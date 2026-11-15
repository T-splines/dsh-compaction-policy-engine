/**
 * Manual compaction honours the same retention as the automatic path.
 *
 * The defect these pin was measured in a real deployment, not reasoned about: an
 * automatic compaction shadowed roughly 319K tokens and kept about 74.7K — the
 * configured retention — while a manual `/compact` shadowed roughly 206K and kept
 * about 2K, one surface node. Two compactions, two different policies.
 *
 * The cause is upstream and cannot be reached from here:
 * `BasicCompactionEngine.compactNow` calls its private
 * `selectCompactableRange(session, measurement, 0)` with a hard-coded zero
 * retention. The transaction that would take a real one is private to the
 * package (it exports only the engine class), and the public `compactRegion`
 * demands an open turn, which an idle manual compaction does not have.
 *
 * So the retention is applied by changing what the parent's selector *sees*.
 * These tests verify the shape of that exchange rather than the wording of it:
 * the parent must receive a measurement whose nodes are the same nodes in the
 * same order (its own surface consistency check), and it must stop on the index
 * the real retention asks for. If a future release changes the selector's loop,
 * or stops comparing tokens the way it does, the failure lands here instead of
 * producing a plugin that loads and quietly keeps collapsing manual compactions.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cc-mc-manual-'));
process.env.DSH_COMPACT_DEBUG = '1';

import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

import { CompactionControlEngine, reframeMeasurement, retainKeepIndex } from '../lib/index.js';

const TARGET = { provider: 'gateway-b', model: 'model-d' };

/** The window and reservation the plugin's own integration tests use. */
const WINDOW = 1_000_000;
const RESERVED = 65_536;
/** Message budget = window − reservation, the base a retention ratio scales. */
const MESSAGE_BUDGET = WINDOW - RESERVED;

/**
 * A stand-in agent exposing what target resolution and the manual path read.
 *
 * `requestHeader` is a getter-backed call so a test can install the routed target
 * the way a real session carries it, and `toolHistory` is present because the
 * parent's summarization reaches for it before the seam does.
 */
function manualAgent(provider = TARGET.provider, model = TARGET.model) {
	const agent = {
		status: 'idle',
		whenIdle: () => Promise.resolve(),
		session: {
			id: 'session-fake',
			requestHeader: () => ({ config: { provider, model, maxTokens: RESERVED } }),
			toolHistory: () => ({}),
		},
		options: {},
	};
	return agent;
}

/**
 * A token meter whose nodes are uniform, so an index means a known token count.
 *
 * Uniform is deliberate: with N nodes of T tokens each, "keep the last k nodes"
 * and "keep m tokens" differ by one boundary the test can name exactly.
 */
function uniformMeter(count, perNode = 1_000) {
	const nodes = Array.from({ length: count }, (_, index) => ({ seq: index, tokens: perNode }));
	return {
		measure: () => ({ nodes, totalTokens: count * perNode }),
	};
}

/**
 * Instantiate the engine with a metered token service and an llm that can
 * describe the route's window.
 *
 * The window has to come through `resolveModelInfo` because that is the only
 * source `contextWindowOf` has, and the gate is what fills the policy cache the
 * manual path reads. So each case runs one real gate pass first — exactly what
 * happens in production, where `/compact` arrives after the conversation has
 * already been compacting itself.
 */
function makeEngine(config) {
	const ctx = new Context();
	ctx.reflect.provide('tokenMeter', uniformMeter(config.__nodeCount ?? 20));
	ctx.reflect.provide('llm', {
		resolveModelInfo: async () => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: 8_192 }),
	});
	const { __nodeCount, ...cfg } = config;
	return { engine: new CompactionControlEngine(ctx, cfg), ctx };
}

/**
 * Fill the policy cache the manual path reads, the way a live conversation has it
 * filled before a manual compaction can happen: the gate resolves the target's
 * policy against the route's window, so `policyFor` writes the target+window key
 * `cachedWindowOf` later reads.
 */
async function primeGate(engine, agent) {
	await engine.applyPolicy(TARGET, WINDOW);
	return engine.ctx.tokenMeter.measure(agent.session);
}

