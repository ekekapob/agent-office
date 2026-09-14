// server/config.js — defaults (CONTRACTS §8), agentdeck.json from cwd then ~/.config/agentdeck/, flags override.
import fs from 'node:fs';
import path from 'node:path';
import { defaultDataRoot, homeDir, isDockerMode, normalizeDataRoot } from './platform.js';

/**
 * @typedef {Object} Config
 * @property {string} data_root
 * @property {number} port
 * @property {string} host
 * @property {boolean} open_browser
 * @property {number} poll_ms
 * @property {string} theme
 * @property {number} context_warn_pct
 * @property {number} context_compact_pct
 * @property {Object<string,number>} context_limits
 * @property {number} stale_after_s
 * @property {string[]} sessions_include
 * @property {string[]} sessions_exclude
 * @property {boolean} hooks_enabled
 * @property {boolean} controls_enabled
 * @property {string} log_level
 * @property {string} log_file
 * @property {'native'|'docker'} mode   'docker' when AGENTDECK_MODE=docker: liveness by file freshness, no pid checks
 */

/**
 * @typedef {Object} Flags
 * @property {number|null} port
 * @property {string|null} host
 * @property {string|null} dataRoot
 * @property {boolean} demo
 * @property {string|null} replay
 * @property {boolean} noOpen
 * @property {boolean} printHooks
 * @property {boolean} installHooks
 * @property {boolean} verbose
 * @property {boolean} yes
 * @property {boolean} help
 * @property {boolean} version
 * @property {string[]} unknown
 */

/** Keys `agentdeck.json` may set. Anything else, apart from `_`-prefixed comments, earns a warning. */
const KNOWN_KEYS = new Set(['data_root', 'port', 'host', 'open_browser', 'poll_ms', 'theme', 'context_warn_pct',
  'context_compact_pct', 'context_limits', 'stale_after_s', 'sessions_include', 'sessions_exclude',
  'hooks_enabled', 'controls_enabled', 'log_level', 'log_file', 'agent_quiet_s', 'demo_file']);

export const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  default: 200000,
  'claude-fable-5-1': 1000000,
  'claude-opus-5': 1000000,
  'claude-sonnet-5': 1000000,
  'claude-haiku-4-5-20251001': 200000,
});

/** Built-in defaults for the current OS. @param {NodeJS.ProcessEnv} [env] @returns {Config} */
export function defaults(env = process.env) {
  return {
    data_root: defaultDataRoot(env),
    port: 7777,
    host: '127.0.0.1',
    open_browser: true,
    poll_ms: 500,
    theme: 'spaceship',
    context_warn_pct: 85,
    context_compact_pct: 96,
    context_limits: { ...DEFAULT_CONTEXT_LIMITS },
    stale_after_s: 180,
  // a subagent that writes nothing for this long, while its session lives on, is treated as ended
  agent_quiet_s: 600,
  // where --demo reads its recording; may sit outside the repo
  demo_file: 'fixtures/demo.jsonl',
    sessions_include: [],
    sessions_exclude: [],
    hooks_enabled: false,
    controls_enabled: false,
    log_level: 'info',
    log_file: path.join(configDir(env), 'agentdeck.log'),
    mode: isDockerMode(env) ? 'docker' : 'native',
  };
}

/** `~/.config/agentdeck` (or `%APPDATA%\agentdeck` on Windows). @param {NodeJS.ProcessEnv} [env] @returns {string} */
export function configDir(env = process.env) {
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'agentdeck');
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config'), 'agentdeck');
}

/**
 * Context window for a model: exact table entry, else by family name, else `default`.
 * @param {string|null} model
 * @param {Object<string,number>} [limits]
 * @returns {number}
 */
export function ctxLimitFor(model, limits = DEFAULT_CONTEXT_LIMITS) {
  if (!model) return limits.default || 200000;
  if (Number.isFinite(limits[model])) return limits[model];
  const m = model.toLowerCase();
  if (/\[1m\]/.test(m)) return 1000000;
  for (const k of Object.keys(limits)) if (k !== 'default' && m.startsWith(k.toLowerCase())) return limits[k];
  if (/haiku/.test(m)) return limits['claude-haiku-4-5-20251001'] || 200000;
  if (/fable|opus|sonnet/.test(m)) return 1000000;
  return limits.default || 200000;
}

/**
 * Parse CLI flags. Unknown flags are collected, not fatal.
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {Flags}
 */
export function parseFlags(argv) {
  /** @type {Flags} */
  const f = { port: null, host: null, dataRoot: null, demo: false, replay: null, noOpen: false, printHooks: false, installHooks: false,
    verbose: false, yes: false, help: false, version: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    switch (key) {
      case '--port': { const n = Number(val()); f.port = Number.isInteger(n) && n > 0 && n < 65536 ? n : NaN; break; }
      case '--host': f.host = val() || null; break;
      case '--data-root': f.dataRoot = val() || null; break;
      case '--demo': f.demo = true; break;
      case '--replay': f.replay = val() || null; break;
      case '--no-open': f.noOpen = true; break;
      case '--print-hooks': f.printHooks = true; break;
      case '--install-hooks': f.installHooks = true; break;
      case '--verbose': case '-v': f.verbose = true; break;
      case '--yes': case '-y': f.yes = true; break;
      case '--help': case '-h': f.help = true; break;
      case '--version': f.version = true; break;
      default: f.unknown.push(a);
    }
  }
  return f;
}

