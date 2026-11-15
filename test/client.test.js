/**
 * Render-level tests for the browser half.
 *
 * `client.js` is a hand-written bundle: `dsh-client-modules` serves its bytes
 * and never transpiles, and its factory is invoked with a `require` built from
 * the platform seed table. Nothing in a normal test run touches that factory, so
 * a typo in the badge — a wrong prop name, a missing translation key, an
 * `inject` face the renderer cannot bind — would reach the user as "the card
 * silently does not render".
 *
 * This file boots the factory against a minimal `window.__ModuleLoader__` shim,
 * a React stub whose hooks are synchronous, and a JSX-runtime stub that builds a
 * plain tree. That is not a DOM test; it is enough to prove the bundle
 * evaluates, both slots register, the session-scoped `inject` face is shaped the
 * way `dsh-client-ui-renderer` binds it, and the badge's tree carries the
 * numbers the policy actually resolved.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PATCH_ENTRY_IDS } from '../lib/settings-file.js';

const CLIENT_ENTRY = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * Collect every string in a rendered JSX-runtime tree.
 * @param node - a `{ type, props }` tree, an array, or a leaf.
 * @param out - accumulator.
 * @returns the accumulated strings.
 */
function textsOf(node, out = []) {
	if (node === null || node === undefined || typeof node === 'boolean') return out;
	if (typeof node === 'string' || typeof node === 'number') {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) textsOf(child, out);
		return out;
	}
	if (typeof node === 'object' && node.props !== undefined) textsOf(node.props.children, out);
	return out;
}

/** Join every string in a tree for substring assertions. */
function text(node) {
	return textsOf(node).join('\n');
}

/**
 * A stand-in for the session's `MutableSessionEventSource`.
 *
 * The real class publishes synchronously on every accepted window mutation, and
 * the badge subscribes to exactly that, so the double keeps the same contract: a
 * mutable entry list, a `getSnapshot()` answering the current window, and a
 * `subscribe()` whose listeners fire on every mutation. A test then drives the
 * window the way the host does — by appending an entry.
 *
 * @param entries - the window's initial entries.
 * @returns the event-source double, exposing `append` for the test.
 */
function makeEventSource(entries = []) {
	const listeners = new Set();
	const source = {
		entries,
		getSnapshot: () => ({ entries: source.entries, hasMore: false, revision: source.entries.length }),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Append one entry and publish, as the host does for a live tail row. */
		append: (entry) => {
			source.entries = [...source.entries, entry];
			for (const listener of listeners) listener();
		},
	};
	return source;
}

/**
 * One `compaction/summary` entry as the host writes it.
 *
 * @param data - payload overrides; `provider`/`model` name the route that
 * actually produced the summary.
 * @returns a durable window entry.
 */
function summaryEntry(data = {}) {
	return {
		type: 'event',
		event: {
			type: 'compaction/summary',
			seq: 6808,
			time: 1_760_000_000_000,
			data: {
				compactionId: 'a3bc7f2b-f338-4b03-9f74-7f0097be0b42',
				summary: [{ type: 'text', text: 'compressed' }],
				shadowedRange: { start: 6664, end: 6798 },
				shadowedSeqs: Array.from({ length: 85 }, (unused, index) => index),
				shadowedTokenCount: 55_367,
				provider: 'gateway-a',
				model: 'model-b',
				maxTokens: 8192,
				usage: { inputTokens: 75_495, outputTokens: 5060, totalTokens: 80_555 },
				...data,
			},
		},
	};
}

/**
 * Evaluate the client bundle and capture its registrations.
 *
 * @param options - `policy` is the settings snapshot the badge reads;
 * `pressure`/`modelSelection` are the projections a session reports;
 * `eventSource` is the session's event window; `clickBadge` seeds the badge's
 * open state so the panel is inspected too.
 * @returns the recorded slot registrations, the module exports, and the render
 * helper.
 */
