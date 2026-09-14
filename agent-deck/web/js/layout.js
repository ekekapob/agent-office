// Layout: domain state → Scene (CONTRACTS §5). Owns desk assignment, pod slots,
// hallway length, door paths and every transition timer (walk, beam, rise, fade).
// Pure-ish: all timing comes from the `nowMs` passed to update(), so tests can
// drive it with a fake clock. Knows nothing about pixels.
/** @typedef {import('../../shared/types.js').Agent} Agent */
/** @typedef {import('../../shared/types.js').Huddle} Huddle */
/** @typedef {import('../../shared/types.js').Snapshot} Snapshot */
import { freeSlot, podRect, podTable, seatPositions, podEntryPath, hallTarget, stepPod, podScene, POD_RISE_PX } from './layout-pods.js';
export { slotAt, podSlots, podRect, podTable, seatPositions } from './layout-pods.js';

export const ROOM = { w: 11, d: 9, wallH: 46 };
export const AISLE_J = 4;
export const DOOR = { i: 0.15, j: 4.5 };
export const DOOR_IN = { i: 0.7, j: 4.5 };
export const PAD = { i: 5.5, j: 4.5, r: 0.7 };
const PAD_OFF = [{ i: 0, j: 0 }, { i: -0.6, j: 0.35 }, { i: 0.6, j: -0.35 }, { i: 0.35, j: 0.6 }];
/** Row A backs onto the north wall, row B faces the aisle. A1 is the lead's wide console. */
export const DESKS = { A1: { i: 1, j: 2, w: 3 }, A2: { i: 5, j: 2, w: 2 }, A3: { i: 8, j: 2, w: 2 }, B1: { i: 2, j: 6.5, w: 2 }, B2: { i: 5, j: 6.5, w: 2 }, B3: { i: 8, j: 6.5, w: 2 } };
const BASE_KEYS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];
const DEFAULTS = { walkSpeed: 1.7, podRise: 1.2, podFall: 1.6, beamOut: 1, beamIn: 1, leaveFade: 0.8, recentMs: 10000, ctxWarnPct: 85, maxDt: 0.25 };

/** n-th desk key in fill order: the six fixed desks, then columns A4,B4,A5,B5,… */
export function deskKey(n) {
  if (n < 6) return BASE_KEYS[n];
  return ((n - 6) % 2 ? 'B' : 'A') + (4 + Math.floor((n - 6) / 2));
}
/**
 * Desk geometry for a key. Extra columns sit 3 tiles apart to the right of both rows.
 * @param {string} key
 * @returns {{i:number,j:number,w:number}|null}
 */
export function deskAt(key) {
  if (DESKS[key]) return DESKS[key];
  const m = /^([AB])(\d+)$/.exec(key || '');
  if (!m || +m[2] < 4) return null;
  return { i: 3 * +m[2] - 1, j: m[1] === 'A' ? 2 : 6.5, w: 2 };
}
/** Room width needed so every listed desk is indoors (11 for the six fixed desks). */
export function roomWidth(deskKeys) {
  let maxCol = 3;
  for (const k of deskKeys) { const m = /^[AB](\d+)$/.exec(k); if (m && +m[1] > maxCol) maxCol = +m[1]; }
  return ROOM.w + 3 * (maxCol - 3);
}
/** Chair position in front of a desk. */
export function seatOf(key) {
  const d = deskAt(key);
  return d ? { i: d.i + d.w / 2, j: d.j - 0.45 } : { ...DOOR_IN };
}
/**
 * Walking path from a desk seat to the airlock (row A walks round the desk's east side).
 * @param {string} key @returns {{i:number,j:number}[]}
 */
export function pathToDoor(key) {
  const d = deskAt(key), s = seatOf(key), p = [];
  if (!d) return [{ ...DOOR_IN }, { ...DOOR }];
  if (d.j < AISLE_J) { const side = d.i + d.w + 0.45; p.push({ i: side, j: s.j }, { i: side, j: 4.5 }); } else p.push({ i: s.i, j: 4.5 });
  p.push({ ...DOOR_IN }, { ...DOOR });
  return p;
}
/** Reverse of pathToDoor, ending on the seat and starting just inside the door. */
export function pathFromDoor(key) {
  const p = pathToDoor(key).reverse();
  p.push(seatOf(key));
  return p.slice(1);
}
/**
 * Stable desk assignment. Entries in `prev` are kept (also for ids no longer
 * in `agents`, so a leaving agent's desk stays reserved until the caller drops
 * it). The lead prefers A1; nobody else takes A1. Never runs out of desks.
 * @param {Array<{id:string,isLead?:boolean}>} agents
 * @param {Object<string,string>} [prev]
 * @returns {Object<string,string>} agentId → desk key
 */
