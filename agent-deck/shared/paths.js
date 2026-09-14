// shared/paths.js — extract file paths from tool inputs and shorten them for display.
// Pure: no Node imports, runs in the browser too. Callers pass {cwd, home} for display shortening.

/** @typedef {{cwd?:string|null, home?:string|null}} PathCtx */

const KNOWN_EXT = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env', 'lock', 'md', 'txt', 'rst', 'html', 'htm', 'css', 'scss',
  'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'csv', 'tsv', 'log',
  'pdf', 'ipynb', 'vue', 'svelte', 'proto', 'graphql', 'tf', 'dockerfile', 'makefile', 'gradle', 'bak', 'map',
]);

const BASH_SKIP = new Set(['&&', '||', '|', ';', '>', '>>', '<', '2>&1', '2>', '&']);

/**
 * Does a token look like a file system path? Absolute, home-relative, dot-relative, containing a slash,
 * or ending in a known extension. URLs, flags and bare numbers are rejected.
 * @param {string} tok
 * @returns {boolean}
 */
export function looksLikePath(tok) {
  if (typeof tok !== 'string' || tok.length < 2 || tok.length > 512) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) return false; // url
  if (tok.startsWith('-')) return false; // flag
  if (/^\d+(\.\d+)?$/.test(tok)) return false; // number
  if (/^(\/|~\/|~$|\.\.?\/|\.\/|[A-Za-z]:[\\/]|\\\\)/.test(tok)) return true;
  if (tok.includes('/') && !/\s/.test(tok) && !/^[\w.-]+\/\d+$/.test(tok)) return true; // a/b but not "1/2"
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(tok);
  if (m && KNOWN_EXT.has(m[1].toLowerCase())) return true;
  return /^(Dockerfile|Makefile|README|LICENSE|CLAUDE\.md)$/i.test(tok);
}

/**
 * Strip shell quoting and trailing punctuation from a token.
 * @param {string} tok
 * @returns {string}
 */
function cleanToken(tok) {
  let t = tok.replace(/^["'`(]+/, '').replace(/["'`),;:]+$/, '');
  t = t.replace(/^\$\(/, '');
  return t;
}

/**
 * Tokenise a shell command loosely: split on whitespace, drop operators, strip `key=` prefixes and quotes.
 * @param {string} cmd
 * @returns {string[]}
 */
export function bashPathTokens(cmd) {
  if (typeof cmd !== 'string') return [];
  const out = [];
  const seen = new Set();
  const parts = cmd.replace(/\\\n/g, ' ').split(/\s+/);
  for (let raw of parts) {
    if (!raw || BASH_SKIP.has(raw)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) raw = raw.slice(raw.indexOf('=') + 1); // FOO=/path
    if (/^--?[A-Za-z0-9-]+=/.test(raw)) raw = raw.slice(raw.indexOf('=') + 1); // --file=/path
    const tok = cleanToken(raw);
    if (!tok || tok.startsWith('-') || seen.has(tok)) continue;
    if (!looksLikePath(tok)) continue;
    if (/^[|&<>]+$/.test(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Guess the user's home directory from an absolute cwd (used in the browser where os.homedir is unavailable).
 * @param {string|null|undefined} cwd
 * @returns {string|null}
 */
export function guessHome(cwd) {
  if (typeof cwd !== 'string') return null;
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)/.exec(cwd);
  return m ? m[1] : null;
}

/**
 * Shorten an absolute path for display: relative to cwd when inside it, else `~/...` when inside home.
 * `~` prefixes and relative paths pass through unchanged.
 * @param {string} p
 * @param {PathCtx} [ctx]
 * @returns {string}
 */
export function displayPath(p, ctx = {}) {
  if (typeof p !== 'string' || !p) return '';
  let s = p.replace(/\\/g, '/');
  const cwd = ctx.cwd ? String(ctx.cwd).replace(/\\/g, '/').replace(/\/+$/, '') : null;
  const home = (ctx.home ? String(ctx.home) : guessHome(cwd) || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (home && (s === home || s.startsWith(home + '/'))) {
    // inside home: prefer cwd-relative when also inside cwd
    if (cwd && (s === cwd || s.startsWith(cwd + '/'))) return s === cwd ? '.' : s.slice(cwd.length + 1);
    return '~' + s.slice(home.length);
  }
  if (cwd && (s === cwd || s.startsWith(cwd + '/'))) return s === cwd ? '.' : s.slice(cwd.length + 1);
  return s;
}

/**
 * Elide the middle of a long display path, keeping the first and last segment.
 * @param {string} p
 * @param {number} [max=60]
 * @returns {string}
 */
export function elidePath(p, max = 60) {
  if (typeof p !== 'string' || p.length <= max) return p || '';
  const segs = p.split('/');
  if (segs.length <= 2) return p.slice(0, max - 1) + '…';
  const abs = segs[0] === '';                       // "/a/b/c" splits with an empty first segment
  const head = abs ? `/${segs[1] || ''}` : segs[0];
  const tail = segs[segs.length - 1];
  const s = `${head}/…/${tail}`;
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Extract the paths a tool call touches, in display form.
 * Read/Edit/Write/MultiEdit → file_path · NotebookEdit → notebook_path · Grep/Glob → path (+ pattern when path-like)
 * · Bash → command tokens that look like paths · anything else → any string field that looks like a path.
 * @param {string} tool
 * @param {Object|null|undefined} input
 * @param {PathCtx} [ctx]
 * @returns {string[]}
 */
export function extractPaths(tool, input, ctx = {}) {
  if (!input || typeof input !== 'object') return [];
  const raw = [];
  switch (tool) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit':
      if (typeof input.file_path === 'string') raw.push(input.file_path);
      break;
    case 'NotebookEdit':
      if (typeof input.notebook_path === 'string') raw.push(input.notebook_path);
      break;
    case 'Glob': {
      const base = typeof input.path === 'string' ? input.path : '';
      const pat = typeof input.pattern === 'string' ? input.pattern : '';
      if (pat) raw.push(base ? joinLoose(base, pat) : pat);
      else if (base) raw.push(base);
      break;
    }
    case 'Grep': {
      if (typeof input.path === 'string') raw.push(input.path);
      if (typeof input.pattern === 'string' && looksLikePath(input.pattern) && !/[\\|()[\]{}*+?^$]/.test(input.pattern)) raw.push(input.pattern);
      break;
    }
    case 'Bash':
      raw.push(...bashPathTokens(input.command));
      break;
    default:
      for (const k of Object.keys(input)) {
        const v = input[k];
        if (typeof v === 'string' && v.length < 512 && /path|file|dir/i.test(k) && looksLikePath(v)) raw.push(v);
      }
  }
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const d = displayPath(r, ctx);
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

/**
 * Join a base dir and a glob pattern without normalising away `**`.
 * @param {string} base
 * @param {string} pat
 * @returns {string}
 */
function joinLoose(base, pat) {
  if (/^(\/|~\/|[A-Za-z]:)/.test(pat)) return pat;
  return base.replace(/\/+$/, '') + '/' + pat.replace(/^\.?\//, '');
}

/**
 * Normalise `~` and separators in a path given from config or a hook payload. Pure string work only.
 * @param {string} p
 * @param {PathCtx} [ctx]
 * @returns {string}
 */
export function expandHome(p, ctx = {}) {
  if (typeof p !== 'string') return '';
  if (p === '~' || p.startsWith('~/')) return (ctx.home || '') + p.slice(1);
  return p;
}