async function bootClient(options = {}) {
	const source = await readFile(CLIENT_ENTRY, 'utf8');

	const Fragment = Symbol('Fragment');
	// No React runtime here: hooks are a per-render cell array, and a queued
	// state update re-renders once and returns the *settled* tree.
	let cells = [];
	let cursor = 0;
	/**
	 * Updates queued since the last render, in order.
	 *
	 * A list rather than a single slot: one event handler routinely queues
	 * several (`selectLayer` clears the draft, the error, *and* moves the layer),
	 * and React applies all of them. Keeping only the last would make the
	 * harness disagree with the browser exactly where a multi-state handler is
	 * the interesting case.
	 */
	let queued = [];
	/**
	 * Effects recorded by the last committed render pass.
	 *
	 * React runs them after mount; this harness does not, because every existing
	 * test asserts a tree that a mount-time subscription would not change. They
	 * are collected instead so a test that *is* about a subscription — the
	 * badge's live read of the session's event window — can run them on demand
	 * with `runEffects`.
	 */
	let effects = [];
	const hooks = {
		useState: (initial) => {
			const index = cursor++;
			if (cells[index] === undefined) {
				const seed =
					options.clickBadge === true && index === 0
						? true
						: typeof initial === 'function'
							? initial()
							: initial;
				cells[index] = [seed, undefined];
			}
			if (cells[index][1] === undefined) {
				cells[index][1] = (next) => {
					queued.push({ index, next });
				};
			}
			return cells[index];
		},
		useEffect: (factory) => {
			effects.push(factory);
		},
		useRef: () => {
			const index = cursor++;
			if (cells[index] === undefined) cells[index] = [{ current: null }];
			return cells[index][0];
		},
	};
	/** JSX-runtime stub: enough for this bundle, which renders only host nodes. */
	const react = {
		Fragment,
		createElement: (type, props, ...children) => ({
			type,
			props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
		}),
		useState: hooks.useState,
		useEffect: hooks.useEffect,
		useRef: hooks.useRef,
	};
	const jsx = (type, props) => ({ type, props: props ?? {} });
	const reactJsxRuntime = { jsx, jsxs: jsx, Fragment };

	/**
	 * Emulate `dsh-client-ui-renderer`'s standard-source binding.
	 *
	 * The renderer renames `hooks.X` / `keyedHooks.X` to `use<X>` and wraps each
	 * source as a React hook; the plugin's own pre-bound `usePolicy` arrives the
	 * same way. Reproducing that here means the test calls the component with the
	 * exact prop names the browser supplies.
	 *
	 * @param face - the `inject()` return value.
	 * @returns props ready for the component.
	 */
	const bindFace = (face) => {
		const { hooks: plain, keyedHooks: keyed, ...rest } = face;
		const bound = { ...rest };
		const wrap = (source) => (select) => {
			const read = () => {
				const snapshot = typeof source === 'function' ? source(select) : source.getSnapshot?.();
				return typeof select === 'function' ? snapshot : select === undefined ? snapshot : undefined;
			};
			// The value is recomputed on every render instead of being seeded once.
			// `read()` can itself call hooks — the badge's inject face implements
			// `usePolicy` as a hook of its own — and a call made only inside the
			// initializer runs on mount and then never again, which shifts every
			// later cell by one on the next render: a component's state would land
			// on its neighbour's cell and the re-render would read a stale value.
			// React invokes the component in full each render, so this must too.
			// The state is kept only to schedule that render when the source
			// publishes.
			const [, setValue] = hooks.useState(undefined);
			const current = read();
			hooks.useEffect(() => {
				if (!source || typeof source.subscribe !== 'function') return undefined;
				return source.subscribe(() => setValue(read()));
			}, []);
			return current;
		};
		for (const [name, source] of Object.entries(plain ?? {})) {
			bound[`use${name[0].toUpperCase()}${name.slice(1)}`] = wrap(source);
		}
		for (const [name, resolve] of Object.entries(keyed ?? {})) {
			bound[`use${name[0].toUpperCase()}${name.slice(1)}`] = () => {
				const source = resolve();
				const [value, setValue] = hooks.useState(() => source.getSnapshot());
				hooks.useEffect(() => source.subscribe(() => setValue(source.getSnapshot())), []);
				return value;
			};
		}
		for (const [name, source] of Object.entries(rest)) {
			if (name.startsWith('use') && typeof source === 'function') bound[name] = wrap(source);
		}
		return bound;
	};

	/**
	 * Render one slot component, settling any synchronous state update.
	 *
	 * The tree is then flattened the way React would: function components are
	 * invoked (they are how the panel's rows are built) and fragments/arrays are
	 * spliced, so the returned tree contains only leaves whose text can be read.
	 *
	 * @param component - the slot component function.
	 * @param props - the props the renderer would bind.
	 * @returns the settled, flattened JSX-runtime tree.
	 */
	const renderOnce = (component, props) => {
		let tree;
		for (let pass = 0; pass < 16; pass += 1) {
			cursor = 0;
			// Only the committed pass's effects survive, as in React: a pass that
			// queued an update is not the one whose effects are kept.
			effects = [];
			tree = component(props);
			if (queued.length === 0) break;
			// `queued` may hold updates from *between* renders (a test firing an
			// `onChange`), which is the whole point of `renderAgain`: they are
			// consumed here rather than discarded at the top of the pass.
			const pending = queued;
			queued = [];
			for (const { index, next } of pending) {
				const slot = cells[index];
				slot[0] = typeof next === 'function' ? next(slot[0]) : next;
			}
			if (pass === 15) throw new Error('renderComponent did not settle');
		}
		// Flattening may itself use hooks of its own (none here), so it runs after
		// the state has settled.
		return flatten(tree);
	};

	/** Mount with fresh hook state. */
	const renderComponent = (component, props) => {
		cells = [];
		queued = [];
		return renderOnce(component, props);
	};

	/**
	 * Re-render against the *existing* hook state.
	 *
	 * This is what makes a form testable: an `onChange` only queues a state
	 * update, so the next tree — the one carrying the staged value — comes from a
	 * re-render that keeps the same cells.
	 *
	 * @param component - the slot component function.
	 * @param props - the props the renderer would bind.
	 * @returns the settled, flattened tree.
	 */
	const renderAgain = (component, props) => renderOnce(component, props);

	/**
	 * Run the effects the committed render recorded, the way React would after
	 * mount, and return their combined cleanup.
	 *
	 * Needed only by a test that is *about* a subscription: the badge reads the
	 * session's event window through one, so a tree asserted before this runs is
	 * the tree of a badge that never subscribed. Every other test leaves it
	 * uncalled, which is why no existing expectation gains a mount-time side
	 * effect. Effects are consumed, not replayed — React mounts them once.
	 *
	 * @returns a disposer that runs every cleanup the effects returned.
	 */
	const runEffects = () => {
		const pending = effects;
		effects = [];
		const cleanups = [];
		for (const factory of pending) {
			const cleanup = factory();
			if (typeof cleanup === 'function') cleanups.push(cleanup);
		}
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	};

	/**
	 * Replace function components and fragments with their output.
	 * @param node - a tree node.
	 * @returns the flattened node.
	 */
	const flatten = (node) => {
		if (node === null || node === undefined || typeof node === 'boolean') return null;
		if (typeof node === 'string' || typeof node === 'number') return node;
		if (Array.isArray(node)) return node.map(flatten).filter((child) => child !== null);
		if (typeof node === 'object' && typeof node.type === 'function') {
			return flatten(node.type(node.props));
		}
		if (typeof node === 'object' && node.type === Fragment) {
			return flatten(node.props.children);
		}
		if (typeof node === 'object' && node.props !== undefined) {
			return { ...node, props: { ...node.props, children: flatten(node.props.children) } };
		}
		return null;
	};

	/** Registrations the plugin makes, in order. */
	const registered = [];
	const slotService = {
		inject: (name, body) => {
			const iterator = body();
			let step = iterator.next();
			while (!step.done) {
				registered.push({ slot: name, ...step.value });
				step = iterator.next();
			}
		},
		register: (spec, component) => ({ spec, component }),
	};

	const locale = { bind: () => (key) => key, register: () => {} };
	/** The session's event window, when the fixture is given one. */
	const eventSource = options.noEventSource === true ? undefined : (options.eventSource ?? makeEventSource());
	/** The session binding the badge's inject face reads. */
	const projections = {
		faceOf: (key) => ({
			getSnapshot: () => (key === 'contextPressure' ? options.pressure : options.modelSelection),
			subscribe: () => () => {},
		}),
	};
	const asked = [];
	const configForms = {
		get: (entryId) => {
			asked.push(entryId);
			return {
				getSnapshot: () => options.policy ?? { value: { auto: true, default: {} }, user: {} },
				subscribe: () => () => {},
				mutate: async () => {},
			};
		},
	};
	const ctx = {
		locale,
		slots: slotService,
		configForms,
		remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) } },
		sessions: {
			binding: (sessionId) =>
				sessionId === options.sessionId ? { session: { projections, eventSource } } : undefined,
		},
		effect: (factory) => {
			factory();
			return () => {};
		},
		on: () => () => {},
	};

	let factory;
	globalThis.window = {
		__ModuleLoader__: {
			load: (module) => {
				factory = module.factory;
			},
		},
	};
	// The bundle is a script (no imports); evaluating it only defines the factory.
	new Function(source)();
	const require = (specifier) => {
		if (specifier === 'react') return react;
		if (specifier === 'react/jsx-runtime') return reactJsxRuntime;
		throw new Error(`client.js required an unregistered module: ${specifier}`);
	};
	const exports = factory(require);
	exports.apply(ctx);
	delete globalThis.window;
	return { registered, exports, renderComponent, renderAgain, bindFace, asked, eventSource, runEffects };
}

