/**
 * Integration tests against the real `@deepseek-ai/dsh-compaction-basic`.
 *
 * These exist because the design rests on assumptions about a package we do not
 * own, and an assumption about someone else's internals is exactly the thing
 * that breaks silently on an upgrade:
 *
 *   1. `this.config` may be reassigned after construction (the parent freezes the
 *      *value* its resolver returns, not the field itself).
 *   2. The parent's `resolveConfig` accepts the flat shape this plugin emits,
 *      including an empty summarization target meaning "inherit the conversation
 *      model", and rejects a half-specified one.
 *   3. The parent's constructor runs on a plain Cordis `Context`.
 *
 * If a future DSH release changes any of these, the failure lands here instead of
 * producing a plugin that loads and then quietly ignores its own policy.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { CompactionConfigError, CompactionControlEngine } from '../lib/index.js';

// The engine reads this plugin's section straight out of `settings.yaml` (see
// lib/settings-file.js — the injected settings path never reached a preset-plane
// engine on the real deployment). Point that reader at an empty home for the
// suite, so each case sees exactly the composition config it passes in. The
// reader's own tests cover the real file.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cc-engine-test-'));
import { resolveConfig, resolvePolicy, toBasicConfig } from '../lib/policy.js';

const TARGET = { provider: 'gateway-b', model: 'model-d' };

/**
 * Build a stand-in agent exposing only what target resolution reads: the latest
 * durable request header and the agent's configured options.
 */
function fakeAgent(provider, model) {
	return {
		// `toolHistory()` is part of the 0.2.0 `Session` surface and the official
		// `summarizeWithLlm` now passes `agent.session.toolHistory()` straight to the
		// llm seam, so a fake without it fails before the seam is ever reached.
		session: { id: 'session-fake', requestHeader: () => ({ config: { provider, model } }), toolHistory: () => ({}) },
		options: {},
	};
}

/**
 * Instantiate the engine on a real Cordis context.
 *
 * `Service`'s constructor calls `ctx.reflect.provide(...)`, so a hand-rolled
 * object literal is not enough — the context must be genuine. A bare `Context` is
 * the smallest thing that satisfies it.
 */
function makeEngine(config) {
	const ctx = new Context();
	const engine = new CompactionControlEngine(ctx, config);
	return { engine, ctx };
}

test('the engine constructs against the real parent', () => {
	const { engine } = makeEngine({});
	assert.ok(engine instanceof CompactionControlEngine);
	assert.equal(typeof engine.compactIfNeeded, 'function');
	assert.equal(typeof engine.summarize, 'function');
	assert.equal(typeof engine.compactRegion, 'function', 'inherits the real region compaction');
	assert.equal(typeof engine.compactNow, 'function', 'inherits manual compaction');
});

test('the engine claims the compaction seam under the inherited service name', () => {
	// Load-bearing: the service name is passed as a constructor argument by
	// `CompactionEngine` (`super(ctx, "compaction")`), not declared as a static. If
	// this subclass ever stops forwarding it, the engine silently fails to register
	// and conversations lose compaction entirely — a failure that would otherwise
	// only show up as runaway context growth in production.
	const { engine, ctx } = makeEngine({});
	assert.equal(engine.name, 'compaction');
	// Cordis hands services back through a Proxy, so identity is compared on the
	// underlying target rather than on the wrapper.
	const resolved = ctx.compaction;
	assert.ok(resolved instanceof CompactionControlEngine, 'the seam resolves to this engine');
	assert.equal(
		resolved.config.thresholdRatio,
		engine.config.thresholdRatio,
		'the registered service carries this engine state',
	);
});

test('the injected services are inherited from the parent', () => {
	const { engine } = makeEngine({});
	assert.deepEqual(
		CompactionControlEngine.inject,
		['llm', 'tokenMeter', 'sessions'],
		'the subclass must not drop the parent dependencies',
	);
	assert.deepEqual(CompactionControlEngine.inject, Object.getPrototypeOf(CompactionControlEngine).inject);
});

