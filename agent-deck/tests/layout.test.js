// node --test tests/layout.test.js — layout geometry and transitions with a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayout, assignDesks, podSlots, seatPositions, pathToDoor, pathFromDoor, seatOf, deskAt, roomWidth, podTable, DOOR, PAD } from '../web/js/layout.js';

const SID = 'sess-1';
const T0 = 1_700_000_000_000;
function agent(id, extra = {}) {
  return { id: `${SID}/${id}`, sessionId: SID, parentId: SID, isLead: false, type: 'Explore', name: id, model: 'claude-haiku-4-5-20251001', effort: 'low', state: 'working', tool: 'Grep', args: 'foo', paths: [], brief: '', tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 }, ctxUsed: 0, ctxLimit: 200000, toolCounts: {}, since: T0 - 60_000, spawnedAt: T0 - 600_000, huddleId: null, transcriptPath: '', touched: {}, ...extra };
}
function lead() { return agent('lead', { id: SID, isLead: true, type: 'lead', name: 'Lead', parentId: null, model: 'claude-fable-5-1' }); }
function snapshot(agents, huddles = []) {
  const s = { now: T0, sessions: { [SID]: { id: SID, name: 'agent workspace', lastPrompt: 'Build the deck', status: 'busy' } }, agents: {}, huddles: {}, alerts: {}, feed: [], health: {} };
  for (const a of agents) s.agents[a.id] = a;
  for (const h of huddles) s.huddles[h.id] = h;
  return s;
}
const UI = { sessionId: SID, selectedId: null, hoverId: null };
/** advance a layout in 100 ms steps (dt is capped at 0.25 s so big jumps would be lost) */
function run(layout, state, from, to, step = 100) {
  let scene = null;
  for (let t = from; t <= to; t += step) scene = layout.update(state, UI, t);
  return scene;
}
const dist = (a, b) => Math.hypot(a.i - b.i, a.j - b.j);
function segDist(p, a, b) { // point → segment
  const dx = b.i - a.i, dy = b.j - a.j, L = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((p.i - a.i) * dx + (p.j - a.j) * dy) / L));
  return dist(p, { i: a.i + dx * u, j: a.j + dy * u });
}

test('desk assignment: 1 agent (the lead) takes A1', () => {
  const m = assignDesks([lead()]);
  assert.equal(m[SID], 'A1');
});

test('desk assignment: 6 agents fill the six fixed desks, room stays 11 wide', () => {
  const agents = [lead(), agent('a'), agent('b'), agent('c'), agent('d'), agent('e')];
  const m = assignDesks(agents);
  const keys = Object.values(m);
  assert.deepEqual([...keys].sort(), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal(m[SID], 'A1');
  assert.equal(roomWidth(keys), 11);
});

test('desk assignment: 9 agents add desk columns (i += 3) and nobody is dropped', () => {
  const agents = [lead()];
  for (let k = 0; k < 8; k++) agents.push(agent('s' + k));
  const m = assignDesks(agents);
  const keys = Object.values(m);
  assert.equal(keys.length, 9);
  assert.equal(new Set(keys).size, 9, 'all desks distinct');
  const extra = keys.filter((k) => !['A1', 'A2', 'A3', 'B1', 'B2', 'B3'].includes(k)).sort();
  assert.deepEqual(extra, ['A4', 'A5', 'B4']);
  assert.deepEqual(deskAt('A4'), { i: 11, j: 2, w: 2 });
  assert.deepEqual(deskAt('B4'), { i: 11, j: 6.5, w: 2 });
  assert.deepEqual(deskAt('A5'), { i: 14, j: 2, w: 2 });
  assert.equal(roomWidth(keys), 17);
  // stable: re-assigning with the same agents changes nothing, and reservations survive removal
  assert.deepEqual(assignDesks(agents, m), m);
  const fewer = assignDesks(agents.slice(0, 3), m);
  assert.equal(Object.keys(fewer).length, 9, 'desks of departed agents stay reserved for the caller to release');
});

test('pod slot order is N1, S1, N2, S2', () => {
  assert.deepEqual(podSlots(4).map((s) => s.side + (s.bay + 1)), ['N1', 'S1', 'N2', 'S2']);
});

test('pod seat paths keep clear of the table on both sides of the hallway', () => {
  for (const slot of podSlots(2)) {
    const t = podTable(slot), seats = seatPositions(slot);
    assert.equal(seats.length, 4);
    for (const s of seats) {
      assert.ok(dist(s, t) > t.r, `seat ${s.i},${s.j} outside the table`);
      const pts = s.path;
      assert.deepEqual(pts[pts.length - 1], { i: s.i, j: s.j }, 'path ends on the seat');
      for (let k = 0; k + 1 < pts.length; k++) assert.ok(segDist(t, pts[k], pts[k + 1]) > t.r + 0.05, `segment ${k} of seat ${slot.side}${s.i},${s.j} clears the table`);
    }
  }
});

test('desk paths start at the door and end on the seat, avoiding row A desks', () => {
  for (const key of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'A4', 'B4']) {
    const out = pathToDoor(key), back = pathFromDoor(key);
    assert.deepEqual(out[out.length - 1], DOOR);
    assert.deepEqual(back[back.length - 1], seatOf(key));
    const d = deskAt(key);
    if (d.j < 4) { // row A walks round the east side of its desk before reaching the aisle
      assert.ok(out[0].i > d.i + d.w, `${key} leaves round the desk`);
      assert.equal(out[1].j, 4.5);
    } else assert.equal(out[0].j, 4.5);
  }
});

