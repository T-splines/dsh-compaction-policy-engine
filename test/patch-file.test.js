/**
 * Tests for the profile-patch reader.
 *
 * The reader exists because a dsh that ships the profile importer renames
 * `settings.yaml` away at boot: the only file a person actually edits is
 * `cordis.patch.yml`, and nothing in dsh watches it. Without this reader an
 * edit to the threshold or the fallback chain reaches a running engine only
 * after a restart, which is exactly the bug it was written to end.
 *
 * The failure modes pinned here are the ones observed on the real file:
 * a commented-out mention of the entry id being mistaken for the entry, a
 * second entry with the same id being ignored, and a scalar sequence
 * (`- provider/model`) parsing as a list of empty objects.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { patchFilePaths, readPatchEntryConfig } from '../lib/settings-file.js';

/** A patch document shaped like the real one: prose, two entries, a chain. */
const PATCH = [
	'# Your patch layer for this dsh profile.',
	'#   `compaction-control-host` —— the preset realm cannot see agent/pre-step.',
	'- id: other-plugin',
	'  config:',
	'    providers:',
	'      gateway-a:',
	'        api: provider-e-completions',
	'- id: compaction-control-host',
	'  name: dsh-compaction-policy-engine/engine',
	'  config:',
	'    default:',
	'      # Example policy tuned for a small-window route.',
	'      threshold: 0.32',
	'      retain: 0.08',
	'      summarizationModel: gateway-a/model-c',
	'      summarizationFallback:',
	'        - gateway-a/model-b',
	'        - gateway-b/model-e',
	'        - gateway-a/model-f',
	'- id: compaction-control-host',
	'  name: dsh-compaction-policy-engine',
	'  config:',
	'    auto: false',
	'',
].join('\n');

test('a commented-out mention of the id is not an entry', () => {
	// The real file names `compaction-control-host` several times in prose. What
	// keeps those out is that `stripComment` strips from `#` onward, so a
	// commented line can never equal the header — not a separate guard, which
	// would be an unreachable branch.
	const withProseOnly = PATCH.replace(/- id: compaction-control-host\n/g, '# - id: compaction-control-host\n');
	assert.equal(readPatchEntryConfig(withProseOnly), undefined);

	// The sharper shape: a comment whose text, minus the `#`, is the header.
	const commentedHeader = [
		'# - id: compaction-control-host',
		'  config:',
		'    default:',
		'      threshold: 0.99',
		'',
	].join('\n');
	assert.equal(readPatchEntryConfig(commentedHeader), undefined, 'a commented header must not yield a config');
});

test('the chain is read as strings, not as a list of empty mappings', () => {
	// A `- provider/model` item is a scalar; treating every sequence item as a
	// mapping produced `[{}, {}, {}]`, which resolved to a chain of `undefined`.
	const config = readPatchEntryConfig(PATCH);
	assert.deepEqual(config.default.summarizationFallback, [
		'gateway-a/model-b',
		'gateway-b/model-e',
		'gateway-a/model-f',
	]);
});

test('every entry carrying the id is merged, later entries winning', () => {
	// One id legitimately appears twice: the host-plane mount and a preset-plane
	// mount, each restating only what differs. Returning the first match dropped
	// the chain whenever the first mount happened to omit it.
	const config = readPatchEntryConfig(PATCH);
	assert.equal(config.default.threshold, 0.32, 'the first entry states this');
	assert.equal(config.auto, false, 'the second entry states this');
	assert.equal(config.default.summarizationModel, 'gateway-a/model-c');
});

test('a later entry merges into the earlier default rather than replacing it', () => {
	// `{ default: { auto: false } }` must not erase `{ default: { threshold } }`.
	const config = readPatchEntryConfig(PATCH);
	assert.equal(typeof config.default, 'object');
	assert.equal(config.default.retain, 0.08);
});

test('an unrelated entry does not contribute config', () => {
	const config = readPatchEntryConfig(PATCH);
	assert.equal(config.providers, undefined, 'other-plugin providers must not leak in');
});

test('a missing entry yields undefined rather than a partial document', () => {
	assert.equal(readPatchEntryConfig('- id: something-else\n  config:\n    a: 1\n'), undefined);
});

test('patch paths never escape the redirected DSH_HOME', () => {
	// A test that redirects DSH_HOME must not have the real profile read into it;
	// a hardcoded absolute path outranked the redirect and replaced every fixture.
	const paths = patchFilePaths({ DSH_HOME: '/tmp/cc-home-probe', HOME: '/tmp/cc-home-probe' });
	assert.ok(paths.length > 0);
	for (const path of paths) {
		assert.ok(path.startsWith('/tmp/cc-home-probe/'), `${path} escaped the redirect`);
	}
});

test('a named profile is tried before the default one', () => {
	const paths = patchFilePaths({ DSH_HOME: '/tmp/cc-home-probe', DSH_PROFILE: 'dev' });
	assert.equal(paths[0], '/tmp/cc-home-probe/profiles/dev/cordis.patch.yml');
	assert.ok(paths.includes('/tmp/cc-home-probe/profiles/web/cordis.patch.yml'));
});

test('the settings-plane entry wins even when the host entry appears first', () => {
	const text = [
		'- id: compaction-control-host',
		'  config:',
		'    default:',
		'      threshold: 0.32',
		'- id: compaction-control-settings',
		'  config:',
		'    default:',
		'      threshold: 0.8',
		'',
	].join('\n');
	const config = readPatchEntryConfig(text);
	assert.equal(config.default.threshold, 0.8);
});

test('the host entry is used when the settings entry is absent', () => {
	const text = [
		'- id: compaction-control-host',
		'  config:',
		'    default:',
		'      threshold: 0.32',
		'',
	].join('\n');
	const config = readPatchEntryConfig(text);
	assert.equal(config.default.threshold, 0.32);
});

test('neither candidate entry yields undefined', () => {
	const text = '- id: compaction-control\n  config:\n    default:\n      threshold: 0.8\n';
	assert.equal(readPatchEntryConfig(text), undefined);
});