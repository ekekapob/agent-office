// tests/state.test.js — the domain model: the agent state machine, huddle detection, alerts and the feed.
// Synthetic AdapterEvents and a fake clock, so nothing depends on timing or on a real transcript.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../server/state.js';
import { nullLogger } from '../server/log.js';
import { defaults } from '../server/config.js';

const SID = 'ses-1';
const T0 = 1700000000000;

/** A state container with a clock the test moves by hand. */
function harness(over = {}) {
  const config = { ...defaults(), stale_after_s: 180, ...over };
  let clock = T0;
  const events = [];
  const state = createState({ config, log: nullLogger(), version: 'test', dataRoot: '/tmp/.claude', now: () => clock });
  state.on((ev) => events.push(ev));
  state.upsertSession(session(over.session || {}));
  return {
    state, events, config,
    at: (ms) => { clock = T0 + ms; return clock; },
    now: () => clock,
    of: (type) => events.filter((e) => e.type === type),
    agent: (id) => state.snapshot().agents[id],
    snap: () => state.snapshot(),
  };
}

function session(over = {}) {
  return { id: SID, pid: 100, name: 'workspace', cwd: '/w', branch: 'main', startedAt: T0, updatedAt: T0,
    status: 'idle', version: '2.1.270', model: null, effort: null, ctxUsed: 0, ctxLimit: 1000000,
    tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0, lastPrompt: null,
    transcriptPath: '/w/t.jsonl', liveness: true, ...over };
}

const usage = (i = 10, o = 5) => ({ input: i, output: o, thinking: 0, cacheRead: 0, cacheWrite: 0 });
const turn = (o) => ({ kind: 'assistant_turn', sessionId: SID, agentId: null, messageId: 'm1', model: 'claude-opus-5',
  effort: 'high', usage: usage(), ctxUsed: 100, text: null, stopReason: null, t: T0, ...o });
const call = (o) => ({ kind: 'tool_call', sessionId: SID, agentId: null, messageId: 'm1', toolUseId: 'tu1',
  tool: 'Read', input: {}, args: 'a.js', paths: ['a.js'], t: T0, ...o });
const result = (o) => ({ kind: 'tool_result', sessionId: SID, agentId: null, toolUseId: 'tu1', ok: true, t: T0, ...o });
const spawn = (o) => ({ kind: 'agent_spawn', sessionId: SID, toolUseId: 'tu1', agentId: 'a1', type: 'Explore',
  description: 'look around', brief: 'go and look', model: 'claude-haiku-4-5-20251001', t: T0, ...o });

// ---------------------------------------------------------------- sessions and the lead

test('a session brings its lead agent with it', () => {
  const h = harness();
  const snap = h.snap();
  assert.equal(Object.keys(snap.sessions).length, 1);
  const lead = snap.agents[SID];
  assert.ok(lead, 'the lead is keyed by the session id');
  assert.equal(lead.isLead, true);
  assert.equal(lead.type, 'lead');
  assert.equal(lead.state, 'idle');
  assert.equal(h.of('session').length, 1);
  assert.equal(h.of('agent').length, 1);
});

test('removing a session takes its agents, huddles and alerts with it', () => {
  const h = harness();
  h.state.apply([call(), spawn(), spawn({ toolUseId: 'tu2', agentId: 'a2' })]);
  assert.ok(Object.keys(h.snap().agents).length >= 2);
  h.state.removeSession(SID);
  const snap = h.snap();
  assert.deepEqual(snap.sessions, {});
  assert.deepEqual(snap.agents, {});
  assert.deepEqual(snap.huddles, {});
  assert.equal(h.of('session_removed').length, 1);
});

// ---------------------------------------------------------------- the state machine

test('a tool call without a result is working; the result makes it thinking', () => {
  const h = harness();
  h.state.apply([call({ t: h.at(1000) })]);
  assert.equal(h.agent(SID).state, 'working');
  assert.equal(h.agent(SID).tool, 'Read');
  assert.equal(h.agent(SID).args, 'a.js');
  assert.equal(h.agent(SID).toolCounts.Read, 1);
  h.state.apply([result({ t: h.at(2000) })]);
  assert.equal(h.agent(SID).state, 'thinking');
  assert.equal(h.agent(SID).since, T0 + 2000);
});

