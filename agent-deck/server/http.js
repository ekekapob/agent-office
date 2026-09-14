// server/http.js — the whole HTTP surface: static files from web/ and themes/, /api/state, /api/health,
// POST /hook/<Event> (untrusted, size-capped) and /control (disabled in v1). No directory listing, no traversal.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseHookPayload } from '../shared/adapter.js';

/** Largest hook body we will read (CONTRACTS §5). */
const HOOK_MAX = 64 * 1024;
const HOOK_EVENTS = new Set(['PermissionRequest', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Notification', 'Stop',
  'PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

/**
 * @typedef {Object} HttpServer
 * @property {import('node:http').Server} server
 * @property {(port:number, host:string)=>Promise<{ok:boolean, problem?:string, fix?:string}>} listen
 * @property {()=>Promise<void>} close
 */

/**
 * Build the server.
 * @param {{state:Object, sse:Object, config:Object, log:Object, roots:{web:string, themes:string},
 *          onHook?:(h:Object)=>void, home?:string|null}} opts
 * @returns {HttpServer}
 */
export function createHttpServer(opts) {
  const { state, sse, config, log, roots } = opts;
  const onHook = opts.onHook || (() => {});

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return send(res, 400, 'text/plain', 'bad request\n'); }
    const p = decodeSafe(url.pathname);
    try { route(req, res, p); }
    catch (e) {
      log.error(`${req.method} ${p} failed`, e);
      state.noteError(`request ${p} failed`, e && e.message);
      if (!res.headersSent) send(res, 500, 'text/plain', 'internal error\n');
    }
  });
  server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ } });

  function route(req, res, p) {
    if (req.method === 'GET' && p === '/events') return sse.handle(req, res);
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, state.snapshot());
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, state.health());
    if (p === '/control' || p.startsWith('/control/')) {
      if (!config.controls_enabled) return json(res, 501, { disabled: true, reason: 'controls are off in this version' });
      return json(res, 501, { disabled: true, reason: 'no controls are implemented yet' });
    }
    if (p.startsWith('/hook/')) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
      return hook(req, res, p.slice('/hook/'.length));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed\n');
    return serveStatic(req, res, p);
  }

  // ---------------------------------------------------------------- hooks

  function hook(req, res, name) {
    const event = name.replace(/[^A-Za-z]/g, '').slice(0, 40);
    if (!HOOK_EVENTS.has(event)) return json(res, 404, { ok: false, error: 'unknown hook event' });
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > HOOK_MAX) { if (!over) { over = true; json(res, 413, { ok: false, error: 'payload too large' }); req.destroy(); } return; }
      chunks.push(c);
    });
    req.on('error', () => { if (!over) { over = true; json(res, 400, { ok: false, error: 'read failed' }); } });
    req.on('end', () => {
      if (over) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return json(res, 400, { ok: false, error: 'body is not JSON' }); }
      const h = parseHookPayload(event, body, { now: Date.now(), home: opts.home || null });
      if (!h) return json(res, 200, { ok: false, error: 'ignored: no session_id' });
      log.debug(`hook ${h.event} for ${h.sessionId.slice(0, 8)}`);
      try { onHook(h); } catch (e) { log.error('hook handler failed', e); }
      json(res, 200, { ok: true });
    });
  }

  // ---------------------------------------------------------------- static

  function serveStatic(req, res, p) {
    let file = null;
    if (p === '/' || p === '') file = path.join(roots.web, 'index.html');
    else if (p.startsWith('/themes/')) file = safeJoin(roots.themes, p.slice('/themes/'.length));
    else file = safeJoin(roots.web, p.slice(1));
    if (!file) return send(res, 403, 'text/plain', 'forbidden\n');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {                                // no directory listing, ever
        if (p === '/') return send(res, 503, 'text/html; charset=utf-8', MISSING_INDEX);
        return send(res, 404, 'text/plain', 'not found\n');
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache',
        'Last-Modified': new Date(st.mtimeMs).toUTCString() };
      if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
      res.writeHead(200, headers);
      const rs = fs.createReadStream(file);
      rs.on('error', (e) => { log.warn(`cannot send ${file}`, e); res.destroy(); });
      rs.pipe(res);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Listen, turning the usual failures into plain English.
   * @param {number} port @param {string} host
   * @returns {Promise<{ok:boolean, problem?:string, fix?:string}>}
   */
  function listen(port, host) {
    return new Promise((resolve) => {
      const onErr = (e) => {
        server.removeListener('listening', onOk);
        if (e.code === 'EADDRINUSE') resolve({ ok: false, problem: `Port ${port} is already in use.`, fix: `Close the other program, or start with --port ${port + 1}.` });
        else if (e.code === 'EACCES') resolve({ ok: false, problem: `Not allowed to listen on port ${port}.`, fix: 'Pick a port above 1024 with --port.' });
        else if (e.code === 'EADDRNOTAVAIL') resolve({ ok: false, problem: `The address ${host} is not available on this machine.`, fix: 'Use --host 127.0.0.1 or 0.0.0.0.' });
        else resolve({ ok: false, problem: `Could not start the server: ${e.message}`, fix: '' });
      };
      const onOk = () => { server.removeListener('error', onErr); resolve({ ok: true }); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    });
  }

  function close() { return new Promise((resolve) => server.close(() => resolve())); }

  return { server, listen, close };
}

// ---------------------------------------------------------------- helpers

function send(res, code, type, body) {
  const buf = Buffer.from(body);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {any} data */
function json(res, code, data) {
  if (res.headersSent || res.writableEnded) return;
  let body;
  try { body = JSON.stringify(data); } catch { body = '{"error":"could not serialise the response"}'; }
  send(res, code, 'application/json; charset=utf-8', body);
}

function decodeSafe(p) { try { return decodeURIComponent(p); } catch { return p; } }

/**
 * Join a request path onto a root, refusing anything that escapes it or hides in a dot-folder.
 * @param {string} root @param {string} rel @returns {string|null}
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((s) => s === '..' || s.startsWith('.'))) return null;
  const full = path.resolve(root, clean);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

const MISSING_INDEX = `<!doctype html><meta charset="utf-8"><title>Agent Deck</title>
<body style="font:14px system-ui;margin:40px;max-width:40em">
<h1>Agent Deck is running</h1>
<p>The server is up, but <code>web/index.html</code> is not there yet, so there is no page to show.</p>
<p>The data is already available:</p>
<ul><li><a href="/api/state">/api/state</a> — the full snapshot</li>
<li><a href="/api/health">/api/health</a> — version, data root, errors</li>
<li><code>/events</code> — the live stream</li></ul>
</body>`;
