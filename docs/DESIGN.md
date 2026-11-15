# Design

## 1. Scope

The plugin adds a policy layer on top of `@deepseek-ai/dsh-compaction-basic`. It does not
reimplement compaction: `CompactionControlEngine` extends `BasicCompactionEngine`, so region
selection, tool-pairing balance, summary framing and the durable transaction stay official.
Only two decisions move into this plugin:

1. **when** to compact (threshold, per route);
2. **which model** writes the summary (including a fallback chain).

## 2. Policy model

```
models[]        exact (provider, model) overrides; highest priority
providers{}     per-provider overrides
default         global fallback
```

Resolution is **per field**. For each budget field, the first layer that defines it wins.
A model override of `threshold` leaves `retain`, `maxTokens` and `summarizationModel`
inheriting from the provider or global layer.

The result is cached by `(provider, model, window)`. The engine reads the session's **current**
route at each threshold check, so switching models mid-session switches policy immediately.

### Units

| ratio form | absolute form | semantics |
|:--|:--|:--|
| `threshold` | `thresholdTokens` | compact at this point |
| `retain` | `retainTokens` | keep this much recent content |

The parent engine consumes ratios (`thresholdRatio`) and computes
`floor(window × ratio)`. To honor an absolute budget exactly, the plugin writes
`(tokens + 0.5) / window`, so the parent's floor returns the declared token count. Absolute
`retainTokens` is passed through (the parent uses it as a boundary).

If a route declares no context window, an absolute budget cannot be honored. The plugin does
not guess: the field is deferred and the error names the route when the policy is needed.

If both forms appear in one layer, the token form wins and one `[compaction] WARNING` names
the shadowed key. Rejecting the whole layer would make a just-saved panel value look ignored.

**Gap warning.** A structured summary has a practical lower bound of about 3.2K tokens. When
`threshold − retain < 8192`, the summary cannot be smaller than the content it replaces and
the parent engine rejects it. This is a warning, not a load error: small windows may make a
small gap unavoidable.

## 3. Configuration sources

The engine reads, in order:

1. the **mount row's `config:`** (the composition baseline);
2. `$DSH_HOME/settings.yaml` under `compaction-control:` (the panel's document);
3. the **profile patch layer** (`cordis.patch.yml` / preset file), which the loader applies
   last and therefore wins.

`settings.yaml` is a **partial document**: it is merged per field with the mount config
(maps recurse, arrays replace wholesale, explicit `undefined` keeps the baseline). Writing a
section in the file does not discard the profile's `models[]`; that was a real regression and
now has a dedicated test.

The engine polls the sources every second, so policy edits apply without a restart. When the
file segment exists, it is the effective document for the fields it defines; fields it omits
still come from the mount row.

## 4. Realm and seam rules

`ctx.compaction` is a per-realm single slot. The stock web app intentionally disables the
host-plane `compaction-basic` / `command-compact` / `tool-result-pruner` and moves the
compaction backend into the agent preset. Therefore:

- in `web`, mount the engine **inside the preset**, replacing the stock row in the same
  realm;
- in a profile without a preset (`headless`), mount it on the host plane and disable
  `compaction-basic` in the same patch.

If two engines exist, both subscribe to the bubbling `agent/pre-step`; the lower threshold
triggers first. If no engine exists, the seam is unclaimed and the session silently stops
compacting. Both mistakes are silent, which is why the documentation insists on reviewing
the disable and the mount together.

The loader key is `disabled`, not `disable`. The typo is dropped by the schema and the row
stays enabled.

The bundle deliberately ships the engine row `disabled`: turning it on without also disabling
the stock engine would create a second engine, and disabling the stock engine without a
replacement would leave no engine. Superseding the stock engine is a deployment decision.

The companion row is host-plane and always enabled because the browser bundle is discovered
from enabled loader entries; the engine row lives in a preset and is invisible to that scan.
The companion never claims `ctx.compaction`.

## 5. Manual compaction

The stock `compactNow` hardcodes a zero retention in its region selector. Manual `/compact`
therefore would reduce the session to the last surface node. The plugin fixes this without
patching `node_modules`:

- the retention index is computed from the policy cache (including the window, which is part
  of the cache key);
- a shadowed `tokenMeter` reframes the measurement so the parent's `accumulated >=
  retainTokens` boundary lands on the intended index;
- the real meter is kept for pricing via `regionDependencies()`;
- when retention cannot be satisfied, the plugin does not fabricate a region: all nodes are
  discounted and the parent returns `null`, matching the real selector.

The transaction is wrapped in a signal that is never aborted by the command caller; only the
agent's maintenance signal can cancel it. A client reconnect cannot kill a 20–40 second
compaction. Busy-gate failures are retried once with a bounded wait and reported honestly.

## 6. Summarization fallback

`summarizationFallback` is a chain of `provider/model` routes tried in order. The parent
consumes `ctx.llm.stream()` incrementally, so each attempt is fully buffered and released
only when it completes with text. This prevents a half-streamed attempt from being committed
as a plausible-looking summary. Terminal `error`/`aborted` finish chunks count as failures;
on success the plugin rewrites `options.provider`/`options.model` in place so the durable
`compaction/summary` record names the route that actually wrote the summary.

Aborts do not consume the next route. A route equal to the primary (including an `auto`
resolution) is rejected at load time. Exhaustion yields a terminal finish chunk rather than
throwing, matching the parent's chunk contract.

## 7. Context policy prompt

The companion registers `compaction:context-policy` at order 100. It says context management
is automatic, the model cannot measure its own usage, and it must not stop, shorten, defer or
hand off work because it believes context is nearly full.

This is not cosmetic. In long sessions models claimed "context is nearly full" well before
the configured threshold had ever fired, then repeatedly cited that claim. No system prompt
or injected message had told them their usage; they were self-diagnosing incorrectly. Since
compaction is automatic, declaring the rule in the compaction plugin is the right scope.

## 8. Tests

The unit suite (198 cases) covers the policy, the engine integration, settings parsing, the
manual-compaction wrapper, the context prompt and both client modules. Two kinds of tests are
worth calling out:

- **Contract tests against the official package** pin assumptions the plugin relies on (for
  example, that the parent still wraps the agent-loop gate as a recognizable `busy`), so an
  upstream change fails loudly instead of silently disabling a retry.
- **Real bundle evaluation**: `client.test.js` evaluates `lib/client.js` with a JSX-runtime
  stub, fake slots and a fake settings scope. Static checks missed several "card renders but
  all fields are empty" regressions; the bundle test catches them.

A smoke script (`scripts/smoke.sh`) checks the real start-up log for `engine up:` and compares
the reported threshold with the deployment's declared policy.

## 9. Known limitations

- The settings writer cannot edit arrays; `models[]` stays hand-edited in `settings.yaml`.
- Non-loopback browsers receive DSH's memory-state settings view; the card is read-only and
  says so.
- The context-policy paragraph is only registered when the profile has a `systemPrompt`
  service.
- Absolute token budgets require a route that declares a context window.