test('two calls in flight stay working until both results are in', () => {
  const h = harness();
  h.state.apply([call({ toolUseId: 'x1' }), call({ toolUseId: 'x2', args: 'b.js', paths: ['b.js'] })]);
  h.state.apply([result({ toolUseId: 'x1' })]);
  assert.equal(h.agent(SID).state, 'working');
  h.state.apply([result({ toolUseId: 'x2' })]);
  assert.equal(h.agent(SID).state, 'thinking');
});

test('assistant text with nothing pending is thinking; an ended turn makes the lead idle', () => {
  const h = harness();
  h.state.apply([turn({ text: 'let me look', t: h.at(500) })]);
  assert.equal(h.agent(SID).state, 'thinking');
  h.state.apply([turn({ messageId: 'm2', stopReason: 'end_turn', t: h.at(900) })]);
  assert.equal(h.agent(SID).state, 'idle');
});

test('a turn that opens a tool call stays working, whatever the stop reason', () => {
  const h = harness();
  h.state.apply([call(), turn({ messageId: 'm9', stopReason: 'end_turn', text: 'done' })]);
  assert.equal(h.agent(SID).state, 'working');
});

test('a subagent that ends its turn is done, not idle', () => {
  const h = harness();
  h.state.apply([spawn(), turn({ agentId: 'a1', messageId: 'sm1', stopReason: 'end_turn' })]);
  assert.equal(h.agent(`${SID}/a1`).state, 'done');
});

test('compaction shows on the lead and clears at the next turn', () => {
  const h = harness();
  h.state.apply([{ kind: 'compaction', sessionId: SID, t: h.at(100) }]);
  assert.equal(h.agent(SID).state, 'compacting');
  assert.ok(h.of('feed').some((e) => e.data.kind === 'compact'));
  h.state.apply([turn({ messageId: 'after', text: 'carrying on', t: h.at(200) })]);
  assert.equal(h.agent(SID).state, 'thinking');
});

test('a PermissionRequest hook makes the agent wait, and the tool result releases it', () => {
  const h = harness();
  h.state.apply([spawn(), call({ agentId: 'a1', toolUseId: 'p1', tool: 'Edit', args: 'x.py', paths: ['x.py'] })]);
  h.state.applyHook({ event: 'PermissionRequest', sessionId: SID, agentId: 'a1', tool: 'Edit', args: 'x.py', paths: ['x.py'], t: h.at(3000) });
  const a = h.agent(`${SID}/a1`);
  assert.equal(a.state, 'waiting');
  const alertsWaiting = Object.values(h.snap().alerts).filter((x) => x.kind === 'approval');
  assert.equal(alertsWaiting.length, 1);
  assert.equal(alertsWaiting[0].agentId, `${SID}/a1`);
  h.state.apply([result({ agentId: 'a1', toolUseId: 'p1', t: h.at(4000) })]);
  assert.equal(h.agent(`${SID}/a1`).state, 'thinking');
  assert.equal(Object.values(h.snap().alerts).filter((x) => x.kind === 'approval').length, 0);
  assert.equal(h.of('alert_cleared').length, 1);
  assert.equal(h.state.health().hooksSeen, true);
});

test('SubagentStop and PreCompact hooks map onto the same events as the transcript', () => {
  const h = harness();
  h.state.apply([spawn()]);
  h.state.applyHook({ event: 'SubagentStop', sessionId: SID, agentId: 'a1', t: h.at(10) });
  assert.equal(h.agent(`${SID}/a1`).state, 'done');
  h.state.applyHook({ event: 'PreCompact', sessionId: SID, agentId: null, t: h.at(20) });
  assert.equal(h.agent(SID).state, 'compacting');
});

test('a finished subagent is removed once its moment on screen has passed', () => {
  const h = harness();
  h.state.apply([spawn({ t: h.at(0) })]);
  h.state.apply([{ kind: 'agent_end', sessionId: SID, agentId: 'a1', t: h.at(1000) }]);
  assert.equal(h.agent(`${SID}/a1`).state, 'done');
  h.state.tick(h.at(5000));
  assert.ok(h.agent(`${SID}/a1`), 'still there a moment later');
  h.state.tick(h.at(30000));
  assert.equal(h.agent(`${SID}/a1`), undefined);
  assert.equal(h.of('agent_removed').length, 1);
});