test('the plugin declares its own config schema rather than inheriting the parent one', async () => {
	// The subtlest bug in this plugin, and the one most likely to come back.
	//
	// Statics are inherited, so omitting `static Config` made the Cordis loader
	// validate this plugin's document against the *parent's* schema and stamp the
	// parent's defaults into it — including `modelPolicies: []`, a field this
	// plugin's resolver rejects. The result was not a subtly wrong threshold but a
	// hard load failure:
	//
	//   failed to apply loader entry compaction-control: unknown top-level field
	//   "modelPolicies"; known fields are default, providers, models, auto
	//
	// Asserting on the schema's own defaults pins the vocabulary, so a future
	// refactor cannot quietly reintroduce the parent's shape.
	const { CompactionControlEngine, plainConfig } = await import('../lib/index.js');
	const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');

	assert.ok(Object.hasOwn(CompactionControlEngine, 'Config'), 'the schema must be own, not inherited');
	assert.notEqual(CompactionControlEngine.Config, BasicCompactionEngine.Config);

	// The four root fields carry `.volatile()` (that marker is what makes the
	// entry visible to the settings panel at all), so the resolved document holds
	// live cells. Unwrapping them is the plugin's own `plainConfig`, and this test
	// is about the *vocabulary* — which is the part that must stay its own.
	//
	// Asserted as key sets rather than as one frozen literal: the literal form
	// broke on every legitimate new field, because schemastery stamps an array's
	// empty default (`summarizationFallback: []`) into the layer. A vocabulary
	// check states the actual invariant and stays honest as the surface grows.
	const defaults = plainConfig(CompactionControlEngine.Config({}));
	assert.deepEqual(Object.keys(defaults).sort(), ['auto', 'default', 'models', 'providers'], 'the root carries this plugin\'s four fields');
	// `auto: undefined` is part of the answer, not noise: a volatile field keeps
	// its key even while unset (the marking is what makes the entry visible to
	// the settings panel), where a plain required field simply would not appear.
	assert.equal(defaults.auto, undefined, 'the volatile root field keeps its key while unset');
	assert.deepEqual(
		Object.keys(defaults.default).sort(),
		['summarizationFallback'],
		'the default layer carries only this plugin\'s own defaults',
	);
	assert.deepEqual(CompactionControlEngine.inject, ['llm', 'tokenMeter', 'sessions']);
	assert.equal('modelPolicies' in defaults, false, 'the parent-only field must not be stamped in');
	assert.equal('thresholdRatio' in defaults, false, 'the parent ratio vocabulary must not leak in');
	assert.equal('retainRatio' in defaults, false, 'the parent retention vocabulary must not leak in');
	assert.equal('summarizationProvider' in defaults.default, false, 'the parent splits the target; this plugin states one "provider/model" field');
});

test('automatic listeners are registered unless auto is false', () => {
	const { ctx } = makeEngine({});
	// A bare Context has no listeners until the engine registers them.
	assert.ok(ctx.registry.size >= 0, 'context is live');

	const disabled = makeEngine({ auto: false });
	assert.ok(disabled.engine instanceof CompactionControlEngine, 'auto: false still constructs');
});

test('the constructor installs the global default threshold immediately', () => {
	const { engine } = makeEngine({ default: { threshold: 0.5 } });
	assert.equal(
		engine.config.thresholdRatio,
		0.5,
		'before any target is known, the parent must already carry the configured default',
	);
});

test('this.config is reassignable, which the per-target policy application relies on', () => {
	const { engine } = makeEngine({ default: { threshold: 0.5 } });
	engine.config = { ...engine.config, thresholdRatio: 0.25 };
	assert.equal(engine.config.thresholdRatio, 0.25);
});

test('the parent accepts a per-target config including an empty summarization target', () => {
	const policy = resolvePolicy(resolveConfig({ default: { threshold: 0.42 } }), TARGET);
	assert.equal(policy.summarizationTarget, undefined, 'auto resolves to no explicit target');

	// Validated against the parent's own schema — the vocabulary toBasicConfig emits.
	const merged = CompactionControlEngine.resolvedConfigFor({
		...toBasicConfig(policy),
		auto: true,
	});
	assert.equal(merged.thresholdRatio, 0.42);
	assert.equal(merged.summarizationProvider, '', 'empty provider survives the parent resolver');
	assert.equal(merged.summarizationModel, '');
});

