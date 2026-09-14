// server/transcript.js — what each AdapterEvent means for the model, and the same for a hook payload.
// The mirror of shared/adapter.js: that module turns raw records into events, this one turns events into
// changes to Sessions and Agents. state.js owns the containers and hands this module the few primitives
// it needs; server/derive.js owns huddles, alerts and the feed.
import { ctxLimitFor } from './config.js';

/** @typedef {import('../shared/types.js').Agent} Agent */
/** @typedef {import('../shared/types.js').AdapterEvent} AdapterEvent */

const TOOL_MEMORY = 4000;   // tool_use → assistant message id pairs kept, for huddle detection
const MSG_MEMORY = 400;     // assistant message ids remembered per agent, for token de-duplication

/**
 * @param {{config:Object, sessions:Map, agents:Map, derived:Object, health:Object, now:()=>number,
 *          ensureAgent:(sid:string, agentId:string|null, t:number)=>Agent,
 *          privOf:(id:string)=>Object, setState:(a:Agent, st:string, t:number)=>void,
 *          pushAgent:(a:Agent)=>void, pushSession:(s:Object)=>void,
 *          touchSession:(sid:string, t:number)=>void, bumpTurn:(sid:string, usage:Object, lead:Agent)=>void,
 *          addTokens:(dst:Object, u:Object)=>void, agentKey:(sid:string, agentId:string|null)=>string,
 *          nameSource:Map}} w
 * @returns {{apply:(ev:AdapterEvent)=>void, hook:(h:Object)=>void, endAgent:(sid:string, agentId:string, t:number)=>void}}
 */
/** Clock skew allowed when deciding a record predates its session (ms). */
const REPLAY_SKEW_MS = 2000;