// ---------------------------------------------------------------- huddles

test('two spawns in one assistant message make a huddle; one does not', () => {
  const h = harness();
  h.state.apply([{ kind: 'prompt', sessionId: SID, agentId: null, text: 'Wire the hooks end to end', t: h.at(0) }]);
  h.state.apply([call({ messageId: 'msgA', toolUseId: 'tuA', tool: 'Agent' }), spawn({ toolUseId: 'tuA', agentId: 'a1' })]);
  assert.deepEqual(h.snap().huddles, {}, 'one agent is not a huddle');

  h.state.apply([call({ messageId: 'msgA', toolUseId: 'tuB', tool: 'Agent' }), spawn({ toolUseId: 'tuB', agentId: 'a2' })]);
  const huddles = Object.values(h.snap().huddles);
  assert.equal(huddles.length, 1);
  assert.equal(huddles[0].id, `${SID}/msgA`);
  assert.equal(huddles[0].goal, 'Wire the hooks end to end', 'the goal is the lead\'s last prompt');
  assert.deepEqual(huddles[0].memberIds.sort(), [`${SID}/a1`, `${SID}/a2`]);
  assert.equal(huddles[0].reports, 0);
  assert.equal(huddles[0].status, 'open');
  assert.equal(h.agent(`${SID}/a1`).huddleId, `${SID}/msgA`);
});

test('spawns in different assistant messages are separate work, not a huddle', () => {
  const h = harness();
  h.state.apply([call({ messageId: 'm1', toolUseId: 't1', tool: 'Agent' }), spawn({ toolUseId: 't1', agentId: 'a1' })]);
  h.state.apply([call({ messageId: 'm2', toolUseId: 't2', tool: 'Agent' }), spawn({ toolUseId: 't2', agentId: 'a2' })]);
  assert.deepEqual(h.snap().huddles, {});
});

test('the goal falls back to the first description when there is no prompt yet', () => {
  const h = harness();
  h.state.apply([call({ messageId: 'mX', toolUseId: 't1', tool: 'Agent' }), spawn({ toolUseId: 't1', agentId: 'a1' }),
    call({ messageId: 'mX', toolUseId: 't2', tool: 'Agent' }), spawn({ toolUseId: 't2', agentId: 'a2', description: 'read the registry' })]);
  assert.equal(Object.values(h.snap().huddles)[0].goal, 'read the registry');
});

test('a huddle closes when every member has reported', () => {
  const h = harness();
  const mk = (n) => [call({ messageId: 'mh', toolUseId: `t${n}`, tool: 'Agent' }), spawn({ toolUseId: `t${n}`, agentId: `a${n}` })];
  h.state.apply([...mk(1), ...mk(2), ...mk(3)]);
  const id = `${SID}/mh`;
  assert.equal(h.snap().huddles[id].memberIds.length, 3);
  h.state.apply([{ kind: 'agent_end', sessionId: SID, agentId: 'a1', t: h.at(10) }]);
  assert.equal(h.snap().huddles[id].reports, 1);
  assert.equal(h.snap().huddles[id].status, 'open');
  h.state.apply([{ kind: 'agent_end', sessionId: SID, agentId: 'a2', t: h.at(20) },
    { kind: 'agent_end', sessionId: SID, agentId: 'a3', t: h.at(30) }]);
  assert.equal(h.snap().huddles[id].reports, 3);
  assert.equal(h.snap().huddles[id].status, 'closed');
  h.state.tick(h.at(60000));
  assert.equal(h.snap().huddles[id], undefined, 'a closed huddle is cleared away');
  assert.equal(h.of('huddle_removed').length, 1);
});

// ---------------------------------------------------------------- alerts