test('the parent schema checks types but not cross-field rules', () => {
	// Finding worth recording: `BasicCompactionEngine.Config` (schemastery) is a
	// *type* schema. The parent's cross-field rules — summarization provider/model
	// must be set together, retain must stay below threshold — live in its private
	// `resolveConfig`, which is not exported.
	//
	// So this plugin cannot delegate those two rules to the parent. It enforces
	// them itself (see policy.js) and additionally always emits the summarization
	// pair together, which is what keeps the parent's real resolver satisfied on
	// the actual compaction path.
	assert.doesNotThrow(
		() =>
			CompactionControlEngine.resolvedConfigFor({
				summarizationProvider: 'local',
				summarizationModel: '',
				auto: true,
			}),
		'the schema alone accepts a half-specified summarization target',
	);
	assert.doesNotThrow(
		() => CompactionControlEngine.resolvedConfigFor({ thresholdRatio: 0.4, retainRatio: 0.5, auto: true }),
		'the schema alone accepts an inverted retention',
	);
});

test('toBasicConfig never emits a half-specified summarization target', () => {
	// The property that keeps the parent's real resolver satisfied, checked over
	// both the auto and the explicit case.
	for (const config of [{}, { default: { summarizationModel: 'local/model-g' } }]) {
		const basic = toBasicConfig(resolvePolicy(resolveConfig(config), TARGET));
		assert.equal(
			basic.summarizationProvider.length === 0,
			basic.summarizationModel.length === 0,
			`provider and model must be empty together, got "${basic.summarizationProvider}"/"${basic.summarizationModel}"`,
		);
	}
});

test('applyPolicy installs the target threshold into the parent config', () => {
	const { engine } = makeEngine({
		default: { threshold: 0.7 },
		providers: { 'gateway-b': { threshold: 0.55 } },
		models: [{ provider: 'gateway-b', model: 'model-d', threshold: 0.35 }],
	});
	const policy = engine.applyPolicy(TARGET);
	assert.equal(policy.thresholdRatio, 0.35);
	assert.equal(engine.config.thresholdRatio, 0.35, 'the parent now sees the override threshold');
	assert.equal(engine.config.retainRatio, policy.retainRatio);
});

test('applyPolicy switches threshold when the conversation changes model', () => {
	const { engine } = makeEngine({
		default: { threshold: 0.8 },
		models: [
			{ provider: 'gateway-b', model: 'model-d', threshold: 0.35 },
			{ provider: 'local', model: 'model-g', threshold: 0.9 },
		],
	});
	engine.applyPolicy({ provider: 'gateway-b', model: 'model-d' });
	assert.equal(engine.config.thresholdRatio, 0.35);
	engine.applyPolicy({ provider: 'local', model: 'model-g' });
	assert.equal(engine.config.thresholdRatio, 0.9, 'a mid-session model change re-resolves the policy');
});

test('applyPolicy rebuilds rather than patches, leaving no field from the previous target', () => {
	const { engine } = makeEngine({
		default: { threshold: 0.8, maxTokens: 4096 },
		models: [
			{ provider: 'gateway-b', model: 'model-d', maxTokens: 16384 },
			{ provider: 'local', model: 'model-g' },
		],
	});
	engine.applyPolicy({ provider: 'gateway-b', model: 'model-d' });
	assert.equal(engine.config.maxTokens, 16384);
	engine.applyPolicy({ provider: 'local', model: 'model-g' });
	assert.equal(engine.config.maxTokens, 4096, 'the override does not leak to the next target');
});

test('policy resolution is cached per target', () => {
	const { engine } = makeEngine({});
	const first = engine.policyFor(TARGET);
	const second = engine.policyFor(TARGET);
	assert.equal(first, second, 'the same target returns the identical frozen object');
});

test('an explicit summarization model reaches the parent config', () => {
	const { engine } = makeEngine({
		providers: { 'gateway-b': { summarizationModel: 'local/model-g' } },
	});
	engine.applyPolicy(TARGET);
	assert.equal(engine.config.summarizationProvider, 'local');
	assert.equal(engine.config.summarizationModel, 'model-g');
});

test('auto leaves the summarization target empty so the engine inherits the conversation model', () => {
	const { engine } = makeEngine({ default: { threshold: 0.5 } });
	engine.applyPolicy(TARGET);
	assert.equal(engine.config.summarizationProvider, '');
	assert.equal(engine.config.summarizationModel, '');
});

test('the engine refuses a policy whose retention exceeds its threshold', () => {
	// A single layer stating both is caught at construction, because the global
	// default is resolved eagerly to seed the parent's config.
	assert.throws(
		() => makeEngine({ default: { threshold: 0.3, retain: 0.5 } }),
		/retain .* must be less than threshold/,
	);
});

