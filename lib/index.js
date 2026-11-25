/**
 * dsh-compaction-policy-engine — a configurable policy layer over the official
 * compaction engine.
 *
 * `@deepseek-ai/dsh-compaction-basic` already implements the compaction semantics
 * (region selection, tool-pairing balance, summary framing, the durable
 * transaction); what it lacks is a configuration surface. This plugin adds
 * exactly that and nothing else: it *replaces* the `compaction-basic` row (one
 * implementation per `ctx.compaction`) by subclassing `BasicCompactionEngine` and
 * overriding its two documented hooks — `compactIfNeeded` (whether, and at what
 * threshold) and `summarize` (which model) — plus `compactNow`, for manual
 * compaction that survives its caller (see that method).
 *
 * Thresholds and retention are ratios of the adapter-declared context window, so
 * they keep their meaning when a window changes; a layer may instead state
 * `thresholdTokens`/`retainTokens` for a fixed working tail, which the engine
 * resolves through the window before handing the parent its ratio form.
 *
 * @module dsh-compaction-policy-engine
 */

import z from '@deepseek-ai/schemastery';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import {
	CompactionConfigError,
	THINKING_OFF,
	overlayDocument,
	pickThinkingOff,
	resolveConfig,
	resolvePolicy,
	resolveSummarizationEffort,
	toBasicConfig,
} from './policy.js';
import { SETTINGS_NS, installSettings, plainConfig, settingsSchema } from './settings.js';
import { patchFilePaths, settingsFilePath, watchPatchFile, watchSettingsFile } from './settings-file.js';

export { CompactionConfigError } from './policy.js';
export {
	AUTO,
	DEFAULT_THRESHOLD_RATIO,
	MIN_COMPACT_GAP_TOKENS,
	THINKING_OFF,
	overlayDocument,
	pickThinkingOff,
	resolveConfig,
	resolvePolicy,
	resolveSummarizationEffort,
	toBasicConfig,
} from './policy.js';
export { SETTINGS_NS, plainConfig, settingsSchema } from './settings.js';

// The two range re-pricing helpers are exported because the manual-retention
// contract rests on them: a test can drive them directly and assert the shape of
// the measurement the parent's selector will consume, which is the only way to
// notice an upstream change to that selector before it silently degrades manual
// compactions back to one node. They are pure, so exporting them widens nothing.
export { reframeMeasurement, retainKeepIndex, reportUnstatedThreshold };

/**
 * A one-line description of a failed summarization attempt.
 *
 * A failure arrives in three shapes — an `LlmError`-carrying `finish` reason, a
 * thrown error from a middleware or consumer, and a bare object — and the operator
 * reading the log needs the same thing from all three: what went wrong and, when
 * the adapter said so, which code. Naming the code matters because the retry-worthy
 * failures (`RATE_LIMITED`, `QUOTA_EXCEEDED`) and the permanent ones
 * (`INVALID_CREDENTIAL`, `UNSUPPORTED_CONTENT`) look identical in a bare message.
 *
 * @param failure - the failure reason, thrown error, or fallback object.
 * @returns a single-line description.
 */
function failureMessage(failure) {
	const message = typeof failure?.message === 'string' && failure.message.length > 0 ? failure.message : String(failure);
	const code = failure?.code;
	return code === undefined ? message : `${code}: ${message}`;
}

/**
 * Render one policy field for a log line, in whichever unit the layer stated:
 * `200000` and `0.2` are the same policy on a 1M window and different ones on a
 * 256k window, so the unit is always explicit.
 */
function declaredText(ratio, tokens) {
	if (tokens !== undefined) return `${tokens}tok`;
	return ratio ?? 'unset';
}

/**
 * Re-pricing constants for the manual-compaction range shadow.
 *
 * `TAIL_DISCOUNT` is subtracted from every node above the keep index, so the
 * official selector's `accumulated >= retainTokens` check (which the caller has
 * fixed at `0`) fails while it walks the tail. The keep index gets the same
 * amount back plus `KEEP_MARGIN`, which makes the accumulated sum telescope
 * back to exactly the real tail total plus a margin. The magnitudes are set
 * against the cancellation: `accumulated` walks through values of order
 * `TAIL_DISCOUNT × nodeCount`, so float error grows with session length (about
 * 1e4 for a 10k-event session) and `KEEP_MARGIN` stays three orders above it.
 * A smaller margin would let a short tail fall through the check and compact
 * the very context the operator asked to keep.
 */
const TAIL_DISCOUNT = 1e12;
const KEEP_MARGIN = 1e9;

/**
 * Re-price a real measurement so the parent's `retainTokens: 0` range selector
 * stops at `keepFromIdx`.
 *
 * This is the manual-compaction fix. The parent's `compactNow` states `0` as its
 * retention — a forced reduction keeps almost nothing, its "one useful
 * reduction" semantic — so a manual compaction kept a single surface node while
 * an automatic one kept the operator's whole tail. The transaction that would
 * take a real retention is private to the upstream package, so the retention
 * cannot be passed in; it has to change what the parent's selector sees.
 *
 * @param measurement - real unified measurement from the conversation meter.
 * @param keepFromIdx - index to retain from (inclusive), or undefined when the
 *   real selector would return null (every node is then discounted, so the
 *   parent's loop runs off the end and it returns null as well).
 * @returns a measurement holding the same nodes in the same order, re-priced.
 */
function reframeMeasurement(measurement, keepFromIdx) {
	const nodes = measurement.nodes;
	return {
		...measurement,
		nodes: nodes.map((node, index) => {
			if (keepFromIdx === undefined) return { ...node, tokens: node.tokens - TAIL_DISCOUNT };
			if (index === keepFromIdx) {
				return { ...node, tokens: node.tokens + TAIL_DISCOUNT * (nodes.length - 1 - keepFromIdx) + KEEP_MARGIN };
			}
			if (index > keepFromIdx) return { ...node, tokens: node.tokens - TAIL_DISCOUNT };
			return { ...node };
		}),
	};
}

/**
 * The index the parent's private range selector would stop at for a real
 * retention budget, replicating its index loop exactly.
 *
 * Everything the parent does after the loop — stepping past a system head,
 * backing off across a tool-call/result pair — is left to it: the shadowed
 * measurement only has to break the loop on the same index, after which the
 * parent applies exactly the validation and pairing it always did. So a policy
 * the real selector rejects (a retention larger than the tail, a range that
 * would split a tool pair) is rejected here too, by the same code.
 *
 * @param measurement - real unified measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim, in tokens.
 * @returns the index to retain from (inclusive), or undefined when no index
 *   satisfies the budget.
 */
function retainKeepIndex(measurement, retainTokens) {
	const nodes = measurement.nodes;
	if (nodes.length === 0) return undefined;
	let accumulated = 0;
	let keepFromIdx = nodes.length;
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		accumulated += nodes[index].tokens;
		keepFromIdx = index;
		if (accumulated >= retainTokens) break;
	}
	// The parent's post-loop guard rejects a keep index of zero for every possible
	// `firstIdx`, so this is the "no useful range" answer rather than a real index.
	return keepFromIdx > 0 ? keepFromIdx : undefined;
}

/**
 * Parent-config fields that must be finite after a policy is applied. A
 * non-finite threshold turns every gate comparison false, which *disables* the
 * gate rather than raising it — a failure that looks like "compaction is far too
 * eager". Checked in `applyPolicy` so it cannot pass silently.
 */
const FIELD_CHECKED_AFTER_APPLY = ['headroomTokens', 'thresholdRatio'];

/**
 * Load-time schema for this plugin's own policy document.
 *
 * Declaring it is not cosmetic: a subclass inherits the parent's static `Config`,
 * and the loader validates an entry against it *before* the constructor runs —
 * so omitting it made the loader stamp the parent-only `modelPolicies: []` into
 * this plugin's config, which this plugin's resolver then rejected: a hard load
 * failure. Shape and type only; cross-field rules live in `resolveConfig`.
 */
const ratioSchema = z.number().description('a fraction of the context window, greater than 0 and less than 1');

/**
 * Fields shared by the global default and every override layer.
 *
 * Written out longhand for each layer rather than shared through a spread,
 * because this schemastery version has no `extend`/`merge` for object schemas —
 * the same reason the parent engine repeats its own policy fields.
 */
