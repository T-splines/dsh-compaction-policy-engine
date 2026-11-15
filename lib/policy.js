/**
 * Compaction policy resolution for dsh-compaction-policy-engine.
 *
 * Three layers (global default / per-provider / per-model) are merged leaf-wise,
 * then resolved to one policy per routed target. Two units are accepted for the
 * two budget fields: a ratio of the adapter-declared window, or an absolute token
 * count. The token form is resolved through the window at apply time — which is
 * why a route that declares no window cannot honor one, and why that is a loud
 * failure rather than a silent fallback to the engine default.
 *
 * @module dsh-compaction-policy-engine/policy
 */

/** The literal `auto` sentinel, meaning "inherit the conversation's own model". */
export const AUTO = 'auto';

/** Default threshold ratio when a layer states none; matches compaction-basic. */
export const DEFAULT_THRESHOLD_RATIO = 0.8;

/** Default retention ratio when a layer states none; matches compaction-basic. */
export const DEFAULT_RETAIN_RATIO = 0.16;

/** Default provider generation cap for the summarization call. */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Minimum room a compaction must free, in tokens: below this the summary can end
 * up no smaller than what it replaces (`summary is not smaller than the shadowed
 * content`), so the policy is reported as unworkable instead of tried forever.
 */
export const MIN_COMPACT_GAP_TOKENS = 8192;

/**
 * The sentinel meaning "inherit the reasoning effort of the route's own model",
 * used by the `summarizationModel` field.
 */
export const INHERIT_EFFORT = 'inherit';

/**
 * Summarizing is mechanical compression of text already in context, so the
 * summarization call always runs with thinking off; `pickThinkingOff` resolves
 * that from the route's own declared levels.
 */
export const THINKING_OFF = 'off';

/**
 * Aliases adapters use for the "do not think" level, in match order.
 */
const THINKING_OFF_ALIASES = ['off', 'none', 'disabled', 'no-thinking', 'nothinking'];

/**
 * Pick a route's "do not think" effort from the efforts it declares.
 *
 * @param efforts - `LlmReasoningEffortInfo[]` for the summarization route.
 * @returns the matching effort id, or undefined when the route offers none.
 */
export function pickThinkingOff(efforts) {
	if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
	for (const alias of THINKING_OFF_ALIASES) {
		const match = efforts.find((effort) => effort?.id === alias);
		if (match !== undefined) return match.id;
	}
	return undefined;
}

/**
 * What the summarization call can actually be told about thinking, and what it
 * will therefore do.
 *
 * `pickThinkingOff` answers only "which id do we send". This answers the question
 * the operator cannot otherwise ask: *can this route be told not to think at
 * all?* A hand-declared model with no `reasoningEfforts` (or
 * `reasoningEfforts: false`) is treated as non-reasoning by the provider-d adapter,
 * which then skips **every** thinking-control branch — including the off switch —
 * so the route thinks at its own default and spends the summarization
 * `maxTokens` on reasoning. Nothing in the log said so: the compaction succeeded,
 * just slower and dearer. The four `control` values are the four answers, and
 * the two that mean "it will think" are the ones the engine warns about.
 *
 * @param info - what `ctx.llm.resolveModelInfo(provider, model, signal)`
 *   resolved to. May be undefined, and may be any shape at all: a hand-written
 *   model entry is not schema-checked by the adapter.
 * @returns the resolved effort, whether the route can be told not to think, and
 *   the level ids it declares in order. Never throws.
 */