export function assignDesks(agents, prev = {}) {
  const out = { ...prev }, taken = new Set(Object.values(out));
  const firstFree = (allowA1) => { for (let n = 0; ; n++) { const k = deskKey(n); if ((allowA1 || k !== 'A1') && !taken.has(k)) return k; } };
  const give = (a, allowA1) => { if (out[a.id]) return; const k = allowA1 && !taken.has('A1') ? 'A1' : firstFree(allowA1); out[a.id] = k; taken.add(k); };
  for (const a of agents) if (a.isLead) give(a, true);
  for (const a of agents) if (!a.isLead) give(a, false);
  return out;
}
/** Leaving path from an arbitrary position: reach the aisle centre line, then the airlock. */
function pathToDoorFrom(pos) {
  const p = [];
  if (Math.abs(pos.j - 4.5) > 0.05) p.push({ i: pos.i, j: 4.5 });
  if (pos.i > DOOR_IN.i + 0.05) p.push({ ...DOOR_IN });
  p.push({ ...DOOR });
  return p;
}

/**
 * Create a layout. `update(state, ui, nowMs)` returns the Scene for `ui.sessionId`.
 * @param {Partial<typeof DEFAULTS>} [cfg]
 */
export function createLayout(cfg = {}) {
  const C = { ...DEFAULTS, ...cfg };
  /** @type {Map<string, any>} agentId → person */ const persons = new Map();
  /** @type {Map<string, any>} huddleId → pod */ const pods = new Map();
  let deskMap = {}, podCount = 0, hallLen = 0, lastNow = null, sessionId = null;

  function reset() { persons.clear(); pods.clear(); deskMap = {}; podCount = 0; hallLen = 0; lastNow = null; }

  function podFor(a) {
    const p = a && a.huddleId ? pods.get(a.huddleId) : null;
    return p && (p.phase === 'rising' || p.phase === 'open') ? p : null;
  }
  function takeSeat(p, id) {
    const k = p.seats.indexOf(null);
    if (k < 0) return -1;
    p.seats[k] = id;
    return k;
  }
  function freeSeat(person) {
    const p = person.seat && person.seat.kind === 'pod' ? pods.get(person.seat.huddleId) : null;
    if (p) { const k = p.seats.indexOf(person.id); if (k >= 0) p.seats[k] = null; }
  }
  function beamOut(person, k) {
    person.phase = 'beamout'; person.beamT = 0; person.path = []; person.padOff = PAD_OFF[k % PAD_OFF.length];
  }

  function syncPods(huddles, roomW) {
    for (const h of huddles) {
      let p = pods.get(h.id);
      if (!p && h.status === 'open') {
        p = { id: h.id, n: ++podCount, slot: freeSlot([...pods.values()].map((x) => x.slot)), h: 0, phase: 'rising', seats: [null, null, null, null], startedAt: h.startedAt };
        pods.set(h.id, p);
      }
      if (p) { p.goal = h.goal; p.reports = h.reports; p.size = h.memberIds ? h.memberIds.length : 0; p.memberIds = h.memberIds || []; p.status = h.status; }
    }
    const live = new Set(huddles.filter((h) => h.status === 'open').map((h) => h.id));
    for (const p of pods.values()) {
      if (!live.has(p.id) && (p.phase === 'rising' || p.phase === 'open')) {
        p.phase = 'collapsing';
        let k = 0;
        for (const person of persons.values()) if (person.seat && person.seat.kind === 'pod' && person.seat.huddleId === p.id) beamOut(person, k++);
      }
    }
  }

  function syncPersons(agents, nowMs, roomW) {
    const present = new Set();
    for (const a of agents) {
      present.add(a.id);
      let person = persons.get(a.id);
      if (person) { person.agent = a; continue; }
      person = { id: a.id, agent: a, phase: 'seated', pos: { ...DOOR }, path: [], walkT: 0, facing: 'SW', fade: 0, beamT: 0, padOff: PAD_OFF[0], seat: null };
      const p = podFor(a), k = p ? takeSeat(p, a.id) : -1;
      const walk = a.state === 'joining' || (typeof a.spawnedAt === 'number' && nowMs - a.spawnedAt < C.recentMs);
      if (k >= 0) {
        const st = seatPositions(p.slot, roomW)[k];
        person.seat = { kind: 'pod', huddleId: p.id, idx: k, at: st };
        if (walk) { person.phase = 'arriving'; person.path = [...podEntryPath(p.slot, roomW), ...st.path.map((q) => ({ ...q }))]; }
        else { person.pos = { i: st.i, j: st.j }; person.facing = st.facing; }
      } else {
        deskMap = assignDesks([a], deskMap);
        person.seat = { kind: 'desk', key: deskMap[a.id] };
        if (walk) { person.phase = 'arriving'; person.path = pathFromDoor(deskMap[a.id]); }
        else { person.pos = seatOf(deskMap[a.id]); person.facing = 'SW'; }
      }
      persons.set(a.id, person);
    }
    for (const person of persons.values()) {
      if (present.has(person.id)) continue;
      if (person.phase === 'beamout' || person.phase === 'beamin' || person.phase === 'leaving' || person.phase === 'gone') continue;
      person.gone = true;
      if (person.seat && person.seat.kind === 'pod') {
        const p = pods.get(person.seat.huddleId);
        if (p && p.phase !== 'collapsing' && p.phase !== 'gone' && person.phase === 'seated') {
          const back = person.seat.at.path.slice(0, -1).reverse(), entry = podEntryPath(p.slot, roomW).reverse();
          person.path = [...back, ...entry, { ...DOOR }];
        } else if (p && p.phase === 'collapsing' && person.phase === 'seated') { beamOut(person, person.seat.idx); continue; }
        else person.path = pathToDoorFrom(person.pos);
      } else if (person.phase === 'seated' && person.seat) person.path = pathToDoor(person.seat.key);
      else person.path = pathToDoorFrom(person.pos);
      person.phase = 'leaving'; person.walkT = 0;
    }
  }

  function stepPerson(person, dt) {
    if (person.phase === 'beamout') {
      person.beamT += dt;
      if (person.beamT >= C.beamOut) { freeSeat(person); person.phase = 'beamin'; person.beamT = 0; person.pos = { i: PAD.i + person.padOff.i, j: PAD.j + person.padOff.j }; person.facing = 'NW'; }
      return;
    }
    if (person.phase === 'beamin') {
      person.beamT += dt;
      if (person.beamT >= C.beamIn) {
        person.seat = null; person.beamT = 0;
        if (person.gone || !person.agent) { person.phase = 'leaving'; person.path = pathToDoorFrom(person.pos); person.walkT = 0; }
        else person.phase = 'pad';
      }
      return;
    }
    if (person.phase === 'pad' && person.gone) { person.phase = 'leaving'; person.path = pathToDoorFrom(person.pos); person.walkT = 0; }
    if (person.phase !== 'leaving' && person.phase !== 'arriving') return;
    const t = person.path[0];
    if (!t) {
      if (person.phase === 'leaving') { person.fade += dt; if (person.fade >= C.leaveFade) person.phase = 'gone'; }
      else { person.phase = 'seated'; person.facing = person.seat && person.seat.kind === 'pod' ? person.seat.at.facing : 'SW'; }
      return;
    }
    const dx = t.i - person.pos.i, dy = t.j - person.pos.j, dist = Math.hypot(dx, dy), sp = C.walkSpeed * dt;
    if (dist > 1e-6) person.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'SE' : 'NW') : (dy > 0 ? 'SW' : 'NE');
    if (dist <= sp) { person.pos = { i: t.i, j: t.j }; person.path.shift(); } else { person.pos = { i: person.pos.i + dx / dist * sp, j: person.pos.j + dy / dist * sp }; }
    person.walkT += dt;
  }

  function personEntry(person, roomW) {
    const a = person.agent || {}, ph = person.phase;
    const state = ph === 'arriving' ? 'joining' : ph === 'leaving' ? 'leaving' : (ph === 'beamout' || ph === 'beamin') ? 'teleporting' : (a.state || 'idle');
    const pct = a.ctxLimit ? (a.ctxUsed || 0) / a.ctxLimit * 100 : 0;
    const seated = ph === 'seated' && !!person.seat;
    let plate = { i: person.pos.i, j: person.pos.j, z: -6 }, z = 0, alpha = 1, desk = null, huddleN = null, seatIdx = null;
    if (person.seat && person.seat.kind === 'desk') { desk = person.seat.key; if (seated) { const d = deskAt(desk); plate = { i: d.i + d.w / 2, j: d.j + 1, z: 5 }; } }
    if (person.seat && person.seat.kind === 'pod') {
      const p = pods.get(person.seat.huddleId); seatIdx = person.seat.idx;
      if (p) { huddleN = p.n; if (ph === 'seated' || ph === 'beamout') { z = -POD_RISE_PX * (1 - p.h); alpha = p.h; } }
      if (seated) plate = { i: person.pos.i, j: person.pos.j, z: -(6 + (seatIdx % 2) * 9) };
    }
    if (ph === 'leaving' && !person.path.length) alpha = Math.max(0, 1 - person.fade / C.leaveFade);
    const beam = ph === 'beamout' ? { t: Math.min(1, person.beamT / C.beamOut), dir: 'out' } : ph === 'beamin' ? { t: Math.min(1, person.beamT / C.beamIn), dir: 'in' } : null;
    return { id: person.id, name: a.name || person.id, type: a.type || 'default', isLead: !!a.isLead, model: a.model || null, state, pos: { ...person.pos }, seated, facing: person.facing, walkT: person.walkT, alpha, beam, ctxWarn: pct >= C.ctxWarnPct && state !== 'compacting', plate, bubble: { text: a.args || '', tool: a.tool || null, kind: state },
      sessionId: a.sessionId || sessionId, desk, huddleId: a.huddleId || (person.seat && person.seat.kind === 'pod' ? person.seat.huddleId : null), huddleN, seatIdx, z, ctxPct: pct, effort: a.effort || null, since: a.since || null, brief: a.brief || null, atPad: ph === 'pad', roomW };
  }

  /**
   * Advance transitions to `nowMs` and produce the Scene for `ui.sessionId`.
   * @param {Snapshot} state @param {{sessionId?:string|null, selectedId?:string|null, hoverId?:string|null}} ui @param {number} nowMs
   */
  function update(state, ui, nowMs) {
    const sid = ui && ui.sessionId ? ui.sessionId : null;
    if (sid !== sessionId) { reset(); sessionId = sid; }
    const dt = lastNow === null ? 0 : Math.max(0, Math.min(C.maxDt, (nowMs - lastNow) / 1000));
    lastNow = nowMs;
    const all = state && state.agents ? Object.values(state.agents) : [];
    const agents = all.filter((a) => a && a.sessionId === sid);
    const huddles = (state && state.huddles ? Object.values(state.huddles) : []).filter((h) => h && h.sessionId === sid);
    const session = state && state.sessions ? state.sessions[sid] : null;
    let roomW = roomWidth(Object.values(deskMap));
    syncPods(huddles, roomW);
    syncPersons(agents, nowMs, roomW);
    roomW = roomWidth(Object.values(deskMap));
    for (const p of pods.values()) stepPod(p, dt, C);
    for (const p of [...pods.values()]) if (p.phase === 'gone') pods.delete(p.id);
    for (const person of persons.values()) stepPerson(person, dt);
    for (const person of [...persons.values()]) if (person.phase === 'gone') { freeSeat(person); persons.delete(person.id); delete deskMap[person.id]; }
    const ht = hallTarget(pods.values());
    hallLen += (ht - hallLen) * Math.min(1, dt * 2.5);
    if (Math.abs(ht - hallLen) < 0.02) hallLen = ht;

    const scene = { room: { w: roomW, d: ROOM.d, wallH: ROOM.wallH }, tiles: [], walls: [], props: [], people: [], pods: [], hallway: { len: hallLen }, hilite: { selectedId: ui && ui.selectedId || null, hoverId: ui && ui.hoverId || null } };
    for (let i = 0; i < roomW; i++) for (let j = 0; j < ROOM.d; j++) scene.tiles.push({ i, j, kind: j === AISLE_J ? 'aisle' : 'floor', alpha: 1 });
    for (let k = 0; k < Math.ceil(hallLen - 0.001); k++) scene.tiles.push({ i: roomW + k, j: AISLE_J, kind: 'hall', alpha: Math.min(1, hallLen - k) });
    scene.walls.push({ kind: 'north', i0: 0, i1: roomW, alpha: 1 }, { kind: 'west', j0: 0, j1: ROOM.d, alpha: 1 });
    const deskCount = 6 + 2 * Math.max(0, (roomW - ROOM.w) / 3);
    for (let n = 0; n < deskCount; n++) {
      const key = deskKey(n), d = deskAt(key), sitter = [...persons.values()].find((p) => p.seat && p.seat.kind === 'desk' && p.seat.key === key && p.phase === 'seated');
      scene.props.push({ id: 'desk:' + key, kind: 'desk', i: d.i, j: d.j, w: d.w, d: 1, alpha: 1, state: sitter ? (sitter.agent && sitter.agent.state) || null : null, agentId: sitter ? sitter.id : null, text: key });
      scene.props.push({ id: 'chair:' + key, kind: 'chair', i: d.i + d.w / 2, j: d.j - 0.45, alpha: 1 });
    }
    const feedT = state && state.feed && state.feed.length ? state.feed[0].t : 0;
    const beaming = [...persons.values()].some((p) => p.phase === 'beamout' || p.phase === 'beamin');
    const atDoor = [...persons.values()].some((p) => (p.phase === 'arriving' || p.phase === 'leaving') && p.pos.i < 1.2 && Math.abs(p.pos.j - 4.5) < 0.6);
    scene.props.push(
      { id: 'core', kind: 'core', i: roomW - 1.45, j: 0.1, w: 0.8, d: 0.7, alpha: 1, state: nowMs - feedT < 600 ? 'blink' : null },
      { id: 'plant', kind: 'plant', i: roomW - 0.8, j: 7.2, w: 0.6, d: 0.6, alpha: 1 },
      { id: 'dispenser', kind: 'dispenser', i: 0.15, j: 7.3, w: 0.6, d: 0.6, alpha: 1 },
      { id: 'pad', kind: 'pad', i: PAD.i, j: PAD.j, r: PAD.r, alpha: 1, state: beaming ? 'active' : null },
      { id: 'door', kind: 'door', i: 0, j: 4.8, j0: 3.9, j1: 5.7, alpha: 1, state: atDoor ? 'open' : null },
      { id: 'board', kind: 'board', i: 0, j: 3.3, z: 39, w: 2.7, h: 23, j0: 0.6, j1: 3.3, z0: 16, z1: 39, alpha: 1, text: session && session.lastPrompt || '' },
      { id: 'sign', kind: 'sign', i: 0.5, j: 0, z: 41, w: 3.2, h: 10, i0: 0.4, i1: 3.6, z0: 32, z1: 42, alpha: 1, text: session && session.name || '' },
    );
    for (const p of pods.values()) {
      const occupants = p.seats.map((id) => { const q = id ? persons.get(id) : null; return q && (q.phase === 'seated' || q.phase === 'beamout') ? { state: (q.agent && q.agent.state) || 'idle' } : null; });
      podScene(p, roomW, occupants, scene);
      const t = podTable(p.slot, roomW);
      scene.pods.push({ id: p.id, n: p.n, slot: { ...p.slot }, h: p.h, goal: p.goal || '', reports: p.reports || 0, size: p.size || 0, tableAt: { i: t.i, j: t.j }, phase: p.phase, memberIds: p.memberIds || [], rect: podRect(p.slot, roomW), startedAt: p.startedAt || 0, status: p.status || 'open', z: -POD_RISE_PX * (1 - p.h) });
    }
    for (const person of persons.values()) scene.people.push(personEntry(person, roomW));
    return scene;
  }

  return { update, reset };
}