const layerFields = {
	threshold: ratioSchema.description('compact once the session reaches this fraction of the context window'),
	thresholdTokens: z
		.number()
		.step(1)
		.min(1)
		.description('compact once the session reaches this many tokens; needs a route that declares a window'),
	retain: ratioSchema.description('verbatim tail to keep, as a fraction of the context window; must be below the threshold'),
	retainTokens: z
		.number()
		.step(1)
		.min(1)
		.description('verbatim tail to keep, in tokens; must be below the threshold'),
	summarizationModel: z
		.string()
		.description('"auto" to reuse the conversation\'s own routed model, or an explicit "provider/model"'),
	summarizationFallback: z
		.array(z.string())
		.description('ordered "provider/model" routes tried when the primary summarization route fails; strongest free first, paid last'),
	headroomTokens: z
		.number()
		.step(1)
		.min(0)
		.description('tokens kept free below the threshold so a summary has room to be smaller than the region it replaces'),
	maxTokens: z.number().step(1).min(1).description('cap on the generated summary length'),
	compactionRetries: z.number().step(1).min(0).description('retries when a summarization attempt fails'),
	maxOverflowRetries: z.number().step(1).min(0).description('retries when the request itself overflowed the context window'),
	replayFullConversation: z
		.boolean()
		.description(
			'send the whole surfaced conversation to the summarizer instead of only the shadowed region; ' +
				'needed only when the summarization route is a local inference engine whose prefix cache ' +
				'resumes from an exact token-prefix (see fullConversationMessages). Off by default: a ' +
				'conversation large enough to need compaction is one whose full replay may not fit the window.',
		),
};

/** The global default layer. */
const layer = z.object(layerFields);

/** One exact-target override: the same fields plus the route it applies to. */
const modelLayer = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	...layerFields,
});

/**
 * The message list the last routed request actually sent: the system head plus
 * every surface node's projected message, in surface order.
 *
 * Why a summary call may need all of it rather than only the shadowed region
 * (measured against a local inference engine): that engine resumes only from a
 * stored state that is an exact token-prefix of the new prompt, and it keeps at
 * most `--prompt-cache` (6) checkpoints, taken at assistant-turn boundaries and
 * every `--prompt-cache-every` (16384) fresh tokens. Those six slots hold the
 * *recent* turn boundaries, so the shadowed region's own checkpoints are long
 * evicted: a region-only replay matches nothing but the pinned system-prompt
 * root and re-reads the whole region. Measured: a 403,413-token prompt read over
 * 311 s, then killed by provider-d's 300 s idle watchdog, because a prefill
 * emits no tokens and a slow engine therefore looks idle. Appending the
 * instruction after the FULL conversation instead makes the call an exact
 * extension of the live state, so the engine resumes at the live end and
 * prefills only the instruction.
 *
 * The trade-off is deliberate: the summary then condenses the whole
 * conversation, so the checkpoint and the verbatim-retained tail overlap. That
 * costs the tail's tokens once per compaction, against re-reading the entire
 * context on every one.
 *
 * ⚠️ Off by default, and it must stay that way. This is the opposite trade in
 * the opposite direction: a conversation large enough to need compaction is one
 * whose full replay may no longer fit the model window, and then the request
 * that was supposed to rescue the session cannot be sent at all. That is exactly
 * what happened on 2026-11-26 — 2,100,381 tokens of surface against a 1,000,000
 * window, every compaction rejected before it left the host. Enable this only
 * when the summarization route is a local engine that needs the prefix.
 *
 * @param session - the session whose surface to project.
 * @returns the projected messages, or `undefined` when the surface is unreadable.
 */
function fullConversationMessages(session) {
	const nodes = session?.surface?.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0) return undefined;
	const messages = [];
	for (const seq of nodes) {
		const event = session.eventAt?.(seq);
		if (event === undefined || event === null) continue;
		const message = session.deriveEventMessage?.(event);
		if (message === null || message === undefined) continue;
		messages.push(message);
	}
	return messages.length === 0 ? undefined : messages;
}

/**
 * The summary request's message list: the full conversation when the operator
 * opted in and the session can project it, otherwise the caller's own
 * region-only input unchanged.
 *
 * @param input - the parent's region-only summarization input.
 * @param agent - the agent whose session to project.
 * @param replayFullConversation - the resolved policy flag.
 * @returns the message list to send.
 */
function summarizationInput(input, agent, replayFullConversation) {
	if (replayFullConversation !== true) return input;
	const messages = fullConversationMessages(agent?.session);
	return messages === undefined ? input : { ...input, messages };
}

/**
 * The routed (provider, model) of a conversation: the latest durable request
 * wins (that is what is actually in use), falling back to the agent's options.
 */
function conversationTarget(agent) {
	const routed = agent.session.requestHeader()?.config;
	if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
		return { provider: routed.provider, model: routed.model };
	}
	const { provider, model } = agent.options;
	if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
		return { provider, model };
	}
	return undefined;
}

/**
 * Say once when the pressure gate falls back to the engine's constructor baseline
 * because no layer states a threshold for this target.
 *
 * Silence is the whole bug: the settings card renders the document it holds, so an
 * operator is shown 42% while compaction fires at 80% and cannot tell a mis-set
 * field from a policy that never reached the resolver.
 *
 * @param engine - the engine holding the applied config and the file origin.
 * @param target - routed provider and model, or `undefined` when none is routed.
 * @param policy - the resolved policy, or `undefined` when no target was routed.
 */
function reportUnstatedThreshold(engine, target, policy) {
	// "Stated" is `source.threshold.layer !== 'engine'`, **not** "the resolved
	// fields are defined": `resolvePolicy` always fills `thresholdRatio` from
	// `DEFAULT_THRESHOLD_RATIO`, so the old test made this function return
	// unconditionally and the warning it exists for could never appear. A unit
	// test kept it green by passing a policy shape (`{ retainRatio: 0.1 }`) that
	// the resolver never produces. Measured 2026-11-25.
	//
	// An unknown layer is reported too: "I cannot tell whether a threshold was
	// stated" must not read as "one was".
	const layer = policy?.source?.threshold?.layer;
	if (layer !== undefined && layer !== 'engine') return;
	const key = target === undefined ? 'no-routed-target' : `${target.provider}/${target.model}`;
	engine._reportedUnstatedThreshold ??= new Set();
	if (engine._reportedUnstatedThreshold.has(key)) return;
	engine._reportedUnstatedThreshold.add(key);
	process.stderr.write(
		`[compaction] NO THRESHOLD fiber=${engine.ctx.fiber?.name} target=${key} source=${engine._fileOrigin} ` +
			`thresholdRatio=${engine.config.thresholdRatio} retainRatio=${engine.config.retainRatio}: no layer states a ` +
			`threshold for this target, so the pressure gate runs on the engine baseline and fires at ` +
			`${Math.round(engine.config.thresholdRatio * 100)}% of the window instead of the configured value. ` +
			'Check that this target\'s provider has a row in the policy document, and that the profile patch ' +
			'layer reached this engine (source=cordis.patch.yml).\n',
	);
}

/**
 * A signal that never aborts, for one manual compaction: durable work must not
 * die with the caller's UI request, and the agent's own maintenance signal still
 * cancels it inside the parent (`AbortSignal.any`). Fresh per call, because
 * `AbortSignal.any` attaches a listener to every source it is given.
 */
function detachedSignal() {
	return new AbortController().signal;
}

/**
 * Whether one parent failure is the agent loop's "already has active work" gate.
 * `compactNow` rewrites every *synchronous* `runMaintenance` failure into
 * `ManualCompactionError('busy', …)`, so the cause it attaches is the only way to
 * tell a closing gate from a real compaction lock.
 */
export function isMaintenanceGateError(error) {
	return error?.code === 'busy' && String(error?.cause?.message ?? '').includes('already has active work');
}

/**
 * Wait, bounded, for the agent's current activity to finish.
 *
 * The gate closes one or more microtasks *after* the previous command reported
 * failure (measured: 4ms, against a retry 6–8ms later), so waiting on
 * `agent.whenIdle()` closes exactly that window. The timeout bounds the wait and
 * the caller's signal ends it early; the promise always resolves.
 */