export function resolveSummarizationEffort(info) {
	// `unknown` is the one case where the route's own declaration cannot be read,
	// so nothing at all can be said about it — not even that it has no levels.
	if (info === undefined || info === null) {
		return { effort: undefined, control: 'unknown', offered: [] };
	}
	const reasoning = info.reasoning;
	// `reasoning: false` (a hand-declared model with no `reasoningEfforts`) and a
	// catalog model whose `thinkingLevelMap.off` is null both land here: the
	// adapter reports no reasoning capability, and its request builder then sends
	// no thinking control whatsoever.
	if (reasoning === undefined || reasoning === null || reasoning === false) {
		return { effort: undefined, control: 'no-reasoning', offered: [] };
	}
	const efforts = reasoning.efforts;
	if (!Array.isArray(efforts) || efforts.length === 0) {
		return { effort: undefined, control: 'no-reasoning', offered: [] };
	}
	const offered = efforts.map((effort) => effort?.id).filter((id) => id !== undefined);
	const effort = pickThinkingOff(efforts);
	// Declared levels but no off-equivalent among them: the route *can* think and
	// cannot be stopped, which is the other half of the same silent failure.
	if (effort === undefined) {
		return { effort: undefined, control: 'no-off-level', offered };
	}
	return { effort, control: 'off', offered };
}

/** The only keys a layer may carry; anything else is a typo, not a silent no-op. */
const LAYER_KEYS = new Set([
	'threshold',
	'thresholdTokens',
	'summarizationModel',
	'summarizationFallback',
	'headroomTokens',
	'retain',
	'retainTokens',
	'maxTokens',
	'compactionRetries',
	'maxOverflowRetries',
]);

/** The only keys the document root may carry. */
const ROOT_KEYS = new Set(['default', 'providers', 'models', 'auto']);

/** A configuration failure the operator can act on. */
export class CompactionConfigError extends Error {
	/**
	 * @param message - actionable description naming the offending field.
	 */
	constructor(message) {
		super(message);
		this.name = 'CompactionConfigError';
	}
}

/** Assert a value is a plain object (not null, not an array). */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one policy layer's keys and field types.
 * @param layer - candidate layer object.
 * @param path - human-readable location used in error messages.
 */
/**
 * A ratio must be a real number in (0, 1). A value at or above 1 is almost
 * always a token budget typed into the ratio field, so the error names the
 * token field to use instead.
 * @param path - field location for the error message.
 * @param value - candidate ratio.
 */
function assertRatio(path, value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new CompactionConfigError(`${path} must be a number`);
	}
	if (value <= 0 || value >= 1) {
		const hint =
			value >= 1
				? `; for an absolute token budget use ${path}Tokens: ${value}`
				: '';
		throw new CompactionConfigError(`${path} must be greater than 0 and less than 1${hint}`);
	}
}

/**
 * An absolute budget is a whole number of tokens. Fractions are rejected rather
 * than rounded: the operator asked for a specific budget, and silently shifting
 * it is worse than saying the value is not a token count.
 * @param path - field location for the error message.
 * @param value - candidate token budget.
 */
function assertTokenBudget(path, value) {
	if (!Number.isInteger(value) || value < 1) {
		throw new CompactionConfigError(`${path} must be a positive whole number of tokens`);
	}
}

/**
 * Validate one budget field that has two units.
 *
 * Stating both in one layer is rejected (they are the same setting in two units);
 * a shadowed sibling is reported, and a ratio must be in (0, 1).
 */
function assertBudgetUnit(path, ratioKey, tokensKey, layer) {
	if (layer[tokensKey] !== undefined) {
		assertTokenBudget(`${path}.${tokensKey}`, layer[tokensKey]);
		return;
	}
	if (layer[ratioKey] !== undefined) assertRatio(`${path}.${ratioKey}`, layer[ratioKey]);
}

/** Assert a positive integer field. */
function assertPositiveInt(path, value) {
	if (!Number.isInteger(value) || value < 1) {
		throw new CompactionConfigError(`${path} must be a positive integer`);
	}
}

/** Assert a non-negative integer field. */
function assertNonNegativeInt(path, value) {
	if (!Number.isInteger(value) || value < 0) {
		throw new CompactionConfigError(`${path} must be a non-negative integer`);
	}
}

/**
 * A summarization model is either the `auto` sentinel or an explicit
 * `provider/model`.
 */
