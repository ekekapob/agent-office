// shared/adapter.js — raw Claude Code records → AdapterEvents. Pure functions, no Node imports.
// The only code that knows Claude Code's file shapes (ADR-0003). Never throws for bad input: bad or
// unknown records become `drift` events. Ground truth for the shapes is fixtures/README.md.
/** @typedef {import('./types.js').AdapterEvent} AdapterEvent */
/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').Agent} Agent */
/** @typedef {import('./types.js').Tokens} Tokens */
import { extractPaths, displayPath, elidePath } from './paths.js';

/**
 * Caller-owned scratch context for one transcript. The adapter reads and updates it so that
 * consecutive lines can be joined (Agent tool_use → its tool_result) without the adapter holding state.
 * @typedef {Object} TranscriptCtx
 * @property {string|null} sessionId       known session id (else read from the record)
 * @property {string|null} [agentId]       set when the file is a subagent transcript
 * @property {string|null} [version]       Claude Code version; updated from records when present
 * @property {string|null} [cwd]           for path shortening; updated from records when present
 * @property {string|null} [home]          user home for `~` shortening
 * @property {Map<string,{tool:string,input:Object,messageId:string}>} [pendingTools]  tool_use awaiting its result
 * @property {Set<string>} [seenDrift]     dedupe key set: one drift per field per version
 * @property {number} [now]                fallback timestamp
 */

/** Record types Claude Code writes that carry nothing we model. Ignored without a drift event. */
const IGNORED_TYPES = new Set([
  'last-prompt', 'mode', 'permission-mode', 'file-history-snapshot', 'file-history-delta', 'atis-latch',
  'queue-operation', 'cost-state', 'summary', 'agent-name', 'progress', 'relocated', 'worktree-state',
  'pr-link', 'continued-in',
]);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ARGS_MAX = 120;

/**
 * Summarise a tool input in ≤120 chars for bubbles and the feed.
 * @param {string} tool
 * @param {Object|null|undefined} input
 * @param {{cwd?:string|null,home?:string|null}} [ctx]
 * @returns {string}
 */
export function summarizeArgs(tool, input, ctx = {}) {
  if (!input || typeof input !== 'object') return '';
  const p = (v) => elidePath(displayPath(v, ctx), 80);
  let s = '';
  switch (tool) {
    case 'Read': case 'Write': case 'MultiEdit': case 'Edit':
      s = p(input.file_path || '');
      if (tool === 'Read' && input.offset) s += ` :${input.offset}`;
      break;
    case 'NotebookEdit': s = p(input.notebook_path || ''); break;
    case 'Bash': s = String(input.command || input.description || '').replace(/\s+/g, ' ').trim(); break;
    case 'Grep': s = `"${input.pattern ?? ''}"` + (input.path ? ` in ${p(input.path)}` : ''); break;
    case 'Glob': s = String(input.pattern || '') + (input.path ? ` in ${p(input.path)}` : ''); break;
    case 'Agent': s = `${input.subagent_type || 'agent'}: ${input.description || ''}`; break;
    case 'WebFetch': s = String(input.url || ''); break;
    case 'WebSearch': s = String(input.query || ''); break;
    case 'Skill': s = String(input.skill || '') + (input.args ? ` ${input.args}` : ''); break;
    case 'ToolSearch': s = String(input.query || ''); break;
    case 'TodoWrite': s = Array.isArray(input.todos) ? `${input.todos.length} todos` : ''; break;
    default: {
      try { s = JSON.stringify(input); } catch { s = ''; }
    }
  }
  s = s.replace(/[\r\n]+/g, ' ');
  return s.length > ARGS_MAX ? s.slice(0, ARGS_MAX - 1) + '…' : s;
}

/**
 * Registry file (`~/.claude/sessions/<pid>.json`) → Session, or null when the essentials are missing.
 * `transcriptPath` is left empty: only the server knows the data root.
 * @param {Object} json
 * @param {{now?:number}} [opts]
 * @returns {Session|null}
 */
