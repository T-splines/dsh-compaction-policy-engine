# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.5.15] - 2026-11-28

### Fixed — the policy now reaches the engine on the Windows desktop host

On Windows the desktop host starts dsh with neither `DSH_HOME` nor `HOME` set
(Windows has no `HOME`) and `cwd = <home>/profiles/desktop`. Both file readers
derived the harness home from `process.env.HOME`, which on that host is the
relative path `.dsh`: every patch candidate resolved to
`<home>/profiles/desktop/.dsh/profiles/desktop/cordis.patch.yml`, a file that
does not exist. A missing candidate is the normal case for every file but one,
so nothing was reported, and the engine ran on its built-in baseline —
`thresholdRatio 0.8`, `retainRatio 0.16`, `maxTokens 8192` — while the settings
card, fed by the loader, read the configured 42%.

Measured on a Win11 `desktop` profile: the only gate-triggered compaction fired
at 680,081 tokens (the 0.8 threshold with the request's 256k `maxTokens`
reserved: 678,464); once the request moved to 131k `maxTokens` the threshold
became 800,000 and the session grew to 745k (74%) without compacting. The
pressure gate measures provider-reported usage, so "42% in the card, compacts at
80%" was the entire symptom.

The home is now resolved the way the host resolves it
(`@deepseek-ai/dsh-home-paths`): the home the running host reports
(`ctx.profileContext.home`, provided before any profile row mounts), then a
non-blank `DSH_HOME` (with `~` expansion), then `os.homedir()/.dsh` — never
`HOME`. The same order applies to `settings.yaml`.

### Changed — a missing patch layer is said once

`watchPatchFile` gains `onMissing`, called once when no candidate file exists at
all; the engine prints `[compaction] WARNING … no profile patch layer found
(tried …)` naming the paths. A candidate that exists but carries no entry for
this plugin stays silent — that is a profile configured elsewhere, not a missing
layer.

## [0.5.10] - 2026-11-26

### Fixed — installing the plugin now actually takes over compaction

The bundle shipped its engine row `disabled: true`, on the theory that "superseding the
stock engine is a deployment decision". That reasoning silently assumed the stock engine
was *running*. On a preset-based host it is not: `dsh-web-app` — which backs both the
`web` and `desktop` profiles — disables the host-plane `compaction-basic` itself. So with
this plugin installed there were **two disabled engines and no owner of `ctx.compaction`**:

- the settings card rendered and returned the configured threshold;
- `engine up` printed nothing, because the engine never mounted;
- nothing compacted, ever.

Observed on a Win11 `desktop` profile: a session grew to 158,118 tokens and then could
not compact at all. Four forced compactions ran (two in turn 27, one in turn 28, one
manual `/compact`) and every one came back `context_length_exceeded` from the gateway,
because the summary request has to carry the same oversized history that triggered it.
The session was unrecoverable — retrying sent the same request, and compaction could not
shrink it.

The fix is for the bundle to do both halves of the swap in one place:

```yaml
- id: compaction-basic
  disabled: true

- insert:
    - id: compaction-control
      name: '@magic6/dsh-compaction-policy-engine/engine'
```

Uninstalling removes both, so the stock engine comes back automatically. The plugin can no
longer leave a profile with no compaction at all.

`ctx.compaction` is a **single-slot service**, not an agreement between engines: a second
engine in the same context throws `service "compaction" has been registered at
<BasicCompactionEngine>` during construction and never mounts (the host only prints
`dsh: warning: 1 entry did not activate`). That is why "leave the stock engine enabled as
a late backstop" is not an option — verified by hand on the same Win11 host.

### Fixed — a test fixture that hid the bug

`e2e/run.sh` wrote `- id: compaction-control / disabled: false` into the fixture profile.
That was intended to mean "the engine has to be on for the test to run", but it also meant
the suite could never observe the bundle's own default. Every scenario stayed green while
the shipped bundle was unusable.

The fixture now overrides only `config:`, leaving `disabled` at whatever the bundle ships.
`fired` additionally asserts that the engine printed its own `[compaction] engine up:` line
before it judges anything about thresholds — the precondition that the old suite silently
assumed.

Regression check with the corrected fixture (same suite, same fake provider):

| version | result |
|:--|:--|
| `0.5.9` (buggy) | **0 passed, 1 failed** — "our engine never started", plus "no compaction fired" |
| this release | 2 passed, 0 failed |

### Changed — README

The mounting section now states that installing the plugin *is* the takeover, that the
stock row must be disabled because the seam is single-slot, and that uninstalling restores
it. The two silent-bad-combination warnings keep their original text but now name which
one this release fixed.

## [0.5.9] - 2026-11-25

### Fixed — three bugs that only a real host could expose

An end-to-end layer (`e2e/`, `npm run test:e2e`) now starts a real `dsh` against a fake
provider and drives the pressure gate across its threshold. It found three defects that
the unit suite could not, because each one lived in an assumption the code made about the
host rather than in the logic it tested.

1. **`source=` named the wrong layer.** When `settings.yaml` does not exist, the watcher
   reports the composition as its fallback section and says so (`origin: 'composition'`),
   but `reloadPolicy` only tested `_fileSection !== undefined` and wrote
   `origin = 'settings.yaml'`. The one diagnostic meant to expose "your config never
   reached the engine" therefore asserted the opposite. Now it reads `_fileOrigin`.

