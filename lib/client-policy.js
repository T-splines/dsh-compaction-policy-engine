/**
 * Client-safe policy view for `dsh-compaction-policy-engine`.
 *
 * The session-header indicator answers "which policy is this conversation under,
 * and where will it fire?" from data the browser genuinely has: the resolved
 * settings document and the session's `contextPressure`/`modelSelection`
 * projections. That is a *view*, not the host's resolver — and `client.js` is
 * served verbatim and cannot import, so this module is inlined there (see the
 * drift test in `test/client-policy.test.js`).
 *
 * @module dsh-compaction-policy-engine/client-policy
 */

/** The only keys a policy layer may carry, in the order the panel lists them. */
export const LAYER_FIELDS = [
	'threshold',
	'thresholdTokens',
	'retain',
	'retainTokens',
	'headroomTokens',
	'maxTokens',
	'summarizationModel',
	'summarizationFallback',
];

/** The literal `auto` sentinel, meaning "inherit the conversation's own model". */
export const AUTO = 'auto';

/** `compaction-basic`'s own default trigger ratio, shown when no layer states one. */
export const ENGINE_DEFAULT_THRESHOLD = 0.8;

/** `compaction-basic`'s own default retention ratio. */
export const ENGINE_DEFAULT_RETAIN = 0.16;

/**
 * Minimum room a compaction must free, mirrored from the host's `policy.js`.
 */
export const MIN_COMPACT_GAP_TOKENS = 8192;

/** True for a plain object (not null, not an array). */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The routed target a conversation is using, from its projection: the latest
 * durable request wins, falling back to the session's selected model.
 */
export function routeOf(modelSelection) {
	const candidate = modelSelection?.lastUsed ?? modelSelection?.next;
	if (!isPlainObject(candidate)) return undefined;
	const { provider, model } = candidate;
	if (typeof provider !== 'string' || provider.length === 0) return undefined;
	if (typeof model !== 'string' || model.length === 0) return undefined;
	return { provider, model };
}

/**
 * Split one resolved settings document into the override layers, most specific
 * first (`models[]` → `providers{}` → `default`), keeping only layers that
 * actually state a field.
 */
export function layersOf(value, user, target) {
	const override = Array.isArray(value?.models)
		? value.models.find((entry) => entry?.provider === target?.provider && entry?.model === target?.model)
		: undefined;
	const userOverride = Array.isArray(user?.models)
		? user.models.find((entry) => entry?.provider === target?.provider && entry?.model === target?.model)
		: undefined;
	const routeName = target?.provider;
	const route = routeName === undefined ? undefined : value?.providers?.[routeName];
	const userRoute = routeName === undefined ? undefined : user?.providers?.[routeName];
	return {
		routeName,
		layers: [
			{ kind: 'model', layer: override, user: userOverride !== undefined },
			{ kind: 'provider', layer: route, user: userRoute !== undefined },
			{ kind: 'default', layer: value?.default, user: user?.default !== undefined },
		],
	};
}

/**
 * Resolve the effective policy for one target out of a resolved settings
 * document, field by field (`models[]` → `providers{}` → `default`).
 *
 * `used` names the winning declared value, while `overridden` says whether a user
 * layer (not the composition base) supplied it — the card shows both.
 */
export function resolveView(value, user, target) {
	const { routeName, layers } = layersOf(value, user, target);
	const pick = (field) => {
		for (const candidate of layers) {
			const declared = candidate.layer?.[field];
			if (declared !== undefined) {
				return { value: declared, source: candidate.kind, overridden: candidate.user };
			}
		}
		return { value: undefined, source: 'engine', overridden: false };
	};
	/** The winning declaration of a field that may be stated in either unit. */
	const pickForm = (ratioKey, tokensKey) => {
		for (const candidate of layers) {
			const layer = candidate.layer;
			if (layer === undefined) continue;
			if (layer[tokensKey] !== undefined) {
				return { value: layer[tokensKey], unit: 'tokens', source: candidate.kind, overridden: candidate.user };
			}
			if (layer[ratioKey] !== undefined) {
				return { value: layer[ratioKey], unit: 'ratio', source: candidate.kind, overridden: candidate.user };
			}
		}
		return { value: undefined, unit: 'ratio', source: 'engine', overridden: false };
	};

	const threshold = pickForm('threshold', 'thresholdTokens');
	const retain = pickForm('retain', 'retainTokens');
	const maxTokens = pick('maxTokens');
	const summarization = pick('summarizationModel');
	const fallback = pick('summarizationFallback');
	// Its own field, not a second name for the derived `gapTokens` below: this is
	// the engine's reserve *below the threshold*, and an operator who set it needs
	// to see it. The gap is computed from the two budgets and means something else
	// entirely, which is why the derived one was renamed.
	const headroom = pick('headroomTokens');

	return {
		target,
		routeName,
		auto: value?.auto !== false,
		thresholdRatio: threshold.unit === 'ratio' ? threshold.value : undefined,
		retainRatio: retain.unit === 'ratio' ? retain.value : undefined,
		thresholdTokens: threshold.unit === 'tokens' ? threshold.value : undefined,
		retainTokens: retain.unit === 'tokens' ? retain.value : undefined,
		/** The winning declarations themselves, units included. */
		declared: { threshold, retain },
		maxTokens: maxTokens.value,
		summarizationModel: summarization.value ?? AUTO,
		/** The winning layer's ordered chain, or empty when no layer states one. */
		summarizationFallback: fallback.value ?? [],
		headroomTokens: headroom.value,
		source: {
			threshold: threshold.source,
			retain: retain.source,
			maxTokens: maxTokens.source,
			summarizationModel: summarization.source,
			summarizationFallback: fallback.source,
			headroomTokens: headroom.source,
		},
		/** Per-field provenance, including whether the user layer stated it. */
		fields: {
			threshold,
			retain,
			maxTokens,
			summarizationModel: summarization,
			summarizationFallback: fallback,
			headroomTokens: headroom,
		},
		/** Whether any layer for this target came from the user document. */
		overridden: layers.some((candidate) => candidate.user),
	};
}

/**
 * Token budgets implied by a view plus a context window, or null when either is
 * unknown: a ratio is a fraction of the adapter-declared window, not of the
 * conversation.
 */
export function budgetsOf(view, contextWindow) {
	const window = typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? contextWindow : undefined;
	const tokensOf = (absolute, ratio, fallbackRatio) => {
		if (typeof absolute === 'number') return absolute;
		if (window === undefined) return null;
		const effective = typeof ratio === 'number' ? ratio : fallbackRatio;
		return Math.floor(window * effective);
	};
	const thresholdTokens = tokensOf(view.thresholdTokens, view.thresholdRatio, ENGINE_DEFAULT_THRESHOLD);
	const retainTokens = tokensOf(view.retainTokens, view.retainRatio, ENGINE_DEFAULT_RETAIN);
	return {
		thresholdTokens,
		retainTokens,
		/**
 * What a compaction would free. Below `MIN_COMPACT_GAP_TOKENS` the summary can
 * end up no smaller than what it replaces, so the view says so.
 *
 * Named `gapTokens`, not `headroomTokens`: the engine's own `headroomTokens` is
 * the reserve *below the threshold* and is a configurable knob, so sharing the
 * name would make the panel's derived number indistinguishable from a setting.
 */
		gapTokens: thresholdTokens === null || retainTokens === null ? null : thresholdTokens - retainTokens,
	};
}
