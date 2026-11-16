/**
 * Browser half of dsh-compaction-policy-engine: the policy card in the settings page
 * and the in-session indicator beside the composer.
 *
 * The server half publishes the `compaction-control` settings section; this file
 * renders it. It is served verbatim (no build step), so the client-safe policy
 * view is inlined below and must stay textually identical to
 * `lib/client-policy.js` — `test/client-policy.test.js` fails if it drifts.
 *
 * @module dsh-compaction-policy-engine/client
 */

window.__ModuleLoader__.load({
	id: '@magic6/dsh-compaction-policy-engine',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require('react');
		const jsx = require('react/jsx-runtime');

		/** Settings namespace owned by the host half of this plugin. */
		const NS = 'compaction-control';

		/** Copy for both locales the Web client ships. */
		const zh = {
			title: '压缩策略',
			hint: '上下文达到触发比例时自动压缩；也可以直接填固定 token 数（≥1 的整数）。留白表示沿用部署配置的默认值。',
			threshold: '触发阈值',
			retain: '保留比例',
			maxTokens: '摘要长度上限',
			model: '压缩用模型',
			auto: 'auto（沿用当前会话的模型）',
			reset: '重置',
			save: '保存',
			invalid: '请输入 0–1 之间的比例，或 ≥1 的整数 token 数',
			retainAbove: '保留比例必须小于触发阈值',
			unavailable: '设置服务不可用，当前策略来自部署配置。',
			memoryNote: '这个浏览器不是环回地址（例如用局域网 IP 打开），dsh 只给它内存态视图：读不到主机上真正生效的压缩策略，写也不会保存。下面输入框里的提示数字是插件默认值，不是实际阈值——百分比请以本机 127.0.0.1 打开的界面为准。',
			writeRefused: '写入未被主机接受：这台浏览器是内存态，改动不会保存。',
			enable: '自动压缩',
			enableHint: '关闭后上下文不再被自动压缩，超长会话将直接撞上模型窗口。',
			modelAuto: 'auto（沿用当前会话的模型）',
			modelLoading: '正在读取模型列表…',
			modelEmpty: '当前没有可用的模型路由，只能选 auto。',
			modelFailed: '模型列表读取失败，只能选 auto。',
			// ── 摘要模型的回退链与安全余量 ────────────────────────────────
			headroom: '安全余量（token）',
			headroomHint: '留空沿用下层',
			fallback: '回退链',
			fallbackOrder: '按顺序尝试：强免费 → 弱免费 → 收费。留空表示不重试。',
			fallbackNone: '还没有回退路由。主模型失败时压缩会直接报错。',
			fallbackPick: '选择一个路由…',
			fallbackAdd: '添加',
			fallbackRemove: '移除',
			fallbackUp: '上移',
			fallbackDown: '下移',
			fallbackNoChoices: '没有更多可添加的路由（不能是主模型，也不能重复）。',
			// ── 策略层（全局默认 / 按供应商 / 按模型）──────────────────────
			layer: '策略层',
			layerRemove: '移除这一层',
			layerAdd: '按供应商新增覆盖',
			layerAddButton: '新增',
			layerAddHint: '选中一层后，下面的输入框改的就是那一层；留白表示继承下一层。',
			layerRoute: '供应商路由名',
			layerPick: '选择供应商…',
			layerOther: '手填路由名…',
			// ── 会话内策略指示器 ──────────────────────────────────────────
			badgeOff: '压缩已关',
			badgeAria: '当前会话压缩策略',
			badgeTitle: '当前会话的压缩策略',
			badgeUnknown: '策略未读到',
			badgeUnknownHint: '这个浏览器读不到主机上的压缩策略（它不是环回地址，dsh 只给它内存态视图），所以徽标不再猜数字。要看真实阈值请用本机 127.0.0.1 打开。',
			pEffective: '生效值',
			pLayerDefault: '全局默认',
			pLayerProvider: '按供应商',
			pLayerModel: '按模型',
			pLayerEngine: '引擎内置（未被任何层覆盖）',
			pUser: '你设置的',
			pThreshold: '触发阈值',
			pThresholdHint: '达到上下文窗口的这一比例即自动压缩',
			pRetain: '保留尾部',
			pRetainHint: '压缩时原样保留的最近内容比例',
			pGap: '可压缩空间',
			pGapWarn: '触发点与保留尾部之间空隙太小，摘要无法比被压缩的内容更短：压缩会被拒绝，门限会反复触发。建议至少留 8K。',
			pSummary: '压缩用模型',
			pFallback: '模型回退链',
			pFallbackHint: '主模型失败时按顺序尝试，依次消耗更强/更弱的免费额度，最后才用收费模型',
			pFallbackNone: '无（主模型失败即报错）',
			pEffort: '压缩思考等级',
			pEffortHint: '摘要只是对已有上下文做机械压缩，不需要思考',
			pEffortFixed: '不思考（写死）',
			pMaxTokens: '摘要上限',
			pMaxTokensUnit: 'tokens',
			pWindow: '上下文窗口',
			pWindowUnknown: '会话尚未报告窗口（还没发过请求）',
			pTriggerAt: '约在',
			pAuto: '自动压缩',
			pOn: '开',
			pOff: '关',
			pOffHint: '自动压缩已关闭，超长会话会直接撞上模型窗口。',
			pUnits: 'tokens',
			pModelAuto: 'auto（沿用本会话模型）',
			pTarget: '适用路由',
			pTargetNone: '本会话还没确定路由，按全局默认显示',
			pEdit: '改这里：设置 → 模型 → 压缩策略，或直接编辑 settings.yaml。',
			// ── 最近一次压缩：谁做的、哪条路由写的 ────────────────────────
			lastSummary: '最近摘要',
			lastSummaryNone: '还没有压缩过',
			lastSummaryHint: '最近一次压缩实际用来写摘要的路由——回退链成功后会改成真正写成功的那条，和策略里配置的那条可能不是同一个。',
			lastManual: '手动',
			lastAuto: '自动',
			lastCount: '压缩了',
			lastTokens: 'tokens',
		};
		const en = {
			title: 'Compaction policy',
			hint: 'Compact once the session reaches this fraction of the context window — or type a whole token count (1 or more). Blank inherits the deployment default.',
			threshold: 'Threshold',
			retain: 'Retain',
			maxTokens: 'Summary cap',
			model: 'Summarization model',
			auto: 'auto (reuse the conversation model)',
			reset: 'Reset',
			save: 'Save',
			invalid: 'Enter a ratio between 0 and 1, or a whole number of tokens (1 or more)',
			retainAbove: 'Retain must be below the threshold',
			unavailable: 'Settings service unavailable; the policy comes from deployment config.',
			memoryNote: 'This browser is not loopback (opened via a LAN address), so dsh gives it a memory-only view: it cannot read the host\'s effective policy and cannot save a change. The hint numbers below are plugin defaults, not your threshold — check the real value from the host at 127.0.0.1.',
			writeRefused: 'The host refused the write: this browser is in memory mode, so changes are not saved.',
			enable: 'Automatic compaction',
			enableHint: 'When off, context is never compacted automatically and a long session runs into the model window.',
			modelAuto: 'auto (reuse the conversation model)',
			modelLoading: 'Reading the model list…',
			modelEmpty: 'No model route is currently available, so only auto can be chosen.',
			modelFailed: 'The model list could not be read, so only auto can be chosen.',
			// ── Summarization fallback chain and reserve ──────────────────
			headroom: 'Reserve (tokens)',
			headroomHint: 'blank inherits the layer below',
			fallback: 'Fallback chain',
			fallbackOrder: 'Tried in order: strongest free → weaker free → paid. Empty means no retry.',
			fallbackNone: 'No fallback route yet. A failing primary aborts the compaction.',
			fallbackPick: 'Choose a route…',
			fallbackAdd: 'Add',
			fallbackRemove: 'Remove',
			fallbackUp: 'Move up',
			fallbackDown: 'Move down',
			fallbackNoChoices: 'No further route can be added (not the primary, and no repeats).',
			// ── Policy layers (global default / per provider / per model) ──
			layer: 'Policy layer',
			layerRemove: 'Remove this layer',
			layerAdd: 'Add a per-provider override',
			layerAddButton: 'Add',
			layerAddHint: 'The fields below edit the selected layer; a blank field inherits the layer under it.',
			layerRoute: 'Provider route id',
			layerPick: 'Choose a provider…',
			layerOther: 'Type a route id…',
			// ── In-session policy indicator ──────────────────────────────
			badgeOff: 'Compaction off',
			badgeAria: 'Current compaction policy',
			badgeTitle: 'Compaction policy for this session',
			badgeUnknown: 'policy unreadable',
			badgeUnknownHint: 'This browser cannot read the host policy (it is not loopback, so dsh gives it a memory-only view), so the badge stops guessing numbers. Check the real threshold from the host at 127.0.0.1.',
			pEffective: 'Effective',
			pLayerDefault: 'Global default',
			pLayerProvider: 'Per provider',
			pLayerModel: 'Per model',
			pLayerEngine: 'Engine default (no layer sets it)',
			pUser: 'yours',
			pThreshold: 'Threshold',
			pThresholdHint: 'Compact once the context reaches this share of the window',
			pRetain: 'Retained tail',
			pRetainHint: 'Recent content kept verbatim across a compaction',
			pGap: 'Compactable room',
			pGapWarn: 'Too little room between the trigger and the retained tail for a summary to be shorter than the region it replaces: the compaction would be rejected and the trigger would fire again. Leave at least 8K.',
			pSummary: 'Summarization model',
			pFallback: 'Model fallback chain',
			pFallbackHint: 'tried in order when the primary fails, spending free quota before paid credit',
			pFallbackNone: 'none (a failing primary aborts the compaction)',
			pEffort: 'Summarization thinking',
			pEffortHint: 'the summary only compresses text already in context, so it need not think',
			pEffortFixed: 'off (fixed)',
			pMaxTokens: 'Summary cap',
			pMaxTokensUnit: 'tokens',
			pWindow: 'Context window',
			pWindowUnknown: 'this session has not reported a window yet (no request sent)',
			pTriggerAt: 'fires at',
			pAuto: 'Automatic compaction',
			pOn: 'on',
			pOff: 'off',
			pOffHint: 'Automatic compaction is off; a long session will run into the model window.',
			pUnits: 'tokens',
			pModelAuto: 'auto (reuse this session’s model)',
			pTarget: 'Applies to',
			pTargetNone: 'no route known for this session yet; showing the global default',
			pEdit: 'Edit it in Settings → Models → Compaction policy, or in settings.yaml.',
			// ── The last compaction: who did it, which route wrote it ──────
			lastSummary: 'Last summary',
			lastSummaryNone: 'no compaction yet',
			lastSummaryHint: 'the route that actually wrote the most recent summary — once the fallback chain succeeds it is the route that won, which need not be the one the policy names.',
			lastManual: 'manual',
			lastAuto: 'automatic',
			lastCount: 'compacted',
			lastTokens: 'tokens',
		};

		/**
		 * Shared config-card kit (`cc*` classes) — the plugin-form layout vocabulary
		 * for settings pages, expressed only in `--dsw-alias-*` theme tokens.
		 *
		 * Provenance: grown inside dsh-compaction-policy-engine's card, promoted to the
		 * shared standard (WorkSpaces/ui-unification-plan-2026-10-26.md). This exact
		 * text is vendored into every hand-written client that renders a config
		 * card; `plugin-devkit/ui-kit/check.mjs` fails when a copy drifts. The
		 * injector is idempotent on the shared `data-plugin-css="dsh-ui-kit"` id, so
		 * the first client to boot owns the single <style> tag and the rest no-op —
		 * no plugin may grow a runtime dependency on another plugin's stylesheet.
		 */
		const UI_KIT_CSS = [
			'.ccWrap{display:flex;flex-direction:column;gap:8px;padding:12px 0}',
			'.ccTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}',
			'.ccHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
			'.ccRow{display:flex;align-items:center;gap:10px}',
			'.ccLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:13px}',
			'.ccInput{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;width:104px;font-size:13px;font-variant-numeric:tabular-nums}',
			'.ccInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
			'.ccInputInvalid{border-color:var(--dsw-alias-label-error)}',
			'.ccInputWide{width:170px}',
			'.ccReset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px}',
			'.ccReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
			'.ccReset:disabled{cursor:default;opacity:.5}',
			'.ccError{color:var(--dsw-alias-label-error);margin:0;font-size:12px}',
			'.ccReadonly{color:var(--dsw-alias-label-secondary);font-size:13px}',
			'.ccSelect{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 8px;max-width:240px;font-size:13px;cursor:pointer}',
			'.ccSelect:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
			'.ccSelect:disabled{cursor:default;opacity:.6}',
			'.ccCheck{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none;margin:0}',
			'.ccSubHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5;padding-left:26px}',
			'.ccList{margin:0;padding-left:1.2em;max-height:9em;overflow:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
			// 回退链是一张有序表，缩进让它读起来像“主模型之下的第 1、2、3 选择”，
			// 而不是一组与阈值平级的设置。
			'.ccChain{display:flex;flex-direction:column;gap:6px;border-left:2px solid var(--dsw-alias-border-l4);padding-left:10px;margin:4px 0}',
			'.ccChainRow{gap:8px}',
			'.ccChainIndex{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:14px}',
			'.ccChainValue{flex:1;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		].join('');

		if (
			typeof document !== 'undefined' &&
			document.querySelector('style[data-plugin-css="dsh-ui-kit"]') === null
		) {
			const uiKitTag = document.createElement('style');
			uiKitTag.dataset.pluginCss = 'dsh-ui-kit';
			uiKitTag.textContent = UI_KIT_CSS;
			document.head.appendChild(uiKitTag);
		}

		/** Session-header badge and flyout — compaction-specific surfaces, stay with this plugin. */
		const css = [
			// ── 会话头部指示器 ────────────────────────────────────────────
			'.ccbRoot{display:inline-flex;position:relative;align-items:center}',
			'.ccbBadge{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;background:0 0;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}',
			'.ccbBadge:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.ccbBadge:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
			'.ccbDot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-brand-primary);flex:none}',
			'.ccbOff{background:var(--dsw-alias-label-tertiary)}',
			'.ccbStrong{color:var(--dsw-alias-label-primary);font-weight:500}',
			// The badge's second segment: the route that actually wrote the last
			// summary. Muted and clipped, because it is the answer to a question the
			// operator asks *after* a compaction, not the state they read every time
			// they look up — the policy headline beside it stays the primary face.
			'.ccbLast{color:var(--dsw-alias-label-tertiary);font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.ccbPanel{position:absolute;top:calc(100% + 8px);right:0;z-index:100;box-sizing:border-box;width:286px;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);border:0;border-radius:12px;padding:12px;font-size:12px;line-height:18px;text-align:left}',
			'.ccbTitle{margin:0 0 2px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}',
			'.ccbTarget{margin:0 0 10px;color:var(--dsw-alias-label-tertiary);font-size:11px;word-break:break-all}',
			'.ccbRows{margin:0;display:flex;flex-direction:column;gap:6px}',
			'.ccbRow{display:flex;align-items:baseline;gap:8px}',
			'.ccbKey{color:var(--dsw-alias-label-secondary);flex:none;min-width:78px}',
			'.ccbVal{margin-left:auto;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;text-align:right}',
			'.ccbHint{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:0}',
			'.ccbSrc{color:var(--dsw-alias-label-tertiary);font-size:11px}',
			'.ccbWarn{color:var(--dsw-alias-label-error);margin:8px 0 0;font-size:11px}',
			'.ccbFoot{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}',
		].join('');

		if (
			typeof document !== 'undefined' &&
			document.querySelector('style[data-plugin-css="dsh-compaction-policy-engine"]') === null
		) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-compaction-policy-engine';
			tag.dataset.pluginCss = 'dsh-compaction-policy-engine';
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/**
		 * Whether a staged budget is neither a ratio in (0, 1) nor a whole token
		 * count. Blank means "inherit", which is always valid.
		 *
		 * The two units are told apart by shape rather than by a separate control:
		 * a value below 1 can only be a ratio, and a whole number of 1 or more can
		 * only be a token count. That keeps one input per setting — the same shape
		 * the setting has in `settings.yaml`.
		 */
		function budgetInvalid(text) {
			if (text === '') return false;
			const value = Number(text);
			if (Number.isNaN(value)) return true;
			if (value > 0 && value < 1) return false;
			return !Number.isInteger(value) || value < 1;
		}

		/** Which unit a staged value is written in. */
		function unitOf(text) {
			const value = Number(text);
			return Number.isInteger(value) && value >= 1 ? 'tokens' : 'ratio';
		}

		/**
		 * One numeric policy field.
		 *
		 * Renders the effective value and whether the user layer overrides it,
		 * and reports edits upward. It never writes: the card owns the single
		 * commit point, so a half-typed number cannot reach the document.
		 */
		function RatioField(props) {
			const { label, text, overridden, placeholder, invalid, disabled, onEdit, onReset, t } = props;
			return jsx.jsxs('div', {
				className: 'ccRow',
				children: [
					jsx.jsx('label', { className: 'ccLabel', children: label }),
					overridden
						? jsx.jsx('button', { type: 'button', className: 'ccReset', disabled, onClick: onReset, children: t('reset') })
						: null,
					jsx.jsx('input', {
						className: invalid ? 'ccInput ccInputInvalid' : 'ccInput',
						inputMode: 'decimal',
						value: text,
						placeholder: placeholder,
						disabled,
						'aria-label': label,
						onChange: (event) => onEdit(event.target.value),
					}),
				],
			});
		}

		/**
		 * Every key a policy layer can carry.
		 *
		 * Used by "remove this layer": the settings document has no
		 * "delete this mapping" op, so removing a layer means unsetting each of
		 * its fields. Listing them here — rather than only the fields this card
		 * renders — is what makes the button mean what it says for a layer
		 * hand-written with `compactionRetries` and the like.
		 */
		const LAYER_KEYS = [
			'threshold',
			'thresholdTokens',
			'retain',
			'retainTokens',
			'headroomTokens',
			'maxTokens',
			'summarizationModel',
			'summarizationFallback',
			'compactionRetries',
			'maxOverflowRetries',
		];

		/**
 * The compaction policy card: the three override layers (global / per-provider /
 * per-model), each editable in either unit, with the effective value per routed
 * model shown as the host would resolve it.
 */
		function CompactionCard(props) {
			const { t, provider, useScope, useCatalog } = props;
			const snapshot = useScope((value) => value);
			const catalog = useCatalog();
			const [draft, setDraft] = react.useState({});
			const [error, setError] = react.useState(null);
			/**
			 * The layer the fields below edit; `null` is the global default.
			 *
			 * A `provider` prop, when the host ever supplies one, only picks the
			 * starting layer — the selector can still move away from it.
			 */
			const [layer, setLayer] = react.useState(provider?.id ?? null);
			/** Routes added in this session that the document does not carry yet. */
			const [added, setAdded] = react.useState([]);
			/** The route staged in the add control. */
			const [candidate, setCandidate] = react.useState('');
			/** The fallback route staged in the chain's add control. */
			const [candidateSelection, setCandidateSelection] = react.useState('');

			const resolvedProviders = snapshot?.value?.providers ?? {};
			const userProviders = snapshot?.user?.providers ?? {};
			/** Every route with a layer, plus the ones added in this session. */
			const routes = [...new Set([...Object.keys(resolvedProviders), ...Object.keys(userProviders), ...added])];
			const userKeysOf = (id) => Object.keys(userProviders[id] ?? {});

			const layerPath = layer === null ? ['default'] : ['providers', layer];
			const resolved = (layer === null ? snapshot?.value?.default : resolvedProviders[layer]) ?? {};
			const user = (layer === null ? snapshot?.user?.default : userProviders[layer]) ?? {};
			/**
			 * What a cleared field falls back to: the composition's own document for
			 * this namespace (`base`) — where the deployment states
			 * `default.threshold`/`default.retain`.
			 *
			 * The hints used to be the plugin's schema defaults (0.8/0.16), which only
			 * apply to a host that declares nothing. On this host, which declares 0.6,
			 * they advertised a number nothing like the effective trigger while the
			 * card's own copy ("blank inherits the deployment default") made it read
			 * as the real one.
			 */
			const base = (layer === null ? snapshot?.base?.default : snapshot?.base?.providers?.[layer]) ?? {};
			const baseText = (field, fallback) => {
				const raw = base[`${field}Tokens`] ?? base[field];
				return typeof raw === 'number' ? String(raw) : fallback;
			};

			/**
			 * A remote browser is a `memory` client: the host never gives it the
			 * settings document and never accepts a write from it — by design, since
			 * the config plane has no authentication. Saying so plainly is the
			 * difference between "your threshold is 0.8" and "this browser cannot see
			 * your threshold".
			 */
			const locked = snapshot?.mode === 'memory' || snapshot?.status === 'unavailable';

			/**
			 * Move to another layer, discarding staged edits.
			 *
			 * A draft belongs to the layer it was typed on; carrying it over
			 * would silently write one layer's number into another.
			 */
			const selectLayer = (next) => {
				setDraft({});
				setError(null);
				setLayer(next);
			};

			const addLayer = (id) => {
				const route = id.trim();
				if (route === '') return;
				if (!routes.includes(route)) setAdded((current) => [...current, route]);
				setCandidate('');
				selectLayer(route);
			};

			/**
			 * Remove the selected route layer from the user document.
			 *
			 * Only the user layer: a route the *composition* declares stays, and
			 * the card then shows its inherited values again — which is the
			 * point of the button, not a failure.
			 */
			const removeLayer = async () => {
				if (layer === null) return;
				setError(null);
				const ops = LAYER_KEYS.map((key) => ({ op: 'unset', path: [...layerPath, key] }));
				try {
					if (!(await props.mutate(ops))) throw new Error(t('writeRefused'));
					setDraft({});
					setAdded((current) => current.filter((entry) => entry !== layer));
					setLayer(null);
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				}
			};

			/**
			 * The two keys one budget field can be stored under.
			 *
			 * A layer states a budget in one unit only — a ratio or an absolute
			 * token count — so an edit that changes the unit has to remove the
			 * form it replaces in the same commit. That keeps the file honest;
			 * the *merged* document can still carry both, because the settings
			 * provider overlays the user section on the composition base.
			 */
			const formsOf = (field) => [field, `${field}Tokens`];

			/**
			 * Effective text for a field: the draft wins, then the resolved layer.
			 *
			 * Within a layer the token form is the effective one, matching the
			 * host's own precedence (`pickForm`) — so the number the card shows is
			 * the number the engine acts on even when the composition base left a
			 * ratio of the same setting in the merged document.
			 */
			const textOf = (field) => {
				if (draft[field] !== undefined) return draft[field];
				const raw = resolved[`${field}Tokens`] ?? resolved[field];
				return typeof raw === 'number' ? String(raw) : '';
			};

			/** Whether the user layer overrides this field in either unit. */
			const overriddenOf = (field) => formsOf(field).some((key) => user[key] !== undefined);

			/**
			 * Move one chain entry one position, returning a new array.
			 *
			 * The chain's order *is* its meaning — strongest free first, paid last —
			 * so reordering has to be a first-class edit rather than "remove and
			 * re-add", which would also silently move the entry to the weakest slot.
			 *
			 * @param entries - the current chain.
			 * @param index - the entry to move.
			 * @param delta - -1 for one step earlier, +1 for one step later.
			 * @returns the reordered chain.
			 */
			const moveIn = (entries, index, delta) => {
				const next = [...entries];
				const [moved] = next.splice(index, 1);
				next.splice(index + delta, 0, moved);
				return next;
			};

			const thresholdInvalid = budgetInvalid(textOf('threshold'));
			const retainInvalid = budgetInvalid(textOf('retain'));
			// Only comparable within one unit: 200000 and 0.2 are not ordered by
			// magnitude, so a mixed pair is left for the host, which compares them
			// in tokens once it has the window.
			const ordering =
				!thresholdInvalid &&
				!retainInvalid &&
				textOf('threshold') !== '' &&
				textOf('retain') !== '' &&
				unitOf(textOf('threshold')) === unitOf(textOf('retain')) &&
				Number(textOf('retain')) >= Number(textOf('threshold'));
			const blocked = thresholdInvalid || retainInvalid || ordering;
			const dirty = Object.keys(draft).length > 0;

			/**
			 * Commit staged edits.
			 *
			 * One `mutate` rather than per-field writes, for two reasons: clearing
			 * an override must *remove* the key rather than write a value the user
			 * never chose, and a threshold change that also moves `retain` must
			 * land atomically — otherwise the intermediate document is one the
			 * host resolver rejects.
			 */
			const commit = async () => {
				if (blocked) return;
				const ops = [];
				for (const field of ['threshold', 'retain']) {
					const text = draft[field];
					if (text === undefined) continue;
					const forms = formsOf(field);
					const keep = text === '' ? undefined : unitOf(text) === 'tokens' ? forms[1] : forms[0];
					for (const key of forms) {
						if (key === keep) ops.push({ op: 'set', path: [...layerPath, key], value: Number(text) });
						// The other unit is removed even when this layer does not
						// currently state it: it may come from the composition base,
						// where leaving it would make the merged layer ambiguous.
						else ops.push({ op: 'unset', path: [...layerPath, key] });
					}
				}
				if (draft.maxTokens !== undefined) {
					const text = draft.maxTokens;
					if (text === '') ops.push({ op: 'unset', path: [...layerPath, 'maxTokens'] });
					else ops.push({ op: 'set', path: [...layerPath, 'maxTokens'], value: Number(text) });
				}
				if (draft.headroomTokens !== undefined) {
					const text = draft.headroomTokens;
					// Blank removes the key rather than storing 0: 0 is a real policy
					// ("no reserve"), while blank means "inherit the layer below".
					if (text === '') ops.push({ op: 'unset', path: [...layerPath, 'headroomTokens'] });
					else ops.push({ op: 'set', path: [...layerPath, 'headroomTokens'], value: Number(text) });
				}
				if (draft.summarizationModel !== undefined) {
					// `auto` is a real stored value, not an absence: writing it back is
					// what lets the user return to inheriting the conversation model
					// without also losing the explicit override they had chosen before.
					ops.push({ op: 'set', path: [...layerPath, 'summarizationModel'], value: draft.summarizationModel });
				}
				if (draft.summarizationFallback !== undefined) {
					// An emptied chain is unset, not stored as `[]`: the host resolver
					// treats a missing field as "no fallback" and an empty list the same,
					// but leaving `[]` in the file would make the layer look like it
					// overrides the chain when it means to inherit one.
					if (draft.summarizationFallback.length === 0) ops.push({ op: 'unset', path: [...layerPath, 'summarizationFallback'] });
					else ops.push({ op: 'set', path: [...layerPath, 'summarizationFallback'], value: [...draft.summarizationFallback] });
				}
				// The automatic-compaction switch is a *root* field shared by every
				// layer, so it is written once at the document root rather than into
				// the per-route layer the other rows edit.
				if (draft.auto !== undefined) ops.push({ op: 'set', path: ['auto'], value: draft.auto });
				if (ops.length === 0) return setDraft({});
				setError(null);
				try {
					if (!(await props.mutate(ops))) throw new Error(t('writeRefused'));
					setDraft({});
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				}
			};

			/**
			 * The fields that exist in two units, and so have two keys to clear.
			 *
			 * Only these may be expanded through `formsOf`. Applying it to every
			 * reset produced a bogus sibling for each single-unit field — resetting
			 * `maxTokens` also unset `maxTokensTokens`, and a chain reset would unset
			 * `summarizationFallbackTokens`. Unsetting a key that cannot exist is not
			 * harmless: it writes a path into the operator's document that the host
			 * resolver then has to reject or ignore.
			 */
			const UNIT_PAIRED = new Set(['threshold', 'retain']);

			const resetField = async (field) => {
				setError(null);
				// Both units, because either may be the one this layer states.
				const keys = UNIT_PAIRED.has(field) ? formsOf(field) : [field];
				const ops = keys.map((key) => ({ op: 'unset', path: [...layerPath, key] }));
				try {
					if (!(await props.mutate(ops))) throw new Error(t('writeRefused'));
					setDraft((current) => {
						const next = { ...current };
						delete next[field];
						return next;
					});
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				}
			};

			/**
			 * Edit the staged fallback chain.
			 *
			 * Staged rather than written: the chain is one array, so adding three
			 * routes should be one commit — three writes would put the document
			 * through two intermediate states, and each is a chain the host resolver
			 * could reject (a chain whose first entry is the primary route, say).
			 *
			 * @param change - receives the current chain, returns the next one.
			 */
			const editChain = (change) => setDraft((current) => ({ ...current, summarizationFallback: change(current.summarizationFallback ?? chain) }));

			const model = resolved.summarizationModel;
			// 与同组件的 chain / autoShown 一致：草稿优先，否则回读 resolved。
			// 这样用户刚选中的值会立刻回显，且 resetField 删除草稿后仍会回到 resolved。
			const modelText = draft.summarizationModel ?? (model === undefined || model === '' ? 'auto' : model);
			/**
			 * The fallback chain shown in the editor: the draft while one is staged,
			 * otherwise the layer's resolved chain.
			 *
			 * Resolved (not just the user layer) so the row shows the chain this target
			 * will actually use, which is the whole point of showing it at all.
			 */
			const chain = draft.summarizationFallback ?? resolved.summarizationFallback ?? [];
			const autoEnabled = snapshot?.value?.auto !== false;
			const draftedAuto = draft.auto;
			const autoShown = draftedAuto === undefined ? autoEnabled : draftedAuto;

			/**
			 * The catalog's flat `provider/model` options.
			 *
			 * A group with no models still contributes its provider: an empty
			 * catalog is a route that can serve, and a route the user configured
			 * a summarization model for must not silently vanish from the list.
			 * The value's shape is the same one `policy.js` validates
			 * (`assertModelRef`), so the picker cannot produce a document the
			 * host rejects.
			 */
			const options = [];
			for (const group of catalog?.groups ?? []) {
				for (const entry of group.models ?? []) options.push({ value: `${group.id}/${entry.id}`, label: `${group.name} · ${entry.name}` });
				if ((group.models ?? []).length === 0) options.push({ value: `${group.id}/`, label: group.name, disabled: true });
			}

			/**
			 * Routes the catalog knows that have no layer yet.
			 *
			 * The same catalog the model picker reads, so a route offered here
			 * is one this host can actually serve. While it is still loading —
			 * or when it cannot be read at all — the control falls back to a
			 * free-text id, because "the catalog failed" must not mean "you
			 * cannot configure a provider".
			 */
			const routeChoices = (catalog?.groups ?? [])
				.map((group) => ({ id: group.id, label: group.name ?? group.id }))
				.filter((choice) => !routes.includes(choice.id));
			const stagedRoute = candidate.trim();

			/**
			 * The route the primary summarization call will use, when this card can
			 * know it.
			 *
			 * An explicit `summarizationModel` names it outright. Under `auto` the
			 * primary is the *conversation's* routed model, which this settings card
			 * has no way to read — so the filter below is simply absent, and the host
			 * resolver stays the authority: it rejects a chain entry naming the
			 * resolved primary, and this card surfaces that as a save error. Hiding
			 * routes on a guess would be worse than letting the host speak.
			 */
			const primaryRoute = modelText === 'auto' ? undefined : modelText;
			/** Catalog routes a chain entry may name: not the known primary, not already in the chain. */
			const chainChoices = options.filter((option) => option.value !== primaryRoute && !chain.includes(option.value));
			const stagedChainEntry = candidateSelection.trim();
			const stagedChainValid =
				stagedChainEntry.length > 0 && stagedChainEntry !== primaryRoute && !chain.includes(stagedChainEntry);

			return jsx.jsxs('div', {
				className: 'ccWrap',
				children: [
					jsx.jsx('span', { className: 'ccTitle', children: t('title') }),
					jsx.jsx('p', { className: 'ccHint', children: t('hint') }),
					locked ? jsx.jsx('p', { className: 'ccError', children: t('memoryNote') }) : null,
					jsx.jsxs('div', {
						className: 'ccRow',
						children: [
							jsx.jsx('input', {
								type: 'checkbox',
								className: 'ccCheck',
								checked: autoShown,
								'aria-label': t('enable'),
								disabled: locked,
								onChange: (event) => setDraft((current) => ({ ...current, auto: event.target.checked })),
							}),
							jsx.jsx('span', { className: 'ccLabel', children: t('enable') }),
						],
					}),
					autoShown ? null : jsx.jsx('p', { className: 'ccSubHint', children: t('enableHint') }),
					jsx.jsxs('div', {
						className: 'ccRow',
						children: [
							jsx.jsx('span', { className: 'ccLabel', children: t('layer') }),
							layer !== null && userKeysOf(layer).length > 0
								? jsx.jsx('button', {
										type: 'button',
										className: 'ccReset',
										onClick: () => void removeLayer(),
										children: t('layerRemove'),
									})
								: null,
							jsx.jsxs('select', {
								className: 'ccSelect',
								'aria-label': t('layer'),
								value: layer ?? '',
								onChange: (event) => selectLayer(event.target.value === '' ? null : event.target.value),
								children: [
									jsx.jsx('option', { value: '', children: t('pLayerDefault') }),
									routes.map((id) =>
										jsx.jsx(
											'option',
											{
												value: id,
												children: userKeysOf(id).length > 0 ? `${id} · ${t('pUser')}` : id,
											},
											id,
										),
									),
								],
							}),
						],
					}),
					jsx.jsxs('div', {
						className: 'ccRow',
						children: [
							jsx.jsx('span', { className: 'ccLabel', children: t('layerAdd') }),
							routeChoices.length > 0
								? jsx.jsxs('select', {
										className: 'ccSelect',
										'aria-label': t('layerAdd'),
										value: '',
										onChange: (event) => addLayer(event.target.value),
										children: [
											jsx.jsx('option', { value: '', children: t('layerPick') }),
											routeChoices.map((choice) =>
												jsx.jsx('option', { value: choice.id, children: choice.label }, choice.id),
											),
										],
									})
								: jsx.jsx('input', {
										className: 'ccInput ccInputWide',
										placeholder: t('layerRoute'),
										value: candidate,
										'aria-label': t('layerAdd'),
										onChange: (event) => setCandidate(event.target.value),
									}),
							jsx.jsx('button', {
								type: 'button',
								className: 'ccReset',
								disabled: stagedRoute === '',
								onClick: () => addLayer(stagedRoute),
								children: t('layerAddButton'),
							}),
						],
					}),
					jsx.jsx('p', { className: 'ccSubHint', children: t('layerAddHint') }),
					jsx.jsx(RatioField, {
						label: t('threshold'),
						text: textOf('threshold'),
						overridden: overriddenOf('threshold'),
						placeholder: baseText('threshold', '0.8'),
						disabled: locked,
						invalid: thresholdInvalid,
						onEdit: (text) => setDraft((current) => ({ ...current, threshold: text })),
						onReset: () => void resetField('threshold'),
						t,
					}),
					jsx.jsx(RatioField, {
						label: t('retain'),
						text: textOf('retain'),
						overridden: overriddenOf('retain'),
						placeholder: baseText('retain', '0.16'),
						disabled: locked,
						invalid: retainInvalid || ordering,
						onEdit: (text) => setDraft((current) => ({ ...current, retain: text })),
						onReset: () => void resetField('retain'),
						t,
					}),
					jsx.jsx(RatioField, {
						label: t('maxTokens'),
						text: textOf('maxTokens'),
						overridden: user.maxTokens !== undefined,
						placeholder: baseText('maxTokens', '8192'),
						disabled: locked,
						invalid: false,
						onEdit: (text) => setDraft((current) => ({ ...current, maxTokens: text })),
						onReset: () => void resetField('maxTokens'),
						t,
					}),
					jsx.jsx(RatioField, {
						label: t('headroom'),
						text: draft.headroomTokens ?? (typeof resolved.headroomTokens === 'number' ? String(resolved.headroomTokens) : ''),
						overridden: user.headroomTokens !== undefined,
						placeholder: t('headroomHint'),
						disabled: locked,
						invalid: draft.headroomTokens !== undefined && draft.headroomTokens !== '' && !/^\d+$/.test(draft.headroomTokens),
						onEdit: (text) => setDraft((current) => ({ ...current, headroomTokens: text })),
						onReset: () => void resetField('headroomTokens'),
						t,
					}),
					jsx.jsxs('div', {
						className: 'ccRow',
						children: [
							jsx.jsx('span', { className: 'ccLabel', children: t('model') }),
							user.summarizationModel !== undefined
								? jsx.jsx('button', { type: 'button', className: 'ccReset', onClick: () => void resetField('summarizationModel'), children: t('reset') })
								: null,
							jsx.jsxs('select', {
								className: 'ccSelect',
								'aria-label': t('model'),
								disabled: locked,
								value: modelText,
								onChange: (event) => {
									const value = event.target.value;
									setDraft((current) => ({ ...current, summarizationModel: value }));
								},
								children: [
									jsx.jsx('option', { value: 'auto', children: t('modelAuto') }),
									options.map((option) =>
										jsx.jsx('option', { value: option.value, disabled: option.disabled, children: option.label }, option.value),
									),
									// A stored model whose route has since disappeared must stay
									// selectable, otherwise merely opening the card would look like
									// an edit and saving would silently drop the operator's choice.
									options.some((option) => option.value === modelText) || modelText === 'auto'
										? null
										: jsx.jsx('option', { value: modelText, children: `${modelText}（${t('modelEmpty')}）` }),
								],
							}),
						],
					}),
					catalog === undefined ? null : jsx.jsx('p', { className: 'ccSubHint', children: t('modelLoading') }),
					// ── 摘要模型的 fallback 链 ────────────────────────────────
					// 顺序即语义：从强到弱依次尝试，最强的免费大模型在前、收费的在后。
					// 单向不可逆，所以每一行都给出上移/下移，而不是只让用户删了重加。
					jsx.jsxs('div', {
						className: 'ccChain',
						children: [
							jsx.jsxs('div', {
								className: 'ccRow',
								children: [
									jsx.jsx('span', { className: 'ccLabel', children: t('fallback') }),
									jsx.jsx('span', { className: 'ccSubHint', children: t('fallbackOrder') }),
									user.summarizationFallback !== undefined
										? jsx.jsx('button', { type: 'button', className: 'ccReset', onClick: () => void resetField('summarizationFallback'), children: t('reset') })
										: null,
								],
							}),
							chain.length === 0 ? jsx.jsx('p', { className: 'ccSubHint', children: t('fallbackNone') }) : null,
							chain.map((entry, index) =>
								jsx.jsxs(
									'div',
									{
										className: 'ccRow ccChainRow',
										children: [
											jsx.jsx('span', { className: 'ccChainIndex', children: String(index + 1) }),
											jsx.jsx('span', { className: 'ccChainValue', children: entry }),
											jsx.jsx('button', {
												type: 'button',
												className: 'ccReset',
												disabled: locked || index === 0,
												'aria-label': t('fallbackUp'),
												onClick: () => editChain((current) => moveIn(current, index, -1)),
												children: '↑',
											}),
											jsx.jsx('button', {
												type: 'button',
												className: 'ccReset',
												disabled: locked || index === chain.length - 1,
												'aria-label': t('fallbackDown'),
												onClick: () => editChain((current) => moveIn(current, index, 1)),
												children: '↓',
											}),
											jsx.jsx('button', {
												type: 'button',
												className: 'ccReset',
												disabled: locked,
												'aria-label': t('fallbackRemove'),
												onClick: () => editChain((current) => current.filter((_, position) => position !== index)),
												children: t('fallbackRemove'),
											}),
										],
									},
									`${entry}-${index}`,
								),
							),
							jsx.jsxs('div', {
								className: 'ccRow',
								children: [
									jsx.jsxs('select', {
										className: 'ccSelect',
										'aria-label': t('fallbackAdd'),
										disabled: locked || chainChoices.length === 0,
										value: candidateSelection,
										onChange: (event) => setCandidateSelection(event.target.value),
										children: [
											jsx.jsx('option', { value: '', children: t('fallbackPick') }),
											chainChoices.map((option) =>
												jsx.jsx('option', { value: option.value, children: option.label }, option.value),
											),
										],
									}),
									jsx.jsx('button', {
										type: 'button',
										className: 'ccReset',
										disabled: locked || !stagedChainValid,
										onClick: () => {
											editChain((current) => [...current, stagedChainEntry]);
											setCandidateSelection('');
										},
										children: t('fallbackAdd'),
									}),
								],
							}),
							chainChoices.length === 0 ? jsx.jsx('p', { className: 'ccSubHint', children: t('fallbackNoChoices') }) : null,
						],
					}),
					thresholdInvalid || retainInvalid
						? jsx.jsx('p', { className: 'ccError', children: t('invalid') })
						: ordering
							? jsx.jsx('p', { className: 'ccError', children: t('retainAbove') })
							: null,
					error === null ? null : jsx.jsx('p', { className: 'ccError', children: error }),
					!dirty
						? null
						: jsx.jsx('button', {
								type: 'button',
								className: 'ccReset',
								disabled: blocked || locked,
								onClick: () => void commit(),
								children: t('save'),
							}),
				],
			});
		}

		// ── 会话头部指示器：当前会话正在跑什么压缩策略 ─────────────────────
		//
		// Inlined view of `lib/client-policy.js`: this file is served verbatim and
		// cannot `import`. `test/client-policy.test.js` extracts these declarations and
		// asserts they match the module AND agree with the host's `policy.js`, so this
		// cannot silently drift from what the engine resolves.

		/** The literal `auto` sentinel, meaning "inherit the conversation's own model". */
		const AUTO = 'auto';

		/** `compaction-basic`'s own default trigger ratio, shown when no layer states one. */
		const ENGINE_DEFAULT_THRESHOLD = 0.8;

		/** `compaction-basic`'s own default retention ratio. */
		const ENGINE_DEFAULT_RETAIN = 0.16;

		/**
		 * Minimum room a compaction must free, mirrored from the host's
		 * `policy.js` (which cannot be imported here — this bundle is served
		 * verbatim and has no module graph). The panel states the shortfall
		 * instead of leaving the operator to infer it from two numbers.
		 */
		const MIN_COMPACT_GAP_TOKENS = 8192;

		function isPlainObject(value) {
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		}

		function routeOf(modelSelection) {
			const candidate = modelSelection?.lastUsed ?? modelSelection?.next;
			if (!isPlainObject(candidate)) return undefined;
			const { provider, model } = candidate;
			if (typeof provider !== 'string' || provider.length === 0) return undefined;
			if (typeof model !== 'string' || model.length === 0) return undefined;
			return { provider, model };
		}

		function layersOf(value, user, target) {
			const override = Array.isArray(value?.models)
				? value.models.find((entry) => entry?.provider === target?.provider && entry?.model === target?.model)
				: undefined;
			const userOverride = Array.isArray(user?.models)
				? user.models.find((entry) => entry?.provider === target?.provider && entry?.model === target?.model)
				: undefined;
			const routeName = target?.provider;
			const route = routeName === undefined ? undefined : value?.providers?.[routeName];
			const userRoute = routeName === undefined ? undefined : user?.providers?.[routeName];
			return {
				routeName,
				layers: [
					{ kind: 'model', layer: override, user: userOverride !== undefined },
					{ kind: 'provider', layer: route, user: userRoute !== undefined },
					{ kind: 'default', layer: value?.default, user: user?.default !== undefined },
				],
			};
		}

		function resolveView(value, user, target) {
			const { routeName, layers } = layersOf(value, user, target);
			const pick = (field) => {
				for (const candidate of layers) {
					const declared = candidate.layer?.[field];
					if (declared !== undefined) {
						return { value: declared, source: candidate.kind, overridden: candidate.user };
					}
				}
				return { value: undefined, source: 'engine', overridden: false };
			};
			/** The winning declaration of a field that may be stated in either unit. */
			const pickForm = (ratioKey, tokensKey) => {
				for (const candidate of layers) {
					const layer = candidate.layer;
					if (layer === undefined) continue;
					if (layer[tokensKey] !== undefined) {
						return { value: layer[tokensKey], unit: 'tokens', source: candidate.kind, overridden: candidate.user };
					}
					if (layer[ratioKey] !== undefined) {
						return { value: layer[ratioKey], unit: 'ratio', source: candidate.kind, overridden: candidate.user };
					}
				}
				return { value: undefined, unit: 'ratio', source: 'engine', overridden: false };
			};

			const threshold = pickForm('threshold', 'thresholdTokens');
			const retain = pickForm('retain', 'retainTokens');
			const maxTokens = pick('maxTokens');
			const summarization = pick('summarizationModel');
			const fallback = pick('summarizationFallback');
			// Its own field, not a second name for the derived `gapTokens` below: this is
			// the engine's reserve *below the threshold*, and an operator who set it needs
			// to see it. The gap is computed from the two budgets and means something else
			// entirely, which is why the derived one was renamed.
			const headroom = pick('headroomTokens');

			return {
				target,
				routeName,
				auto: value?.auto !== false,
				thresholdRatio: threshold.unit === 'ratio' ? threshold.value : undefined,
				retainRatio: retain.unit === 'ratio' ? retain.value : undefined,
				thresholdTokens: threshold.unit === 'tokens' ? threshold.value : undefined,
				retainTokens: retain.unit === 'tokens' ? retain.value : undefined,
				/** The winning declarations themselves, units included. */
				declared: { threshold, retain },
				maxTokens: maxTokens.value,
				summarizationModel: summarization.value ?? AUTO,
				/** The winning layer's ordered chain, or empty when no layer states one. */
				summarizationFallback: fallback.value ?? [],
				headroomTokens: headroom.value,
				source: {
					threshold: threshold.source,
					retain: retain.source,
					maxTokens: maxTokens.source,
					summarizationModel: summarization.source,
					summarizationFallback: fallback.source,
					headroomTokens: headroom.source,
				},
				/** Per-field provenance, including whether the user layer stated it. */
				fields: {
					threshold,
					retain,
					maxTokens,
					summarizationModel: summarization,
					summarizationFallback: fallback,
					headroomTokens: headroom,
				},
				/** Whether any layer for this target came from the user document. */
				overridden: layers.some((candidate) => candidate.user),
			};
		}

		function budgetsOf(view, contextWindow) {
			const window = typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? contextWindow : undefined;
			const tokensOf = (absolute, ratio, fallbackRatio) => {
				if (typeof absolute === 'number') return absolute;
				if (window === undefined) return null;
				const effective = typeof ratio === 'number' ? ratio : fallbackRatio;
				return Math.floor(window * effective);
			};
			const thresholdTokens = tokensOf(view.thresholdTokens, view.thresholdRatio, ENGINE_DEFAULT_THRESHOLD);
			const retainTokens = tokensOf(view.retainTokens, view.retainRatio, ENGINE_DEFAULT_RETAIN);
			return {
				thresholdTokens,
				retainTokens,
				/**
				 * What a compaction would free. Below `MIN_COMPACT_GAP_TOKENS` the summary can
				 * end up no smaller than what it replaces, so the view says so.
				 *
				 * Named `gapTokens`, not `headroomTokens`: the engine's own `headroomTokens` is
				 * the reserve *below the threshold* and is a configurable knob, so sharing the
				 * name would make the panel's derived number indistinguishable from a setting.
				 */
				gapTokens: thresholdTokens === null || retainTokens === null ? null : thresholdTokens - retainTokens,
			};
		}

		/** Count tokens the way the conversation's own meter does (K / M). */
		function tokenText(value) {
			if (value === null || value === undefined) return '—';
			if (value < 1000) return String(value);
			const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
			if (value < 1e6) return `${scaled(value / 1e3)}K`;
			return `${scaled(value / 1e6)}M`;
		}

		/** `0.2` → `20%`, without trailing zeroes. */
		function ratioText(ratio) {
			if (typeof ratio !== 'number') return null;
			return `${Math.round(ratio * 1000) / 10}%`;
		}

		/** Panel copy for one policy field's winning layer. */
		function layerText(t, source, overridden) {
			const name =
				source === 'model'
					? t('pLayerModel')
					: source === 'provider'
						? t('pLayerProvider')
						: source === 'default'
							? t('pLayerDefault')
							: t('pLayerEngine');
			return overridden ? `${name} · ${t('pUser')}` : name;
		}

		/**
		 * One panel row: label, effective value, and the layer that produced it.
		 *
		 * @param props - row content; `hint` renders under the label as the
		 * explanation, `unit` as a muted suffix on the value.
		 */
		function PolicyRow(props) {
			const { label, value, source, hint, unit, t } = props;
			return jsx.jsxs('div', {
				className: 'ccbRow',
				children: [
					jsx.jsxs('span', {
						className: 'ccbKey',
						children: [
							label,
							hint === undefined ? null : jsx.jsx('span', { className: 'ccbHint', children: ` — ${hint}` }),
						],
					}),
					jsx.jsxs('span', {
						className: 'ccbVal',
						children: [
							value,
							unit === undefined ? null : jsx.jsx('span', { className: 'ccbHint', children: ` ${unit}` }),
							source === undefined ? null : jsx.jsx('span', { className: 'ccbSrc', children: ` · ${source}` }),
						],
					}),
				],
			});
		}

		/**
 * In-session indicator for the policy this conversation is actually running
 * under, resolved from the same document and the session's own projections.
 */
		/**
 * Read one session projection with a plain subscription: the indicator must
 * follow the live session, not a snapshot taken when it mounted.
 */
		function useSessionProjection(session, key) {
			const face = session?.projections?.faceOf(key);
			const [value, setValue] = react.useState(() => face?.getSnapshot());
			react.useEffect(() => {
				if (face === undefined || typeof face.subscribe !== 'function') return undefined;
				setValue(face.getSnapshot());
				return face.subscribe(() => setValue(face.getSnapshot()));
			}, [face]);
			return value;
		}

		/**
		 * The route that actually wrote the most recent compaction's summary, read
		 * live from the session's own event window.
		 *
		 * The `compaction/summary` event is the only durable answer to "which model
		 * summarized this": `provider`/`model` are rewritten by the fallback chain
		 * on success, so the recorded pair is the route that won and not merely the
		 * one the policy asked for. Nothing here goes over the remote — the loaded
		 * window is the source, which is what makes this cheap enough for a header
		 * badge that re-renders on every streamed event.
		 *
		 * Deliberately defensive: a session stub, or a session whose event source
		 * has not been wired up, must leave the badge at its current face rather
		 * than throw. `undefined` means "no compaction record readable", which is
		 * also the answer for an empty window.
		 *
		 * @param param0 - `{ session }`, the object `useSession()` returns.
		 * @returns the last summary's route and cost, or `undefined`.
		 */
		function useLastCompaction({ session } = {}) {
			const source = session?.eventSource;
			const [value, setValue] = react.useState(() => lastCompactionOf(source));
			react.useEffect(() => {
				if (source === undefined || typeof source.subscribe !== 'function') return undefined;
				setValue(lastCompactionOf(source));
				return source.subscribe(() => setValue(lastCompactionOf(source)));
			}, [source]);
			return value;
		}

		/** Read the last `compaction/summary` entry out of one event window. */
		function lastCompactionOf(source) {
			const snapshot = typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined;
			const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : undefined;
			if (entries === undefined) return undefined;
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry?.type !== 'event') continue;
				const event = entry.event;
				if (event?.type !== 'compaction/summary') continue;
				const data = event.data;
				if (!isPlainObject(data)) continue;
				const { provider, model } = data;
				if (typeof provider !== 'string' || provider.length === 0) continue;
				if (typeof model !== 'string' || model.length === 0) continue;
				const usage = isPlainObject(data.usage) ? data.usage : undefined;
				return {
					provider,
					model,
					// A `sourceCommandId` means the operator ran /compact; its absence
					// means the engine compacted on its own trigger.
					manual: data.sourceCommandId !== undefined && data.sourceCommandId !== null,
					itemCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : null,
					tokenCount: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : null,
					usage,
					time: typeof event.time === 'number' ? event.time : 0,
				};
			}
			return undefined;
		}

		/**
		 * In-session indicator for the policy this conversation is actually
		 * running under.
		 *
		 * The backend numbers and the frontend numbers come from two different
		 * places and both are needed: the policy is the session-scoped settings
		 * document (live — an edit on the settings page moves this badge in the
		 * same commit), while the window and current occupancy come from the
		 * session's own projections. Showing the ratio alone would be useless in
		 * this deployment, because `measured` already contains the fixed system
		 * prompt and tool catalog (~21k), so a ratio is not "percent of the
		 * conversation" — the panel therefore also states the token budget the
		 * ratio maps to once a window is known.
		 *
		 * The route matters: the policy table resolves per `provider/model`, so
		 * the badge resolves against the session's last-used route rather than
		 * the global default alone. Before the session has sent a request there
		 * is no route, and the panel says so instead of implying a per-model
		 * layer applied.
		 */
		function CompactionBadge(props) {
			const { t, usePolicy, useSession } = props;
			// State and ref are declared before the injected hooks on purpose: a
			// React hook's identity is its call position, so keeping the
			// component's own two seats first makes the hook order independent of
			// how many hooks the standard source happens to contribute.
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);
			const policy = usePolicy((value) => value);
			/**
			 * Whether this client can see the host's policy at all.
			 *
			 * A remote browser gets a memory-mode form (`status: 'unavailable'`), so
			 * `value` is empty. The badge used to fall through to
			 * `ENGINE_DEFAULT_THRESHOLD` and render the plugin's own 0.8 as
			 * "80% · 800K" — a number that reads exactly like a configured trigger and
			 * is wrong by a factor the operator cannot see. Saying "unreadable" is the
			 * only honest answer it can give.
			 */
			const policyKnown = policy !== undefined && policy !== null && policy.status !== 'unavailable';
			const session = useSession();
			const pressure = useSessionProjection(session, 'contextPressure');
			const selection = useSessionProjection(session, 'modelSelection');
			/**
			 * Which route actually wrote the last summary, and whether the operator
			 * asked for it. Read from the session's event window, so a compaction
			 * that just landed moves this badge without a reload.
			 */
			const last = useLastCompaction({ session });

			const view = resolveView(policy?.value, policy?.user, routeOf(selection));
			const contextWindow = pressure?.contextWindow;
			const budgets = budgetsOf(view, contextWindow);
			const used = pressure?.projectedTokens ?? pressure?.pressureTokens;

			react.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open]);

			const thresholdText = !policyKnown
				? '—'
				: (ratioText(
						view.thresholdRatio ??
							(budgets.thresholdTokens === null ? undefined : budgets.thresholdTokens / contextWindow),
					) ?? ratioText(ENGINE_DEFAULT_THRESHOLD));
			const autoOn = view.auto;
			// Headline: what will happen, not what is configured. Without a window
			// the honest answer is the ratio; with one it is the token budget.
			const headline = !policyKnown
				? t('badgeUnknown')
				: autoOn
					? budgets.thresholdTokens === null
						? `${t('pThreshold')} ${thresholdText}`
						: `${thresholdText} · ${tokenText(budgets.thresholdTokens)}`
					: t('badgeOff');
			const aria = `${t('badgeAria')}: ${headline}`;

		/**
		 * The badge's second face segment: the route that actually wrote the last
		 * summary, with how it was triggered.
		 *
		 * The policy face above answers "what will happen"; this answers "what just
		 * happened, and who did it" — the one thing the operator cannot tell from
		 * anywhere else in the chat, because the compaction marker's renderer is
		 * dsh's own and a plugin cannot decorate it. The route is shown here, not
		 * only in the popover, because the question it answers is the one asked
		 * right after a compaction: the summary came out short, or in a voice that
		 * is not the policy's model, and the cause is the fallback chain having
		 * picked a different route.
		 *
		 * Without a compaction record there is nothing to say, and the segment is
		 * omitted rather than replaced by a placeholder — a header badge that
		 * reads "no compaction yet" on every fresh conversation is noise.
		 */
		const lastSummary = last === undefined ? undefined : `${last.provider}/${last.model}`;
		const lastSummaryText =
			lastSummary === undefined ? undefined : `${lastSummary} · ${last.manual ? t('lastManual') : t('lastAuto')}`;

			/**
			 * A budget as the panel states it: the ratio, and the token count it
			 * maps to whenever that is knowable.
			 *
			 * Both units, always, because either can be the one the operator wrote
			 * and either can be the one the engine acts on: a policy stated in
			 * tokens has no ratio of its own until the window is known, and a
			 * policy stated as a ratio has no token count without it. Showing one
			 * number would let the configured value and the effective value drift
			 * apart on screen.
			 */
			const budgetText = (ratio, tokens, fallback) => {
				if (!policyKnown) return '—';
				// A budget declared in tokens has no ratio of its own, but with a
				// window in hand the share it occupies is arithmetic, not a
				// guess — and it is the number that says how eager the trigger is.
				const shown =
					typeof ratio === 'number'
						? ratio
						: typeof tokens === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
							? tokens / contextWindow
							: undefined;
				const ratioPart = ratioText(shown) ?? ratioText(fallback);
				return tokens === null ? ratioPart : `${ratioPart} · ${tokenText(tokens)}`;
			};

			const rows = [
				{
					key: 'threshold',
					label: t('pThreshold'),
					hint: t('pThresholdHint'),
					value: budgetText(view.thresholdRatio, budgets.thresholdTokens, ENGINE_DEFAULT_THRESHOLD),
					source: layerText(t, view.fields.threshold.source, view.fields.threshold.overridden),
				},
				{
					key: 'retain',
					label: t('pRetain'),
					hint: t('pRetainHint'),
					value: budgetText(view.retainRatio, budgets.retainTokens, ENGINE_DEFAULT_RETAIN),
					source: layerText(t, view.fields.retain.source, view.fields.retain.overridden),
				},
				{
					key: 'summary',
					label: t('pSummary'),
					value: view.summarizationModel === AUTO ? t('pModelAuto') : view.summarizationModel,
					source: layerText(
						t,
						view.fields.summarizationModel.source,
						view.fields.summarizationModel.overridden,
					),
				},
				{
					// The chain is a row of its own rather than a suffix on the model: it
					// is a *sequence*, and the order is the whole point — a reader who
					// cannot see which route is tried first cannot reason about what a
					// failed summarization will cost.
					key: 'fallback',
					label: t('pFallback'),
					hint: t('pFallbackHint'),
					value:
						view.summarizationFallback.length === 0
							? t('pFallbackNone')
							: view.summarizationFallback.join(' → '),
					source:
						view.summarizationFallback.length === 0
							? undefined
							: layerText(t, view.fields.summarizationFallback.source, view.fields.summarizationFallback.overridden),
				},
				{
					// Not a setting either: the route that actually wrote the last
					// summary. The policy row above names the model that *will* be
					// asked; this one names the model that *did* the work, which the
					// fallback chain may have rewritten. The two disagreeing is the
					// whole reason the row exists.
					key: 'lastSummary',
					label: t('lastSummary'),
					hint: t('lastSummaryHint'),
					value:
						lastSummary === undefined
							? t('lastSummaryNone')
							: `${lastSummary} · ${last.manual ? t('lastManual') : t('lastAuto')}`,
					source: undefined,
				},
				{
					// What that compaction actually replaced. Stated because the route
					// alone does not say whether the summary had room to work: a
					// 55K-token shadowed region and an 85-node one are different kinds
					// of squeeze, and the number is what makes the difference visible
					// without opening the trajectory panel.
					key: 'lastCost',
					label: t('lastCount'),
					value:
						last?.tokenCount === null || last?.tokenCount === undefined
							? '—'
							: tokenText(last.tokenCount),
					unit: last?.tokenCount === null || last?.tokenCount === undefined ? undefined : t('lastTokens'),
					source: last?.itemCount === null || last?.itemCount === undefined ? undefined : `${last.itemCount}`,
				},
				{
					// Not a setting: summarizing is mechanical compression of text that
					// is already in context, so the engine always asks the route for its
					// "do not think" level. The row exists so the panel states that fact
					// rather than leaving the reader to wonder.
					key: 'effort',
					label: t('pEffort'),
					hint: t('pEffortHint'),
					value: t('pEffortFixed'),
				},
				{
					key: 'maxTokens',
					label: t('pMaxTokens'),
					value: view.maxTokens === undefined ? '—' : view.maxTokens,
					unit: view.maxTokens === undefined ? undefined : t('pMaxTokensUnit'),
					source: layerText(t, view.fields.maxTokens.source, view.fields.maxTokens.overridden),
				},
			];
			const triggerRow =
				budgets.thresholdTokens === null
					? null
					: {
							key: 'trigger',
							label: t('pTriggerAt'),
							value: `${tokenText(budgets.thresholdTokens)} / ${tokenText(contextWindow)}`,
							source: used === undefined ? undefined : `${tokenText(used)} ${t('pWindow')}`,
						};
			const windowRow =
				budgets.thresholdTokens === null
					? {
							key: 'window',
							label: t('pWindow'),
							value: t('pWindowUnknown'),
							source: undefined,
						}
					: null;
			/**
			 * The room a compaction actually has to work with: everything between
			 * the trigger and the retained tail.
			 *
			 * A summary has to come out *smaller* than the region it replaces or
			 * the engine rejects the compaction, and the observed floor for a
			 * structured summary is a few thousand tokens — so a policy whose gap
			 * is a few hundred tokens fires, fails, and fires again. The engine
			 * cannot refuse the document (a small window may make a small gap
			 * unavoidable), so the panel is where the operator is told.
			 */
			const gap = budgets.gapTokens;
			const gapShort = gap !== null && gap < MIN_COMPACT_GAP_TOKENS;
			const gapRow =
				gap === null
					? null
					: {
							key: 'gap',
							label: t('pGap'),
							value: tokenText(gap),
							source: undefined,
						};

			return jsx.jsxs('span', {
				ref: rootRef,
				className: 'ccbRoot',
				children: [
					jsx.jsxs('button', {
						type: 'button',
						className: 'ccbBadge',
						'aria-label': aria,
						'aria-haspopup': 'dialog',
						'aria-expanded': open,
						title: aria,
						onClick: () => setOpen(!open),
						children: [
							jsx.jsx('span', { className: autoOn ? 'ccbDot' : 'ccbDot ccbOff' }),
							jsx.jsx('span', { children: headline }),
							lastSummaryText === undefined
								? null
								: jsx.jsx('span', {
										className: 'ccbLast',
										// The route alone does not say who started it, and
										// "automatic" is the case worth seeing at a glance: an
										// automatic compaction is the one that lands mid-turn
										// and surprises the operator.
										title: `${t('pSummary')}: ${lastSummary} · ${last.manual ? t('lastManual') : t('lastAuto')}`,
										children: lastSummaryText,
									}),
						],
					}),
					!open
						? null
						: jsx.jsxs('div', {
								className: 'ccbPanel',
								role: 'dialog',
								'aria-label': t('badgeTitle'),
								children: [
									jsx.jsx('p', { className: 'ccbTitle', children: t('badgeTitle') }),
									jsx.jsx('p', {
										className: 'ccbTarget',
										children: `${t('pTarget')}: ${
											view.target === undefined
												? t('pTargetNone')
												: `${view.target.provider}/${view.target.model}`
										}`,
									}),
									jsx.jsxs('div', {
										className: 'ccbRows',
										children: [
											jsx.jsx(
												PolicyRow,
												{
													key: 'auto',
													label: t('pAuto'),
													value: autoOn ? t('pOn') : t('pOff'),
													t,
												},
												'auto',
											),
											...rows.map((row) => jsx.jsx(PolicyRow, { ...row, t }, row.key)),
											triggerRow === null ? null : jsx.jsx(PolicyRow, { ...triggerRow, t }),
											windowRow === null ? null : jsx.jsx(PolicyRow, { ...windowRow, t }),
											gapRow === null ? null : jsx.jsx(PolicyRow, { ...gapRow, t }),
										],
									}),
									autoOn ? null : jsx.jsx('p', { className: 'ccbWarn', children: t('pOffHint') }),
!policyKnown ? jsx.jsx('p', { className: 'ccbWarn', children: t('badgeUnknownHint') }) : null,
									autoOn && gapShort ? jsx.jsx('p', { className: 'ccbWarn', children: t('pGapWarn') }) : null,
									jsx.jsx('p', { className: 'ccbFoot', children: t('pEdit') }),
								],
							}),
				],
			});
		}

		/**
 * Register the policy card into the Models page's footer seat, and keep its
 * translation keys in sync with the locale bundle.
 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'compaction-control: card copy');

			// 0.2.0 renamed the browser-side settings transport: the old
			// `ctx.settingsScope.bind({ namespace })` no longer exists (the service
			// was removed outright), and `ctx.configForms.get(entryId)` is its
			// replacement — same ConfigForm surface (getSnapshot/subscribe/mutate).
			// Injecting the old name leaves this entry `pending` forever, which the
			// browser reports as "Failed to load plugins".
			/**
			 * The 0.2.0 settings document IS the profile patch: a form is keyed by the
			 * profile **entry id** whose `Config` owns it (see `configForms.get`'s own
			 * doc: "Unique Host plugin entry id"), not by a namespace the plugin
			 * registers. 0.1.x's publish path (`ctx.settings.installSection`) is gone
			 * from 0.2.0 outright, so `get('compaction-control')` answers
			 * `unavailable` forever and this card quietly fell back to its own schema
			 * defaults — the deployment said 0.6 while the panel advertised 0.8.
			 *
			 * The first entry must match the server's `PATCH_ENTRY_IDS[0]`: the panel
			 * edits the first available form, while the engine reads the first patch
			 * entry with a config. `compaction-control-host` is not exposed by this
			 * deployment's settings plane (`settings/describe` exposes only
			 * `compaction-control-settings`), so starting with it made the panel edit
			 * an entry the engine never read — that divergence broke settings on
			 * 2026-10-14. The remaining ids remain fallbacks for older profiles.
			 */
			const SETTINGS_ENTRIES = ['compaction-control-settings', 'compaction-control-host', 'compaction-control'];
			const forms = SETTINGS_ENTRIES.map((id) => ctx.configForms.get(id));
			/**
			 * The first entry the Host actually serves.
			 *
			 * Resolved per read rather than once: these forms all start `loading`, so a
			 * pick made at apply time would be a guess about which entry this profile
			 * mounts. `unavailable` is the settled answer, so anything else may still
			 * be right.
			 */
			const scopeOf = () => forms.find((form) => form.getSnapshot?.()?.status !== 'unavailable') ?? forms[0];
			const scope = {
				getSnapshot: () => scopeOf().getSnapshot(),
				subscribe: (listener) => {
					const disposers = forms.map((form) => form.subscribe(listener));
					return () => {
						for (const dispose of disposers) dispose();
					};
				},
				mutate: (ops, expectedRevision) => scopeOf().mutate(ops, expectedRevision),
			};

			/**
			 * The host's servable model catalog, loaded once per page.
			 *
			 * Read lazily — the first card that mounts starts the load — because
			 * most visits to the Models page never open the compaction card's
			 * picker, and this is the same Remote the conversation's model menu
			 * uses, so it is cheap but not free.
			 *
			 * A failure is a fact the card must state, not a reason to render an
			 * empty picker: `undefined` means "still loading", `null` means "the
			 * read failed", and the card says so.
			 */
			let catalogState = { status: 'idle', value: undefined };
			const catalogListeners = new Set();
			const loadCatalog = () => {
				if (catalogState.status !== 'idle') return;
				catalogState = { status: 'loading', value: undefined };
				ctx.remote.session
					.modelCatalog()
					.then((response) => {
						if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
						catalogState = { status: 'ready', value: response.value };
					})
					.catch(() => {
						catalogState = { status: 'failed', value: null };
					})
					.finally(() => {
						for (const listener of catalogListeners) listener();
					});
			};

			const useCatalog = () => {
				const [value, setValue] = react.useState(() => catalogState.value);
				react.useEffect(() => {
					loadCatalog();
					const listener = () => setValue(catalogState.value);
					catalogListeners.add(listener);
					listener();
					return () => {
						catalogListeners.delete(listener);
					};
				}, []);
				return value;
			};

			ctx.slots.inject('settings.models.footer', function* () {
				yield ctx.slots.register(
					{
						name: 'settings.models.footer',
						id: NS,
						locale: NS,
						inject: () => ({
							t,
							scope,
							useCatalog,
							useScope: (select) => {
								const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
								react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), []);
								return select(snapshot);
							},
							mutate: (ops) => scope.mutate(ops),
						}),
					},
					CompactionCard,
				);
			});

			/**
			 * The in-session indicator.
			 *
			 * Seat: `conversation.session.header.utilities` — a session-scoped
			 * list slot rendered with no props (`renderSlot(name, {})`), beside
			 * the header's other utilities. Session scope is what supplies
			 * `sessionId` and the two standard keyed hooks: `useProjection`
			 * (the `contextPressure` / `modelSelection` projections the chat
			 * meter already reads) and `useSession`. It needs no `remote.*`
			 * calls, which is what keeps it cheap enough for a header that
			 * re-renders on every streamed event.
			 *
			 * The policy itself comes from the settings scope rather than the
			 * projections, and that is the point: the scope is live, so an edit
			 * on the Models page moves this badge in the same commit — the
			 * answer to "did my change apply to the session I am looking at".
			 */
			const sessions = ctx.sessions;
			ctx.slots.inject('conversation.session.header.utilities', function* () {
				yield ctx.slots.register(
					{
						name: 'conversation.session.header.utilities',
						id: `${NS}-session-badge`,
						order: 20,
						locale: NS,
						inject: (sessionId) => {
							const binding = sessionId === undefined ? undefined : sessions.binding(sessionId);
							if (binding === undefined) {
								throw new Error(`compaction-control: session "${String(sessionId)}" is unavailable`);
							}
							return {
								useSession: () => binding.session,
								usePolicy: (select) => {
									const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot());
									react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), []);
									return select(snapshot);
								},
							};
						},
					},
					CompactionBadge,
				);
			});
		}

		/**
 * Required client services (cordis fiber inject). Listed in one place so the
 * bundle's dependencies are auditable against the host's provided services.
 */
		const inject = [
			'locale',
			'remote',
			'remote.session',
			'sessions',
			// 0.2.0：`settingsScope` 已不存在，settings 表单服务改名 `configForms`
			// （由 dsh-client-ui-settings 提供）。名字写错 = entry 永远 pending。
			'configForms',
			'slots',
		];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});