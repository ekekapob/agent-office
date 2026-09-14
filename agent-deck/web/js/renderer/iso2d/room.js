// Room shell: star field, north/west walls with viewports, floor tiles, base faces, hallway, pod floors and pod walls.
import { R, quad, poly, tile, isoX, isoY, wallFaceN, wallFaceW, wallSegI, wallSegJ } from './primitives.js';

/** Background star field over the whole viewport (VW×VH art px). */
export function drawStars(C, VW, VH) {
  for (let k = 0; k < 26; k++) { const x = (k * 97 + 13) % VW, y = (k * 61 + 7) % VH; R(x, y, 1, 1, k % 5 ? C.starDim : C.starBright); }
}

/** West wall (i = 0) from j0 to j1: face, wainscot, trims and steel cap. H = wall height. */
export function drawWallWest(j0, j1, H, C) {
  wallFaceW(j0, j1, 0, H, C.wall); wallFaceW(j0, j1, 0, 9, C.wainscot); wallFaceW(j0, j1, 9, 10, C.trimDim); wallFaceW(j0, j1, 29, 30, C.trim);
  quad(isoX(0, j0), isoY(0, j0, H + 3), isoX(0, j1), isoY(0, j1, H + 3), isoX(0, j1), isoY(0, j1, H), isoX(0, j0), isoY(0, j0, H), C.steel2);
}

const WIN_STARS = [[0.2, 30], [0.55, 24], [0.8, 36], [1.3, 21], [1.6, 29], [0.4, 38], [1.9, 34], [1.1, 18]];
const PL = new Float64Array(28);

/** North wall (j = 0) from i0 to i1: face, wainscot, trims, steel cap and, when the theme says so, viewports onto space. */
export function drawWallNorth(i0, i1, H, C, f) {
  wallFaceN(i0, i1, 0, H, C.wall2); wallFaceN(i0, i1, 0, 9, C.wainscot); wallFaceN(i0, i1, 9, 10, C.trimDim); wallFaceN(i0, i1, 29, 30, C.trim);
  quad(isoX(i0, 0), isoY(i0, 0, H + 3), isoX(i1, 0), isoY(i1, 0, H + 3), isoX(i1, 0), isoY(i1, 0, H), isoX(i0, 0), isoY(i0, 0, H), C.steel1);
  if (C.features.viewports) {
    if (i0 <= 4.4 && i1 >= 6.6) viewport(4.4, 6.6, false, f, C);
    if (i0 <= 7.3 && i1 >= 9.5) viewport(7.3, 9.5, !!C.features.planet, f, C);
  }
}

function viewport(i0, i1, planet, f, C) {
  wallFaceN(i0 - 0.12, i1 + 0.12, 15, 41, C.steel1); wallFaceN(i0, i1, 16, 40, C.space);
  for (let k = 0; k < WIN_STARS.length; k++) {
    const u = WIN_STARS[k][0], z = WIN_STARS[k][1];
    if (u < i1 - i0) R(isoX(i0 + u, 0), isoY(i0 + u, 0, z), 1, 1, (f + k) % 7 === 0 ? C.starTint : C.white);
  }
  if (planet) {
    const ci = i0 + (i1 - i0) * 0.62, cx = isoX(ci, 0), cy = isoY(ci, 0, 26);
    for (let k = 0; k < 14; k++) { const t = k / 14 * Math.PI * 2; PL[2 * k] = cx + Math.cos(t) * 7.5; PL[2 * k + 1] = cy + Math.sin(t) * 7.5; }
    poly(PL, C.planet[0]);
    quad(cx - 7, cy - 1, cx + 7, cy - 1, cx + 7, cy + 1, cx - 7, cy + 1, C.planet[1]);
    quad(cx - 5, cy + 3, cx + 5, cy + 3, cx + 5, cy + 4, cx - 5, cy + 4, C.planet[2]);
  }
}

/** Dark post where the two walls meet. */
export function drawCornerPost(H, C) { R(isoX(0, 0) - 1, isoY(0, 0, H + 3), 2, H + 3, C.base2); }

/** One floor tile of kind floor | aisle | hall (checkerboard by i+j; aisle and hall share the lit colours). */
export function drawFloorTile(t, C) {
  const odd = (t.i + t.j) & 1;
  if (t.kind === 'floor') tile(t.i, t.j, odd ? C.floor1 : C.floor2, C.grout);
  else tile(t.i, t.j, odd ? C.aisle1 : C.aisle2, C.trimDim);
}

/** Dark base faces under the room's south and east edges (w×d tiles). */
export function drawRoomBase(w, d, C) { baseFaces(0, w, 0, d, 0, C.base1, C.base2); }

/** Base faces under the hallway: len tiles east of the room along row hallJ. */
export function drawHallBase(w, hallJ, len, C) { if (len > 0.01) baseFaces(w, w + len, hallJ, hallJ + 1, 0, C.base1, C.base2); }

/** Base faces under a pod rect {i0,i1,j0,j1}, lifted by zo. */
export function drawPodBase(r, zo, C) { baseFaces(r.i0, r.i1, r.j0, r.j1, zo, C.podBase1, C.podBase2); }

function baseFaces(i0, i1, j0, j1, zo, c1, c2) {
  const ax = isoX(i0, j1), ay = isoY(i0, j1, zo), bx = isoX(i1, j1), by = isoY(i1, j1, zo), cx = isoX(i1, j0), cy = isoY(i1, j0, zo);
  quad(ax, ay, bx, by, bx, by + 12, ax, ay + 12, c1);
  quad(bx, by, cx, cy, cx, cy + 12, bx, by + 12, c2);
}

/** Pod floor tile at lift zo. */
export function drawPodTile(i, j, zo, C) { tile(i, j, ((i + j) & 1) ? C.pod1 : C.pod2, C.podGrout, zo); }

/** Pod north wall (north-side bays only), lifted by zo. */
export function drawPodNorth(i0, i1, zo, H, C) {
  wallSegJ(0, i0, i1, 0, H, zo, C.wall2); wallSegJ(0, i0, i1, 0, 9, zo, C.wainscot);
  wallSegJ(0, i0, i1, 9, 10, zo, C.trimDim); wallSegJ(0, i0, i1, 29, 30, zo, C.trim);
  wallSegJ(0, i0, i1, H, H + 3, zo, C.steel1);
}

/** Full-height glass divider along j at column i: steel base, translucent glass, trim cap. */
export function drawGlassI(i, j0, j1, zo, C) {
  wallSegI(i, j0, j1, 0, 10, zo, C.steel2); wallSegI(i, j0, j1, 10, 40, zo, C.glass, 0.2); wallSegI(i, j0, j1, 40, 42, zo, C.trim);
}

/** Low rail along i at row j (the hallway side of a pod). */
export function drawRailJ(j, i0, i1, zo, C) { wallSegJ(j, i0, i1, 0, 9, zo, C.steel2); wallSegJ(j, i0, i1, 9, 10, zo, C.trim); }
