/**
 * Policy resolution tests.
 *
 * These cover the precedence rules and the validation failures that an operator
 * is most likely to hit. They are deliberately independent of Cordis, sessions,
 * and the LLM: policy resolution is pure, so every rule is checkable directly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	AUTO,
	CompactionConfigError,
	DEFAULT_MAX_TOKENS,
	DEFAULT_RETAIN_RATIO,
	DEFAULT_THRESHOLD_RATIO,
	MIN_COMPACT_GAP_TOKENS,
	overlayDocument,
	pickThinkingOff,
	resolveConfig,
	resolvePolicy,
	resolveSummarizationEffort,
	toBasicConfig,
} from '../lib/policy.js';

const TARGET = { provider: 'gateway-b', model: 'model-d' };

test('an empty config yields the documented defaults', () => {
	const policy = resolvePolicy(resolveConfig(), TARGET);
	assert.equal(policy.thresholdRatio, DEFAULT_THRESHOLD_RATIO);
	assert.equal(policy.retainRatio, DEFAULT_RETAIN_RATIO);
	assert.equal(policy.maxTokens, DEFAULT_MAX_TOKENS);
	assert.equal(policy.summarizationModel, AUTO);
	assert.equal(policy.summarizationTarget, undefined);
});

test('the global default layer applies to every target', () => {
	const config = resolveConfig({ default: { threshold: 0.5, summarizationModel: 'local/model-g' } });
	const policy = resolvePolicy(config, TARGET);
	assert.equal(policy.thresholdRatio, 0.5);
	assert.deepEqual(policy.summarizationTarget, { provider: 'local', model: 'model-g' });
});

test('a provider layer overrides the default for every model on that route', () => {
	const config = resolveConfig({
		default: { threshold: 0.8 },
		providers: { 'gateway-b': { threshold: 0.6 } },
	});
	assert.equal(resolvePolicy(config, TARGET).thresholdRatio, 0.6);
	assert.equal(
		resolvePolicy(config, { provider: 'gateway-b', model: 'anything-else' }).thresholdRatio,
		0.6,
		'the route layer covers models it never named',
	);
	assert.equal(
		resolvePolicy(config, { provider: 'other', model: 'x' }).thresholdRatio,
		0.8,
		'an unrelated route falls through to the default',
	);
});

test('an exact model override beats the provider layer', () => {
	const config = resolveConfig({
		default: { threshold: 0.8 },
		providers: { 'gateway-b': { threshold: 0.6 } },
		models: [{ provider: 'gateway-b', model: 'model-d', threshold: 0.45 }],
	});
	assert.equal(resolvePolicy(config, TARGET).thresholdRatio, 0.45);
	assert.equal(
		resolvePolicy(config, { provider: 'gateway-b', model: 'other' }).thresholdRatio,
		0.6,
		'a sibling model still gets the route layer',
	);
});

test('each field resolves independently across layers', () => {
	// The override narrows the threshold only; its summarization model must come
	// from the route layer, not from the global default.
	const config = resolveConfig({
		default: { threshold: 0.8, summarizationModel: 'local/default-model' },
		providers: { 'gateway-b': { summarizationModel: 'local/route-model' } },
		models: [{ provider: 'gateway-b', model: 'model-d', threshold: 0.45 }],
	});
	const policy = resolvePolicy(config, TARGET);
	assert.equal(policy.thresholdRatio, 0.45, 'threshold from the model override');
	assert.deepEqual(
		policy.summarizationTarget,
		{ provider: 'local', model: 'route-model' },
		'summarization model from the route layer, not the default',
	);
});

test('auto is the default summarization model and survives an explicit route layer', () => {
	const config = resolveConfig({ providers: { 'gateway-b': { summarizationModel: AUTO, threshold: 0.5 } } });
	const policy = resolvePolicy(config, TARGET);
	assert.equal(policy.summarizationModel, AUTO);
	assert.equal(policy.summarizationTarget, undefined, 'auto means "let the engine inherit the conversation model"');
});

test('auto keeps an empty summarization target in the parent config shape', () => {
	const policy = resolvePolicy(resolveConfig(), TARGET);
	const basic = toBasicConfig(policy);
	assert.equal(basic.summarizationProvider, '');
	assert.equal(basic.summarizationModel, '');
});

test('an explicit summarization model is split into the parent config shape', () => {
	const policy = resolvePolicy(
		resolveConfig({ default: { summarizationModel: 'local/model-g' } }),
		TARGET,
	);
	const basic = toBasicConfig(policy);
	assert.equal(basic.summarizationProvider, 'local');
	assert.equal(basic.summarizationModel, 'model-g');
});

test('an explicit primary repeated in the fallback chain is removed and reported', () => {
	const config = resolveConfig({
		default: {
			summarizationModel: 'local/model-g',
			summarizationFallback: ['provider-d/model-s', 'local/model-g', 'provider-e/model-t'],
		},
	});
	const policy = resolvePolicy(config, TARGET);
	assert.deepEqual(policy.summarizationFallback, [
		{ provider: 'provider-d', model: 'model-s' },
		{ provider: 'provider-e', model: 'model-t' },
	]);
	assert.equal(policy.warnings.length, 1);
	assert.match(
		policy.warnings[0],
		/summarizationFallback\[1\] \(local\/model-g\) is the primary summarization route; it was skipped/,
	);
});

test('an auto primary matching the conversation route is removed and reported', () => {
	const policy = resolvePolicy(
		resolveConfig({
			default: {
				summarizationModel: AUTO,
				summarizationFallback: [`${TARGET.provider}/${TARGET.model}`],
			},
		}),
		TARGET,
	);
	assert.deepEqual(policy.summarizationFallback, []);
	assert.equal(policy.warnings.length, 1);
	assert.match(
		policy.warnings[0],
		/summarizationFallback\[0\] \(gateway-b\/model-d\) is the primary summarization route; it was skipped/,
	);
});

test('a fallback chain without the primary is kept unchanged and adds no warning', () => {
	const config = resolveConfig({
		default: {
			summarizationModel: 'local/model-g',
			summarizationFallback: ['provider-d/model-s', 'provider-e/model-t'],
		},
	});
	const policy = resolvePolicy(config, TARGET);
	assert.deepEqual(policy.summarizationFallback, [
		{ provider: 'provider-d', model: 'model-s' },
		{ provider: 'provider-e', model: 'model-t' },
	]);
	assert.deepEqual(policy.warnings, []);
});

test('the resolved policy is frozen', () => {
	const policy = resolvePolicy(resolveConfig(), TARGET);
	assert.ok(Object.isFrozen(policy));
	assert.throws(() => {
		'use strict';
		policy.thresholdRatio = 0.1;
	});
});

test('a threshold at or above 1 is rejected, naming the token form instead', () => {
	assert.throws(
		() => resolveConfig({ default: { threshold: 1 } }),
		(err) =>
			err instanceof CompactionConfigError &&
			/less than 1/.test(err.message) &&
			/thresholdTokens: 1/.test(err.message),
	);
	assert.throws(() => resolveConfig({ default: { threshold: 200000 } }), CompactionConfigError);
	assert.throws(() => resolveConfig({ default: { threshold: 0 } }), CompactionConfigError);
	assert.throws(() => resolveConfig({ default: { threshold: -0.5 } }), CompactionConfigError);
});

test('retain must stay below the threshold it is compared against', () => {
	// A single layer can state both, but the comparison is only meaningful once
	// merged, so it is enforced at resolve time rather than load time.
	const equal = resolveConfig({ default: { threshold: 0.2, retain: 0.2 } });
	assert.throws(() => resolvePolicy(equal, TARGET), /retain .* must be less than threshold/);

	const inverted = resolveConfig({ default: { threshold: 0.3, retain: 0.5 } });
	assert.throws(() => resolvePolicy(inverted, TARGET), CompactionConfigError);
});

test('each ratio is individually range-checked at load time', () => {
	assert.throws(() => resolveConfig({ default: { retain: 1.5 } }), /retain must be greater than 0 and less than 1/);
	assert.throws(() => resolveConfig({ default: { retain: 0 } }), CompactionConfigError);
});

test('retain is checked against the override threshold, not the global one', () => {
	// Global retain 0.5 is fine under the global threshold 0.8, but the override
	// lowers the threshold to 0.4, so the inherited retain becomes invalid.
	const config = resolveConfig({
		default: { threshold: 0.8, retain: 0.5 },
		models: [{ provider: 'gateway-b', model: 'model-d', threshold: 0.4 }],
	});
	assert.throws(() => resolvePolicy(config, TARGET), CompactionConfigError);
});

test('unknown fields are rejected rather than silently ignored', () => {
	assert.throws(() => resolveConfig({ defaults: {} }), /unknown top-level field "defaults"/);
	assert.throws(() => resolveConfig({ default: { thresholds: 0.5 } }), /unknown field "thresholds"/);
	assert.throws(
		() => resolveConfig({ models: [{ provider: 'p', model: 'm', thresold: 0.5 }] }),
		/unknown field "thresold"/,
	);
});

test('a malformed summarization model reference is rejected', () => {
	assert.throws(() => resolveConfig({ default: { summarizationModel: 'justamodel' } }), /provider\/model/);
	assert.throws(() => resolveConfig({ default: { summarizationModel: '/model' } }), /provider\/model/);
	assert.throws(() => resolveConfig({ default: { summarizationModel: 'provider/' } }), /provider\/model/);
	assert.throws(() => resolveConfig({ default: { summarizationModel: '' } }), CompactionConfigError);
});

test('the thinking-off level is matched against what a route declares', () => {
	// The id is adapter-owned, so the policy matches declarations rather than
	// trusting a literal: DeepSeek names it `off`, a minimal-only route has no
	// equivalent, and an empty declaration means the model cannot think at all.
	assert.equal(pickThinkingOff([{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }]), 'off');
	assert.equal(pickThinkingOff([{ id: 'none', name: 'None' }]), 'none', 'alias form');
	// `minimal` is provider-d's cheapest *thinking* level, not an off switch.
	assert.equal(pickThinkingOff([{ id: 'minimal', name: 'Minimal' }, { id: 'high', name: 'High' }]), undefined);
	assert.equal(pickThinkingOff([{ id: 'low', name: 'Low' }]), undefined, 'no off-equivalent is not guessed');
	assert.equal(pickThinkingOff([]), undefined);
	assert.equal(pickThinkingOff(undefined), undefined);

	// The field is gone from the policy vocabulary: the engine decides this, not
	// the operator, and a stale settings section naming it must now fail loud.
	assert.throws(
		() => resolveConfig({ default: { summarizationReasoningEffort: 'high' } }),
		/unknown field "summarizationReasoningEffort"/,
	);
});

// ── what the summarization call can be told about thinking ──────────────────

test('a route declaring an off level resolves to that level as the control', () => {
	// The normal case, and the one that must stay silent-and-correct: the route
	// offers an off switch, so the summarization call is told not to think.
	assert.deepEqual(resolveSummarizationEffort({ reasoning: { efforts: [{ id: 'off', name: 'Off' }] } }), {
		effort: 'off',
		control: 'off',
		offered: ['off'],
	});
	// The off level need not be the first one declared.
	assert.deepEqual(
		resolveSummarizationEffort({ reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'off', name: 'Off' }] } }),
		{ effort: 'off', control: 'off', offered: ['high', 'off'] },
	);
});

test('every off alias resolves as the control, under its own id', () => {
	// The id is adapter-owned and the request names it verbatim, so the alias that
	// matched is what comes back — `none` is sent as `none`, never rewritten to
	// `off`, which the route might not declare.
	for (const [id, alias] of [
		['off', 'off'],
		['none', 'none'],
		['disabled', 'disabled'],
		['no-thinking', 'no-thinking'],
		['nothinking', 'nothinking'],
	]) {
		const resolved = resolveSummarizationEffort({ reasoning: { efforts: [{ id, name: alias }] } });
		assert.equal(resolved.effort, id, `the declared id is the one sent`);
		assert.equal(resolved.control, 'off');
		assert.deepEqual(resolved.offered, [id]);
	}
	// Match order is the alias list's, not the declaration's: with both present the
	// earlier alias wins, so the choice is stable however the adapter orders them.
	// (`pickThinkingOff` is the shared matcher, so this pins its order rather than
	// a second copy of it.)
	const both = resolveSummarizationEffort({
		reasoning: { efforts: [{ id: 'disabled', name: 'Disabled' }, { id: 'off', name: 'Off' }] },
	});
	assert.equal(both.effort, 'off', '`off` precedes `disabled` in the alias list');
	assert.equal(both.control, 'off');
});

test('a route that declares levels but no off switch cannot be told not to think', () => {
	// The failure this diagnostic exists for: the route *can* think and offers no
	// switch to stop it, so the summarization call goes out with no thinking
	// control and the provider reasons at its own default inside the cap.
	const resolved = resolveSummarizationEffort({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } });
	assert.deepEqual(resolved, {
		effort: undefined,
		control: 'no-off-level',
		offered: ['low', 'high'],
	});
	// `minimal` is the cheapest *thinking* level, not an off switch.
	assert.equal(
		resolveSummarizationEffort({ reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }] } }).control,
		'no-off-level',
	);
	// The declaration's order is reported, because that is the order an operator
	// reads it in.
	assert.deepEqual(
		resolveSummarizationEffort({ reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }).offered,
		['high', 'low'],
	);
});

test('a route with no reasoning capability resolves as such, in every shape it arrives', () => {
	// A hand-declared model with `reasoningEfforts` omitted, or with it `false`,
	// is treated as non-reasoning by the adapter — which then skips every
	// thinking-control branch, off included. All of these are the same answer:
	// there is nothing to send and nothing to select.
	for (const [label, info] of [
		['reasoning missing', {}],
		['reasoning null', { reasoning: null }],
		['reasoning false', { reasoning: false }],
		['efforts missing', { reasoning: {} }],
		['efforts null', { reasoning: { efforts: null } }],
		['efforts undefined', { reasoning: { efforts: undefined } }],
		['efforts empty', { reasoning: { efforts: [] } }],
	]) {
		assert.deepEqual(resolveSummarizationEffort(info), {
			effort: undefined,
			control: 'no-reasoning',
			offered: [],
		}, label);
	}
});

test('an unreadable model resolves as unknown rather than throwing', () => {
	// `resolveModelInfo` answered with nothing at all. Guessing `no-reasoning` here
	// would assert a capability fact the lookup failed to establish, and the two
	// need different operator responses.
	assert.deepEqual(resolveSummarizationEffort(undefined), {
		effort: undefined,
		control: 'unknown',
		offered: [],
	});
	assert.deepEqual(resolveSummarizationEffort(null), {
		effort: undefined,
		control: 'unknown',
		offered: [],
	});
});

test('a malformed declaration never throws and still reports what it declared', () => {
	// A hand-written model entry is not schema-checked by the adapter, so the
	// resolver has to survive whatever shape arrives — a throw here would take the
	// summarization call down with it.
	assert.deepEqual(resolveSummarizationEffort({ reasoning: { efforts: [{ id: 'off' }, null, {}] } }), {
		effort: 'off',
		control: 'off',
		offered: ['off'],
	});
	assert.deepEqual(resolveSummarizationEffort({ reasoning: { efforts: [null, {}] } }), {
		effort: undefined,
		control: 'no-off-level',
		offered: [],
	});
	assert.deepEqual(resolveSummarizationEffort('garbage'), {
		effort: undefined,
		control: 'no-reasoning',
		offered: [],
	});
	assert.doesNotThrow(() => resolveSummarizationEffort());
});

test('duplicate model overrides for one target are rejected', () => {
	assert.throws(
		() =>
			resolveConfig({
				models: [
					{ provider: 'p', model: 'm', threshold: 0.5 },
					{ provider: 'p', model: 'm', threshold: 0.6 },
				],
			}),
		/duplicate override for p\/m/,
	);
});

test('a model override entry must name both provider and model', () => {
	assert.throws(() => resolveConfig({ models: [{ model: 'm' }] }), /provider must be a non-empty string/);
	assert.throws(() => resolveConfig({ models: [{ provider: 'p' }] }), /model must be a non-empty string/);
});

test('integer fields are validated', () => {
	assert.throws(() => resolveConfig({ default: { maxTokens: 0 } }), /maxTokens must be a positive integer/);
	assert.throws(() => resolveConfig({ default: { maxTokens: 1.5 } }), /maxTokens must be a positive integer/);
	assert.throws(
		() => resolveConfig({ default: { compactionRetries: -1 } }),
		/compactionRetries must be a non-negative integer/,
	);
	assert.doesNotThrow(() => resolveConfig({ default: { compactionRetries: 0, maxOverflowRetries: 0 } }));
});

test('auto may be disabled to turn off automatic compaction entirely', () => {
	assert.equal(resolveConfig({ auto: false }).auto, false);
	assert.equal(resolveConfig({}).auto, true, 'automatic compaction is on by default');
	assert.throws(() => resolveConfig({ auto: 'yes' }), /auto must be a boolean/);
});

test('a providers layer must be a mapping', () => {
	assert.throws(() => resolveConfig({ providers: [] }), /providers must be a mapping/);
	assert.throws(() => resolveConfig({ models: {} }), /models must be a list/);
});

// ── absolute token budgets (the second input unit) ─────────────────────────

test('an absolute threshold is converted through the declared window', () => {
	const config = resolveConfig({ default: { thresholdTokens: 200_000, retainTokens: 80_000 } });
	const policy = resolvePolicy(config, TARGET, 1_000_000);
	assert.equal(policy.thresholdRatio, 0.2);
	assert.equal(policy.retainRatio, 0.08);
	assert.equal(policy.thresholdTokens, 200_000);
	assert.equal(policy.retainTokens, 80_000);
	assert.deepEqual(policy.absolute, { threshold: true, retain: true });
	assert.deepEqual(policy.deferred, []);
	assert.deepEqual(policy.source.threshold, { layer: 'default', unit: 'tokens' });
});

test('the same absolute budget means different ratios on different windows', () => {
	// This is the whole reason the token form exists: "keep the last 80k" is one
	// number, and the share of the window it occupies is not.
	const config = resolveConfig({ default: { thresholdTokens: 100_000, retainTokens: 80_000 } });
	assert.equal(resolvePolicy(config, TARGET, 1_000_000).thresholdRatio, 0.1);
	assert.equal(resolvePolicy(config, TARGET, 256_000).thresholdRatio, 100_000 / 256_000);
	assert.equal(resolvePolicy(config, TARGET, 256_000).retainTokens, 80_000);
});

test('an absolute retention reaches the parent as tokens, a ratio one as a ratio', () => {
	const absolute = toBasicConfig(
		resolvePolicy(resolveConfig({ default: { thresholdTokens: 200_000, retainTokens: 80_000 } }), TARGET, 1_000_000),
	);
	assert.equal(absolute.retainTokens, 80_000);
	assert.equal('retainRatio' in absolute, false, 'the parent rejects both units at once');

	const ratio = toBasicConfig(resolvePolicy(resolveConfig({ default: { threshold: 0.2, retain: 0.08 } }), TARGET));
	assert.equal(ratio.retainRatio, 0.08);
	assert.equal('retainTokens' in ratio, false);
});

test('the converted threshold ratio floors back to the declared token count', () => {
	// The parent recomputes `floor(window * thresholdRatio)`. A 512k window and a
	// 123456-token budget is not exactly representable, and a naive `tokens /
	// window` can land one token short — which would also be one token nearer an
	// absolute retention the parent refuses to cross.
	const config = resolveConfig({ default: { thresholdTokens: 123_456, retainTokens: 100_000 } });
	for (const window of [1_000_000, 512_000, 262_144, 200_000, 131_072]) {
		const basic = toBasicConfig(resolvePolicy(config, TARGET, window));
		assert.equal(Math.floor(window * basic.thresholdRatio), 123_456, `window ${window}`);
		assert.ok(basic.retainTokens < Math.floor(window * basic.thresholdRatio), `ordering holds at ${window}`);
	}
});

test('a higher layer stating the token form wins outright, per field', () => {
	const config = resolveConfig({
		default: { threshold: 0.8, retain: 0.16 },
		providers: { 'gateway-b': { retainTokens: 80_000 } },
		models: [{ provider: 'gateway-b', model: 'model-d', thresholdTokens: 400_000 }],
	});
	const policy = resolvePolicy(config, TARGET, 1_000_000);
	assert.equal(policy.thresholdRatio, 0.4, 'the model override states tokens and wins');
	assert.equal(policy.retainTokens, 80_000, 'the provider layer states tokens and wins');
	assert.equal(policy.maxTokens, DEFAULT_MAX_TOKENS, 'unstated fields still fall through');
	assert.deepEqual(
		{ t: policy.source.threshold, r: policy.source.retain },
		{ t: { layer: 'model', unit: 'tokens' }, r: { layer: 'provider', unit: 'tokens' } },
	);
});

test('a route-level token budget covers models the route never names', () => {
	const config = resolveConfig({ providers: { 'gateway-b': { thresholdTokens: 300_000, retainTokens: 100_000 } } });
	assert.equal(resolvePolicy(config, { provider: 'gateway-b', model: 'anything' }, 1_000_000).thresholdTokens, 300_000);
	assert.equal(resolvePolicy(config, { provider: 'other', model: 'x' }, 1_000_000).thresholdRatio, DEFAULT_THRESHOLD_RATIO);
});

test('a layer stating one field in both units keeps the token form and reports the ratio it shadowed', () => {
	// The settings service resolves `merge(base, user)`, so this is the shape a
	// panel-saved token budget takes whenever the composition base declares a
	// ratio. Rejecting the document would freeze the engine on the previous
	// policy and make the saved value look ignored, which is precisely the bug.
	const config = resolveConfig({ default: { threshold: 0.2, thresholdTokens: 200_000 } });
	const policy = resolvePolicy(config, TARGET, 1_000_000);
	assert.equal(policy.thresholdTokens, 200_000, 'the absolute form is the effective one');
	assert.equal(policy.thresholdRatio, 200_000 / 1_000_000);
	assert.equal(policy.source.threshold.unit, 'tokens');
	assert.match(policy.warnings.join('\n'), /default: thresholdTokens \(200000\) wins over threshold \(0\.2\)/);

	// Same rule per field and in every layer kind.
	const model = resolvePolicy(
		resolveConfig({ models: [{ provider: 'p', model: 'm', retain: 0.1, retainTokens: 1000 }] }),
		{ provider: 'p', model: 'm' },
		1_000_000,
	);
	assert.equal(model.retainTokens, 1000);
	assert.match(model.warnings.join('\n'), /model: retainTokens \(1000\) wins over retain \(0\.1\)/);

	// A lone ratio is still validated, and a lone token count still has to be a
	// whole positive number: only the *shadowed* declaration is excused.
	assert.throws(() => resolveConfig({ default: { threshold: 5 } }), /greater than 0 and less than 1/);
	assert.throws(() => resolveConfig({ default: { thresholdTokens: 1.5 } }), /positive whole number/);
	// A garbage ratio beside a valid token count is ignored, not fatal.
	assert.equal(resolvePolicy(resolveConfig({ default: { threshold: 5, thresholdTokens: 200_000 } }), TARGET, 1_000_000).thresholdTokens, 200_000);
});

test('token budgets are whole positive numbers', () => {
	assert.throws(() => resolveConfig({ default: { thresholdTokens: 0 } }), /positive whole number of tokens/);
	assert.throws(() => resolveConfig({ default: { thresholdTokens: 1.5 } }), /positive whole number/);
	assert.throws(() => resolveConfig({ default: { retainTokens: -1 } }), /positive whole number/);
	assert.doesNotThrow(() => resolveConfig({ default: { thresholdTokens: 1 } }));
});

test('a token budget with no declared window is deferred, not guessed', () => {
	const config = resolveConfig({ default: { thresholdTokens: 200_000 } });
	const policy = resolvePolicy(config, TARGET);
	assert.deepEqual(policy.deferred, ['thresholdTokens']);
	assert.equal(policy.thresholdTokens, undefined);
	assert.equal(policy.thresholdRatio, DEFAULT_THRESHOLD_RATIO, 'the fallback keeps construction working');
	assert.deepEqual(policy.warnings, [], 'no window means no headroom arithmetic to report');

	// The deferred name is what the engine turns into an actionable refusal.
	const both = resolvePolicy(resolveConfig({ default: { thresholdTokens: 1, retainTokens: 1 } }), TARGET);
	assert.deepEqual(both.deferred, ['thresholdTokens', 'retainTokens']);
});

test('the ordering check uses tokens when the window is known', () => {
	// 25% under an 80% threshold is valid as ratios, but the absolute retention
	// the route inherits is above it once the window is applied.
	const config = resolveConfig({ default: { threshold: 0.25, retainTokens: 300_000 } });
	assert.throws(() => resolvePolicy(config, TARGET, 1_000_000), /retain .* must be less than threshold/);
	assert.doesNotThrow(() => resolvePolicy(config, TARGET, 2_000_000), 'the same pair is valid on a 2M window');
});

test('a policy with too little room for a summary is reported as unworkable', () => {
	// The production failure this guardrail exists for: a 0.015/0.012 pair left a
	// ~1.5k-token gap, the summarizer produced a ~3.2k-token checkpoint, and the
	// parent refused it — firing the gate again on every subsequent step.
	const tight = resolvePolicy(resolveConfig({ default: { threshold: 0.015, retain: 0.012 } }), TARGET, 1_000_000);
	assert.equal(tight.warnings.length, 1);
	assert.match(tight.warnings[0], /below the 8192-token minimum/);
	assert.ok(MIN_COMPACT_GAP_TOKENS > 3200, 'the floor must exceed the observed checkpoint size');

	const roomy = resolvePolicy(resolveConfig({ default: { threshold: 0.2, retain: 0.08 } }), TARGET, 1_000_000);
	assert.deepEqual(roomy.warnings, []);
});
test('overlaying the operator section keeps the layers it does not restate', () => {
	// The rule the engine's direct file read has to reproduce from `ctx.settings`:
	// a section is a *partial* document. Replacing instead of overlaying is how a
	// profile's per-model row disappeared the first time somebody saved the panel.
	const base = {
		auto: true,
		default: { threshold: 0.8, retain: 0.16 },
		providers: { 'gateway-b': { threshold: 0.5 } },
		models: [{ provider: 'local', model: 'model-x', threshold: 0.9 }],
	};
	const merged = overlayDocument(base, { default: { threshold: 0.2 } });
	assert.deepEqual(merged, {
		auto: true,
		default: { threshold: 0.2, retain: 0.16 },
		providers: { 'gateway-b': { threshold: 0.5 } },
		models: [{ provider: 'local', model: 'model-x', threshold: 0.9 }],
	});
	// Neither input is touched: the composition document is reused on every reload.
	assert.equal(base.default.threshold, 0.8);
	assert.equal(merged.default.retain, 0.16);
});

test('overlaying replaces a list rather than extending it, as the settings provider does', () => {
	// The provider replaces arrays, so a user who writes one model row owns the
	// whole list. Concatenating here would make the engine apply rows the panel
	// never showed them.
	const base = { models: [{ provider: 'a', model: 'b', threshold: 0.9 }] };
	const merged = overlayDocument(base, { models: [{ provider: 'c', model: 'd', threshold: 0.3 }] });
	assert.deepEqual(merged.models, [{ provider: 'c', model: 'd', threshold: 0.3 }]);
	// An explicit `undefined` in the section keeps the base value, as upstream.
	assert.equal(overlayDocument({ default: { retain: 0.16 } }, { default: { retain: undefined } }).default.retain, 0.16);
	assert.equal(overlayDocument({ auto: true }, undefined).auto, true);
});