/**
 * Load config: defaults ← ~/.config/agentdeck/agentdeck.json ← ./agentdeck.json ← flags.
 * Bad values fall back to defaults with a warning; nothing throws.
 * @param {{argv?:string[], env?:NodeJS.ProcessEnv, cwd?:string}} [opts]
 * @returns {{config:Config, flags:Flags, sources:string[], warnings:string[]}}
 */
export function loadConfig(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const flags = parseFlags(opts.argv || []);
  const config = defaults(env);
  const sources = [];
  const warnings = [];
  for (const file of [path.join(configDir(env), 'agentdeck.json'), path.join(cwd, 'agentdeck.json')]) {
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && typeof json === 'object') { applyFile(config, json, warnings, file); sources.push(file); }
      else warnings.push(`${file}: expected a JSON object, ignored.`);
    } catch (e) { warnings.push(`${file}: ${e.message}; ignored.`); }
  }
  if (flags.port !== null) {
    if (Number.isNaN(flags.port)) warnings.push('--port must be a number between 1 and 65535; using the default.');
    else config.port = flags.port;
  }
  if (flags.host) config.host = flags.host;
  if (flags.dataRoot) config.data_root = normalizeDataRoot(flags.dataRoot, env);
  if (flags.noOpen) config.open_browser = false;
  if (flags.verbose) config.log_level = 'debug';
  if (flags.unknown.length) warnings.push(`Unknown flag(s): ${flags.unknown.join(' ')} (see --help).`);
  config.data_root = normalizeDataRoot(config.data_root, env);
  return { config, flags, sources, warnings };
}

/** Merge a config file into `cfg` with type checks; bad values are reported and kept at their previous value. */
function applyFile(cfg, json, warnings, file) {
  const num = (k, min, max) => {
    const v = json[k]; if (v === undefined) return;
    if (Number.isFinite(v) && v >= min && v <= max) cfg[k] = v; else warnings.push(`${file}: ${k} must be a number in [${min}, ${max}]; kept ${cfg[k]}.`);
  };
  const bool = (k) => {
    const v = json[k]; if (v === undefined) return;
    if (typeof v === 'boolean') cfg[k] = v; else warnings.push(`${file}: ${k} must be true or false; kept ${cfg[k]}.`);
  };
  const strv = (k) => {
    const v = json[k]; if (v === undefined) return;
    if (typeof v === 'string' && v) cfg[k] = v; else warnings.push(`${file}: ${k} must be a non-empty string; kept ${cfg[k]}.`);
  };
  const list = (k) => {
    const v = json[k]; if (v === undefined) return;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) cfg[k] = v.slice(); else warnings.push(`${file}: ${k} must be a list of strings; kept it.`);
  };
  for (const k of Object.keys(json)) {
    if (k.startsWith('_')) continue;              // `_`-prefixed keys are comments (CONTRACTS §8)
    if (!KNOWN_KEYS.has(k)) warnings.push(`${file}: unknown key "${k}"; ignored.`);
  }
  if (json.data_root === null) cfg.data_root = defaultDataRoot(); // explicit null means "per-OS default"
  else strv('data_root');
  strv('host'); strv('theme'); strv('log_level'); strv('log_file'); strv('demo_file');
  num('port', 1, 65535); num('poll_ms', 50, 60000); num('context_warn_pct', 1, 100); num('context_compact_pct', 1, 100); num('stale_after_s', 1, 86400); num('agent_quiet_s', 60, 86400);
  bool('open_browser'); bool('hooks_enabled'); bool('controls_enabled');
  list('sessions_include'); list('sessions_exclude');
  if (json.context_limits !== undefined) {
    if (json.context_limits && typeof json.context_limits === 'object') {
      for (const [k, v] of Object.entries(json.context_limits)) {
        if (Number.isFinite(v) && v > 0) cfg.context_limits[k] = v; else warnings.push(`${file}: context_limits.${k} must be a positive number; ignored.`);
      }
    } else warnings.push(`${file}: context_limits must be an object; ignored.`);
  }
}

export const HELP = `Agent Deck — local dashboard for Claude Code sessions

Usage: node server.js [flags]

  --port <n>          listen on this port (default 7777)
  --host <addr>       bind address (default 127.0.0.1; use 0.0.0.0 inside a container)
  --data-root <path>  Claude Code data folder (default ~/.claude)
  --demo              play fixtures/demo.jsonl in a loop; no Claude Code needed
  --replay <file>     play a recorded transcript through the adapter at 20x speed
  --no-open           do not open the browser
  --print-hooks       print the hooks JSON snippet for ~/.claude/settings.json
  --install-hooks     merge the hooks into ~/.claude/settings.json (diff, backup, confirmation)
  --yes               answer yes to --install-hooks
  --verbose           debug logging
  --help, --version

Config: agentdeck.json in the current folder or ~/.config/agentdeck/. Flags win over the file.
`;
