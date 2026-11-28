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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
	parseSettingsDocument,
	patchFilePaths,
	readSection,
	resolveDshHome,
	settingsFilePath,
	watchPatchFile,
	watchSettingsFile,
} from '../lib/settings-file.js';

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

// ── DSH home resolution (2026-11-28, Windows desktop) ──────────────────────
//
// The Windows desktop host spawns dsh with neither `DSH_HOME` nor `HOME` set
// (Windows has no `HOME`; `USERPROFILE` is what `os.homedir()` reads) and
// `cwd = <home>/profiles/desktop`. Both readers used to derive the home from
// `env.DSH_HOME ?? join(env.HOME ?? '', '.dsh')`, which on that host is the
// *relative* path `.dsh` — resolved against the cwd it names a file that does
// not exist, and the engine silently ran on its built-in baseline. The host's
// own resolver (`@deepseek-ai/dsh-home-paths`) is `DSH_HOME` → `os.homedir()`,
// and these tests pin the same order.

test('without DSH_HOME or HOME the home is os.homedir()/.dsh, never a relative ".dsh"', () => {
	const home = resolveDshHome({ USERPROFILE: join(tmpdir(), 'cc-userprofile') });
	assert.equal(home, join(homedir(), '.dsh'), 'Windows has USERPROFILE, not HOME; os.homedir() reads it');
	assert.ok(isAbsolute(home), `${home} must be absolute: a relative home resolves against the cwd`);
	for (const file of patchFilePaths({ USERPROFILE: 'C:\\Users\\x' }, 'desktop')) {
		assert.ok(isAbsolute(file), `${file} must be absolute`);
		assert.ok(file.startsWith(join(homedir(), '.dsh', 'profiles') + sep), `${file} must sit under the real home`);
	}
	assert.ok(isAbsolute(settingsFilePath(resolveDshHome({}))));
});

test('a blank DSH_HOME counts as unset, as in dsh-home-paths', () => {
	assert.equal(resolveDshHome({ DSH_HOME: '   ', HOME: '/from/home' }), join(homedir(), '.dsh'));
});

test('a leading ~ in DSH_HOME expands against os.homedir()', () => {
	assert.equal(resolveDshHome({ DSH_HOME: '~/.dsh' }), join(homedir(), '.dsh'));
	assert.equal(patchFilePaths({ DSH_HOME: '~' }, 'desktop')[0], join(homedir(), 'profiles', 'desktop', 'cordis.patch.yml'));
});

test('the home the host reports outranks the environment', () => {
	// `ctx.profileContext.home` is the host's own answer (`resolveDshHome()`),
	// so a `--dsh-home` the launcher passed without exporting it still wins.
	assert.equal(resolveDshHome({ DSH_HOME: '/from/env' }, '/from/host'), resolve('/from/host'));
	assert.equal(patchFilePaths({ DSH_HOME: '/from/env' }, 'desktop', '/from/host')[0], resolve('/from/host', 'profiles', 'desktop', 'cordis.patch.yml'));
	assert.equal(resolveDshHome({ DSH_HOME: '  ' }, '  '), join(homedir(), '.dsh'), 'a blank host home is not an answer either');
});

test('watchPatchFile says once when no candidate file exists, then stops', async () => {
	// "Missing is the normal case for every candidate but one" — but missing
	// for *all* of them means the engine runs on the composition defaults, and
	// on 2026-11-28 that was exactly the silent failure: nothing was ever read.
	const dir = join(tmpdir(), `cc-missing-${process.pid}`);
	const files = [join(dir, 'desktop', 'cordis.patch.yml'), join(dir, 'web', 'cordis.patch.yml')];
	const missing = [];
	const configs = [];
	const stop = watchPatchFile({ files, intervalMs: 5, onConfig: (config) => configs.push(config), onMissing: (tried) => missing.push(tried) });
	try {
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(missing.length, 1, 'reported once, not once per poll');
		assert.deepEqual(missing[0], files, 'the warning names the paths that were tried');
		mkdirSync(dirname(files[0]), { recursive: true });
		writeFileSync(files[0], '- id: compaction-control-settings\n  config:\n    default:\n      threshold: 0.42\n');
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(configs.length, 1, 'a layer that appears later is still picked up');
		assert.equal(missing.length, 1, 'and does not re-report');
	} finally {
		stop();
	}
});

test('watchPatchFile stays quiet when a candidate exists but carries no entry', () => {
	// A profile may legitimately configure the policy elsewhere
	// (`settings.yaml`, or the composition); an existing file without this
	// plugin's entry is not a missing patch layer.
	const file = join(tmpdir(), `cc-no-entry-${process.pid}.yml`);
	writeFileSync(file, '- id: other-plugin\n  config:\n    a: 1\n');
	let missing = 0;
	const stop = watchPatchFile({ files: [file], intervalMs: 3600_000, onConfig: () => {}, onMissing: () => { missing += 1; } });
	stop();
	assert.equal(missing, 0);
});