test('a joining agent walks from the airlock to its seat at 1.7 tiles/s', () => {
  const layout = createLayout();
  const L = lead(), joiner = agent('scout', { state: 'joining', spawnedAt: T0, since: T0 });
  const state = snapshot([L, joiner]);
  let scene = layout.update(state, UI, T0);
  const lp = scene.people.find((p) => p.id === SID), jp = scene.people.find((p) => p.id === joiner.id);
  assert.ok(lp.seated, 'lead seen long ago is seated at once');
  assert.deepEqual(lp.pos, seatOf('A1'));
  assert.equal(lp.facing, 'SW');
  assert.equal(jp.seated, false);
  assert.deepEqual(jp.pos, DOOR);
  assert.equal(jp.state, 'joining');
  assert.equal(jp.desk, 'A2');
  // path length door → A2 seat
  const path = [DOOR, ...pathFromDoor('A2')];
  let len = 0; for (let k = 0; k + 1 < path.length; k++) len += dist(path[k], path[k + 1]);
  const expectMs = len / 1.7 * 1000;
  scene = run(layout, state, T0 + 100, T0 + expectMs * 0.6);
  const mid = scene.people.find((p) => p.id === joiner.id);
  assert.equal(mid.seated, false, 'still walking at 60% of the expected time');
  assert.equal(mid.state, 'joining');
  assert.ok(['SE', 'NE', 'NW', 'SW'].includes(mid.facing));
  assert.ok(mid.walkT > 0);
  scene = run(layout, state, T0 + expectMs * 0.6, T0 + expectMs + 400);
  const done = scene.people.find((p) => p.id === joiner.id);
  assert.equal(done.seated, true, `seated within ${Math.round(expectMs)} ms`);
  assert.deepEqual(done.pos, seatOf('A2'));
  assert.equal(done.facing, 'SW');
  assert.equal(done.state, 'joining', 'the server still says joining, so the seated figure does too');
  const working = snapshot([L, { ...joiner, state: 'working' }]);
  assert.equal(layout.update(working, UI, T0 + expectMs + 500).people.find((p) => p.id === joiner.id).state, 'working', 'server state shows through once seated');
});

test('a removed desk agent walks to the door and disappears', () => {
  const layout = createLayout();
  const state = snapshot([lead(), agent('a'), agent('b')]);
  let scene = layout.update(state, UI, T0);
  assert.equal(scene.people.length, 3);
  const gone = snapshot([lead(), agent('a')]);
  scene = layout.update(gone, UI, T0 + 100);
  const b = scene.people.find((p) => p.name === 'b');
  assert.equal(b.state, 'leaving');
  assert.equal(b.seated, false);
  scene = run(layout, gone, T0 + 200, T0 + 12_000);
  assert.equal(scene.people.length, 2, 'b has left the scene');
  scene = layout.update(snapshot([lead(), agent('a'), agent('c', { state: 'joining', spawnedAt: T0 + 12_000 })]), UI, T0 + 12_100);
  assert.equal(scene.people.find((p) => p.name === 'c').desk, 'A3', 'released desk is reused');
});

