// tests/adapter.test.js — the adapter against the real recordings in fixtures/v2.1.270 (ADR-0010).
// Everything here is a fixture in, expected events out: no clock, no filesystem beyond reading the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegistryFile, parseSubagentMeta, parseTranscriptLine, parseHookPayload, summarizeArgs } from '../shared/adapter.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v2.1.270');
const SESSION = '5c704dc8-c32c-4524-a3b2-1e286f657bb1';

/** Fresh adapter context, as the server builds one per transcript. */
function ctx(over = {}) {
  return { sessionId: null, agentId: null, version: null, cwd: null, home: '/Users/me',
    pendingTools: new Map(), seenDrift: new Set(), now: 1789285000000, ...over };
}

/** Run a whole fixture file through the adapter. */
function runFile(rel, over) {
  const c = ctx(over);
  const events = [];
  for (const line of fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n')) {
    if (line.trim()) events.push(...parseTranscriptLine(line, c));
  }
  return { events, c };
}

const tally = (events) => events.reduce((t, e) => (t[e.kind] = (t[e.kind] || 0) + 1, t), {});
const only = (events, kind) => events.filter((e) => e.kind === kind);

// ---------------------------------------------------------------- registry

test('parseRegistryFile reads a live registry entry', () => {
  const json = JSON.parse(fs.readFileSync(path.join(FIX, 'sessions', '64500.json'), 'utf8'));
  const s = parseRegistryFile(json, { now: 1789285300000 });
  assert.equal(s.id, SESSION);
  assert.equal(s.pid, 64500);
  assert.equal(s.name, 'agent workspace');
  assert.equal(s.cwd, '/Users/me/Documents/GitHub/agent-workspace');
  assert.equal(s.status, 'busy');
  assert.equal(s.version, '2.1.270');
  assert.equal(s.startedAt, 1789284974230);
  assert.equal(s.transcriptPath, '', 'the adapter does not know the data root');
});

test('parseRegistryFile falls back to the cwd basename and never throws', () => {
  assert.equal(parseRegistryFile(null), null);
  assert.equal(parseRegistryFile({ pid: 1 }), null, 'no sessionId means no Session');
  const s = parseRegistryFile({ sessionId: 'abc', cwd: '/home/j/proj' }, { now: 5 });
  assert.equal(s.name, 'proj');
  assert.equal(s.pid, null);
  assert.equal(s.status, 'idle');
});

test('all three registry fixtures parse and keep distinct session ids', () => {
  const ids = fs.readdirSync(path.join(FIX, 'sessions'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => parseRegistryFile(JSON.parse(fs.readFileSync(path.join(FIX, 'sessions', f), 'utf8'))))
    .map((s) => s.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
});

// ---------------------------------------------------------------- subagent transcript

test('a complete subagent transcript yields the expected events', () => {
  const { events } = runFile('subagent-explore/agent-a7554d2a808cd9271.jsonl');
  assert.deepEqual(tally(events), {
    prompt: 1, session_meta: 3, assistant_turn: 5, tool_call: 2, tool_result: 2, agent_end: 1,
  });
  assert.equal(only(events, 'drift').length, 0, 'a real transcript must not drift');
  for (const e of events) if (e.sessionId !== undefined) assert.equal(e.sessionId, SESSION);
});

test('the subagent model comes from its own assistant records when the meta file has none', () => {
  const { events } = runFile('subagent-explore/agent-a7554d2a808cd9271.jsonl');
  const models = new Set(only(events, 'assistant_turn').map((e) => e.model));
  assert.deepEqual([...models], ['claude-haiku-4-5-20251001']);
});

test('ctxUsed is input + cache_read + cache_creation of the record', () => {
  const { events } = runFile('subagent-explore/agent-a7554d2a808cd9271.jsonl');
  const turns = only(events, 'assistant_turn');
  assert.equal(turns[0].ctxUsed, 10 + 0 + 9974);
  assert.equal(turns.at(-1).ctxUsed, 8 + 9974 + 1172);
  assert.equal(turns[0].usage.cacheWrite, 9974);
});

test('every record of the subagent transcript carries its agentId', () => {
  const { events } = runFile('subagent-explore/agent-a7554d2a808cd9271.jsonl');
  for (const e of events) {
    if (!('agentId' in e) || e.agentId === undefined) continue;
    assert.equal(e.agentId, 'a7554d2a808cd9271');
  }
});

test('the closing SubagentStop hook attachment becomes agent_end', () => {
  const { events } = runFile('subagent-explore/agent-a7554d2a808cd9271.jsonl');
  const end = only(events, 'agent_end');
  assert.equal(end.length, 1);
  assert.equal(end[0].agentId, 'a7554d2a808cd9271');
  assert.equal(events.at(-1).kind, 'agent_end', 'it is the last thing that happens');
});

test('tool arguments are summarised to at most 120 characters and carry paths', () => {
  const { events } = runFile('subagent-explore/agent-a7554d2a808cd9271.jsonl');
  const calls = only(events, 'tool_call');
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.tool, 'Bash');
    assert.ok(c.args.length <= 120, `args too long: ${c.args.length}`);
    assert.ok(c.paths.length >= 1, 'a Bash command over ~/.claude must yield paths');
    for (const p of c.paths) assert.ok(p.startsWith('~/'), `expected a ~-relative path, got ${p}`);
  }
});