2. **The patch layer was read from the wrong profile.** `patchFilePaths` trusted
   `process.env.DSH_PROFILE`, which the host injects into every *shell tool* execution
   — so a `dsh --profile headless …` launched from inside an agent inherited the parent's
   profile name and watched `profiles/web/cordis.patch.yml` instead of its own. A patch
   layer that was present and correct read as absent, silently, once a second. The engine
   now passes `ctx.get('profileContext').name`, which is the host's own answer; the env
   var remains only as a fallback hint.

3. **`NO THRESHOLD` could never print.** The guard tested
   `policy.thresholdRatio !== undefined`, but `resolvePolicy` always fills that field from
   `DEFAULT_THRESHOLD_RATIO`, so the function returned unconditionally. The warning
   existed for exactly the case it could not report. It now tests
   `policy.source.threshold.layer`, and an unknown layer counts as unstated.

The unit test that was supposed to cover (3) passed because it fed a hand-written policy
shape the resolver never produces. It now uses the resolved shape, and a new case asserts
that an engine-default threshold *is* reported.

### Added

- `e2e/run.sh` with `fired` (threshold crossed → `FIRED`, `source=cordis.patch.yml`, and
  `measured` falling back below the threshold afterwards) and `unstated` (`NO THRESHOLD`
  must be printed when no layer states one).
- Two regression tests for (2) and (3); both fail against 0.5.8 and pass against 0.5.9.

Unit suite: 201 passing.

## [0.5.8] - 2026-11-25

### Documentation

- README (both languages) now carries a **tested platforms** table — macOS, Windows
  and Linux, each with the actual pass count — and a **reporting a problem** section.
- `.github/ISSUE_TEMPLATE/` added: `bug_report.yml` (asks for the effective policy
  and where it came from) and `config_question.yml`.

## [0.5.7] - 2026-11-25

### Fixed

- One more Windows-only test failure, found by the `windows-latest` job added in
  this release: the watcher test built its temp path as
  `process.env.TMPDIR ?? '/tmp'`. `TMPDIR` is unset on Windows, and the fallback
  `/tmp/x.yaml` is drive-relative there, so it resolved to `D:\tmp\x.yaml` and
  the test died with `ENOENT`. Now uses `os.tmpdir()`. This one reached users:
  the suite is what a Windows contributor runs before sending a patch.
## [0.5.6] - 2026-11-25

### Fixed

- Two tests asserted POSIX path literals against `path.join` output and failed on
  every Windows run (`\tmp\cc-home-probe\…` never starts with `/tmp/cc-home-probe/`).
  The product code was correct; the assertions were the platform-specific part.
  They now build the expected path with `join`/`sep`, and the suite passes on
  Windows for the first time (198/198). CI is `ubuntu-latest` only, which is why
  this went unnoticed while the plugin was being used on Windows.

## [0.5.5] - 2026-11-22

### Fixed

- Host compatibility range now includes DSH `0.2.1-rc.x` as well as `0.2.2-rc.x`.
  DSH 0.2.1 rejects `engines.dsh >=0.2.2-0`, so the previous manifest blocked
  installation even though the plugin runs on 0.2.1.
- README: state the supported DSH versions.

## [0.5.4] - 2026-11-16

### Fixed

- Bundle entry, engine subpath, and client module identities now use the scoped
  npm package name, so the installed package resolves at runtime.
- Example bundle: engine entry uses the scoped package name.

## [0.5.3] - 2026-11-16

### Changed

- npm package renamed to `@magic6/dsh-compaction-policy-engine`; npm requires a
  scoped package for the first automated publish.
- README: update the npm installation command.

## [0.5.2] - 2026-11-16

### Added

- npm distribution: install with `dsh plugin --profile web add dsh-compaction-policy-engine`.

### Changed

- README: document npm installation and use absolute links for the language switch.

## [0.5.1] - 2026-11-16

### Changed

- README: add a visible English / Simplified Chinese language switch.

## [0.5.0] - 2026-11-16

First public release.

### Added

- Three-layer compaction policy (`models[]` → `providers{}` → `default`) with per-field
  resolution.
- Ratio and absolute-token budget forms with exact conversion back to the official engine;
  explicit failure when a route declares no window.
- Live reload from `settings.yaml` and the `compaction-control-settings` row without
  restarting DSH; the engine mount row's `config:` is read at load.
- Partial-document merge of the `compaction-control:` settings section with the mount
  config; profile `models[]` layers survive panel saves.
- Per-provider and per-model summarization models, plus a summarization fallback chain.
- Settings panel for the global/provider layers, unit switching, compactable-space warning
  and a session badge showing the current trigger point and the last summarizing route.
- `compaction:context-policy` prompt preventing self-diagnosed "context nearly full"
  refusals.
- Durable manual `/compact` that is not killed by client disconnects, with honest busy
  messages.
- 198 `node --test` cases plus a real start-up smoke script.

### Changed

- Package and repository renamed from `dsh-compaction-control` to
  `dsh-compaction-policy-engine`. Entry ids (`compaction-control`,
  `compaction-control-settings`) and the `compaction-control:` settings namespace are
  unchanged; update the `name:` fields in profiles/presets.
- README rewritten for the public release; added a Chinese README, design document, security
  policy, contribution guide, CI, and an example preset bundle for the web profile.

### Removed

- Internal probe tools and one-off probes are not part of the public release.

Earlier development history is not part of this repository.