export function waitForAgentIdle(agent, signal, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener?.('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		if (signal?.aborted === true) {
			finish();
			return;
		}
		signal?.addEventListener?.('abort', finish, { once: true });
		Promise.resolve(agent?.whenIdle?.()).then(finish, finish);
	});
}

/**
 * The stable name of the one prompt section this plugin registers. Registered
 * from the host-plane companion (global scope, so every preset carries it), and
 * shadowable per agent by the same name.
 */
export const CONTEXT_POLICY_SECTION = 'compaction:context-policy';

/**
 * The one behavioral rule compaction owes the model.
 *
 * Measured 2026-10-04 in two long sessions: the model announced its context was
 * nearly exhausted — and deferred work on that basis — while still far below the
 * gate, and first said so *before* any compaction had fired. It cannot measure
 * its own context, nothing reports one to it, and once said the claim is repeated
 * (52 and 49 times). Compaction is automatic; the model's job is to keep working.
 */
export const CONTEXT_POLICY_TEXT =
	'Context management is automatic and is not your responsibility: the harness measures this conversation and ' +
	'compacts it at a configured threshold. You cannot measure your own context usage, so never estimate it. ' +
	'Never stop, shorten, defer, or hand off work because you believe your context is nearly full, and never cite ' +
	'a context limit as a reason to change plans or to ask the user to start a new session — keep working until the ' +
	'user stops you or the task is complete.';

/**
 * Placement of that section: directly after the deployment persona prefix, well
 * before the plan/team policies, so it reads as a standing rule rather than as
 * tool documentation.
 */
const CONTEXT_POLICY_ORDER = 100;

/**
 * Compaction engine with a three-layer policy table.
 *
 * Policy is resolved per routed target rather than once at construction, because
 * one session can change models mid-conversation and each model may carry its
 * own threshold and summarization route.
 */
export class CompactionControlEngine extends BasicCompactionEngine {
	/**
	 * This plugin's config schema. Must be declared explicitly: statics are
	 * inherited, so omitting it would make the loader validate this plugin's
	 * document against the *parent's* schema (see the schema's own comment).
	 */
	static Config = z.object({
		// 根字段判活（`.volatile()`）：dsh-settings 只把带 volatile 字段的 entry
		// 供到设置平面（volatileForm），而 schemastery 不允许"字典里再嵌 volatile
		// 字段"（$.providers.*.threshold ... without an enclosing volatile field），
		// 所以只能标在这四个固定路径上。标了之后本插件读自己的配置必须先
		// plainConfig() 解单元格。
		default: layer.volatile(),
		providers: z.dict(layer).volatile(),
		models: z.array(modelLayer).volatile(),
		auto: z.boolean().volatile(),
	});

	/**
	 * The operator's policy document, validated at load time and kept separately
	 * from the parent's already-resolved config so the parent can be fed a
	 * per-target configuration on each call.
	 */
	controlConfig;

	/**
	 * The composition document, kept unresolved-of-the-user: every later read of
	 * `settings.yaml` is overlaid on *this*, so a layer the file does not restate
	 * (a `models[]` row the profile shipped, a `providers{}` entry) survives the
	 * user's first edit instead of being silently dropped.
	 */
	baseConfig;

	/**
	 * The latest `compaction-control:` section read from `settings.yaml`, or
	 * undefined when that file is absent or silent. A dsh with the profile
	 * importer renames the file away at boot, so this normally stays undefined
	 * and the patch layer below is what carries the operator's numbers.
	 */
	_fileSection;

	/**
	 * The latest `config:` mapping read from the profile's `cordis.patch.yml`
	 * for this plugin's loader entry. Outranks `_fileSection` because dsh applies
	 * the patch layer last; a running server does not re-read it on its own, so
	 * this watcher is the only thing that makes a patch edit take effect live.
	 */
	_patchEntry;

	/** Which source the live policy came from, for the `source=` diagnostic. */
	_fileOrigin;

	/** Resolved policy per `provider/model` *and* window, so a hot path does not re-merge layers. */
	policyCache = new Map();

	/** Warning texts already printed, so an unworkable policy is stated once. */
	reportedWarnings = new Set();

	/** Live settings document, or undefined when no settings provider is mounted. */
	settingsState;

	/**
	 * @param ctx - context providing the LLM, token-meter, and session services.
	 * @param config - the operator's policy document, used as the composition default.
	 */
	constructor(ctx, config = {}) {
		// Resolve first: a malformed policy must fail here, with this plugin's own
		// diagnostics, rather than at the first compaction.
		const controlConfig = resolveConfig(plainConfig(config));
		// Seed the parent with the global default layer, so inherited code paths that
		// read `this.config` without a routed request already see the right numbers.
		const baseline = resolvePolicy(controlConfig, { provider: '', model: '' });
		super(ctx, { ...toBasicConfig(baseline), auto: controlConfig.auto });
		// Keep the parent's *own* resolved shape (`headroomTokens` above all, which it
		// defaults to 65536): every later `applyPolicy` rebuild starts from it, because
		// `toBasicConfig` names only the fields this plugin owns.
		this._parentDefaults = { ...this.config };
		this.controlConfig = controlConfig;
		this.baseConfig = controlConfig;

		// Publish the user-facing settings section, based on this plugin's own config,
		// so a profile ships a working policy the user tunes from the settings page.
		// With no settings provider the section is never published at all.
		this.settingsState = installSettings(ctx, SETTINGS_NS, settingsSchema, controlConfig, () => {
			// The document changed (possibly an external file edit): drop every cached
			// policy, or the cache would pin it for the life of the process.
			this.reloadPolicy();
		});

		// Read the same section straight from `settings.yaml` as well.
		//
		// The injected path above is canonical, but it does not reach a preset-plane
		// engine on this deployment: gate lines carried the composition's 0.8 while
		// the file said 0.2, with no change notification. This reader gives the engine
		// the one source both realms share and a person actually edits.
		this._settingsFileWatcher = watchSettingsFile({
			file: settingsFilePath(),
			fallbackSection: controlConfig,
			onSection: (section, origin) => {
				this._fileSection = section;
				this._fileOrigin = origin;
				this.reloadPolicy();
			},
			onError: (error) => {
				this.ctx.logger?.warn?.(`compaction-control: settings.yaml unreadable (${error.message}); keeping the last good policy`);
			},
		});
		ctx.effect(() => () => this._settingsFileWatcher?.());

		// Read the profile patch layer too: in a dsh that ships the profile
		// importer, `settings.yaml` is renamed away at boot and the patch file is
		// the layer a person actually edits. Nothing in dsh watches it — its own
		// header says a restart is required — so without this poll an edit to the
		// chain or the threshold reaches a running engine only on restart.
		//
		// The patch layer outranks `settings.yaml` because it is the layer dsh
		// applies last, so it is allowed to override the section read above.
		// The running profile, not an inherited env var: `DSH_PROFILE` names the
		// *parent* process's profile when this dsh was launched from an agent's
		// shell tool. `profileContext` is the host's own answer (see
		// `patchFilePaths` for the measured failure).
		const runningProfile = ctx.get?.('profileContext')?.name;
		this._patchFileWatcher = watchPatchFile({
			files: patchFilePaths(process.env, runningProfile),
			onConfig: (config) => {
				// `reloadPolicy` derives `source=` from which layers are present, so
				// this callback only records the value.
				this._patchEntry = config;
				this.reloadPolicy();
			},
			onError: (error) => {
				this.ctx.logger?.warn?.(`compaction-control: profile patch unreadable (${error.message}); keeping the last good policy`);
			},
		});
		ctx.effect(() => () => this._patchFileWatcher?.());

		// One line per process, on stderr, unconditionally: "the policy is not being
		// applied" and "this plugin never mounted" are otherwise indistinguishable
		// from outside (the card renders either way, and a disabled or auto:false
		// engine prints no gate diagnostic at all). The fiber name says *which* mount
		// this is — a host-plane and a preset-realm engine print the same numbers.
		process.stderr.write(
			`[compaction] engine up: fiber=${this.ctx.fiber?.name} ` +
				`threshold=${declaredText(this.controlConfig.default.threshold, this.controlConfig.default.thresholdTokens)} ` +
				`retain=${declaredText(this.controlConfig.default.retain, this.controlConfig.default.retainTokens)} auto=${controlConfig.auto} ` +
				`thinking=${THINKING_OFF} source=${this._fileOrigin}\n`,
		);
	}