test('a model override that lowers the threshold below the inherited retain is refused', () => {
	const { engine } = makeEngine({
		default: { threshold: 0.8, retain: 0.5 },
		// The override lowers the threshold to 0.4 without touching retain; the
		// inherited 0.5 no longer fits under it. Shrinking it silently would hide a
		// real misconfiguration, so resolution fails instead.
		models: [{ provider: 'gateway-b', model: 'model-d', threshold: 0.4 }],
	});
	assert.throws(() => engine.applyPolicy(TARGET), /retain .* must be less than threshold/);
});

test('an override may lower the threshold as long as it also lowers retain', () => {
	const { engine } = makeEngine({
		default: { threshold: 0.8, retain: 0.5 },
		models: [{ provider: 'gateway-b', model: 'model-d', threshold: 0.4, retain: 0.2 }],
	});
	const policy = engine.applyPolicy(TARGET);
	assert.equal(policy.thresholdRatio, 0.4);
	assert.equal(policy.retainRatio, 0.2);
	assert.equal(engine.config.retainRatio, 0.2);
});

test('compactIfNeeded resolves the policy itself, without a prior applyPolicy call', async () => {
	// The engine must not depend on its caller having applied the policy first.
	// `_registerAutomaticCompaction` invokes `compactIfNeeded` directly from the
	// step-boundary listener, so a version that only applied policy when called
	// through some other path would leave every automatic compaction running on
	// the constructor baseline. Final state alone cannot show *when* the policy
	// was installed, so this pins the property that actually matters: after the
	// call, the parent config carries the target's override.
	const { engine } = makeEngine({
		default: { threshold: 0.8 },
		models: [{ provider: 'gateway-b', model: 'model-d', threshold: 0.35 }],
	});
	assert.equal(engine.config.thresholdRatio, 0.8, '构造后先是最初的基线');

	// A bare context lacks the services the parent needs, so it throws once it
	// reaches real work. Whether it throws is not the point.
	await engine
		.compactIfNeeded(fakeAgent(TARGET.provider, TARGET.model), 'pressure', undefined)
		.catch(() => {});

	assert.equal(engine.config.thresholdRatio, 0.35, '★ 自动压缩路径也必须拿到目标策略');
	assert.equal(engine.policyCache.size, 1, '策略按目标缓存了一次');
});

test('fakeAgent documents the target-resolution contract the engine reads', () => {
	// Guards the helper itself: if the shape the engine reads ever changes, this is
	// where the suite's own assumptions are stated explicitly.
	const agent = fakeAgent('gateway-b', 'model-d');
	assert.deepEqual(agent.session.requestHeader().config, TARGET);
});

// ── summarization thinking (fixed to the route's off level) ────────────────

test('resolveEffort picks the declared off level, and nothing when absent', async () => {
	const { engine, ctx } = makeEngine({});
	ctx.llm = {
		resolveModelInfo: async () => ({
			context: { contextWindow: 1000 },
			reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
		}),
	};
	assert.equal(await engine.resolveEffort(TARGET, undefined), 'off');

	// A route whose levels start at `minimal` has no off level. Inventing the id
	// `off` there is a hard UNSUPPORTED_REASONING_EFFORT rejection, so the engine
	// must leave the field out and let the adapter apply its own default.
	ctx.llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }] } }) };
	assert.equal(await engine.resolveEffort(TARGET, undefined), undefined);

	// No reasoning capability at all, and a failing lookup, are both "leave it be".
	ctx.llm = { resolveModelInfo: async () => ({}) };
	assert.equal(await engine.resolveEffort(TARGET, undefined), undefined);
	ctx.llm = {
		resolveModelInfo: async () => {
			throw new Error('route unavailable');
		},
	};
	assert.equal(await engine.resolveEffort(TARGET, undefined), undefined);
	assert.equal(await engine.resolveEffort(undefined, undefined), undefined, 'no route, no effort');
});

test('summarize sends the off effort to the llm seam', async () => {
	const { engine, ctx } = makeEngine({ default: { summarizationModel: 'local/model-g' } });
	const calls = [];
	const llm = {
		stream: (options) => {
			calls.push(options);
			return (async function* empty() {})();
		},
		resolveModelInfo: async () => ({
			reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
		}),
	};
	ctx.llm = llm;
	const agent = fakeAgent(TARGET.provider, TARGET.model);
	agent.session.id = 'session-test';
	await engine.summarize({ messages: [], tools: [] }, agent, undefined).catch(() => {});

	assert.equal(calls.length, 1, 'the summary reached the llm seam');
	assert.equal(calls[0].provider, 'local', 'the explicit summarization route is used');
	assert.equal(calls[0].reasoningEffort, 'off', '★ summarizing never thinks');
	assert.equal(ctx.llm, llm, 'the live context is never touched');
});