function assertModelRef(path, value) {
	if (typeof value !== 'string' || value.length === 0) {
		throw new CompactionConfigError(`${path} must be a non-empty string`);
	}
	if (value === AUTO) return;
	const slash = value.indexOf('/');
	if (slash <= 0 || slash === value.length - 1) {
		throw new CompactionConfigError(
			`${path} must be "${AUTO}" or "provider/model", got "${value}"`,
		);
	}
}

/**
 * A summarization fallback chain is an ordered list of `provider/model` refs.
 *
 * Validated as strictly as a single model ref, plus the two rules a chain can
 * break that a bare list cannot express: an entry repeating the primary route is
 * a no-op that costs a full re-send, and a repeated entry would retry a route
 * that has already failed in the same attempt. Both are rejected rather than
 * de-duplicated: the operator wrote them, and silently reordering a cost-bearing
 * attempt list is worse than saying the list is wrong.
 *
 * @param path - field location for the error message.
 * @param value - candidate chain.
 */
function assertFallbackChain(path, value) {
	if (!Array.isArray(value)) {
		throw new CompactionConfigError(`${path} must be a list of "provider/model" refs; got ${typeof value}`);
	}
	const seen = new Set();
	for (const [index, entry] of value.entries()) {
		const entryPath = `${path}[${index}]`;
		if (typeof entry !== 'string' || entry.length === 0) {
			throw new CompactionConfigError(`${entryPath} must be a non-empty string`);
		}
		assertModelRef(entryPath, entry);
		if (entry === AUTO) {
			throw new CompactionConfigError(
				`${entryPath} is "${AUTO}"; a fallback must name an explicit "provider/model" — ` +
					'"auto" means the conversation\'s own route, which is what the primary field is for.',
			);
		}
		if (seen.has(entry)) {
			throw new CompactionConfigError(
				`${entryPath} repeats "${entry}"; a fallback chain is tried in order, so a repeat would ` +
					're-send the whole summary prompt to a route that already failed in this attempt.',
			);
		}
		seen.add(entry);
	}
}

function validateLayer(layer, path) {
	if (!isPlainObject(layer)) throw new CompactionConfigError(`${path} must be a mapping`);
	for (const key of Object.keys(layer)) {
		if (!LAYER_KEYS.has(key)) {
			throw new CompactionConfigError(
				`${path}: unknown field "${key}"; known fields are ${[...LAYER_KEYS].join(', ')}`,
			);
		}
	}
	assertBudgetUnit(path, 'threshold', 'thresholdTokens', layer);
	assertBudgetUnit(path, 'retain', 'retainTokens', layer);
	if (layer.maxTokens !== undefined) assertPositiveInt(`${path}.maxTokens`, layer.maxTokens);
	if (layer.headroomTokens !== undefined) assertNonNegativeInt(`${path}.headroomTokens`, layer.headroomTokens);
	if (layer.compactionRetries !== undefined) assertNonNegativeInt(`${path}.compactionRetries`, layer.compactionRetries);
	if (layer.maxOverflowRetries !== undefined) assertNonNegativeInt(`${path}.maxOverflowRetries`, layer.maxOverflowRetries);
	if (layer.summarizationModel !== undefined) assertModelRef(`${path}.summarizationModel`, layer.summarizationModel);
	if (layer.summarizationFallback !== undefined) assertFallbackChain(`${path}.summarizationFallback`, layer.summarizationFallback);
}

/**
 * Validate the whole document and freeze it.
 * @param config - untrusted plugin configuration.
 * @returns a detached, deeply frozen config document.
 */
