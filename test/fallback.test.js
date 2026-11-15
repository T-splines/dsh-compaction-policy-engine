/**
 * The summarization fallback chain.
 *
 * The harness has no model-level fallback, and this is where its absence costs
 * the most: a summarization call is the one request compaction cannot proceed
 * without, so a free route that is rate-limited or briefly down stops the
 * conversation instead of degrading to the next route. `dsh-llm-retry` retries
 * the *same* provider/model with backoff (keyed by `retryStateKey(provider,
 * policyKey)`); nothing in the official packages walks to a different model.
 *
 * These tests pin the three things that make the chain safe rather than merely
 * present, all of which follow from the parent consuming the stream
 * incrementally (`for await (const chunk of ctx.llm.stream(options))`):
 *
 *   1. a failed attempt contributes **nothing** to the parent — its deltas are
 *      buffered and dropped, so half a summary from a dead route can never be
 *      committed;
 *   2. a terminal `error`, `aborted`, or `max-tokens` finish chunk counts as a
 *      failure — `LlmRuntime` reports adapter failures the first way rather than by
 *      throwing, and a `max-tokens` finish means the summary was cut at the cap, so
 *      it is incomplete rather than merely slow.
 *   3. `options.provider`/`options.model` name the route that actually worked,
 *      because the parent reads them *after* the stream to record the
 *      `compaction/summary` row — and that row is the only evidence an operator
 *      has of which model summarized what.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cc-fallback-test-'));

import { Context } from '@deepseek-ai/cordis';

import { CompactionControlEngine } from '../lib/index.js';
import { CompactionConfigError, resolveConfig, resolvePolicy } from '../lib/policy.js';

const PRIMARY = { provider: 'gateway-a', model: 'model-a' };
const STRONG = { provider: 'gateway-a', model: 'model-b' };
const WEAK = { provider: 'gateway-a', model: 'model-c' };
const PAID = { provider: 'gateway-a', model: 'model-f' };
const ref = (target) => `${target.provider}/${target.model}`;

/** Instantiate the engine on a real Cordis context. */
function makeEngine(config = {}) {
	return new CompactionControlEngine(new Context(), config);
}

/**
 * A recorded llm service whose per-route behaviour the test scripts.
 *
 * `stream` is what the fallback executor calls; `resolveModelInfo` is what the
 * effort lookup calls, and it declares no thinking levels so the effort path
 * stays out of the way of the chain under test.
 */
function recordingLlm(scripts) {
	const calls = [];
	return {
		calls,
		stream(options) {
			calls.push({ provider: options.provider, model: options.model });
			const script = scripts[ref(options)] ?? scripts[options.model] ?? [];
			return (async function* () {
				for (const step of script) {
					if (typeof step === 'function') throw step();
					yield step;
				}
			})();
		},
		resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 8_192, reasoning: { efforts: [] } }),
	};
}

/** A chunk stream that succeeds with the given text. */
function success(text) {
	return [
		{ type: 'text-delta', text },
		{ type: 'block-end', block: { type: 'text', text } },
		{ type: 'finish', reason: { kind: 'stop' } },
	];
}

/** A chunk stream that reports an adapter failure as a terminal finish chunk. */
function failure(message, code = 'RATE_LIMITED') {
	return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }];
}

/** Collect every chunk yielded by the executor. */
async function drain(engine, llm, options, attempt) {
	const yielded = [];
	for await (const chunk of engine.streamWithFallback(llm, options, attempt)) yielded.push(chunk);
	return yielded;
}

test('the policy resolves a fallback chain to ordered routes', () => {
	const config = resolveConfig({
		default: { summarizationModel: ref(PRIMARY), summarizationFallback: [ref(STRONG), ref(WEAK), ref(PAID)] },
	});
	const policy = resolvePolicy(config, PRIMARY, 1_000_000);
	assert.deepEqual(
		policy.summarizationFallback,
		[STRONG, WEAK, PAID],
		'the chain keeps the operator\'s order — strongest free first, paid last',
	);
});