test('the context alert appears above the warning threshold and clears below it', () => {
  const h = harness({ context_warn_pct: 85, context_compact_pct: 96, context_limits: { default: 1000 } });
  h.state.apply([turn({ messageId: 'c1', model: 'unknown-model', ctxUsed: 400, t: h.at(10) })]);
  assert.equal(Object.values(h.snap().alerts).filter((a) => a.kind === 'context').length, 0);
  h.state.apply([turn({ messageId: 'c2', model: 'unknown-model', ctxUsed: 900, t: h.at(20) })]);
  const [ctxAlert] = Object.values(h.snap().alerts).filter((a) => a.kind === 'context');
  assert.ok(ctxAlert);
  assert.ok(/90%/.test(ctxAlert.text), ctxAlert.text);
  assert.ok(/expected soon/.test(ctxAlert.text));
  h.state.apply([turn({ messageId: 'c3', model: 'unknown-model', ctxUsed: 980, t: h.at(30) })]);
  assert.ok(/imminent/.test(Object.values(h.snap().alerts).find((a) => a.kind === 'context').text));
  h.state.apply([turn({ messageId: 'c4', model: 'unknown-model', ctxUsed: 300, t: h.at(40) })]);
  assert.equal(Object.values(h.snap().alerts).filter((a) => a.kind === 'context').length, 0);
});

test('two agents editing one file raise a conflict', () => {
  const h = harness();
  const mk = (n) => [call({ messageId: 'mh', toolUseId: `t${n}`, tool: 'Agent' }), spawn({ toolUseId: `t${n}`, agentId: `a${n}`, description: `agent ${n}` })];
  h.state.apply([...mk(1), ...mk(2)]);
  h.state.apply([call({ agentId: 'a1', toolUseId: 'e1', tool: 'Edit', args: 'server.py', paths: ['server.py'], isEdit: true, t: h.at(10) })]);
  assert.equal(Object.values(h.snap().alerts).filter((a) => a.kind === 'conflict').length, 0, 'one editor is not a conflict');
  h.state.apply([call({ agentId: 'a2', toolUseId: 'e2', tool: 'Edit', args: 'server.py', paths: ['server.py'], isEdit: true, t: h.at(20) })]);
  const [conflict] = Object.values(h.snap().alerts).filter((a) => a.kind === 'conflict');
  assert.ok(conflict, 'two editors are');
  assert.equal(conflict.detail.path, 'server.py');
  assert.equal(conflict.detail.agentIds.length, 2);
  // reading the same file is not a conflict
  h.state.apply([call({ agentId: 'a1', toolUseId: 'r1', tool: 'Read', args: 'other.py', paths: ['other.py'], t: h.at(30) }),
    call({ agentId: 'a2', toolUseId: 'r2', tool: 'Read', args: 'other.py', paths: ['other.py'], t: h.at(40) })]);
  assert.equal(Object.values(h.snap().alerts).filter((a) => a.kind === 'conflict').length, 1);
});

test('drift is recorded once in health and raised as an alert', () => {
  const h = harness();
  h.state.apply([{ kind: 'drift', sessionId: SID, field: 'type.wombat', version: '2.1.270', sample: 'u1' }]);
  h.state.apply([{ kind: 'drift', sessionId: SID, field: 'type.wombat', version: '2.1.270', sample: 'u2' }]);
  assert.equal(h.state.health().drift.length, 1);
  assert.equal(Object.values(h.snap().alerts).filter((a) => a.kind === 'drift').length, 1);
  h.state.apply([{ kind: 'drift', sessionId: SID, field: 'x', version: '2', sample: 's', repeat: true }]);
  assert.equal(h.state.health().drift.length, 1, 'a repeat marker is dropped');
});

test('a session that stops changing goes stale', () => {
  const h = harness({ stale_after_s: 10 });
  h.state.tick(h.at(5000));
  assert.equal(Object.values(h.snap().alerts).filter((a) => a.kind === 'stale').length, 0);
  h.state.tick(h.at(60000));
  assert.equal(Object.values(h.snap().alerts).filter((a) => a.kind === 'stale').length, 1);
  assert.equal(h.snap().sessions[SID].status, 'idle');
  h.state.upsertSession(session({ liveness: false }));
  h.state.tick(h.at(61000));
  assert.equal(h.snap().sessions[SID].status, 'stale');
});

