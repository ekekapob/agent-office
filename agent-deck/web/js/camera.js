// Camera: pan, stepped zoom about a point, glide, fit, fullscreen. Renderer-independent
// (ADR-0004); talks to the renderer only through setCamera() and resize().
// State: x,y = pan offset in world art px; zoom = absolute scale S shown on the chip
// (steps 1…5); pixelScale = integer base scale S0 from the stage size. The renderer
// receives setCamera({x, y, zoom: S / S0}) so that pixelScale × zoom = S (CONTRACTS §6).

const ZOOMS = [1, 1.5, 2, 2.5, 3, 4, 5];
const WHEEL_STEP = 40;
const IGNORE = '.viewctl, .podlist, .hcard, .bub';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isTyping = (t) => !!t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable);

/**
 * @param {{stage:HTMLElement, canvas:HTMLCanvasElement, renderer:{resize:Function,setCamera:Function,project?:Function}, artW?:number, artH?:number}} opts
 * @returns {{getState:()=>{x:number,y:number,zoom:number,pixelScale:number,fullscreen:boolean,cssW:number,cssH:number}, pan:(dx:number,dy:number)=>void, zoomStep:(dir:number,cssX?:number,cssY?:number)=>void, setZoom:(z:number,cssX?:number,cssY?:number)=>void, glideTo:(t:{x?:number,y?:number,zoom?:number})=>void, fit:()=>void, toggleFullscreen:()=>void, onChange:(fn:Function)=>()=>void, centerOn:(tile:{i:number,j:number,z?:number}, zoom?:number)=>void, suppressClick:()=>boolean, destroy:()=>void}}
 */