test('per-field layering lets a route override the chain without restating the rest', () => {
	// The three-layer design is per field, and the chain is a field like any other:
	// a route that only wants a different chain must not have to restate its
	// threshold, and a route that states nothing inherits the default chain.
	const config = resolveConfig({
		default: { threshold: 0.5, summarizationFallback: [ref(STRONG)] },
		providers: { 'gateway-a': { summarizationFallback: [ref(PAID)] } },
		models: [{ provider: 'gateway-a', model: PRIMARY.model, threshold: 0.3 }],
	});
	const overridden = resolvePolicy(config, PRIMARY, 1_000_000);
	assert.deepEqual(overridden.summarizationFallback, [PAID], 'the model layer inherits the provider chain, not the default one');
	assert.equal(overridden.thresholdRatio, 0.3, 'the route states its own threshold');
	const other = resolvePolicy(config, { provider: 'gateway-a', model: 'something-else' }, 1_000_000);
	assert.deepEqual(other.summarizationFallback, [PAID], 'the provider layer wins for a route with no model row');
	assert.equal(other.thresholdRatio, 0.5, 'and the default threshold still fills the field the provider did not state');
});

test('a chain entry naming the primary route is skipped and reported, not retried', () => {
	// The one mistake a hand-written chain actually makes, and the most expensive
	// way to accomplish nothing: re-sending the entire summary prompt at full
	// cold-read price to the route that just failed.
	//
	// Skipped rather than fatal. Refusing the document was the original answer and
	// it was the wrong one: on 2026-10-14 a provider override made the local route
	// primary while the shared chain still named it, and *every* compaction of that
	// route failed outright —
	// `[compaction] FAILED ... summarizationFallback[1] names the primary
	// summarization route` — over one redundant entry. The rest of the chain is
	// still worth trying, so the repeat is dropped and reported instead.
	const explicit = resolvePolicy(
		resolveConfig({ default: { summarizationModel: ref(PRIMARY), summarizationFallback: [ref(PRIMARY), ref(STRONG)] } }),
		PRIMARY,
		1_000_000,
	);
	assert.deepEqual(explicit.summarizationFallback, [STRONG], 'the repeated route is dropped and the rest keeps its order');
	assert.equal(explicit.warnings.length, 1, 'and the drop is reported rather than swallowed');

	// `auto` resolves to the conversation's route, which differs per target, so the
	// repeat can only be caught at resolution time.
	const automatic = resolvePolicy(
		resolveConfig({ default: { summarizationFallback: [ref(PRIMARY), ref(STRONG)] } }),
		PRIMARY,
		1_000_000,
	);
	assert.deepEqual(automatic.summarizationFallback, [STRONG], 'under auto the conversation route is the primary');
	assert.equal(automatic.warnings.length, 1);
});

test('a malformed chain is refused at load rather than ignored', () => {
	for (const [chain, pattern] of [
		[[ref(STRONG), ref(STRONG)], /repeats/],
		[['auto'], /must name an explicit/],
		[['no-slash'], /provider\/model/],
		[[ref(STRONG), ''], /non-empty/],
		['not-a-list', /must be a list/],
	]) {
		assert.throws(
			() => resolveConfig({ default: { summarizationFallback: chain } }),
			(error) => error instanceof CompactionConfigError && pattern.test(error.message),
			`expected ${JSON.stringify(chain)} to be refused`,
		);
	}
});

test('a failing primary falls through to the next route and yields only its chunks', async () => {
	const engine = makeEngine();
	const llm = recordingLlm({
		[ref(PRIMARY)]: failure('rate limited', 'RATE_LIMITED'),
		[ref(STRONG)]: success('the summary'),
	});
	const options = { provider: PRIMARY.provider, model: PRIMARY.model, maxTokens: 8_192 };
	const yielded = await drain(engine, llm, options, { fallback: [STRONG], signal: undefined });

	assert.deepEqual(
		llm.calls.map((call) => `${call.provider}/${call.model}`),
		[ref(PRIMARY), ref(STRONG)],
		'the chain is tried in order and stops at the first success',
	);
	assert.equal(yielded.length, 3, 'only the successful attempt\'s chunks reach the parent');
	assert.equal(yielded[0].text, 'the summary');
	// The whole point: the parent's incremental assembler never saw the failed
	// attempt, so it cannot commit a partial or empty summary from it.
	assert.equal(options.model, STRONG.model, 'the request names the route that actually worked');
	assert.equal(options.provider, STRONG.provider);
});

test('nothing from a failed attempt reaches the parent, including its text', async () => {
	// A route that streams real text and *then* dies is the dangerous case: the
	// parent would otherwise assemble a plausible-looking half summary and commit
	// it. Buffering is what makes the discard complete.
	const engine = makeEngine();
	const llm = recordingLlm({
		[ref(PRIMARY)]: [{ type: 'text-delta', text: 'half a summ' }, { type: 'finish', reason: { kind: 'error', failure: { message: 'connection reset', code: 'NETWORK' } } }],
		[ref(STRONG)]: success('complete summary'),
	});
	const yielded = await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.deepEqual(
		yielded.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text),
		['complete summary'],
		'the dead route\'s partial text is never yielded',
	);
});

