// iso2d primitives: projection, crisp scanline polygon fill, tiles, cuboids, cylinders, wall faces, glyphs, shading.
// Everything draws in "art px" into V.ctx, which the renderer sets up with a pixel-scale transform so each art px
// becomes an integer block of device pixels. Ported from mockups/f-spaceship-deck.html.

/** Shared view state: the 2D context being drawn into and the projection origin (art px, camera already added). */
export const V = { ctx: null, ox: 0, oy: 0 };

/** Tile footprint in art px: width and height of the floor diamond. */
export const TW = 32, TH = 16;

/** Screen x of a world tile position. @param {number} i @param {number} j */
export function isoX(i, j) { return V.ox + (i - j) * (TW / 2); }
/** Screen y of a world tile position at height z (art px). @param {number} i @param {number} j @param {number} [z] */
export function isoY(i, j, z = 0) { return V.oy + (i + j) * (TH / 2) - z; }
/** World → screen point. @returns {{x:number,y:number}} */
export function iso(i, j, z = 0) { return { x: isoX(i, j), y: isoY(i, j, z) }; }

const XS = new Float64Array(64);

/**
 * Crisp scanline polygon fill: every row is a run of whole pixels, so shapes stay pixel-art sharp at any scale.
 * @param {ArrayLike<number>} pts flat [x0,y0,x1,y1,...] in art px
 * @param {string} color CSS colour
 * @param {number} [alpha] extra opacity, multiplied with the current globalAlpha and restored afterwards
 */
export function poly(pts, color, alpha) {
  const ctx = V.ctx, n = pts.length >> 1;
  let prev = 1;
  if (alpha !== undefined) { prev = ctx.globalAlpha; ctx.globalAlpha = prev * alpha; }
  ctx.fillStyle = color;
  let minY = Infinity, maxY = -Infinity;
  for (let k = 1; k < pts.length; k += 2) { const y = pts[k]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  minY = Math.floor(minY); maxY = Math.ceil(maxY);
  for (let y = minY; y < maxY; y++) {
    const cy = y + 0.5;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const k2 = k + 1 === n ? 0 : k + 1;
      const x1 = pts[2 * k], y1 = pts[2 * k + 1], x2 = pts[2 * k2], y2 = pts[2 * k2 + 1];
      if ((cy >= y1 && cy < y2) || (cy >= y2 && cy < y1)) XS[m++] = x1 + (cy - y1) * (x2 - x1) / (y2 - y1);
    }
    for (let a = 1; a < m; a++) { const v = XS[a]; let b = a - 1; while (b >= 0 && XS[b] > v) { XS[b + 1] = XS[b]; b--; } XS[b + 1] = v; }
    for (let k = 0; k + 1 < m; k += 2) { const x0 = Math.round(XS[k]), x1 = Math.round(XS[k + 1]); if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, 1); }
  }
  if (alpha !== undefined) ctx.globalAlpha = prev;
}

const Q = new Float64Array(8);
/** Four-point polygon without allocating. */
export function quad(x0, y0, x1, y1, x2, y2, x3, y3, color, alpha) {
  Q[0] = x0; Q[1] = y0; Q[2] = x1; Q[3] = y1; Q[4] = x2; Q[5] = y2; Q[6] = x3; Q[7] = y3;
  poly(Q, color, alpha);
}

/** Axis-aligned rectangle snapped to whole art px. */
export function R(x, y, w, h, c) { const ctx = V.ctx; ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }

/** Rectangle drawn at a fraction of the current opacity (restored afterwards). */
export function fadeR(x, y, w, h, c, a) { const ctx = V.ctx, g = ctx.globalAlpha; ctx.globalAlpha = g * a; R(x, y, w, h, c); ctx.globalAlpha = g; }

/** Run fn with the opacity multiplied by a, then restore it. */
export function withAlpha(a, fn) { const ctx = V.ctx, g = ctx.globalAlpha; ctx.globalAlpha = g * a; fn(); ctx.globalAlpha = g; }

/**
 * Floor tile (i,j)→(i+1,j+1) as a diamond, with an optional 1 px grout border, at height z.
 */
export function tile(i, j, c, grout, z = 0) {
  const x = isoX(i, j), y = isoY(i, j, z);
  if (grout) quad(x, y, x + 16, y + 8, x, y + 16, x - 16, y + 8, grout);
  quad(x, y + 1, x + 14, y + 8, x, y + 15, x - 14, y + 8, c);
}

/**
 * World-space cuboid: corner (i,j), extents w (along i) and d (along j), base height z, height h.
 * @param {string[]} cols [top,left,right]
 */
export function box(i, j, w, d, z, h, cols) {
  const ax = isoX(i, j), ay = isoY(i, j, z + h);
  const bx = isoX(i + w, j), by = isoY(i + w, j, z + h);
  const cx = isoX(i + w, j + d), cy = isoY(i + w, j + d, z + h);
  const dx = isoX(i, j + d), dy = isoY(i, j + d, z + h);
  quad(dx, dy, cx, cy, cx, cy + h, dx, dy + h, cols[1]);
  quad(bx, by, cx, cy, cx, cy + h, bx, by + h, cols[2]);
  quad(ax, ay, bx, by, cx, cy, dx, dy, cols[0]);
}

/**
 * Screen-anchored cuboid used for figure parts: offsets u (along i), v (along j), z (up) in iso px from the anchor
 * (x0,y0); w,d,h are its extents. Same projection as the furniture, so people sit correctly among it.
 * @param {string[]} cols [top,left,right]
 */