export function parseRegistryFile(json, opts = {}) {
  if (!json || typeof json !== 'object') return null;
  const now = opts.now ?? Date.now();
  if (typeof json.sessionId !== 'string' || !json.sessionId) return null;
  const cwd = typeof json.cwd === 'string' ? json.cwd : '';
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd || json.sessionId.slice(0, 8);
  const status = json.status === 'busy' ? 'busy' : json.status === 'waiting' ? 'waiting' : 'idle';
  return {
    id: json.sessionId,
    pid: Number.isFinite(json.pid) ? json.pid : null,
    name: typeof json.name === 'string' && json.name ? json.name : base,
    cwd,
    branch: null,
    startedAt: Number.isFinite(json.startedAt) ? json.startedAt : now,
    updatedAt: Number.isFinite(json.updatedAt) ? json.updatedAt : now,
    status,
    regStatus: status,                                            // what Claude Code itself reports, kept as the truth about waiting
    waitingFor: typeof json.waitingFor === 'string' ? json.waitingFor : null,
    version: typeof json.version === 'string' ? json.version : null,
    model: null,
    effort: null,
    ctxUsed: 0,
    ctxLimit: 0,
    tokens: zeroTokens(),
    turns: 0,
    lastPrompt: null,
    transcriptPath: '',
    liveness: true,
  };
}

/**
 * Subagent `.meta.json` → the Agent fields it carries, plus `toolUseId`: the id of the `Agent` tool_use in
 * the parent transcript. That id is what ties a subagent back to the assistant message that spawned it, and
 * so to its huddle, when the subagent's file is discovered before (or without) the parent's tool_result.
 * `model` is null when the Agent call gave no override — the real model then comes from the subagent's own
 * assistant records (fixtures/README.md).
 * @param {Object} json
 * @param {{sessionId:string, agentId:string}} ids
 * @returns {Partial<Agent> & {toolUseId?:string, depth?:number}}
 */
export function parseSubagentMeta(json, ids) {
  /** @type {Partial<Agent> & {toolUseId?:string, depth?:number}} */
  const out = { id: `${ids.sessionId}/${ids.agentId}`, sessionId: ids.sessionId };
  if (!json || typeof json !== 'object') return out;
  if (typeof json.agentType === 'string' && json.agentType) out.type = json.agentType;
  if (typeof json.description === 'string' && json.description) out.name = json.description;
  if (typeof json.model === 'string' && json.model) out.model = json.model;
  if (typeof json.toolUseId === 'string' && json.toolUseId) out.toolUseId = json.toolUseId;
  if (Number.isFinite(json.spawnDepth)) out.depth = json.spawnDepth;
  return out;
}

/**
 * Hook payload (POST /hook/<event>) → a small normalised object, or null when unusable.
 * Treated as untrusted data: only known string fields are copied, sizes are capped.
 * @param {string} event  from the URL
 * @param {Object} body
 * @param {{now?:number, home?:string|null}} [opts]
 * @returns {{event:string,sessionId:string,agentId:string|null,tool:string|null,input:Object|null,args:string,paths:string[],message:string|null,notificationType:string|null,cwd:string|null,t:number}|null}
 */
export function parseHookPayload(event, body, opts = {}) {
  if (!body || typeof body !== 'object') return null;
  const ev = typeof body.hook_event_name === 'string' && body.hook_event_name ? body.hook_event_name : event;
  const sessionId = typeof body.session_id === 'string' ? body.session_id : null;
  if (!sessionId || !ev) return null;
  const cwd = typeof body.cwd === 'string' ? body.cwd : null;
  const tool = typeof body.tool_name === 'string' ? body.tool_name.slice(0, 64) : null;
  const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : null;
  const ctx = { cwd, home: opts.home ?? null };
  return {
    event: String(ev).slice(0, 40),
    sessionId,
    agentId: typeof body.agent_id === 'string' ? body.agent_id : null,
    tool,
    input,
    args: tool ? summarizeArgs(tool, input, ctx) : '',
    paths: tool ? extractPaths(tool, input, ctx) : [],
    message: typeof body.message === 'string' ? body.message.slice(0, 300) : null,
    notificationType: typeof body.notification_type === 'string' ? body.notification_type : null,
    cwd,
    t: opts.now ?? Date.now(),
  };
}

/**
 * One transcript line → zero or more AdapterEvents. Never throws.
 * @param {string} line
 * @param {TranscriptCtx} ctx
 * @returns {AdapterEvent[]}
 */