	/**
 * Re-resolve the operator's document and drop cached policies.
 *
 * A malformed document is reported and the previous policy kept: a bad edit must
 * not take the running session's compaction down, and silently reverting to
 * built-in defaults would be worse than either.
 */
	reloadPolicy() {
		// Precedence, lowest first: the composition config, then the injected
		// settings service or `settings.yaml`, then the profile patch layer. Each
		// later source is *overlaid* rather than replacing the document, so the
		// layers the profile declared but the operator did not restate (per-model
		// rows above all) survive a save — replacing them silently dropped them.
		//
		// The patch layer is applied last because dsh applies it last: it is the
		// final word on this entry's config, and a running server that never
		// re-reads it is exactly how an edit went unnoticed until restart.
		let document = this.baseConfig;
		let origin = 'composition';
		// `_fileOrigin` says where `_fileSection` came from, and it is the only
		// honest answer: when `settings.yaml` is absent the watcher still reports
		// the composition as a fallback section, so testing `_fileSection` alone
		// labelled a built-in default as `settings.yaml`. That turned the one
		// diagnostic meant to expose "the config never reached the engine" into a
		// line asserting the opposite. Measured 2026-11-25.
		if (this._fileSection !== undefined && this._fileOrigin === 'settings.yaml') {
			document = overlayDocument(document, this._fileSection);
			origin = 'settings.yaml';
		} else if (this.settingsState !== undefined) {
			const current = this.settingsState.current();
			if (current !== undefined) {
				document = current;
				origin = 'settings-service';
			}
		}
		if (this._patchEntry !== undefined) {
			document = overlayDocument(document, this._patchEntry);
			origin = 'cordis.patch.yml';
		}
		this._fileOrigin = origin;
		try {
			this.controlConfig = resolveConfig(plainConfig(document));
		} catch (error) {
			this.ctx.logger?.warn?.(`compaction-control: ignoring invalid settings (${error.message})`);
			return false;
		}
		this.policyCache.clear();
		this.reportedWarnings.clear();
		// One line per accepted change: the settings path is live, so this record is
		// the only way to tell "the watcher fired and the document was accepted" from
		// "the edit never arrived".
		this.ctx.logger?.info?.(
			`compaction-control: policy reloaded (default.threshold=${declaredText(this.controlConfig.default.threshold, this.controlConfig.default.thresholdTokens)} ` +
				`default.retain=${declaredText(this.controlConfig.default.retain, this.controlConfig.default.retainTokens)} auto=${this.controlConfig.auto} ` +
				`routes=${Object.keys(this.controlConfig.providers).join(',') || '-'} ` +
				`models=${this.controlConfig.models.length} source=${this._fileOrigin})`,
		);
		return true;
	}

	/**
 * Resolve (and cache) the effective policy for one routed target.
 *
 * Keyed by the window as well as the target: an absolute token budget resolves to
 * different ratios on two windows, so a target-only key would pin whichever
 * window was seen first.
 */
	policyFor(target, contextWindow) {
		const key = `${target.provider}\u0000${target.model}\u0000${contextWindow ?? ''}`;
		const cached = this.policyCache.get(key);
		if (cached !== undefined) return cached;
		const policy = resolvePolicy(this.controlConfig, target, contextWindow);
		this.policyCache.set(key, policy);
		return policy;
	}

	/**
 * The route's declared context window, when it declares a usable one.
 *
 * Not cached: it is one adapter-local read per step, and caching would only add
 * staleness. Absence is a normal answer — a ratio-only policy never consults it.
 */
	async contextWindowOf(target, signal) {
		if (target === undefined) return undefined;
		try {
			const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
			const window = info?.context?.contextWindow;
			return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined;
		} catch {
			return undefined;
		}
	}

	/**
 * Apply the operator's policy for one target to the parent's config.
 *
 * Rebuilt rather than patched (a patch would leave a previous target's fields
 * behind) and seeded from the parent's own resolved defaults, because
 * `toBasicConfig` names only this plugin's fields — dropping `headroomTokens`
 * made the parent's threshold NaN and silently disabled the gate. This plugin's
 * vocabulary is `threshold`/`retain`; the parent's is
 * `thresholdRatio`/`retainRatio`; `toBasicConfig` translates.
 *
 * @param target - routed provider and model.
 * @param contextWindow - the route's declared window, when the caller has it.
 * @returns the target's policy.
 */
	applyPolicy(target, contextWindow) {
		const policy = this.policyFor(target, contextWindow);
		// Refuse an absolute budget this route cannot convert, rather than silently
		// replacing it with the engine default: the alternative is a policy that reads
		// as applied while the gate runs on a number nobody wrote.
		if (policy.deferred.length > 0) {
			throw new CompactionConfigError(
				`${policy.deferred.join(' and ')} for ${target.provider}/${target.model} cannot be honored: ` +
					'this route declares no context window to convert from. State the budget as a ratio, or fix the route\'s declared window.',
			);
		}
		const owned = toBasicConfig(policy);
		// Seed the rebuild from the parent's own resolved defaults: `toBasicConfig`
		// names only this plugin's fields, so building from it drops `headroomTokens`
		// — and the parent then computes `Math.min(window * ratio, NaN)` → **NaN**,
		// which makes every gate comparison false. Compaction then fires on *every*
		// step and the retry loop can never succeed (the 2026-10-03 runaway, context
		// compacted repeatedly down to a few hundred tokens).
		const next = { ...this._parentDefaults, ...owned, auto: this.controlConfig.auto };
		// Retention is a mutually exclusive pair; leaving the inherited sibling in
		// place makes the parent reject the whole config.
		if (owned.retainTokens === undefined) delete next.retainTokens;
		else delete next.retainRatio;
		this.config = this.constructor.resolvedConfigFor(next);
		// Fail loud rather than gate-off: a non-finite threshold is not a "no
		// compaction needed" answer, and ignoring it is precisely the runaway above.
		// Throwing is safe — the parent's `agent/pre-step` logs it and continues.
		for (const field of FIELD_CHECKED_AFTER_APPLY) {
			if (Number.isFinite(this.config[field])) continue;
			throw new CompactionConfigError(
				`compaction-control: the parent engine's "${field}" is ${this.config[field]} after applying the policy for ` +
					`${target.provider}/${target.model}; a non-finite threshold silently disables the pressure gate. ` +
					'This means the parent schema no longer fills its own defaults — report it with this message.',
			);
		}
		// The parent needs exactly one retention unit; checked post-resolution, so an
		// absolute `retainTokens` policy is accepted and one that lost both is not.
		const retention = [this.config.retainRatio, this.config.retainTokens].filter((value) => Number.isFinite(value));
		if (retention.length !== 1) {
			throw new CompactionConfigError(
				`compaction-control: the parent engine holds ${retention.length} usable retention values ` +
					`(retainRatio=${this.config.retainRatio}, retainTokens=${this.config.retainTokens}) after applying the policy for ` +
					`${target.provider}/${target.model}; exactly one finite value is required.`,
			);
		}
		this.reportWarnings(policy);
		return policy;
	}

	/**
 * Say once per distinct message what is wrong with a policy's numbers: a warning
 * that repeats hundreds of times an hour is a warning nobody reads.
 */
	reportWarnings(policy) {
		for (const warning of policy.warnings) {
			if (this.reportedWarnings.has(warning)) continue;
			this.reportedWarnings.add(warning);
			process.stderr.write(
				`[compaction] WARNING fiber=${this.ctx.fiber?.name} target=${policy.target.provider}/${policy.target.model} ${warning}\n`,
			);
		}
	}

	/**
 * Validate a config in the parent's vocabulary against the parent's schema, which
 * is the authoritative statement of its shape — no duplicated copy to drift from.
 */
	static resolvedConfigFor(config) {
		return BasicCompactionEngine.Config(config);
	}