// ---------------------------------------------------------------- tokens, feed, status

test('one assistant message spread over several records is counted once', () => {
  const h = harness();
  // this is what the transcript really looks like: one message id, one record per content block
  h.state.apply([turn({ messageId: 'batch', usage: usage(32, 100) }), turn({ messageId: 'batch', usage: usage(32, 100) }),
    turn({ messageId: 'batch', usage: usage(32, 100) })]);
  assert.equal(h.agent(SID).tokens.input, 32, 'not 96');
  assert.equal(h.snap().sessions[SID].turns, 1);
  h.state.apply([turn({ messageId: 'next', usage: usage(8, 4) })]);
  assert.equal(h.agent(SID).tokens.input, 40);
  assert.equal(h.snap().sessions[SID].turns, 2);
});

test('the feed is newest first and capped per session', () => {
  const h = harness();
  for (let i = 0; i < 560; i++) {
    h.state.apply([call({ toolUseId: `t${i}`, args: `file-${i}.js`, paths: [], t: h.at(i) })]);
  }
  const feed = h.snap().feed;
  assert.equal(feed.length, 500);
  assert.equal(feed[0].text, 'file-559.js');
  assert.ok(feed[0].t >= feed[1].t);
  assert.equal(feed[0].kind, 'tool');
  assert.equal(feed[0].who, 'Lead');
  assert.equal(feed[0].agentId, null, 'lead feed items carry no agent id');
});

test('a prompt updates the session and the feed', () => {
  const h = harness();
  h.state.apply([{ kind: 'prompt', sessionId: SID, agentId: null, text: 'do the thing', t: h.at(1) }]);
  assert.equal(h.snap().sessions[SID].lastPrompt, 'do the thing');
  assert.equal(h.agent(SID).state, 'thinking');
  assert.equal(h.snap().feed[0].kind, 'prompt');
});

test('session status follows the agents', () => {
  const h = harness();
  h.state.tick(h.at(10));
  assert.equal(h.snap().sessions[SID].status, 'idle');
  h.state.apply([call({ t: h.at(20) })]);
  h.state.tick(h.at(30));
  assert.equal(h.snap().sessions[SID].status, 'busy');
  h.state.applyHook({ event: 'PermissionRequest', sessionId: SID, agentId: null, tool: 'Edit', args: 'x', paths: [], t: h.at(40) });
  h.state.tick(h.at(50));
  assert.equal(h.snap().sessions[SID].status, 'waiting');
});

test('a title only renames a session that has no name of its own', () => {
  const h = harness();
  h.state.apply([{ kind: 'title', sessionId: SID, title: 'Wiring the hooks', t: h.at(1) }]);
  assert.equal(h.snap().sessions[SID].name, 'workspace', 'the registry name wins');
  // a name equal to the cwd basename is derived, not chosen, so a title may replace it
  const h2 = harness({ session: { name: 'w' } });
  h2.state.apply([{ kind: 'title', sessionId: SID, title: 'Wiring the hooks', t: T0 }]);
  assert.equal(h2.snap().sessions[SID].name, 'Wiring the hooks');
});

test('events for unknown sessions are ignored rather than inventing one', () => {
  const h = harness();
  h.state.apply([call({ sessionId: 'nope' }), turn({ sessionId: 'nope' })]);
  assert.equal(Object.keys(h.snap().sessions).length, 1);
  assert.equal(Object.keys(h.snap().agents).length, 1);
});

test('silent mode applies everything but emits nothing', () => {
  const h = harness();
  const before = h.events.length;
  h.state.apply([call({ toolUseId: 'q1' }), result({ toolUseId: 'q1' })], { silent: true });
  assert.equal(h.events.length, before, 'no stream traffic while a big file is being read');
  assert.equal(h.agent(SID).toolCounts.Read, 1, 'but the state moved');
});

test('errors reach health and the stream', () => {
  const h = harness();
  h.state.noteError('something went wrong', 'detail here');
  assert.equal(h.state.health().lastErrors[0].msg, 'something went wrong');
  assert.equal(h.of('error').length, 1);
});