/**
 * Run the parent's private range-selection criterion over a measurement.
 *
 * Reimplemented from the upstream source rather than exported, because the whole
 * point of this test is to notice when that source changes: if a release alters
 * the criterion, the copy diverges, the assertion fails, and the fix is
 * deliberate rather than a plugin that quietly stops honouring its own policy.
 * It is the loop from `selectCompactableRange`, verbatim.
 */
function parentStopIndex(measurement) {
	let accumulated = 0;
	let keepFromIdx = measurement.nodes.length;
	for (let index = measurement.nodes.length - 1; index >= 0; index -= 1) {
		accumulated += measurement.nodes[index].tokens;
		keepFromIdx = index;
		if (accumulated >= 0) break;
	}
	return keepFromIdx;
}

test('the shadow makes the parent stop on the index the retention asks for', async () => {
	// 100 nodes × 1,000 = 100,000 tokens, retention 0.02 of the message budget
	// (934,464 × 0.02 = 18,689) → keep the last 19 nodes, so the range starts at
	// index 81. The parent's own criterion, run over the re-priced measurement,
	// has to land there: that single number is the whole fix.
	const nodes = 100;
	const perNode = 1_000;
	const { engine } = makeEngine({ default: { retain: 0.02 }, __nodeCount: nodes });
	const agent = manualAgent();
	await primeGate(engine, agent);

	const measurement = engine.ctx.tokenMeter.measure(agent.session);
	const retainTokens = Math.floor(MESSAGE_BUDGET * 0.02);

	const keepFromIdx = retainKeepIndex(measurement, retainTokens);
	assert.equal(keepFromIdx, nodes - 19, 'the real retention keeps the last 19 nodes');
	assert.equal(parentStopIndex(reframeMeasurement(measurement, keepFromIdx)), keepFromIdx, 'the parent stops on the retention index');

	// The nodes below the stop are untouched, so the range the parent selects
	// prices and validates exactly as the real one would — the re-pricing only
	// steers the break point, it does not describe a different context.
	const reframed = reframeMeasurement(measurement, keepFromIdx);
	for (let index = 0; index < keepFromIdx; index += 1) {
		assert.equal(reframed.nodes[index].tokens, perNode, `node ${index} below the stop is not re-priced`);
	}
});

test('a retention the tail cannot satisfy leaves the parent its own answer', async () => {
	// The tail is smaller than the retention, so the real selector returns null.
	// The shadow must let that happen rather than inventing a range: every node
	// discounted, the loop runs off the end, the parent refuses.
	const nodes = 100;
	const perNode = 1_000;
	const { engine } = makeEngine({ default: { retain: 0.5 }, __nodeCount: nodes });
	const agent = manualAgent();
	await primeGate(engine, agent);

	const measurement = engine.ctx.tokenMeter.measure(agent.session);
	const retainTokens = Math.floor(MESSAGE_BUDGET * 0.5);
	assert.equal(retainKeepIndex(measurement, retainTokens), undefined, 'no index satisfies the retention');

	const reframed = reframeMeasurement(measurement, undefined);
	let accumulated = 0;
	let stopAt = -1;
	for (let index = reframed.nodes.length - 1; index >= 0; index -= 1) {
		accumulated += reframed.nodes[index].tokens;
		if (accumulated >= 0) {
			stopAt = index;
			break;
		}
	}
	assert.equal(stopAt, -1, 'the parent loop never clears zero, so it refuses the range');
});

