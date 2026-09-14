// iso2d renderer (CONTRACTS §6, ADR-0004): draws one Scene (§5) per frame. Owns the pixel-scale
// canvas transform, the camera's world-px origin, painter's-algorithm depth sorting, and hit
// testing. Everything else (walls/floor, figures, furniture) lives in room.js/figure.js/props.js.
import { V, isoX, isoY, R, withAlpha } from './primitives.js';
import { resolveColors } from './colors.js';
import { drawStars, drawWallWest, drawWallNorth, drawCornerPost, drawFloorTile, drawRoomBase, drawHallBase, drawPodBase, drawPodTile, drawPodNorth, drawGlassI, drawRailJ } from './room.js';
import { drawDesk, drawChair, drawCore, drawPlant, drawDispenser, drawPad, drawDoor, drawBoard, drawSign, drawTable, drawStool, drawLaptop } from './props.js';
import { drawChar, drawPortrait, figureAnchor } from './figure.js';

/** Base art-px canvas size and its projection origin, matching mockups/f-spaceship-deck.html. */
const ART_W = 480, ART_H = 284, ORIGIN0 = { x: 144, y: 52 };
/** Fixed aisle row (CONTRACTS §5 room is 11×9; layout.js's AISLE_J). */
const AISLE_J = 4;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Object} theme theme JSON (CONTRACTS §7)
 */
