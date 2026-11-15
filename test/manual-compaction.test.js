/**
 * Regression tests for the manual-compaction wrapper.
 *
 * These pin the two failures measured on 2026-10-04 in two sessions, where every
 * `/compact` attempt failed twice in a row:
 *
 *   1. the command settled as "This operation was aborted" ~4s in while the
 *      transaction kept running and was then lost — the UI request signal was
 *      composed into the compaction;
 *   2. the immediate retry (6–8ms later) was answered "Compaction is unavailable
 *      because this process has an active compaction, or the agent is not idle"
 *      — a lie: the lock was free and only the agent's gate was still closing,
 *      which the parent rewrites into `busy` because it never awaits
 *      `runMaintenance`.
 *
 * The parent is stubbed on its prototype for the wrapper cases: `super.compactNow`
 * resolves there, so the stub *is* the inherited implementation from the
 * wrapper's point of view. One case calls the real inherited implementation to
 * prove the gate wrapper still looks the way `isMaintenanceGateError` expects.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the settings-file reader at an empty home so a case never reads a real
// `settings.yaml`; the reader's own tests cover the real document.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cc-manual-test-'));

import { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction';

import {
	CompactionControlEngine,
	isMaintenanceGateError,
	waitForAgentIdle,
} from '../lib/index.js';

/** Instantiate the engine on a real Cordis context (the seam's constructor needs one). */
function makeEngine(config = {}) {
	return new CompactionControlEngine(new Context(), config);
}

/** The exact wrapper the agent loop's synchronous gate refusal produces. */
function gateFailure() {
	return new ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', {
		cause: new Error('agent "session-fake" already has active work'),
	});
}

/** Run `body` with the inherited `compactNow` replaced by `stub`. */
async function withParentCompactNow(stub, body) {
	const original = BasicCompactionEngine.prototype.compactNow;
	BasicCompactionEngine.prototype.compactNow = stub;
	try {
		return await body();
	} finally {
		BasicCompactionEngine.prototype.compactNow = original;
	}
}

/** An idle agent whose `whenIdle()` resolves immediately and records the call. */
function idleAgent() {
	const agent = {
		status: 'idle',
		idleCalls: 0,
		whenIdle() {
			agent.idleCalls += 1;
			return Promise.resolve();
		},
	};
	return agent;
}

test('the gate wrapper is recognizable, and a real failure is not mistaken for it', () => {
	assert.equal(isMaintenanceGateError(gateFailure()), true);
	// The genuine lock `assertCompactionInactive` throws: same code, no agent-loop
	// cause. Treating it as a closing gate would retry a session that really is
	// locked and then report a misleading "retry now".
	assert.equal(
		isMaintenanceGateError(
			new ManualCompactionError('busy', 'compaction: compaction already in progress; the session compaction lock is already active'),
		),
		false,
	);
	assert.equal(isMaintenanceGateError(new ManualCompactionError('summary', 'not smaller')), false);
	assert.equal(isMaintenanceGateError(new Error('already has active work')), false);
});

test('waitForAgentIdle resolves on whenIdle, on timeout, and on abort', async () => {
	const agent = idleAgent();
	await waitForAgentIdle(agent, undefined, 1_000);
	assert.equal(agent.idleCalls, 1, 'the wait must observe the agent going idle');

	const stuck = { whenIdle: () => new Promise(() => {}) };
	const started = Date.now();
	await waitForAgentIdle(stuck, undefined, 20);
	assert.ok(Date.now() - started >= 15, 'the wait must be bounded by its timeout');

	const controller = new AbortController();
	const pending = waitForAgentIdle(stuck, controller.signal, 60_000);
	controller.abort();
	await pending; // resolves, never rejects: callers re-check the signal themselves
});

test('a retry that lands while the previous maintenance is still closing is waited out, not reported as busy', async () => {
	const engine = makeEngine();
	let calls = 0;
	await withParentCompactNow(
		async () => {
			calls += 1;
			if (calls === 1) throw gateFailure();
			return { shadowedSeqs: [1, 2], shadowedTokenCount: 10 };
		},
		async () => {
			const agent = idleAgent();
			const result = await engine.compactNow(agent, new AbortController().signal, 'cmd-1');
			assert.equal(calls, 2, 'the gate refusal must be retried exactly once');
			assert.equal(agent.idleCalls, 1, 'the retry must wait for the agent to go idle first');
			assert.deepEqual(result.shadowedSeqs, [1, 2]);
		},
	);
});

