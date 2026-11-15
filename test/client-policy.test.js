/**
 * Tests for the client-side policy view.
 *
 * Two things are being defended here, and they are different:
 *
 *  1. `client.js` is served verbatim (no build step), so its inlined view of
 *     `lib/client-policy.js` is a *copy*. A copy that drifts is worse than no
 *     copy — the badge would quietly report numbers the engine does not use.
 *     The first test pins the two together textually.
 *  2. The view is a second implementation of the layering rules in
 *     `policy.js`. The remaining tests assert it agrees with the host resolver
 *     on generated documents, so the indicator cannot disagree with the
 *     engine about which layer won.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { AUTO, resolveConfig, resolvePolicy } from '../lib/policy.js';
import {
	ENGINE_DEFAULT_RETAIN,
	ENGINE_DEFAULT_THRESHOLD,
	MIN_COMPACT_GAP_TOKENS,
	budgetsOf,
	resolveView,
	routeOf,
} from '../lib/client-policy.js';

const CLIENT_ENTRY = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const MODULE_ENTRY = fileURLToPath(new URL('../lib/client-policy.js', import.meta.url));

/** The inlined declarations start here and end at the settings-card docblock. */
const INLINE_START = 'Inlined view of `lib/client-policy.js`';
const INLINE_END = 'Register the policy card into the Models page';

/** Helpers the copy is allowed (and required) to carry. */
const INLINE_NAMES = ['AUTO', 'ENGINE_DEFAULT_THRESHOLD', 'ENGINE_DEFAULT_RETAIN', 'MIN_COMPACT_GAP_TOKENS', 'isPlainObject', 'routeOf', 'layersOf', 'resolveView', 'budgetsOf'];

/**
 * Extract the inlined block from `client.js`.
 * @returns the block text, without the surrounding comments.
 */
async function inlineBlock() {
	const source = await readFile(CLIENT_ENTRY, 'utf8');
	const start = source.indexOf(INLINE_START);
	assert.notEqual(start, -1, 'client.js carries no inlined block marker');
	const end = source.indexOf(INLINE_END, start);
	assert.notEqual(end, -1, 'client.js inlined block has no end marker');
	return source.slice(start, end);
}

/**
 * Pull one declaration out of the block by its own text up to a unique anchor.
 *
 * Line-anchored so a name that appears inside another declaration (a call to
 * `routeOf` inside `resolveView`, say) cannot truncate the wrong one.
 *
 * @param block - the inlined block.
 * @param head - the declaration's first line.
 * @returns the declaration source.
 */
function declaration(block, head) {
	// The bundle form is indented inside the factory; the canonical module is
	// not. Try the indented anchor first so a nested occurrence cannot win.
	const indented = block.indexOf(`\n\t\t${head}`);
	const start = indented === -1 ? block.indexOf(`\n${head}`) : indented;
	assert.notEqual(start, -1, `block is missing "${head}"`);
	const lines = block.slice(start + 1).split('\n');
	const out = [];
	let depth = 0;
	let started = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!started && (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))) {
			continue;
		}
		out.push(line);
		started = true;
		for (const char of line) {
			if (char === '{' || char === '[') depth += 1;
			else if (char === '}' || char === ']') depth -= 1;
		}
		if (depth === 0 && (trimmed.endsWith(';') || trimmed.endsWith('}'))) break;
	}
	assert.ok(out.length > 0, `"${head}" produced no body`);
	return out.join('\n').trim();
}

/**
 * Materialize the inlined block as an importable ES module.
 *
 * The block is written as statements inside the bundle factory (indent 2 tabs,
 * `const`/`function`). Rewriting each declaration's keyword to `export` turns
 * it into exactly the module shape `client-policy.js` publishes — which is what
 * makes the comparison below a comparison of *bodies*, not of formatting.
 *
 * @returns the namespace of the materialized copy.
 */
async function loadInlinedCopy() {
	const block = await inlineBlock();
	const declarations = [
		declaration(block, `const AUTO =`),
		declaration(block, `const ENGINE_DEFAULT_THRESHOLD =`),
		declaration(block, `const ENGINE_DEFAULT_RETAIN =`),
		declaration(block, `const MIN_COMPACT_GAP_TOKENS =`),
		declaration(block, `function isPlainObject(`),
		declaration(block, `function routeOf(`),
		declaration(block, `function layersOf(`),
		declaration(block, `function resolveView(`),
		declaration(block, `function budgetsOf(`),
	];
	const source = declarations
		// Only the declaration's own keyword is prefixed; a line-anchored regex
		// would also match `const` statements *inside* a function body.
		.map((text) => `export ${text}`)
		.join('\n\n');
	const href = `data:text/javascript;base64,${Buffer.from(`${source}\n`).toString('base64')}`;
	return import(href);
}

