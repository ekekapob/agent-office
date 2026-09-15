#!/usr/bin/env node
// tools/charlab/serve.mjs — the Character Lab's own tiny local server. Separate from server.js:
// it never reads ~/.claude, never opens a session, and serves only this repo's static files plus
// a small preset API. It exists because the lab page imports the real renderer modules from web/,
// which needs http:// (ES modules do not load from file://), and because saving a preset has to
// write a real file into presets/ so it can be read back and applied later.
//
//   node tools/charlab/serve.mjs [--port 4800] [--host 127.0.0.1]
//
// API:
//   GET   /api/themes          -> { themes: ["office", "spaceship"] }
//   GET   /api/presets         -> { presets: [{ name, label, figures }] }
//   GET   /api/presets/<name>  -> the preset JSON
//   POST  /api/presets/<name>  -> validate, then write presets/<name>.json
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..'); // agent-deck/
const PRESETS_DIR = path.join(ROOT, 'presets');
const THEMES_DIR = path.join(ROOT, 'themes');

/** Directories the lab may serve files from. Anything else is 404, so this cannot leak the disk. */
const SERVE_ROOTS = ['web', 'themes', 'presets', 'tools/charlab'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// These three lists mirror what web/js/renderer/iso2d/figure.js can draw. Keep them in step:
// a value the renderer does not know falls back silently, so the lab rejects it here instead.
/** Accessories drawFigure() can draw. Anything else draws nothing. */
export const ACCESSORIES = ['tie', 'cap', 'hat', 'glasses', 'badge'];
/** Outfits drawFigure() can draw (torso, legs, sleeves). */
export const OUTFITS = ['shirt', 'suit', 'turtleneck', 'tank', 'hoodie', 'bikini', 'dress', 'labcoat', 'armor'];
/** Head types drawFigure() can draw. Each keeps the human head and adds ears, a beak, a visor or a fringe. */
export const HEADS = ['human', 'swept', 'rabbit', 'cat', 'fox', 'bear', 'bird', 'robot', 'frog'];
/** Faces drawFigure() can draw on the front of the head. 'plain' is the original two-pixel eyes. */
export const FACES = ['plain', 'john', 'smile', 'focused', 'tired', 'wink'];
/** Shared colours a preset may set. Each is a theme.palette key read by resolveColors() (iso2d/colors.js). */
export const SHARED_KEYS = ['skin', 'hat', 'cap', 'gold', 'jewel', 'tie', 'lens', 'outline', 'ink',
  'earInner', 'beak', 'coat', 'visor', 'metal', 'lip', 'blush'];

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BODY_MAX = 64 * 1024;

/**
 * Check one preset and return a clean copy. Unknown palette keys are reported and dropped, so a
 * preset stays character-only and can be applied on top of any theme.
 * @param {any} raw @param {string} name
 * @returns {{ok:boolean, preset?:Object, problems:string[]}}
 */
export function validatePreset(raw, name) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problems: ['preset is not an object'] };
  if (!NAME_RE.test(name)) return { ok: false, problems: [`name "${name}" must be lowercase letters, digits and dashes`] };

  const palette = {};
  const rawPal = raw.palette && typeof raw.palette === 'object' ? raw.palette : {};
  for (const k of SHARED_KEYS) {
    if (rawPal[k] === undefined) continue;
    if (HEX_RE.test(String(rawPal[k]))) palette[k] = String(rawPal[k]).toLowerCase();
    else problems.push(`palette.${k} is not a #rrggbb colour`);
  }
  for (const k of Object.keys(rawPal)) if (!SHARED_KEYS.includes(k)) problems.push(`palette.${k} is not a character colour (dropped)`);

  const figures = {};
  const rawFigs = raw.figures && typeof raw.figures === 'object' ? raw.figures : {};
  for (const [type, f] of Object.entries(rawFigs)) {
    if (!TYPE_RE.test(type)) { problems.push(`figures."${type}" is not a usable agent type name`); continue; }
    if (!f || typeof f !== 'object') { problems.push(`figures.${type} is not an object`); continue; }
    const out = {};
    for (const k of ['shirt', 'hair', 'pants']) {
      if (HEX_RE.test(String(f[k]))) out[k] = String(f[k]).toLowerCase();
      else problems.push(`figures.${type}.${k} is not a #rrggbb colour`);
    }
    if (f.acc === null || f.acc === undefined || f.acc === '') out.acc = null;
    else if (ACCESSORIES.includes(f.acc)) out.acc = f.acc;
    else problems.push(`figures.${type}.acc "${f.acc}" is not one of ${ACCESSORIES.join(', ')}`);
    if (f.outfit === undefined || f.outfit === null || f.outfit === '') out.outfit = 'shirt';
    else if (OUTFITS.includes(f.outfit)) out.outfit = f.outfit;
    else problems.push(`figures.${type}.outfit "${f.outfit}" is not one of ${OUTFITS.join(', ')}`);
    if (f.head === undefined || f.head === null || f.head === '') out.head = 'human';
    else if (HEADS.includes(f.head)) out.head = f.head;
    else problems.push(`figures.${type}.head "${f.head}" is not one of ${HEADS.join(', ')}`);
    if (f.face === undefined || f.face === null || f.face === '') out.face = 'plain';
    else if (FACES.includes(f.face)) out.face = f.face;
    else problems.push(`figures.${type}.face "${f.face}" is not one of ${FACES.join(', ')}`);
    if (f.crown) out.crown = true;
    figures[type] = out;
  }
  if (!Object.keys(figures).length) problems.push('preset has no agent types');
  if (problems.some((p) => !p.endsWith('(dropped)'))) return { ok: false, problems };

  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 60) : name;
  return {
    ok: true,
    problems,
    preset: {
      kind: 'agentdeck-character-preset',
      version: 1,
      name,
      label,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
      palette,
      figures,
    },
  };
}

