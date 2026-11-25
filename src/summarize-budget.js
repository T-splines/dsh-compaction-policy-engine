/**
 * Fitting a summary request inside the target model's window.
 *
 * Compaction is the one operation every other failure mode recovers through, so it
 * must not be able to fail for the reason it exists to fix. Before 2026-11-26 it
 * could: the summary request replayed the whole conversation, and a conversation
 * that had outgrown the window produced a summary request that had outgrown the
 * window. The retry re-sent the same bytes. Measured on a Win11 session: 158k
 * tokens, four compactions, every one rejected `context_length_exceeded`.
 *
 * The stages below degrade in cost order — full replay (best prefix-cache reuse),
 * then the caller's own region, then chunked summarization, then a verbatim trim
 * that needs no model at all. Each stage's output is a message list that fits the
 * budget stage has established; the engine still has the last word, and a stage
 * that fails to fit is simply not used.
 *
 * This module is pure: no context, no session, no I/O. The engine supplies the
 * window and the messages; every decision here is arithmetic over them.
 *
 * @module dsh-compaction-policy-engine/summarize-budget
 */

/**
 * Characters per token, matching `@deepseek-ai/dsh-token-meter`'s density
 * heuristic. Duplicated rather than imported because the package exports only the
 * meter class; a drift here under-estimates a prompt and the stage that depended
 * on the estimate fails safe (it is rejected upstream and the next stage runs).
 */
const CHARS_PER_TOKEN = 4;

/** Per-block framing cost, matching the same heuristic. */
const BLOCK_OVERHEAD = 4;

/**
 * Fraction of the window a summary *request* may occupy.
 *
 * Deliberately below the gate threshold (0.42 by default): this is not "when to
 * compact", it is "how much room the request needs while leaving space for the
 * summary it produces". 0.8 also matches the stock engine's gate, so a deployment
 * that raised the policy threshold still fits its own request.
 */
const DEFAULT_REQUEST_BUDGET_RATIO = 0.8;

/**
 * Upper bound on chunked-summarization rounds.
 *
 * Each round is a full model call over `budget` tokens, so an unbounded loop on a
 * corrupt or pathologically long session would spend real money without bound.
 * Twelve rounds at 80% of a 256k window covers ~2.4M tokens of history, which is
 * far past any session worth rescuing; beyond it the honest answer is "start a
 * new session", not another ten rounds.
 */
const DEFAULT_MAX_CHUNK_ROUNDS = 12;

/**
 * Bookkeeping per message that the content estimate does not see: role framing,
 * the separators a wire protocol adds, and the instruction the caller appends.
 * Not a tuned number — a deliberately generous allowance so a request that fits
 * under this estimate also fits upstream.
 */
const MESSAGE_OVERHEAD = 8;

/** Token cost of the compaction instruction appended by the parent engine. */
const INSTRUCTION_TOKENS = 512;

/**
 * Price one content block under the density heuristic.
 * Mirrors `estimateContent` in `@deepseek-ai/dsh-token-meter`.
 * @param block - one content block.
 * @returns estimated tokens for that block.
 */