test('client.js inlines client-policy.js verbatim', async () => {
	const block = await inlineBlock();
	const moduleSource = await readFile(MODULE_ENTRY, 'utf8');

	for (const name of INLINE_NAMES) {
		const head =
			name === 'AUTO' || name.startsWith('ENGINE_') || name.startsWith('MIN_')
				? `const ${name} =`
				: `function ${name}(`;
		const inlined = declaration(block, head);
		// The canonical module publishes these as `export`; strip the keyword so
		// the comparison is of bodies rather than of module syntax.
		const canonical = declaration(moduleSource.replace(/^export /gm, ''), head);
		// The module source is indented with tabs too (top level), so compare the
		// de-indented bodies; anything but whitespace is a real divergence.
		const strip = (text) => text.replace(/[ \t]+/g, ' ').replace(/\s+/g, ' ').trim();
		assert.equal(
			strip(inlined),
			strip(canonical),
			`inlined "${name}" has drifted from lib/client-policy.js — update the copy in lib/client.js`,
		);
	}
});

test('resolveView agrees with the host resolver, field by field', async () => {
	const copy = await loadInlinedCopy();
	const documents = [
		{},
		{ default: { threshold: 0.2, retain: 0.08 } },
		{ default: { threshold: 0.5 }, providers: { local: { threshold: 0.7 } } },
		{
			default: { threshold: 0.5, retain: 0.1 },
			providers: { local: { retain: 0.05 } },
			models: [{ provider: 'local', model: 'model-x', threshold: 0.9 }],
		},
		{ default: { summarizationModel: 'gateway-b/model-f', maxTokens: 4096 } },
		{ auto: false, default: { threshold: 0.33 } },
		// The two fields the GUI grew for the fallback chain and the engine's own
		// reserve. Both resolve through all three layers, and the chain is an
		// ordered list — so the comparison has to be on order, not on membership.
		{ default: { headroomTokens: 40_000 } },
		{
			default: { headroomTokens: 40_000, summarizationFallback: ['local/weak-free', 'gateway-b/paid'] },
			providers: { local: { headroomTokens: 12_345, summarizationFallback: ['gateway-b/paid'] } },
		},
	];
	const targets = [
		{ provider: 'local', model: 'model-x' },
		{ provider: 'local', model: 'other' },
		{ provider: 'gateway-b', model: 'model-f' },
	];

	for (const document of documents) {
		for (const target of targets) {
			const config = resolveConfig(document);
			const host = resolvePolicy(config, target);
			const view = copy.resolveView(config, {}, target);
			const label = `${JSON.stringify(document)} @ ${target.provider}/${target.model}`;
			assert.equal(view.thresholdRatio ?? ENGINE_DEFAULT_THRESHOLD, host.thresholdRatio, `threshold: ${label}`);
			assert.equal(view.retainRatio ?? ENGINE_DEFAULT_RETAIN, host.retainRatio, `retain: ${label}`);
			assert.equal(view.summarizationModel, host.summarizationModel, `model: ${label}`);
			assert.equal(view.maxTokens ?? 8192, host.maxTokens, `maxTokens: ${label}`);
			assert.equal(
				view.summarizationReasoningEffort,
				host.summarizationReasoningEffort,
				`summarizationReasoningEffort: ${label}`,
			);
			assert.equal(view.auto, config.auto, `auto: ${label}`);
			// The chain is compared as an ordered `provider/model` list, because its
			// order is its meaning: a view that agreed on membership but not on order
			// would show the operator a fallback sequence the engine does not follow.
			assert.deepEqual(
				view.summarizationFallback,
				host.summarizationFallback.map((entry) => `${entry.provider}/${entry.model}`),
				`summarizationFallback: ${label}`,
			);
			// The engine's reserve, which is NOT the derived threshold-minus-retain gap
			// the panel also shows. Undefined means "no layer states one", and the host
			// reports exactly that rather than a default this view would have invented.
			assert.equal(view.headroomTokens, host.headroomTokens, `headroomTokens: ${label}`);
		}
	}
});

test('budgetsOf agrees with the host resolver in tokens, window by window', async () => {
	// The panel's numbers are a second implementation of the same arithmetic, and
	// the one the operator actually reads before deciding. So the claim asserted
	// here is the strong one: for every document and every window, the token
	// budgets the panel shows are the ones the host resolves — including the
	// token form, where the two arrive at the same budget from opposite ends.
	const copy = await loadInlinedCopy();
	const documents = [
		{ default: { threshold: 0.2, retain: 0.08 } },
		{ default: { thresholdTokens: 200_000, retainTokens: 80_000 } },
		{ default: { threshold: 0.5 }, providers: { local: { retainTokens: 60_000 } } },
		{ models: [{ provider: 'local', model: 'model-x', thresholdTokens: 400_000, retainTokens: 100_000 }] },
		{ default: { threshold: 0.015, retain: 0.012 } },
	];
	const windows = [1_000_000, 262_144, 200_000];

	for (const document of documents) {
		for (const window of windows) {
			for (const target of [{ provider: 'local', model: 'model-x' }, { provider: 'other', model: 'x' }]) {
				const config = resolveConfig(document);
				const host = resolvePolicy(config, target, window);
				const view = copy.resolveView(config, {}, target);
				const budgets = copy.budgetsOf(view, window);
				const label = `${JSON.stringify(document)} @ ${target.provider}/${target.model} / ${window}`;
				assert.equal(budgets.thresholdTokens, host.thresholdTokens, `threshold tokens: ${label}`);
				assert.equal(budgets.retainTokens, host.retainTokens, `retain tokens: ${label}`);
				assert.equal(
					budgets.gapTokens,
					host.thresholdTokens - host.retainTokens,
					`headroom: ${label}`,
				);
				assert.equal(
					budgets.gapTokens < MIN_COMPACT_GAP_TOKENS,
					host.warnings.length > 0,
					`the panel warns exactly when the host does: ${label}`,
				);
			}
		}
	}
});

