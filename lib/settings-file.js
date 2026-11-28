/**
 * Direct readers for this plugin's operator-editable configuration.
 *
 * Two files can carry the section on this deployment, and they are not
 * equivalent:
 *
 *   - `$DSH_HOME/settings.yaml` is what the settings provider reads, but a
 *     dsh that ships the profile importer renames it to `settings.yaml.imported`
 *     at boot and thereafter it never exists. A watcher pointed only here reads
 *     ENOENT forever and reports the composition fallback on every poll, so an
 *     operator edit reaches the engine only through a restart.
 *   - `<profile>/cordis.patch.yml` is the layer the profile actually loads, and
 *     in this deployment it is the file a person edits. Nothing in dsh watches
 *     it (its own header says a restart is required), so the engine has to poll
 *     it to honour "edit and it takes effect".
 *
 * Both are read, patch file last, because the patch file is the layer that
 * wins when dsh builds the composition. A malformed document is reported and
 * ignored, keeping the previous policy.
 *
 * @module dsh-compaction-policy-engine/settings-file
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolve the DSH home the way the host does (`@deepseek-ai/dsh-home-paths`):
 * the home the host reports, then a non-blank `DSH_HOME`, then `os.homedir()/.dsh`.
 *
 * Why not `HOME`: Windows has no `HOME` (it has `USERPROFILE`, which
 * `os.homedir()` reads), and the desktop host starts dsh with neither variable
 * set and `cwd = <home>/profiles/desktop`. `join(process.env.HOME ?? '', '.dsh')`
 * therefore produced the *relative* path `.dsh` there, every candidate resolved
 * to `<home>/profiles/desktop/.dsh/profiles/desktop/cordis.patch.yml`, and the
 * patch layer that carried the operator's threshold was never read — the engine
 * ran on its 0.8 baseline while the settings card read 42%. Measured 2026-11-28
 * on a Win11 `desktop` profile; silent, because a missing candidate is the
 * normal case for every file but one.
 *
 * `hostHome` is `ctx.profileContext.home`, which the host provides before any
 * profile row mounts, so a `--dsh-home` the launcher was given without exporting
 * it is still honoured. A blank value is not an answer (the core treats a blank
 * `DSH_HOME` as unset, so that an empty override never resolves to the cwd).
 *
 * @param env - the environment to read.
 * @param hostHome - the home reported by the running host, when known.
 * @returns the absolute harness home.
 */
export function resolveDshHome(env = process.env, hostHome = undefined) {
	const chosen = nonBlank(hostHome) ?? nonBlank(env.DSH_HOME);
	return resolve(chosen === undefined ? join(homedir(), '.dsh') : expandHome(chosen));
}

