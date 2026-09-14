// server/platform.js — per-OS data root, project slug, pid liveness, WSL paths, browser opening (ADR-0009).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const PID_CACHE_MS = 5000;
/** @type {Map<number,{alive:boolean,at:number}>} */
const pidCache = new Map();

/** The user's home folder (AGENTDECK_HOME overrides it for tests). @returns {string} */
export function homeDir(env = process.env) {
  return env.AGENTDECK_HOME || os.homedir() || env.HOME || env.USERPROFILE || '/';
}

/** True when running inside WSL (Linux kernel built by Microsoft). @returns {boolean} */
export function isWsl() {
  if (process.platform !== 'linux') return false;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

/** True when docker mode is requested (AGENTDECK_MODE=docker) or we are inside a container. @returns {boolean} */
export function isDockerMode(env = process.env) {
  if (env.AGENTDECK_MODE === 'docker') return true;
  if (env.AGENTDECK_MODE === 'native') return false;
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

/**
 * Default data root: macOS/Linux `~/.claude`, Windows `%USERPROFILE%\.claude`, docker `/data/claude` when present.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultDataRoot(env = process.env) {
  if (env.AGENTDECK_DATA_ROOT) return normalizeDataRoot(env.AGENTDECK_DATA_ROOT, env);
  if (isDockerMode(env) && fs.existsSync('/data/claude')) return '/data/claude';
  if (process.platform === 'win32') return path.join(env.USERPROFILE || homeDir(env), '.claude');
  return path.join(homeDir(env), '.claude');
}

/**
 * Expand `~`, accept `\\wsl$\<distro>\...` UNC paths on Windows, and map `C:\...` to `/mnt/c/...` inside WSL.
 * @param {string} p
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function normalizeDataRoot(p, env = process.env) {
  if (typeof p !== 'string' || !p) return defaultDataRoot(env);
  let s = p.trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(homeDir(env), s.slice(2));
  if (isWsl()) {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(s);
    if (m) s = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }
  if (process.platform === 'win32' && /^\\\\wsl(\$|\.localhost)\\/i.test(s)) return s; // UNC path, Node handles it
  return path.resolve(s);
}

/**
 * Is `dataRoot` the local user's own `~/.claude` (so pid liveness is meaningful)?
 * @param {string} dataRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isLocalDataRoot(dataRoot, env = process.env) {
  try {
    const a = fs.realpathSync(dataRoot);
    const b = fs.realpathSync(path.join(homeDir(env), '.claude'));
    return a === b;
  } catch { return false; }
}

/**
 * Claude Code encodes a cwd into the project folder name: every path separator, dot and drive colon becomes '-'.
 * `/Users/me/Documents/GitHub/agent-workspace` → `-Users-john-Documents-GitHub-agent-workspace`.
 * @param {string} cwd
 * @returns {string}
 */
export function projectSlug(cwd) {
  return String(cwd || '').replace(/[\\/.:]/g, '-');
}

/**
 * Where the lead transcript of a session lives.
 * @param {string} dataRoot @param {string} cwd @param {string} sessionId
 * @returns {string}
 */
export function transcriptPath(dataRoot, cwd, sessionId) {
  return path.join(dataRoot, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Is a process alive? POSIX: `kill(pid, 0)` (EPERM counts as alive). Windows: `tasklist` with a short timeout,
 * cached for a few seconds per pid so polling does not spawn a process every tick.
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try { process.kill(pid, 0); return Promise.resolve(true); } catch (e) { return Promise.resolve(e.code === 'EPERM'); }
  }
  const c = pidCache.get(pid);
  const now = Date.now();
  if (c && now - c.at < PID_CACHE_MS) return Promise.resolve(c.alive);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { timeout: 1500, windowsHide: true }, (err, stdout) => {
      const alive = !err && typeof stdout === 'string' && stdout.includes(`"${pid}"`);
      pidCache.set(pid, { alive, at: Date.now() });
      resolve(alive);
    });
  });
}

/**
 * Open a URL in the default browser: macOS `open`, Linux `xdg-open`, Windows `start`. Failures are reported, not thrown.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export function openBrowser(url) {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url.replace(/&/g, '^&')]; }
    else if (isWsl()) { cmd = 'cmd.exe'; args = ['/c', 'start', '""', url.replace(/&/g, '^&')]; }
    else { cmd = 'xdg-open'; args = [url]; }
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}

/**
 * Plain-English check of the data root.
 * @param {string} dataRoot
 * @returns {{ok:boolean, problem?:string, fix?:string}}
 */
export function checkDataRoot(dataRoot) {
  try {
    const st = fs.statSync(dataRoot);
    if (!st.isDirectory()) return { ok: false, problem: `${dataRoot} is not a folder.`, fix: 'Point --data-root at your .claude folder.' };
  } catch {
    return { ok: false, problem: `Data root ${dataRoot} does not exist.`, fix: 'Run Claude Code once, or pass --data-root <path to .claude>.' };
  }
  try { fs.accessSync(dataRoot, fs.constants.R_OK); } catch {
    return { ok: false, problem: `No permission to read ${dataRoot}.`, fix: 'Check the folder permissions or run as the user who owns it.' };
  }
  const sessions = path.join(dataRoot, 'sessions');
  if (!fs.existsSync(sessions)) return { ok: true, problem: `${sessions} is missing; no live sessions will appear until Claude Code creates it.` };
  return { ok: true };
}
