# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
