// server/tailer.js — follow append-only transcripts: read only the bytes that arrived since last time,
// hand whole lines to a callback, and discover subagent transcripts as Claude Code writes them.
// Polling, not inotify: file notifications do not cross Docker's VM boundary (ADR-0002, ADR-0009).
import fs from 'node:fs';
import path from 'node:path';

/** Files larger than this on first sight are streamed in chunks instead of read into one buffer. */
const BULK_BYTES = 2 * 1024 * 1024;
/** Chunk size for both the bulk stream and ordinary appended reads. */
const CHUNK = 512 * 1024;

/**
 * @typedef {Object} Source
 * @property {string} key        caller's identifier, e.g. "<sessionId>" or "<sessionId>/<agentId>"
 * @property {string} file
 * @property {Object} meta       opaque: handed back with every batch of lines
 * @property {number} pos        bytes consumed so far
 * @property {string} rem        trailing bytes of a half-written last line
 * @property {boolean} missing   the file has not appeared yet (or went away)
 * @property {number} mtimeMs
 * @property {boolean} primed    the first read has finished
 */

/**
 * @typedef {Object} Tailer
 * @property {(key:string, file:string, meta?:Object)=>boolean} add
 * @property {(key:string)=>void} remove
 * @property {(key:string)=>boolean} has
 * @property {(sessionId:string, dir:string)=>void} watchSubagents
 * @property {()=>Promise<void>} poll
 * @property {(key:string)=>number} freshness      mtime of a source, 0 when unknown
 * @property {()=>void} close
 */

/**
 * Create a tailer.
 * @param {{log:Object, onLines:(key:string, lines:string[], meta:Object)=>void,
 *          onSubagent?:(sessionId:string, agentId:string, files:{transcript:string, meta:string|null})=>void,
 *          bulkBytes?:number}} opts
 * @returns {Tailer}
 */