test('aborting the UI request mid-transaction does not abort the transaction', async () => {
	const engine = makeEngine();
	const controller = new AbortController();
	let seen;
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	await withParentCompactNow(
		async (_agent, signal) => {
			seen = signal;
			await pending;
			return null;
		},
		async () => {
			const call = engine.compactNow(idleAgent(), controller.signal, 'cmd-2');
			// The stub body has already run synchronously up to its first await.
			assert.notEqual(seen, controller.signal, 'the request signal must not reach the parent');
			controller.abort();
			assert.equal(seen.aborted, false, 'aborting the request must not abort a running transaction');
			release();
			assert.equal(await call, null);
		},
	);
});

test('each manual compaction gets its own never-aborting signal', async () => {
	// A shared permanent signal would accumulate one `AbortSignal.any` listener
	// (and retain one composite) per compaction for the life of the process.
	const engine = makeEngine();
	const seen = [];
	await withParentCompactNow(
		async (_agent, signal) => {
			seen.push(signal);
			return null;
		},
		async () => {
			await engine.compactNow(idleAgent(), new AbortController().signal, 'cmd-a');
			await engine.compactNow(idleAgent(), new AbortController().signal, 'cmd-b');
		},
	);
	assert.equal(seen.length, 2);
	assert.notEqual(seen[0], seen[1]);
	assert.equal(seen[0].aborted || seen[1].aborted, false);
});

test('a caller that already gave up never opens a transaction', async () => {
	const engine = makeEngine();
	let calls = 0;
	await withParentCompactNow(
		async () => {
			calls += 1;
			return null;
		},
		async () => {
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(
				() => engine.compactNow(idleAgent(), controller.signal, 'cmd-3'),
				(error) => error?.name === 'AbortError',
			);
		},
	);
	assert.equal(calls, 0, 'an aborted caller must not start a 30s durable transaction');
});

test('a running turn is refused at once with an actionable message', async () => {
	const engine = makeEngine();
	let calls = 0;
	await withParentCompactNow(
		async () => {
			calls += 1;
			return null;
		},
		async () => {
			await assert.rejects(
				() => engine.compactNow({ status: 'running' }, new AbortController().signal, 'cmd-4'),
				/running a turn/,
			);
		},
	);
	assert.equal(calls, 0, 'a running turn must not be entered, let alone waited on');
});

test('a real failure keeps its own cause instead of being rewritten as busy', async () => {
	const engine = makeEngine();
	const failure = new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary');
	await withParentCompactNow(
		async () => {
			throw failure;
		},
		async () => {
			await assert.rejects(
				() => engine.compactNow(idleAgent(), new AbortController().signal, 'cmd-5'),
				(error) => error === failure,
			);
		},
	);
});

test('a gate that never releases is reported as a stuck agent, not as an active compaction', async () => {
	const engine = makeEngine();
	const previousWait = CompactionControlEngine.MANUAL_GATE_WAIT_MS;
	CompactionControlEngine.MANUAL_GATE_WAIT_MS = 20;
	try {
		await withParentCompactNow(
			async () => {
				throw gateFailure();
			},
			async () => {
				await assert.rejects(
					() => engine.compactNow({ status: 'idle', whenIdle: () => new Promise(() => {}) }, new AbortController().signal, 'cmd-6'),
					(error) => /still finishing its previous activity/.test(error.message) && !/active compaction/.test(error.message),
				);
			},
		);
	} finally {
		CompactionControlEngine.MANUAL_GATE_WAIT_MS = previousWait;
	}
});

test('contract: the inherited compactNow still wraps the agent-loop gate the way the retry detects it', async () => {
	// If an upgrade changes either the message or the wrapping, the retry in
	// `compactNow` silently stops firing and the original bug returns. Fail here
	// instead of in a session.
	const engine = makeEngine();
	const inherited = BasicCompactionEngine.prototype.compactNow;
	const agent = {
		status: 'idle',
		runMaintenance() {
			throw new Error('agent "session-fake" already has active work');
		},
	};
	await assert.rejects(
		// The inherited implementation throws *synchronously* here (its catch has no
		// await in front of it); the async wrapper is what lets `rejects` see it —
		// and what makes the wrapper's own `await` necessary.
		async () => inherited.call(engine, agent, new AbortController().signal, 'cmd-7'),
		(error) => {
			assert.equal(error.code, 'busy', 'the sync gate refusal is rewritten to busy');
			assert.equal(isMaintenanceGateError(error), true, 'and must stay recognizable as the gate');
			return true;
		},
	);
});
