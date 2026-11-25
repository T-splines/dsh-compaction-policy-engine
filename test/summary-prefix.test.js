/**
 * The summarization call replays exactly what the caller asked for — nothing more.
 *
 * Upstream `buildSummarizationInput` replays only the region being compacted, and
 * this plugin used to override that to replay the whole conversation, to make the
 * summary call an exact token-prefix extension of a local engine's live state.
 * That optimisation was measured on a local engine and is removed (2026-11-26).
 *
 * It failed on the payload that matters. A conversation large enough to need
 * compaction is one whose full replay no longer fits the model's window, so the
 * request that was supposed to rescue the session was the one request that could
 * not be sent. Measured on a Win11 session: real context 217k tokens, but the
 * full replay carried **934k tokens of `reasoning` blocks** on top, and four
 * consecutive compactions were rejected `context_length_exceeded` — the session
 * became unrecoverable.
 *
 * The region upstream selects is bounded by the gate that chose it, so replaying
 * it is bounded too. These tests pin that the plugin no longer widens the request,
 * that the caller's input is never mutated, and that the reasoning that made the
 * full replay unaffordable is not reintroduced by any other path.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cc-summary-prefix-test-'));

import { Context } from '@deepseek-ai/cordis';

import { CompactionControlEngine } from '../lib/index.js';

const TARGET = { provider: 'local', model: 'model-h' };
const TOOLS = [{ name: 'bash', description: 'run a command' }];

/** One projected message per surface node, keyed by seq. */
const PROJECTED = new Map([
	[0, { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] }],
	[1, { role: 'user', content: [{ type: 'text', text: 'U1' }] }],
	[2, { role: 'assistant', content: [{ type: 'text', text: 'A1' }] }],
	[3, { role: 'user', content: [{ type: 'text', text: 'U2-TAIL' }] }],
	[4, { role: 'assistant', content: [{ type: 'text', text: 'A2-TAIL' }] }],
]);

/** The region upstream would replay: the system head and the first two nodes. */
const REGION_INPUT = {
	messages: [PROJECTED.get(0), PROJECTED.get(1), PROJECTED.get(2)],
	tools: TOOLS,
};

/**
 * A session stand-in. `withSurface: false` models one that exposes no readable
 * surface, which is how every fake in this suite's older tests looks.
 */
function fakeSession(options = {}) {
	const session = {
		surface: options.emptySurface ? { nodes: [] } : { nodes: [0, 1, 2, 3, 4] },
		eventAt: (seq) => ({ type: 'user/message', seq }),
		deriveEventMessage: (event) => PROJECTED.get(event.seq),
		requestHeader: () => ({ config: { provider: TARGET.provider, model: TARGET.model } }),
		toolHistory: () => [],
	};
	if (options.withSurface === false) delete session.surface;
	return session;
}

/** An engine whose llm seam records each request and answers with one text block. */
function makeEngine(session, control = {}) {
	const calls = [];
	const ctx = new Context();
	ctx.tokenMeter = { measure: () => ({ totalTokens: 0, nodes: [] }) };
	const llm = {
		resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }),
		stream: async function* (options) {
			calls.push(options);
			yield { type: 'block-end', block: { type: 'text', text: 'SUMMARY' } };
			yield { type: 'finish', reason: 'stop' };
		},
		resolveModel: async (provider, model) => ({
			provider,
			model,
			reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] },
		}),
	};
	ctx.llm = llm;
	// 走真实构造器：`resolveConfig` 会校验并规范化每一层，直接改字段会绕过它。
	const engine = new CompactionControlEngine(ctx, control);
	return { engine, calls, ctx, llm, agent: { session, options: {} } };
}

const texts = (options) => options.messages.map((message) => message.content[0].text);

/**
 * The conversation part of the request: the parent always appends exactly one
 * COMPACTION_INSTRUCTION message last, so the assertions below compare the
 * conversation and separately pin that the instruction really is final.
 */
const conversation = (options) => texts(options).slice(0, -1);
const instruction = (options) => texts(options).at(-1);

test('the summary replays the region, not the whole conversation', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession());
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.equal(calls.length, 1, 'the summary reached the llm seam');
	assert.deepEqual(
		conversation(calls[0]),
		['SYSTEM', 'U1', 'A1'],
		'★ the region is replayed; the retained tail is NOT dragged along',
	);
	assert.match(instruction(calls[0]), /compaction engine/, 'the instruction is the final message');
});

