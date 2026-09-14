// Furniture and fixtures: desk, chair, core (server rack), plant, dispenser, transporter pad,
// airlock door, holo board/sign plates, and the pod's holo table/stool/laptop. Each function takes
// one `scene.props[]` entry (CONTRACTS §5) plus the colour table; geometry fields are read straight
// off the prop so layout.js owns every position. Ported from mockups/f-spaceship-deck.html
// drawDesk/drawChair/drawRack/drawPlant/drawCoffee/drawPod's table+seat+laptop block.
import { iso, box, cyl, poly, R, wallFaceN, wallFaceW, ellipsePts, withAlpha } from './primitives.js';

/** Desk console: legs, a paper+mug still life, and one or two monitors that glow with `prop.state`. */
export function drawDesk(prop, C, f) {
  const { i, j, w } = prop, d = prop.d || 1;
  box(i, j, w, d, 0, 14, C.desk);
  const l1 = iso(i + 0.1, j + 1), l2 = iso(i + w - 0.1, j + 1);
  R(l1.x - 1, l1.y - 8, 2, 8, C.steel3); R(l2.x - 1, l2.y - 8, 2, 8, C.steel3);
  const pp = iso(i + 0.35, j + 0.35, 14);
  poly([pp.x, pp.y, pp.x + 5, pp.y + 2.5, pp.x, pp.y + 5, pp.x - 5, pp.y + 2.5], C.trimDim);
  poly([pp.x, pp.y + 1, pp.x + 3, pp.y + 2.5, pp.x, pp.y + 4, pp.x - 3, pp.y + 2.5], C.trim);
  const st = prop.state, glow = st ? (C.states[st] || C.screenIdle) : C.screenIdle;
  const mons = w > 2 ? [i + w / 2 - 0.55, i + w / 2 + 0.45] : [i + w / 2];
  for (const mi of mons) {
    if (st && st !== 'idle') {
      const a = iso(mi - 0.45, j + 0.05, 14), b = iso(mi + 0.45, j + 0.05, 14), c = iso(mi + 0.45, j + 0.6, 14), dd = iso(mi - 0.45, j + 0.6, 14);
      withAlpha(0.28, () => poly([a.x, a.y, b.x, b.y, c.x, c.y, dd.x, dd.y], glow));
    }
    box(mi - 0.32, j + 0.62, 0.64, 0.12, 14, 11, C.monitor);
    const rim = iso(mi, j + 0.62, 25); R(rim.x - 5, rim.y - 1, 10, 1, st && st !== 'idle' ? glow : C.monitorRim);
    const stand = iso(mi, j + 0.7, 14); R(stand.x - 1, stand.y - 1, 2, 1, C.monitorStand);
    if (st === 'working') for (let k = 0; k < 2; k++) { const ph = (f * 2 + k * 7) % 14, pt = iso(mi + (k ? 0.15 : -0.15), j + 0.5, 26 + ph); withAlpha(1 - ph / 14, () => R(pt.x, pt.y, 1, 1, glow)); }
  }
}

/** Chair at the seat position `prop.i,prop.j` (already the desk's seat centre — see layout.js). */
export function drawChair(prop, C) {
  box(prop.i - 0.5, prop.j - 0.55, 1.0, 0.6, 0, 6, C.chair);
  box(prop.i - 0.5, prop.j - 0.65, 1.0, 0.14, 6, 12, C.chair);
}

/** Server rack ("core"): blinking LED column (faster while `prop.state === 'blink'`) + a status strip. */
export function drawCore(prop, C, f) {
  const { i, j, w, d } = prop, blink = prop.state === 'blink';
  box(i, j, w, d, 0, 36, C.core);
  for (let k = 0; k < 7; k++) {
    const p = iso(i + 0.07, j + 0.7, 5 + k * 4.2);
    const on = blink ? (f + k) % 2 === 0 : (f + k) % 9 === 0;
    R(p.x, p.y, 1, 1, on ? (k % 2 ? C.states.waiting : C.trim) : C.ledOff);
    R(p.x + 3, p.y, 4, 1, C.ledSlot);
  }
  const s = iso(i + 0.8, j + 0.7, 4);
  R(s.x, s.y - 30, 1, 30, (f % 6 < 3) ? C.trim : C.trimDim);
}

/** Potted plant behind a glass tube. */
export function drawPlant(prop, C) {
  const { i, j, w, d } = prop;
  box(i, j, w, d, 0, 5, C.plant);
  const p = iso(i + 0.3, j + 0.3, 5);
  R(p.x - 4, p.y - 8, 8, 4, C.leaf[0]); R(p.x - 6, p.y - 6, 12, 3, C.leaf[1]); R(p.x - 3, p.y - 11, 6, 3, C.leaf[2]); R(p.x - 1, p.y - 13, 2, 2, C.leaf[2]);
  withAlpha(0.35, () => cyl(i + 0.3, j + 0.3, 0.42, 5, 16, C.tube));
}