/**
 * Collect every flattened node matching a predicate.
 * @param node - a flattened tree node.
 * @param predicate - test for one node.
 * @param out - accumulator.
 * @returns the matching nodes, in tree order.
 */
function nodesWhere(node, predicate, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const child of node) nodesWhere(child, predicate, out);
		return out;
	}
	if (predicate(node)) out.push(node);
	nodesWhere(node.props?.children, predicate, out);
	return out;
}

/** The `settings.models.footer` card, booted with the props the renderer binds. */
async function bootCard(options = {}) {
	const booted = await bootClient({ ...options, sessionId: options.sessionId ?? 's1' });
	const entry = booted.registered.find((candidate) => candidate.slot === 'settings.models.footer');
	const face = entry.spec.inject();
	const mutations = [];
	const props = {
		...face,
		t: (key) => key,
		mutate: async (ops) => {
			mutations.push(ops);
			if (options.mutateFails === true) throw new Error('write rejected');
			// The real `ConfigForm.mutate` answers with a boolean: true for Host
			// acceptance, false for a refusal or a skipped write. A double that
			// answers with nothing makes every refusal look like a crash.
			return options.mutateRefused !== true;
		},
	};
	return { ...booted, entry, props, mutations };
}

/** The input whose placeholder distinguishes a budget field. */
function inputFor(tree, placeholder) {
	return nodesWhere(tree, (node) => node.type === 'input' && node.props.placeholder === placeholder)[0];
}

/** The layer selector: `''` is the global default. */
function layerSelect(tree) {
	return nodesWhere(tree, (node) => node.type === 'select' && node.props['aria-label'] === 'layer')[0];
}

/** The summarization model selector. */
function modelSelect(tree) {
	return nodesWhere(tree, (node) => node.type === 'select' && node.props['aria-label'] === 'model')[0];
}

/** The control that stages a route id, whichever shape it currently renders. */
function addControl(tree, type) {
	return nodesWhere(tree, (node) => node.type === type && node.props['aria-label'] === 'layerAdd')[0];
}

/** The button that starts a new per-provider layer. */
function addButton(tree) {
	return nodesWhere(tree, (node) => node.type === 'button' && node.props.children === 'layerAddButton')[0];
}

/** The button that removes the selected route layer. */
function removeButton(tree) {
	return nodesWhere(tree, (node) => node.type === 'button' && node.props.children === 'layerRemove')[0];
}

/** Let a queued async mutation settle. */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The commit button, which only exists while the card is dirty. */
function saveButton(tree) {
	return nodesWhere(tree, (node) => node.type === 'button' && node.props.children === 'save')[0];
}

/** Every chain row's text, in rendered order — the chain as the operator reads it. */
function chainRows(tree) {
	return nodesWhere(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('ccChainRow')).map(
		(row) => text(row).replace(/\s+/g, ' ').trim(),
	);
}

/** A control inside the chain editor, by its aria-label key. */
function chainControl(tree, label, type = 'button') {
	return nodesWhere(tree, (node) => node.type === type && node.props['aria-label'] === label)[0];
}

test('the fallback chain is shown in order and reordered without a round trip', async () => {
	// The chain's order *is* its meaning (strongest free first, paid last), so the
	// card has to show the order and change it. The host resolves the chain through
	// the three layers, so the card renders the resolved chain — not merely the user
	// layer — which is what this pins.
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({
		policy: {
			value: {
				auto: true,
				default: {
					threshold: 0.32,
					retain: 0.08,
					summarizationModel: 'gateway-a/model-a',
					summarizationFallback: ['gateway-a/model-b', 'gateway-a/model-f'],
				},
			},
			user: {},
		},
	});
	let tree = renderComponent(entry.component, props);
	assert.deepEqual(
		chainRows(tree),
		['1 gateway-a/model-b ↑ ↓ fallbackRemove', '2 gateway-a/model-f ↑ ↓ fallbackRemove'],
		'the chain renders in the order it will be tried',
	);

	// Moving the second entry up is a staged edit, and the first entry's "up"
	// control is disabled because there is nowhere above it.
	const rowTwoUp = nodesWhere(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'fallbackUp')[1];
	assert.equal(rowTwoUp.props.disabled, false, 'a lower entry can move up');

	rowTwoUp.props.onClick();
	tree = renderAgain(entry.component, props);
	assert.deepEqual(
		chainRows(tree),
		['1 gateway-a/model-f ↑ ↓ fallbackRemove', '2 gateway-a/model-b ↑ ↓ fallbackRemove'],
		'the reordered chain is staged in the card',
	);

	saveButton(tree).props.onClick();
	await tick();
	assert.deepEqual(
		mutations[0].find((op) => op.path[1] === 'summarizationFallback'),
		{
			op: 'set',
			path: ['default', 'summarizationFallback'],
			value: ['gateway-a/model-f', 'gateway-a/model-b'],
		},
		'one commit writes the whole reordered chain',
	);
});

test('removing the last chain entry unsets the field instead of storing an empty list', async () => {
	// An emptied chain must leave the layer, not become `[]`: leaving the key in the
	// file would make the layer look like it overrides the chain when the operator
	// means to inherit one from the layer below.
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({
		policy: {
			value: { auto: true, default: { summarizationFallback: ['local/only'] } },
			user: { default: { summarizationFallback: ['local/only'] } },
		},
	});
	let tree = renderComponent(entry.component, props);
	assert.equal(chainRows(tree).length, 1, 'the chain starts with one entry');

	chainControl(tree, 'fallbackRemove').props.onClick();
	tree = renderAgain(entry.component, props);
	assert.deepEqual(chainRows(tree), [], 'the chain is empty');
	assert.ok(text(tree).includes('fallbackNone'), 'and the card says what an empty chain means');

	saveButton(tree).props.onClick();
	await tick();
	assert.deepEqual(
		mutations[0].find((op) => op.path[1] === 'summarizationFallback'),
		{ op: 'unset', path: ['default', 'summarizationFallback'] },
		'an emptied chain removes the key',
	);
});