/** A string with non-whitespace content, else undefined. */
function nonBlank(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Expand a leading `~` against `os.homedir()`, as the host's own resolver does. */
function expandHome(path) {
	if (path === '~') return homedir();
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
	return path;
}

/** The settings document this plugin's section lives in. */
export function settingsFilePath(home = resolveDshHome()) {
	return join(home, 'settings.yaml');
}

/**
 * The profile patch layer that carries this plugin's entry, if it is present.
 *
 * Every candidate is derived from the resolved harness home (see
 * {@link resolveDshHome}), never hardcoded: a test that redirects `DSH_HOME` to
 * a temp directory must not have the real profile's config read into it, and a
 * hardcoded `/Users/...` path did exactly that — it outranked the redirect and
 * silently replaced every fixture.
 *
 * `DSH_PROFILE` names the profile when dsh exports it; `web` is the profile
 * this deployment uses, and a wrong guess only costs one failed read per
 * second because a missing file means "no patch layer".
 *
 * @param env - the environment to read.
 * @param profileName - the running profile, from `ctx.profileContext.name`.
 * @param hostHome - the harness home reported by the running host, when known.
 * @returns absolute path candidates, most specific first.
 */
export function patchFilePaths(env = process.env, profileName = undefined, hostHome = undefined) {
	const home = resolveDshHome(env, hostHome);
	const profiles = [];
	// `profileName` is the authoritative answer: the host exposes the *running*
	// profile as `ctx.profileContext.name`, and this plugin passes it in.
	//
	// `DSH_PROFILE` is only a hint, and a dangerous one. The host injects it into
	// every shell tool execution so a subprocess can see *its parent's* profile;
	// a `dsh --profile other …` launched from inside an agent therefore inherits
	// `DSH_PROFILE` naming the parent. Relying on it made this plugin watch
	// `profiles/web/cordis.patch.yml` while running under `--profile headless`,
	// so a patch layer that was present and correct read as "no patch layer" —
	// silently, once a second, forever. Measured 2026-11-25.
	if (typeof profileName === 'string' && profileName !== '') profiles.push(profileName);
	else if (env.DSH_PROFILE !== undefined && env.DSH_PROFILE !== '') profiles.push(env.DSH_PROFILE);
	if (!profiles.includes('web')) profiles.push('web');
	return profiles.map((profile) => join(home, 'profiles', profile, 'cordis.patch.yml'));
}

/**
 * Loader entry ids that can carry this plugin's config, in priority order.
 *
 * The settings plane exposes `compaction-control-settings`, while older profiles
 * and backups may only expose `compaction-control-host`. The panel and engine
 * must read the same authority, so the first entry with a readable config wins.
 *
 * @type {readonly string[]}
 */
export const PATCH_ENTRY_IDS = ['compaction-control-settings', 'compaction-control-host'];

/**
 * Read this plugin's entry config out of a profile patch document.
 *
 * The patch file is a top-level sequence of loader entries. A candidate entry
 * with a `config:` mapping supplies the policy, and only a fully parsed block is
 * returned — a half-read entry would silently replace the policy with a partial
 * document, which is worse than keeping the last good one.
 *
 * @param text - the whole patch document.
 * @param entryId - one loader entry id, or candidate ids in priority order.
 * @returns the first readable entry's config mapping, or undefined when absent.
 */
export function readPatchEntryConfig(text, entryId = PATCH_ENTRY_IDS) {
	const entryIds = Array.isArray(entryId) ? entryId : [entryId];
	for (const id of entryIds) {
		const config = readOnePatchEntryConfig(text, id);
		if (config !== undefined) return config;
	}
	return undefined;
}

/**
 * Read one loader entry's config, preserving the original file-order merge.
 *
 * `parseSettingsDocument` is built for a mapping-rooted settings file and
 * rejects a sequence root, which is what a patch file has. Scanning the
 * entry's own block by indentation is both simpler and stricter here: it
 * reads exactly the lines under `- id: <entryId>`, so a second entry that
 * mentions the same key cannot bleed into this one.
 *
 * Every matching entry is collected and merged in file order, later entries
 * winning. One id can legitimately appear more than once: the host-plane
 * entry and a preset-plane entry are separate mounts of the same engine, and
 * the operator restates only what differs. Returning the first match dropped
 * the chain whenever the first mount happened to omit it.
 *
 * @param text - the whole patch document.
 * @param entryId - the loader entry id to read.
 * @returns the merged config mapping, or undefined when absent or unreadable.
 */
function readOnePatchEntryConfig(text, entryId) {
	const lines = text.split('\n');
	const configs = [];
	let index = 0;
	while (index < lines.length) {
		const line = stripComment(lines[index]);
		index += 1;
		// `stripComment` already removed any `#`-prefixed text, so a commented-out
		// mention of the id can never equal the header below — no separate comment
		// check is needed, and adding one only creates an unreachable branch.
		if (line.trim() !== `- id: ${entryId}`) continue;
		// The item's own keys sit at the indent of `id:` plus two (the `- ` cost).
		const itemIndent = line.length - line.trimStart().length;
		const childIndent = itemIndent + 2;
		let configIndent;
		const configLines = [];
		for (; index < lines.length; index += 1) {
			const raw = lines[index];
			const bare = stripComment(raw);
			if (bare.trim() === '') continue;
			const indent = bare.length - bare.trimStart().length;
			// A `- ` at the item indent starts the next entry.
			if (indent <= itemIndent && bare.trimStart().startsWith('- ')) break;
			if (indent <= itemIndent) break;
			if (configIndent === undefined) {
				// `config:` must be a direct child of the entry, not a nested one.
				// Sibling keys at the same indent (`name:`) are skipped, not fatal.
				if (indent === childIndent && bare.trim() === 'config:') {
					configIndent = indent;
					continue;
				}
				continue;
			}
			// Everything indented under `config:` belongs to it.
			if (indent <= configIndent) break;
			// Re-anchor the block to column zero so the settings parser can read it.
			configLines.push(raw.slice(configIndent + 2));
		}
		if (configLines.length === 0) continue;
		const parsed = parseSettingsDocument(`${configLines.join('\n')}\n`);
		if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
		configs.push(parsed);
	}
	if (configs.length === 0) return undefined;
	// Deep-merge so a later entry's single field does not erase the earlier
	// entry's whole `default` block.
	let merged = configs[0];
	for (const config of configs.slice(1)) merged = mergeConfig(merged, config);
	return merged;
}

/**
 * Recursively merge two config mappings, `override` winning on scalars. Arrays
 * replace rather than concatenate: a fallback chain is ordered, and a later
 * entry states the whole order rather than an increment to it.
 *
 * @param base - the lower-precedence mapping.
 * @param override - the higher-precedence mapping.
 * @returns the merged mapping.
 */
function mergeConfig(base, override) {
	if (base === null || typeof base !== 'object' || Array.isArray(base)) return override;
	if (override === null || typeof override !== 'object' || Array.isArray(override)) return override;
	const merged = { ...base };
	for (const [key, value] of Object.entries(override)) {
		merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
	}
	return merged;
}

/** Strip an inline `# comment`, respecting single and double quotes. */
function stripComment(text) {
	let quote = null;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quote !== null) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === '#' && (index === 0 || text[index - 1] === ' ' || text[index - 1] === '\t')) {
			return text.slice(0, index);
		}
	}
	return text;
}