// ---------------------------------------------------------------- parent transcript

test('the parent excerpt yields one prompt, two titles and one spawn', () => {
  const { events } = runFile('parent/excerpt.jsonl');
  assert.deepEqual(tally(events), { prompt: 1, session_meta: 2, title: 2, assistant_turn: 2, tool_call: 1, tool_result: 1, agent_spawn: 1 });
  assert.equal(only(events, 'prompt')[0].text, 'can you detect how many claude session currently running now?');
  assert.deepEqual(only(events, 'title').map((e) => e.title), ['Detect running Claude sessions', 'agent office']);
});

test('agent_spawn is built from the Agent tool_use and its tool_result', () => {
  const { events } = runFile('parent/excerpt.jsonl');
  const [spawn] = only(events, 'agent_spawn');
  assert.equal(spawn.agentId, 'a7554d2a808cd9271');
  assert.equal(spawn.toolUseId, 'toolu_01Bukhd3zN5BAeUbFd1coLMp');
  assert.equal(spawn.type, 'Explore', 'subagent_type comes from the tool_use input');
  assert.equal(spawn.description, 'Probe subagent transcript layout');
  assert.equal(spawn.model, 'claude-haiku-4-5-20251001', 'resolvedModel wins over the alias in the input');
  assert.ok(spawn.brief.startsWith('You are a probe.'));
  const [call] = only(events, 'tool_call');
  assert.equal(call.tool, 'Agent');
  assert.equal(call.toolUseId, spawn.toolUseId, 'the tool_use id links the spawn to its assistant message');
});

test('an async launch does not end the agent it just started', () => {
  const { events } = runFile('parent/excerpt.jsonl');
  assert.equal(only(events, 'agent_end').length, 0);
});

// ---------------------------------------------------------------- the huddle signal

test('five Agent calls in one assistant message give five spawns under one message id', () => {
  const { events } = runFile('parent/batch-spawn.jsonl');
  const calls = only(events, 'tool_call');
  const spawns = only(events, 'agent_spawn');
  assert.equal(calls.length, 5);
  assert.equal(spawns.length, 5);
  const ids = new Set(calls.map((c) => c.messageId));
  assert.equal(ids.size, 1, 'one assistant message');
  assert.equal([...ids][0], 'msg_011Cf14ykhqeGwZQNYAZ1sNp');
  assert.equal(new Set(spawns.map((s) => s.agentId)).size, 5, 'five distinct agents');
  for (const s of spawns) {
    assert.equal(s.type, 'general-purpose');
    assert.equal(s.model, 'claude-fable-5-1');
    assert.ok(s.description.length > 0);
  }
  // and every spawn can be traced back to that one message through its tool_use id
  const byTool = new Map(calls.map((c) => [c.toolUseId, c.messageId]));
  for (const s of spawns) assert.equal(byTool.get(s.toolUseId), 'msg_011Cf14ykhqeGwZQNYAZ1sNp');
});

// ---------------------------------------------------------------- drift, never exceptions

test('a corrupted line becomes drift, not an exception', () => {
  const c = ctx({ sessionId: SESSION, version: '2.1.270' });
  const out = parseTranscriptLine('{"type":"assistant","message":{"id"', c);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'drift');
  assert.equal(out[0].field, 'line.json');
  assert.ok(out[0].sample.length > 0);
});

test('an unknown record type drifts once per version', () => {
  const c = ctx({ sessionId: SESSION, version: '2.1.270' });
  const rec = JSON.stringify({ type: 'wombat', sessionId: SESSION, uuid: 'u1' });
  const first = parseTranscriptLine(rec, c);
  const second = parseTranscriptLine(rec, c);
  assert.equal(first[0].kind, 'drift');
  assert.equal(first[0].field, 'type.wombat');
  assert.equal(first[0].version, '2.1.270');
  assert.ok(!first[0].repeat);
  assert.ok(second[0].repeat, 'the second one is marked as a repeat so the state can drop it');
});

