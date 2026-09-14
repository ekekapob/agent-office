// Huddle pod geometry and lifecycle helpers for layout.js (pure, no DOM).
// Tile coordinates: i runs to the lower-right, j to the lower-left. Pods line a
// hallway that leaves the room at j=4 (centre 4.5) and alternate north (j 0–4)
// and south (j 5–9) per bay. Ported from mockups/f-spaceship-deck.html podSeats().

/** @typedef {{bay:number, side:'N'|'S'}} PodSlot */
/** @typedef {{i:number, j:number}} Pt */
/** @typedef {{i:number, j:number, facing:'SW'|'SE'|'NW'|'NE', path:Pt[]}} PodSeat */

export const POD_W = 6;
export const POD_D = 4;
export const HALL_J0 = 4;
export const HALL_J1 = 5;
export const POD_RISE_PX = 30;

/**
 * Slot for the n-th pod (0-based): N1, S1, N2, S2, ...
 * @param {number} n
 * @returns {PodSlot}
 */
export function slotAt(n) {
  return { bay: Math.floor(n / 2), side: n % 2 ? 'S' : 'N' };
}

/**
 * The first `count` pod slots in fill order.
 * @param {number} count
 * @returns {PodSlot[]}
 */
export function podSlots(count) {
  const out = [];
  for (let n = 0; n < count; n++) out.push(slotAt(n));
  return out;
}

/**
 * First slot not present in `taken` (never null: slots extend along the hallway).
 * @param {PodSlot[]} taken
 * @returns {PodSlot}
 */
export function freeSlot(taken) {
  for (let n = 0; n < taken.length + 1; n++) {
    const s = slotAt(n);
    if (!taken.some((t) => t.bay === s.bay && t.side === s.side)) return s;
  }
  return slotAt(taken.length);
}

/**
 * Tile rectangle of a pod. `roomW` is where the hallway starts (room width).
 * @param {PodSlot} slot
 * @param {number} [roomW=11]
 * @returns {{i0:number,i1:number,j0:number,j1:number}}
 */
export function podRect(slot, roomW = 11) {
  const i0 = roomW + slot.bay * POD_W;
  return slot.side === 'N'
    ? { i0, i1: i0 + POD_W, j0: 0, j1: HALL_J0 }
    : { i0, i1: i0 + POD_W, j0: HALL_J1, j1: HALL_J1 + POD_D };
}

/**
 * Round holo table at the centre of a pod.
 * @param {PodSlot} slot
 * @param {number} [roomW=11]
 * @returns {{i:number,j:number,r:number,h:number}}
 */
export function podTable(slot, roomW = 11) {
  const r = podRect(slot, roomW);
  return { i: r.i0 + 3, j: slot.side === 'N' ? 2.0 : 7.0, r: 0.95, h: 14 };
}

/**
 * Four seats around the table with a walking path from the hallway entrance
 * (the rail gap at i0+2.5..3.5) that keeps clear of the table.
 * @param {PodSlot} slot
 * @param {number} [roomW=11]
 * @returns {PodSeat[]}
 */
export function seatPositions(slot, roomW = 11) {
  const x = podRect(slot, roomW).i0;
  if (slot.side === 'N') {
    return [
      { i: x + 1.8, j: 1.15, facing: 'SE', path: [{ i: x + 3, j: 3.6 }, { i: x + 1.15, j: 3.4 }, { i: x + 1.15, j: 1.15 }, { i: x + 1.8, j: 1.15 }] },
      { i: x + 3.0, j: 0.85, facing: 'SW', path: [{ i: x + 3, j: 3.6 }, { i: x + 1.15, j: 3.4 }, { i: x + 1.15, j: 0.85 }, { i: x + 3.0, j: 0.85 }] },
      { i: x + 4.2, j: 1.15, facing: 'SW', path: [{ i: x + 3, j: 3.6 }, { i: x + 4.85, j: 3.4 }, { i: x + 4.85, j: 1.15 }, { i: x + 4.2, j: 1.15 }] },
      { i: x + 1.35, j: 2.5, facing: 'SE', path: [{ i: x + 3, j: 3.6 }, { i: x + 1.15, j: 3.4 }, { i: x + 1.15, j: 2.5 }, { i: x + 1.35, j: 2.5 }] },
    ];
  }
  return [
    { i: x + 1.8, j: 6.15, facing: 'SE', path: [{ i: x + 3, j: 5.4 }, { i: x + 1.8, j: 5.5 }, { i: x + 1.8, j: 6.15 }] },
    { i: x + 3.0, j: 5.85, facing: 'SW', path: [{ i: x + 3, j: 5.4 }, { i: x + 3.0, j: 5.85 }] },
    { i: x + 4.2, j: 6.15, facing: 'SW', path: [{ i: x + 3, j: 5.4 }, { i: x + 4.2, j: 5.5 }, { i: x + 4.2, j: 6.15 }] },
    { i: x + 1.35, j: 7.5, facing: 'SE', path: [{ i: x + 3, j: 5.4 }, { i: x + 1.15, j: 5.5 }, { i: x + 1.15, j: 7.5 }, { i: x + 1.35, j: 7.5 }] },
  ];
}