test('a thrown failure is treated like a terminal failure chunk', async () => {
	// Middleware, nested-call, and consumer failures throw; adapter failures arrive
	// as a finish chunk. Both mean the same thing, and both must fall through.
	const engine = makeEngine();
	const llm = recordingLlm({
		[ref(PRIMARY)]: [() => Object.assign(new Error('boom'), { code: 'NETWORK' })],
		[ref(STRONG)]: success('recovered'),
	});
	const yielded = await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.equal(yielded[0].text, 'recovered');
});

test('a route that yields no text is treated as a failure', async () => {
	// An attempt that ends without text did not summarize anything, and the parent
	// rejects an empty summary anyway — so re-sending the prompt is cheaper than
	// reporting a compaction that cannot be committed.
	const engine = makeEngine();
	const llm = recordingLlm({
		[ref(PRIMARY)]: [{ type: 'finish', reason: { kind: 'stop' } }],
		[ref(STRONG)]: success('real summary'),
	});
	const yielded = await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.equal(yielded[0].text, 'real summary');
});

test('an exhausted chain reports a terminal failure rather than throwing', async () => {
	// The parent's contract is the `finish` chunk; throwing from inside the stream
	// would surface as an unhandled stream error instead of the lawful
	// "summarization failed" the retry loop knows how to handle.
	const engine = makeEngine();
	const llm = recordingLlm({
		[ref(PRIMARY)]: failure('rate limited'),
		[ref(STRONG)]: failure('down', 'NETWORK'),
	});
	const yielded = await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.equal(yielded.length, 1);
	assert.equal(yielded[0].type, 'finish');
	assert.equal(yielded[0].reason.kind, 'error');
	assert.equal(yielded[0].reason.failure.code, 'FALLBACK_EXHAUSTED');
});

test('an aborted call does not spend money on the next route', async () => {
	// Aborting is the operator stopping the work, not a route failing.
	const engine = makeEngine();
	const controller = new AbortController();
	const llm = recordingLlm({
		[ref(PRIMARY)]: failure('aborted', 'ABORTED'),
		[ref(STRONG)]: success('should never be requested'),
	});
	controller.abort(new Error('user stopped it'));
	await assert.rejects(
		drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: controller.signal }),
		/user stopped it/,
	);
	assert.equal(llm.calls.length, 1, 'the fallback is not attempted after an abort');
});

test('the effort rides along with whichever route serves the summary', async () => {
	// The two features share one shadow, so a route that offers a "do not think"
	// level gets it wherever in the chain it sits: without it that route would
	// summarize with thinking on, which is the slow and expensive way to compress
	// text. The effort is resolved against each route that serves the attempt, so
	// the chain is read per route and the two requests differ only in the route.
	const engine = makeEngine();
	const seen = [];
	const llm = {
		stream(options) {
			seen.push({ model: options.model, reasoningEffort: options.reasoningEffort });
			return (async function* () {
				if (options.model === PRIMARY.model) {
					yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMITED' } } };
					return;
				}
				yield { type: 'text-delta', text: 'ok' };
				yield { type: 'finish', reason: { kind: 'stop' } };
			})();
		},
		async resolveModelInfo(provider, model) {
			return { reasoning: { efforts: model === PRIMARY.model ? [{ id: 'off' }] : [{ id: 'off' }, { id: 'low' }] } };
		},
	};
	await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.deepEqual(seen, [
		{ model: PRIMARY.model, reasoningEffort: 'off' },
		{ model: STRONG.model, reasoningEffort: 'off' },
	]);
});

test('a route that offers no "do not think" level gets no effort field, not the primary\'s', async () => {
	// The level id is adapter-owned: naming a level the route did not declare is a
	// hard rejection, not a silent drop to its default. Reusing the primary's
	// effort for a later route would turn one route's capability into another
	// route's failure, so a route with nothing to offer gets no field at all.
	const engine = makeEngine();
	const seen = [];
	const llm = {
		stream(options) {
			seen.push({ model: options.model, reasoningEffort: options.reasoningEffort });
			return (async function* () {
				if (options.model === PRIMARY.model) {
					yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMITED' } } };
					return;
				}
				yield { type: 'text-delta', text: 'ok' };
				yield { type: 'finish', reason: { kind: 'stop' } };
			})();
		},
		async resolveModelInfo(provider, model) {
			return { reasoning: { efforts: model === PRIMARY.model ? [{ id: 'off' }] : [] } };
		},
	};
	await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.deepEqual(seen, [
		{ model: PRIMARY.model, reasoningEffort: 'off' },
		{ model: STRONG.model, reasoningEffort: undefined },
	]);
});