test('a closed huddle collapses its pod, beams the crew to the pad, then they leave when removed', () => {
  const layout = createLayout();
  const hid = `${SID}/msg-1`;
  const m1 = agent('m1', { huddleId: hid }), m2 = agent('m2', { huddleId: hid });
  const huddle = { id: hid, sessionId: SID, goal: 'Where do hooks live?', memberIds: [m1.id, m2.id], startedAt: T0 - 60_000, reports: 0, status: 'open' };
  const open = snapshot([lead(), m1, m2], [huddle]);
  let scene = layout.update(open, UI, T0);
  assert.equal(scene.pods.length, 1);
  assert.deepEqual(scene.pods[0].slot, { bay: 0, side: 'N' });
  assert.equal(scene.pods[0].n, 1);
  assert.equal(scene.pods[0].h, 0, 'pod starts rising');
  scene = run(layout, open, T0 + 100, T0 + 1500);
  assert.equal(scene.pods[0].h, 1, 'pod fully risen after 1.2 s');
  assert.equal(scene.pods[0].phase, 'open');
  assert.ok(scene.hallway.len > 5.5, 'hallway extends to the first bay');
  const seats = seatPositions(scene.pods[0].slot, scene.room.w);
  const p1 = scene.people.find((p) => p.id === m1.id);
  assert.equal(p1.seated, true);
  assert.deepEqual(p1.pos, { i: seats[0].i, j: seats[0].j });
  assert.equal(p1.facing, seats[0].facing);
  assert.equal(p1.huddleN, 1);
  assert.ok(scene.props.some((x) => x.kind === 'laptop'), 'seated members get laptops');
  assert.ok(scene.tiles.some((x) => x.kind === 'hall') && scene.tiles.some((x) => x.kind === 'pod'));
  // close the huddle: members are still listed (state done) but the pod collapses and they beam out
  const closed = snapshot([lead(), { ...m1, state: 'done' }, { ...m2, state: 'done' }], [{ ...huddle, reports: 2, status: 'closed' }]);
  scene = layout.update(closed, UI, T0 + 1600);
  const b1 = scene.people.find((p) => p.id === m1.id);
  assert.equal(b1.state, 'teleporting');
  assert.deepEqual(b1.beam && b1.beam.dir, 'out');
  assert.equal(scene.pods[0].phase, 'collapsing');
  assert.equal(scene.props.find((x) => x.kind === 'pad').state, 'active');
  scene = run(layout, closed, T0 + 1700, T0 + 2800);
  const b2 = scene.people.find((p) => p.id === m1.id);
  assert.equal(b2.beam && b2.beam.dir, 'in', 'after 1 s the beam lands on the pad');
  assert.ok(dist(b2.pos, PAD) < 1, 'standing on the transporter pad');
  scene = run(layout, closed, T0 + 2900, T0 + 4200);
  const b3 = scene.people.find((p) => p.id === m1.id);
  assert.equal(b3.beam, null);
  assert.equal(b3.state, 'done', 'server truth shows while waiting on the pad');
  assert.equal(b3.atPad, true);
  assert.equal(scene.pods.length, 0, 'pod removed after the 1.6 s fall');
  assert.equal(scene.people.length, 3, 'nobody vanished while the server still lists them');
  // server removes the agents → they walk out through the airlock
  const removed = snapshot([lead()], []);
  scene = layout.update(removed, UI, T0 + 4300);
  assert.equal(scene.people.find((p) => p.id === m1.id).state, 'leaving');
  scene = run(layout, removed, T0 + 4400, T0 + 12_000);
  assert.equal(scene.people.length, 1, 'crew gone, lead remains');
  assert.equal(scene.hallway.len, 0, 'hallway retracts');
});

test('a huddle removed before the server drops its members beams them too; a fifth member takes a desk', () => {
  const layout = createLayout();
  const hid = `${SID}/msg-2`;
  const members = [0, 1, 2, 3, 4].map((k) => agent('m' + k, { huddleId: hid }));
  const huddle = { id: hid, sessionId: SID, goal: 'g', memberIds: members.map((m) => m.id), startedAt: T0, reports: 0, status: 'open' };
  let scene = run(layout, snapshot([lead(), ...members], [huddle]), T0, T0 + 1500);
  const seated = scene.people.filter((p) => p.huddleN === 1 && p.seated);
  assert.equal(seated.length, 4, 'four pod seats');
  const fifth = scene.people.find((p) => p.id === members[4].id);
  assert.equal(fifth.desk, 'A2', 'overflow member sits at a desk');
  scene = layout.update(snapshot([lead(), ...members], []), UI, T0 + 1600);
  assert.equal(scene.people.filter((p) => p.state === 'teleporting').length, 4);
});

test('scene always carries the room, six desks, the pad, the door, the board and the sign', () => {
  const scene = createLayout().update(snapshot([]), UI, T0);
  assert.deepEqual(scene.room, { w: 11, d: 9, wallH: 46 });
  assert.equal(scene.tiles.filter((t) => t.kind === 'floor').length, 11 * 9 - 11);
  assert.equal(scene.tiles.filter((t) => t.kind === 'aisle').length, 11);
  for (const kind of ['desk', 'chair', 'core', 'plant', 'dispenser', 'pad', 'door', 'board', 'sign']) assert.ok(scene.props.some((p) => p.kind === kind), kind);
  assert.equal(scene.props.filter((p) => p.kind === 'desk').length, 6);
  assert.deepEqual(scene.walls.map((w) => w.kind), ['north', 'west']);
  assert.equal(scene.props.find((p) => p.kind === 'board').text, 'Build the deck');
});

test('switching session drops the previous crew without animation', () => {
  const layout = createLayout();
  layout.update(snapshot([lead(), agent('a')]), UI, T0);
  const other = layout.update(snapshot([lead(), agent('a')]), { ...UI, sessionId: 'other' }, T0 + 100);
  assert.equal(other.people.length, 0);
});
