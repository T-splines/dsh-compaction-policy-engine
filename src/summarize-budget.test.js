/**
 * Fitting a summary request inside the window it must be sent through.
 *
 * Every case here is arithmetic over message lists, so the module is tested
 * without a session, a context, or a model. The properties that matter are the
 * ones the engine relies on when it decides which stage to use:
 *
 *   - an estimate is never *below* what the provider will charge, or a stage
 *     that "fits" is rejected upstream and the fallback chain runs instead;
 *   - chunking loses no message and covers every index exactly once, or a chunked
 *     summary silently omits part of the conversation;
 *   - shrinking never drops user or assistant turns, because those carry the
 *     decisions a truncated tool log cannot reconstruct.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DEFAULT_MAX_CHUNK_ROUNDS,
	DEFAULT_REQUEST_BUDGET_RATIO,
	chunkMessages,
	elideText,
	listTokens,
	messageTokens,
	requestBudget,
	shrinkToFit,
} from './summarize-budget.js';

/** A text message of roughly `tokens * 4` characters. */
function textMessage(role, tokens) {
	return { role, content: [{ type: 'text', text: 'x'.repeat(tokens * 4) }] };
}

test('a text message costs its density plus framing', () => {
	// 400 chars / 4 = 100 tokens, plus the block overhead and message framing.
	const cost = messageTokens({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] });
	assert.ok(cost >= 100, `expected at least 100 tokens, got ${cost}`);
	assert.ok(cost <= 120, `framing must stay small, got ${cost}`);
});

test('a tool-call block is priced by name and arguments', () => {
	const small = messageTokens({
		role: 'assistant',
		content: [{ type: 'tool-call', name: 'a', arguments: '{}' }],
	});
	const large = messageTokens({
		role: 'assistant',
		content: [{ type: 'tool-call', name: 'a', arguments: 'x'.repeat(4000) }],
	});
	assert.ok(large > small + 900, 'a 4k argument string must dominate the price');
});

test('a string-content message is priced, not ignored', () => {
	// `tool` results project their payload on `content` as a plain string.
	const cost = messageTokens({ role: 'tool', content: 'y'.repeat(4000) });
	assert.ok(cost >= 1000, `expected ~1000 tokens, got ${cost}`);
});

test('an unpriceable message still costs framing, never zero', () => {
	// A zero-priced message would let an unbounded list look empty.
	for (const message of [null, {}, { role: 'user' }, { role: 'user', content: 42 }]) {
		assert.ok(messageTokens(message) > 0, `${JSON.stringify(message)} must be positive`);
	}
});

test('listTokens includes the instruction and the tool catalog', () => {
	const messages = [textMessage('user', 100)];
	const bare = listTokens(messages);
	const withTools = listTokens(messages, 5000);
	assert.ok(withTools >= bare + 5000, 'the tool catalog is part of the request');
	assert.ok(bare > 100, 'the appended instruction is part of the request');
});

test('requestBudget is a fraction of the window and 0 when unknown', () => {
	assert.equal(requestBudget(1_000_000), 800_000);
	assert.equal(requestBudget(256_000), 204_800);
	assert.equal(requestBudget(undefined), 0);
	assert.equal(requestBudget(0), 0);
	assert.equal(requestBudget(-1), 0);
	// An out-of-range ratio falls back to the default rather than producing a
	// nonsensical budget (0 would mark every stage as fitting nothing).
	assert.equal(requestBudget(1000, 2), Math.floor(1000 * DEFAULT_REQUEST_BUDGET_RATIO));
});

test('a list that already fits is one chunk', () => {
	const messages = [textMessage('user', 10), textMessage('assistant', 10)];
	const { chunks, oversized } = chunkMessages(messages, 10_000);
	assert.equal(chunks.length, 1);
	assert.deepEqual(chunks[0], { start: 0, end: 1, tokens: chunks[0].tokens });
	assert.deepEqual(oversized, []);
});

test('chunks cover every index exactly once, in order', () => {
	// The property chunked summarization depends on: nothing skipped, nothing
	// summarized twice.
	const messages = Array.from({ length: 20 }, (_, i) => textMessage(i % 2 ? 'assistant' : 'user', 100));
	const { chunks } = chunkMessages(messages, 400);
	assert.ok(chunks.length > 1, 'the list must actually be split');
	let next = 0;
	for (const chunk of chunks) {
		assert.equal(chunk.start, next, 'chunks must be contiguous');
		assert.ok(chunk.end >= chunk.start, 'a chunk cannot be empty');
		next = chunk.end + 1;
	}
	assert.equal(next, messages.length, 'the last chunk must reach the end');
});

