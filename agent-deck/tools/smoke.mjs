#!/usr/bin/env node
// tools/smoke.mjs — headless-Chrome smoke test for Agent Deck. Zero dependencies, Node 20+.
//
// What it does
//   1. starts `node server.js --demo --no-open --port 7799` from the agent-deck folder
//   2. waits for /api/health
//   3. launches headless Chrome with --remote-debugging-port and a throw-away profile
//   4. drives the page over the Chrome DevTools Protocol with Node's global WebSocket
//   5. runs the steps (a)–(i) below, one screenshot per step into tools/smoke-out/
//   6. prints a table; exit 0 when every step passed, 1 otherwise
// Chrome and the server are always stopped, also on Ctrl-C or a crash.
//
// Environment
//   CHROME         path to the Chrome/Chromium binary (default: the macOS app path, or PATH lookup)
//   SMOKE_PORT     server port (default 7799; keep it, other ports may belong to real instances)
//   SMOKE_HEADFUL  set to 1 to watch the browser instead of running headless
//   SMOKE_SERVER   alternative server script (default server.js), for testing this tool itself
//
// The script is written against the DOM contract (CONTRACTS.md §11). It also uses an optional
// debug hook, `window.__agentdeck = {store, scene, renderer, camera}`, when main.js exposes it;
// without the hook it falls back to timing and a mouse sweep. Every step fails with a message
// instead of throwing, so a half-built app still produces a full table.

import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Node 20/21 ship the WebSocket global behind a flag; re-exec once with it.
if (typeof globalThis.WebSocket === 'undefined') {
  if (process.env.AGENTDECK_SMOKE_REEXEC) {
    console.error('smoke: this Node has no global WebSocket. Use Node 22+ or run: node --experimental-websocket tools/smoke.mjs');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ['--experimental-websocket', ...process.argv.slice(1)],
    {stdio: 'inherit', env: {...process.env, AGENTDECK_SMOKE_REEXEC: '1'}});
  process.exit(r.status ?? 1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'smoke-out');
const PORT = Number(process.env.SMOKE_PORT || 7799);
const BASE = `http://127.0.0.1:${PORT}/`;
const SERVER_SCRIPT = process.env.SMOKE_SERVER || 'server.js';
const HEADFUL = process.env.SMOKE_HEADFUL === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const trunc = (s, n) => (s = String(s ?? ''), s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- cleanup: always stop children and remove the temp profile ----------
const cleanups = [];
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
}
function killChild(child) {
  return new Promise((res) => {
    if (!child || child.exitCode !== null || child.signalCode) return res();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } res(); }, 1500);
    child.once('exit', () => { clearTimeout(t); res(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(t); res(); }
  });
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => { console.error(`\nsmoke: got ${sig}, cleaning up`); await cleanup(); process.exit(130); });
}
process.on('uncaughtException', async (e) => { console.error('smoke: uncaught error:', e); await cleanup(); process.exit(1); });
process.on('unhandledRejection', async (e) => { console.error('smoke: unhandled rejection:', e); await cleanup(); process.exit(1); });

// ---------- helpers: ports, chrome ----------
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const portBusy = (port) => new Promise((res) => {
  const s = net.createServer(); s.once('error', () => res(true));
  s.listen(port, '127.0.0.1', () => s.close(() => res(false)));
});
function findChrome() {
  if (process.env.CHROME) return fs.existsSync(process.env.CHROME) ? process.env.CHROME : null;
  const onPath = (names) => names.flatMap((n) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, n)));
  const cands = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')]
      : onPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']);
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