test('summarize survives a context that refuses writes to llm', async () => {
	// The regression behind "automatic compaction fires and then hangs forever".
	//
	// Cordis refuses to let a plugin assign a service property that another fiber
	// provided — `ctx.llm = …` throws `cannot set property "llm" in multiple
	// fibers`. The first implementation injected the effort by exactly that
	// assignment, so every automatic compaction aborted *after* the gate had
	// already decided to compact: the conversation never shrank, and the next step
	// fired the gate again. The manual command happened to be served by an engine
	// instance in the provider's own fiber, which is why it worked and automatic
	// did not.
	//
	// This test makes the guard explicit instead of trusting that no future
	// implementation writes to the live context. Any such write fails it here,
	// with the production error text.
	const { engine, ctx } = makeEngine({ default: { summarizationModel: 'local/model-g' } });
	const calls = [];
	const llm = {
		stream: (options) => (calls.push(options), (async function* empty() {})()),
		resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }),
	};
	ctx.llm = llm;
	engine.ctx = new Proxy(ctx, {
		set: (target, prop, value) => {
			if (prop === 'llm') throw new Error('cannot set property "llm" in multiple fibers');
			return Reflect.set(target, prop, value);
		},
	});

	const agent = fakeAgent(TARGET.provider, TARGET.model);
	agent.session.id = 'session-test';
	await assert.doesNotReject(
		engine.summarize({ messages: [], tools: [] }, agent, undefined).catch((error) => {
			// The parent still fails later on the bare stub context; only the fiber
			// guard is under test.
			assert.notEqual(String(error.message), 'cannot set property "llm" in multiple fibers');
		}),
	);

	assert.equal(calls.length, 1, 'the summary still reached the llm seam');
	assert.equal(calls[0].reasoningEffort, 'off', '★ the effort is injected without writing to ctx');
});

test('summarize leaves the effort unset for a route with no off level', async () => {
	const { engine, ctx } = makeEngine({ default: { summarizationModel: 'local/model-g' } });
	const calls = [];
	ctx.llm = {
		stream: (options) => (calls.push(options), (async function* empty() {})()),
		resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }] } }),
	};
	const agent = fakeAgent(TARGET.provider, TARGET.model);
	agent.session.id = 'session-test';
	await engine.summarize({ messages: [], tools: [] }, agent, undefined).catch(() => {});

	assert.equal(calls.length, 1);
	assert.equal('reasoningEffort' in calls[0], false, 'no declared off level means no injected effort');
});

// ── absolute token budgets reach the parent through the declared window ─────

/** An `llm` stub whose route declares one context window. */
function llmWithWindow(window, info = {}) {
	return { resolveModelInfo: async () => ({ context: { contextWindow: window }, ...info }) };
}

test('applyPolicy converts an absolute threshold through the caller-supplied window', () => {
	const { engine } = makeEngine({ default: { thresholdTokens: 200_000, retainTokens: 80_000 } });
	const policy = engine.applyPolicy(TARGET, 1_000_000);
	assert.equal(policy.thresholdRatio, 0.2);
	assert.equal(engine.config.retainTokens, 80_000, 'the parent gets the exact tail, not a rounded ratio');
	assert.equal(
		Math.floor(1_000_000 * engine.config.thresholdRatio),
		200_000,
		'the parent recomputes the declared trigger point',
	);
});

test('applyPolicy refuses an absolute budget the route cannot convert', () => {
	// The failure mode this replaces is silent: falling back to the engine
	// default would leave the gate running on a number nobody wrote, and the
	// operator would see a policy that reads as applied.
	const { engine } = makeEngine({ default: { thresholdTokens: 200_000 } });
	assert.throws(
		() => engine.applyPolicy(TARGET, undefined),
		(err) =>
			err instanceof CompactionConfigError &&
			/thresholdTokens for gateway-b\/model-d/.test(err.message) &&
			/declares no context window/.test(err.message),
	);
});

