/**
 * Tests for the one prompt section this plugin registers.
 *
 * Why the plugin owns a prompt rule at all: measured on 2026-10-04 across two
 * long sessions, the model announces that its context is nearly exhausted — and
 * defers work on that basis — while the session is still far below the
 * configured gate. It first said so *before* any compaction had ever fired (seq
 * 969 and 1209 of its session), nothing in the harness reports context usage to
 * it, and no other prompt corrected it. Compaction is automatic, so the rule is
 * declared here, next to the engine that makes it true.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the settings-file reader off the real `settings.yaml`.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cc-prompt-test-'));

import { CONTEXT_POLICY_SECTION, CONTEXT_POLICY_TEXT, CompactionControlSettings } from '../lib/index.js';

test('the companion registers the standing automatic-compaction rule', () => {
	const sections = [];
	const ctx = {
		inject(services, callback) {
			if (!services.includes('systemPrompt')) return;
			callback({ systemPrompt: { section: (section) => sections.push(section) } });
		},
	};
	new CompactionControlSettings(ctx, { default: { threshold: 0.6 } });
	assert.equal(sections.length, 1, 'exactly one section, registered once');
	assert.equal(sections[0].name, CONTEXT_POLICY_SECTION);
	assert.equal(sections[0].order, 100, 'placed right after the deployment persona prefix');
	assert.equal(sections[0].text, CONTEXT_POLICY_TEXT);
	// The rule must actually forbid the observed behaviour, not merely mention it.
	assert.match(sections[0].text, /never stop, shorten, defer, or hand off work/i);
	assert.match(sections[0].text, /cannot measure your own context usage/i);
});

test('the companion stays loadable with no system-prompt service', () => {
	assert.doesNotThrow(() => new CompactionControlSettings({ inject() {} }, { default: { threshold: 0.6 } }));
});
