// server/log.js — leveled logger to stderr plus a rotating file (~/.config/agentdeck/agentdeck.log, 5 MB, keep 3).
// Errors and warnings are also handed to an optional sink so the state can expose them on /api/health (ADR-0008).
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * @typedef {Object} Logger
 * @property {(msg:string, detail?:any)=>void} debug
 * @property {(msg:string, detail?:any)=>void} info
 * @property {(msg:string, detail?:any)=>void} warn
 * @property {(msg:string, detail?:any)=>void} error
 * @property {(scope:string)=>Logger} child        prefix every line with `[scope]` (usually a session id)
 * @property {(level:string)=>void} setLevel
 * @property {(fn:(e:{when:number,level:string,msg:string,detail?:string})=>void)=>void} onEntry  subscribe to warn/error entries
 * @property {()=>void} close
 */

/**
 * Create the logger.
 * @param {{level?:string, file?:string|null, maxBytes?:number, keep?:number, stderr?:boolean}} [opts]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  let level = LEVELS[opts.level] ?? LEVELS.info;
  const file = opts.file === undefined ? null : opts.file;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const keep = opts.keep ?? 3;
  const toStderr = opts.stderr !== false;
  const listeners = new Set();
  let size = 0;
  let fileOk = !!file;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch (e) {
      fileOk = false;
      if (toStderr) process.stderr.write(`log: cannot open ${file}: ${e.message}\n`);
    }
  }

  function rotate() {
    try {
      for (let i = keep - 1; i >= 1; i--) {
        const from = `${file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
      }
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
      size = 0;
    } catch { /* keep writing to the current file */ }
  }

  function write(lvl, scope, msg, detail) {
    if (LEVELS[lvl] < level) return;
    const when = Date.now();
    const det = fmtDetail(detail);
    const line = `${new Date(when).toISOString()} ${lvl.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${msg}${det ? ` · ${det}` : ''}\n`;
    if (toStderr) process.stderr.write(line);
    if (fileOk) {
      try {
        if (size + line.length > maxBytes) rotate();
        fs.appendFileSync(file, line);
        size += line.length;
      } catch { fileOk = false; }
    }
    if (LEVELS[lvl] >= LEVELS.warn) {
      const entry = { when, level: lvl, msg: scope ? `[${scope}] ${msg}` : msg, detail: det || undefined };
      for (const fn of listeners) { try { fn(entry); } catch { /* never let a sink break logging */ } }
    }
  }

  function make(scope) {
    return {
      debug: (m, d) => write('debug', scope, m, d),
      info: (m, d) => write('info', scope, m, d),
      warn: (m, d) => write('warn', scope, m, d),
      error: (m, d) => write('error', scope, m, d),
      child: (s) => make(scope ? `${scope}:${s}` : s),
      setLevel: (l) => { if (LEVELS[l] !== undefined) level = LEVELS[l]; },
      onEntry: (fn) => { listeners.add(fn); },
      close: () => { listeners.clear(); },
    };
  }
  return make('');
}

/** Short one-line rendering of an error or object. */
function fmtDetail(d) {
  if (d === undefined || d === null) return '';
  if (d instanceof Error) return (d.code ? `${d.code}: ` : '') + d.message;
  if (typeof d === 'string') return d.replace(/\s+/g, ' ').slice(0, 300);
  try { return JSON.stringify(d).slice(0, 300); } catch { return String(d); }
}

/** A logger that discards everything (tests). @returns {Logger} */
export function nullLogger() { return createLogger({ level: 'silent', file: null, stderr: false }); }