export function createCamera({ stage, canvas, renderer, artW = 480, artH = 284 }) {
  const doc = stage.ownerDocument, win = doc.defaultView;
  const $ = (id) => stage.querySelector('#' + id) || doc.getElementById(id);
  let x = 0, y = 0, S = 2, S0 = 2, cssW = artW * 2, cssH = artH * 2;
  let target = null, raf = 0, lastT = 0, drag = null, justDragged = false, wheelAcc = 0, pinch = null;
  const listeners = new Set(), offs = [];
  const on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); offs.push(() => el.removeEventListener(ev, fn, o)); };

  const isFull = () => doc.fullscreenElement === stage || stage.classList.contains('max');
  function getState() { return { x, y, zoom: S, pixelScale: S0, fullscreen: isFull(), cssW, cssH }; }
  function push() {
    try { renderer.setCamera({ x, y, zoom: S / S0 }); } catch (err) { console.error('[camera] setCamera failed', err); }
    const chip = $('zoomchip'); if (chip) chip.textContent = (Math.round(S * 10) / 10) + '×';
    stage.style.setProperty('--zs', clamp(S / S0, 0.7, 1.35).toFixed(2));
    const st = getState();
    for (const fn of listeners) { try { fn(st); } catch (err) { console.error('[camera] onChange failed', err); } }
  }
  /** Pan by a delta in world art px. */
  function pan(dx, dy) { target = null; x = clamp(x + dx, -artW * 1.6, artW * 1.6); y = clamp(y + dy, -artH * 1.6, artH * 1.6); push(); }
  /** Set an absolute zoom step, keeping the CSS point (cssX, cssY) fixed (defaults to the canvas centre). */
  function setZoom(z, cssX, cssY) {
    target = null;
    const ns = clamp(z, ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
    if (ns === S) return;
    if (cssX === undefined || cssY === undefined) { cssX = cssW / 2; cssY = cssH / 2; }
    x += cssX * (1 / ns - 1 / S); y += cssY * (1 / ns - 1 / S); S = ns;
    push();
  }
  /** Zoom one step in (dir > 0) or out (dir < 0). */
  function zoomStep(dir, cssX, cssY) {
    let ni;
    if (dir > 0) { ni = ZOOMS.findIndex((z) => z > S + 1e-9); if (ni < 0) ni = ZOOMS.length - 1; }
    else { ni = ZOOMS.length - 1; while (ni > 0 && ZOOMS[ni] >= S - 1e-9) ni--; }
    setZoom(ZOOMS[ni], cssX, cssY);
  }
  function tick(t) {
    raf = 0;
    if (!target) return;
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 1 / 60; lastT = t;
    const k = Math.min(1, dt * 6);
    x += (target.x - x) * k; y += (target.y - y) * k; S += (target.zoom - S) * k;
    if (Math.abs(target.x - x) < 0.3 && Math.abs(target.y - y) < 0.3 && Math.abs(target.zoom - S) < 0.01) { x = target.x; y = target.y; S = target.zoom; target = null; }
    push();
    if (target) raf = win.requestAnimationFrame(tick);
  }
  /** Ease the camera to a pan/zoom (missing keys keep their current value). */
  function glideTo(t) {
    target = { x: t.x ?? x, y: t.y ?? y, zoom: clamp(t.zoom ?? S, ZOOMS[0], ZOOMS[ZOOMS.length - 1]) };
    lastT = 0;
    // No animation frames run while the tab is hidden, so easing there would strand the camera.
    if (typeof win.requestAnimationFrame !== 'function' || doc.hidden) { x = target.x; y = target.y; S = target.zoom; target = null; push(); return; }
    if (!raf) raf = win.requestAnimationFrame(tick);
  }
  /**
   * Glide so the tile lands on the canvas centre. Uses renderer.project() so no
   * knowledge of the renderer's origin is needed: CAMnew = css/2/ns − p/S + CAM.
   */
  function centerOn(tile, zoom) {
    if (typeof renderer.project !== 'function') return;
    let p; try { p = renderer.project({ i: tile.i, j: tile.j, z: tile.z || 0 }); } catch (_) { return; }
    if (!p) return;
    const ns = clamp(zoom ?? Math.max(S0, 2.5), ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
    glideTo({ x: cssW / 2 / ns - p.x / S + x, y: cssH / 2 / ns - p.y / S + y, zoom: ns });
  }
  /** Recompute the integer pixel scale from the stage size, reset pan/zoom, resize the renderer. */
  function fit() {
    target = null;
    if (isFull()) { const w = stage.clientWidth || cssW, h = stage.clientHeight || cssH; S0 = clamp(Math.floor(Math.min(w / artW, h / artH)), 1, 4); cssW = w; cssH = h; }
    else { const host = stage.parentElement || stage; const w = (host.clientWidth || artW + 40) - 40; S0 = clamp(Math.floor(w / artW), 1, 3); cssW = artW * S0; cssH = artH * S0; }
    S = S0; x = 0; y = 0;
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    try { renderer.resize(cssW, cssH, S0); } catch (err) { console.error('[camera] resize failed', err); }
    push();
  }
  function onFullChange() {
    const full = isFull(), fs = $('fs');
    if (fs) fs.textContent = full ? '⛶ exit full screen' : '⛶ full screen';
    setTimeout(fit, 60);
  }
  /** Fullscreen API on the stage, with a fixed-position `.max` fallback. */
  function toggleFullscreen() {
    if (doc.fullscreenElement) { doc.exitFullscreen().catch(() => {}); return; }
    if (stage.classList.contains('max')) { stage.classList.remove('max'); onFullChange(); return; }
    const fallback = () => { stage.classList.add('max'); onFullChange(); };
    if (stage.requestFullscreen) stage.requestFullscreen().catch(fallback); else fallback();
  }
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { cx: e.clientX - r.left, cy: e.clientY - r.top }; };

  // drag to pan (mouse)
  on(stage, 'mousedown', (e) => { if (e.button !== 0 || (e.target.closest && e.target.closest(IGNORE))) return; target = null; drag = { x: e.clientX, y: e.clientY, cx: x, cy: y, moved: false }; });
  on(win, 'mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved) { if (Math.hypot(dx, dy) < 4) return; drag.moved = true; canvas.style.cursor = 'grabbing'; stage.classList.add('dragging'); }
    x = clamp(drag.cx + dx / S, -artW * 1.6, artW * 1.6); y = clamp(drag.cy + dy / S, -artH * 1.6, artH * 1.6);
    push(); e.preventDefault();
  });
  on(win, 'mouseup', () => { if (drag && drag.moved) { justDragged = true; setTimeout(() => { justDragged = false; }, 0); } drag = null; canvas.style.cursor = 'grab'; stage.classList.remove('dragging'); });
  // touch: one finger pans, two fingers pinch in steps about the midpoint
  on(stage, 'touchstart', (e) => {
    if (e.target.closest && e.target.closest(IGNORE)) return;
    if (e.touches.length === 1) { const t = e.touches[0]; drag = { x: t.clientX, y: t.clientY, cx: x, cy: y, moved: false }; pinch = null; }
    else if (e.touches.length === 2) { drag = null; pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) }; }
  }, { passive: true });
  on(stage, 'touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      const [a, b] = e.touches, d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), ratio = d / pinch.d;
      if (ratio > 1.25 || ratio < 0.8) { const m = local({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }); zoomStep(ratio > 1 ? 1 : -1, m.cx, m.cy); pinch.d = d; }
      e.preventDefault(); return;
    }
    if (!drag || e.touches.length !== 1) return;
    const t = e.touches[0], dx = t.clientX - drag.x, dy = t.clientY - drag.y;
    if (!drag.moved) { if (Math.hypot(dx, dy) < 4) return; drag.moved = true; }
    x = clamp(drag.cx + dx / S, -artW * 1.6, artW * 1.6); y = clamp(drag.cy + dy / S, -artH * 1.6, artH * 1.6);
    push(); e.preventDefault();
  }, { passive: false });
  on(stage, 'touchend', () => { if (drag && drag.moved) { justDragged = true; setTimeout(() => { justDragged = false; }, 0); } drag = null; pinch = null; });
  // wheel zoom with 40-delta accumulation, about the cursor
  on(stage, 'wheel', (e) => {
    if (e.target.closest && e.target.closest('.podlist, .hcard')) return;
    e.preventDefault(); wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < WHEEL_STEP) return;
    const m = local(e); zoomStep(wheelAcc > 0 ? -1 : 1, m.cx, m.cy); wheelAcc = 0;
  }, { passive: false });
  // buttons + keys
  const zin = $('zin'), zout = $('zout'), rec = $('recenter'), fs = $('fs');
  if (zin) on(zin, 'click', () => zoomStep(1));
  if (zout) on(zout, 'click', () => zoomStep(-1));
  if (rec) on(rec, 'click', () => glideTo({ x: 0, y: 0, zoom: S0 }));
  if (fs) on(fs, 'click', toggleFullscreen);
  on(doc, 'keydown', (e) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomStep(1);
    else if (e.key === '-' || e.key === '_') zoomStep(-1);
    else if (e.key === '0') glideTo({ x: 0, y: 0, zoom: S0 });
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 'Escape' && stage.classList.contains('max')) { stage.classList.remove('max'); onFullChange(); }
  });
  on(doc, 'fullscreenchange', onFullChange);
  on(win, 'resize', fit);
  canvas.style.cursor = 'grab';
  fit();

  return {
    getState, pan, zoomStep, setZoom, glideTo, fit, toggleFullscreen, centerOn,
    /** Subscribe to camera changes; returns an unsubscribe function. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** True for the click that ends a drag, so callers can ignore it. */
    suppressClick: () => justDragged,
    destroy() { for (const off of offs) off(); offs.length = 0; listeners.clear(); if (raf) win.cancelAnimationFrame(raf); },
  };
}
