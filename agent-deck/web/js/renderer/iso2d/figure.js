// People: cuboid figures built from `cub()`, per-state fx (typing, thinking dots, waiting glyph,
// idle zz, done flag, compacting particles, ctxWarn triangle, beam column), accessories and the
// hover/pin-card portrait. Ported from mockups/f-spaceship-deck.html drawFigure/drawChar/drawWarn/
// drawBeam/drawPortrait. All colour comes from `C` (iso2d/colors.js resolveColors output).
import { V, iso, cub, box, R, poly, drawGlyph, G, sh, withAlpha } from './primitives.js';

/** @typedef {import('../../../../shared/types.js').Agent} Agent */

const BASE_HZ = 14;

/** Glyph drawn `scale`× bigger per bit (the big amber "?" for `waiting`). */
function drawGlyphBig(x, y, g, c, scale) {
  const ctx = V.ctx, rx = Math.round(x), ry = Math.round(y);
  ctx.fillStyle = c;
  for (let r = 0; r < g.length; r++) { const row = g[r]; for (let k = 0; k < row.length; k++) if (row.charCodeAt(k) === 49) ctx.fillRect(rx + k * scale, ry + r * scale, scale, scale); }
}

/**
 * One figure at screen anchor (bx,by в art px, ground plane). Every part is a small shaded
 * cuboid via `cub()`. Draws four 1px outline offsets first, then the lit figure, mirroring the
 * mockup's cheap outline trick.
 * @param {number} bx @param {number} by
 * @param {Object} person Scene person (CONTRACTS §5): state, type, isLead, facing, ctxWarn...
 * @param {Object} C colour table from resolveColors()
 * @param {number} f frame counter (~timeMs/150)
 * @param {{seated:boolean, facing:string, walking:boolean, wf:number, outline?:string}} o
 * @returns {number} hy — screen y (art px) of the top of the head, used to place state fx
 */
