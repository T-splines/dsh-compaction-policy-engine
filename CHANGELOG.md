# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