	/**
 * Consider automatic compaction under the operator's policy for this target;
 * region selection, tool-result pruning, retries, and the durable transaction all
 * remain the parent's.
 */
	async compactIfNeeded(agent, trigger, signal) {
		const target = conversationTarget(agent);
		let thresholdTokens;
		let result;
		try {
			// Needed twice (absolute-budget conversion and the diagnostic), so resolved
			// once. Not a failure condition: a ratio-only policy never consults it.
			const window = await this.contextWindowOf(target, signal);
			// Apply the policy *before* the diagnostic, so the numbers it prints are
			// the ones the gate will compare; reading `this.config` first would report
			// the constructor baseline and misreport every override as ineffective.
			const policy = target === undefined ? undefined : this.applyPolicy(target, window);
			// The gate's number comes from the *policy*, not from `this.config`.
			// `this.config` is only right here because `applyPolicy` happens to have
			// rewritten it, and when `target` is undefined it still holds the engine's
			// constructor baseline (0.8/0.16 on this deployment). Gating on that number
			// is silent and wrong: the settings card reads 42% while compaction fires at
			// 80%, which is indistinguishable from "my setting never applied".
			const ratio = policy?.thresholdRatio ?? this.config.thresholdRatio;
			thresholdTokens =
				policy?.thresholdTokens ??
				(window === undefined ? undefined : Math.floor(window * ratio));
			reportUnstatedThreshold(this, target, policy);
			if (process.env.DSH_COMPACT_DEBUG) {
				let measured = 'unavailable';
				try {
					measured = this.ctx.tokenMeter.measure(agent.session).totalTokens;
				} catch (error) {
					measured = `error(${error.message})`;
				}
				// The verdict, not just the inputs: `gate` is the comparison the parent is
				// about to make, so "compaction never fired" is answerable from one line.
				const gate =
					thresholdTokens === undefined || typeof measured !== 'number'
						? 'unknown'
						: measured >= thresholdTokens
							? 'FIRE'
							: 'wait';
				// `declared.*` is the document as written, in its own unit, beside the
				// numbers the parent compares.
				process.stderr.write(
					`[compact-debug] fiber=${this.ctx.fiber?.name} trigger=${trigger} target=${target === undefined ? 'UNDEFINED' : `${target.provider}/${target.model}`} ` +
						`declared.threshold=${declaredText(
							this.controlConfig.default.threshold,
							this.controlConfig.default.thresholdTokens,
						)} ` +
						`declared.retain=${declaredText(
							this.controlConfig.default.retain,
							this.controlConfig.default.retainTokens,
						)} ` +
						`thresholdRatio=${this.config.thresholdRatio} retainRatio=${this.config.retainRatio} ` +
						`retainTokens=${this.config.retainTokens} headroomTokens=${this.config.headroomTokens} window=${window ?? 'unresolved'} ` +
						`thresholdTokens=${thresholdTokens ?? 'unknown'} measured=${measured} gate=${gate} ` +
						`source=${this._fileOrigin}\n`,
				);
			}
			result = await super.compactIfNeeded(agent, trigger, signal);
		} catch (error) {
			// The parent's own log line does not reach this deployment's log destination,
			// and a summary that fails on every step leaves the conversation growing with
			// no visible cause — so state it on stderr too, once per trigger.
			if (this._reportedFailures.get(trigger) !== String(error?.message ?? error)) {
				this._reportedFailures.set(trigger, String(error?.message ?? error));
				process.stderr.write(
					`[compaction] FAILED fiber=${this.ctx.fiber?.name} trigger=${trigger} target=${target === undefined ? 'UNDEFINED' : `${target.provider}/${target.model}`} error=${String(error?.message ?? error)}\n`,
				);
			}
			// The de-duplication above keeps the wording readable; this keeps the
			// *persistence* visible. Silence was the actual defect on 2026-11-26.
			this._consecutiveFailures += 1;
			if (this._consecutiveFailures >= this.constructor.CONSECUTIVE_FAILURE_WARN_AT && !this._streakEscalated) {
				this._streakEscalated = true;
				process.stderr.write(
					`[compaction] ⚠️ ${this._consecutiveFailures} CONSECUTIVE FAILURES fiber=${this.ctx.fiber?.name} ` +
						`trigger=${trigger} target=${target === undefined ? 'UNDEFINED' : `${target.provider}/${target.model}`} ` +
						`this.session=${agent?.session?.id ?? 'unknown'} error=${String(error?.message ?? error)} ` +
						`— compaction is the recovery path for every other failure, so this session is no longer self-healing. ` +
						`Check the summarization route and its declared context window; if the surface has outgrown the window, ` +
						`a rescue outside DSH may be required (tools/dsh-session-rescue.mjs).\n`,
				);
			}
			throw error;
		}
		if (result !== null) {
			// A success resets the streak: only *consecutive* failures say the route
			// is broken, and an intermittent one must not accumulate into a warning.
			this._consecutiveFailures = 0;
			this._streakEscalated = false;
			process.stderr.write(
				`[compaction] FIRED fiber=${this.ctx.fiber?.name} trigger=${trigger} source=${this._fileOrigin} thresholdRatio=${this.config.thresholdRatio} thresholdTokens=${thresholdTokens ?? 'unknown'} shadowed=${result.shadowedSeqs.length} seqs=${result.shadowedRange.start}-${result.shadowedRange.end} tokens=~${result.shadowedTokenCount}\n`,
			);
		}
		return result;
	}

	/**
 * How long a manual compaction waits for the agent's previous activity to release
 * its gate before reporting it stuck. Overridable so a test need not wait the
 * production timeout to pin the failure branch.
 */
	static MANUAL_GATE_WAIT_MS = 10_000;

	/**
 * Run one manual compaction that outlives the caller's own cancellation.
 *
 * Two inherited defects are fixed here, both measured 2026-10-04 (two sessions,
 * each: the first attempt aborted ~4s in, the second reported "busy"):
 *
 *   1. The transaction was composed with the **UI request's** signal, which
 *      `dsh-commands` also races the handler against — so a dropped request
 *      killed a 20–40s durable compaction while the command had already settled
 *      as "This operation was aborted". The parent now receives a never-aborting
 *      signal; only the agent's maintenance signal cancels (Stop still works).
 *   2. The parent `return`s `runMaintenance(…)` without `await`, so async
 *      failures escape its `catch`, and that `catch` rewrites any synchronous
 *      failure into `busy`. Awaiting it lets the real cause through, and a gate
 *      that is merely still closing is waited out once instead of being reported
 *      as an active compaction that does not exist.
 *
 * @param agent - idle agent whose next-turn admission this call reserves.
 * @param signal - the caller's cancellation signal (the UI request).
 * @param sourceCommandId - initiating command identity for presentation correlation.
 * @returns the committed result, or `null` when no safe useful range exists.
 */
	async compactNow(agent, signal, sourceCommandId) {
		// The request signal governs only the decision to *start*: a caller that
		// already gave up must not open a transaction nobody is waiting for.
		signal?.throwIfAborted?.();
		// A running turn is not a closing gate; waiting for it would stall the
		// command for the length of the turn and then still refuse. Say so at once.
		if (agent?.status === 'running') {
			throw new Error(
				'manual compaction needs an idle agent: this session is running a turn. ' +
					'Stop it or wait for the turn to finish, then retry /compact.',
			);
		}
		// A manual compaction shall honour the same policy as an automatic one. It did
		// not: the parent's `compactNow` hard-codes a zero retention (its forced
		// reduction semantic), so `/compact` collapsed the history onto a single
		// surface node while the pressure gate kept the operator's whole tail. That is
		// not a size difference, it is a different policy, and it is the reason a user
		// could not trust a manual compaction to leave the session usable.
		//
		// The policy cannot be passed to the parent — the transaction that would take
		// a retention is private to the upstream package — so it is applied by
		// changing what the parent's range selector sees (see `reframeMeasurement`).
		const retainTokens = this.retainTokensForManual(agent);

		const waitMs = this.constructor.MANUAL_GATE_WAIT_MS;
		for (let attempt = 0; ; attempt += 1) {
			try {
				if (retainTokens === undefined) {
					return await super.compactNow(agent, detachedSignal(), sourceCommandId);
				}
				return this.compactNowWithRetention(agent, detachedSignal(), sourceCommandId, retainTokens);
			} catch (error) {
				if (!isMaintenanceGateError(error)) throw error;
				// A closing gate is waited out exactly once. Any second refusal is a
				// genuinely busy agent, and the message must say that rather than
				// claim an active compaction that does not exist.
				if (attempt > 0) {
					throw new Error(
						`manual compaction could not start: the agent is still finishing its previous activity ` +
							`after waiting ${waitMs}ms. The compaction lock itself is free — retry /compact now.`,
						{ cause: error },
					);
				}
				await waitForAgentIdle(agent, signal, waitMs);
				// The wait may have been cut short by the caller giving up.
				signal?.throwIfAborted?.();
			}
		}
	}