export function cub(x0, y0, u, v, z, w, d, h, cols) {
  const fx = x0 + (u + w) - (v + d), fy = y0 + (u + w + v + d) / 2 - z;
  quad(fx, fy, fx - w, fy - w / 2, fx - w, fy - w / 2 - h, fx, fy - h, cols[1]);
  quad(fx, fy, fx + d, fy - d / 2, fx + d, fy - d / 2 - h, fx, fy - h, cols[2]);
  quad(fx, fy - h, fx + d, fy - d / 2 - h, fx + d - w, fy - d / 2 - w / 2 - h, fx - w, fy - w / 2 - h, cols[0]);
}

/** Vertical wall segment along j at column i, from height z0 to z1, lifted by zo (pods rise). */
export function wallSegI(i, j0, j1, z0, z1, zo, col, alpha) {
  quad(isoX(i, j0), isoY(i, j0, z1 + zo), isoX(i, j1), isoY(i, j1, z1 + zo), isoX(i, j1), isoY(i, j1, z0 + zo), isoX(i, j0), isoY(i, j0, z0 + zo), col, alpha);
}
/** Vertical wall segment along i at row j, from height z0 to z1, lifted by zo. */
export function wallSegJ(j, i0, i1, z0, z1, zo, col, alpha) {
  quad(isoX(i0, j), isoY(i0, j, z1 + zo), isoX(i1, j), isoY(i1, j, z1 + zo), isoX(i1, j), isoY(i1, j, z0 + zo), isoX(i0, j), isoY(i0, j, z0 + zo), col, alpha);
}
/** Face on the north wall (j = 0). */
export function wallFaceN(i0, i1, z0, z1, c, alpha) { wallSegJ(0, i0, i1, z0, z1, 0, c, alpha); }
/** Face on the west wall (i = 0). */
export function wallFaceW(j0, j1, z0, z1, c, alpha) { wallSegI(0, j0, j1, z0, z1, 0, c, alpha); }

const N_ELL = 16, COS = new Float64Array(N_ELL), SIN = new Float64Array(N_ELL);
for (let k = 0; k < N_ELL; k++) { const t = k / N_ELL * Math.PI * 2; COS[k] = Math.cos(t); SIN[k] = Math.sin(t); }
const ELO = new Float64Array(N_ELL * 2), EHI = new Float64Array(N_ELL * 2);

/** Fills `out` (length 32) with the 16 screen points of a world-space circle of radius r at height z. */
export function ellipsePts(i, j, r, z, out = ELO) {
  for (let k = 0; k < N_ELL; k++) { const ci = i + COS[k] * r, cj = j + SIN[k] * r; out[2 * k] = isoX(ci, cj); out[2 * k + 1] = isoY(ci, cj, z); }
  return out;
}
/** Filled world-space ellipse (a circle on the floor plane). */
export function ellipse(i, j, r, z, color, alpha) { poly(ellipsePts(i, j, r, z, ELO), color, alpha); }

/** World-space cylinder: centre (i,j), radius r, base z, height h. @param {string[]} cols [top,left,right] */
export function cyl(i, j, r, z, h, cols) {
  const lo = ellipsePts(i, j, r, z, ELO), hi = ellipsePts(i, j, r, z + h, EHI), pcx = isoX(i, j), pcy = isoY(i, j, z);
  for (let k = 0; k < N_ELL; k++) {
    const k2 = (k + 1) & (N_ELL - 1);
    const x1 = lo[2 * k], y1 = lo[2 * k + 1], x2 = lo[2 * k2], y2 = lo[2 * k2 + 1];
    if ((y1 + y2) / 2 > pcy) quad(x1, y1, x2, y2, hi[2 * k2], hi[2 * k2 + 1], hi[2 * k], hi[2 * k + 1], (x1 + x2) / 2 < pcx ? cols[1] : cols[2]);
  }
  poly(hi, cols[0]);
}

/** 1-bit glyphs as rows of '0'/'1'. */
export const G = {
  '!': ['11', '11', '11', '11', '00', '11'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  z: ['111', '001', '010', '100', '111'],
  dot: ['1'],
};
/** Draws a glyph with its top-left at (x,y). */
export function drawGlyph(x, y, g, c) {
  const ctx = V.ctx; ctx.fillStyle = c; const rx = Math.round(x), ry = Math.round(y);
  for (let r = 0; r < g.length; r++) { const row = g[r]; for (let k = 0; k < row.length; k++) if (row.charCodeAt(k) === 49) ctx.fillRect(rx + k, ry + r, 1, 1); }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
const H = (r, g, b) => '#' + ((cl(r) << 16) | (cl(g) << 8) | cl(b)).toString(16).padStart(6, '0');
/** Splits a #rrggbb colour into [r,g,b]; null when malformed. */
export function rgb(hex) { if (!HEX.test(hex)) return null; const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
/** Lit top / base left / dark right faces from one base colour: [top,left,right]. Pure shading maths. */
export function shade(hex) {
  const c = rgb(hex); if (!c) return [hex, hex, hex];
  const [r, g, b] = c;
  return [H(r * 1.15 + 22, g * 1.15 + 22, b * 1.15 + 22), hex, H(r * 0.6, g * 0.6, b * 0.6)];
}
const SHC = new Map();
/** Cached shade(). */
export function sh(c) { let v = SHC.get(c); if (!v) { v = shade(c); SHC.set(c, v); } return v; }
/** Darkens (k<1) or lightens (k>1) a colour by a factor. */
export function dim(hex, k) { const c = rgb(hex); return c ? H(c[0] * k, c[1] * k, c[2] * k) : hex; }
