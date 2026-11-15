/**
 * Tests for the settings seam wiring.
 *
 * The interesting property here is not "the schema accepts a number" — it is
 * that a settings change becomes visible *without reloading the plugin*. That
 * is the whole reason this module exists, and it is the part a refactor is most
 * likely to break silently: a cached document would still pass every
 * schema-level test while pinning the operator's policy forever.
 *
 * These run against a stand-in settings provider rather than the real
 * `dsh-settings-file`, because the contract under test is the one
 * `installSection` declares — a getter over the resolved document plus an
 * `onChange` callback — not the file provider's YAML handling.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SETTINGS_NS, installSettings, settingsSchema } from '../lib/settings.js';
import { CompactionControlSettings } from '../lib/index.js';
import { resolveConfig, resolvePolicy } from '../lib/policy.js';

/**
 * Build a context whose `inject(['settings'], …)` runs the callback against a
 * stand-in provider that records the hooks it was handed.
 *
 * @returns the context, the hooks, and a function to publish a new document.
 */
function fakeSettingsContext() {
	const base = { default: { threshold: 0.8, retain: 0.16 } };
	let user = {};

	/**
	 * Leaf-wise merge of the user section over the composition base, mirroring
	 * the real provider ("schema defaults, then base, then user document").
	 *
	 * A shallow spread would be wrong here for the same reason it would be wrong
	 * in the plugin: setting only `default.threshold` must not erase
	 * `default.retain`.
	 */
	const resolve = () => ({
		...base,
		...user,
		...(user.default === undefined ? {} : { default: { ...base.default, ...user.default } }),
	});

	/** The hooks the plugin handed us, so a publish can notify through them. */
	let installed;

	const ctx = {
		inject(services, callback) {
			assert.deepEqual(services, ['settings']);
			callback({
				settings: {
					installSection(owner, ns, schema, entry, hooks) {
						assert.equal(ns, SETTINGS_NS);
						assert.equal(schema, settingsSchema);
						assert.deepEqual(entry, base, '组合默认值必须原样交给 provider 作为 base 层');
						installed = hooks;
						// The provider hands `setSource` a getter over its resolved
						// value, so this double must do the same: a later write must be
						// visible through the same getter.
						hooks.setSource(resolve);
						hooks.onChange();
					},
				},
			});
		},
	};

	return {
		ctx,
		base,
		/**
		 * Publish a new user section, exactly as the file provider does on a
		 * write or a watched external edit: the document changes, then the
		 * consumer is notified.
		 */
		publish(next) {
			user = next;
			installed.onChange();
		},
	};
}

test('current() returns the document, never the provider getter', () => {
	// `setSource` hands over a *getter*, so storing it and returning it directly
	// would make `current()` a function — every caller would then read
	// `.default` off a function and get undefined. This shipped once; the test
	// exists so it cannot ship again.
	const { ctx, base } = fakeSettingsContext();
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
	const document = state.current();
	assert.equal(typeof document, 'object', 'current() 必须是文档本身，不是 getter 函数');
	assert.equal(typeof document.default, 'object');
	assert.equal(document.default.threshold, 0.8);
});

test('current() is usable before any provider responds', () => {
	// The engine reads this during construction, possibly before the settings
	// service finishes its own init.
	const base = { default: { threshold: 0.8 } };
	const state = installSettings({ inject() {} }, SETTINGS_NS, settingsSchema, base, () => {});
	assert.equal(typeof state.current(), 'object');
	assert.equal(state.current().default.threshold, 0.8);
});

test('without a settings provider the plugin falls back to its own config', () => {
	const base = { default: { threshold: 0.8 } };
	// A context whose inject never fires stands in for a bare profile.
	const state = installSettings({ inject() {} }, SETTINGS_NS, settingsSchema, base, () => {});
	assert.equal(state.installed, false);
	assert.equal(state.current(), base, '必须回落到组合默认值，否则裸 profile 会失去策略');
});

test('the section is published and the effective document is readable', () => {
	const { ctx, base } = fakeSettingsContext();
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
	assert.equal(state.installed, true);
	assert.equal(state.current().default.threshold, 0.8, '未覆盖时应等于组合默认值');
});

test('a settings write is visible without reinstalling the section', () => {
	const { ctx, base, publish } = fakeSettingsContext();
	let notifications = 0;
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {
		notifications += 1;
	});
	const before = state.current().default.threshold;

	publish({ default: { threshold: 0.5 } });

	assert.equal(before, 0.8);
	assert.equal(state.current().default.threshold, 0.5, '★ 热更新：不重装 section 也要看到新值');
	assert.equal(notifications, 2, '首次发布 + 本次写入各通知一次');
});

test('a change notification fires for external edits too', () => {
	// The file provider watches settings.yaml, so an edit made outside the UI
	// republishes through the same seam. Nothing in this module may distinguish
	// the two, or an external edit would be ignored until restart.
	const { ctx, base, publish } = fakeSettingsContext();
	const seen = [];
	installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {
		seen.push('change');
	});
	publish({ default: { threshold: 0.42 } });
	assert.deepEqual(seen, ['change', 'change']);
});

test('a merged document is accepted by resolveConfig', () => {
	// The schema and the resolver are two stages of one validation path; a
	// document the schema accepts must not be rejected downstream, or the
	// settings page could produce an unloadable document.
	const { ctx, base, publish } = fakeSettingsContext();
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
	publish({
		default: { threshold: 0.9, retain: 0.2 },
		providers: { 'gateway-b': { threshold: 0.6 } },
		models: [{ provider: 'p', model: 'm', threshold: 0.5 }],
	});
	const resolved = resolveConfig(state.current());
	assert.equal(resolved.default.threshold, 0.9);
	assert.equal(resolved.providers['gateway-b'].threshold, 0.6);
	assert.equal(resolved.models[0].threshold, 0.5);
});

