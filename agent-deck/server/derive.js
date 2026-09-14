// server/derive.js — everything the deck shows that is not a straight copy of a record: huddles, alerts,
// the feed and a session's overall status. state.js owns the Sessions and Agents; this module owns what
// falls out of them once you look across several at once.
/** @typedef {import('../shared/types.js').Agent} Agent */
/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').Huddle} Huddle */
/** @typedef {import('../shared/types.js').Alert} Alert */
/** @typedef {import('../shared/types.js').FeedItem} FeedItem */

const FEED_CAP = 500;            // per session (CONTRACTS §2)
const HUDDLE_LINGER_MS = 15000;  // a closed huddle stays on screen this long

/**
 * @param {{config:Object, emit:(type:string, data:any)=>void,
 *          agents:Map<string,Agent>, sessions:Map<string,Session>}} world
 * @returns {Object}
 */
export function createDerived(world) {
  const { config, emit, agents, sessions } = world;
  /** @type {Map<string,Huddle>} */ const huddles = new Map();
  /** @type {Map<string,Alert>} */ const alerts = new Map();
  /** @type {Map<string,FeedItem[]>} */ const feeds = new Map();
  /** @type {Map<string,{ids:string[]}>} */ const groups = new Map();  // assistant message id → the agents it spawned
  let feedSeq = 0;

  // ---------------------------------------------------------------- huddles

  /**
   * Two or more Agent spawns whose tool_use blocks sit in one assistant message are one huddle (CONTRACTS §3).
   * @param {string} sessionId @param {string} messageId @param {string} agentId  full Agent.id
   * @param {string} description  fallback goal when the session has no prompt yet
   * @param {number} t
   */
  function joinGroup(sessionId, messageId, agentId, description, t) {
    if (!messageId) return;
    const key = `${sessionId}/${messageId}`;
    const g = groups.get(key) || { ids: [] };
    if (!g.ids.includes(agentId)) g.ids.push(agentId);
    groups.set(key, g);
    if (g.ids.length < 2) return;
    const s = sessions.get(sessionId);
    const h = huddles.get(key) || {
      id: key, sessionId, goal: (s && s.lastPrompt) || description || 'huddle',
      memberIds: [], startedAt: t, reports: 0, status: 'open',
    };
    h.memberIds = [...g.ids];
    huddles.set(key, h);
    for (const id of g.ids) {
      const a = agents.get(id);
      if (a && a.huddleId !== key) { a.huddleId = key; emit('agent', a); }
    }
    emit('huddle', h);
  }

  /** Recount how many members have reported back. @param {string} huddleId @param {number} t */
  function countReport(huddleId, t) {
    const h = huddles.get(huddleId);
    if (!h) return;
    h.reports = h.memberIds.filter((id) => { const a = agents.get(id); return !a || a.state === 'done'; }).length;
    // `closedAt` is set once: a member cleared away later must not restart the huddle's own clock
    if (h.reports >= h.memberIds.length && !h.closedAt) { h.status = 'closed'; h.closedAt = t; }
    emit('huddle', h);
  }

  /** Drop huddles that closed a while ago. @param {number} t */
  function sweepHuddles(t) {
    for (const [id, h] of [...huddles]) {
      if (h.status !== 'closed' || !h.closedAt || t - h.closedAt <= HUDDLE_LINGER_MS) continue;
      huddles.delete(id);
      emit('huddle_removed', { id });
    }
  }

  // ---------------------------------------------------------------- alerts

  /** Raise or refresh an alert. The `since` of an existing alert is kept. */
  function setAlert(id, kind, sessionId, agentId, text, t, detail) {
    const prev = alerts.get(id);
    if (prev && prev.text === text) return;
    const al = { id, kind, sessionId, agentId, text, since: prev ? prev.since : t, detail };
    alerts.set(id, al);
    emit('alert', al);
  }

  /** @param {string} id */
  function clearAlert(id) {
    if (!alerts.delete(id)) return;
    emit('alert_cleared', { id });
  }

  /** Warn as an agent's context window fills (CONTRACTS §8). @param {Agent} a @param {number} t */
  function checkContext(a, t) {
    const id = `context:${a.id}`;
    const pct = a.ctxLimit ? (a.ctxUsed / a.ctxLimit) * 100 : 0;
    if (pct < config.context_warn_pct) return clearAlert(id);
    const near = pct >= config.context_compact_pct ? ' · compaction imminent' : ' · compaction expected soon';
    setAlert(id, 'context', a.sessionId, a.id, `${a.name} context ${Math.round(pct)}%${near}`, t, { pct });
  }

  /**
   * Two live agents writing the same file — the more so when they are in different huddles.
   * @param {string} sessionId @param {string[]} paths @param {number} t
   */
  function checkConflicts(sessionId, paths, t) {
    for (const p of paths) {
      const who = [];
      for (const a of agents.values()) {
        if (a.sessionId !== sessionId || a.state === 'done') continue;
        if (a.touched[p] && a.touched[p].edit) who.push(a);
      }
      const id = `conflict:${sessionId}:${p}`;
      if (who.length < 2) { clearAlert(id); continue; }
      const pods = new Set(who.map((a) => a.huddleId || '-'));
      setAlert(id, 'conflict', sessionId, who[0].id,
        `${p} edited by ${who.map((a) => a.name).join(' and ')}${pods.size > 1 ? ' across huddles' : ''}`,
        t, { path: p, agentIds: who.map((a) => a.id) });
    }
  }

  /**
   * A session whose files have stopped changing, or whose process has gone. The text carries no live
   * counter: the page renders the age from `since`, and a changing string would re-emit the alert every tick.
   * @param {number} t
   */
  function checkStale(t) {
    for (const [id, s] of sessions) {
      const age = t - (s.updatedAt || 0);
      if (s.regStatus === 'waiting') clearAlert(`stale:${id}`);   // waiting is not quiet, it is blocked on you
      else if (!s.liveness) setAlert(`stale:${id}`, 'stale', id, null, `${s.name} is no longer running`, t, { quietSince: s.updatedAt });
      else if (age > config.stale_after_s * 1000) {
        // In a container there is no process to check, so say what we actually know: it has been quiet.
        const why = config.mode === 'docker' ? `${s.name} has been quiet for ${Math.round(age / 60000)} min (a container cannot check the process)` : `${s.name} has gone quiet`;
        setAlert(`stale:${id}`, 'stale', id, null, why, t, { quietSince: s.updatedAt });
      }
      else clearAlert(`stale:${id}`);
    }
  }

  /** Forget everything that belonged to one agent. @param {Agent} a */
  function dropAgent(a) {
    clearAlert(`context:${a.id}`);
    clearAlert(`approval:${a.id}`);
  }

  /** Forget everything that belonged to one session. @param {string} sessionId */
  function dropSession(sessionId) {
    feeds.delete(sessionId);
    for (const [id, h] of [...huddles]) if (h.sessionId === sessionId) { huddles.delete(id); emit('huddle_removed', { id }); }
    for (const [id, a] of [...alerts]) if (a.sessionId === sessionId) clearAlert(id);
    for (const key of [...groups.keys()]) if (key.startsWith(`${sessionId}/`)) groups.delete(key);
  }

  // ---------------------------------------------------------------- feed and status

  /**
   * Add one line to a session's feed, newest first, capped.
   * @param {string} sessionId @param {Agent|null} who @param {string} kind
   * @param {string|null} tool @param {string} text @param {number} t
   */
  function addFeed(sessionId, who, kind, tool, text, t) {
    if (!sessions.has(sessionId)) return;
    const item = { id: `f${++feedSeq}`, sessionId, agentId: who && !who.isLead ? who.id : null, t, kind,
      who: (who && who.name) || 'Lead', tool: tool || null, text: String(text || '').slice(0, 300) };
    const list = feeds.get(sessionId) || [];
    list.unshift(item);
    if (list.length > FEED_CAP) list.length = FEED_CAP;
    feeds.set(sessionId, list);
    emit('feed', item);
  }

  /** Every session's feed, merged newest first. @returns {FeedItem[]} */
  function feedItems() {
    const all = [];
    for (const list of feeds.values()) all.push(...list);
    all.sort((a, b) => b.t - a.t);
    return all;
  }

  /**
   * A session's status is whatever its agents are doing, unless the session itself is unusable.
   * @param {Session} s @returns {import('../shared/types.js').SessionStatus}
   */
  function status(s) {
    if (s.unreadable) return 'unreadable';
    // Claude Code itself says the session is blocked on a prompt: that outranks everything, including
    // staleness. A session waiting for you writes nothing while it waits, so it always looks quiet.
    if (s.regStatus === 'waiting') return 'waiting';
    if (!s.liveness) return 'stale';
    let busy = false;
    for (const a of agents.values()) {
      if (a.sessionId !== s.id) continue;
      if (a.state === 'waiting') return 'waiting';
      if (a.state === 'working' || a.state === 'thinking' || a.state === 'compacting') busy = true;
    }
    return busy ? 'busy' : 'idle';
  }

  return { huddles, alerts, joinGroup, countReport, sweepHuddles, setAlert, clearAlert, checkContext,
    checkConflicts, checkStale, dropAgent, dropSession, addFeed, feedItems, status };
}