export function parseTranscriptLine(line, ctx) {
  if (typeof line !== 'string') return [];
  const s = line.trim();
  if (!s) return [];
  let rec;
  try { rec = JSON.parse(s); } catch {
    return [drift(ctx, null, 'line.json', s.slice(0, 80))];
  }
  if (!rec || typeof rec !== 'object' || typeof rec.type !== 'string') {
    return [drift(ctx, null, 'record.type', s.slice(0, 80))];
  }
  const sessionId = ctx.sessionId || (typeof rec.sessionId === 'string' ? rec.sessionId : null);
  if (typeof rec.version === 'string') ctx.version = rec.version;
  if (typeof rec.cwd === 'string') ctx.cwd = rec.cwd;
  if (!sessionId) return [drift(ctx, null, 'record.sessionId', rec.uuid || s.slice(0, 80))];
  const agentId = ctx.agentId ?? (typeof rec.agentId === 'string' ? rec.agentId : null);
  const t = parseTime(rec.timestamp) ?? ctx.now ?? Date.now();
  const pctx = { cwd: ctx.cwd ?? null, home: ctx.home ?? null };

  switch (rec.type) {
    case 'user': return parseUser(rec, { ctx, sessionId, agentId, t, pctx });
    case 'assistant': return parseAssistant(rec, { ctx, sessionId, agentId, t, pctx });
    case 'attachment': return parseAttachment(rec, { ctx, sessionId, agentId, t });
    case 'system':
      if (rec.subtype === 'compact_boundary') return [{ kind: 'compaction', sessionId, t }];
      return [];
    case 'ai-title':
      return typeof rec.aiTitle === 'string' ? [{ kind: 'title', sessionId, title: rec.aiTitle, t }] : [];
    case 'custom-title':
      return typeof rec.customTitle === 'string' ? [{ kind: 'title', sessionId, title: rec.customTitle, t }] : [];
    default:
      if (IGNORED_TYPES.has(rec.type)) return [];
      return [drift(ctx, sessionId, `type.${rec.type}`, rec.uuid || s.slice(0, 80))];
  }
}

/** @param {Object} rec */
function parseUser(rec, { ctx, sessionId, agentId, t, pctx }) {
  /** @type {AdapterEvent[]} */
  const out = [];
  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return [drift(ctx, sessionId, 'user.message', rec.uuid)];
  if (rec.isCompactSummary === true) out.push({ kind: 'compaction', sessionId, t });
  if (typeof msg.content === 'string') {
    if (!rec.isMeta && isHumanText(msg.content)) out.push({ kind: 'prompt', sessionId, agentId, text: trimText(msg.content), t });
    pushMeta(out, rec, sessionId, t);
    return out;
  }
  if (!Array.isArray(msg.content)) return [drift(ctx, sessionId, 'user.message.content', rec.uuid)];
  const texts = [];
  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (isHumanText(block.text)) texts.push(block.text);
    } else if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string') { out.push(drift(ctx, sessionId, 'tool_result.tool_use_id', rec.uuid)); continue; }
      out.push({ kind: 'tool_result', sessionId, agentId, toolUseId: block.tool_use_id, ok: block.is_error !== true, t });
      const r = rec.toolUseResult;
      if (r && typeof r === 'object' && typeof r.agentId === 'string') {
        const pend = ctx.pendingTools?.get(block.tool_use_id);
        const input = pend?.input || {};
        out.push({
          kind: 'agent_spawn', sessionId, toolUseId: block.tool_use_id, agentId: r.agentId,
          type: str(input.subagent_type) || str(r.agentType) || str(r.subagent_type) || 'agent',
          description: str(r.description) || str(input.description) || '',
          brief: str(r.prompt) || str(input.prompt) || '',
          model: str(r.resolvedModel) || str(input.model) || null,
          parentAgentId: agentId, t,
        });
        if (r.isAsync !== true && r.status !== 'async_launched') out.push({ kind: 'agent_end', sessionId, agentId: r.agentId, t });
      }
      ctx.pendingTools?.delete(block.tool_use_id);
    }
  }
  if (texts.length && !rec.isMeta) out.push({ kind: 'prompt', sessionId, agentId, text: trimText(texts.join('\n')), t });
  pushMeta(out, rec, sessionId, t);
  return out;
}