/** Coffee/drink dispenser: blinking indicator + an occasional steam pixel. */
export function drawDispenser(prop, C, f) {
  const { i, j, w, d } = prop;
  box(i, j, w, d, 0, 14, C.dispenser);
  const p = iso(i + 0.6, j + 0.6, 9);
  R(p.x, p.y - 1, 1, 1, (f % 10 < 5) ? C.trim : C.trimDim);
  const s = iso(i + 0.3, j + 0.3, 15);
  if (f % 3) R(s.x, s.y - (f % 3), 1, 1, C.steam);
}

/** Transporter pad: rim glows and the column brightens while `prop.state === 'active'`. */
export function drawPad(prop, C, f) {
  const { i, j, r } = prop, active = prop.state === 'active';
  poly(ellipsePts(i, j, r + 0.12, 0), active ? C.trim : C.trimDim);
  cyl(i, j, r, 0, 2, C.pad);
  poly(ellipsePts(i, j, r * 0.55, 2), active && f % 2 ? C.glass : C.padCore);
  if (active) withAlpha(0.12, () => box(i - 0.75, j - 0.75, 1.5, 1.5, 2, 44, C.beam));
}

/** Airlock door on the west wall, spanning `prop.j0..prop.j1`. Window lights steady when `state === 'open'`. */
export function drawDoor(prop, C, f) {
  const { j0, j1 } = prop, open = prop.state === 'open';
  wallFaceW(j0, j1, 0, 40, C.steel1);
  wallFaceW(j0 + 0.2, j1 - 0.2, 0, 38, C.doorPanel);
  wallFaceW(j0 + 0.68, j0 + 0.72, 0, 38, C.steel2);
  wallFaceW(j0 + 0.2, j1 - 0.2, 3, 5, C.hazard);
  wallFaceW(j0 + 0.4, j0 + 0.7, 3, 5, C.doorPanel); wallFaceW(j1 - 0.7, j1 - 0.4, 3, 5, C.doorPanel);
  wallFaceW(j0 + 0.25, j1 - 0.25, 20, 28, C.doorWindow);
  wallFaceW(j0 + 0.3, j1 - 0.3, 21, 27, (open || f % 16 < 8) ? C.trim : C.trimDim);
}

/** Assignment holo board on the west wall; the prompt text itself is an HTML overlay (owner D). */
export function drawBoard(prop, C) {
  const { j0, j1, z0, z1 } = prop;
  wallFaceW(j0 - 0.1, j1 + 0.1, z0 - 1, z1 + 1, C.trimDim);
  wallFaceW(j0, j1, z0, z1, C.holoScreen);
}

/** Ship name plate on the north wall; the name text is an HTML overlay (owner D). */
export function drawSign(prop, C) {
  const { i0, i1, z0, z1 } = prop;
  wallFaceN(i0, i1, z0, z1, C.signPlate);
  wallFaceN(i0, i1, z0, z0 + 0.6, C.trim); wallFaceN(i0, i1, z1 - 0.6, z1, C.trim);
}

/** Round holo table at a pod's centre, with `prop.reports` floating report chips. */
export function drawTable(prop, C) {
  const { i, j, r, h, reports } = prop, z = prop.z || 0;
  cyl(i, j, 0.25, z, h - 3, C.desk);
  poly(ellipsePts(i, j, r + 0.06, z + h), C.trim);
  cyl(i, j, r, z + h - 3, 3, C.table);
  for (let k = 0; k < (reports || 0); k++) {
    const q = iso(i - 0.05 + k * 0.12, j + 0.25 - k * 0.06, h + z + 1 + k);
    poly([q.x, q.y, q.x + 5, q.y + 2.5, q.x, q.y + 5, q.x - 5, q.y + 2.5], C.glass);
    poly([q.x, q.y + 1, q.x + 2, q.y + 2, q.x, q.y + 3, q.x - 2, q.y + 2], C.chipInk);
  }
}

/** Stool at a pod seat. */
export function drawStool(prop, C) { cyl(prop.i, prop.j, 0.3, prop.z || 0, 6, C.stool); }

/** Laptop open toward the table (`prop.di,prop.dj`), screen rim tinted by the occupant's state. */
export function drawLaptop(prop, C) {
  const { i, j, di, dj, state } = prop, z = prop.z || 0;
  box(i - 0.16, j - 0.11, 0.32, 0.22, z, 1, C.laptop);
  box(i - 0.16 + di * 0.12, j - 0.11 + dj * 0.12, 0.32, 0.05, z + 1, 5, C.laptop);
  const rim = iso(i + di * 0.12, j - 0.08 + dj * 0.12, z + 6);
  R(rim.x - 3, rim.y - 1, 6, 1, (state && C.states[state]) || C.trimDim);
}