	/**
	 * The context window a routed target was last resolved against, read from the
	 * policy cache without a model round-trip.
	 *
	 * `policyFor` keys on the window as well as the target — an absolute budget
	 * resolves to different ratios on two windows — so the window the pressure gate
	 * used is recoverable from the cache it already wrote. That is what lets the
	 * manual path stay synchronous: `resolveModelInfo` is the only other source and
	 * it is a promise, which `compactNow` cannot await without breaking the contract
	 * its callers rely on (the parent's transaction body runs to its first await
	 * before the caller gets to inspect it — the wrapper tests pin exactly that).
	 *
	 * @param target - routed provider and model.
	 * @returns the last window used, or undefined when the gate never ran for it.
	 */
	cachedWindowOf(target) {
		const prefix = `${target.provider}\u0000${target.model}\u0000`;
		for (const key of this.policyCache.keys()) {
			if (!key.startsWith(prefix)) continue;
			const window = Number(key.slice(prefix.length));
			if (Number.isFinite(window) && window > 0) return window;
		}
		return undefined;
	}

	/**
	 * The retention the operator's policy asks a manual compaction to keep, in
	 * tokens, read from the state the pressure gate already resolved.
	 *
	 * Deliberately synchronous and deliberately `undefined` — not a default, not a
	 * guess — when the policy cannot be resolved for this route (no routed target,
	 * no cached window, or a retention that resolves to nothing). A manual
	 * compaction then keeps the parent's own forced-reduction semantics rather than
	 * inventing a number: silently guessing a retention is how a compaction ends up
	 * keeping context the operator never asked for.
	 *
	 * @param agent - idle agent whose session is about to be compacted.
	 * @returns the retention in tokens, or undefined.
	 */
	retainTokensForManual(agent) {
		// `conversationTarget` dereferences the agent's session and options, and a
		// manual compaction can arrive from a caller that supplies neither — a test
		// double, or an agent whose session is not up yet. No policy can be honoured
		// for such a caller, so the parent's own forced-reduction semantics apply:
		// that is the behaviour this method existed to refine, not a new failure.
		if (agent?.session === undefined || agent?.options === undefined) return undefined;
		const target = conversationTarget(agent);
		if (target === undefined) return undefined;
		const window = this.cachedWindowOf(target);
		if (!Number.isFinite(window)) return undefined;
		// The parent resolves a ratio against the message budget — the window less
		// what the route reserves for its own completion — and manual compaction must
		// use the same number or the two paths disagree about what "keep the tail"
		// means. The reserve is the latest routed request's configured maxTokens, the
		// same value the parent's own `reservedCompletionTokens` prefers.
		const reserved = agent.session.requestHeader?.()?.config?.maxTokens ?? this.config.maxTokens ?? 0;
		const messageBudget = window - reserved;
		const tokens = this.config.retainTokens;
		const retain = tokens === undefined || !Number.isFinite(tokens) ? Math.floor(messageBudget * this.config.retainRatio) : tokens;
		if (!Number.isFinite(retain) || retain <= 0) return undefined;
		return retain;
	}

	/**
	 * Run the parent's manual compaction with its range selector held to the
	 * operator's retention.
	 *
	 * The shadow is a receiver, never a mutation: `ctx.extend()` returns a context
	 * that prototypally inherits this one with `tokenMeter` shadowed, and the
	 * parent runs against that receiver. Writing the live context instead is what
	 * Cordis rejects outright — a service property belongs to the fiber that
	 * provided it, so the assignment throws "cannot set property in multiple
	 * fibers" — and the failure is realm-dependent, which is the worst shape for a
	 * bug to take. Nothing is shared, so concurrent compactions in one realm cannot
	 * leak one conversation's re-pricing into another's.
	 *
	 * @param agent - idle agent whose session is compacted.
	 * @param signal - cancellation scoped to this compaction.
	 * @param sourceCommandId - command identity for presentation correlation.
	 * @param retainTokens - the retention the policy asked for, in tokens.
	 * @returns the committed result, or `null` when no safe useful range exists.
	 */
	async compactNowWithRetention(agent, signal, sourceCommandId, retainTokens) {
		const meter = this.ctx.tokenMeter;
		const measured = meter.measure(agent.session);
		const keepFromIdx = retainKeepIndex(measured, retainTokens);
		if (process.env.DSH_COMPACT_DEBUG) {
			process.stderr.write(
				`[compact-debug] fiber=${this.ctx.fiber?.name} trigger=manual-target target=${agent.session.id} ` +
					`retained=${retainTokens} keepFromIdx=${keepFromIdx ?? 'none'} nodes=${measured.nodes.length} ` +
					`measured=${measured.totalTokens}\n`,
			);
		}
		// Nothing to hold: the selection already returns null on its own, and
		// shadowing a meter for a call the parent will refuse is pure risk.
		if (keepFromIdx === undefined) return super.compactNow(agent, signal, sourceCommandId);
		const shadow = Object.create(meter);
		Object.defineProperty(shadow, 'measure', {
			value: (session) => reframeMeasurement(meter.measure(session), keepFromIdx),
		});
		const receiver = Object.create(this);
		// `defineProperty`, not assignment: when a method is entered through
		// `ctx.compaction.<method>()` cordis rebinds `this` to a traceable shadow
		// proxy in which `ctx` is read-only by design, and `receiver.ctx = …`
		// walks that chain and trips its `set` trap
		// (`'set' on proxy: trap returned falsish for property 'ctx'`). The
		// automatic path enters with `this` still the real engine, which is why
		// only the manual `/compact` route failed.
		Object.defineProperty(receiver, 'ctx', {
			value: this.ctx.extend({ tokenMeter: shadow }),
			writable: true,
			configurable: true,
		});
		// The parent prices the compaction through `regionDependencies().meter`, and
		// the re-priced nodes would charge a summary for megabytes of context that
		// were never in it. Pricing therefore runs against the real meter while only
		// the range selector sees the reframed one. `call(this)` rather than a
		// closure over `receiver`: a plain closure would recurse into this override.
		receiver.regionDependencies = () => ({
			...BasicCompactionEngine.prototype.regionDependencies.call(this),
			meter,
		});
		return BasicCompactionEngine.prototype.compactNow.call(receiver, agent, signal, sourceCommandId);
	}

	/** Last failure reported per trigger, so a repeating failure is stated once. */
	_reportedFailures = new Map();

	/**
	 * Consecutive compaction failures, and whether the current streak has already
	 * been escalated.
	 *
	 * Why this exists: a repeating failure is de-duplicated above so the log stays
	 * readable, but that same de-duplication is what let a Win11 session fail
	 * **32 compactions in a row** without anyone noticing — every step logged
	 * nothing new, and the conversation simply grew until it could never be
	 * compacted again. De-duplicating the wording must not suppress the fact that
	 * the failure is *persistent*.
	 *
	 * The escalation threshold is deliberately small: compaction is the recovery
	 * path for every other failure, so three in a row means the session is no
	 * longer self-healing and the operator has to hear it while a fix is still
	 * cheap.
	 */
	_consecutiveFailures = 0;

	/** Whether the current failure streak has been escalated to a warning. */
	_streakEscalated = false;

	/** Escalate once the streak reaches this many consecutive failures. */
	static CONSECUTIVE_FAILURE_WARN_AT = 3;

	/** Targets already warned about gating on the engine baseline. */
	_reportedUnstatedThreshold = new Set();

	/**
	 * Routes already told what their summarization thinking control is, so the
	 * diagnostic is stated once per provider/model per process rather than once
	 * per compaction — a route that cannot be told not to think is a property of
	 * the route, not of the call, and repeating it per step would bury the one
	 * line that explains a slow summary under thousands of gate lines.
	 */
	_reportedThinkingControl = new Map();