/** @param {Object} rec */
function parseAssistant(rec, { ctx, sessionId, agentId, t, pctx }) {
  /** @type {AdapterEvent[]} */
  const out = [];
  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return [drift(ctx, sessionId, 'assistant.message', rec.uuid)];
  const messageId = typeof msg.id === 'string' ? msg.id : rec.uuid || `m-${t}`;
  if (typeof msg.id !== 'string') out.push(drift(ctx, sessionId, 'assistant.message.id', rec.uuid));
  const u = msg.usage;
  if (!u || typeof u !== 'object') out.push(drift(ctx, sessionId, 'assistant.message.usage', rec.uuid));
  const usage = toTokens(u);
  const ctxUsed = usage.input + usage.cacheRead + usage.cacheWrite;
  const model = typeof msg.model === 'string' ? msg.model : null;
  const effort = str(rec.effort) || str(rec.perTurnEffort) || null;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  let text = null;
  const tools = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') text = (text ? text + '\n' : '') + b.text;
    else if (b.type === 'tool_use') {
      if (typeof b.name !== 'string' || typeof b.id !== 'string') { out.push(drift(ctx, sessionId, 'tool_use.name/id', rec.uuid)); continue; }
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      tools.push({ kind: 'tool_call', sessionId, agentId, messageId, toolUseId: b.id, tool: b.name, input,
        args: summarizeArgs(b.name, input, pctx), paths: extractPaths(b.name, input, pctx), isEdit: EDIT_TOOLS.has(b.name), t });
      ctx.pendingTools?.set(b.id, { tool: b.name, input, messageId });
    }
  }
  out.push({ kind: 'assistant_turn', sessionId, agentId, messageId, model, effort, usage, ctxUsed,
    text: text ? trimText(text) : null, stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null, t });
  out.push(...tools);
  return out;
}

/** @param {Object} rec */
function parseAttachment(rec, { sessionId, agentId, t }) {
  const a = rec.attachment;
  if (!a || typeof a !== 'object') return [];
  if ((a.type === 'hook_success' || a.type === 'hook_error') && typeof a.hookName === 'string') {
    if (a.hookName === 'SubagentStop' && agentId) return [{ kind: 'agent_end', sessionId, agentId, t }];
    if (a.hookName === 'PreCompact') return [{ kind: 'compaction', sessionId, t }];
  }
  return [];
}

function pushMeta(out, rec, sessionId, t) {
  if (typeof rec.cwd === 'string' || typeof rec.gitBranch === 'string' || typeof rec.version === 'string') {
    out.push({ kind: 'session_meta', sessionId, cwd: str(rec.cwd) || undefined, branch: str(rec.gitBranch) || undefined,
      version: str(rec.version) || undefined, t });
  }
}

/**
 * Build a drift event; when ctx.seenDrift is present, repeat keys return a no-op marker that callers may drop.
 * @returns {AdapterEvent}
 */
function drift(ctx, sessionId, field, sample) {
  const version = ctx?.version ?? null;
  const ev = { kind: 'drift', sessionId, field, version, sample: String(sample ?? '').slice(0, 120) };
  if (ctx?.seenDrift) {
    const key = `${field}@${version}`;
    if (ctx.seenDrift.has(key)) ev.repeat = true; else ctx.seenDrift.add(key);
  }
  return ev;
}

/** @param {Object|undefined} u @returns {Tokens} */
function toTokens(u) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  if (!u || typeof u !== 'object') return zeroTokens();
  return {
    input: n(u.input_tokens), output: n(u.output_tokens),
    thinking: n(u.output_tokens_details?.thinking_tokens),
    cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens),
  };
}

/** @returns {Tokens} */
export function zeroTokens() { return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 }; }

function str(v) { return typeof v === 'string' && v ? v : ''; }
function trimText(s) { return s.replace(/\s+/g, ' ').trim().slice(0, 500); }
function isHumanText(s) {
  const x = s.trimStart();
  return x.length > 0 && !x.startsWith('<system-reminder>') && !x.startsWith('<local-command') && !x.startsWith('<command-') && !x.startsWith('<task-notification>');
}
function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}
