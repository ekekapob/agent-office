// server/registry.js — poll `<data_root>/sessions/*.json` and turn it into Session upserts and removals.
// Identity is `sessionId`, never the pid: a resumed session writes a new `<pid>.json` and deletes the old one,
// which must look like the same Session with a new pid (fixtures/README.md).
import fs from 'node:fs';
import path from 'node:path';
import { parseRegistryFile } from '../shared/adapter.js';
import { isPidAlive, isLocalDataRoot, projectSlug, transcriptPath } from './platform.js';

/** A session file must be gone this long before we call the session finished (covers the resume gap). */
const REMOVE_GRACE_MS = 3000;


/** @typedef {import('../shared/types.js').Session} Session */

/**
 * @typedef {Object} Registry
 * @property {()=>Promise<void>} poll
 * @property {()=>Session[]} list
 * @property {(id:string)=>Session|undefined} get
 * @property {()=>boolean} sawFolder    the sessions folder exists
 * @property {()=>void} close
 */

/**
 * Create the registry watcher.
 * @param {{dataRoot:string, config:Object, log:Object,
 *          onSession:(s:Session)=>void, onRemoved:(id:string)=>void, now?:()=>number}} opts
 * @returns {Registry}
 */
export function createRegistry(opts) {
  const { dataRoot, config, log, onSession, onRemoved } = opts;
  const now = opts.now || (() => Date.now());
  const dir = path.join(dataRoot, 'sessions');
  const include = compileGlobs(config.sessions_include);
  const exclude = compileGlobs(config.sessions_exclude);
  /** @type {Map<string,{session:Session, pidFile:string, missingSince:number}>} */
  const known = new Map();
  let folderSeen = false;
  let closed = false;
  let warnedFolder = false;
  // pid liveness only means something when we can see the same process table as Claude Code
  const pidLiveness = config.mode !== 'docker' && isLocalDataRoot(dataRoot);

  /** One poll pass. Never throws: an unreadable file is skipped with a warning. */
  async function poll() {
    if (closed) return;
    let names;
    try { names = await fs.promises.readdir(dir); folderSeen = true; }
    catch (e) {
      if (!warnedFolder) { warnedFolder = true; log.warn(`cannot read ${dir}; no sessions will appear`, e); }
      return;
    }
    warnedFolder = false;
    /** @type {Map<string,Session>} */
    const found = new Map();
    /** @type {Map<string,string>} */
    const files = new Map();
    for (const n of names) {
      if (!n.endsWith('.json')) continue;                      // `.key` files sit beside them
      const file = path.join(dir, n);
      const s = await readSession(file);
      if (!s) continue;
      if (!wanted(s.cwd)) continue;
      const prev = found.get(s.id);
      if (prev && prev.updatedAt >= s.updatedAt) continue;      // keep the freshest file for a session id
      found.set(s.id, s);
      files.set(s.id, file);
    }
    const t = now();
    for (const [id, s] of found) {
      const entry = known.get(id);
      s.transcriptPath = transcriptPath(dataRoot, s.cwd, s.id);
      s.liveness = await alive(s);
      if (entry) {                                             // carry forward what the transcript told us
        const merged = { ...entry.session, ...s, name: pickName(entry.session, s) };
        if (same(entry.session, merged) && entry.pidFile === files.get(id)) { entry.missingSince = 0; continue; }
        entry.session = merged; entry.pidFile = files.get(id); entry.missingSince = 0;
        emit(merged);
      } else {
        known.set(id, { session: s, pidFile: files.get(id), missingSince: 0 });
        log.info(`session ${s.id.slice(0, 8)} · ${s.name} · pid ${s.pid}`);
        emit(s);
      }
    }
    for (const [id, entry] of [...known]) {
      if (found.has(id)) continue;
      if (!entry.missingSince) { entry.missingSince = t; continue; }
      if (t - entry.missingSince < REMOVE_GRACE_MS) continue;   // a resume deletes the old file before writing the new
      known.delete(id);
      log.info(`session ${id.slice(0, 8)} ended`);
      try { onRemoved(id); } catch (e) { log.error('onRemoved failed', e); }
    }
  }

  /** @param {Session} s */
  function emit(s) { try { onSession({ ...s }); } catch (e) { log.error('onSession failed', e); } }

  /** Read and parse one registry file. @param {string} file @returns {Promise<Session|null>} */
  async function readSession(file) {
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') log.warn(`cannot read ${file}`, e); return null; }
    let json;
    try { json = JSON.parse(text); }
    catch { log.warn(`${path.basename(file)} is not valid JSON (half-written?); skipped`); return null; }
    const s = parseRegistryFile(json, { now: now() });
    if (!s) { log.warn(`${path.basename(file)} has no sessionId; skipped`); return null; }
    return s;
  }

  /**
   * Is this session's process still there? Natively by pid; in docker, or against someone else's
   * data folder, by how recently the registry file was touched (`stale_after_s`).
   * @param {Session} s @returns {Promise<boolean>}
   */
  async function alive(s) {
    if (pidLiveness && Number.isInteger(s.pid)) return isPidAlive(s.pid);
    // No host process table (docker, or someone else's data folder). Claude Code deletes a session's
    // registry file when it ends, so the file being here at all is the signal we have. An idle session
    // can sit untouched for a day and still be alive, and claiming otherwise would be a guess.
    return true;
  }

  /** A user-set registry name wins; otherwise keep whatever the transcript's title gave us. */
  function pickName(prev, next) {
    if (next.name && next.name !== prev.cwd.split(/[\\/]/).pop()) return next.name;
    return prev.name || next.name;
  }

  /** @param {string} cwd @returns {boolean} */
  function wanted(cwd) {
    if (include.length && !include.some((re) => re.test(cwd))) return false;
    if (exclude.length && exclude.some((re) => re.test(cwd))) return false;
    return true;
  }

  return {
    poll,
    list: () => [...known.values()].map((e) => e.session),
    get: (id) => known.get(id)?.session,
    sawFolder: () => folderSeen,
    close() { closed = true; known.clear(); },
  };
}

/** Only the fields the registry owns, so transcript-driven updates do not cause churn. */
function same(a, b) {
  return a.pid === b.pid && a.status === b.status && a.updatedAt === b.updatedAt
    && a.name === b.name && a.liveness === b.liveness && a.cwd === b.cwd;
}

/**
 * Turn shell-style path globs into regular expressions. `*` stops at a separator, `**` does not.
 * @param {string[]|undefined} globs
 * @returns {RegExp[]}
 */
export function compileGlobs(globs) {
  if (!Array.isArray(globs)) return [];
  const out = [];
  for (const g of globs) {
    if (typeof g !== 'string' || !g) continue;
    const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '.');
    try { out.push(new RegExp(`^${body}$`)); } catch { /* an unusable glob simply matches nothing */ }
  }
  return out;
}

/**
 * Where a session's subagent transcripts live: `<data_root>/projects/<slug>/<sessionId>/subagents/`.
 * @param {string} dataRoot @param {string} cwd @param {string} sessionId
 * @returns {string}
 */
export function subagentsDir(dataRoot, cwd, sessionId) {
  return path.join(dataRoot, 'projects', projectSlug(cwd), sessionId, 'subagents');
}
