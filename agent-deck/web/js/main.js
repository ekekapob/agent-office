// Entry point: wires theme, store, stream, layout, renderer, camera, overlays,
// rooms list, panel and the error reporter. Robust to missing sibling modules
// (renderer/overlays/rooms/panel): each is reported through errors.js and stubbed.
import { createStore } from './store.js';
import { connect } from './stream.js';
import { createLayout } from './layout.js';
import { createCamera } from './camera.js';
import { loadTheme } from './theme.js';
import { installErrorReporter } from './errors.js';

const ART_W = 480, ART_H = 284;
const THEMES = [{ name: 'spaceship', label: 'Spaceship deck' }, { name: 'office', label: 'Office' }];
const STATUS_RANK = { waiting: 0, busy: 1, idle: 2, stale: 3, unreadable: 4 };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => { const d = Math.max(0, Date.now() - t) / 1000; return d < 60 ? Math.floor(d) + ' s' : d < 3600 ? Math.floor(d / 60) + ' min' : Math.floor(d / 3600) + ' h ' + Math.floor(d % 3600 / 60) + ' min'; };

const errors = installErrorReporter({ errbar: $('errbar'), diag: $('diag') });

/** Import a sibling module owned by another builder; report instead of dying when absent. */
async function optional(path, what) {
  try { return await import(path); } catch (err) { errors.report(`${what} module is missing or broken (${path})`, err && err.message); return null; }
}
/** No-op renderer so the camera, overlays and loop keep running without one. */
function stubRenderer(canvas) {
  return { resize(w, h) { canvas.width = w; canvas.height = h; }, setCamera() {}, render() {}, project() { return { x: 0, y: 0 }; }, pick() { return null; }, portrait() {}, destroy() {} };
}
function readHash() {
  const out = {};
  for (const part of location.hash.slice(1).split(/[&;]/)) { const [k, v] = part.split('='); if (k) out[k] = decodeURIComponent(v || ''); }
  return out;
}
function writeHash(patch) {
  const cur = { ...readHash(), ...patch };
  const s = Object.entries(cur).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
}
function dotClass(status) { return status === 'busy' ? 'busy' : status === 'waiting' ? 'waiting' : status === 'unreadable' ? 'bad' : status === 'stale' ? 'stale' : 'idle'; }