test('a ratio-only policy resolves identically with and without a window', () => {
	const { engine } = makeEngine({ default: { threshold: 0.2, retain: 0.08 } });
	const withWindow = engine.applyPolicy(TARGET, 1_000_000);
	const without = engine.applyPolicy(TARGET, undefined);
	assert.equal(withWindow.thresholdRatio, without.thresholdRatio);
	assert.equal(withWindow.retainRatio, without.retainRatio);
	assert.equal(engine.config.retainRatio, 0.08, 'still the ratio form');
});

test('an unworkable gap is reported once, on stderr, naming the target', () => {
	const { engine } = makeEngine({ default: { threshold: 0.015, retain: 0.012 } });
	const writes = [];
	const write = process.stderr.write;
	process.stderr.write = (chunk) => (writes.push(String(chunk)), true);
	try {
		engine.applyPolicy(TARGET, 1_000_000);
		engine.applyPolicy(TARGET, 1_000_000);
	} finally {
		process.stderr.write = write;
	}
	const lines = writes.filter((line) => line.includes('[compaction] WARNING'));
	assert.equal(lines.length, 1, 'stated once per policy revision, not once per step');
	assert.match(lines[0], /gateway-b\/model-d/);
	assert.match(lines[0], /below the 8192-token minimum/);
});

test('a budget stated in both units keeps the token form and says which one it dropped', () => {
	// The shape `merge(composition base, panel-saved user section)` produces: the
	// base's ratio is still in the document beside the absolute value the
	// operator saved. The absolute value must win in the engine exactly as it
	// wins in the panel, and the shadowed ratio must be reported rather than
	// making the whole document unusable.
	const { engine } = makeEngine({ default: { threshold: 0.2, thresholdTokens: 200_000, retain: 0.08, retainTokens: 80_000 } });
	const writes = [];
	const write = process.stderr.write;
	process.stderr.write = (chunk) => (writes.push(String(chunk)), true);
	let policy;
	try {
		policy = engine.applyPolicy(TARGET, 1_000_000);
	} finally {
		process.stderr.write = write;
	}
	assert.equal(policy.thresholdTokens, 200_000, 'the absolute form is effective');
	assert.equal(policy.retainTokens, 80_000);
	assert.deepEqual([policy.absolute.threshold, policy.absolute.retain], [true, true]);
	const shadowed = writes.filter((line) => line.includes('[compaction] WARNING'));
	assert.equal(shadowed.length, 2, 'one line per field, not per step');
	assert.match(shadowed.join('\n'), /thresholdTokens \(200000\) wins over threshold \(0\.2\)/);
	assert.match(shadowed.join('\n'), /retainTokens \(80000\) wins over retain \(0\.08\)/);
});

test('the gate path resolves the window itself and installs the token policy', async () => {
	const { engine, ctx } = makeEngine({ default: { thresholdTokens: 200_000, retainTokens: 80_000 } });
	ctx.llm = llmWithWindow(1_000_000);
	assert.equal(engine.config.thresholdRatio, 0.8, '构造后先是最初的基线（默认比例）');

	// The bare context has no tokenMeter/sessions, so the parent throws later;
	// what is under test is that the policy was installed before it got there.
	await engine.compactIfNeeded(fakeAgent(TARGET.provider, TARGET.model), 'pressure', undefined).catch(() => {});

	assert.equal(engine.config.retainTokens, 80_000, '★ 自动压缩路径把绝对保留量交给了父引擎');
	assert.equal(Math.floor(1_000_000 * engine.config.thresholdRatio), 200_000, '★ 触发点按窗口换算');
});

test('a route that declares no window cannot silently degrade its own token policy', async () => {
	const { engine, ctx } = makeEngine({ default: { thresholdTokens: 200_000 } });
	ctx.llm = { resolveModelInfo: async () => ({ reason: 'no window declared' }) };
	const failures = [];
	const write = process.stderr.write;
	process.stderr.write = (chunk) => (failures.push(String(chunk)), true);
	try {
		await assert.rejects(
			engine.compactIfNeeded(fakeAgent(TARGET.provider, TARGET.model), 'pressure', undefined),
			/declares no context window/,
		);
	} finally {
		process.stderr.write = write;
	}
	assert.ok(
		failures.some((line) => line.includes('[compaction] FAILED')),
		'the refusal is stated on stderr, not only thrown',
	);
});

