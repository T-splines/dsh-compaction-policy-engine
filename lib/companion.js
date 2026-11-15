/**
 * Settings-companion entry point for dsh-compaction-policy-engine.
 *
 * What the **bare package name** resolves to. It publishes the
 * `compaction-control` settings section and the standing "compaction is
 * automatic" prompt rule, and claims no service — so mounting it is inert with
 * respect to compaction itself, and it can never mount an engine (see
 * `./engine.js` for why that matters).
 *
 * @module dsh-compaction-policy-engine/companion
 */

export { CompactionControlSettings as default, CompactionControlSettings } from './index.js';
