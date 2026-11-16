# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
