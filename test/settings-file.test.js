/**
 * Tests for the direct `settings.yaml` reader.
 *
 * This reader exists because the injected settings path did not reach a
 * preset-plane engine on the real deployment: every recorded gate line carried
 * the composition's `thresholdRatio=0.8` while the file said `0.2`. The reader
 * is therefore load-bearing, and its failure mode is a gate that silently runs
 * on the wrong threshold — the exact bug it was written to end.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSettingsDocument, readSection, settingsFilePath, watchSettingsFile } from '../lib/settings-file.js';

test('the parser handles the shapes a settings document actually uses', () => {
	// Comments, quoted scalars, numbers, booleans, nested maps, and a sequence of
	// maps all appear in a real `settings.yaml`.
	const text = [
		'# a comment',
		'agent-default-model:',
		"  provider: 'deepseek-official'   # trailing comment",
		'  model: deepseek-flash',
		'  reasoningEffort: high',
		'compaction-control:',
		'  default:',
		'    threshold: 0.2',
		'    retain: 0.08',
		'    summarizationModel: auto',
		'  providers:',
		'    gateway-b:',
		'      threshold: 0.5',
		'  models:',
		'    - provider: local',
		'      model: model-x',
		'      threshold: 0.9',
		'    - provider: x',
		'      model: y',
		'  auto: false',
		'other:',
		'  nested:',
		'    deep: 1',
	].join('\n');

	assert.deepEqual(readSection(text), {
		default: { threshold: 0.2, retain: 0.08, summarizationModel: 'auto' },
		providers: { 'gateway-b': { threshold: 0.5 } },
		models: [
			{ provider: 'local', model: 'model-x', threshold: 0.9 },
			{ provider: 'x', model: 'y' },
		],
		auto: false,
	});
});

test('a document without this plugin\'s section reads as absent, not as empty', () => {
	// Absent must stay distinguishable from `{}`: the engine falls back to its
	// composition config for absent, but an empty section would override every
	// field with nothing.
	assert.equal(readSection('llm-deepseek:\n  models:\n    - id: a\n'), undefined);
	assert.equal(readSection(''), undefined);
	assert.deepEqual(readSection('compaction-control:\n  default:\n    threshold: 0.2\n'), {
		default: { threshold: 0.2 },
	});
});

test('the reader parses this machine\'s real settings document', () => {
	const file = settingsFilePath();
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return; // no durable settings on this machine; nothing to pin
	}
	const section = readSection(text);
	assert.ok(section !== undefined, `${file} should carry a compaction-control section`);
	assert.equal(typeof section.default?.threshold, 'number', 'the threshold must survive as a number');
});

test('the watcher reports the section, then follows an external edit', async () => {
	// `os.tmpdir()`, not `process.env.TMPDIR ?? '/tmp'`: TMPDIR is unset on
	// Windows, so the fallback produced the drive-relative path `/tmp/...` →
	// `D:\tmp\...`, which does not exist. That failed the windows-latest job
	// while every POSIX run passed.
	const file = join(tmpdir(), `cc-settings-${process.pid}.yaml`);
	const writes = [];
	writeFileSync(file, 'compaction-control:\n  default:\n    threshold: 0.2\n    retain: 0.08\n');
	const stop = watchSettingsFile({
		file,
		fallbackSection: { default: { threshold: 0.8 } },
		onSection: (section, origin) => writes.push({ section, origin }),
		onError: () => {},
	});
	assert.equal(writes.length, 1, 'the initial read is synchronous, so construction can use it');
	assert.equal(writes[0].origin, 'settings.yaml');
	assert.equal(writes[0].section.default.threshold, 0.2);

	// This edit lands immediately after construction, and that timing is the
	// point: it is the window in which the old `fs.watchFile` implementation
	// swallowed the change (its baseline stat is taken asynchronously, so an edit
	// that arrives first *becomes* the baseline and is never reported). It failed
	// here in about one run in three under a parallel test load. The deadline
	// below is 10x the poll interval, so a real regression fails fast instead of
	// hiding behind a two-minute bound.
	writeFileSync(file, 'compaction-control:\n  default:\n    threshold: 0.25\n    retain: 0.08\n');
	for (let tick = 0; tick < 100; tick += 1) {
		if (writes.some((entry) => entry.section.default.threshold === 0.25)) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(
		writes.some((entry) => entry.section.default.threshold === 0.25),
		'an edit made immediately after construction is picked up, not swallowed as the baseline',
	);

	// And every later edit is reported too, not just the first one.
	writeFileSync(file, 'compaction-control:\n  default:\n    threshold: 0.3\n    retain: 0.08\n');
	for (let tick = 0; tick < 100; tick += 1) {
		if (writes.some((entry) => entry.section.default.threshold === 0.3)) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	stop();
	assert.ok(
		writes.some((entry) => entry.section.default.threshold === 0.3),
		'a second external edit is picked up as well',
	);
});

test('a missing file falls back to the composition section instead of failing', () => {
	const writes = [];
	const stop = watchSettingsFile({
		file: join(tmpdir(), `cc-absent-${process.pid}.yaml`),
		fallbackSection: { default: { threshold: 0.8, retain: 0.16 } },
		onSection: (section, origin) => writes.push({ section, origin }),
		onError: () => {},
	});
	stop();
	assert.deepEqual(writes, [{ section: { default: { threshold: 0.8, retain: 0.16 } }, origin: 'composition' }]);
});