test('the chain cannot be given the primary route or a repeat', async () => {
	// The host resolver rejects both (a repeat of the primary re-sends the whole
	// summary prompt to the route that just failed), so offering them would be
	// offering an edit that cannot be saved.
	const { entry, props, renderComponent } = await bootCard({
		policy: {
			value: {
				auto: true,
				default: { summarizationModel: 'local/primary', summarizationFallback: ['local/weak'] },
			},
			user: {},
		},
	});
	const tree = renderComponent(entry.component, props);
	const choices = (chainControl(tree, 'fallbackAdd', 'select').props.children ?? [])
		.flat()
		.filter((node) => node?.props?.value !== undefined && node.props.value !== '')
		.map((node) => node.props.value);
	assert.equal(choices.includes('local/primary'), false, 'the primary route is not offered as a fallback');
	assert.equal(choices.includes('local/weak'), false, 'a route already in the chain is not offered again');
});

test('the summarization model select shows the staged route after a change', async () => {
	const { entry, props, renderComponent, renderAgain } = await bootCard({
		policy: {
			value: { auto: true, default: { summarizationModel: 'local/primary' } },
			user: { default: { summarizationModel: 'local/primary' } },
		},
	});
	let tree = renderComponent(entry.component, props);
	assert.equal(modelSelect(tree).props.value, 'local/primary', 'the stored route is shown initially');

	modelSelect(tree).props.onChange({ target: { value: 'local/model-i' } });
	tree = renderAgain(entry.component, props);
	assert.equal(
		modelSelect(tree).props.value,
		'local/model-i',
		'the newly selected route is shown immediately',
	);

	// resetField 成功后删除 draft 中的该 key，select 随即回落到 resolved 的值。
	const reset = nodesWhere(tree, (node) => node.type === 'button' && node.props.children === 'reset')[0];
	reset.props.onClick();
	await tick();
	tree = renderAgain(entry.component, props);
	assert.equal(modelSelect(tree).props.value, 'local/primary', 'resetting returns the select to the resolved route');

	// 保存成功的路径不必另测：`commit()` 成功后 `setDraft({})`，`draft.summarizationModel`
	// 变成 undefined —— 与上面 reset 那条断言的是同一个条件、同一个表达式。这里再模拟一次
	// 「宿主接受写入并发布新设置文档」只会去测 harness 缺失的那套发布机制（scope 的
	// `subscribe` 在桩里不会通知），测不到产品行为。
});

test('the engine reserve is a separate field from the derived gap', async () => {
	// `headroomTokens` is the engine's own configurable reserve below the threshold;
	// the panel's "gap" is threshold minus retain. They were both once called
	// headroom, which made a computed number look like a setting.
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({
		policy: { value: { auto: true, default: { threshold: 0.32, retain: 0.08, headroomTokens: 40_000 } }, user: {} },
	});
	let tree = renderComponent(entry.component, props);
	const field = nodesWhere(tree, (node) => node.type === 'input' && node.props['aria-label'] === 'headroom')[0];
	assert.equal(field.props.value, '40000', 'the resolved reserve is shown');

	field.props.onChange({ target: { value: '50000' } });
	tree = renderAgain(entry.component, props);
	saveButton(tree).props.onClick();
	await tick();
	assert.deepEqual(
		mutations[0].find((op) => op.path[1] === 'headroomTokens'),
		{ op: 'set', path: ['default', 'headroomTokens'], value: 50_000 },
		'the reserve is written as a number',
	);
});

test('the bundle registers the settings card and the in-session badge', async () => {
	const { registered, exports } = await bootClient({ sessionId: 's1' });
	const slots = registered.map((entry) => entry.slot).sort();
	assert.deepEqual(slots, ['conversation.session.header.utilities', 'settings.models.footer']);

	// Both services the badge reaches through the ctx proxy must be declared, or
	// the loader entry fails at materialization with a browser-console-only error
	// and no card at all.
	for (const service of ['locale', 'remote', 'remote.session', 'sessions', 'configForms', 'slots']) {
		assert.ok(exports.inject.includes(service), `client inject list is missing "${service}"`);
	}
});

test('the badge inject face binds the session and the session-scoped policy hook', async () => {
	const pressure = { pressureTokens: 40_000, contextWindow: 200_000 };
	const { registered } = await bootClient({ sessionId: 's1', pressure });
	const badge = registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	assert.equal(badge.spec.name, 'conversation.session.header.utilities');
	assert.equal(badge.spec.locale, 'compaction-control');

	const face = badge.spec.inject('s1');
	// The projections are read off the session object, NOT through an
	// entry-supplied `hooks.<name>` face: that form binds through the renderer's
	// selector hook and throws inside `useSyncExternalStoreWithSelector` for this
	// seat (verified in a real browser — the slot entry crashed and the badge
	// never rendered). Guarding the working shape is the point of this test.
	assert.equal(face.hooks, undefined, 'the badge must not contribute plain hooks');
	assert.equal(face.keyedHooks, undefined, 'the badge must not contribute keyed hooks');
	assert.equal(typeof face.useSession, 'function');
	assert.equal(face.useSession().projections.faceOf('contextPressure').getSnapshot(), pressure);
	assert.equal(typeof face.usePolicy, 'function');
});

test('an unknown session fails loudly rather than rendering an empty badge', async () => {
	const { registered } = await bootClient({ sessionId: 's1' });
	const badge = registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	assert.throws(() => badge.spec.inject('other'), /session "other" is unavailable/);
});

