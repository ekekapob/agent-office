#!/usr/bin/env node
// server.js — Agent Deck. Reads Claude Code's own files and streams what it finds to a local page.
// Never calls a model, never writes under ~/.claude except the opt-in --install-hooks (ADR-0001, ADR-0006).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, loadConfig } from './server/config.js';
import { createLogger } from './server/log.js';
import { checkDataRoot, homeDir, openBrowser, projectSlug } from './server/platform.js';
import { createRegistry, subagentsDir } from './server/registry.js';
import { createTailer } from './server/tailer.js';
import { createState } from './server/state.js';
import { createSse } from './server/sse.js';
import { createHttpServer } from './server/http.js';
import { hooksStatus, installHooks, printHooks } from './server/hooks.js';
import { createDemoSource, emptySnapshot, replayTranscript } from './server/demo.js';
import { parseSubagentMeta, parseTranscriptLine } from './shared/adapter.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = readVersion();
const MIN_NODE = 20;

main().catch((e) => { process.stderr.write(`Agent Deck stopped: ${e && e.stack || e}\n`); process.exit(1); });

async function main() {
  const { config, flags, sources, warnings } = loadConfig({ argv: process.argv.slice(2) });

  if (flags.help) { process.stdout.write(HELP); return; }
  if (flags.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (flags.printHooks) { process.stdout.write(printHooks(config.port, config.host === '0.0.0.0' ? '127.0.0.1' : config.host) + '\n'); return; }
  if (flags.installHooks) {
    const log = createLogger({ level: config.log_level, file: null });
    const r = await installHooks({ port: config.port, yes: flags.yes, log });
    process.stdout.write(`\n${r.message}\n`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE) {
    process.stderr.write(`Agent Deck needs Node ${MIN_NODE} or newer; this is Node ${process.versions.node}.\n`
      + 'Install a newer Node (https://nodejs.org) and run it again.\n');
    process.exit(1);
  }

  const log = createLogger({ level: config.log_level, file: config.log_file });
  for (const w of warnings) log.warn(w);
  for (const s of sources) log.info(`config from ${s}`);

  const demo = flags.demo;
  const state = createState({ config, log, version: VERSION, dataRoot: demo ? '(demo)' : config.data_root });
  log.onEntry((e) => { if (e.level === 'error') state.noteError(e.msg, e.detail); });

  // In --demo the page talks to a real stream; only the source of truth is a recording (CONTRACTS §8).
  const demoFile = demo ? path.resolve(ROOT, config.demo_file || 'fixtures/demo.jsonl') : null;
  if (demo && !fs.existsSync(demoFile)) {
    console.error(`--demo needs a recording and there is none at ${demoFile}.\nPoint "demo_file" in agentdeck.json at one, or drop the file back in place.`);
    process.exit(1);
  }
  const demoSource = demo ? createDemoSource({ file: demoFile, log, health: { version: VERSION } }) : null;
  const source = demoSource || state;
  const facade = demoSource ? demoFacade(demoSource, VERSION) : state;
  const sse = createSse({ source, log });
  const http = createHttpServer({
    state: facade, sse, config, log, home: homeDir(),
    roots: { web: path.join(ROOT, 'web'), themes: path.join(ROOT, 'themes') },
    onHook: (h) => { if (!demo) state.applyHook(h); },
  });

  if (!demo && !flags.replay) {
    const check = checkDataRoot(config.data_root);
    if (!check.ok) {
      process.stderr.write(`\n${check.problem}\n${check.fix}\n\n`);
      process.exit(1);
    }
    if (check.problem) log.warn(check.problem);
  }

  const started = await http.listen(config.port, config.host);
  if (!started.ok) {
    process.stderr.write(`\n${started.problem}\n${started.fix}\n\n`);
    process.exit(1);
  }

  let watchers = null;
  if (demoSource) demoSource.start();
  else if (flags.replay) await startReplay(flags.replay, state, config, log);
  else watchers = startWatching({ config, log, state });

  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}/`;
  banner({ url, config, demo, replay: flags.replay, log });

  if (config.open_browser) {
    const ok = await openBrowser(url);
    if (!ok) log.warn('could not open a browser; open the address above yourself');
  }

  const tick = setInterval(() => { try { state.tick(); } catch (e) { log.error('housekeeping failed', e); } }, 1000);
  const shutdown = async (sig) => {
    log.info(`${sig}: shutting down`);
    clearInterval(tick);
    if (watchers) watchers.stop();
    if (demoSource) demoSource.stop();
    sse.close();
    await http.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('uncaughtException', (e) => { log.error('uncaught exception', e); state.noteError('internal error', e && e.message); });
  process.on('unhandledRejection', (e) => { log.error('unhandled rejection', e); });
}

// ---------------------------------------------------------------- live watching

/**
 * Wire the registry and the tailer into the state.
 * @param {{config:Object, log:Object, state:Object}} o
 * @returns {{stop:()=>void}}
 */
function startWatching(o) {
  const { config, log, state } = o;
  const home = homeDir();
  /** @type {Map<string,Object>} */
  const ctxs = new Map();          // tailer key → adapter TranscriptCtx
  /** @type {Map<string,number>} */
  const noFileSince = new Map();   // session id → when we first found no transcript
  const NO_FILE_GRACE_MS = 30000;  // a brand-new session has none for a moment; longer than that is a problem

  const tailer = createTailer({
    log,
    onLines(key, lines, meta) {
      const ctx = ctxFor(key, meta);
      /** @type {Array<Object>} */
      const events = [];
      for (const line of lines) {
        try { events.push(...parseTranscriptLine(line, ctx)); }
        catch (e) { log.error(`adapter threw on a line of ${key}`, e); }        // must not happen; guard anyway
      }
      if (events.length) state.apply(events, { silent: meta.bulk === true });
    },
    onSubagent(sessionId, agentId, files) { addSubagent(sessionId, agentId, files); },
  });

  const registry = createRegistry({
    dataRoot: config.data_root, config, log,
    onSession(s) {
      state.upsertSession(s);
      const fresh = tailer.add(s.id, s.transcriptPath, { sessionId: s.id, agentId: null, cwd: s.cwd });
      if (fresh) tailer.watchSubagents(s.id, subagentsDir(config.data_root, s.cwd, s.id));
      state.setAgentMeta(s.id, { transcriptPath: s.transcriptPath });   // the lead stays "Lead"; the session carries the name
      checkTranscript(s, fresh);
    },
    onRemoved(id) {
      state.removeSession(id);
      tailer.remove(id);
      for (const k of [...ctxs.keys()]) if (k === id || k.startsWith(`${id}/`)) ctxs.delete(k);
    },
  });

  /**
   * A session whose transcript never appears shows what the registry knows and is flagged `unreadable`
   * once the grace period is past — a brand-new session has no file for a moment (ADR-0008).
   * @param {Object} s @param {boolean} fresh
   */
  function checkTranscript(s, fresh) {
    if (fs.existsSync(s.transcriptPath)) { noFileSince.delete(s.id); return; }
    if (!noFileSince.has(s.id)) {
      noFileSince.set(s.id, Date.now());
      if (fresh) log.warn(`no transcript at ${s.transcriptPath} for ${s.name}; only registry data will show`);
      return;
    }
    if (Date.now() - noFileSince.get(s.id) > NO_FILE_GRACE_MS) state.markUnreadable(s.id, `no transcript at ${s.transcriptPath}`);
  }

  /**
   * Timestamp of a transcript's first record. Resuming a session copies the old subagent files into the
   * new session's folder, so the file's mtime is the copy time and useless; the first record is its age.
   * @param {string} file @returns {number|null}
   */
  function firstRecordTime(file) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      // The opening record carries the system prompt and can be hundreds of kilobytes, so read generously
      // and take the first line that parses and carries a timestamp.
      const buf = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf8');
      const lines = text.split('\n');
      const whole = text.endsWith('\n') ? lines : lines.slice(0, -1);   // drop a line cut by the read
      for (const line of whole) {
        if (!line) continue;
        try {
          const t = Date.parse(JSON.parse(line).timestamp);
          if (Number.isFinite(t)) return t;
        } catch { /* keep looking */ }
      }
      return null;
    } catch { return null; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
  }

  /** Register a subagent transcript the moment its file appears. */
  function addSubagent(sessionId, agentId, files) {
    const id = `${sessionId}/${agentId}`;
    const sess = state.getSession(sessionId);
    if (!sess) return false;                            // registry has not caught up: decide on the next pass
    let meta = {};
    if (files.meta) {
      try { meta = parseSubagentMeta(JSON.parse(fs.readFileSync(files.meta, 'utf8')), { sessionId, agentId }); }
      catch (e) { log.warn(`cannot read the meta file for ${agentId}`, e); }
    }
    const born = firstRecordTime(files.transcript);
    if (born && sess.startedAt && born < sess.startedAt - 2000) {
      log.info(`subagent ${agentId} predates this session; it is copied history, not activity`);
      return true;                                      // a resumed session carries the old crew's files
    }

    // Create or refresh the Agent. `toolUseId` links it to the assistant message that spawned it, which is
    // how state.js finds huddles; the model stays whatever the parent resolved, if it knows better.
    state.apply([{
      kind: 'agent_spawn', sessionId, toolUseId: meta.toolUseId || `meta:${agentId}`, agentId,
      type: meta.type || 'agent', description: meta.name || '', brief: '', model: null, t: born || Date.now(),
    }]);
    const existing = state.getAgent(id);
    state.setAgentMeta(id, { transcriptPath: files.transcript, model: existing && existing.model ? undefined : meta.model });
    const big = safeSize(files.transcript) > 2 * 1024 * 1024;
    if (tailer.add(id, files.transcript, { sessionId, agentId, bulk: big })) log.info(`subagent ${agentId} · ${meta.type || 'agent'}`);
    return true;
  }

  function ctxFor(key, meta) {
    let c = ctxs.get(key);
    if (!c) {
      c = { sessionId: meta.sessionId, agentId: meta.agentId ?? null, version: null, cwd: meta.cwd ?? null,
        home, pendingTools: new Map(), seenDrift: new Set(), now: Date.now() };
      ctxs.set(key, c);
    }
    return c;
  }

  let stopped = false;
  let pass = 0;
  const loop = async () => {
    if (stopped) return;
    try { await registry.poll(); } catch (e) { log.error('registry poll failed', e); }
    try { await tailer.poll(); } catch (e) { log.error('transcript poll failed', e); }
    if (++pass % 20 === 0) for (const s of registry.list()) checkTranscript(s, false);
    if (!stopped) timer = setTimeout(loop, config.poll_ms);
  };
  let timer = setTimeout(loop, 0);

  return { stop() { stopped = true; clearTimeout(timer); registry.close(); tailer.close(); } };
}

function safeSize(file) { try { return fs.statSync(file).size; } catch { return 0; } }

// ---------------------------------------------------------------- replay

async function startReplay(file, state, config, log) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    process.stderr.write(`\nThere is no file at ${full}.\nPass --replay with a path to a .jsonl transcript.\n\n`);
    process.exit(1);
  }
  log.info(`replaying ${full} at 20×`);
  replayTranscript({ file: full, state, config, log, speed: 20 })
    .catch((e) => log.error('replay failed', e));
}

// ---------------------------------------------------------------- output

function banner({ url, config, demo, replay, log }) {
  const hooks = hooksStatus(config.port);
  const lines = [
    '',
    `Agent Deck ${VERSION}`,
    `  data root  ${demo ? '(demo recording)' : config.data_root}${config.mode === 'docker' ? '  · docker mode, liveness by file freshness' : ''}`,
    `  mode       ${demo ? 'demo — a recorded sequence on a 125 s loop' : replay ? `replay — ${path.basename(replay)} at 20×` : 'live — watching Claude Code'}`,
    `  hooks      ${hooks.installed ? `installed for ${hooks.events.join(', ')}` : 'not installed — approval waits appear only once answered'}`,
    hooks.installed ? null : `             run  node server.js --print-hooks   to see the snippet`,
    `  open       ${url}`,
    '',
  ].filter((l) => l !== null);
  process.stdout.write(lines.join('\n') + '\n');
  log.info(`listening on ${url}`);
}

/** A read-only façade so /api/state and /api/health work identically in --demo. */
function demoFacade(demoSource, version) {
  return {
    snapshot: () => demoSource.snapshot(),
    health: () => ({ ...emptySnapshot().health, ...demoSource.snapshot().health, version, dataRoot: '(demo)' }),
    noteError: () => {},
    tick: () => {},
  };
}

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

export { projectSlug };