	/**
 * Summarize through the operator's chosen model, or through the conversation's
 * own when the policy says `auto` — handing the parent an empty target makes it
 * fall back to the latest routed request, which preserves the provider's warm
 * prefix cache.
 *
 * The message list is the caller's own: upstream replays only the shadowed
 * region, and that region is bounded by the gate that selected it, so the
 * request is bounded too.
 */
	async summarize(input, agent, signal) {
		// The parent's own region-only input is used verbatim. A full-conversation
		// replay was tried to reuse a local engine's prefix cache and removed on
		// 2026-11-26: it made the summary request carry the whole session, which is
		// the one payload that must stay bounded — a conversation large enough to
		// need compaction is one whose replay no longer fits, so the request that
		// was supposed to rescue the session could not be sent at all.
		//
		// It is now opt-in (`replayFullConversation`), resolved below against the
		// same policy layer every other knob comes from.
		const target = conversationTarget(agent);
		// The window goes with the policy for the same reason it does in the gate:
		// an absolute retention has to be converted before the parent can compare
		// it, and a document stated in tokens must not resolve two different ways
		// on the two paths that apply it.
		const policy = target === undefined ? undefined : this.applyPolicy(target, await this.contextWindowOf(target, signal));
		const effective = summarizationInput(input, agent, policy?.replayFullConversation);
		const effort = await this.resolveEffort(target, signal);
		// The diagnostic, not the decision: `effort` below is exactly what it was
		// before this line existed, and the seam is still installed on the same
		// condition. What changes is that a route which will think by default now
		// says so once, instead of costing reasoning tokens in silence.
		this.logThinkingControl(target, await this.thinkingControlOf(target, signal));
		const fallback = policy?.summarizationFallback ?? [];
		// `effort` decides whether this call needs the seam at all: with no declared
		// "do not think" level and no chain there is nothing to give the seam. It is
		// not handed to it — the attempt re-resolves the level against whichever route
		// serves it, because a chain's later routes do not have to accept the primary's,
		// and naming an undeclared id is a hard rejection.
		//
		// A route with no declared thinking level and no fallback chain needs no seam
		// at all: `super.summarize` is the parent's own call with the parent's own
		// context, and shadowing it would add a hand-off for nothing.
		if (effort === undefined && fallback.length === 0) return super.summarize(effective, agent, signal);
		// The parent assembles the whole summary request and calls `ctx.llm.stream`
		// itself, and the package exports only the engine class — so there is no
		// request option to hand the effort or the fallback to. The seam therefore
		// has to be the context, and the only safe direction is *outward*:
		// `ctx.extend()` returns a new context that prototypally inherits this one
		// with `llm` shadowed by a thin forwarder, and the parent runs against that
		// receiver.
		//
		// Writing the live context instead (`ctx.llm = …`) is what shipped first,
		// and Cordis rejects it — a service property belongs to the fiber that
		// provided it, so the assignment throws `cannot set property "llm" in
		// multiple fibers`. On this deployment that failure was realm-dependent:
		// the host-plane engine shares the provider fiber and could assign, the
		// preset-plane engine could not, which is why a manual compaction (served
		// by the former) completed while every automatic one (dispatched to the
		// latter) aborted right after the gate fired.
		//
		// Nothing is shared or mutated here, so concurrent compactions in one realm
		// cannot leak one conversation's effort — or one conversation's fallback
		// attempt — into another's summary.
		const llm = this.ctx.llm;
		const shadow = Object.create(llm);
		Object.defineProperty(shadow, 'stream', {
			value: (options) => this.streamWithFallback(llm, options, { fallback, signal }),
		});
		const receiver = Object.create(this);
		// `defineProperty`, not assignment — see `compactNowWithRetention` above for
		// why an assignment here trips cordis's read-only `ctx` shadow.
		Object.defineProperty(receiver, 'ctx', {
			value: this.ctx.extend({ llm: shadow }),
			writable: true,
			configurable: true,
		});
		return BasicCompactionEngine.prototype.summarize.call(receiver, effective, agent, signal);
	}