/** Parse a scalar the way the settings schema accepts it. */
function scalar(text) {
	const value = text.trim();
	if (value === '') return undefined;
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (value === 'null' || value === '~') return null;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Parse a nested YAML mapping well enough for `settings.yaml`: block mappings,
 * block sequences of mappings, and scalars — no anchors, flow collections, or
 * multi-line scalars, because this plugin controls the document's shape and stays
 * dependency-free.
 */
export function parseSettingsDocument(text) {
	const root = {};
	/** Stack of `{ indent, container }` for the open block at each depth. */
	const stack = [{ indent: -1, container: root }];

	for (const rawLine of text.split('\n')) {
		if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue;
		const withoutComment = stripComment(rawLine);
		if (withoutComment.trim() === '') continue;
		const indent = withoutComment.length - withoutComment.trimStart().length;
		const line = withoutComment.trim();

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
		const parent = stack[stack.length - 1].container;

		if (line.startsWith('- ')) {
			const frame = stack[stack.length - 1];
			let container = frame.container;
			if (!Array.isArray(container)) {
				// The key was provisionally a mapping (`providers:` / a `models[0]`
				// block); the first `- ` item settles that it is a sequence.
				if (frame.key === undefined || frame.owner === undefined) return undefined;
				container = [];
				frame.owner[frame.key] = container;
				frame.container = container;
			}
			const rest = line.slice(2).trim();
			// A `- key: value` item opens a mapping; a bare `- value` is a scalar
			// item (the fallback chain is a list of `provider/model` strings, and
			// treating every item as a mapping produced `[{}, {}, {}]`).
			const colon = rest.indexOf(': ');
			if (colon === -1 && !rest.endsWith(':')) {
				container.push(scalar(rest));
				continue;
			}
			const item = {};
			container.push(item);
			if (colon !== -1) {
				const key = rest.slice(0, colon).trim();
				const value = scalar(rest.slice(colon + 1));
				if (value !== undefined) item[key] = value;
				stack.push({ indent, container: item });
			}
			continue;
		}

		const colon = line.indexOf(':');
		if (colon === -1 || Array.isArray(parent)) return undefined;
		const key = line.slice(0, colon).trim();
		const rest = line.slice(colon + 1);

		if (rest.trim() === '') {
			// Open a block; which one it is is decided by the next line, so a
			// placeholder object is installed and replaced when a sequence starts.
			const block = {};
			parent[key] = block;
			stack.push({ indent, container: block, key, owner: parent });
			continue;
		}
		if (rest.trim() === '|' || rest.trim() === '>') return undefined;
		parent[key] = scalar(rest);
	}

	return root;
}

/**
 * Read this plugin's section out of a settings document.
 * @param text - the whole settings document.
 * @returns the section, or undefined when absent or unreadable.
 */
export function readSection(text) {
	const parsed = parseSettingsDocument(text);
	if (parsed === undefined || parsed === null || typeof parsed !== 'object') return undefined;
	const section = parsed['compaction-control'];
	if (section === undefined) return undefined;
	if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined;
	return section;
}

/**
 * Watch `settings.yaml` and report this plugin's section on every change.
 *
 * The initial read is synchronous, so the gate carries the operator's threshold
 * from the very first step. The poll compares the *parsed section* rather than
 * asking `fs.watchFile` whether the stat changed: `watchFile`'s baseline snapshot
 * is taken asynchronously, so an edit landing before it completes becomes the
 * baseline and is never reported (measured: ~1 run in 3 under load). Content
 * comparison has no baseline to lose; the cost is one small read per second.
 *
 * @param options - `file`, `fallbackSection`, `onSection`, `onError`, `intervalMs`.
 * @returns a disposer that stops watching.
 */
export function watchSettingsFile(options) {
	const { file, fallbackSection, onSection, onError, intervalMs = 1000 } = options;
	let last = null;
	const read = (initial) => {
		let text;
		try {
			text = readFileSync(file, 'utf8');
		} catch (error) {
			// A missing file is normal (the provider may not have written one yet)
			// and must not take the engine down; any other failure is worth a line.
			if (error?.code !== 'ENOENT') onError?.(error);
			if (initial) onSection(fallbackSection, 'composition');
			return;
		}
		let section;
		try {
			section = readSection(text);
		} catch (error) {
			onError?.(error);
			return;
		}
		if (section === undefined) {
			if (initial) onSection(fallbackSection, 'composition');
			return;
		}
		const serialized = JSON.stringify(section);
		if (serialized === last) return;
		last = serialized;
		onSection(section, 'settings.yaml');
	};
	read(true);
	// `unref` rather than `persistent: false`: a plugin-owned timer must never be
	// the reason the host process (or a test runner) stays alive.
	const timer = setInterval(() => read(false), intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * Watch a profile patch file and report this plugin's entry config on change.
 *
 * Same contract and same content-comparison poll as {@link watchSettingsFile},
 * but the source is `cordis.patch.yml` and the extracted value is the entry's
 * `config:` mapping rather than a `compaction-control:` section. This is the
 * source that actually feeds the composition in a dsh that ships the profile
 * importer, so without it an edit to the patch file needs a restart.
 *
 * The first candidate that yields a config wins, and the reported `origin`
 * names the file so a log line can tell the two sources apart.
 *
 * A candidate that does not exist is the normal case for every file but one,
 * so it is skipped quietly — but when *no* candidate exists the engine is
 * running on the composition defaults, which for this plugin means the built-in
 * baseline rather than the operator's policy. That is reported once through
 * `onMissing`, naming the paths that were tried: on 2026-11-28 the Windows
 * desktop host resolved every candidate to a non-existent path and the only
 * symptom was a session that compacted at 80% instead of 42%.
 *
 * @param options - `files`, `entryId` (string or candidate ids), `onConfig`, `onError`, `onMissing`, `intervalMs`.
 * @returns a disposer that stops watching.
 */
export function watchPatchFile(options) {
	const { files, entryId = PATCH_ENTRY_IDS, onConfig, onError, onMissing, intervalMs = 1000 } = options;
	let last = null;
	let missingReported = false;
	const read = () => {
		let anyExists = false;
		for (const file of files) {
			let text;
			try {
				text = readFileSync(file, 'utf8');
			} catch (error) {
				// Missing is the normal case for every candidate but one.
				if (error?.code !== 'ENOENT') onError?.(error);
				continue;
			}
			anyExists = true;
			let config;
			try {
				config = readPatchEntryConfig(text, entryId);
			} catch (error) {
				onError?.(error);
				return;
			}
			if (config === undefined) continue;
			const serialized = JSON.stringify(config);
			if (serialized === last) return;
			last = serialized;
			onConfig(config, file);
			return;
		}
		// No candidate carried the entry: leave the last good config in place
		// rather than reverting to the composition on a transient read failure.
		// No candidate *exists* at all is different: nothing will ever arrive,
		// and the operator has to hear which paths were tried.
		if (!anyExists && !missingReported) {
			missingReported = true;
			onMissing?.(files);
		}
	};
	read();
	const timer = setInterval(read, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