test('layers resolve models[] → providers{} → default, per field', () => {
	const value = {
		auto: true,
		default: { threshold: 0.5, retain: 0.1, summarizationModel: AUTO },
		providers: { local: { threshold: 0.7 } },
		models: [{ provider: 'local', model: 'model-x', threshold: 0.9 }],
	};
	const view = resolveView(value, { default: { threshold: 0.5 } }, { provider: 'local', model: 'model-x' });
	assert.equal(view.thresholdRatio, 0.9);
	assert.equal(view.source.threshold, 'model');
	assert.equal(view.retainRatio, 0.1);
	assert.equal(view.source.retain, 'default');
	assert.equal(view.summarizationModel, AUTO);
	assert.equal(view.overridden, true);

	const routeOnly = resolveView(value, {}, { provider: 'local', model: 'other' });
	assert.equal(routeOnly.thresholdRatio, 0.7);
	assert.equal(routeOnly.source.threshold, 'provider');
});

test('an undeclared field reports the engine source rather than a fabricated number', () => {
	const view = resolveView({ auto: true }, {}, undefined);
	assert.equal(view.thresholdRatio, undefined);
	assert.equal(view.source.threshold, 'engine');
	assert.equal(view.retainRatio, undefined);
	assert.equal(view.summarizationModel, AUTO);
	assert.equal(view.routeName, undefined);
	assert.equal(view.overridden, false);
});

test('routeOf prefers the last used route and tolerates missing projections', () => {
	assert.deepEqual(routeOf({ lastUsed: { provider: 'a', model: 'b' }, next: { provider: 'c', model: 'd' } }), {
		provider: 'a',
		model: 'b',
	});
	assert.deepEqual(routeOf({ next: { provider: 'c', model: 'd' } }), { provider: 'c', model: 'd' });
	assert.equal(routeOf(undefined), undefined);
	assert.equal(routeOf({ lastUsed: { provider: '', model: 'd' } }), undefined);
	assert.equal(routeOf({ lastUsed: { provider: 'a' } }), undefined);
});

test('budgetsOf scales ratios by the reported window, and withholds numbers without one', () => {
	const view = resolveView({ default: { threshold: 0.2, retain: 0.08 } }, {}, undefined);
	assert.deepEqual(budgetsOf(view, 1_000_000), {
		thresholdTokens: 200_000,
		retainTokens: 80_000,
		gapTokens: 120_000,
	});
	assert.deepEqual(budgetsOf(view, undefined), {
		thresholdTokens: null,
		retainTokens: null,
		gapTokens: null,
	});
	assert.deepEqual(budgetsOf(view, Number.NaN), {
		thresholdTokens: null,
		retainTokens: null,
		gapTokens: null,
	});
	// No declared ratio: the engine's own defaults are what the panel shows.
	const bare = resolveView({ auto: true }, {}, undefined);
	assert.deepEqual(budgetsOf(bare, 1000), {
		thresholdTokens: 800,
		retainTokens: 160,
		gapTokens: 640,
	});
});

test('an absolute budget needs no window, and the ratio is derived from it', () => {
	// The point of the token form: the panel can state the trigger budget of a
	// session that has not reported its window yet, which a ratio cannot.
	const view = resolveView({ default: { thresholdTokens: 200_000, retainTokens: 80_000 } }, {}, undefined);
	assert.equal(view.thresholdRatio, undefined, 'the declaration was not a ratio');
	assert.equal(view.thresholdTokens, 200_000);
	assert.deepEqual(budgetsOf(view, undefined), {
		thresholdTokens: 200_000,
		retainTokens: 80_000,
		gapTokens: 120_000,
	});
	assert.deepEqual(budgetsOf(view, 1_000_000), {
		thresholdTokens: 200_000,
		retainTokens: 80_000,
		gapTokens: 120_000,
	});
	// 0.2 of a 1M window, arrived at from the other direction.
	assert.equal(budgetsOf(view, 1_000_000).thresholdTokens / 1_000_000, 0.2);
});

test('a mixed policy takes each field from the layer that stated it', () => {
	const value = {
		auto: true,
		default: { threshold: 0.5, retain: 0.1 },
		providers: { local: { retainTokens: 80_000 } },
	};
	const view = resolveView(value, {}, { provider: 'local', model: 'model-x' });
	assert.equal(view.thresholdRatio, 0.5, 'the ratio comes from the default layer');
	assert.equal(view.retainRatio, undefined);
	assert.equal(view.retainTokens, 80_000);
	assert.deepEqual(
		{ t: view.declared.threshold.unit, r: view.declared.retain.unit },
		{ t: 'ratio', r: 'tokens' },
	);
});