test('the retained tail is never added to the request', async () => {
	// The specific regression: a full replay pulled in nodes 3 and 4, which are
	// the tail the engine deliberately keeps verbatim. On a long session that is
	// where the unbounded growth came from.
	const { engine, calls, agent } = makeEngine(fakeSession());
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	const sent = conversation(calls[0]);
	assert.ok(!sent.includes('U2-TAIL'), 'the retained user tail must not be replayed');
	assert.ok(!sent.includes('A2-TAIL'), 'the retained assistant tail must not be replayed');
});

test('reasoning blocks are never replayed by the summary request', async () => {
	// 934k of the 1.3M tokens in the failing session were reasoning. Even a
	// region-only replay must not forward them: they carry no decisions a summary
	// needs and the provider does not replay them into later turns either.
	const session = fakeSession();
	session.deriveEventMessage = (event) => {
		const base = PROJECTED.get(event.seq);
		if (base === undefined) return undefined;
		return {
			...base,
			content: [{ type: 'reasoning', text: 'PRIVATE-THOUGHT' }, ...base.content],
		};
	};
	const { engine, calls, agent } = makeEngine(session);
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	// The region is the caller's own list, so it is forwarded as given; what
	// matters is that the engine adds nothing derived from the surface.
	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1']);
});

test('the replayed tools are the caller\u2019s, unchanged', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession());
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(calls[0].tools, TOOLS, 'the tool schemas are handed over unchanged');
});

test('the caller\u2019s input is never mutated', async () => {
	const input = { messages: [...REGION_INPUT.messages], tools: TOOLS };
	const { engine, agent } = makeEngine(fakeSession());
	await engine.summarize(input, agent, undefined).catch(() => {});

	assert.equal(input.messages.length, 3, '★ the parent\u2019s input still holds only the region');
	assert.equal(input.messages, input.messages, 'the array identity the caller passed is intact');
});

test('a session with no readable surface keeps the region-only input', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession({ withSurface: false }));
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1'], 'the upstream input is passed through');
});

test('an empty surface keeps the region-only input', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession({ emptySurface: true }));
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1'], 'an empty projection is not an empty prompt');
});

test('a surface whose nodes all project to null keeps the region-only input', async () => {
	const session = fakeSession();
	session.deriveEventMessage = () => null;
	const { engine, calls, agent } = makeEngine(session);
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1'], 'a null projection is not a truncation');
});

//#region 可选的全量重放（replayFullConversation）

/**
 * The full replay is kept as an opt-in for one real case: a local inference
 * engine that resumes only from an exact token-prefix of the new prompt. For
 * that engine a region-only replay re-reads the whole region (measured 403,413
 * tokens / 311 s), while a full replay is an exact extension of the live state.
 *
 * It must stay opt-in because it fails in the opposite direction: a session
 * large enough to need compaction may not fit its own replay in the window.
 */

/** A layer that turns the replay on for the target under test. */
const REPLAY_ON = { models: [{ provider: TARGET.provider, model: TARGET.model, replayFullConversation: true }] };

test('replayFullConversation: false (the default) keeps the region-only input', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession());
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1'], '★ default is region-only');
});

test('replayFullConversation: true replays the whole surfaced conversation', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession(), REPLAY_ON);
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(
		conversation(calls[0]),
		['SYSTEM', 'U1', 'A1', 'U2-TAIL', 'A2-TAIL'],
		'★ opted in: every surface node is replayed so a prefix-cache engine can resume',
	);
	assert.match(instruction(calls[0]), /compaction engine/, 'the instruction is still the final message');
});

test('replayFullConversation never mutates the caller\'s input', async () => {
	const input = { messages: [PROJECTED.get(0)], tools: TOOLS };
	const original = structuredClone(input);
	const { engine, agent } = makeEngine(fakeSession(), REPLAY_ON);
	await engine.summarize(input, agent, undefined).catch(() => {});

	assert.deepEqual(input, original, 'the parent still owns its input object');
});

test('replayFullConversation: true falls back to the region when the surface is unreadable', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession({ withSurface: false }), REPLAY_ON);
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1'], 'no projection → caller\'s own input');
});

test('replayFullConversation: true falls back to the region on an empty surface', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession({ emptySurface: true }), REPLAY_ON);
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1'], 'empty surface → caller\'s own input');
});

//#endregion