test('every translation key the components ask for exists in both locales', async () => {
	// Learned the hard way: a missing key does not throw, it renders the key
	// itself into the panel (`pEffortViaAuto` showed up where a label belonged).
	// The bundle holds both dictionaries in its factory closure, so the only way
	// to check them is to read the source and compare the two blocks.
	const source = await readFile(CLIENT_ENTRY, 'utf8');
	const zhStart = source.indexOf('const zh = {');
	const enStart = source.indexOf('const en = {');
	assert.ok(zhStart !== -1 && enStart !== -1, 'both locale dictionaries are present');
	const keysOf = (block) => [...block.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*['"]/gm)].map((match) => match[1]);
	const zh = new Set(keysOf(source.slice(zhStart, enStart)));
	const en = new Set(keysOf(source.slice(enStart, source.indexOf('const css = ['))));
	assert.deepEqual([...zh].sort(), [...en].sort(), 'zh and en must define the same keys');

	// Every `t('key')` the components call must exist in those dictionaries.
	const used = new Set([...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'\)/g)].map((match) => match[1]));
	const missing = [...used].filter((key) => !zh.has(key));
	assert.deepEqual(missing, [], `missing translation keys: ${missing.join(', ')}`);
});

test('the panel edits the same patch entry id the engine reads first', async () => {
	const source = await readFile(CLIENT_ENTRY, 'utf8');
	const match = source.match(/const SETTINGS_ENTRIES = \[([^\]]+)\];/);
	assert.ok(match, 'SETTINGS_ENTRIES is present in the client source');
	const firstEntryId = match[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).find(Boolean);
	assert.equal(firstEntryId, PATCH_ENTRY_IDS[0]);
});

test('the badge reports the resolved policy and the token budget it maps to', async () => {
	const policy = {
		value: { auto: true, default: { threshold: 0.2, retain: 0.08, summarizationModel: 'auto' } },
		user: { default: { threshold: 0.2, retain: 0.08 } },
	};
	const pressure = { pressureTokens: 40_000, contextWindow: 1_000_000 };
	const modelSelection = { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } };
	const { registered, renderComponent, bindFace } = await bootClient({
		sessionId: 's1',
		policy,
		pressure,
		modelSelection,
		clickBadge: true,
	});
	const badge = registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	const face = badge.spec.inject('s1');
	const session = face.useSession();
	const rendered = text(
		renderComponent(badge.component, {
			...bindFace(face),
			// The real renderer merges this in from the standard session scope.
			useSession: () => session,
			t: (key) => key,
		}),
	);

	// Headline: ratio plus the scaled budget, not a bare percentage — 0.2 of a
	// 1M window is 200K, and that is the number the operator acts on.
	assert.match(rendered, /20%/, 'headline must carry the effective ratio');
	assert.match(rendered, /200K/, 'headline must carry the scaled trigger budget');
	// Attribution: the threshold is user-set, the summarization model falls back
	// to the engine default, and the target route is named.
	assert.match(rendered, /pLayerDefault/);
	assert.match(rendered, /pUser/);
	assert.match(rendered, /pLayerEngine/);
	assert.match(rendered, /deepseek-official\/deepseek-flash/);
	assert.match(rendered, /40K/);
});

test('the badge says the window is unknown instead of inventing a budget', async () => {
	const policy = {
		value: { auto: true, default: { threshold: 0.2, retain: 0.08 } },
		user: { default: { threshold: 0.2, retain: 0.08 } },
	};
	const { registered, renderComponent, bindFace } = await bootClient({
		sessionId: 's1',
		policy,
		pressure: {},
		clickBadge: true,
	});
	const badge = registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	const face = badge.spec.inject('s1');
	const session = face.useSession();
	const rendered = text(
		renderComponent(badge.component, {
			...bindFace(face),
			// The real renderer merges this in from the standard session scope.
			useSession: () => session,
			t: (key) => key,
		}),
	);

	assert.match(rendered, /20%/);
	assert.match(rendered, /pWindowUnknown/);
	assert.doesNotMatch(rendered, /200K/, 'no window means no fabricated token budget');
	assert.match(rendered, /pTargetNone/, 'an unknown route must be stated, not implied');
});

// ── the badge's second face: which route wrote the last summary ──────────────

/** Render the in-session badge with the props the renderer binds. */
async function renderBadge(options) {
	const booted = await bootClient({ sessionId: 's1', ...options });
	const badge = booted.registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	const face = badge.spec.inject('s1');
	const session = face.useSession();
	return {
		...booted,
		badge,
		face,
		props: { ...booted.bindFace(face), useSession: () => session, t: (key) => key },
	};
}

test('the badge names the route that actually wrote the last summary', async () => {
	// The policy row already says which model *will* be asked. This says which one
	// *did* the work, and the fallback chain is exactly why the two can differ —
	// which is also why the route is on the badge face rather than only in the
	// panel: the compaction marker in the chat belongs to dsh's own renderer, so
	// this badge is the only place a plugin can answer the question at all.
	const { badge, props, renderComponent, eventSource } = await renderBadge({
		eventSource: makeEventSource([summaryEntry({ sourceCommandId: 'cmd-c2ca4fdc-1' })]),
	});
	const rendered = text(renderComponent(badge.component, props));

	assert.match(
		rendered,
		/gateway-a\/model-b/,
		'the route that produced the summary must be on the badge face',
	);
	assert.match(rendered, /lastManual/, 'a /compact is a manual compaction');
	assert.doesNotMatch(rendered, /lastAuto/, 'and must not also claim to be automatic');
	// The badge reads the window the host handed it, not a re-fetch of its own.
	assert.equal(eventSource.getSnapshot().entries.length, 1);
});

test('a compaction the engine triggered itself is labelled automatic', async () => {
	// No `sourceCommandId` is the whole difference: the engine's own trigger wrote
	// the record, and an operator reading "automatic" knows the compaction landed
	// mid-turn rather than because they asked for it.
	const { badge, props, renderComponent } = await renderBadge({
		eventSource: makeEventSource([summaryEntry({ sourceCommandId: undefined })]),
	});
	const rendered = text(renderComponent(badge.component, props));

	assert.match(rendered, /lastAuto/);
	assert.doesNotMatch(rendered, /lastManual/);
});

test('a session with no compaction yet names no route', async () => {
	// An empty window is the ordinary state of a fresh conversation. The face has
	// nothing to say and says nothing — a badge reading "no compaction yet" on
	// every new session would be noise — while the panel still states the fact
	// rather than leaving the row blank.
	const { badge, props, renderComponent } = await renderBadge({ clickBadge: true, eventSource: makeEventSource() });
	const rendered = text(renderComponent(badge.component, props));

	assert.doesNotMatch(rendered, /model-b/, 'no record means no route to name');
	assert.doesNotMatch(rendered, /undefined/, 'and certainly not a fabricated one');
	assert.match(rendered, /lastSummaryNone/, 'the panel states the absence');
});

test('a session with no event window leaves the badge on its policy face', async () => {
	// A stub session, or one whose event source has not been wired, must degrade
	// to the policy readout. Throwing here would take the whole header down.
	const { badge, props, renderComponent } = await renderBadge({ noEventSource: true });
	const rendered = text(renderComponent(badge.component, props));

	assert.match(rendered, /pThreshold/, 'the policy face survives');
	assert.doesNotMatch(rendered, /model-b/);
	assert.doesNotMatch(rendered, /undefined/, 'no route may be invented from a missing window');
});

test('a compaction that lands while the session is open moves the badge', async () => {
	// The badge reads the window through a subscription, so a tree asserted
	// before the mount effect runs is the tree of a badge that never subscribed.
	// The host publishes synchronously on every accepted window mutation; this
	// drives that exact path rather than trusting the initial read.
	const { badge, props, renderComponent, renderAgain, eventSource, runEffects } = await renderBadge({
		eventSource: makeEventSource(),
	});

	const before = text(renderComponent(badge.component, props));
	assert.doesNotMatch(before, /model-b/, 'nothing has been compacted yet');

	const dispose = runEffects();
	eventSource.append(summaryEntry());
	const after = text(renderAgain(badge.component, props));
	assert.match(
		after,
		/gateway-a\/model-b/,
		'the subscription must carry a record that lands later into the tree',
	);
	dispose();
});

// ── the settings card: one input per budget, two units ───────────────────────

test('a token count typed into the card replaces the ratio in the same commit', async () => {
	// The card is a view of a document the engine reads *raw* (the file section),
	// so a unit change has to remove the form it replaced: leaving both keys in
	// the section is the one state where "which unit wins" depends on the reader.
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({
		policy: {
			value: { auto: true, default: { threshold: 0.2, retain: 0.08 } },
			user: { default: { threshold: 0.2, retain: 0.08 } },
		},
	});
	let tree = renderComponent(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.value, '0.2', 'the ratio form is what the layer states');

	// 1 or more can only be a token count; below 1 can only be a ratio. One input,
	// no unit selector — the shape of the number is the unit.
	inputFor(tree, '0.8').props.onChange({ target: { value: '200000' } });
	tree = renderAgain(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.value, '200000', 'the staged value is shown, not reformatted');
	assert.equal(inputFor(tree, '0.8').props.className, 'ccInput', 'a token count is not an invalid ratio');

	saveButton(tree).props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(mutations, [
		[
			{ op: 'unset', path: ['default', 'threshold'] },
			{ op: 'set', path: ['default', 'thresholdTokens'], value: 200000 },
		],
	]);
});

test('the card shows the merged layer\'s token form even when the base left a ratio beside it', async () => {
	// The exact state the settings provider produces: the user section says
	// `thresholdTokens`, the composition base still says `threshold`. The engine
	// acts on the token form, so the input has to show it — a ratio shown here
	// while the engine uses another number is the bug this whole path is about.
	const { entry, props, renderComponent } = await bootCard({
		policy: {
			value: { auto: true, default: { threshold: 0.8, thresholdTokens: 200_000 } },
			user: { default: { thresholdTokens: 200_000 } },
		},
	});
	const tree = renderComponent(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.value, '200000');
	assert.equal(inputFor(tree, '0.8').props.placeholder, '0.8', 'the placeholder still hints the ratio form');
	// The base's ratio is not an override of the user's layer, but the user's
	// token value is — so the reset affordance appears.
	assert.deepEqual(
		nodesWhere(tree, (node) => node.type === 'button' && node.props.children === 'reset').length,
		1,
	);
});

test('a ratio typed over a token policy removes the token form', async () => {
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({
		policy: {
			value: { auto: true, default: { thresholdTokens: 200_000, retain: 0.01 } },
			user: { default: { thresholdTokens: 200_000, retain: 0.01 } },
		},
	});
	let tree = renderComponent(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.value, '200000');

	inputFor(tree, '0.8').props.onChange({ target: { value: '0.25' } });
	tree = renderAgain(entry.component, props);
	saveButton(tree).props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(mutations.at(-1), [
		{ op: 'set', path: ['default', 'threshold'], value: 0.25 },
		{ op: 'unset', path: ['default', 'thresholdTokens'] },
	]);
});

test('the card refuses a value that is neither a ratio nor a whole token count', async () => {
	const { entry, props, renderComponent, renderAgain } = await bootCard({
		policy: { value: { auto: true, default: {} }, user: {} },
	});
	let tree = renderComponent(entry.component, props);
	for (const bad of ['1.5', 'abc', '0', '-5']) {
		inputFor(tree, '0.8').props.onChange({ target: { value: bad } });
		tree = renderAgain(entry.component, props);
		const input = inputFor(tree, '0.8');
		assert.equal(input.props.className, 'ccInput ccInputInvalid', `"${bad}" must be flagged`);
		assert.equal(saveButton(tree).props.disabled, true, `"${bad}" must block the commit`);
	}
	// Blank is "inherit", never an error.
	inputFor(tree, '0.8').props.onChange({ target: { value: '' } });
	tree = renderAgain(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.className, 'ccInput');
	assert.equal(saveButton(tree).props.disabled, false, 'clearing the override is a legal edit');
});

test('the card only compares budgets stated in one unit', async () => {
	// 0.3 is not "less than" 200000 in any meaningful sense; the host compares
	// them in tokens once it has the window, so the card must not invent an error.
	const mixed = await bootCard({
		policy: {
			value: { auto: true, default: { thresholdTokens: 200_000, retain: 0.3 } },
			user: { default: { thresholdTokens: 200_000, retain: 0.3 } },
		},
	});
	const mixedTree = mixed.renderComponent(mixed.entry.component, mixed.props);
	assert.deepEqual(nodesWhere(mixedTree, (node) => node.props?.className === 'ccError'), []);

	// Same unit, inverted: the engine would reject the document, so the card must
	// say so before the write reaches the service.
	const same = await bootCard({
		policy: { value: { auto: true, default: {} }, user: {} },
	});
	let tree = same.renderComponent(same.entry.component, same.props);
	inputFor(tree, '0.8').props.onChange({ target: { value: '0.2' } });
	tree = same.renderAgain(same.entry.component, same.props);
	inputFor(tree, '0.16').props.onChange({ target: { value: '0.3' } });
	tree = same.renderAgain(same.entry.component, same.props);
	assert.deepEqual(
		nodesWhere(tree, (node) => node.props?.className === 'ccError').map((node) => node.props.children),
		['retainAbove'],
	);
	assert.equal(saveButton(tree).props.disabled, true);
});

test('resetting a budget clears both units', async () => {
	const { entry, props, mutations, renderComponent } = await bootCard({
		policy: {
			value: { auto: true, default: { thresholdTokens: 200_000 } },
			user: { default: { thresholdTokens: 200_000 } },
		},
	});
	const tree = renderComponent(entry.component, props);
	const reset = nodesWhere(tree, (node) => node.type === 'button' && node.props.children === 'reset')[0];
	reset.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(mutations, [
		[
			{ op: 'unset', path: ['default', 'threshold'] },
			{ op: 'unset', path: ['default', 'thresholdTokens'] },
		],
	]);
});

test('resetting a single-unit field unsets only that field', async () => {
	// `formsOf` expands a budget into its ratio/token pair, and applying it to every
	// reset invented a sibling for each single-unit field: resetting `maxTokens`
	// unset `maxTokensTokens`, and resetting the fallback chain unset
	// `summarizationFallbackTokens`. Writing a path that cannot exist into the
	// operator's document is a real edit, not a harmless no-op.
	const { entry, props, mutations, renderComponent } = await bootCard({
		policy: {
			value: { auto: true, default: { maxTokens: 4096, summarizationFallback: ['local/weak'] } },
			user: { default: { maxTokens: 4096, summarizationFallback: ['local/weak'] } },
		},
	});
	const tree = renderComponent(entry.component, props);
	const resets = nodesWhere(tree, (node) => node.type === 'button' && node.props.children === 'reset');
	// The first reset in card order belongs to `maxTokens`, which is a single-unit
	// field and so is the case that used to invent a sibling.
	resets[0].props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(mutations[0], [{ op: 'unset', path: ['default', 'maxTokens'] }], 'only the field itself is cleared');
	assert.equal(
		mutations[0].some((op) => op.path[1] === 'maxTokensTokens'),
		false,
		'no invented sibling key is written',
	);
});

test('the panel states the compactable room and warns when a summary cannot fit', async () => {
	const policy = {
		value: { auto: true, default: { threshold: 0.2, retain: 0.195 } },
		user: { default: { threshold: 0.2, retain: 0.195 } },
	};
	const { registered, renderComponent, bindFace } = await bootClient({
		sessionId: 's1',
		policy,
		pressure: { pressureTokens: 180_000, contextWindow: 1_000_000 },
		clickBadge: true,
	});
	const badge = registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	const face = badge.spec.inject('s1');
	const session = face.useSession();
	const rendered = text(
		renderComponent(badge.component, { ...bindFace(face), useSession: () => session, t: (key) => key }),
	);
	assert.match(rendered, /pGap/, 'the panel names the room a compaction has');
	assert.match(rendered, /5K/, '200K trigger − 195K retention');
	assert.match(rendered, /pGapWarn/, 'and warns below the 8192-token floor');
});

test('a token-declared budget shows the share of the window it occupies', async () => {
	const policy = {
		value: { auto: true, default: { thresholdTokens: 200_000, retainTokens: 80_000 } },
		user: { default: { thresholdTokens: 200_000, retainTokens: 80_000 } },
	};
	const { registered, renderComponent, bindFace } = await bootClient({
		sessionId: 's1',
		policy,
		pressure: { pressureTokens: 40_000, contextWindow: 1_000_000 },
		clickBadge: true,
	});
	const badge = registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	const face = badge.spec.inject('s1');
	const session = face.useSession();
	const rendered = text(
		renderComponent(badge.component, { ...bindFace(face), useSession: () => session, t: (key) => key }),
	);
	// 200000 / 1M is 20%, and the panel must derive that rather than fall back to
	// the engine default 80% — otherwise the headline contradicts the policy.
	assert.match(rendered, /20%/);
	assert.doesNotMatch(rendered, /80%/);
	assert.match(rendered, /8%/);
	assert.doesNotMatch(rendered, /pGapWarn/, '720K of room is plenty');
});

test('a per-provider layer can be added, filled in and saved', async () => {
	// The per-provider layer is the coarser of the two override planes, and the
	// only one the card can write: `models[]` is a list, and the settings writer
	// replaces arrays whole, so a list editor would rewrite the operator's whole
	// table on every keystroke.
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({
		policy: { value: { auto: true, default: { threshold: 0.8 } }, user: {} },
	});
	let tree = renderComponent(entry.component, props);
	assert.equal(layerSelect(tree).props.value, '', 'the card opens on the global default');

	// The catalog has not resolved in this harness, so the control falls back to
	// a typed route id — "the catalog failed" must not mean "cannot configure".
	addControl(tree, 'input').props.onChange({ target: { value: 'gateway-b' } });
	tree = renderAgain(entry.component, props);
	addButton(tree).props.onClick();
	tree = renderAgain(entry.component, props);

	assert.equal(layerSelect(tree).props.value, 'gateway-b', 'adding selects the new layer');
	assert.equal(
		inputFor(tree, '0.8').props.value,
		'',
		'a new layer starts empty: showing the inherited value would stage it as the user\'s own',
	);

	inputFor(tree, '0.8').props.onChange({ target: { value: '0.5' } });
	tree = renderAgain(entry.component, props);
	saveButton(tree).props.onClick();
	await tick();
	assert.deepEqual(mutations[0], [
		{ op: 'set', path: ['providers', 'gateway-b', 'threshold'], value: 0.5 },
		{ op: 'unset', path: ['providers', 'gateway-b', 'thresholdTokens'] },
	]);
});

test('switching layers discards the staged edit instead of carrying it over', async () => {
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({
		policy: {
			value: { auto: true, default: { threshold: 0.8 }, providers: { 'gateway-b': { threshold: 0.5 } } },
			user: {},
		},
	});
	let tree = renderComponent(entry.component, props);
	inputFor(tree, '0.8').props.onChange({ target: { value: '0.33' } });
	tree = renderAgain(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.value, '0.33', 'staged on the global default');

	layerSelect(tree).props.onChange({ target: { value: 'gateway-b' } });
	tree = renderAgain(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.value, '0.5', 'the route layer shows its own value');
	assert.equal(saveButton(tree), undefined, 'and nothing is dirty, so 0.33 cannot be written into it');
	assert.deepEqual(mutations, []);
});

test('the route layer the composition declares is selectable and removable in one commit', async () => {
	const document = {
		value: {
			auto: true,
			default: { threshold: 0.8 },
			providers: { 'gateway-b': { threshold: 0.5, summarizationModel: 'deepseek-official/flash' } },
		},
		user: { providers: { 'gateway-b': { threshold: 0.5 } } },
	};
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({ policy: document });
	let tree = renderComponent(entry.component, props);

	const options = nodesWhere(tree, (node) => node.type === 'option').map((node) => node.props.value);
	assert.ok(options.includes('gateway-b'), 'a route from the composition base is offered, not only user-written ones');
	const labelled = nodesWhere(tree, (node) => node.props.value === 'gateway-b')[0];
	assert.equal(labelled.props.children, 'gateway-b · pUser', 'a route the user layer also states is marked as theirs');

	layerSelect(tree).props.onChange({ target: { value: 'gateway-b' } });
	tree = renderAgain(entry.component, props);
	assert.equal(inputFor(tree, '0.8').props.value, '0.5', 'the selected route layer is what the fields show');

	removeButton(tree).props.onClick();
	await tick();
	assert.equal(mutations[0].length, 10, 'removing a layer clears every field it can carry');
	assert.ok(
		mutations[0].every((op) => op.op === 'unset' && op.path[0] === 'providers' && op.path[1] === 'gateway-b'),
		'and only unsets this route\'s keys',
	);
	assert.ok(
		mutations[0].some((op) => op.path[2] === 'thresholdTokens') &&
			mutations[0].some((op) => op.path[2] === 'compactionRetries'),
		'including the keys this card does not render, so the button means what it says',
	);

	tree = renderAgain(entry.component, props);
	assert.equal(layerSelect(tree).props.value, '', 'and the card returns to the global default');
});

test('the hints quote the composition policy, not the plugin schema defaults', async () => {
	// A host whose composition row declares `default.threshold: 0.6`: the
	// deployment default IS 0.6, so a cleared field must advertise 0.6. The
	// plugin's own 0.8 is only what a host that declares nothing falls back to —
	// advertising it here read as "this session compacts at 80% of the window",
	// four times the point the engine actually fires at.
	const policy = {
		status: 'ready',
		mode: 'host',
		value: { auto: true, default: {} },
		base: { default: { threshold: 0.6, summarizationModel: 'auto', retain: 0.1 } },
		user: {},
	};
	const { entry, props, renderComponent } = await bootCard({ policy });
	const tree = renderComponent(entry.component, props);

	assert.equal(inputFor(tree, '0.6').props.value, '', 'the user layer states nothing, so the field stays blank');
	assert.equal(inputFor(tree, '0.1').props.value, '', 'and so does the retained tail');
	assert.equal(inputFor(tree, '0.8'), undefined, 'the plugin schema default is not advertised as the deployment default');
	assert.equal(inputFor(tree, '0.16'), undefined, 'nor is the retain one');
});

test('a memory-mode client is told what it cannot read or write', async () => {
	// A remote browser: the host never hands it the settings document and never
	// accepts its writes. Rendering the schema defaults as if they were policy is
	// the failure mode this guards — the card has to say the plane is out of reach.
	const policy = { status: 'unavailable', mode: 'memory', value: undefined, base: undefined, user: {}, writable: false };
	const { entry, props, renderComponent } = await bootCard({ policy });
	const tree = renderComponent(entry.component, props);

	const note = nodesWhere(tree, (node) => node.type === 'p' && node.props.children === 'memoryNote')[0];
	assert.ok(note, 'the card explains the memory partition instead of showing defaults as if they were the policy');
	assert.equal(inputFor(tree, '0.8').props.disabled, true, 'a field it cannot save is not left editable');
	assert.equal(saveButton(tree), undefined, 'and there is nothing to commit while nothing stages');
});

test('a write the host refuses is reported instead of silently doing nothing', async () => {
	const policy = { status: 'ready', mode: 'host', value: { auto: true, default: {} }, base: undefined, user: {}, writable: false };
	const { entry, props, mutations, renderComponent, renderAgain } = await bootCard({ policy, mutateRefused: true });
	let tree = renderComponent(entry.component, props);

	inputFor(tree, '0.8').props.onChange({ target: { value: '0.5' } });
	tree = renderAgain(entry.component, props);
	saveButton(tree).props.onClick();
	await tick();
	tree = renderAgain(entry.component, props);

	assert.equal(mutations.length, 1, 'the attempt reached the form');
	const error = nodesWhere(tree, (node) => node.type === 'p' && node.props.children === 'writeRefused')[0];
	assert.ok(error, 'a refusal has to surface: a save that does nothing looks exactly like a save that worked');
});

test('the card asks for the profile entry that owns the policy', async () => {
	// 0.2.0 keys settings forms by profile entry id (`configForms.get`'s own doc:
	// "Unique Host plugin entry id"), because the settings document IS the profile
	// patch. Asking for a namespace the plugin used to *publish* answers
	// `unavailable` forever — which is how the panel came to advertise the
	// plugin's 0.8 while the deployment ran 0.6.
	const { asked } = await bootCard({});
	assert.equal(asked[0], 'compaction-control-settings', 'the exposed settings entry is the engine authority');
	assert.ok(asked.includes('compaction-control-host'), 'the older entry stays as a fallback for other profiles');
});

test('the badge says the policy is unreadable instead of inventing the engine default', async () => {
	// A remote browser's form is memory-mode (`status: 'unavailable'`). The badge
	// used to fall through to `ENGINE_DEFAULT_THRESHOLD` and render the plugin's
	// own 0.8 as "80% · 800K" against a 1M window — a number indistinguishable
	// from a configured trigger, and a third off the real 0.6 the engine fires at.
	const { registered } = await bootClient({
		sessionId: 's1',
		pressure: { pressureTokens: 40_000, contextWindow: 1_000_000 },
		policy: { status: 'unavailable', mode: 'memory', value: undefined, user: undefined },
	});
	const badge = registered.find((entry) => entry.slot === 'conversation.session.header.utilities');
	const face = badge.spec.inject('s1');
	assert.equal(face.usePolicy((value) => value)?.status, 'unavailable', 'the fixture is a memory-mode client');

	const element = badge.component({ ...face, t: (key) => key });
	const texts = [
		...nodesWhere(element, (node) => typeof node.props?.children === 'string').map((node) => node.props.children),
		...nodesWhere(element, (node) => typeof node.props?.['aria-label'] === 'string').map((node) => node.props['aria-label']),
	];
	assert.ok(texts.includes('badgeUnknown'), `the badge states its state (saw: ${texts.join(' | ')})`);
	assert.equal(
		texts.some((text) => /\d+\s*%|\d+K/.test(text)),
		false,
		`no fabricated trigger may reach the badge (saw: ${texts.join(' | ')})`,
	);
});