test('each chunk stays inside the budget it was given', () => {
	// 12 x 100 tokens = 1200 total, so a 2000 budget could hold it in one chunk;
	// use 40 messages so the split is the budget's doing, not the list's length.
	const messages = Array.from({ length: 40 }, (_, i) => textMessage(i % 2 ? 'assistant' : 'user', 100));
	const budget = 2000;
	const { chunks, oversized } = chunkMessages(messages, budget);
	assert.deepEqual(oversized, [], 'no message here is larger than the budget');
	assert.ok(chunks.length > 1, 'this list must actually be split');
	for (const chunk of chunks) {
		assert.ok(chunk.tokens <= budget - 512, `chunk ${chunk.start}-${chunk.end} is ${chunk.tokens}`);
	}
});

test('a message larger than the whole budget gets its own chunk and is reported', () => {
	// Reported rather than dropped: a caller that silently skipped it would
	// summarize a conversation with a hole in the middle.
	const messages = [textMessage('user', 10), textMessage('tool', 5000), textMessage('user', 10)];
	const budget = 2000;
	const { chunks, oversized } = chunkMessages(messages, budget);
	assert.deepEqual(oversized, [1]);
	const monster = chunks.find((chunk) => chunk.start === 1);
	assert.deepEqual(monster, { start: 1, end: 1, tokens: monster.tokens });
	assert.ok(monster.tokens > budget, 'the oversized chunk is honestly over budget');
});

test('reserving room for tools shrinks the per-chunk payload', () => {
	const messages = Array.from({ length: 10 }, (_, i) => textMessage('user', 100));
	const roomy = chunkMessages(messages, 2000);
	const tight = chunkMessages(messages, 2000, { toolTokens: 1500 });
	assert.ok(tight.chunks.length > roomy.chunks.length, 'the reservation must cost payload room');
});

test('empty input yields no chunks', () => {
	assert.deepEqual(chunkMessages([], 1000), { chunks: [], oversized: [] });
	assert.deepEqual(chunkMessages(undefined, 1000), { chunks: [], oversized: [] });
	// A non-positive budget cannot fit anything and must not loop forever.
	assert.deepEqual(chunkMessages([textMessage('user', 1)], 0), { chunks: [], oversized: [] });
});

test('elideText keeps the head and the tail and names what it removed', () => {
	const text = `${'H'.repeat(3000)}${'M'.repeat(4000)}${'T'.repeat(3000)}`;
	const trimmed = elideText(text, 2048, 512);
	assert.ok(trimmed.length < text.length, 'the excerpt must be shorter');
	assert.ok(trimmed.startsWith('H'), 'the head is kept');
	assert.ok(trimmed.endsWith('T'), 'the tail is kept');
	assert.match(trimmed, /characters elided/, 'the elision must be stated');
	assert.doesNotMatch(trimmed, /M{100}/, 'the middle is what went');
});

test('elideText leaves a short string untouched', () => {
	const text = 'short';
	assert.equal(elideText(text, 2048, 512), text);
});

test('shrinkToFit reaches the budget by trimming tool output only', () => {
	const messages = [
		textMessage('user', 100),
		{ role: 'tool', content: 'z'.repeat(40_000) },
		textMessage('assistant', 100),
	];
	const budget = 2000;
	const result = shrinkToFit(messages, budget);
	assert.ok(result.tokens <= budget, `expected ≤ ${budget}, got ${result.tokens}`);
	assert.ok(result.elided > 0, 'something must have been trimmed');
	// The spine survives.
	assert.equal(result.messages[0].role, 'user');
	assert.equal(result.messages[0].content[0].text, 'x'.repeat(400));
	assert.equal(result.messages[2].role, 'assistant');
});

test('shrinkToFit never mutates the caller list', () => {
	const original = { role: 'tool', content: 'q'.repeat(40_000) };
	const messages = [original];
	shrinkToFit(messages, 500);
	assert.equal(original.content.length, 40_000, 'the input message must be untouched');
});

test('shrinkToFit is a no-op when the list already fits', () => {
	const messages = [textMessage('user', 10)];
	const result = shrinkToFit(messages, 10_000);
	assert.equal(result.elided, 0);
	assert.equal(result.messages.length, 1);
});

test('shrinkToFit terminates on a session that cannot fit', () => {
	// Sixty messages with no tool payload to trim: nothing can be elided, so the
	// function must return over budget rather than halve forever.
	const messages = Array.from({ length: 60 }, (_, i) => textMessage('user', 500));
	const result = shrinkToFit(messages, 100);
	assert.ok(result.messages.length === 60, 'no message may be dropped');
	assert.ok(result.tokens > 100, 'the honest answer is "still too big"');
});

test('the chunk round ceiling is a small bounded number', () => {
	// Each round is a full model call; an unbounded loop spends real money.
	assert.ok(DEFAULT_MAX_CHUNK_ROUNDS >= 4);
	assert.ok(DEFAULT_MAX_CHUNK_ROUNDS <= 32);
});