function listJson(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); }
  catch { return []; }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj, null, 2));

function serveStatic(res, urlPath) {
  const rel = urlPath.replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return send(res, 404, 'text/plain', 'not found\n');
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return send(res, 403, 'text/plain', 'forbidden\n');
  const inside = path.relative(ROOT, abs).split(path.sep).join('/');
  if (!SERVE_ROOTS.some((r) => inside === r || inside.startsWith(`${r}/`))) return send(res, 404, 'text/plain', 'not found\n');
  const type = MIME[path.extname(abs).toLowerCase()];
  if (!type) return send(res, 404, 'text/plain', 'not found\n');
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return send(res, 404, 'text/plain', 'not found\n'); }
  return send(res, 200, type, buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > BODY_MAX) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The lab's HTTP server. Exported so tests can drive it without binding a port. */
export function createLabServer() {
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return send(res, 400, 'text/plain', 'bad request\n'); }
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { p = url.pathname; }

    if (req.method === 'GET' && (p === '/' || p === '/tools/charlab' || p === '/tools/charlab/')) {
      return serveStatic(res, '/tools/charlab/index.html');
    }
    if (req.method === 'GET' && p === '/api/themes') return json(res, 200, { themes: listJson(THEMES_DIR) });

    if (p === '/api/presets' && req.method === 'GET') {
      const presets = listJson(PRESETS_DIR).map((name) => {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, `${name}.json`), 'utf8'));
          return { name, label: j.label || name, figures: Object.keys(j.figures || {}).length };
        } catch { return { name, label: name, figures: 0, broken: true }; }
      });
      return json(res, 200, { presets });
    }

    const m = p.match(/^\/api\/presets\/([^/]+)$/);
    if (m) {
      const name = m[1].replace(/\.json$/, '');
      if (!NAME_RE.test(name)) return json(res, 400, { ok: false, problems: ['bad preset name'] });
      const file = path.join(PRESETS_DIR, `${name}.json`);
      if (req.method === 'GET') {
        try { return send(res, 200, MIME['.json'], fs.readFileSync(file)); }
        catch { return json(res, 404, { ok: false, problems: [`no preset "${name}"`] }); }
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        let raw;
        try { raw = JSON.parse(await readBody(req)); }
        catch (e) { return json(res, 400, { ok: false, problems: [`bad JSON: ${e.message}`] }); }
        const v = validatePreset(raw, name);
        if (!v.ok) return json(res, 400, v);
        fs.mkdirSync(PRESETS_DIR, { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(v.preset, null, 2)}\n`, 'utf8');
        return json(res, 200, { ok: true, saved: path.relative(ROOT, file).split(path.sep).join('/'), problems: v.problems });
      }
      return json(res, 405, { ok: false, problems: ['method not allowed'] });
    }

    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed\n');
    return serveStatic(res, p);
  });
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const port = Number(arg('--port', process.env.PORT || 4800));
  const host = arg('--host', '127.0.0.1');
  createLabServer().listen(port, host, () => {
    console.log(`Character Lab  http://${host}:${port}/`);
    console.log(`presets ->     ${PRESETS_DIR}`);
  });
}