export function drawFigure(bx, by, person, C, f, o) {
  const pal = C.figureOf(person), st = person.state, { seated, facing, walking, wf } = o;
  const axisI = facing === 'SW' || facing === 'NE';
  const front = facing === 'SW' ? 'L' : facing === 'SE' ? 'R' : null;
  const crown = !!(person.isLead || pal.crown);
  const draw = (mono) => {
    const c1 = (c) => (mono ? [mono, mono, mono] : sh(c));
    const skin = c1(C.skin), shirt = c1(pal.shirt), pants = c1(pal.pants), hair = c1(pal.hair), yellow = c1(C.hat), green = c1(C.cap);
    const K = (u, v, z, w, d, h, c) => cub(bx, by, u, v, z, w, d, h, c);
    if (!seated) {
      const l = walking ? wf : 0;
      if (axisI) { K(-4, -2, 0, 3, 3, 6 - l, pants); K(1, -2, 0, 3, 3, 5 + l, pants); }
      else { K(-2, -4, 0, 3, 3, 6 - l, pants); K(-2, 1, 0, 3, 3, 5 + l, pants); }
    }
    if (axisI) K(-4, -2, 6, 8, 4, 8, shirt); else K(-2, -4, 6, 4, 8, 8, shirt);
    const armPos = axisI ? [[-6, -1], [4, -1]] : [[-1, -6], [-1, 4]];
    if (st === 'working' && seated) {
      const o2 = f % 2;
      if (axisI) { K(-6, 1, 9, 2, 4, 2, shirt); K(4, 1, 9, 2, 4, 2, shirt); K(-6, 5, 8 + o2, 2, 2, 2, skin); K(4, 5, 9 - o2, 2, 2, 2, skin); }
      else { K(1, -6, 9, 4, 2, 2, shirt); K(1, 4, 9, 4, 2, 2, shirt); K(5, -6, 8 + o2, 2, 2, 2, skin); K(5, 4, 9 - o2, 2, 2, 2, skin); }
    } else if (st === 'waiting') {
      const [a1, a2] = armPos; // one arm straight up
      K(a1[0], a1[1], 6, 2, 2, 2, skin); K(a1[0], a1[1], 8, 2, 2, 6, shirt); K(a2[0], a2[1], 8, 2, 2, 12, shirt); K(a2[0], a2[1], 20, 2, 2, 2, skin);
    } else {
      const sw = walking ? wf : 0, [a1, a2] = armPos;
      K(a1[0], a1[1], 6 + sw, 2, 2, 2, skin); K(a1[0], a1[1], 8 + sw, 2, 2, 6, shirt); K(a2[0], a2[1], 7 - sw, 2, 2, 2, skin); K(a2[0], a2[1], 9 - sw, 2, 2, 6, shirt);
    }
    const hz = BASE_HZ + (st === 'thinking' ? (f % 4 < 2 ? 0 : -1) : 0) - (st === 'idle' ? 1 : 0);
    K(-3, -3, hz, 6, 6, 7, skin);
    K(-3, -3, hz + (front ? 5 : 3), 6, 6, front ? 3 : 5, hair); // fringe, or the back of the head
    if (pal.acc === 'hat') { K(-4, -4, hz + 7, 8, 8, 2, yellow); K(-3, -3, hz + 9, 6, 6, 3, yellow); }
    if (crown) {
      const gold = c1(C.gold);
      K(-4, -4, hz + 7, 8, 8, 2, gold); K(-4, -4, hz + 9, 2, 2, 2, gold); K(2, -4, hz + 9, 2, 2, 2, gold);
      K(-4, 2, hz + 9, 2, 2, 2, gold); K(2, 2, hz + 9, 2, 2, 2, gold); K(-1, -1, hz + 9, 2, 2, 3, gold);
    }
    if (pal.acc === 'cap') { // brim points toward facing
      K(-3, -3, hz + 7, 6, 6, 2, green);
      if (facing === 'SW') K(-3, 3, hz + 7, 6, 3, 1, green);
      else if (facing === 'SE') K(3, -3, hz + 7, 3, 6, 1, green);
      else if (facing === 'NE') K(-3, -6, hz + 7, 6, 3, 1, green);
      else K(-6, -3, hz + 7, 3, 6, 1, green);
    }
    if (!mono && front) { // surface details on the visible face only
      const eyeH = st === 'idle' ? 1 : 2;
      const F = front === 'L' ? (u, z) => [bx + u - 3, by + (u + 3) / 2 - z] : (v, z) => [bx + 3 - v, by + (3 + v) / 2 - z];
      for (const t of [-2, 1]) { const [x, y] = F(t, hz + 3 + eyeH); R(x, y, 1, eyeH, C.ink); }
      if (pal.acc === 'glasses') for (const t of [-3, -2, -1, 1, 2]) { const [x, y] = F(t, hz + 5); R(x, y, 1, 1, C.lens); }
      if (crown) { const J = front === 'L' ? (u, z) => [bx + u - 4, by + (u + 4) / 2 - z] : (v, z) => [bx + 4 - v, by + (4 + v) / 2 - z]; const [jx, jy] = J(0, hz + 9); R(jx, jy, 1, 1, C.jewel); }
      const T = front === 'L' ? (u, z) => [bx + u - 2, by + (u + 2) / 2 - z] : (v, z) => [bx + 2 - v, by + (2 + v) / 2 - z];
      if (pal.acc === 'tie') { const [x, y] = T(0, 14); R(x, y, 1, 4, C.tie); }
      if (pal.acc === 'badge') { const [x, y] = T(2, 13); R(x, y, 2, 2, C.tie); }
    }
    return by - hz - (crown ? 13 : 10);
  };
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ctx = V.ctx; ctx.save(); ctx.translate(ox, oy); draw(o.outline || C.outline); ctx.restore(); }
  return draw(null);
}

/** Warning triangle with a white "!" — reserved for `person.ctxWarn` (the `waiting` state gets the "?" glyph instead). */
export function drawWarn(cx, top, f, C) {
  const c = f % 2 ? C.states.compacting : C.states.waiting, W = [1, 3, 5, 5, 7, 7, 9];
  for (let r = 0; r < W.length; r++) R(cx - (W[r] - 1) / 2, top + r, W[r], 1, c);
  R(cx, top + 2, 1, 3, C.white); R(cx, top + 6, 1, 1, C.white);
}

/** Translucent cyan transporter column + rising particles for `person.beam`. */
export function drawBeam(person, C, f) {
  const { t, dir } = person.beam, env = Math.max(0.15, dir === 'out' ? t : 1 - t), z = person.z || 0;
  withAlpha(0.26 * (0.6 + 0.4 * Math.sin(f)) * env, () => box(person.pos.i - 0.35, person.pos.j - 0.35, 0.7, 0.7, z, 42, C.beam));
  for (let k = 0; k < 7; k++) {
    const ph = (f * 3 + k * 5) % 24, ang = (k / 7) * Math.PI * 2;
    const pp = iso(person.pos.i + Math.cos(ang) * 0.35, person.pos.j + Math.sin(ang) * 0.35, z + ph + 2);
    withAlpha((1 - ph / 24) * env, () => R(pp.x, pp.y, 1, 1, C.glass));
  }
}

