// server/demo.js — two ways to run without a live Claude Code:
//   --demo            play fixtures/demo.jsonl (recorded StreamEvents) on a loop; the stream is a real
//                     SSE stream, so the page reads "live" exactly as it does against real sessions.
//   --replay <file>   push a recorded transcript through the real adapter at 20× speed.
// (ADR-0005: the demo is a recording of state, never a second simulation.)
import fs from 'node:fs';
import readlinePromises from 'node:readline';
import { parseTranscriptLine } from '../shared/adapter.js';
import { homeDir } from './platform.js';

/** The demo recording repeats on this period. */
export const DEMO_LOOP_MS = 125000;

/** @typedef {import('../shared/types.js').Snapshot} Snapshot */

/**
 * Apply one StreamEvent to a snapshot, in place. Mirrors web/js/store.js so the demo and the page agree.
 * @param {Snapshot} s @param {{type:string,data:any}} ev
 * @returns {boolean} whether anything changed
 */
export function applyStreamEvent(s, ev) {
  if (!ev || typeof ev.type !== 'string') return false;
  const d = ev.data;
  switch (ev.type) {
    case 'snapshot':
      if (!d || typeof d !== 'object') return false;
      s.now = d.now || Date.now();
      s.sessions = { ...(d.sessions || {}) }; s.agents = { ...(d.agents || {}) };
      s.huddles = { ...(d.huddles || {}) }; s.alerts = { ...(d.alerts || {}) };
      s.feed = Array.isArray(d.feed) ? d.feed.slice(0, 2000) : [];
      if (d.health) s.health = { ...s.health, ...d.health };
      return true;
    case 'session': return put(s.sessions, d);
    case 'session_removed': return del(s.sessions, d);
    case 'agent': return put(s.agents, d);
    case 'agent_removed': return del(s.agents, d);
    case 'huddle': return put(s.huddles, d);
    case 'huddle_removed': return del(s.huddles, d);
    case 'alert': return put(s.alerts, d);
    case 'alert_cleared': return del(s.alerts, d);
    case 'feed':
      if (!d) return false;
      s.feed.unshift(d);
      if (s.feed.length > 2000) s.feed.length = 2000;
      return true;
    case 'health': if (!d) return false; s.health = { ...s.health, ...d }; return true;
    case 'error': return true;
    default: return false;
  }
}
function put(map, d) { if (!d || typeof d.id !== 'string') return false; map[d.id] = d; return true; }
function del(map, d) { if (!d || typeof d.id !== 'string') return false; delete map[d.id]; return true; }

/** @returns {Snapshot} */
export function emptySnapshot(health = {}) {
  return { now: Date.now(), sessions: {}, agents: {}, huddles: {}, alerts: {}, feed: [],
    health: { version: '0.1.0', dataRoot: '(demo)', mode: 'native', sessions: 0, agents: 0, hooksSeen: false, lastErrors: [], drift: [], ...health } };
}

/**
 * Read `fixtures/demo.jsonl`: one `{t, type, data}` per line, ordered by `t`.
 * @param {string} file @param {Object} log
 * @returns {Array<{t:number,type:string,data:any}>}
 */
export function readDemoFile(file, log) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { log.error(`cannot read the demo recording ${file}`, e); return []; }
  const out = [];
  text.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      const r = JSON.parse(s);
      if (!Number.isFinite(r.t) || typeof r.type !== 'string') { log.warn(`${file}:${i + 1} is not a {t,type,data} record; skipped`); return; }
      out.push({ t: r.t, type: r.type, data: r.data });
    } catch { log.warn(`${file}:${i + 1} is not JSON; skipped`); }
  });
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Play the recording on a loop and act as an SSE source.
 * @param {{file:string, log:Object, loopMs?:number, health?:Object}} opts
 * @returns {{on:(fn:Function)=>()=>void, snapshot:()=>Snapshot, start:()=>void, stop:()=>void, size:()=>number}}
 */