test('setAgentMeta fills in what the meta file knows without clobbering ids', () => {
  const h = harness();
  h.state.apply([spawn()]);
  h.state.setAgentMeta(`${SID}/a1`, { transcriptPath: '/w/subagents/agent-a1.jsonl', id: 'nope', model: null });
  const a = h.agent(`${SID}/a1`);
  assert.equal(a.id, `${SID}/a1`);
  assert.equal(a.transcriptPath, '/w/subagents/agent-a1.jsonl');
  assert.equal(a.model, 'claude-haiku-4-5-20251001', 'a null in the patch leaves the known model alone');
  h.state.setAgentMeta('does/not/exist', { model: 'x' });   // must not throw
});

// ---------------------------------------------------------------- resumed sessions, quiet agents, waiting

test('spawns replayed from an earlier session do not become live agents', () => {
  const h = harness();
  // Resuming copies the old conversation into the new transcript, keeping its original timestamps.
  h.state.apply([spawn({ t: T0 - 3600_000 })]);
  assert.equal(h.agent(`${SID}/a1`), undefined, 'an agent spawned before the session began is history');
  h.state.apply([spawn({ agentId: 'a2', t: T0 + 1000 })]);
  assert.ok(h.agent(`${SID}/a2`), 'a spawn after the session began is live');
});

test('a replayed batch raises no huddle', () => {
  const h = harness();
  h.state.apply(['x1', 'x2', 'x3'].map((id) => call({ toolUseId: 'tu-' + id, tool: 'Agent', t: T0 - 7200_000 })));
  for (const id of ['x1', 'x2', 'x3']) {
    h.state.apply([spawn({ agentId: id, toolUseId: 'tu-' + id, t: T0 - 7200_000 })]);
  }
  assert.equal(Object.keys(h.snap().huddles).length, 0, 'history must not open a huddle');
});

test('a subagent that goes quiet is treated as ended, so its huddle can close', () => {
  const h = harness({ agent_quiet_s: 60 });
  // the Agent calls share one assistant message, which is what makes them a huddle
  h.state.apply([call({ toolUseId: 'tu1', tool: 'Agent', t: T0 + 5 }), call({ toolUseId: 'tu2', tool: 'Agent', t: T0 + 6 })]);
  h.state.apply([spawn({ agentId: 'a1', toolUseId: 'tu1', t: T0 + 10 })]);
  h.state.apply([spawn({ agentId: 'a2', toolUseId: 'tu2', t: T0 + 20 })]);
  h.state.apply([call({ agentId: 'a1', toolUseId: 'c1', t: T0 + 30 })]);
  h.state.apply([call({ agentId: 'a2', toolUseId: 'c2', t: T0 + 40 })]);
  const hud = Object.values(h.snap().huddles)[0];
  assert.ok(hud, 'two spawns in one message make a huddle');
  assert.equal(hud.status, 'open');
  h.at(5 * 60_000);                       // both killed: no further records
  h.state.tick(h.now());
  assert.equal(h.agent(`${SID}/a1`).state, 'done', 'a killed agent stops thinking');
  assert.equal(Object.values(h.snap().huddles)[0].status, 'closed', 'and its huddle can finish');
});

test('a subagent still writing is left alone', () => {
  const h = harness({ agent_quiet_s: 60 });
  h.state.apply([spawn({ agentId: 'a1', t: T0 + 10 })]);
  h.at(120_000);
  h.state.apply([call({ agentId: 'a1', toolUseId: 'c9', t: h.now() })]);
  h.state.tick(h.now());
  assert.equal(h.agent(`${SID}/a1`).state, 'working', 'recent activity keeps it alive');
});

test('a session Claude Code reports as waiting is never shown as stale', () => {
  const h = harness({ session: { regStatus: 'waiting', waitingFor: 'dialog open', liveness: false } });
  h.at(60 * 60_000);
  h.state.tick(h.now());
  assert.equal(h.snap().sessions[SID].status, 'waiting', 'blocked on you outranks quiet');
  const stale = Object.values(h.snap().alerts).filter((a) => a.kind === 'stale');
  assert.equal(stale.length, 0, 'and raises no stale alert');
});