export function createIso2DRenderer(canvas, theme) {
  const ctx = canvas.getContext('2d');
  let C = resolveColors(theme);
  let cssW = canvas.width || ART_W, cssH = canvas.height || ART_H, pixelScale = 1;
  let ox0 = ORIGIN0.x, oy0 = ORIGIN0.y;
  let camX = 0, camY = 0, zoom = 1, scale = 1;

  function computeOrigin() {
    ox0 = ORIGIN0.x + (cssW / pixelScale - ART_W) / 2;
    oy0 = ORIGIN0.y + (cssH / pixelScale - ART_H) / 2;
  }
  computeOrigin();

  /** Point V (primitives.js) at the current camera/origin so isoX/isoY read the right offsets. */
  function setView() { V.ox = ox0 + camX; V.oy = oy0 + camY; }

  /**
   * @param {number} cssW css px @param {number} cssH css px @param {number} pixelScale integer 1..4
   */
  function resize(w, h, ps) {
    cssW = w; cssH = h; pixelScale = Math.max(1, Math.min(4, Math.round(ps) || 1));
    canvas.width = w; canvas.height = h;
    computeOrigin();
    scale = pixelScale * zoom;
  }

  /** @param {{x?:number, y?:number, zoom?:number}} cam world-px pan + zoom multiplier over pixelScale */
  function setCamera(cam) {
    if (!cam) return;
    if (typeof cam.x === 'number') camX = cam.x;
    if (typeof cam.y === 'number') camY = cam.y;
    if (typeof cam.zoom === 'number') zoom = cam.zoom;
    scale = pixelScale * zoom;
  }

  /** @param {{i:number, j:number, z?:number}} pos @returns {{x:number, y:number}} CSS px within the canvas */
  function project({ i, j, z }) {
    setView();
    return { x: isoX(i, j) * scale, y: isoY(i, j, z || 0) * scale };
  }

  /** @param {number} cssX @param {number} cssY @param {Object} scene @returns {?string} person id under the point, else null */
  function pick(cssX, cssY, scene) {
    if (!scene || !scene.people || !scene.people.length) return null;
    setView();
    const x = cssX / scale, y = cssY / scale;
    for (let k = scene.people.length - 1; k >= 0; k--) {
      const person = scene.people[k], a = figureAnchor(person);
      if (x >= a.bx - 10 && x <= a.bx + 10 && y >= a.hy - 4 && y <= a.by + 2) return person.id;
    }
    return null;
  }

  /** @param {CanvasRenderingContext2D} ctx2d @param {Object} person @param {number} timeMs */
  function portrait(ctx2d, person, timeMs) { drawPortrait(ctx2d, person, timeMs, C); }

  function destroy() {}

  /** @param {Object} scene Scene (CONTRACTS §5) @param {number} timeMs */
  function render(scene, timeMs) {
    if (!scene) return;
    setView(); V.ctx = ctx;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const f = Math.floor((timeMs || 0) / 150);
    const VW = Math.ceil(cssW / scale) + 1, VH = Math.ceil(cssH / scale) + 1;
    R(0, 0, VW, VH, C.bg);
    if (C.features.stars) drawStars(C, VW, VH);

    const H = scene.room.wallH;
    for (const w of scene.walls) {
      if (w.kind === 'north') withAlpha(w.alpha, () => drawWallNorth(w.i0, w.i1, H, C, f));
      else if (w.kind === 'west') withAlpha(w.alpha, () => drawWallWest(w.j0, w.j1, H, C));
    }
    drawCornerPost(H, C);
    for (const p of scene.props) {
      if (p.kind === 'door') withAlpha(p.alpha, () => drawDoor(p, C, f));
      else if (p.kind === 'board') withAlpha(p.alpha, () => drawBoard(p, C));
      else if (p.kind === 'sign') withAlpha(p.alpha, () => drawSign(p, C));
    }

    for (const t of scene.tiles) if (t.kind === 'floor' || t.kind === 'aisle') drawFloorTile(t, C);
    drawRoomBase(scene.room.w, scene.room.d, C);
    for (const t of scene.tiles) if (t.kind === 'hall') withAlpha(t.alpha, () => drawFloorTile(t, C));
    if (scene.hallway && scene.hallway.len > 0.01) drawHallBase(scene.room.w, AISLE_J, scene.hallway.len, C);
    for (const t of scene.tiles) if (t.kind === 'pod') withAlpha(t.alpha, () => drawPodTile(t.i, t.j, t.z || 0, C));
    for (const pod of scene.pods) if (pod.h > 0.01) withAlpha(pod.h, () => drawPodBase(pod.rect, pod.z || 0, C));
    for (const w of scene.walls) if (w.kind === 'podNorth') withAlpha(w.alpha, () => drawPodNorth(w.i0, w.i1, w.z || 0, H, C));

    // Painter's algorithm: everything that can occlude or be occluded by a figure, sorted by i+j
    // (CONTRACTS §6), each item's own alpha applied only while it draws.
    const items = [];
    for (const w of scene.walls) {
      if (w.kind === 'glassI') items.push({ d: w.i + (w.j0 + w.j1) / 2 + 0.5, a: w.alpha, fn: () => drawGlassI(w.i, w.j0, w.j1, w.z || 0, C) });
      else if (w.kind === 'railJ') items.push({ d: (w.i0 + w.i1) / 2 + w.j + 0.5, a: w.alpha, fn: () => drawRailJ(w.j, w.i0, w.i1, w.z || 0, C) });
    }
    for (const p of scene.props) {
      switch (p.kind) {
        case 'desk': items.push({ d: p.i + p.w / 2 + p.j + 0.5, a: p.alpha, fn: () => drawDesk(p, C, f) }); break;
        case 'chair': items.push({ d: p.i + p.j - 0.9, a: p.alpha, fn: () => drawChair(p, C) }); break;
        case 'core': items.push({ d: p.i + p.j + 0.4, a: p.alpha, fn: () => drawCore(p, C, f) }); break;
        case 'plant': items.push({ d: p.i + p.j, a: p.alpha, fn: () => drawPlant(p, C) }); break;
        case 'dispenser': items.push({ d: p.i + p.j, a: p.alpha, fn: () => drawDispenser(p, C, f) }); break;
        case 'pad': items.push({ d: p.i + p.j - 0.4, a: p.alpha, fn: () => drawPad(p, C, f) }); break;
        case 'table': items.push({ d: p.i + p.j, a: p.alpha, fn: () => drawTable(p, C) }); break;
        case 'stool': items.push({ d: p.i + p.j - 0.03, a: p.alpha, fn: () => drawStool(p, C) }); break;
        case 'laptop': items.push({ d: p.i + p.j + 0.6, a: p.alpha, fn: () => drawLaptop(p, C) }); break;
        default: break; // door/board/sign are wall-mounted, drawn above with the walls
      }
    }
    const hilite = scene.hilite || {};
    for (const person of scene.people) items.push({ d: person.pos.i + person.pos.j, a: person.alpha, fn: () => drawChar(person, C, f, hilite) });

    items.sort((x, y) => x.d - y.d);
    for (const it of items) withAlpha(it.a == null ? 1 : it.a, it.fn);
  }

  return { resize, setCamera, render, project, pick, portrait, destroy };
}