/**
 * Full figure + ground shadow + hilite ring + per-state fx for one Scene person.
 * @param {Object} person @param {Object} C @param {number} f
 * @param {{selectedId:?string, hoverId:?string}} hilite
 * @returns {{bx:number, by:number, hy:number}} screen anchor (art px), reused by pick()
 */
export function drawChar(person, C, f, hilite) {
  const seated = !!person.seated, z = person.z || 0;
  const p = iso(person.pos.i, person.pos.j, z);
  const bx = Math.round(p.x), by = Math.round(p.y);
  const walking = person.state === 'joining' || person.state === 'leaving';
  const wf = Math.floor((person.walkT || 0) * 7) % 2;
  const facing = person.facing || 'SW';
  poly([bx, by - 4, bx + 9, by, bx, by + 4, bx - 9, by], C.shadow, 0.35);
  const selected = !!(hilite && hilite.selectedId === person.id), hovered = !!(hilite && hilite.hoverId === person.id);
  if (selected || hovered) poly([bx, by - 10, bx + 20, by, bx, by + 10, bx - 20, by], C.white, selected ? 0.22 + 0.18 * Math.sin(f) : 0.14);
  const hy = drawFigure(bx, by, person, C, f, { seated, facing, walking, wf, outline: (selected || hovered) ? C.white : C.outline });
  const st = person.state;
  if (st === 'thinking') { for (let k = 0; k < 3; k++) if ((f % 4) > k) R(bx + 9 + k * 2, hy - 2 - k, 1, 1, C.states.thinking); }
  else if (st === 'waiting') drawGlyphBig(bx + 10, hy - 20 + (f % 2) * 2, G['?'], C.states.waiting, 2);
  else if (st === 'idle') { for (let k = 0; k < 3; k++) { const ph = (f + k * 3) % 9; withAlpha(1 - ph / 9, () => drawGlyph(bx + 9 + k * 2, hy - 2 - ph - k * 2, G.z, C.starTint)); } }
  else if (st === 'compacting') { const c = f % 2 ? C.states.compacting : C.states.waiting; for (let k = 0; k < 3; k++) R(bx - 4 + k * 4, hy - 5 - ((f + k) % 3), 2, 2, c); }
  else if (st === 'done') { R(bx + 8, hy - 5, 8, 8, C.states.done); R(bx + 10, hy - 2, 1, 2, C.outline); R(bx + 11, hy - 1, 1, 1, C.outline); R(bx + 12, hy - 2, 1, 1, C.outline); R(bx + 13, hy - 3, 1, 1, C.outline); }
  if (person.ctxWarn && st !== 'compacting') drawWarn(bx, hy - 14 + (f % 2), f, C);
  if (person.beam) drawBeam(person, C, f);
  return { bx, by, hy };
}

/**
 * 84×120 preview: a standing front-left figure at 3× with a floor diamond. `ctx2d` is the target
 * 2D context (already sized 84×120 by the caller); this temporarily borrows the shared draw state.
 * @param {CanvasRenderingContext2D} ctx2d @param {Object} person @param {number} timeMs @param {Object} C
 */
export function drawPortrait(ctx2d, person, timeMs, C) {
  const prevCtx = V.ctx, prevOx = V.ox, prevOy = V.oy;
  V.ctx = ctx2d;
  ctx2d.setTransform(3, 0, 0, 3, 0, 0);
  ctx2d.imageSmoothingEnabled = false;
  R(0, 0, 28, 40, C.portraitBg);
  poly([14, 30, 27, 36.5, 14, 43, 1, 36.5], C.portraitFloor1);
  poly([14, 31, 25, 36.5, 14, 42, 3, 36.5], C.portraitFloor2);
  const f = Math.floor((timeMs || 0) / 150);
  drawFigure(14, 36, person, C, f, { seated: false, facing: 'SW', walking: false, wf: 0, outline: C.outline });
  V.ctx = prevCtx; V.ox = prevOx; V.oy = prevOy;
}

/**
 * Pure screen anchor for a person, without drawing — used by `pick()` so hit-testing does not
 * depend on having rendered this exact frame. Ignores the ±1px state bob `drawFigure` applies.
 * @param {Object} person @returns {{bx:number, by:number, hy:number}}
 */
export function figureAnchor(person) {
  const p = iso(person.pos.i, person.pos.j, person.z || 0);
  return { bx: p.x, by: p.y, hy: p.y - BASE_HZ - (person.isLead ? 13 : 10) };
}
