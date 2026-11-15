/**
 * Engine entry point for dsh-compaction-policy-engine.
 *
 * The package needs two independently mountable halves, and the Cordis loader
 * cannot pick one: it resolves a row's module as `exports.default ?? exports` and
 * consults no entry option. The halves are therefore split across specifiers:
 *
 *   - `dsh-compaction-policy-engine`          → `./companion.js` (settings + prompt rule)
 *   - `dsh-compaction-policy-engine/engine`   → this file (the compaction engine)
 *
 * The bare name must stay the companion: the host plane is where the browser
 * bundle anchor lives, and that row must never mount a second engine — the host
 * plane's `agent/pre-step` sees every preset's engine by bubbling, so a host
 * engine would run *beside* the preset one and the lower threshold would win.
 *
 * @module dsh-compaction-policy-engine/engine
 */

export { CompactionControlEngine as default, CompactionControlEngine } from './index.js';