test('missing fields drift with the record uuid and never throw', () => {
  const c = ctx({ sessionId: SESSION });
  for (const rec of [
    { type: 'assistant', uuid: 'a1' },                                   // no message
    { type: 'user', uuid: 'u2' },                                        // no message
    { type: 'user', uuid: 'u3', message: { content: 42 } },              // content is neither text nor blocks
  ]) {
    const out = parseTranscriptLine(JSON.stringify(rec), c);
    assert.equal(out[0].kind, 'drift', JSON.stringify(rec));
    assert.equal(out[0].sample, rec.uuid);
  }
  assert.deepEqual(parseTranscriptLine('', c), []);
  assert.deepEqual(parseTranscriptLine(null, c), []);
  assert.deepEqual(parseTranscriptLine('   ', c), []);
});

test('an assistant record with no message id still produces a turn, plus drift', () => {
  const c = ctx({ sessionId: SESSION });
  const out = parseTranscriptLine(JSON.stringify({
    type: 'assistant', uuid: 'x1', sessionId: SESSION,
    message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 5 } },
  }), c);
  assert.ok(out.some((e) => e.kind === 'drift' && e.field === 'assistant.message.id'));
  const turn = out.find((e) => e.kind === 'assistant_turn');
  assert.ok(turn);
  assert.equal(turn.messageId, 'x1', 'the record uuid stands in for the missing message id');
  assert.equal(turn.ctxUsed, 5);
});

// ---------------------------------------------------------------- meta + hooks

test('parseSubagentMeta reads the type, description, model and the spawning tool_use id', () => {
  const json = JSON.parse(fs.readFileSync(path.join(FIX, 'subagent-explore', 'agent-a7554d2a808cd9271.meta.json'), 'utf8'));
  const m = parseSubagentMeta(json, { sessionId: SESSION, agentId: 'a7554d2a808cd9271' });
  assert.equal(m.id, `${SESSION}/a7554d2a808cd9271`);
  assert.equal(m.type, 'Explore');
  assert.equal(m.name, 'Probe subagent transcript layout');
  assert.equal(m.model, 'haiku');
  assert.equal(m.toolUseId, 'toolu_01Bukhd3zN5BAeUbFd1coLMp');
  assert.equal(m.depth, 1);
  assert.deepEqual(parseSubagentMeta(null, { sessionId: 's', agentId: 'a' }), { id: 's/a', sessionId: 's' });
  assert.equal(parseSubagentMeta({ model: null }, { sessionId: 's', agentId: 'a' }).model, undefined,
    'a null model means "ask the transcript"');
});

test('the PermissionRequest hook payload is normalised and size-capped', () => {
  const body = JSON.parse(fs.readFileSync(path.join(FIX, '..', 'hooks', 'PermissionRequest.example.json'), 'utf8'));
  const h = parseHookPayload('PermissionRequest', body, { now: 1, home: '/Users/me' });
  assert.equal(h.event, 'PermissionRequest');
  assert.equal(h.sessionId, SESSION);
  assert.equal(h.tool, 'Edit');
  // the file is outside the session's cwd but inside home, so it is shown ~-relative
  assert.deepEqual(h.paths, ['~/Documents/GitHub/jenkins/casc.yaml']);
  assert.ok(h.args.includes('casc.yaml'));
  assert.equal(parseHookPayload('PermissionRequest', {}, {}), null, 'no session_id means the payload is useless');
  assert.equal(parseHookPayload('X', null, {}), null);
  const long = parseHookPayload('Notification', { session_id: 's', message: 'x'.repeat(5000) }, {});
  assert.equal(long.message.length, 300);
});

test('summarizeArgs stays within 120 characters for every tool', () => {
  const cases = [
    ['Read', { file_path: '/a/'.repeat(200) + 'f.js' }],
    ['Bash', { command: 'echo ' + 'y'.repeat(500) }],
    ['Grep', { pattern: 'z'.repeat(400) }],
    ['Unknown', { blob: 'q'.repeat(900) }],
  ];
  for (const [tool, input] of cases) {
    const s = summarizeArgs(tool, input, { cwd: '/tmp', home: '/Users/me' });
    assert.ok(s.length <= 120, `${tool}: ${s.length}`);
    assert.ok(!/[\r\n]/.test(s), `${tool} must be one line`);
  }
  assert.equal(summarizeArgs('Read', null), '');
});