test('a route whose levels cannot be read gets no effort field', async () => {
	// Reading the levels is best-effort. When it fails there is nothing to guess:
	// a guessed level may be one the route rejects, and the adapter default is the
	// only answer that cannot be refused.
	const engine = makeEngine();
	const seen = [];
	const llm = {
		stream(options) {
			seen.push({ model: options.model, reasoningEffort: options.reasoningEffort });
			return success('ok');
		},
	};
	await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [], signal: undefined });

	assert.deepEqual(seen, [{ model: PRIMARY.model, reasoningEffort: undefined }]);
});

/**
 * An llm service whose declared thinking levels the test scripts per route.
 *
 * `resolveModelInfo` returns `reasoning: { efforts }` for the route it is asked
 * about, which is what both the effort lookup and the thinking-control
 * diagnostic read.
 */
function llmWithLevels(levelsByModel) {
	const calls = [];
	return {
		calls,
		stream: (options) => {
			calls.push({ provider: options.provider, model: options.model });
			return (async function* () {
				yield { type: 'text-delta', text: 'ok' };
				yield { type: 'finish', reason: { kind: 'stop' } };
			})();
		},
		async resolveModelInfo(_provider, model) {
			return { reasoning: { efforts: levelsByModel[model] ?? [] } };
		},
	};
}

/** A logger that records every line, for asserting what was and was not said. */
function recordingLogger() {
	const lines = [];
	return {
		lines,
		info: (message) => lines.push(`info: ${message}`),
		warn: (message) => lines.push(`warn: ${message}`),
	};
}

test('a route that cannot be told not to think is warned about once, per route', async () => {
	// The silent failure: a hand-declared model with no `reasoningEfforts` is
	// treated as non-reasoning by the adapter, which then skips every
	// thinking-control branch — off included — so the route thinks at its own
	// default and spends the summarization maxTokens on it. The compaction
	// succeeds; nothing used to say so.
	const engine = makeEngine();
	const logger = recordingLogger();
	engine.ctx.logger = logger;
	// The primary fails, so the chain walks to the fallback route: both routes are
	// then attempted, and each one's own capability is what gets reported.
	const levels = {
		[PRIMARY.model]: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
		[STRONG.model]: [],
	};
	const llm = {
		calls: [],
		stream(options) {
			this.calls.push({ provider: options.provider, model: options.model });
			if (options.model === PRIMARY.model) {
				return (async function* () {
					yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMITED' } } };
				})();
			}
			return (async function* () {
				yield { type: 'text-delta', text: 'ok' };
				yield { type: 'finish', reason: { kind: 'stop' } };
			})();
		},
		async resolveModelInfo(_provider, model) {
			return { reasoning: { efforts: levels[model] ?? [] } };
		},
	};

	await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });
	// A second chain over the same two routes, on the same engine: the diagnostic
	// is a property of the route, not of the call, so neither route says it again.
	await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	// Only the diagnostic's own lines: the chain logs a failure and a fall-back per
	// attempt as well, and those are covered by the tests above.
	const warned = logger.lines.filter((line) => line.startsWith('warn:') && /cannot be told not to think/.test(line));
	assert.equal(warned.length, 2, 'one warning per route that cannot be told not to think, not one per call');
	assert.match(warned[0], /summarization route gateway-a\/model-a cannot be told not to think/);
	assert.match(warned[0], /none of them is an off switch/);
	assert.match(warned[0], /low, high/, 'the levels it does offer are named');
	assert.match(warned[1], /summarization route gateway-a\/model-b cannot be told not to think/);
	assert.match(warned[1], /no reasoning capability/);
	// The chain's own fall-back line is info too, so the assertion is about the
	// diagnostic: neither of these routes got a "thinking control resolved" line.
	assert.equal(
		logger.lines.some((line) => line.startsWith('info:') && /thinking control for/.test(line)),
		false,
		'a route that cannot be told not to think is never reported as resolved',
	);
});