export function createTailer(opts) {
  const log = opts.log;
  const onLines = opts.onLines;
  const onSubagent = opts.onSubagent || (() => {});
  const bulkBytes = opts.bulkBytes ?? BULK_BYTES;
  /** @type {Map<string,Source>} */
  const sources = new Map();
  /** @type {Map<string,{dir:string, seen:Set<string>}>} */
  const subDirs = new Map();
  let closed = false;
  let running = false;

  /**
   * Follow a file. Safe to call repeatedly with the same key.
   * @param {string} key @param {string} file @param {Object} [meta] @returns {boolean} true when newly added
   */
  function add(key, file, meta = {}) {
    const cur = sources.get(key);
    if (cur) { cur.meta = { ...cur.meta, ...meta }; return false; }
    sources.set(key, { key, file, meta, pos: 0, rem: '', missing: false, mtimeMs: 0, primed: false });
    return true;
  }

  /** Stop following a file. @param {string} key */
  function remove(key) { sources.delete(key); }

  /** @param {string} key @returns {boolean} */
  function has(key) { return sources.has(key); }

  /** mtime of a followed file, 0 when unknown. @param {string} key @returns {number} */
  function freshness(key) { return sources.get(key)?.mtimeMs ?? 0; }

  /**
   * Watch `<projectDir>/<sessionId>/subagents/` for `agent-*.jsonl` appearing.
   * @param {string} sessionId @param {string} dir
   */
  function watchSubagents(sessionId, dir) {
    if (!subDirs.has(sessionId)) subDirs.set(sessionId, { dir, seen: new Set() });
    else subDirs.get(sessionId).dir = dir;
  }

  /** One poll pass: scan for new subagent files, then read everything that grew. */
  async function poll() {
    if (closed || running) return;
    running = true;
    try {
      for (const [sessionId, w] of subDirs) await scanSubagents(sessionId, w);
      for (const src of [...sources.values()]) {
        if (closed) break;
        await pump(src);
      }
    } finally { running = false; }
  }

  /** @param {string} sessionId @param {{dir:string, seen:Set<string>}} w */
  async function scanSubagents(sessionId, w) {
    let names;
    try { names = await fs.promises.readdir(w.dir); } catch { return; } // not created yet: normal
    for (const n of names) {
      if (!n.startsWith('agent-') || !n.endsWith('.jsonl')) continue;
      const agentId = n.slice('agent-'.length, -'.jsonl'.length);
      if (!agentId || w.seen.has(agentId)) continue;
      w.seen.add(agentId);
      const transcript = path.join(w.dir, n);
      const metaFile = path.join(w.dir, `agent-${agentId}.meta.json`);
      let metaPath = null;
      try { await fs.promises.access(metaFile, fs.constants.R_OK); metaPath = metaFile; } catch { /* optional */ }
      // onSubagent returns false when it cannot decide yet (the session is not known); try again next pass
      try { if (onSubagent(sessionId, agentId, { transcript, meta: metaPath }) === false) w.seen.delete(agentId); }
      catch (e) { log.warn(`subagent ${agentId}: could not register`, e); }
    }
  }

  /** Read whatever arrived in one source. Errors are logged, never thrown. @param {Source} src */
  async function pump(src) {
    let st;
    try { st = await fs.promises.stat(src.file); }
    catch (e) {
      if (!src.missing) { src.missing = true; if (e.code !== 'ENOENT') log.warn(`cannot stat ${src.file}`, e); }
      return;
    }
    src.missing = false;
    src.mtimeMs = st.mtimeMs;
    if (st.size < src.pos) {                       // rotated or rewritten: start again
      log.info(`${path.basename(src.file)} shrank (${src.pos} → ${st.size} bytes); re-reading from the start`);
      src.pos = 0; src.rem = '';
    }
    if (st.size === src.pos) return;
    if (!src.primed && st.size > bulkBytes) await bulkRead(src, st.size);
    else await rangeRead(src, st.size);
    src.primed = true;
  }

  /**
   * First read of a large file: stream it once in chunks so a 40 MB transcript never lands in one buffer.
   * @param {Source} src @param {number} upto
   */
  async function bulkRead(src, upto) {
    const t0 = Date.now();
    let stream;
    try { stream = fs.createReadStream(src.file, { start: 0, end: upto - 1, highWaterMark: CHUNK, encoding: 'utf8' }); }
    catch (e) { log.warn(`cannot open ${src.file}`, e); return; }
    let n = 0;
    try {
      for await (const chunk of stream) { n += emit(src, chunk); }
    } catch (e) { log.warn(`read failed on ${src.file}`, e); }
    src.pos = upto;
    log.info(`read ${(upto / 1048576).toFixed(1)} MB of ${path.basename(src.file)} (${n} records, ${Date.now() - t0} ms)`);
  }

  /**
   * Read the bytes appended since the last poll.
   * @param {Source} src @param {number} upto
   */
  async function rangeRead(src, upto) {
    let fh;
    try { fh = await fs.promises.open(src.file, 'r'); }
    catch (e) { log.warn(`cannot open ${src.file}`, e); return; }
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, upto - src.pos));
      while (src.pos < upto) {
        const want = Math.min(buf.length, upto - src.pos);
        const { bytesRead } = await fh.read(buf, 0, want, src.pos);
        if (bytesRead <= 0) break;
        src.pos += bytesRead;
        emit(src, buf.toString('utf8', 0, bytesRead));
      }
    } catch (e) {
      log.warn(`read failed on ${src.file}`, e);
    } finally { await fh.close().catch(() => {}); }
  }

  /**
   * Split a chunk into whole lines, keeping any partial last line for next time.
   * @param {Source} src @param {string} chunk @returns {number} lines handed on
   */
  function emit(src, chunk) {
    const parts = (src.rem + chunk).split('\n');
    src.rem = parts.pop() ?? '';
    if (src.rem.length > 8 * 1024 * 1024) { // a line this long is corruption, not a record
      log.warn(`${path.basename(src.file)}: dropping an over-long partial line (${src.rem.length} bytes)`);
      src.rem = '';
    }
    const lines = parts.filter((l) => l.length > 0);
    if (!lines.length) return 0;
    try { onLines(src.key, lines, src.meta); }
    catch (e) { log.error(`handler failed for ${src.key}`, e); }
    return lines.length;
  }

  function close() { closed = true; sources.clear(); subDirs.clear(); }

  return { add, remove, has, watchSubagents, poll, freshness, close };
}