test('the manual path hands the parent an unmodified measurement when nothing is re-priced', async () => {
	// 20 nodes × 1,000 = 20,000 tokens against a retention of 93,446: the tail
	// cannot satisfy the retention, so the selector reports "no useful range" and
	// the parent is called straight through. What must hold is the negative space:
	// the engine's own meter — the one every other path prices against — is
	// untouched, so a refusal cannot corrupt a later compaction's accounting.
	const { engine } = makeEngine({ default: { retain: 0.1 }, __nodeCount: 20 });
	const agent = manualAgent();
	await primeGate(engine, agent);

	const meterBefore = engine.ctx.tokenMeter;
	const original = BasicCompactionEngine.prototype.compactNow;
	BasicCompactionEngine.prototype.compactNow = () => null;
	try {
		assert.equal(await engine.compactNow(agent, new AbortController().signal, 'cmd-refuse'), null);
	} finally {
		BasicCompactionEngine.prototype.compactNow = original;
	}
	assert.equal(engine.ctx.tokenMeter, meterBefore, 'the live token meter is never replaced');
	// The cache the manual path read its window from still holds the route, so a
	// second compaction resolves the same retention.
	assert.equal(engine.cachedWindowOf(TARGET), WINDOW, 'the policy cache still carries the route window');
	assert.equal(engine.retainTokensForManual(agent), Math.floor(MESSAGE_BUDGET * 0.1), 'the same retention is derived again');
});

test('the manual path survives being entered through the context service proxy', async () => {
	// `/compact` reaches the override as `ctx.compaction.compactNow(...)`, not
	// `engine.compactNow(...)` — every test above entered it directly, which is why
	// this one stayed green while production threw. Cordis rebinds `this` to a
	// traceable shadow proxy on the proxied path, and in that proxy `ctx` is
	// read-only by design, so building the shadow receiver as `receiver.ctx = …`
	// walked the read-only chain and failed with
	// "'set' on proxy: trap returned falsish for property 'ctx'". The automatic
	// path enters with the real engine still bound, which is why only manual
	// compaction failed while the pressure gate kept firing.
	const { engine, ctx } = makeEngine({ default: { retain: 0.02 }, __nodeCount: 100 });
	const agent = manualAgent();
	await primeGate(engine, agent);

	const meterBefore = engine.ctx.tokenMeter;
	const retainTokens = Math.floor(MESSAGE_BUDGET * 0.02);
	const expectedStop = retainKeepIndex(meterBefore.measure(agent.session), retainTokens);

	const original = BasicCompactionEngine.prototype.compactNow;
	let seen;
	BasicCompactionEngine.prototype.compactNow = function () {
		seen = this.ctx.tokenMeter;
		return null;
	};
	try {
		assert.equal(await ctx.compaction.compactNow(agent, new AbortController().signal, 'cmd-proxy'), null, 'entering through ctx.compaction does not throw');
	} finally {
		BasicCompactionEngine.prototype.compactNow = original;
	}

	assert.notEqual(seen, meterBefore, 'the parent receives the reframed shadow, not the live meter');
	assert.equal(engine.ctx.tokenMeter, meterBefore, 'the live token meter is never replaced');
	assert.equal(parentStopIndex(seen.measure(agent.session)), expectedStop, 'the parent still stops on the retention index');
});

test('the summarization seam survives being entered through the context service proxy', async () => {
	// Same defect, second call site: `compactNowWithRetention` and `summarize` both
	// build a shadow receiver whose only purpose is to hand the parent a different
	// `ctx`. The seam is currently reached only through the automatic path, so a
	// direct `ctx.compaction.summarize(...)` still works — pin it before a future
	// route makes the failure reachable the same way manual compaction did.
	const { engine, ctx } = makeEngine({
		default: {
			retain: 0.02,
			summarizationModel: 'gateway-b/model-d',
			summarizationFallback: ['gateway-a/model-b'],
		},
	});
	const agent = manualAgent();
	await primeGate(engine, agent);

	const llmBefore = engine.ctx.llm;
	const original = BasicCompactionEngine.prototype.summarize;
	let seen;
	BasicCompactionEngine.prototype.summarize = function () {
		seen = this.ctx.llm;
		return null;
	};
	try {
		assert.equal(await ctx.compaction.summarize({}, agent, new AbortController().signal), null, 'entering through ctx.compaction does not throw');
	} finally {
		BasicCompactionEngine.prototype.summarize = original;
	}

	assert.notEqual(seen, llmBefore, 'the parent receives the fallback forwarder, not the live llm');
	assert.equal(engine.ctx.llm, llmBefore, 'the live llm is never replaced');
	assert.equal(typeof seen.stream, 'function', 'the forwarder exposes the parent stream interface');
});