test('a route declaring an off level is reported once at info level and warns never', async () => {
	// The good case has to be quiet about being good: one line saying the control
	// resolved, and nothing on every later compaction.
	const engine = makeEngine();
	const logger = recordingLogger();
	engine.ctx.logger = logger;
	const llm = llmWithLevels({ [PRIMARY.model]: [{ id: 'off', name: 'Off' }] });

	await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [], signal: undefined });
	await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [], signal: undefined });

	assert.deepEqual(logger.lines, [
		'info: compaction-control: summarization thinking control for gateway-a/model-a: off (off level; offered: off)',
	]);
});

test('the thinking-control diagnostic says nothing when the route is undefined', async () => {
	// `auto` (the default) hands the parent an empty target so it inherits the
	// conversation's own route — there is no provider/model to name, and the gate's
	// own lines already cover that route. Logging here would either be silent about
	// the real route or invent a name for it.
	const engine = makeEngine();
	const logger = recordingLogger();
	engine.ctx.logger = logger;
	const llm = llmWithLevels({});

	await engine.logThinkingControl(undefined, { effort: undefined, control: 'no-reasoning', offered: [] });
	assert.deepEqual(logger.lines, []);
	// A control that could not be read is `resolveEffort`'s warning to make, not
	// this one's: the two must not both fire for the same route.
	await engine.logThinkingControl(PRIMARY, undefined);
	assert.deepEqual(logger.lines, []);
});

test('a summary cut at the token cap falls through to the next route', async () => {
	// `max-tokens` is a terminal finish kind, and it is not a success: the output
	// was cut at the cap, so the summary is incomplete. Yielding it as text let a
	// truncated checkpoint through as a "successful" summary — the parent only
	// noticed once it assembled the checkpoint — so the attempt must count as a
	// failure and the chain must walk.
	const engine = makeEngine();
	const llm = recordingLlm({
		[ref(PRIMARY)]: [
			{ type: 'text-delta', text: 'a summary that never finished' },
			{ type: 'block-end', block: { type: 'text', text: 'a summary that never finished' } },
			{ type: 'finish', reason: { kind: 'max-tokens' } },
		],
		[ref(STRONG)]: success('a complete summary'),
	});
	const yielded = await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.deepEqual(
		llm.calls.map((call) => `${call.provider}/${call.model}`),
		[ref(PRIMARY), ref(STRONG)],
		'a cut summary is a failed attempt, so the chain walks',
	);
	assert.deepEqual(
		yielded.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text),
		['a complete summary'],
		'the truncated text is never released to the parent',
	);
	assert.equal(yielded.some((chunk) => chunk.reason?.kind === 'max-tokens'), false, 'the cut finish is not passed through');
});

test('a token cap on every route reports a terminal failure that names the cap', async () => {
	// With no route able to finish inside the cap, failing is the correct outcome:
	// committing a truncated checkpoint would drop the turns after the cut. The
	// message has to say why each route failed, because the parent reports one line
	// for the whole compaction and a bare "all routes failed" is undiagnosable.
	const engine = makeEngine();
	const llm = recordingLlm({
		[ref(PRIMARY)]: [{ type: 'finish', reason: { kind: 'max-tokens' } }],
		[ref(STRONG)]: [{ type: 'finish', reason: { kind: 'max-tokens' } }],
	});
	const yielded = await drain(engine, llm, { provider: PRIMARY.provider, model: PRIMARY.model }, { fallback: [STRONG], signal: undefined });

	assert.equal(yielded.length, 1);
	assert.equal(yielded[0].type, 'finish');
	assert.equal(yielded[0].reason.kind, 'error');
	assert.equal(yielded[0].reason.failure.code, 'FALLBACK_EXHAUSTED');
	assert.match(yielded[0].reason.failure.message, new RegExp(ref(PRIMARY)), 'the primary route is named');
	assert.match(yielded[0].reason.failure.message, new RegExp(ref(STRONG)), 'the fallback route is named');
	assert.match(yielded[0].reason.failure.message, /token cap/, 'the cap is named, not just "all routes failed"');
});

test('an empty chain leaves the parent its own single-route call', async () => {
	// No chain and no effort must not install a shadow at all: the seam exists to
	// change the request, and installing it to forward an unchanged one would add
	// a hand-off (and a way to get it wrong) for nothing.
	const engine = makeEngine({ default: { summarizationModel: ref(PRIMARY) } });
	assert.deepEqual(engine.controlConfig.default.summarizationFallback ?? [], [], 'no chain is configured');
});