export function createDemoSource(opts) {
  const { log } = opts;
  const loopMs = opts.loopMs ?? DEMO_LOOP_MS;
  const events = readDemoFile(opts.file, log);
  const listeners = new Set();
  let snap = emptySnapshot({ ...opts.health, dataRoot: '(demo)' });
  let timer = null;
  let idx = 0;
  let base = 0;
  let stopped = false;

  if (!events.length) log.warn(`the demo recording ${opts.file} is empty; the deck will be blank`);

  function emit(ev) {
    applyStreamEvent(snap, ev);
    snap.now = Date.now();
    for (const fn of listeners) { try { fn(ev); } catch (e) { log.error('demo listener failed', e); } }
  }

  function step() {
    if (stopped) return;
    const elapsed = Date.now() - base;
    while (idx < events.length && events[idx].t <= elapsed) {
      const e = events[idx++];
      emit({ type: e.type, data: rebase(e.data, base) });
    }
    if (idx >= events.length && elapsed >= loopMs) { // wrap: start the world again from the recording's first frame
      idx = 0; base = Date.now();
      snap = emptySnapshot({ ...opts.health, dataRoot: '(demo)' });
      log.debug('demo loop restarting');
    }
    const nextAt = idx < events.length ? events[idx].t : loopMs;
    const wait = Math.max(30, Math.min(1000, nextAt - (Date.now() - base)));
    timer = setTimeout(step, wait);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot() { snap.now = Date.now(); return snap; },
    size: () => events.length,
    start() { if (timer) return; stopped = false; base = Date.now(); idx = 0; step(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; listeners.clear(); },
  };
}

/**
 * Recorded timestamps are offsets from the loop start; turn them into wall-clock times so the page's
 * "3s ago" labels read correctly.
 * @param {any} data @param {number} base
 */
function rebase(data, base) {
  if (!data || typeof data !== 'object') return data;
  const out = Array.isArray(data) ? data.slice() : { ...data };
  for (const k of ['t', 'since', 'spawnedAt', 'startedAt', 'updatedAt', 'when', 'now']) {
    if (typeof out[k] === 'number' && out[k] < 1e11) out[k] = base + out[k];
  }
  if (Array.isArray(out.feed)) out.feed = out.feed.map((f) => rebase(f, base));
  for (const k of ['sessions', 'agents', 'huddles', 'alerts']) {
    if (out[k] && typeof out[k] === 'object') {
      const m = {};
      for (const [id, v] of Object.entries(out[k])) m[id] = rebase(v, base);
      out[k] = m;
    }
  }
  return out;
}

/**
 * Push a recorded transcript through the adapter into the live state, faster than real time.
 * @param {{file:string, state:Object, config:Object, log:Object, speed?:number, sessionId?:string}} opts
 * @returns {Promise<{lines:number, events:number}>}
 */
export async function replayTranscript(opts) {
  const { file, state, log } = opts;
  const speed = opts.speed || 20;
  const home = homeDir();
  let stream;
  try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
  catch (e) { log.error(`cannot open ${file}`, e); return { lines: 0, events: 0 }; }
  const rl = readlinePromises.createInterface({ input: stream, crlfDelay: Infinity });
  const ctx = { sessionId: opts.sessionId || null, agentId: null, version: null, cwd: null, home,
    pendingTools: new Map(), seenDrift: new Set(), now: Date.now() };
  let session = null;
  let lines = 0;
  let count = 0;
  let prevT = 0;
  const t0 = Date.now();
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    if (!session) session = seed(line, state, ctx, file, log);
    const evs = parseTranscriptLine(line, ctx);
    if (!evs.length) continue;
    count += evs.length;
    const t = evs[0].t || 0;
    if (prevT && t > prevT) {
      const wait = Math.min(400, (t - prevT) / speed);
      if (wait > 8) await sleep(wait);
    }
    if (t) prevT = t;
    state.apply(evs);
  }
  log.info(`replayed ${lines} records from ${file} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { lines, events: count };
}

/** Invent the Session the replayed transcript belongs to, from its first usable record. */
function seed(line, state, ctx, file, log) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  const id = ctx.sessionId || rec.sessionId;
  if (typeof id !== 'string' || !id) return null;
  ctx.sessionId = id;
  if (typeof rec.agentId === 'string') ctx.agentId = rec.agentId;
  const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';
  state.upsertSession({
    id, pid: null, name: `replay · ${cwd.split(/[\\/]/).pop() || id.slice(0, 8)}`, cwd, branch: null,
    startedAt: Date.now(), updatedAt: Date.now(), status: 'busy', version: rec.version || null,
    model: null, effort: null, ctxUsed: 0, ctxLimit: 0,
    tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 },
    turns: 0, lastPrompt: null, transcriptPath: file, liveness: true,
  });
  log.info(`replaying session ${id.slice(0, 8)}${ctx.agentId ? ` (subagent ${ctx.agentId})` : ''}`);
  return id;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