	/**
	 * The parent's summarization stream, with the reasoning effort applied and the
	 * configured fallback chain attempted in order.
	 *
	 * The chain exists because the harness has none. `dsh-llm-retry` retries the
	 * *same* provider/model with backoff, keyed by `retryStateKey(provider,
	 * policyKey)`; nothing anywhere in the official packages walks to a different
	 * model on failure. And a summarization call is exactly where that hurts: the
	 * summary is the one request the harness cannot proceed without, so a free
	 * route that is rate-limited or briefly down stops the conversation instead of
	 * degrading to the next route.
	 *
	 * The parent consumes this stream incrementally
	 * (`for await (const chunk of ctx.llm.stream(options))`), so an attempt cannot
	 * be yielded as it arrives: a failure is only known once the stream ends, and
	 * by then the parent has already fed the assembler. Each attempt is therefore
	 * buffered whole, and only a complete, text-bearing attempt is released. A
	 * failed attempt contributes nothing to the parent — not its deltas, not its
	 * usage — so its cost is the operator's bill, never a corrupted summary.
	 *
	 * `options` is rewritten in place on success, because the parent reads
	 * `options.provider`/`options.model` **after** the stream to record the
	 * `compaction/summary` row. Without that rewrite the durable record would name
	 * the primary route while a fallback did the work — and that record is the only
	 * evidence an operator has of which model summarized what.
	 *
	 * @param llm - the real llm service, captured before the context was shadowed.
	 * @param options - the parent's assembled request.
	 * @param attempt - the ordered fallback routes and the call's abort signal.
	 * @returns an async generator of chunks from the first attempt that succeeds.
	 */
	async *streamWithFallback(llm, options, attempt) {
		const { fallback, signal } = attempt;
		const primary = { provider: options.provider, model: options.model };
		const routes = [primary, ...fallback];
		const reasons = [];
		for (const [index, route] of routes.entries()) {
			const chunks = [];
			let failure;
			let sawText = false;
			// The effort is per route, not per call: a level the primary offers is not
			// one a fallback route has to accept, and naming an undeclared id is a hard
			// rejection rather than a drop to the adapter default. Resolve it against
			// whatever route serves the attempt, and send none at all when that route
			// offers nothing or its levels cannot be read — a guess is not safer here,
			// because a wrong guess is refused outright and burns the attempt.
			const routeEffort = await this.resolveEffort(route, signal, llm);
			// Per route, for the same reason the effort is: a fallback route that
			// cannot be told not to think is a different route's problem, and the
			// chain is walked one route at a time.
			this.logThinkingControl(route, await this.thinkingControlOf(route, signal, llm));
			try {
				for await (const chunk of llm.stream({
					...options,
					provider: route.provider,
					model: route.model,
					...(routeEffort === undefined ? {} : { reasoningEffort: routeEffort }),
				})) {
					// A terminal `error`/`aborted` finish is how `LlmRuntime` reports an
					// adapter, dispatch, or iteration failure — it does not throw — so the
					// stream ending cleanly is not evidence that the attempt worked.
					// `max-tokens` is the third terminal kind and it is not a success:
					// the output was cut at the cap, so the summary is incomplete. Yielding
					// it as text let a truncated checkpoint through as a "successful"
					// summary and the parent only noticed once it assembled it.
					const kind = chunk.type === 'finish' ? chunk.reason?.kind : undefined;
					if (kind === 'error' || kind === 'aborted' || kind === 'max-tokens') {
						failure = chunk.reason.failure ?? { message: `summarization cut at the token cap (finish ${kind})` };
						break;
					}
					chunks.push(chunk);
					if (chunk.type === 'text-delta' && chunk.text.trim().length > 0) sawText = true;
					else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text.trim().length > 0) sawText = true;
				}
			} catch (error) {
				// Middleware, nested-call, and consumer failures *do* throw. Both shapes
				// mean the same thing here: this route produced no usable summary.
				failure = error;
			}
			// Aborting is the operator stopping the work, not a route failing; walking
			// to the next route would spend money on a request nobody is waiting for.
			if (signal?.aborted) throw signal.reason ?? new Error('summarization aborted');
			// An attempt that ends without text produced no summary even when it did not
			// "fail": the parent rejects an empty summary, and re-sending the prompt is
			// cheaper than reporting a compaction that cannot be committed.
			if (failure === undefined && sawText) {
				options.provider = route.provider;
				options.model = route.model;
				if (index > 0) {
					this.ctx.logger?.info?.(
						`compaction-control: summarization fell back to ${route.provider}/${route.model} ` +
							`(route ${index + 1} of ${routes.length}) after ${primary.provider}/${primary.model} failed: ` +
							`${failureMessage(failure ?? { message: 'no summary text' })}`,
					);
				}
				yield* chunks;
				return;
			}
			const reason = failureMessage(failure ?? { message: 'the route produced no summary text' });
			reasons.push(`${route.provider}/${route.model}: ${reason}`);
			this.ctx.logger?.warn?.(
				`compaction-control: summarization attempt ${index + 1}/${routes.length} on ` +
					`${route.provider}/${route.model} failed: ${reason}`,
			);
		}
		// Every route failed. The parent needs a terminal outcome, and its own
		// contract is the `finish` chunk — throwing instead would surface as an
		// unhandled stream error rather than the lawful "summarization failed".
		// The message carries each route's own reason: the parent's caller reports
		// only one line for the whole compaction, and without these an operator has
		// no way to tell a rate-limited free route from a truncated one.
		yield {
			type: 'finish',
			reason: { kind: 'error', failure: { message: `all ${routes.length} summarization routes failed (${reasons.join('; ')})`, code: 'FALLBACK_EXHAUSTED' } },
		};
	}

	/**
 * The reasoning effort the summarization call should carry: summarizing is
 * mechanical compression, so it runs at the route's own "do not think" level. The
 * level id is adapter-owned, so it is matched against what the route declares
 * (an undeclared id is a hard rejection), and a route with no such level gets no
 * effort field at all.
 *
 * `service` is the llm service to read the levels through; the fallback executor
 * passes the one it streams on, because that is the route that has to accept the
 * level, and it may not be the context's own service.
 */
	async resolveEffort(target, signal, service) {
		if (target === undefined) return undefined;
		try {
			const info = await (service ?? this.ctx.llm).resolveModelInfo(target.provider, target.model, signal);
			return pickThinkingOff(info.reasoning?.efforts);
		} catch (error) {
			this.ctx.logger?.warn?.(
				`compaction-control: could not resolve thinking levels for ${target.provider}/${target.model} (${error.message}); summarizing with the adapter default`,
			);
			return undefined;
		}
	}

	/**
	 * The route's declared thinking capability, read once for the diagnostic.
	 *
	 * Separate from `resolveEffort` so the diagnostic cannot change what is sent:
	 * this only reads, and its answer is logged, never returned into a request. A
	 * lookup failure is `unknown` here, and the existing "could not resolve
	 * thinking levels" warning in `resolveEffort` stays the only thing said about
	 * it.
	 *
	 * @param target - routed provider and model; undefined (the `auto` case) is
	 *   skipped by the caller, because there is no route to name.
	 * @param signal - the call's abort signal.
	 * @param service - the llm service to read through; defaults to the context's.
	 * @returns the resolved control, or undefined when there is no route.
	 */
	async thinkingControlOf(target, signal, service) {
		if (target === undefined) return undefined;
		try {
			const info = await (service ?? this.ctx.llm).resolveModelInfo(target.provider, target.model, signal);
			return resolveSummarizationEffort(info);
		} catch {
			return undefined;
		}
	}

	/**
	 * Say once per provider/model what the summarization call will do about
	 * thinking, and warn when it will think.
	 *
	 * The warning is the point. A route with no off level — whether it declares
	 * levels but none of them is an off switch, or declares no reasoning at all —
	 * is one the provider-d adapter treats as non-reasoning: it skips every
	 * thinking-control branch, off included, and the provider then thinks at its
	 * own default inside the summarization `maxTokens`. That used to be completely
	 * silent, and a silent route that burns the cap is indistinguishable from a
	 * merely slow one.
	 *
	 * @param target - routed provider and model. Undefined means `auto`, where
	 *   the route is the conversation's own and is named by the gate's own lines.
	 * @param control - the resolved control; undefined means "could not be read",
	 *   which `resolveEffort` has already reported.
	 */
	logThinkingControl(target, control) {
		if (target === undefined || control === undefined) return;
		const key = `${target.provider}/${target.model}`;
		if (this._reportedThinkingControl.has(key)) return;
		this._reportedThinkingControl.set(key, control.control);
		const offered = control.offered.length === 0 ? 'none' : control.offered.join(', ');
		if (control.control === 'off') {
			this.ctx.logger?.info?.(
				`compaction-control: summarization thinking control for ${key}: ${control.effort} (off level; offered: ${offered})`,
			);
			return;
		}
		// `no-off-level` and `no-reasoning` are the two ways a route ends up
		// thinking by default; `unknown` means its declaration could not be read at
		// all, which is the same risk with less certainty.
		const reason =
			control.control === 'no-off-level'
				? `it declares ${control.offered.length} level(s) (${offered}) and none of them is an off switch`
				: control.control === 'no-reasoning'
					? 'it declares no reasoning capability, so the adapter sends no thinking control at all'
					: 'its declared thinking levels could not be read';
		this.ctx.logger?.warn?.(
			`compaction-control: summarization route ${key} cannot be told not to think: ${reason}; ` +
				'the provider will think at its own default inside the summarization maxTokens',
		);
	}
}

/**
 * Host-plane companion: publishes the settings section and the standing
 * "compaction is automatic" prompt rule.
 *
 * Why a second entry exists: the engine cannot live on the host plane (it would
 * not supersede the preset one — both would listen on the bubbling
 * `agent/pre-step` and the lower threshold would win), yet the browser bundle is
 * discovered from **enabled host-plane loader entries**, and a row that exists
 * only inside a preset is invisible to that scan. So the engine owns the seam and
 * the policy, and this row publishes the settings section, registers
 * {@link CONTEXT_POLICY_SECTION}, and anchors `dsh-client-modules`.
 *
 * It claims no service, and both publications are optional: with no `settings`
 * provider or no `systemPrompt` service the corresponding one is simply never
 * published. The prompt rule is registered here rather than from the engine row
 * because the engine is mounted once per realm — and can be mounted twice.
 */
export class CompactionControlSettings {
	/**
	 * Accepts the same policy document as the engine, because it is the same
	 * document: this row is normally the composition base the settings section
	 * overrides. Declaring the schema keeps a malformed host config a load-time
	 * failure rather than a surprise at first compaction.
	 */
	static Config = z.object({
		// 根字段判活（`.volatile()`）：dsh-settings 只把带 volatile 字段的 entry
		// 供到设置平面（volatileForm），而 schemastery 不允许"字典里再嵌 volatile
		// 字段"（$.providers.*.threshold ... without an enclosing volatile field），
		// 所以只能标在这四个固定路径上。标了之后本插件读自己的配置必须先
		// plainConfig() 解单元格。
		default: layer.volatile(),
		providers: z.dict(layer).volatile(),
		models: z.array(modelLayer).volatile(),
		auto: z.boolean().volatile(),
	});

	/** Live settings document, exposed for tests and diagnostics. */
	settingsState;

	/**
	 * @param ctx - context that may provide the `settings` service.
	 * @param config - the composition default policy document.
	 */
	constructor(ctx, config = {}) {
		// Validated for the same reason the engine validates: a bad document
		// should fail where it was written, naming the field.
		const base = resolveConfig(plainConfig(config));
		this.settingsState = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
		// Publish the standing rule that compaction is automatic. This row is the
		// right owner because it is the only one mounted unconditionally on the host
		// plane — its scope is global, so no preset has to restate the rule — and
		// because a compaction plugin is what makes the rule true. Degradation is
		// the same as the settings section: a profile with no system-prompt service
		// simply never publishes it.
		ctx.inject(['systemPrompt'], (promptCtx) => {
			promptCtx.systemPrompt.section({
				name: CONTEXT_POLICY_SECTION,
				order: CONTEXT_POLICY_ORDER,
				text: CONTEXT_POLICY_TEXT,
			});
		});
	}

	/**
	 * The effective policy document, as the settings page sees it.
	 * @returns the merged document.
	 */
	currentPolicy() {
		return this.settingsState.current();
	}
}

export default CompactionControlEngine;