function blockTokens(block) {
	if (block === null || typeof block !== 'object') return BLOCK_OVERHEAD;
	switch (block.type) {
		case 'text':
		case 'reasoning':
			return Math.ceil(String(block.text ?? '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
		case 'tool-call':
			return (
				Math.ceil(String(block.name ?? '').length / CHARS_PER_TOKEN) +
				Math.ceil(String(block.arguments ?? '').length / CHARS_PER_TOKEN) +
				BLOCK_OVERHEAD
			);
		default:
			return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
	}
}

/**
 * Estimate the tokens one message costs on the wire.
 *
 * A `tool` message carries its payload on `content`; an assistant message carries
 * blocks; either may be a plain string. All three shapes appear in a projected
 * surface, so all three are priced.
 * @param message - one projected message.
 * @returns estimated tokens, never negative.
 */
export function messageTokens(message) {
	if (message === null || typeof message !== 'object') return MESSAGE_OVERHEAD;
	const content = message.content;
	let tokens = MESSAGE_OVERHEAD;
	if (typeof content === 'string') {
		tokens += Math.ceil(content.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
	} else if (Array.isArray(content)) {
		for (const block of content) tokens += blockTokens(block);
	} else if (content !== undefined && content !== null) {
		tokens += Math.ceil(JSON.stringify(content).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
	}
	return tokens;
}

/**
 * Estimate the tokens a message list costs, plus the instruction the parent
 * appends and (when supplied) the tools it replays alongside.
 * @param messages - projected messages in model order.
 * @param toolTokens - tokens the replayed tool catalog costs, if any.
 * @returns the estimated total for one summary request.
 */
export function listTokens(messages, toolTokens = 0) {
	let total = INSTRUCTION_TOKENS + Math.max(0, toolTokens);
	for (const message of messages ?? []) total += messageTokens(message);
	return total;
}

/**
 * The token budget one summary request may occupy for a given window.
 * @param contextWindow - the target model's declared window.
 * @param ratio - fraction of the window the request may use.
 * @returns the budget in tokens; 0 when the window is unknown.
 */
export function requestBudget(contextWindow, ratio = DEFAULT_REQUEST_BUDGET_RATIO) {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
	const bounded = Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DEFAULT_REQUEST_BUDGET_RATIO;
	return Math.floor(contextWindow * bounded);
}

/**
 * Split a message list into consecutive chunks that each fit `budget`.
 *
 * A single message larger than the whole budget cannot be split (it is one
 * message); it gets a chunk of its own so the caller can decide whether to trim
 * it rather than silently dropping the session tail. `oversized` names those
 * indices so the caller can report them instead of guessing why a chunk failed.
 *
 * Empty input yields no chunks. A message list that already fits yields one chunk.
 * @param messages - projected messages in model order.
 * @param budget - token budget per chunk; must be positive.
 * @param options - `toolTokens` reserves room for the replayed tool catalog;
 *   `instructionTokens` overrides the fixed instruction allowance.
 * @returns `{ chunks, oversized }` where each chunk is `{ start, end, tokens }`.
 */
export function chunkMessages(messages, budget, options = {}) {
	const list = Array.isArray(messages) ? messages : [];
	if (!(budget > 0) || list.length === 0) return { chunks: [], oversized: [] };
	const reserve =
		(Number.isFinite(options.instructionTokens) ? options.instructionTokens : INSTRUCTION_TOKENS) +
		Math.max(0, options.toolTokens ?? 0);
	// A tiny budget can be smaller than the fixed reserve. Clamping to 1 token of
	// payload would then mark *every* message oversized, which reads as "nothing
	// fits" when the honest answer is "the reserve already exceeds the budget".
	// In that case pay for the reserve and accept that the caller's budget cannot
	// be honored here — the stages above this one are responsible for choosing a
	// budget that leaves room.
	const perChunk = Math.max(1, budget - reserve);
	// A message is oversized only when it cannot fit *with* the reserve, i.e. when
	// no chunk could ever contain it. Comparing against `perChunk` alone would call
	// an ordinary message oversized whenever the reserve is large.
	const oversizedCeiling = Math.max(perChunk, budget - Math.min(reserve, budget));

	const chunks = [];
	const oversized = [];
	let start = 0;
	let tokens = 0;
	for (let index = 0; index < list.length; index += 1) {
		const cost = messageTokens(list[index]);
		if (cost > oversizedCeiling) {
			// Flush what accumulated, then give the monster its own chunk.
			if (index > start) chunks.push({ start, end: index - 1, tokens });
			chunks.push({ start: index, end: index, tokens: cost });
			oversized.push(index);
			start = index + 1;
			tokens = 0;
			continue;
		}
		if (tokens + cost > perChunk && index > start) {
			chunks.push({ start, end: index - 1, tokens });
			start = index;
			tokens = 0;
		}
		tokens += cost;
	}
	if (start < list.length) chunks.push({ start, end: list.length - 1, tokens });
	return { chunks, oversized };
}

/**
 * Replace one oversized text payload with a head/tail excerpt.
 *
 * Used by the last-resort stage, which must succeed without any model call. The
 * excerpt keeps the beginning (where a command and its context usually are) and
 * the end (where the verdict usually is), and names the elision so a later reader
 * knows the text was truncated rather than empty.
 * @param text - the payload to trim.
 * @param headChars - characters kept from the start.
 * @param tailChars - characters kept from the end.
 * @returns the trimmed text, or the original when it already fits.
 */
export function elideText(text, headChars, tailChars) {
	const value = String(text ?? '');
	const keep = Math.max(0, headChars) + Math.max(0, tailChars);
	if (value.length <= keep + 64) return value;
	const head = value.slice(0, Math.max(0, headChars));
	const tail = Math.max(0, tailChars) === 0 ? '' : value.slice(-Math.max(0, tailChars));
	const omitted = value.length - head.length - tail.length;
	return `${head}\n[… ${omitted} characters elided by compaction …]\n${tail}`;
}

/**
 * Shrink a message list until it fits `budget`, without calling a model.
 *
 * This is the final stage: it cannot fail on account of the provider, because it
 * makes no request. It only ever rewrites `tool` payloads — user and assistant
 * messages carry the semantic spine of the session and are never dropped here.
 * Tool results are the bulk of any long agent session (they are command output),
 * and they are also the most reproducible: a truncated log is recoverable by
 * re-running the command, a deleted user decision is not.
 *
 * Elision is progressive: payloads are halved repeatedly until the list fits or
 * nothing more can be removed, so a session that only just overflows loses only a
 * fraction of its detail.
 * @param messages - projected messages in model order.
 * @param budget - token budget the result must fit.
 * @param options - `headChars`/`tailChars` bound one excerpt, `toolTokens`
 *   reserves room for the replayed tool catalog.
 * @returns `{ messages, elided, tokens }` — `elided` counts rewritten payloads.
 */
export function shrinkToFit(messages, budget, options = {}) {
	const list = Array.isArray(messages) ? messages : [];
	const headChars = Number.isFinite(options.headChars) ? options.headChars : 2048;
	const tailChars = Number.isFinite(options.tailChars) ? options.tailChars : 512;
	const toolTokens = Math.max(0, options.toolTokens ?? 0);

	// Work on shallow copies: the caller's list (and the session projection behind
	// it) must not be mutated by an attempt that might still be abandoned.
	let working = list.map((message) => ({ ...message }));
	let elided = 0;
	let total = listTokens(working, toolTokens);
	if (!(budget > 0) || total <= budget) return { messages: working, elided, tokens: total };

	// Halve the excerpt window each pass. Bounded by the number of passes needed to
	// reach a single character, so this always terminates.
	for (let head = headChars, tail = tailChars; head + tail >= 2; head = Math.floor(head / 2), tail = Math.floor(tail / 2)) {
		working = working.map((message) => {
			if (message?.role !== 'tool') return message;
			const content = message.content;
			if (typeof content === 'string') {
				const next = elideText(content, head, tail);
				if (next === content) return message;
				elided += 1;
				return { ...message, content: next };
			}
			if (!Array.isArray(content)) return message;
			let touched = false;
			const blocks = content.map((block) => {
				if (block?.type !== 'text' || typeof block.text !== 'string') return block;
				const next = elideText(block.text, head, tail);
				if (next === block.text) return block;
				touched = true;
				return { ...block, text: next };
			});
			if (!touched) return message;
			elided += 1;
			return { ...message, content: blocks };
		});
		total = listTokens(working, toolTokens);
		if (total <= budget) break;
	}
	return { messages: working, elided, tokens: total };
}

export { DEFAULT_MAX_CHUNK_ROUNDS, DEFAULT_REQUEST_BUDGET_RATIO, INSTRUCTION_TOKENS };