export function createRules(w) {
  const { config, sessions, agents, derived: d, health } = w;
  /** @type {Map<string,string>} */
  const toolMsg = new Map();

  /** One adapter event. @param {AdapterEvent} ev */
  function apply(ev) {
    if (!ev || typeof ev.kind !== 'string') return;
    if (ev.kind === 'drift') return onDrift(ev);
    const sid = ev.sessionId;
    if (!sid || !sessions.has(sid)) return;              // events for sessions we do not track
    const t = ev.t || w.now();
    // Resuming a session copies the earlier conversation into the new transcript, keeping the original
    // timestamps. Replaying those spawns would raise phantom agents that never seat and a huddle that can
    // never finish, so agent lifecycle from before this session began is history, not activity.
    if (isReplay(sid, ev, t)) return;
    w.touchSession(sid, t);
    if (ev.agentId) w.seeAgent(w.agentKey(sid, ev.agentId), t);   // last sighting, by the record's clock
    switch (ev.kind) {
      case 'session_meta': return onMeta(ev, sid);
      case 'prompt': return onPrompt(ev, t);
      case 'assistant_turn': return onTurn(ev, t);
      case 'tool_call': return onToolCall(ev, t);
      case 'tool_result': return onToolResult(ev, t);
      case 'agent_spawn': return onSpawn(ev, t);
      case 'agent_end': return endAgent(sid, ev.agentId, t);
      case 'compaction': return onCompaction(sid, t);
      case 'title': return onTitle(sid, ev.title);
      default: return;
    }
  }

  /**
   * Is this record older than the session that contains it? True only for events that would otherwise
   * create or move an agent; the lead's own prompts and turns still land so a resumed session shows its
   * assignment and context straight away.
   * @param {string} sid @param {AdapterEvent} ev @param {number} t
   */
  function isReplay(sid, ev, t) {
    const s = sessions.get(sid);
    if (!s || !s.startedAt || t >= s.startedAt - REPLAY_SKEW_MS) return false;
    return ev.kind === 'agent_spawn' || ev.kind === 'agent_end' || !!ev.agentId;
  }

  function onMeta(ev, sid) {
    const next = { ...sessions.get(sid) };
    if (ev.cwd) next.cwd = ev.cwd;
    if (ev.branch) next.branch = ev.branch;
    if (ev.version) next.version = ev.version;
    sessions.set(sid, next);
    w.pushSession(next);
  }

  function onPrompt(ev, t) {
    const a = w.ensureAgent(ev.sessionId, ev.agentId, t);
    if (a.isLead) {
      const s = { ...sessions.get(ev.sessionId), lastPrompt: ev.text };
      sessions.set(ev.sessionId, s);
      w.pushSession(s);
    }
    w.setState(a, 'thinking', t);
    d.addFeed(ev.sessionId, a, 'prompt', null, ev.text, t);
    w.pushAgent(a);
  }

  /**
   * An assistant record. One assistant message is written as several records — one per content block — so
   * tokens are added once per message id, while ctxUsed always takes the latest value (CONTRACTS §3).
   */
  function onTurn(ev, t) {
    const a = w.ensureAgent(ev.sessionId, ev.agentId, t);
    const p = w.privOf(a.id);
    if (ev.model) a.model = ev.model;
    if (ev.effort) a.effort = ev.effort;
    a.ctxLimit = ctxLimitFor(a.model, config.context_limits);
    a.ctxUsed = ev.ctxUsed || 0;
    if (ev.messageId && !p.msgs.has(ev.messageId)) {
      p.msgs.add(ev.messageId);
      if (p.msgs.size > MSG_MEMORY) p.msgs.delete(p.msgs.values().next().value);
      w.addTokens(a.tokens, ev.usage);
      if (a.isLead) w.bumpTurn(ev.sessionId, ev.usage, a);
    }
    if (a.state === 'compacting') a.state = 'thinking';
    if (p.pending.size) w.setState(a, 'working', t);
    else if (ev.stopReason === 'end_turn') w.setState(a, a.isLead ? 'idle' : 'done', t);
    else if (ev.text) w.setState(a, 'thinking', t);
    if (!a.isLead && a.state === 'done') finish(a, t);
    d.checkContext(a, t);
    w.pushAgent(a);
  }

  function onToolCall(ev, t) {
    const a = w.ensureAgent(ev.sessionId, ev.agentId, t);
    w.privOf(a.id).pending.add(ev.toolUseId);
    if (ev.messageId) {
      toolMsg.set(ev.toolUseId, ev.messageId);
      if (toolMsg.size > TOOL_MEMORY) toolMsg.delete(toolMsg.keys().next().value);
    }
    a.tool = ev.tool; a.args = ev.args || ''; a.paths = Array.isArray(ev.paths) ? ev.paths : [];
    a.toolCounts[ev.tool] = (a.toolCounts[ev.tool] || 0) + 1;
    for (const p of a.paths) {
      const cur = a.touched[p] || { edit: false, n: 0 };
      a.touched[p] = { edit: cur.edit || !!ev.isEdit, n: cur.n + 1 };
    }
    w.setState(a, 'working', t);
    d.addFeed(ev.sessionId, a, ev.tool === 'Agent' ? 'spawn' : 'tool', ev.tool, ev.args || '', t);
    if (ev.isEdit) d.checkConflicts(ev.sessionId, a.paths, t);
    w.pushAgent(a);
  }

  function onToolResult(ev, t) {
    const a = agents.get(w.agentKey(ev.sessionId, ev.agentId));
    if (!a) return;
    const p = w.privOf(a.id);
    p.pending.delete(ev.toolUseId);
    if (p.approval) { d.clearAlert(p.approval); p.approval = null; }
    if (!p.pending.size && (a.state === 'working' || a.state === 'waiting')) w.setState(a, 'thinking', t);
    w.pushAgent(a);
  }

  function onSpawn(ev, t) {
    const id = `${ev.sessionId}/${ev.agentId}`;
    const a = agents.get(id) || w.newAgent(ev.sessionId, ev.agentId,
      { type: ev.type || 'agent', name: ev.description || ev.type || 'agent', state: 'joining', t });
    if (ev.type) a.type = ev.type;
    if (ev.description) a.name = ev.description;
    if (ev.brief) a.brief = ev.brief;
    if (ev.model) { a.model = ev.model; a.ctxLimit = ctxLimitFor(a.model, config.context_limits); }
    a.parentId = ev.parentAgentId ? `${ev.sessionId}/${ev.parentAgentId}` : ev.sessionId;
    agents.set(id, a);
    w.seeAgent(id, t);
    d.joinGroup(ev.sessionId, toolMsg.get(ev.toolUseId), id, ev.description, t);
    d.addFeed(ev.sessionId, agents.get(ev.sessionId) || a, 'spawn', 'Agent', `spawned ${a.type} · ${a.name}`, t);
    w.pushAgent(a);
  }

  /** @param {string} sid @param {string} agentId @param {number} t */
  function endAgent(sid, agentId, t) {
    const a = agents.get(`${sid}/${agentId}`);
    if (!a || a.state === 'done') return;
    w.setState(a, 'done', t);
    finish(a, t);
    w.pushAgent(a);
  }

  /** A subagent has delivered: drop the tool, count the report, start the removal clock. */
  function finish(a, t) {
    const p = w.privOf(a.id);
    if (p.doneAt) return;
    p.doneAt = t;
    a.tool = null; a.args = null;
    if (p.approval) { d.clearAlert(p.approval); p.approval = null; }
    d.addFeed(a.sessionId, a, 'end', null, 'report delivered', t);
    if (a.huddleId) d.countReport(a.huddleId, t);
  }

  function onCompaction(sid, t) {
    const lead = agents.get(sid);
    if (lead) { w.setState(lead, 'compacting', t); w.pushAgent(lead); }
    d.addFeed(sid, lead, 'compact', null, 'context compacting', t);
  }

  /** The registry's own name wins; an ai-title only replaces a name derived from the cwd. */
  function onTitle(sid, title) {
    if (!title || w.nameSource.get(sid) === 'registry') return;
    w.nameSource.set(sid, 'title');
    const s = { ...sessions.get(sid), name: title };
    sessions.set(sid, s);
    w.pushSession(s);
  }

  function onDrift(ev) {
    if (ev.repeat) return;
    const key = `${ev.field}@${ev.version || '?'}`;
    if (!health.drift.some((x) => `${x.field}@${x.version}` === key)) {
      health.drift.push({ field: ev.field, version: ev.version || '?', sample: ev.sample || '' });
      if (health.drift.length > 50) health.drift.shift();
    }
    if (!ev.sessionId || !sessions.has(ev.sessionId)) return;
    d.setAlert(`drift:${key}`, 'drift', ev.sessionId, null, `unexpected record shape: ${ev.field}`, w.now(), { sample: ev.sample });
  }

  /**
   * One normalised hook payload. Hooks say sooner what the transcript says later, so they map onto the
   * same changes (ADR-0006). The payload is untrusted: http.js has already shape-checked and size-capped it.
   * @param {Object} h
   */
  function hook(h) {
    if (!h || !h.sessionId || !sessions.has(h.sessionId)) return;
    health.hooksSeen = true;
    const sid = h.sessionId;
    const t = h.t || w.now();
    w.touchSession(sid, t);
    if (h.event === 'SubagentStop') return endAgent(sid, h.agentId, t);
    if (h.event === 'PreCompact') return onCompaction(sid, t);
    const a = w.ensureAgent(sid, h.agentId || null, t);
    switch (h.event) {
      case 'PermissionRequest': {
        if (h.tool) a.tool = h.tool;
        if (h.args) a.args = h.args;
        if (h.paths && h.paths.length) a.paths = h.paths;
        w.setState(a, 'waiting', t);
        const id = `approval:${a.id}`;
        w.privOf(a.id).approval = id;
        d.setAlert(id, 'approval', sid, a.id, `${a.name} needs approval for ${h.tool || 'a tool'}${h.args ? ` · ${h.args}` : ''}`, t);
        d.addFeed(sid, a, 'note', h.tool, `waiting for approval · ${h.args || h.tool || ''}`, t);
        break;
      }
      case 'SubagentStart': w.setState(a, 'joining', t); break;
      case 'Notification': d.addFeed(sid, a, 'note', null, h.message || h.notificationType || 'notification', t); break;
      case 'Stop': {
        const p = w.privOf(a.id);
        if (p.approval) { d.clearAlert(p.approval); p.approval = null; }
        if (!p.pending.size) w.setState(a, a.isLead ? 'idle' : 'done', t);
        break;
      }
      default: d.addFeed(sid, a, 'note', null, String(h.event), t);
    }
    w.pushAgent(a);
  }

  /** Did this session's own live records contain that tool call? @param {string} sid @param {string} toolUseId */
  function knowsToolUse(sid, toolUseId) { return !!toolUseId && toolMsg.has(toolUseId); }

  return { apply, hook, knowsToolUse, endAgent };
}
