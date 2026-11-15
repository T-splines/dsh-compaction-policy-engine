/**
 * Settings wiring for dsh-compaction-policy-engine.
 *
 * `ctx.settings.installSection(ns, schema, entry, hooks)` publishes a namespaced
 * section of the user settings document and hands back a live getter; the
 * provider already merges "schema defaults, then the registrant's composition
 * base, then the user document", so this module must not merge anything itself.
 * Validation is split the same way as `policy.js`: shape here, meaning there.
 *
 * @module dsh-compaction-policy-engine/settings
 */

import z from '@deepseek-ai/schemastery';
import { isVolatile } from '@deepseek-ai/cosmokit';

/** The settings namespace this plugin owns. Must be lowercase-hyphenated. */
export const SETTINGS_NS = 'compaction-control';

/**
 * Fields shared by the global default and every override layer. The vocabulary
 * mirrors `policy.js` (`threshold`/`retain`), not the parent's
 * (`thresholdRatio`/`retainRatio`); the translation happens once, in
 * `toBasicConfig`. Every field is optional — a settings section is a partial
 * override by nature.
 */
const layerFields = {
	threshold: z.number().description('compact at this fraction of the context window'),
	thresholdTokens: z
		.number()
		.step(1)
		.min(1)
		.description('compact at this many tokens of context; needs a route that declares a window'),
	retain: z.number().description('verbatim tail to keep, as a fraction of the context window'),
	retainTokens: z.number().step(1).min(1).description('verbatim tail to keep, in tokens; must be below the threshold'),
	summarizationModel: z.string().description('"auto", or an explicit "provider/model"'),
	summarizationFallback: z
		.array(z.string())
		.description('ordered "provider/model" routes tried when the primary summarization route fails; strongest free first, paid last'),
	headroomTokens: z.number().step(1).min(0).description('tokens kept free below the threshold for the summary to be smaller than what it replaces'),
	maxTokens: z.number().step(1).min(1).description('cap on the generated summary length'),
	compactionRetries: z.number().step(1).min(0).description('retries when summarization fails'),
	maxOverflowRetries: z.number().step(1).min(0).description('retries after a context overflow'),
};

/** One exact-target override: the shared fields plus the route it applies to. */
const modelLayer = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	...layerFields,
});

/**
 * Schema of the user's `compaction-control` section.
 *
 * Deliberately the same shape as the plugin's own `Config`, so the same
 * `resolveConfig` accepts either document.
 */
export const settingsSchema = z.object({
	default: z.object(layerFields).volatile(),
	providers: z.dict(z.object(layerFields)).volatile(),
	models: z.array(modelLayer).volatile(),
	auto: z.boolean().volatile(),
});

/**
 * Publish this plugin's section and keep a live getter for the effective
 * document.
 *
 * `current()` delegates to the provider on every call, so an external edit is
 * visible without a restart; caching it would reintroduce exactly the staleness
 * this module exists to remove. With no settings provider (a bare profile, or a
 * unit test) the section is never published and the plugin runs on its Cordis
 * config alone — a deliberate degradation every existing deployment relies on.
 *
 * @param ctx - context that may provide the `settings` service.
 * @param ns - settings namespace to own.
 * @param schema - schema resolving the section.
 * @param base - the composition default, used until the user overrides it.
 * @param onChange - called when the effective document changes.
 * @returns an object exposing the live document and whether a provider took it.
 */
/**
 * Unwrap the live cells a `.volatile()` field resolves to.
 *
 * A volatile field's value is a cell exposing `get()`, so every read of this
 * plugin's own config has to read the cells out: `resolveConfig` is written for
 * plain documents, and a cell reaching it would merge as an object.
 */
export function plainConfig(value) {
	if (isVolatile(value)) return plainConfig(value.get());
	if (Array.isArray(value)) return value.map(plainConfig);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
	}
	return value;
}

export function installSettings(ctx, ns, schema, base, onChange) {
	/**
	 * Getter over the provider's resolved document.
	 *
	 * Starts by returning the composition base, so `current()` is meaningful
	 * even before a provider responds — and stays meaningful when none exists.
	 */
	let read = () => base;

	const state = {
		/** Whether a settings provider took the section. */
		installed: false,
		/**
		 * The effective document: composition default overlaid by the user
		 * section.
		 *
		 * Delegates to the provider's getter on every call rather than
		 * snapshotting, which is what makes an external edit to `settings.yaml`
		 * visible without a restart.
		 */
		current: () => read(),
	};

	ctx.inject(['settings'], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, ns, schema, base, {
			// The provider calls this with a getter over its own resolved value,
			// so calling it here yields the merged document. It is a getter, not a
			// snapshot: re-reading inside `current()` is what makes a later write
			// visible without a restart.
			setSource: (providerRead) => {
				read = providerRead;
			},
			onChange: () => {
				state.installed = true;
				onChange();
			},
		});
	});

	return state;
}