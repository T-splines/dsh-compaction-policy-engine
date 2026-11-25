/**
 * Gating on an unstated policy must not be silent.
 *
 * The gate's number falls back to the engine's constructor baseline when no
 * layer states a threshold for the routed target. On this deployment that
 * baseline is 0.8/0.16, so an operator who set 42% in the settings card watches
 * compaction fire at 80% with nothing in any log to explain the difference —
 * "my setting did not apply" and "my setting applied to a different target"
 * look identical from outside. The one-shot warning exists so they do not.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportUnstatedThreshold } from '../lib/index.js';

/** Capture stderr writes for one call. */
function capture(run) {
	const lines = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	try {
		run();
	} finally {
		process.stderr.write = original;
	}
	return lines;
}

/** An engine stand-in exposing exactly what the warning reads. */
function fakeEngine() {
	return {
		config: { thresholdRatio: 0.8, retainRatio: 0.16 },
		_fileOrigin: 'composition',
		ctx: { fiber: { name: 'CompactionControlEngine' } },
	};
}

const TARGET = { provider: 'local', model: 'model-h' };

test('a policy that states no threshold warns once, naming the baseline', () => {
	const engine = fakeEngine();
	const lines = capture(() => {
		reportUnstatedThreshold(engine, TARGET, { retainRatio: 0.1 });
		reportUnstatedThreshold(engine, TARGET, { retainRatio: 0.1 });
	});

	assert.equal(lines.length, 1, '★ the first fallback is reported, the repeat is not');
	assert.match(lines[0], /NO THRESHOLD/);
	assert.match(lines[0], /target=local\/model-h/);
	assert.match(lines[0], /fires at 80% of the window/, 'the message names the percentage actually used');
	assert.match(lines[0], /source=composition/, 'and which layer the engine is running on');
});

test('a policy that states a ratio is never reported', () => {
	const engine = fakeEngine();
	// The resolved shape `resolvePolicy` actually returns: `source.threshold.layer`
	// names the winning layer, and `'engine'` means none of the operator's layers
	// said anything. It is that, not the presence of `thresholdRatio` (the resolver
	// always fills that from its default), which distinguishes stated from unstated.
	const lines = capture(() =>
		reportUnstatedThreshold(engine, TARGET, {
			thresholdRatio: 0.42,
			retainRatio: 0.1,
			source: { threshold: { layer: 'default', unit: 'ratio' } },
		}),
	);

	assert.deepEqual(lines, [], '42% is stated, so there is nothing to report');
});

test('a policy that states an absolute budget is never reported', () => {
	const engine = fakeEngine();
	const lines = capture(() =>
		reportUnstatedThreshold(engine, TARGET, {
			thresholdTokens: 220_200,
			retainRatio: 0.1,
			source: { threshold: { layer: 'model', unit: 'tokens' } },
		}),
	);

	assert.deepEqual(lines, [], 'an absolute budget is a stated threshold too');
});

test('a resolved policy whose threshold came from the engine default *is* reported', () => {
	// Regression guard for the bug above: this is the shape the resolver returns
	// when no layer states a threshold, and it used to be treated as "stated"
	// because `thresholdRatio` was defined. The warning could never fire in
	// production, which is exactly the silence it exists to break.
	const engine = fakeEngine();
	const lines = capture(() =>
		reportUnstatedThreshold(engine, TARGET, {
			thresholdRatio: 0.8,
			retainRatio: 0.16,
			source: { threshold: { layer: 'engine', unit: 'ratio' } },
		}),
	);

	assert.equal(lines.length, 1, '★ the engine baseline must be reported');
	assert.match(lines[0], /NO THRESHOLD/);
});

test('an unrouted target reports under its own key', () => {
	const engine = fakeEngine();
	const lines = capture(() => reportUnstatedThreshold(engine, undefined, undefined));

	assert.equal(lines.length, 1);
	assert.match(lines[0], /target=no-routed-target/);
});