/**
 * Path from just inside the airlock along the hallway to a pod's entrance.
 * @param {PodSlot} slot
 * @param {number} [roomW=11]
 * @returns {Pt[]}
 */
export function podEntryPath(slot, roomW = 11) {
  const r = podRect(slot, roomW);
  return [{ i: 0.7, j: 4.5 }, { i: r.i0 + 3, j: 4.5 }];
}

/**
 * Hallway length (tiles) needed to reach the furthest pod.
 * @param {Iterable<{slot:PodSlot}>} pods
 * @returns {number}
 */
export function hallTarget(pods) {
  let max = -1;
  for (const p of pods) if (p.slot.bay > max) max = p.slot.bay;
  return max < 0 ? 0 : (max + 1) * POD_W;
}

/**
 * Advance a pod's rise/fall animation. Mutates `pod.h` and `pod.phase`.
 * @param {{h:number, phase:'rising'|'open'|'collapsing'|'gone'}} pod
 * @param {number} dt seconds
 * @param {{podRise:number, podFall:number}} cfg
 */
export function stepPod(pod, dt, cfg) {
  if (pod.phase === 'rising') {
    pod.h = Math.min(1, pod.h + dt / cfg.podRise);
    if (pod.h >= 1) pod.phase = 'open';
  } else if (pod.phase === 'collapsing') {
    pod.h = Math.max(0, pod.h - dt / cfg.podFall);
    if (pod.h <= 0) pod.phase = 'gone';
  }
}

/**
 * Append a pod's tiles, walls and props to a scene under construction.
 * Pod pieces carry `z` (rise offset in art px) and `podId` so a renderer can
 * either draw them per piece or ignore them and draw from `scene.pods`.
 * @param {{id:string, n:number, slot:PodSlot, h:number, reports:number}} pod
 * @param {number} roomW
 * @param {Array<{state:string}|null>} occupants seat index → agent state (for laptops)
 * @param {{tiles:Array, walls:Array, props:Array}} scene
 */
export function podScene(pod, roomW, occupants, scene) {
  const h = pod.h, z = -POD_RISE_PX * (1 - h), r = podRect(pod.slot, roomW), N = pod.slot.side === 'N';
  const t = podTable(pod.slot, roomW), podId = pod.id;
  for (let i = r.i0; i < r.i1; i++) for (let j = r.j0; j < r.j1; j++) scene.tiles.push({ i, j, kind: 'pod', alpha: h, z, podId });
  if (N) scene.walls.push({ kind: 'podNorth', i0: r.i0, i1: r.i1, z, alpha: h, podId });
  scene.walls.push({ kind: 'glassI', i: r.i0, j0: r.j0, j1: r.j1, z, alpha: h, podId });
  const jr = N ? r.j1 : r.j0, gap = [r.i0 + 2.5, r.i0 + 3.5];
  scene.walls.push({ kind: 'railJ', j: jr, i0: r.i0, i1: gap[0], z, alpha: h, podId });
  scene.walls.push({ kind: 'railJ', j: jr, i0: gap[1], i1: r.i1, z, alpha: h, podId });
  scene.props.push({ id: 'table:' + podId, kind: 'table', i: t.i, j: t.j, r: t.r, h: t.h, z, alpha: h, podId, reports: pod.reports, text: String(pod.n) });
  seatPositions(pod.slot, roomW).forEach((st, k) => {
    scene.props.push({ id: `stool:${podId}:${k}`, kind: 'stool', i: st.i, j: st.j, z, alpha: h, podId });
    const occ = occupants[k];
    if (!occ) return;
    const dx = t.i - st.i, dy = t.j - st.j, n = Math.hypot(dx, dy) || 1;
    scene.props.push({ id: `laptop:${podId}:${k}`, kind: 'laptop', i: t.i - dx / n * 0.62, j: t.j - dy / n * 0.62, z: z + t.h, alpha: h, podId, state: occ.state, di: dx / n, dj: dy / n });
  });
}
