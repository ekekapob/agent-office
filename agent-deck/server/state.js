// server/state.js — the containers: Sessions, Agents, the event bus and the snapshot. It is the single
// source of truth the page reads (ADR-0005). The rules that turn transcript events and hook payloads into
// changes live in server/transcript.js; huddles, alerts and the feed live in server/derive.js.
import { ctxLimitFor } from './config.js';
import { createDerived } from './derive.js';
import { createRules } from './transcript.js';
import { zeroTokens } from '../shared/adapter.js';

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').Agent} Agent */
/** @typedef {import('../shared/types.js').Snapshot} Snapshot */
/** @typedef {import('../shared/types.js').Health} Health */
/** @typedef {import('../shared/types.js').AdapterEvent} AdapterEvent */

const DONE_LINGER_MS = 9000;   // a finished subagent stays visible this long, then is removed
const ERR_CAP = 20;

/**
 * Create the state container.
 * @param {{config:Object, log:Object, version?:string, dataRoot?:string, now?:()=>number}} opts
 * @returns {Object}
 */
export function createState(opts) {
  const { config, log } = opts;
  const now = opts.now || (() => Date.now());
  /** @type {Map<string,Session>} */ const sessions = new Map();
  /** @type {Map<string,Agent>} */ const agents = new Map();
  /** @type {Map<string,{pending:Set<string>, msgs:Set<string>, doneAt:number, approval:string|null, seenAt:number}>} */
  const priv = new Map();
  /** @type {Map<string,string>} */ const nameSource = new Map();  // session id → 'registry' | 'title' | 'cwd'
  const listeners = new Set();
  /** @type {Health} */
  const health = {
    version: opts.version || '0.1.0', dataRoot: opts.dataRoot || '', mode: config.mode || 'native',
    sessions: 0, agents: 0, hooksSeen: false, lastErrors: [], drift: [],
  };
  let silent = false;

  const d = createDerived({ config, emit, agents, sessions });
  const rules = createRules({ config, sessions, agents, derived: d, health, now, nameSource,
    ensureAgent, newAgent, privOf, setState, pushAgent, pushSession, touchSession, bumpTurn, addTokens, agentKey,
    seeAgent: (id, t) => { if (t) { const p = privOf(id); p.seenAt = Math.max(p.seenAt || 0, t); } } });

  // ---------------------------------------------------------------- bus

  /** Subscribe to StreamEvents. @param {(ev:{type:string,data:any})=>void} fn @returns {()=>void} */
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(type, data) {
    if (silent) return;
    for (const fn of listeners) { try { fn({ type, data }); } catch (e) { log.error('stream listener failed', e); } }
  }
  function pushAgent(a, t) { const p = priv.get(a.id); if (p && t) p.seenAt = Math.max(p.seenAt || 0, t); emit('agent', a); }
  function pushSession(s) { emit('session', s); }

  // ---------------------------------------------------------------- sessions

  /**
   * Upsert a Session from the registry, creating its lead agent the first time.
   * @param {Session} s
   */
  function upsertSession(s) {
    if (!s || typeof s.id !== 'string') return;
    const prev = sessions.get(s.id);
    const merged = prev ? { ...prev, ...s } : { ...s, ctxLimit: s.ctxLimit || ctxLimitFor(null, config.context_limits) };
    if (!prev) nameSource.set(s.id, s.name && s.name !== baseName(s.cwd) ? 'registry' : 'cwd');
    else merged.name = nameSource.get(s.id) === 'registry' ? s.name : prev.name;
    merged.status = d.status(merged);
    sessions.set(s.id, merged);
    if (!agents.has(s.id)) {
      const lead = newAgent(s.id, null, { type: 'lead', name: 'Lead', isLead: true, state: 'idle', t: merged.startedAt || now() });
      lead.transcriptPath = merged.transcriptPath;
      agents.set(s.id, lead);
      pushAgent(lead);
    }
    pushSession(merged);
  }

  /** Remove a session and everything hanging off it. @param {string} id */
  function removeSession(id) {
    if (!sessions.delete(id)) return;
    nameSource.delete(id);
    for (const [aid, a] of [...agents]) if (a.sessionId === id) dropAgent(aid, false);
    d.dropSession(id);
    emit('session_removed', { id });
  }

  // ---------------------------------------------------------------- events in

  /**
   * Apply adapter events. `o.silent` suppresses stream traffic, used while a big file is read at startup.
   * @param {AdapterEvent[]} events @param {{silent?:boolean}} [o]
   */
  function apply(events, o = {}) {
    if (!Array.isArray(events) || !events.length) return;
    const wasSilent = silent;
    if (o.silent) silent = true;
    try {
      for (const ev of events) {
        try { rules.apply(ev); } catch (e) { log.error(`applying ${ev && ev.kind}`, e); }
      }
    } finally { silent = wasSilent; }
  }

  /** Apply one normalised hook payload. @param {Object} h */
  function applyHook(h) {
    try { rules.hook(h); } catch (e) { log.error('applying a hook payload', e); }
  }

  // ---------------------------------------------------------------- housekeeping

  /**
   * Periodic pass: drop finished subagents and closed huddles, refresh staleness and session status.
   * @param {number} [t]
   */
  function tick(t = now()) {
    const quietMs = Math.max(60, Number(config.agent_quiet_s) || 600) * 1000;
    for (const [id, a] of [...agents]) {
      if (a.isLead) continue;
      const p = privOf(id);
      if (a.state === 'done') {
        if (p.doneAt && t - p.doneAt > DONE_LINGER_MS) dropAgent(id, true);
        continue;
      }
      // A subagent that was killed writes no end-of-turn record, so it would sit here thinking forever.
      // Long silence while its session is still alive means it is gone, not busy.
      const sess = sessions.get(a.sessionId);
      if (!sess || sess.unreadable) continue;
      if (t - (p.seenAt || 0) <= quietMs) continue;
      a.tool = null; a.args = null;
      setState(a, 'done', t);
      p.doneAt = t;
      d.addFeed(a.sessionId, a, 'end', null, 'stopped without reporting', t);
      if (a.huddleId) d.countReport(a.huddleId, t);
      pushAgent(a);
      log.info(`agent ${a.name} went quiet for ${Math.round((t - (p.seenAt || 0)) / 1000)}s; treating it as ended`);
    }
    d.sweepHuddles(t);
    d.checkStale(t);
    for (const [id, s] of sessions) {
      const status = d.status(s);
      if (status === s.status) continue;
      const n = { ...s, status };
      sessions.set(id, n);
      pushSession(n);
    }
  }

  function dropAgent(id, notify) {
    const a = agents.get(id);
    if (!a) return;
    agents.delete(id);
    priv.delete(id);
    d.dropAgent(a);
    if (a.huddleId) d.countReport(a.huddleId, now());
    if (notify) emit('agent_removed', { id });
  }

  /** Record an error for /api/health and the page (ADR-0008). @param {string} msg @param {string} [detail] */
  function noteError(msg, detail) {
    const e = { when: now(), msg: String(msg).slice(0, 300), detail: detail ? String(detail).slice(0, 300) : undefined };
    health.lastErrors.unshift(e);
    if (health.lastErrors.length > ERR_CAP) health.lastErrors.pop();
    emit('error', e);
  }

  // ---------------------------------------------------------------- agent primitives (used by the rules)

  function ensureAgent(sid, agentId, t) {
    const id = agentKey(sid, agentId);
    const found = agents.get(id);
    if (found) return found;
    const a = newAgent(sid, agentId, { type: agentId ? 'agent' : 'lead', name: agentId ? agentId.slice(0, 8) : 'Lead',
      isLead: !agentId, state: agentId ? 'joining' : 'idle', t });
    agents.set(id, a);
    privOf(id).seenAt = t;
    pushAgent(a, t);
    return a;
  }

  /** @returns {Agent} */
  function newAgent(sid, agentId, o) {
    return {
      id: agentKey(sid, agentId), sessionId: sid, parentId: agentId ? sid : null, isLead: !!o.isLead || !agentId,
      type: o.type, name: o.name, model: null, effort: null, state: o.state, tool: null, args: null, paths: [],
      brief: null, tokens: zeroTokens(), ctxUsed: 0, ctxLimit: ctxLimitFor(null, config.context_limits),
      toolCounts: {}, since: o.t, spawnedAt: o.t, huddleId: null, transcriptPath: '', touched: {},
    };
  }

  /** Bookkeeping we keep about an agent but do not publish: pending tools, seen messages, its approval. */
  function privOf(id) {
    let p = priv.get(id);
    if (!p) { p = { pending: new Set(), msgs: new Set(), doneAt: 0, approval: null, seenAt: 0 }; priv.set(id, p); }
    return p;
  }

  function setState(a, st, t) { if (a.state !== st) { a.state = st; a.since = t; } }

  function touchSession(sid, t) {
    const s = sessions.get(sid);
    if (s && t > (s.updatedAt || 0)) sessions.set(sid, { ...s, updatedAt: t });
  }

  function bumpTurn(sid, usage, lead) {
    const s = sessions.get(sid);
    if (!s) return;
    const n = { ...s, turns: (s.turns || 0) + 1, tokens: { ...s.tokens }, model: lead.model, effort: lead.effort,
      ctxUsed: lead.ctxUsed, ctxLimit: lead.ctxLimit };
    addTokens(n.tokens, usage);
    sessions.set(sid, n);
    pushSession(n);
  }

  /**
   * Fill in what the subagent `.meta.json` or the registry knows. `null` and `undefined` are skipped so a
   * better answer already found in the transcript is never overwritten.
   * @param {string} id @param {Object} patch
   */
  function setAgentMeta(id, patch) {
    const a = agents.get(id);
    if (!a || !patch) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && k !== 'id') a[k] = v;
    if (patch.model) a.ctxLimit = ctxLimitFor(a.model, config.context_limits);
    pushAgent(a);
  }

  /** Mark a session whose transcript cannot be parsed; the others carry on (ADR-0008). */
  function markUnreadable(sid, why) {
    const s = sessions.get(sid);
    if (!s || s.unreadable) return;
    const n = { ...s, unreadable: true, status: 'unreadable' };
    sessions.set(sid, n);
    pushSession(n);
    noteError(`session ${sid.slice(0, 8)} is unreadable`, why);
  }

  // ---------------------------------------------------------------- readers

  /** @returns {Health} */
  function healthNow() { return { ...health, sessions: sessions.size, agents: agents.size }; }

  /** @returns {Snapshot} */
  function snapshot() {
    return {
      now: now(),
      sessions: Object.fromEntries(sessions),
      agents: Object.fromEntries(agents),
      huddles: Object.fromEntries(d.huddles),
      alerts: Object.fromEntries(d.alerts),
      feed: d.feedItems(),
      health: healthNow(),
    };
  }

  return {
    on, apply, applyHook, upsertSession, removeSession, tick, snapshot, noteError,
    setAgentMeta, markUnreadable,
    health: healthNow,
    getAgent: (id) => agents.get(id),
    knowsToolUse: (sid, toolUseId) => rules.knowsToolUse(sid, toolUseId),
    getSession: (id) => sessions.get(id),
    sessionIds: () => [...sessions.keys()],
  };
}

/** @param {string} sid @param {string|null} agentId @returns {string} */
export function agentKey(sid, agentId) { return agentId ? `${sid}/${agentId}` : sid; }

function addTokens(dst, u) {
  if (!u) return;
  dst.input += u.input || 0; dst.output += u.output || 0; dst.thinking += u.thinking || 0;
  dst.cacheRead += u.cacheRead || 0; dst.cacheWrite += u.cacheWrite || 0;
}

function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || ''; }