export function resolveConfig(config = {}) {
	if (!isPlainObject(config)) throw new CompactionConfigError('compaction-control config must be a mapping');
	for (const key of Object.keys(config)) {
		if (!ROOT_KEYS.has(key)) {
			throw new CompactionConfigError(
				`unknown top-level field "${key}"; known fields are ${[...ROOT_KEYS].join(', ')}`,
			);
		}
	}
	if (config.auto !== undefined && typeof config.auto !== 'boolean') {
		throw new CompactionConfigError('auto must be a boolean');
	}

	const defaults = config.default ?? {};
	validateLayer(defaults, 'default');

	const providers = config.providers ?? {};
	if (!isPlainObject(providers)) throw new CompactionConfigError('providers must be a mapping of route name to policy');
	for (const [route, layer] of Object.entries(providers)) validateLayer(layer, `providers.${route}`);

	const models = config.models ?? [];
	if (!Array.isArray(models)) throw new CompactionConfigError('models must be a list');
	const seenTargets = new Set();
	models.forEach((entry, index) => {
		const path = `models[${index}]`;
		if (!isPlainObject(entry)) throw new CompactionConfigError(`${path} must be a mapping`);
		if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
			throw new CompactionConfigError(`${path}.provider must be a non-empty string`);
		}
		if (typeof entry.model !== 'string' || entry.model.length === 0) {
			throw new CompactionConfigError(`${path}.model must be a non-empty string`);
		}
		const rest = { ...entry };
		delete rest.provider;
		delete rest.model;
		validateLayer(rest, path);
		const key = `${entry.provider}\u0000${entry.model}`;
		if (seenTargets.has(key)) {
			throw new CompactionConfigError(`${path}: duplicate override for ${entry.provider}/${entry.model}`);
		}
		seenTargets.add(key);
	});

	return deepFreeze({
		auto: config.auto ?? true,
		default: { ...defaults },
		providers: { ...providers },
		models: models.map((entry) => ({ ...entry })),
	});
}

/** Recursively freeze a value so callers cannot mutate resolved policy. */
function deepFreeze(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return value;
}

/**
 * Find the layer stack that applies to one routed target, highest precedence first.
 * @param config - resolved config document.
 * @param target - routed provider and model.
 * @returns the override layer, the route layer, and the global default.
 */
function layersFor(config, target) {
	const override = config.models.find(
		(entry) => entry.provider === target.provider && entry.model === target.model,
	);
	return {
		override,
		route: config.providers[target.provider],
		fallback: config.default,
	};
}

/**
 * Resolve the first layer that states a given field.
 * @param layers - precedence-ordered layers.
 * @param key - field name to look up.
 * @returns the winning value, or undefined when no layer states it.
 */
function pick(layers, key) {
	for (const layer of [layers.override, layers.route, layers.fallback]) {
		const value = layer?.[key];
		if (value !== undefined) return value;
	}
	return undefined;
}

/** The layer names, highest precedence first, for provenance reporting. */
const LAYER_NAMES = [
	['override', 'model'],
	['route', 'provider'],
	['fallback', 'default'],
];

/**
 * Resolve the first layer that states a field in *either* unit, returning both
 * forms so callers can order and report them.
 */
function pickForm(layers, ratioKey, tokensKey) {
	for (const [slot, name] of LAYER_NAMES) {
		const layer = layers[slot];
		if (layer === undefined) continue;
		if (layer[tokensKey] !== undefined) return { value: layer[tokensKey], unit: 'tokens', layer: name };
		if (layer[ratioKey] !== undefined) return { value: layer[ratioKey], unit: 'ratio', layer: name };
	}
	return { value: undefined, unit: 'ratio', layer: 'engine' };
}

/**
 * Report every layer that states one budget field in both units.
 */
function shadowedUnits(layers) {
	const messages = [];
	for (const [slot, name] of LAYER_NAMES) {
		const layer = layers[slot];
		if (layer === undefined) continue;
		for (const [ratioKey, tokensKey] of [
			['threshold', 'thresholdTokens'],
			['retain', 'retainTokens'],
		]) {
			if (layer[ratioKey] === undefined || layer[tokensKey] === undefined) continue;
			messages.push(
				`${name}: ${tokensKey} (${layer[tokensKey]}) wins over ${ratioKey} (${layer[ratioKey]}); ` +
					'the two are the same setting in two units, so remove the one you did not mean',
			);
		}
	}
	return messages;
}