test('a partial override keeps the fields the base declared', () => {
	// This is the property the provider's leaf-wise merge gives us, and the
	// reason this module must not merge documents itself: doing so would apply
	// the base twice and could revert untouched fields.
	const { ctx, base, publish } = fakeSettingsContext();
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
	publish({ default: { threshold: 0.5 } });
	assert.equal(state.current().default.threshold, 0.5);
	assert.equal(state.current().default.retain, 0.16, '★ 未覆盖的 retain 必须保留组合默认值');
});

test('a panel-saved token budget wins over the ratio the composition base declared', () => {
	// The real write path in one test: the panel's ops replace `threshold` with
	// `thresholdTokens` in the user section, the provider merges that section
	// over the composition base (`threshold: 0.8`), and the merged document is
	// what both the settings page and — when the file has no section — the
	// engine resolve. It has to be accepted, and the absolute value has to be
	// the effective one, with the shadowed base ratio named in a warning.
	const { ctx, base, publish } = fakeSettingsContext();
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
	publish({ default: { thresholdTokens: 200_000, retainTokens: 80_000 } });

	const document = state.current();
	assert.equal(document.default.threshold, 0.8, 'the base ratio is still in the merged document');
	const resolved = resolveConfig(document);
	const policy = resolvePolicy(resolved, { provider: 'deepseek-official', model: 'deepseek-flash' }, 1_000_000);
	assert.equal(policy.thresholdTokens, 200_000);
	assert.equal(policy.retainTokens, 80_000);
	assert.deepEqual([policy.absolute.threshold, policy.absolute.retain], [true, true]);
	assert.match(
		policy.warnings.join('\n'),
		/default: thresholdTokens \(200000\) wins over threshold \(0\.8\)/,
		'the shadowed base ratio must be named, not silently dropped',
	);
});

test('the namespace is a legal settings identifier', () => {
	assert.match(SETTINGS_NS, /^[a-z][a-z0-9-]*$/);
});

test('a summarization model chosen in the card survives the round trip', () => {
	// The card writes `{op:'set', path:['default','summarizationModel'], value}`
	// and reads it back off the same layer, so the value must be a real stored
	// string rather than something the resolver normalizes away. `auto` is the
	// other legal value and is stored just as literally: it means "inherit the
	// conversation model", which is a choice, not an absence.
	const { ctx, base, publish } = fakeSettingsContext();
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
	publish({ default: { summarizationModel: 'local/model-g' } });

	const chosen = resolveConfig(state.current());
	const target = { provider: 'gateway-b', model: 'model-d' };
	assert.equal(chosen.default.summarizationModel, 'local/model-g');
	assert.equal(resolvePolicy(chosen, target).summarizationTarget.model, 'model-g');

	publish({ default: { summarizationModel: 'auto' } });
	const inherited = resolveConfig(state.current());
	assert.equal(inherited.default.summarizationModel, 'auto');
	assert.equal(
		resolvePolicy(inherited, target).summarizationTarget,
		undefined,
		'auto 必须回到"沿用会话模型"，而不是变成一个字面量 provider',
	);
});

test('the automatic-compaction switch is a root field, not a per-route one', () => {
	// The card writes the checkbox to `['auto']` while every other row writes
	// into `['default', …]`. If `auto` were accepted inside a layer the switch
	// would appear to be per provider while the engine only ever reads the root
	// value — a control that silently does nothing for every route but one.
	const { ctx, base, publish } = fakeSettingsContext();
	const state = installSettings(ctx, SETTINGS_NS, settingsSchema, base, () => {});
	publish({ auto: false });
	assert.equal(resolveConfig(state.current()).auto, false, '关掉自动压缩必须能从文档根部读到');

	publish({ default: { auto: false } });
	assert.throws(
		() => resolveConfig(state.current()),
		/unknown|auto/,
		'层里出现 auto 必须报错，而不是被静默忽略',
	);
});
test('the host-plane companion publishes the section without claiming compaction', () => {
	// The companion exists so the browser bundle has an enabled host-plane
	// loader entry to hang from: `dsh-client-modules` walks enabled entries and
	// skips disabled or fiberless ones, while the engine normally lives inside
	// an agent preset it cannot see. If this class ever starts claiming the
	// `compaction` seam, a host-plane engine would run beside the preset one on
	// the same bubbling `agent/pre-step` — the "compaction fires far too early"
	// bug — so the assertion is deliberately about what it does NOT do.
	// A bare context: the companion normalizes its document through
	// `resolveConfig` before publishing, so the strict base-verbatim double used
	// elsewhere would (correctly) reject it.
	const companion = new CompactionControlSettings({ inject() {} }, { default: { threshold: 0.8 } });
	assert.equal(companion.currentPolicy().default.threshold, 0.8);
	assert.equal(companion.name, undefined, '不能占用服务名');
});

test('the companion rejects a malformed document at construction', () => {
	// Same reasoning as the engine: a bad document should fail where it was
	// written, naming the field, rather than surfacing at first compaction.
	assert.throws(
		() => new CompactionControlSettings({ inject() {} }, { default: { threshold: 2 } }),
		/less than 1/,
	);
});