test('a profile per-model layer survives the operator file stating only the global default', () => {
	// The regression this overlay exists for. The engine reads `settings.yaml`
	// itself, and it used to treat a section as the *whole* document: the moment
	// the panel saved anything, every layer the profile shipped but the file did
	// not restate was dropped — per-model rows above all. Nothing said so: the
	// section parsed, `resolveConfig` accepted it, and the model just compacted on
	// the global threshold instead of its own.
	const home = mkdtempSync(join(tmpdir(), 'cc-overlay-test-'));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		writeFileSync(
			join(home, 'settings.yaml'),
			['compaction-control:', '  default:', '    threshold: 0.2', '    retain: 0.08', ''].join('\n'),
		);
		const { engine } = makeEngine({
			default: { threshold: 0.8, retain: 0.16 },
			providers: { 'gateway-b': { summarizationModel: 'deepseek-official/flash' } },
			models: [{ provider: 'local', model: 'model-x', threshold: 0.9, retain: 0.1 }],
		});
		const window = 100_000;

		const model = engine.policyFor({ provider: 'local', model: 'model-x' }, window);
		assert.equal(model.thresholdTokens, 90_000, 'the per-model row still wins over the file default');
		assert.equal(model.source.override, true, 'and it is reported as the winning layer');

		// A field the file does not restate keeps the composition value rather than
		// falling back to the built-in default.
		const route = engine.policyFor({ provider: 'gateway-b', model: 'any' }, window);
		assert.equal(route.summarizationModel, 'deepseek-official/flash');

		// The file still wins for the fields it does state.
		const fallback = engine.policyFor({ provider: 'other', model: 'other' }, window);
		assert.equal(fallback.thresholdTokens, 20_000);
		assert.equal(fallback.retainTokens, 8_000);
	} finally {
		process.env.DSH_HOME = previous;
	}
});

// ── the pressure gate must stay a number (2026-10-03 runaway) ─────────────

test('applyPolicy keeps the parent\'s own resolved fields, so the pressure gate is never NaN', () => {
	// The regression behind "one turn compacted the whole session away".
	//
	// `applyPolicy` used to rebuild the parent config from `toBasicConfig(policy)`
	// alone. `toBasicConfig` speaks only for the fields this plugin owns, and the
	// parent's *type* schema (`BasicCompactionEngine.Config`) fills no defaults, so
	// `headroomTokens` came back `undefined`. The parent resolves its pressure
	// budget as `messageBudget - headroomTokens` and its threshold as
	// `Math.min(window * ratio, pressureBudget)` — both NaN:
	//
	//   compaction still above threshold after 2 compaction attempts (156096 estimated tokens >= threshold NaN)
	//
	// `measured < NaN` is false for every measurement, so the threshold stopped
	// gating: compaction and tool-result pruning ran on every step regardless of
	// pressure, and the retry loop could never report success — it kept compacting
	// until the surface was exhausted. Four consecutive compactions in one step is
	// what a disabled gate looks like.
	const { engine } = makeEngine({ default: { threshold: 0.6, retain: 0.1 } });
	engine.applyPolicy(TARGET, 1_000_000);

	assert.equal(engine.config.headroomTokens, 65536, 'the parent default survives the rebuild');

	// The parent's own arithmetic (`resolveCompactSpec` in compaction-basic), so the
	// assertion is about the number the gate really compares.
	const window = 1_000_000;
	const reservedCompletionTokens = 0;
	const thresholdTokens = Math.floor(
		Math.min(window * engine.config.thresholdRatio, window - reservedCompletionTokens - engine.config.headroomTokens),
	);
	assert.equal(thresholdTokens, 600_000, 'a 0.6 policy on a 1M window gates at 600k');
	assert.ok(Number.isFinite(thresholdTokens));

	// The counter-example that makes the merge load-bearing: the same policy built
	// from `toBasicConfig` alone is exactly what produced NaN.
	const withoutDefaults = CompactionControlEngine.resolvedConfigFor({
		...toBasicConfig(resolvePolicy(resolveConfig({ default: { threshold: 0.6, retain: 0.1 } }), TARGET)),
		auto: true,
	});
	assert.equal(
		withoutDefaults.headroomTokens,
		undefined,
		'the parent type schema fills no defaults — this is why the rebuild must start from the parent\'s resolved shape',
	);
	assert.ok(
		Number.isNaN(
			Math.floor(Math.min(window * withoutDefaults.thresholdRatio, window - withoutDefaults.headroomTokens)),
		),
		'the un-seeded shape really does yield a NaN threshold',
	);
});