/**
 * Overlay one settings section on the composition document, leaf-wise and
 * per-field: a layer the section does not restate (a profile's per-model row)
 * survives the user's first edit instead of being dropped. Arrays replace whole.
 */
export function overlayDocument(base, section) {
	if (section === undefined) return base;
	if (!isPlainObject(base) || !isPlainObject(section)) return section;
	const merged = { ...base };
	for (const [key, value] of Object.entries(section)) {
		merged[key] = key in merged ? overlayDocument(merged[key], value) : value;
	}
	return merged;
}

/**
 * Parse a model reference into an explicit provider/model pair.
 * @param value - `auto`, an explicit `provider/model`, or undefined.
 * @returns the explicit pair, or undefined for `auto`/absent (inherit the conversation's route).
 */
function modelRefToTarget(value) {
	if (value === undefined || value === AUTO) return undefined;
	const slash = value.indexOf('/');
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/**
 * Resolve the effective policy for one routed conversation target: per-model
 * beats per-provider beats global, per field, in either unit.
 */
export function resolvePolicy(config, target, contextWindow) {
	const layers = layersFor(config, target);
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;

	const threshold = pickForm(layers, 'threshold', 'thresholdTokens');
	const retain = pickForm(layers, 'retain', 'retainTokens');

	/**
 * Express one declared field as both units, so the ordering check compares like
 * with like.
 */
	const deferred = [];
	const budgetOf = (declaration, defaultRatio, tokensKey) => {
		if (declaration.unit === 'tokens') {
			if (window === undefined) {
				deferred.push(tokensKey);
				return { ratio: defaultRatio, tokens: undefined };
			}
			return { ratio: declaration.value / window, tokens: declaration.value };
		}
		const ratio = declaration.value ?? defaultRatio;
		return { ratio, tokens: window === undefined ? undefined : Math.floor(window * ratio) };
	};

	const thresholdBudget = budgetOf(threshold, DEFAULT_THRESHOLD_RATIO, 'thresholdTokens');
	const retainBudget = budgetOf(retain, DEFAULT_RETAIN_RATIO, 'retainTokens');

	// Compared in whichever unit is exact: tokens once the window is known, the
	// declared ratios otherwise. A deferred absolute budget is not comparable at
	// all — `applyPolicy` refuses it where the window is supposed to be known, so
	// the comparison is deferred to the same place as the value.
	if (deferred.length === 0) {
		const describe = (budget) =>
			budget.tokens === undefined ? `${budget.ratio}` : `${budget.tokens} tokens (${budget.ratio})`;
		const inverted =
			window === undefined
				? retainBudget.ratio >= thresholdBudget.ratio
				: retainBudget.tokens >= thresholdBudget.tokens;
		if (inverted) {
			throw new CompactionConfigError(
				`retain (${describe(retainBudget)}) must be less than threshold (${describe(thresholdBudget)}) for ${target.provider}/${target.model}`,
			);
		}
	}

	/**
	 * The headroom a compaction needs to be able to succeed. Reported, not
	 * enforced; see {@link MIN_COMPACT_GAP_TOKENS}.
	 */
	const warnings = [];
	if (window !== undefined) {
		const gap = thresholdBudget.tokens - retainBudget.tokens;
		if (gap < MIN_COMPACT_GAP_TOKENS) {
			warnings.push(
				`threshold (${thresholdBudget.tokens}) leaves only ${gap} tokens above retain (${retainBudget.tokens}), ` +
					`below the ${MIN_COMPACT_GAP_TOKENS}-token minimum a summary needs to be smaller than the region it replaces`,
			);
		}
	}
	for (const shadow of shadowedUnits(layers)) warnings.push(shadow);

	const summarizationModel = pick(layers, 'summarizationModel') ?? AUTO;
	const summarizationTarget = modelRefToTarget(summarizationModel);
	// The chain is resolved against the *primary* route, not against the layer's
	// own text: `summarizationModel: "auto"` resolves to the conversation's route,
	// which differs per target, so an entry repeating it can only be caught here.
	// Such an entry is a no-op that re-sends the entire summary prompt at full
	// cold-read price to a route that just failed — the most expensive way to
	// accomplish nothing, and the one mistake a hand-written chain actually makes.
	let summarizationFallback = (pick(layers, 'summarizationFallback') ?? []).map(modelRefToTarget);
	// What the primary actually resolves to. `auto` means "the conversation's own
	// route", which the parent reads from the latest routed request — so under
	// `auto` the primary *is* this target, and an entry naming it is the same
	// mistake as naming an explicit primary.
	const primary = summarizationTarget ?? { provider: target.provider, model: target.model };
	// Remove redundant primary entries rather than disable all compaction. A
	// repeated route is a no-op: retrying the route that just failed re-sends
	// the whole summary prompt for nothing. Keep the remaining chain order.
	summarizationFallback = summarizationFallback.filter((entry, index) => {
		const isPrimary = entry.provider === primary.provider && entry.model === primary.model;
		if (isPrimary) {
			warnings.push(
				`summarizationFallback[${index}] (${entry.provider}/${entry.model}) is the primary summarization route; it was skipped, ` +
					'because retrying the route that just failed re-sends the whole summary prompt for nothing.',
			);
		}
		return !isPrimary;
	});

	return deepFreeze({
		target: { provider: target.provider, model: target.model },
		window,
		thresholdRatio: thresholdBudget.ratio,
		retainRatio: retainBudget.ratio,
		thresholdTokens: thresholdBudget.tokens,
		retainTokens: retainBudget.tokens,
		/** Which units the winning layers stated, and where they came from. */
		absolute: { threshold: threshold.unit === 'tokens', retain: retain.unit === 'tokens' },
		/** Absolute fields that could not be converted for want of a window. */
		deferred,
		warnings,
		maxTokens: pick(layers, 'maxTokens') ?? DEFAULT_MAX_TOKENS,
		/** Left undefined when no layer states one, so the parent's own default stands. */
		headroomTokens: pick(layers, 'headroomTokens'),
		compactionRetries: pick(layers, 'compactionRetries') ?? 1,
		maxOverflowRetries: pick(layers, 'maxOverflowRetries') ?? 1,
		summarizationTarget,
		summarizationModel,
		/** Ordered fallback routes, already checked against `summarizationTarget`. */
		summarizationFallback,
		source: {
			override: layers.override !== undefined,
			route: layers.route !== undefined,
			fallback: true,
			threshold: { layer: threshold.layer, unit: threshold.unit },
			retain: { layer: retain.layer, unit: retain.unit },
		},
	});
}

/**
 * Translate one resolved policy into the flat shape the parent engine consumes,
 * naming only the fields this plugin owns (the caller seeds the rest from the
 * parent's own resolved defaults).
 */
export function toBasicConfig(policy) {
	const config = {
		maxTokens: policy.maxTokens,
		compactionRetries: policy.compactionRetries,
		maxOverflowRetries: policy.maxOverflowRetries,
		summarizationProvider: policy.summarizationTarget?.provider ?? '',
		summarizationModel: policy.summarizationTarget?.model ?? '',
	};
	// Named only when a layer stated one: the field is in the parent's schema with
	// its own default, and writing `undefined` over it would make the loader treat
	// the key as present-but-empty rather than absent.
	if (policy.headroomTokens !== undefined) config.headroomTokens = policy.headroomTokens;
	if (policy.absolute.threshold && policy.window !== undefined) {
		config.thresholdRatio = (policy.thresholdTokens + 0.5) / policy.window;
	} else {
		config.thresholdRatio = policy.thresholdRatio;
	}
	// Exactly one retention unit, because the parent treats the two as mutually
	// exclusive. A deferred absolute retention has no token value to send, and
	// `applyPolicy` has already refused that policy by the time this is reached.
	if (policy.absolute.retain && policy.retainTokens !== undefined) {
		config.retainTokens = policy.retainTokens;
	} else {
		config.retainRatio = policy.retainRatio;
	}
	return config;
}