async function boot() {
  const store = createStore();
  const layout = createLayout();
  const canvas = $('cv'), stage = $('stage');
  const hash = readHash();
  let storedTheme = null; try { storedTheme = localStorage.getItem('agentdeck.theme'); } catch (_) { /* private mode */ }
  let theme = await loadTheme(hash.theme || storedTheme || 'spaceship');
  if (theme.loadError) errors.report(theme.loadError);
  store.setUI({ theme: theme.name, sessionId: hash.session || null, selectedId: hash.pin || null });
  document.title = 'Agent Deck';

  const [rendMod, ovMod, roomsMod, panelMod] = await Promise.all([
    optional('./renderer/index.js', 'renderer'), optional('./overlays.js', 'overlays'), optional('./rooms.js', 'rooms list'), optional('./panel.js', 'panel')]);

  // renderer behind a forwarding shim so camera/overlays survive a theme swap
  let renderer = null;
  function makeRenderer() {
    let r = null;
    if (rendMod && typeof rendMod.createRenderer === 'function') {
      try { r = rendMod.createRenderer('iso2d', canvas, theme); } catch (err) { errors.report('createRenderer failed', err && err.message); }
    }
    return r || stubRenderer(canvas);
  }
  renderer = makeRenderer();
  const rshim = {
    resize: (...a) => renderer.resize(...a), setCamera: (...a) => renderer.setCamera(...a), render: (...a) => renderer.render(...a),
    project: (...a) => renderer.project(...a), pick: (...a) => renderer.pick(...a), portrait: (...a) => renderer.portrait(...a), destroy() {},
  };
  const camera = createCamera({ stage, canvas, renderer: rshim, artW: ART_W, artH: ART_H });

  let lastScene = null, overlays = null, rooms = null;
  // Debug hook (CONTRACTS §11): current scene each frame, used by tools/smoke.mjs.
  window.__agentdeck = { store, get scene() { return lastScene; }, get renderer() { return renderer; }, get camera() { return camera; } };
  function select(id) {
    const cur = store.getUI().selectedId, next = id && cur !== id ? id : null;
    store.setUI({ selectedId: next });
    writeHash({ pin: next || '' });
  }
  const hover = (id) => { if (store.getUI().hoverId !== (id || null)) store.setUI({ hoverId: id || null }); };
  function focusRoom(id) {
    const roomId = id || 'deck';
    store.setUI({ focusRoomId: roomId });
    if (roomId === 'deck') { camera.glideTo({ x: 0, y: 0, zoom: camera.getState().pixelScale }); return; }
    const pod = lastScene && lastScene.pods.find((p) => p.id === roomId || 'pod' + p.n === roomId || String(p.n) === roomId);
    if (pod) camera.centerOn({ i: pod.tableAt.i, j: pod.tableAt.j, z: 8 }, Math.max(camera.getState().pixelScale, 2.5));
  }
  function makeOverlays() {
    if (overlays) { try { overlays.destroy(); } catch (err) { errors.report('overlays.destroy failed', err && err.message); } overlays = null; }
    if (ovMod && typeof ovMod.createOverlays === 'function') {
      try { overlays = ovMod.createOverlays({ container: $('ov'), renderer: rshim, theme, store, onSelect: select, onHover: hover }); }
      catch (err) { errors.report('createOverlays failed', err && err.message); }
    }
  }
  makeOverlays();
  if (roomsMod && typeof roomsMod.createRoomsList === 'function') {
    try { rooms = roomsMod.createRoomsList($('podlist'), { onFocus: focusRoom }); } catch (err) { errors.report('createRoomsList failed', err && err.message); }
  }
  camera.onChange((st) => { if (overlays && typeof overlays.setZoomScale === 'function') { try { overlays.setZoomScale(Math.max(0.7, Math.min(1.35, st.zoom / st.pixelScale))); } catch (_) { /* reported by loop */ } } });

  // ---- frame loop: layout → renderer → overlays → rooms (guarded, always rescheduled)
  const frame = errors.wrap(() => {
    const now = Date.now(), state = store.getState(), ui = store.getUI();
    lastScene = layout.update(state, ui, now);
    renderer.render(lastScene, now);
    if (overlays) overlays.update(lastScene, state, ui);
    if (rooms) rooms.update(state, lastScene, ui);
  }, 'render loop');
  (function loop() { frame(); requestAnimationFrame(loop); })();

  // ---- panel + tabs + top stats, throttled to 100 ms on store changes
  const panelEl = $('panel');
  const renderPanel = errors.wrap(() => {
    const state = store.getState(), ui = store.getUI();
    if (panelMod && typeof panelMod.renderPanel === 'function') panelMod.renderPanel(panelEl, state, ui, { theme, onSelect: select, onFocusRoom: focusRoom });
    else if (!panelEl.dataset.stub) { panelEl.dataset.stub = '1'; panelEl.innerHTML = '<div class="card"><h3>Panel</h3><p class="muted small">panel.js is not available yet.</p></div>'; }
  }, 'panel');
  const renderTabs = errors.wrap(() => {
    const state = store.getState(), ui = store.getUI();
    const sessions = Object.values(state.sessions).sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const counts = {}; for (const a of Object.values(state.agents)) counts[a.sessionId] = (counts[a.sessionId] || 0) + 1;
    // Two sessions in one folder get the same name. Add the pid so the tabs can be told apart.
    const seen = {}; for (const s of sessions) seen[s.name || ''] = (seen[s.name || ''] || 0) + 1;
    const label = (s) => {
      const base = s.name || s.id.slice(0, 8);
      return seen[s.name || ''] > 1 ? `${base} · ${s.pid || s.id.slice(0, 4)}` : base;
    };
    $('tabs').innerHTML = sessions.length
      ? sessions.map((s) => `<button data-id="${esc(s.id)}" class="${s.id === ui.sessionId ? 'on' : ''}" title="${esc(s.cwd || '')}${s.branch ? ' · ' + esc(s.branch) : ''} · started ${new Date(s.startedAt || 0).toTimeString().slice(0, 5)} · ${esc(s.id)}"><span class="dot ${dotClass(s.status)}"></span>${esc(label(s))}<small>${counts[s.id] || 0}</small></button>`).join('')
      : '<span class="muted small">no Claude Code sessions seen yet</span>';
    const sid = ui.sessionId, agents = Object.values(state.agents).filter((a) => a.sessionId === sid);
    const huddles = Object.values(state.huddles).filter((h) => h.sessionId === sid && h.status === 'open').length;
    const waiting = agents.filter((a) => a.state === 'waiting').length;
    const ctx = Object.values(state.alerts).find((al) => al.sessionId === sid && al.kind === 'context');
    $('topstats').innerHTML = `<b>${agents.length}</b> agent${agents.length === 1 ? '' : 's'} on deck${huddles ? ` · <b>${huddles}</b> huddle${huddles > 1 ? 's' : ''}` : ''}${waiting ? ` <span class="warn">· <b>${waiting}</b> need${waiting > 1 ? '' : 's'} approval</span>` : ''}${ctx ? ` <b class="hot">▲ ${esc(ctx.text)}</b>` : ''}`;
    const s = state.sessions[sid];
    // A hidden tab still has to shout: anything waiting anywhere goes in the title (FR-23), because a
    // background tab draws nothing and the title bar is all the reader can see.
    const alerts = Object.values(state.alerts);
    const needsYou = alerts.filter((al) => al.kind === 'approval').length
      || Object.values(state.agents).filter((a) => a.state === 'waiting').length;
    const ctxHot = alerts.some((al) => al.kind === 'context');
    const badge = needsYou ? `(${needsYou}) approval · ` : ctxHot ? '▲ context · ' : '';
    document.title = badge + (s ? `Agent Deck · ${s.name}` : 'Agent Deck');
  }, 'tabs');
  let panelTimer = 0;
  function schedulePanel() { if (panelTimer) return; panelTimer = setTimeout(() => { panelTimer = 0; renderTabs(); renderPanel(); }, 100); }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) selectSession(b.dataset.id); });
  function selectSession(id) {
    if (store.getUI().sessionId === id) return;
    store.setUI({ sessionId: id, selectedId: null, focusRoomId: 'deck' });
    writeHash({ session: id, pin: '' });
    camera.glideTo({ x: 0, y: 0, zoom: camera.getState().pixelScale });
  }
  /** Keep ui.sessionId pointing at a real session: the hash's, else the most urgent, most recent one. */
  function ensureSession() {
    const state = store.getState(), ui = store.getUI(), ids = Object.keys(state.sessions);
    if (!ids.length || (ui.sessionId && state.sessions[ui.sessionId])) return;
    const want = readHash().session;
    const pick = want && state.sessions[want] ? want : Object.values(state.sessions).sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (b.updatedAt || 0) - (a.updatedAt || 0))[0].id;
    store.setUI({ sessionId: pick });
    writeHash({ session: pick });
  }
  let pinPending = hash.pin || null;
  store.subscribe((state, ev) => {
    if (ev && ev.type === 'ui' && ev.data && Object.keys(ev.data).every((k) => k === 'hoverId')) return; // hover is a scene concern only
    if (ev && ev.type !== 'ui') ensureSession();
    if (pinPending && state.agents[pinPending]) { const id = pinPending; pinPending = null; store.setUI({ sessionId: state.agents[id].sessionId, selectedId: id }); }
    schedulePanel();
  });
  setInterval(schedulePanel, 10000); // refresh relative times
  setInterval(() => { if (panelMod && typeof panelMod.tickAgo === 'function') panelMod.tickAgo(panelEl); }, 1000);

  // ---- stream + status strip
  const statusEl = $('status');
  const renderStatus = errors.wrap(() => {
    const st = store.getUI().streamStatus;
    const label = st.state === 'live' ? 'live' : st.state === 'reconnecting' ? 'reconnecting…' : 'disconnected';
    statusEl.className = 'status ' + st.state;
    statusEl.textContent = `● ${label}${st.lastEventAt ? ` · ${ago(st.lastEventAt)} ago` : ''}`;
    statusEl.title = st.state === 'live' ? 'Connected to the server; time since the last event' : 'The server is unreachable; the picture may be stale';
  }, 'status');
  connect('/events', store, { onStatus: renderStatus, onError: (m, d) => errors.report(m, d) });
  setInterval(renderStatus, 1000);
  setInterval(() => { const c = $('clock'); if (c) c.textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 1000);

  // ---- canvas hit testing (pick) → select / hover; camera handles pan/zoom
  canvas.addEventListener('mousemove', (e) => {
    if (camera.suppressClick() || stage.classList.contains('dragging')) return;
    const r = canvas.getBoundingClientRect();
    let id = null; try { id = renderer.pick(e.clientX - r.left, e.clientY - r.top, lastScene); } catch (err) { /* reported by loop */ }
    canvas.style.cursor = id ? 'pointer' : 'grab';
    hover(id);
  });
  canvas.addEventListener('mouseleave', () => hover(null));
  canvas.addEventListener('click', (e) => {
    if (camera.suppressClick()) return;
    const r = canvas.getBoundingClientRect();
    let id = null; try { id = renderer.pick(e.clientX - r.left, e.clientY - r.top, lastScene); } catch (err) { errors.report('pick failed', err && err.message); }
    if (id) select(id); else if (store.getUI().selectedId) select(null);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && store.getUI().selectedId && !document.fullscreenElement) select(null); });

  // ---- theme switch (re-creates renderer + overlays)
  const sel = $('themesel');
  sel.innerHTML = THEMES.map((t) => `<option value="${t.name}">${t.label}</option>`).join('');
  sel.value = THEMES.some((t) => t.name === theme.name) ? theme.name : 'spaceship';
  async function switchTheme(name) {
    if (name === theme.name) return;
    const next = await loadTheme(name);
    if (next.loadError) errors.report(next.loadError);
    theme = next;
    store.setUI({ theme: theme.name });
    try { localStorage.setItem('agentdeck.theme', theme.name); } catch (_) { /* ignore */ }
    writeHash({ theme: theme.name === 'spaceship' ? '' : theme.name });
    try { renderer.destroy(); } catch (err) { errors.report('renderer.destroy failed', err && err.message); }
    renderer = makeRenderer();
    camera.fit();
    makeOverlays();
    sel.value = theme.name;
    schedulePanel();
  }
  sel.addEventListener('change', () => switchTheme(sel.value));

  // ---- URL hash: #session=<id> #pin=<agentId> #theme=<name>
  window.addEventListener('hashchange', () => {
    const h = readHash(), state = store.getState();
    if (h.theme && h.theme !== theme.name) switchTheme(h.theme);
    if (h.session && state.sessions[h.session]) selectSession(h.session);
    if (h.pin !== undefined) { if (h.pin && state.agents[h.pin]) store.setUI({ selectedId: h.pin }); else if (!h.pin) store.setUI({ selectedId: null }); }
  });
  renderTabs(); renderPanel(); renderStatus();
}

boot().catch((err) => errors.report('startup failed', err && err.stack || String(err)));
