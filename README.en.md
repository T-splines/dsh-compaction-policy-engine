# dsh-compaction-policy-engine

**English** | [简体中文](https://github.com/T-splines/dsh-compaction-policy-engine/blob/main/README.md)

**Per-model context compaction policy for DeepSeek Harness — three-layer thresholds, live reload and summarization-model selection, on top of the official compaction engine.**

The official `@deepseek-ai/dsh-compaction-basic` already supports a threshold, a
summarization model, and exact per-`(provider, model)` overrides through `modelPolicies`.
This plugin subclasses that engine and adds the layer above it:

- **provider-level layers** — one rule for every model behind a provider, instead of
  enumerating each model id;
- **field-by-field inheritance** — a model can override `threshold` while inheriting
  `retain`, `maxTokens` and the summarizer from its provider or the global layer;
- **ratio or absolute-token units**, converted against the route's declared window;
- **live reload plus a settings panel and session badge**;
- **a summarization fallback chain** and a context-policy prompt.

Region selection, tool-pairing balance, summary framing and the durable compaction
transaction remain the official implementation. If you only need a few exact
`(provider, model)` overrides, the official `modelPolicies` already covers you; this plugin
is for layered policy across many routes.

- [Why this exists](#why-this-exists)
- [What makes it different](#what-makes-it-different)
- [Install and mount](#install-and-mount)
- [Configuration](#configuration)
- [How policy is resolved](#how-policy-is-resolved)
- [Settings panel](#settings-panel)
- [Behavior guarantees](#behavior-guarantees)
- [Tests](#tests)
- [Compatibility and migration](#compatibility-and-migration)

## Why this exists

The official engine's `modelPolicies` are exact `(provider, model)` pairs. When one gateway
exposes many model ids, or when several routes share the same policy, enumerating every pair
is brittle: a newly added model silently falls back to the global threshold until someone
adds it. This plugin lets one provider-level row cover every model behind that provider, and
resolves `models[] → providers{} → default` field by field.

```
models[]  →  providers{}  →  default
```

A model can override `threshold` while still inheriting `retain`, `maxTokens`,
`headroomTokens` and the summarization route from the provider or global layer.

## What makes it different

- **Three-layer policy, per-field.** `models[]` → `providers{}` → `default`. Changing one
  field does not require copying the whole layer, and one provider row covers every model
  behind that provider.
- **Ratio or absolute tokens.** `threshold` / `retain` are ratios of the route's declared
  window; `thresholdTokens` / `retainTokens` are absolute budgets. The plugin converts
  exactly back into the parent engine's ratio (`(tokens + 0.5) / window`) and **refuses to
  guess** when a route declares no window, naming the route in the error.
- **Live reload.** The engine polls `settings.yaml` and the `compaction-control-settings`
  row every second; a policy edit applies to the next compaction without restarting DSH.
  The panel writes the same document. The engine mount row's own `config:` is read at load
  (see [Install and mount](#install-and-mount)).
- **Partial settings document.** The `compaction-control:` section in `settings.yaml` is
  merged **per field** with the mount config (maps recurse, arrays replace wholesale), so a
  panel save cannot silently erase a `models[]` layer written in the profile.
- **Settings panel.** Edit the global layer or a provider layer, switch units without
  leaving both keys behind, see warnings for an un-compactable gap, and see the session
  badge's current trigger point and the route that actually wrote the last summary.
- **Summarization fallback chain.** `summarizationFallback` lists routes to try when the
  primary summarizer fails, so one broken summarizer route does not disable compaction.
- **Context-policy prompt.** The companion registers a prompt section telling the model that
  context management is automatic and that it cannot measure its own usage — preventing the
  "I think my context is nearly full" refusal loop observed in long sessions.
- **Manual `/compact` is durable.** A client disconnect or reconnect does not kill a 20–40 s
  compaction transaction; the command reports the real reason when it cannot start.
- **Tested.** 198 `node --test` cases across 13 files, including a real-bundle client
  evaluation, policy resolution, unit conversion, patch-file parsing and manual-compaction
  retention.

## Install and mount

Requirements: DSH `0.2.1-rc.x` / `0.2.2-rc.x`, Node.js 20+.

### From npm

```bash
dsh plugin --profile web add @magic6/dsh-compaction-policy-engine
```

The npm package includes `examples/standard-with-policy` for reference; the preset override
rules below still apply. The `$PWD` commands in the web section assume a source checkout.

### From source

```bash
git clone https://github.com/T-splines/dsh-compaction-policy-engine.git
cd dsh-compaction-policy-engine
dsh plugin --profile web add "$PWD"
```

The package is a bundle. It mounts:

- an **engine row** (`compaction-control`), **disabled by default**, and
- an **always-enabled companion row** (`compaction-control-settings`) that serves the
  settings card and the context-policy prompt. It deliberately does **not** claim
  `ctx.compaction`.

### Choose the realm first

`ctx.compaction` is a **per-realm single-slot seam**. The engine must live in the same realm
the agent resolves `ctx.compaction` from. Mounting it elsewhere creates a second engine; both
subscribe to the bubbling `agent/pre-step`, and the lower threshold wins — the symptom is
"compaction became unexpectedly early after installing the plugin".

| profile | where the agent's engine lives | how to mount |
|:--|:--|:--|
| `headless` | the host plane (no agent preset) | the profile's `cordis.patch.yml`, overriding the bundle's engine row |
| `web` | the **agent preset** (`dsh-web-app` disables the host-plane `compaction-basic`) | a preset declaration override; this repo ships an example bundle |

#### Headless (host plane)

The bundle already inserts `compaction-control` (disabled). Override that row; do **not**
`insert` a second one:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: compaction-basic
  disabled: true

- id: compaction-control
  disabled: false
  config:
    default:
      threshold: 0.8
      retain: 0.16
```

The loader key is **`disabled`**, not `disable`; the typo is silently dropped by the static
config and looks like "I disabled it, but it is still enabled".

#### Web (agent preset)

DSH 0.2.2 presets are `@deepseek-ai/dsh-agent-preset` declarations carried by bundle
patches. The legacy `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` directory is no longer
read. The web agent realm isolates `ctx.compaction`, so a host-plane engine is not seen by
the agent.

This repo ships an example bundle that overrides the shipped `preset-standard` and replaces
`compaction-basic` inside its `compaction` group with `compaction-control` (keeping
`command-compact` and `tool-result-pruner`):

```bash
dsh plugin --profile web add "$PWD"
dsh plugin --profile web add "$PWD/examples/standard-with-policy"
```

Restart the web app and open a new session. The example is a snapshot of the standard preset
from DSH 0.2.2. If you have customized the standard preset, merge the `compaction` group into
your own preset declaration instead of installing the example blindly (Creator mode can
author that override). The file is
[`examples/standard-with-policy/cordis.patch.yml`](examples/standard-with-policy/cordis.patch.yml);
its header says the same.

Two silent failure modes are easy to create:

- engine on the host plane **and** the stock `compaction-basic` still enabled in the preset
  → two engines, lower threshold wins;
- stock engine disabled **without** mounting a replacement → the seam is unclaimed and the
  session silently stops compacting until the provider rejects it.

Disable the old engine and enable the new one in the **same composition**, reviewed together.

### Live reload scope

The settings panel writes `$DSH_HOME/settings.yaml`. The engine polls that file **and** the
`compaction-control-settings` row every second, so panel edits and edits to that row apply to
the next compaction without a restart. The **engine mount row** (`compaction-control`) is
read at plugin load; editing its `config:` requires a restart.

### Threshold semantics

The official engine's trigger is

```
floor(min(W × threshold, W − O − headroomTokens))
```

where `W` is the route's declared window, `O` the output reservation, and `headroomTokens`
defaults to 65,536. `measured` **includes the fixed system prompt and tool catalogue**. On a
deployment with a large tool set, a threshold of 0.5 can mean "compact after roughly 23K
tokens of conversation", not "compact when the conversation is half full".

The plugin's `threshold` / `retain` map to the official `thresholdRatio` / `retainRatio`;
`headroomTokens` and `maxTokens` are per-layer fields. The default is 0.8, the official
engine's default, so the plugin never triggers earlier than the stock engine unless a
headroom cap does. The session badge shows `window × threshold` as a quick preview; because
`W − O − headroomTokens` can be lower, treat that number as an **upper bound** on when
compaction fires.

## Configuration

The policy can live in the mount row's `config:` or in `$DSH_HOME/settings.yaml` under the
`compaction-control:` section (the panel edits the latter).

```yaml
compaction-control:
  # global layer
  default:
    threshold: 0.8            # compact at this fraction of the window
    retain: 0.16              # keep this tail fraction; must be < threshold
    summarizationModel: auto  # auto = the session's current route, or "provider/model"
    summarizationFallback: [] # ordered "provider/model" routes to try after the primary
    headroomTokens: 65536     # keep this much free below the threshold
    maxTokens: 8192           # summary length cap
    compactionRetries: 1
    maxOverflowRetries: 1

  # per-provider override (provider names come from the llm config)
  providers:
    some-provider:
      threshold: 0.5

  # exact (provider, model) override; highest priority
  models:
    - provider: local
      model: model-262k
      threshold: 0.9

  # false = disable automatic compaction (manual /compact still works)
  auto: true
```

### Two units per budget field

Each budget field has a ratio form and an absolute-token form. Use **one form per layer**:

| ratio (of the window) | absolute tokens | meaning |
|:--|:--|:--|
| `threshold` | `thresholdTokens` | compact when reached |
| `retain` | `retainTokens` | keep this much recent content |

If both forms appear in the same layer, the token form wins and a `[compaction] WARNING`
names the shadowed key. The whole section is not rejected, because the panel naturally
stores a token value next to a ratio baseline and silently ignoring it would be worse.

### Other policy fields

Every field below is valid in `default`, a `providers{}` layer, or a `models[]` layer:

| field | default | meaning |
|:--|:--|:--|
| `summarizationModel` | `auto` | `auto` reuses the session's routed model; or an explicit `provider/model` |
| `summarizationFallback` | `[]` | ordered `provider/model` routes tried when the primary summarizer fails |
| `headroomTokens` | `65536` (official default) | tokens kept free below the threshold so the summary has room to be smaller |
| `maxTokens` | official default | cap on the generated summary length |
| `compactionRetries` | `1` | extra summarization attempts when pressure remains |
| `maxOverflowRetries` | `1` | retries after a confirmed context-window overflow; `0` disables recovery |

`auto` is a root-level switch, not a layer field: `false` disables automatic compaction while
manual `/compact` still works.

**The gap must be large enough.** The summary is a structured summary with a practical lower
bound (about 3.2K tokens). When `threshold − retain < 8192`, the summary cannot be smaller
than the content it replaces and the parent engine rejects it. The panel shows this as
"compactable space" with a warning; small windows may make a small gap unavoidable, so it is
a warning, not a load failure.

## How policy is resolved

- `models[]` → `providers{}` → `default`, **per field**, resolved by
  `(provider, model, window)` and cached. A session that switches models picks up the new
  policy on the next threshold check.
- The engine reads the route **at the time of the check**, not at session start.
- A route that declares no context window cannot honor an absolute token budget: the field
  is deferred and the error names the route when the policy is actually needed.
- Configuration errors (out-of-range ratio, `retain >= threshold`, unknown field, duplicate
  `models[]` target, malformed `summarizationModel`) fail at plugin load with a message
  pointing at the field.

## Settings panel

Models page footer → **Compaction policy** card:

- choose the layer: global default or a provider route;
- edit each budget field; the number's shape is the unit (`0.2` ratio, `200000` tokens);
  mixed/invalid values are marked and saving is disabled;
- switch units without leaving both keys in the document (the replaced key is `unset` in the
  same operation);
- add/remove a provider override; removal unsets every field in the user layer, including
  fields the card does not render;
- the session header badge shows the current trigger point (`ratio · tokens`), the layer
  that supplied it (`models[]` / `providers{}` / `default` / engine default), the estimated
  compactable space, and the route that wrote the last summary.

`models[]` remains hand-edited in `settings.yaml`: the settings writer treats arrays as
whole-value replacements, so a list editor would rewrite the whole table on every keystroke.
The badge still reports when a session hit a `models[]` entry.

Non-loopback browsers get DSH's memory-state view (`status: 'unavailable'`,
`writable: false`); the card says so instead of rendering plugin defaults as if they were
the deployed policy.

## Behavior guarantees

- **Configuration errors fail at startup, not at the first compaction.** The exception is a
  policy that needs the route's window; that fails at the step that actually needs it and
  names the route.
- **`retain >= threshold` after an override is an error**, not a silent shrink of `retain`.
- **No semantic hijack.** Region selection, tool pairing and the durable transaction are
  untouched from the official engine.
- **Manual compaction is persistent work.** `/compact` is not cancelled by a client
  disconnect; only the agent's own maintenance signal can cancel it. Stop still works.
- **Failures are not misreported.** A busy gate is retried once with a bounded wait; if it
  never releases, the message says the previous activity is still finishing, rather than
  claiming a lock is held.
- **Context policy.** The companion says: context management is automatic; you cannot
  measure your own usage; never stop or shorten work because you believe context is nearly
  full. The rule is registered only when the profile has a `systemPrompt` service.

## Tests

```bash
npm test
```

198 cases across 13 files, including:

- `manual-compaction.test.js` — gate retry, UI signal abort, real failures, honest messages,
  and a contract assertion against the installed official package;
- `context-policy.test.js` — prompt registration and absence without a `systemPrompt` service;
- `policy.test.js` — three-layer resolution, per-field merge, both units, conversion,
  warnings, overlay document rules;
- `engine.test.js` — seam registration, `inject` inheritance, `Config` ownership, per-target
  switching, window conversion, no-window refusal, profile `models[]` surviving a
  `settings.yaml` section;
- `settings-file.test.js` — patch/settings parsing and immediate edits;
- `fallback.test.js`, `patch-file.test.js`, `settings.test.js`, `summary-prefix.test.js`,
  `unstated-threshold.test.js` — summarizer fallback, patch entry shapes, settings merge,
  summary framing and the unstated-threshold warning;
- `client-policy.test.js` / `client.test.js` — panel calculations, unit switching, provider
  layers, session badge, illegal value blocking, inline bundle consistency.

## Compatibility and migration

- DSH `0.2.1-rc.x` / `0.2.2-rc.x` (`engines.dsh`: `>=0.2.1-0 <0.3.0-0`), Node.js 20+.
- **Renamed from `dsh-compaction-control` in 0.5.0.** Entry ids are unchanged:
  `compaction-control` (engine), `compaction-control-settings` (companion), and the
  `compaction-control:` settings namespace. Update the `name:` fields in your profile/preset
  to `@magic6/dsh-compaction-policy-engine` (and `.../engine` for the engine row).
- The engine is still a subclass of the official `BasicCompactionEngine`; no `node_modules`
  patch is required.

## License

MIT. See [LICENSE](LICENSE).