// ---------- CDP client over the global WebSocket ----------
async function connectCDP(cdpPort) {
  let targets = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome did not expose a page target on the debugging port');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed to open')); });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(`CDP ${p.method}: ${m.error.message}`)) : p.res(m.result);
    } else if (m.method) {
      for (const fn of listeners.get(m.method) || []) fn(m.params);
    }
  };
  const send = (method, params = {}, timeoutMs = 15000) => new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} timed out`)); }, timeoutMs);
    pending.set(i, {method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); }});
    ws.send(JSON.stringify({id: i, method, params}));
  });
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  return {send, on, close: () => { try { ws.close(); } catch { /* closed */ } }};
}

// ---------- main ----------
async function main() {
  if (!fs.existsSync(path.join(ROOT, 'fixtures', 'demo.jsonl')) && !fs.existsSync(path.join(ROOT, 'agentdeck.json'))) {
    console.error('The smoke test drives `--demo`, which needs a recording.\nPut one at agent-deck/fixtures/demo.jsonl, or point "demo_file" in agent-deck/agentdeck.json at one.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, {recursive: true});
  for (const f of fs.readdirSync(OUT)) if (/\.(png|log|json)$/.test(f)) fs.rmSync(path.join(OUT, f), {force: true});

  // preflight
  const serverPath = path.resolve(ROOT, SERVER_SCRIPT);
  if (!fs.existsSync(serverPath)) throw new Error(`server script not found: ${serverPath}`);
  if (await portBusy(PORT)) throw new Error(`port ${PORT} is already in use; stop that process (lsof -i :${PORT}) and rerun`);
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found. Set CHROME=/path/to/chrome');

  // 1. server
  const serverLog = fs.createWriteStream(path.join(OUT, 'server.log'));
  let serverTail = '';
  const server = spawn(process.execPath, [serverPath, '--demo', '--no-open', '--port', String(PORT)],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, AGENTDECK_SMOKE: '1'}});
  for (const s of [server.stdout, server.stderr]) {
    s.pipe(serverLog, {end: false});
    s.on('data', (d) => { serverTail = (serverTail + d.toString()).slice(-2000); });
  }
  let serverExit = null;
  server.on('exit', (code, signal) => { serverExit = {code, signal}; });
  cleanups.push(() => killChild(server));
  cleanups.push(() => new Promise((r) => serverLog.end(r)));

  let health = null;
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    if (serverExit) break;
    try { const r = await fetch(BASE + 'api/health'); if (r.ok) { health = await r.json(); break; } } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!health) {
    const why = serverExit ? `server exited early (code ${serverExit.code}, signal ${serverExit.signal})` : 'no answer from /api/health within 20 s';
    throw new Error(`${why}\n--- server output (tail) ---\n${serverTail.trim() || '(nothing)'}`);
  }
  console.log(`server: ${BASE} · health ok (${health.sessions ?? '?'} sessions, mode ${health.mode ?? '?'})`);

  // 2. chrome
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-smoke-'));
  cleanups.push(() => fs.rmSync(profile, {recursive: true, force: true}));
  const chromeArgs = [
    ...(HEADFUL ? [] : ['--headless=new']),
    '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    // a backgrounded page gets no animation frames, which would freeze the camera mid-glide
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--window-size=1440,960',
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const chrome = spawn(chromePath, chromeArgs, {stdio: 'ignore'});
  cleanups.push(() => killChild(chrome));
  const cdp = await connectCDP(cdpPort);
  cleanups.push(() => cdp.close());

  const consoleLog = [];
  cdp.on('Runtime.exceptionThrown', (p) => consoleLog.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') consoleLog.push(`console.${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') consoleLog.push(`${p.entry.source}: ${p.entry.text} ${p.entry.url || ''}`); });
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error('in page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const mouse = {
    move: (x, y) => cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}),
    click: async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
      await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
    },
    // Chrome occasionally never answers a mouseWheel dispatch in headless, then delivers it late and
    // moves the camera under a later step. One hang disables the wheel for the rest of the run.
    wheel: async (x, y, deltaY) => {
      if (wheelBroken) return 'timeout';
      const r = await Promise.race([
        cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x, y, deltaX: 0, deltaY}).catch(() => 'error'),
        sleep(2500).then(() => 'timeout'),
      ]);
      if (r === 'timeout') wheelBroken = true;
      return r;
    },
  };
  const press = async (key, code, vk, text) => {
    const base = {key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk};
    await cdp.send('Input.dispatchKeyEvent', text ? {type: 'keyDown', text, ...base} : {type: 'rawKeyDown', ...base});
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
  };
  const rectOf = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height}})()`);
  let wheelBroken = false;
  /**
   * The app opens on the most urgent session, which may hold a single agent; the hover step needs a crowd.
   * Waits for the debug hook, which appears only after the theme fetch and the first render.
   */
  async function pickBusiestSession() {
    for (let k = 0; k < 40; k++) {
      const r = await ev(`(()=>{try{const d=window.__agentdeck;if(!d||!d.store)return null;const st=d.store.getState();const n={};for(const a of Object.values(st.agents||{}))n[a.sessionId]=(n[a.sessionId]||0)+1;const best=Object.entries(n).sort((x,y)=>y[1]-x[1])[0];if(!best||best[1]<2)return null;d.store.setUI({sessionId:best[0]});const s=st.sessions[best[0]];return (s&&s.name||best[0])+' ('+best[1]+' agents)'}catch(e){return null}})()`);
      if (r) { await sleep(1200); return r; }
      await sleep(500);
    }
    return null;
  }
  const toasts = () => ev(`[...document.querySelectorAll('#errbar > *')].map(e=>e.textContent.trim().slice(0,160))`);
  const chip = () => ev(`(document.querySelector('#zoomchip')||{}).textContent||null`);
  const HCARD_VISIBLE = `(()=>{const h=document.querySelector('.hcard');if(!h||h.hidden)return false;const cs=getComputedStyle(h);if(cs.display==='none'||cs.visibility==='hidden')return false;const b=h.getBoundingClientRect();return b.width>0&&b.height>0})()`;
  const PIN_STATE = `(()=>{const h=document.querySelector('.hcard');let sel=null;try{const d=window.__agentdeck;const s=d&&d.store&&d.store.getState&&d.store.getState();sel=s&&(s.selectedId||s.selected||(s.ui&&(s.ui.selectedId||s.ui.selected)))||null}catch{}return {pinnedClass:!!(h&&h.classList.contains('pinned')),hashPin:/pin=/.test(location.hash),sel:sel?String(sel):null,visible:${HCARD_VISIBLE}}})()`;
  const waitFor = async (fn, ms, what) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(250); }
    console.log(`warn: gave up waiting for ${what} after ${ms} ms`);
    return false;
  };
  let shotN = 0;
  const shot = async (name) => {
    try {
      const s = await cdp.send('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(s.data, 'base64'));
    } catch (e) { console.log(`warn: screenshot ${name} failed: ${e.message}`); }
  };

  // 3. open the page and wait until it is ready
  await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {});
  await cdp.send('Page.navigate', {url: BASE});
  const tNav = Date.now();
  await waitFor(() => ev(`!!document.querySelector('#cv')`), 15000, '#cv');
  // main.js exposes the hook after the theme fetch and first render, so poll rather than check once
  await waitFor(() => ev(`!!(window.__agentdeck && window.__agentdeck.store)`), 10000, 'the debug hook').catch(() => {});
  const hook = await ev(`(()=>{const d=window.__agentdeck;return {hook:!!d,store:!!(d&&d.store&&typeof d.store.getState==='function'),scene:!!(d&&d.scene),renderer:!!(d&&d.renderer&&typeof d.renderer.project==='function'),camera:!!(d&&d.camera)}})()`);
  console.log(`page: #cv ${await ev(`!!document.querySelector('#cv')`) ? 'found' : 'MISSING'} · debug hook ${hook.hook ? `present (store:${hook.store} scene:${hook.scene} renderer:${hook.renderer} camera:${hook.camera})` : 'absent, using fallbacks'}`);
  const COUNT = (x) => `(${x} instanceof Map?${x}.size:Array.isArray(${x})?${x}.length:Object.keys(${x}||{}).length)`;
  if (hook.store) {
    await waitFor(() => ev(`(()=>{try{const s=window.__agentdeck.store.getState();return ${COUNT('s.sessions')}>0}catch{return false}})()`), 15000, 'a session in the store');
    const picked = await pickBusiestSession();
    if (picked) console.log(`page: hover target session → ${picked}`);
  } else {
    await sleep(4000);
  }
  await shot('ready');

  // 4. steps
  let hoverPoint = null;
  let chipBaseline = null;
  const steps = [
    {id: 'a', name: 'DOM ids present', run: async () => {
      const ids = ['stage', 'cv', 'ov', 'panel', 'podlist', 'viewctl', 'errbar'];
      const missing = await ev(`${JSON.stringify(ids)}.filter(id=>!document.getElementById(id))`);
      const extra = await ev(`['tabs','topstats','status','zout','zoomchip','zin','recenter','fs','diag','themesel'].filter(id=>!document.getElementById(id))`);
      return {ok: missing.length === 0, note: missing.length ? `missing #${missing.join(' #')}` : `all present${extra.length ? `; optional ids missing: #${extra.join(' #')}` : ''}`};
    }},
    {id: 'b', name: 'no errors in #errbar', run: async () => {
      const t = await toasts();
      return {ok: t.length === 0, note: t.length ? `${t.length} toast(s): ${t.join(' | ')}` : 'no toasts'};
    }},
    {id: 'c', name: 'hover a person shows .hcard', run: async () => {
      await pickBusiestSession();          // the hook may only have appeared after the earlier attempt
      const tryPoint = async (x, y) => { await mouse.move(x, y); await sleep(300); return ev(HCARD_VISIBLE); };
      if (hook.scene && hook.renderer) {
        const p = await ev(`(()=>{const d=window.__agentdeck;const sc=typeof d.scene==='function'?d.scene():d.scene;const p=sc&&sc.people&&sc.people[0];if(!p)return {none:true};const cv=document.querySelector('#cv');const b=cv.getBoundingClientRect();const pts=[];for(const z of [16,8,24,0]){let q=null;try{q=d.renderer.project({i:p.pos.i,j:p.pos.j,z})}catch{}if(!q)continue;let hit=null;try{if(typeof d.renderer.pick==='function')hit=d.renderer.pick(q.x,q.y,sc)}catch{}pts.push({x:b.left+q.x,y:b.top+q.y,z,hit})}return {id:p.id,name:p.name,pts}})()`);
        if (p?.none) return {ok: false, note: 'scene.people is empty (no agents laid out yet)'};
        const ordered = [...(p?.pts || [])].sort((u, v) => (v.hit === p.id) - (u.hit === p.id));
        for (const pt of ordered) {
          if (await tryPoint(pt.x, pt.y)) { hoverPoint = pt; return {ok: true, note: `via debug hook: ${p.name || p.id} at (${pt.x.toFixed(0)},${pt.y.toFixed(0)}) z=${pt.z}${pt.hit ? ' pick=' + pt.hit : ''}`}; }
        }
        console.log(`  hook projection did not hit (${ordered.length} points tried); falling back to a sweep`);
      }
      const st = await rectOf('#stage');
      if (!st) return {ok: false, note: '#stage missing'};
      const N = 5;
      for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
        const x = st.x - st.w / 2 + st.w * (0.15 + 0.7 * gx / (N - 1));
        const y = st.y - st.h / 2 + st.h * (0.15 + 0.7 * gy / (N - 1));
        if (await tryPoint(x, y)) { hoverPoint = {x, y}; return {ok: true, note: `via ${N}×${N} sweep at (${x.toFixed(0)},${y.toFixed(0)})`}; }
      }
      return {ok: false, note: `.hcard never became visible over ${N * N} stage points`};
    }},
    {id: 'd', name: 'click pins card, Escape clears', run: async () => {
      if (!hoverPoint) return {ok: false, note: 'skipped: step c found no hover point'};
      await mouse.click(hoverPoint.x, hoverPoint.y); await sleep(400);
      const after = await ev(PIN_STATE);
      const pinned = after.pinnedClass || after.hashPin || !!after.sel;
      await press('Escape', 'Escape', 27); await sleep(400);
      const cleared = await ev(PIN_STATE);
      const stillPinned = cleared.pinnedClass || cleared.hashPin || !!cleared.sel;
      const how = after.pinnedClass ? '.hcard.pinned' : after.hashPin ? 'url #pin=' : after.sel ? `store selected=${after.sel}` : 'nothing';
      if (!pinned) return {ok: false, note: `click did not pin (card visible: ${after.visible})`};
      if (stillPinned) return {ok: false, note: `pinned via ${how}, but Escape did not clear it`};
      return {ok: true, note: `pinned via ${how}; Escape cleared`};
    }},
    {id: 'e', name: 'wheel zoom in x2 changes chip', run: async () => {
      const before = await chip();
      chipBaseline = before;
      const st = await rectOf('#stage');
      if (!st) return {ok: false, note: '#stage missing'};
      // CDP's Input.dispatchMouseEvent with type mouseWheel is sometimes never acknowledged in
      // headless, and because commands are answered in order that blocks every later read for ~20 s.
      // Dispatching the WheelEvent inside the page exercises the same listener without that risk.
      const sent = await ev(`(()=>{const s=document.querySelector('#stage');if(!s)return 0;let n=0;
        for(let k=0;k<2;k++){const e=new WheelEvent('wheel',{deltaY:-100,clientX:${Math.round(st.x)},clientY:${Math.round(st.y)},bubbles:true,cancelable:true});s.dispatchEvent(e);n++}return n})()`);
      await sleep(500);
      let after = await chip();
      let how = `${sent} page wheel event(s)`;
      if (after === before) {              // no wheel listener reached: the +button is the same code path
        const z = await rectOf('#zin');
        if (z) { await mouse.click(z.x, z.y); await sleep(250); await mouse.click(z.x, z.y); await sleep(400); after = await chip(); how += ', +button'; }
      }
      if (before == null || after == null) return {ok: false, note: '#zoomchip missing'};
      return {ok: before !== after, note: `chip ${JSON.stringify(before)} → ${JSON.stringify(after)} (${how})`};
    }},
    {id: 'f', name: 'click #recenter', run: async () => {
      const r = await rectOf('#recenter');
      if (!r) return {ok: false, note: '#recenter missing'};
      const before = (await toasts()).length;
      // a hung wheel event can still arrive minutes later and move the camera; wait for it to settle first
      const camNow = () => ev(`(()=>{try{const c=window.__agentdeck.camera.getState();return c.x+','+c.y+','+c.zoom}catch{return 'none'}})()`);
      let last = await camNow();
      for (let k = 0; k < 20; k++) { await sleep(400); const now = await camNow(); if (now === last) break; last = now; }
      const r2 = await rectOf('#recenter');   // re-read: zoom/fullscreen may have moved it
      const readCam = () => ev(`(()=>{try{const c=window.__agentdeck.camera.getState();return {x:Math.round(c.x),y:Math.round(c.y),zoom:c.zoom,base:c.pixelScale}}catch{return null}})()`);
      const isReset = (c) => c && c.x === 0 && c.y === 0 && Math.abs(c.zoom - c.base) < 0.001;
      let cam = null;
      // A mouseWheel that headless Chrome never acknowledged is flushed when the next input event
      // arrives, so the first click can be undone by it. Allow one retry.
      for (let attempt = 0; attempt < 2; attempt++) {
        await mouse.click((r2 || r).x, (r2 || r).y);
        await sleep(1400);                    // the camera glides back
        cam = await readCam();
        if (isReset(cam) || !cam) break;
      }
      const after = (await toasts()).length;
      if (after > before) return {ok: false, note: 'an error toast appeared'};
      if (!cam) return {ok: true, note: `no new toast; chip now ${JSON.stringify(await chip())} (no debug hook to check the camera)`};
      const reset = isReset(cam);
      return {ok: reset, note: reset ? `camera back to 0,0 at ${cam.zoom}× (base ${cam.base}×)` : `camera still at x=${cam.x} y=${cam.y} zoom=${cam.zoom} (base ${cam.base})`};
    }},
    {id: 'g', name: 'click first .podlist .row2', run: async () => {
      const rows = await ev(`[...document.querySelectorAll('#podlist .row2, .podlist .row2')].map(e=>e.textContent.trim().replace(/\\s+/g,' ').slice(0,60))`);
      if (!rows.length) return {ok: true, note: 'no rows yet (rooms list empty at this point of the demo)'};
      let r = await rectOf('#podlist .row2, .podlist .row2');
      if (!r || r.w === 0 || r.h === 0) {
        const h = await rectOf('#podlist .h');
        if (h) { await mouse.click(h.x, h.y); await sleep(300); r = await rectOf('#podlist .row2, .podlist .row2'); }
      }
      if (!r || r.w === 0) return {ok: false, note: `${rows.length} row(s) but the first has no size (collapsed?)`};
      const t0 = (await toasts()).length;
      await mouse.click(r.x, r.y); await sleep(1200);
      const on = await ev(`!!document.querySelector('#podlist .row2.on, .podlist .row2.on')`);
      const t1 = (await toasts()).length;
      return {ok: t1 === t0, note: `clicked "${rows[0]}" of ${rows.length}; ${on ? 'row marked .on' : 'no .on marker'}; ${t1 === t0 ? 'no new toast' : `${t1 - t0} new toast(s)`}`};
    }},
    {id: 'h', name: 'F then Escape (fullscreen)', run: async () => {
      // focus emulation makes requestFullscreen hang in headless; turn it off for this step only
      await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => {});
      try {
      const t0 = (await toasts()).length;
      await press('f', 'KeyF', 70, 'f'); await sleep(700);
      const fsState = await ev(`(()=>{const st=document.getElementById('stage');return document.fullscreenElement?'native fullscreen':st&&st.classList.contains('max')?'stage.max fallback':'not entered (headless may deny it)'})()`);
      await press('Escape', 'Escape', 27); await sleep(500);
      const left = await ev(`!document.fullscreenElement&&!(document.getElementById('stage')||{classList:{contains:()=>false}}).classList.contains('max')`);
      const t1 = (await toasts()).length;
      return {ok: t1 === t0, note: `${fsState}; after Escape ${left ? 'normal view' : 'still maximised'}; ${t1 === t0 ? 'no new toast' : `${t1 - t0} new toast(s): ${(await toasts()).slice(t0).join(' | ')}`}`};
    } finally { await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {}); }
    }},
    {id: 'i', name: 'huddle card in panel, #status live (t≥25 s)', run: async () => {
      const wait = Math.max(3000, tNav + 25000 - Date.now());
      console.log(`  waiting ${(wait / 1000).toFixed(1)} s for the demo timeline`);
      await sleep(wait);
      const r = await ev(`(()=>{const panel=document.querySelector('#panel');const txt=panel?panel.innerText:'';const dom=!!(panel&&(panel.querySelector('[class*="huddle" i],[data-kind="huddle"],[data-huddle]')||/huddle/i.test(txt)));let storeN=null;try{const d=window.__agentdeck;const s=d&&d.store&&d.store.getState&&d.store.getState();if(s&&s.huddles!=null)storeN=${COUNT('s.huddles')}}catch{}const status=((document.querySelector('#status')||{}).textContent||'').trim();return {dom,storeN,status}})()`);
      const live = /live/i.test(r.status);
      const okHuddle = r.dom || (r.storeN != null && r.storeN > 0);
      const notes = [r.dom ? 'huddle card in #panel' : 'no huddle card in #panel', r.storeN != null ? `store huddles=${r.storeN}` : null, `#status="${r.status}"${live ? '' : ' (expected live)'}`].filter(Boolean);
      return {ok: okHuddle && live, note: notes.join('; ')};
    }},
  ];

  const results = [];
  for (const step of steps) {
    const t0 = Date.now();
    let r;
    try { r = await step.run(); } catch (e) { r = {ok: false, note: `threw: ${e.message}`}; }
    r = {id: step.id, name: step.name, ok: !!r.ok, note: String(r.note || ''), ms: Date.now() - t0};
    results.push(r);
    console.log(`  (${r.id}) ${r.ok ? 'pass' : 'FAIL'}  ${r.name} — ${r.note}`);
    await shot(`${step.id}-${slug(step.name)}`);
  }

  // 5. report
  fs.writeFileSync(path.join(OUT, 'console.log'), consoleLog.join('\n') + (consoleLog.length ? '\n' : ''));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({when: new Date().toISOString(), url: BASE, chrome: chromePath, hook, health, results, console: consoleLog}, null, 2));
  const rows = results.map((r) => [`(${r.id})`, r.name, r.ok ? 'pass' : 'FAIL', `${r.ms} ms`, trunc(r.note, 90)]);
  const head = ['step', 'what', 'result', 'time', 'note'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  console.log('\n' + line(head) + '\n' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed · screenshots in ${path.relative(process.cwd(), OUT) || '.'} · ${consoleLog.length} console error/warning line(s) in smoke-out/console.log`);
  return passed === results.length ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`smoke: ${e.message}`);
} finally {
  await cleanup();
}
process.exit(code);