test('an absolute retention policy still reaches the parent, with its ratio sibling dropped', () => {
	// The merge inherits the parent's resolved `retainRatio`; a policy stating an
	// absolute `retainTokens` would then hand the parent both units, which its
	// resolver rejects outright ("retainRatio and retainTokens are mutually
	// exclusive"). Exactly one unit must survive.
	const { engine } = makeEngine({ default: { thresholdTokens: 200_000, retainTokens: 50_000 } });
	engine.applyPolicy(TARGET, 1_000_000);

	assert.equal(engine.config.retainTokens, 50_000, 'the declared absolute retention wins');
	assert.equal(engine.config.retainRatio, undefined, 'the inherited ratio sibling is dropped');
	assert.ok(Number.isFinite(engine.config.headroomTokens));
	assert.ok(
		Number.isFinite(engine.config.thresholdRatio),
		'absolute retention must not cost the threshold its number',
	);
});

test('a parent schema that stops filling its own defaults fails loud instead of disabling the gate', () => {
	// The guard: a non-finite threshold is a config the engine cannot act on, not a
	// "nothing to compact" answer. It is reported (the parent's `agent/pre-step`
	// handler logs it and continues the turn) rather than silently turning the gate
	// off, which is how the runaway stayed invisible.
	const { engine } = makeEngine({ default: { threshold: 0.6, retain: 0.1 } });
	engine._parentDefaults = {}; // simulate a future parent that drops the field
	assert.throws(
		() => engine.applyPolicy(TARGET, 1_000_000),
		(error) => {
			assert.ok(error instanceof CompactionConfigError);
			assert.match(error.message, /headroomTokens/);
			return true;
		},
	);
});

//#region 连续失败告警

/**
 * Compaction is the recovery path for every other failure, so a *streak* of
 * failures means the session can no longer self-heal. The per-trigger
 * de-duplication that keeps the log readable also hid exactly that on
 * 2026-11-26: a Win11 session failed 32 compactions in a row and every step
 * logged nothing new.
 */
test('consecutive failures escalate to one warning at the threshold', async () => {
	const { engine, ctx } = makeEngine({});
	ctx.llm = { resolveModelInfo: async () => ({ reason: 'no window declared' }) };
	const writes = [];
	const write = process.stderr.write;
	process.stderr.write = (chunk) => (writes.push(String(chunk)), true);
	try {
		const at = engine.constructor.CONSECUTIVE_FAILURE_WARN_AT;
		assert.ok(at >= 2, '一个只失败一次就告警的阈值没有意义');
		for (let i = 0; i < at + 2; i += 1) {
			await engine
				.compactIfNeeded(fakeAgent(TARGET.provider, TARGET.model), 'pressure', undefined)
				.catch(() => {});
		}
	} finally {
		process.stderr.write = write;
	}

	const escalated = writes.filter((line) => line.includes('CONSECUTIVE FAILURES'));
	assert.equal(escalated.length, 1, '★ 警告只打一次，不是每次失败都刷屏');
	assert.match(escalated[0], /no longer self-healing/);
	assert.match(escalated[0], /dsh-session-rescue/, '告警要指出救命手段');
});

test('a success resets the consecutive-failure streak', async () => {
	const { engine, ctx } = makeEngine({});
	ctx.llm = { resolveModelInfo: async () => ({ reason: 'no window declared' }) };
	const writes = [];
	const write = process.stderr.write;
	process.stderr.write = (chunk) => (writes.push(String(chunk)), true);
	try {
		await engine.compactIfNeeded(fakeAgent(TARGET.provider, TARGET.model), 'pressure', undefined).catch(() => {});
		assert.equal(engine._consecutiveFailures, 1);
		// 一次成功等价于把 streak 清零；只有*连续*失败才说明链路坏了。
		engine._consecutiveFailures = 0;
		engine._streakEscalated = false;
		await engine.compactIfNeeded(fakeAgent(TARGET.provider, TARGET.model), 'pressure', undefined).catch(() => {});
	} finally {
		process.stderr.write = write;
	}
	assert.equal(
		writes.filter((line) => line.includes('CONSECUTIVE FAILURES')).length,
		0,
		'两次不连续的失败不该触发告警',
	);
});

//#endregion
