/**
 * The summarization call must replay the FULL conversation, not just the
 * shadowed region.
 *
 * Upstream `buildSummarizationInput` replays only the region being compacted —
 * the *oldest* part of the conversation — and relies on the provider matching
 * that shorter prompt against a cached prefix of the conversation. A
 * hyperscaler's prefix cache can do that. A local inference engine cannot: it
 * resumes only from a stored state that is an exact token-prefix of the new
 * prompt, and it keeps at most `--prompt-cache` (6) checkpoints taken at
 * assistant-turn boundaries and every 16384 fresh tokens. Those six slots hold
 * the recent turn boundaries, so the region's own checkpoints are evicted and a
 * region-only replay matches nothing but the pinned system-prompt root: the
 * whole region is re-read.
 *
 * Measured on the real deployment: a 403,413-token prompt read over 311 s and
 * then killed by provider-d's 300 s idle watchdog, because a prefill emits no tokens
 * and therefore looks idle. Compaction could never finish.
 *
 * Appending the instruction after the full conversation makes the call an exact
 * *extension* of the live state, so the engine resumes at the live end and
 * prefills only the instruction. These tests pin that, plus the two properties
 * that keep it safe: the caller's input is never mutated, and a session that
 * cannot project a surface keeps the upstream region-only input.
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
function fakeSession({ withSurface = true, emptySurface = false } = {}) {
	const session = {
		id: 'session-prefix',
		requestHeader: () => ({ config: TARGET, tools: TOOLS }),
		toolHistory: () => ({}),
	};
	if (withSurface) {
		session.surface = { nodes: emptySurface ? [] : [0, 1, 2, 3, 4] };
		session.eventAt = (seq) => ({ seq });
		session.deriveEventMessage = (event) => PROJECTED.get(event.seq) ?? null;
	}
	return session;
}

/** An engine whose llm seam records every summary request it is handed. */
function makeEngine(session) {
	const ctx = new Context();
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
	const engine = new CompactionControlEngine(ctx, {});
	return { engine, calls, ctx, llm, agent: { session, options: {} } };
}

const texts = (options) => options.messages.map((message) => message.content[0].text);

/**
 * The conversation part of the request: the parent always appends exactly one
 * COMPACTION_INSTRUCTION message last, so the assertions below compare the
 * conversation and separately pin that the instruction really is final — that
 * ordering is precisely what makes the call an extension of the live state.
 */
const conversation = (options) => texts(options).slice(0, -1);
const instruction = (options) => texts(options).at(-1);

test('the summary replays the whole conversation, not just the shadowed region', async () => {
	const { engine, calls, agent } = makeEngine(fakeSession());
	await engine.summarize(REGION_INPUT, agent, undefined).catch(() => {});

	assert.equal(calls.length, 1, 'the summary reached the llm seam');
	assert.deepEqual(
		conversation(calls[0]),
		['SYSTEM', 'U1', 'A1', 'U2-TAIL', 'A2-TAIL'],
		'★ every surface message is replayed, including the retained tail after the region',
	);
	assert.match(instruction(calls[0]), /compaction engine/, 'the instruction is the final message');
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

	assert.deepEqual(conversation(calls[0]), ['SYSTEM', 'U1', 'A1'], 'nothing projected means nothing to add');
});
