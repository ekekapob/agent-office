# Agent Deck

Agent Deck is a local web dashboard that shows what every Claude Code session on your machine is doing, drawn as a 2.5D isometric pixel-art deck. One session is one room; the session lead and every subagent is a person at a console with a speech bubble showing the tool it is running right now; agents spawned together in one turn get a glass "huddle" pod with their shared goal and the files they converge on. It reads the files Claude Code already writes under `~/.claude` and never calls a model, so it costs zero tokens and has no effect on your sessions. The product spec is [`../docs/PRD.md`](../docs/PRD.md), the decisions are in [`../docs/adr/`](../docs/adr/), and the visual reference is the mockup set in [`../mockups/`](../mockups/) (`f-spaceship-deck.html` for the deck, `a-office-building.html` for the future multi-session overview).

## Quick start

Requires Node 20 or newer. No install step, no npm packages.

```sh
cd agent-deck
node server.js            # reads ~/.claude, serves http://127.0.0.1:7777 and opens it
node server.js --demo     # scripted sample session, no Claude Code needed (see Demo recording)
```

Or through the package scripts: `npm start`, `npm run demo`, `npm test`, `npm run smoke`.

| Flag | Meaning | Config key |
|---|---|---|
| `--port <n>` | Listen on this port (default 7777) | `port` |
| `--data-root <dir>` | Where Claude Code keeps its files (default per OS, see below) | `data_root` |
| `--demo` | Replay a recorded timeline instead of reading `~/.claude`. Needs a recording; see `demo_file` | `demo_file` |
| `--replay <file>` | Replay a recorded event file the same way | |
| `--no-open` | Do not open a browser on start | `open_browser: false` |
| `--print-hooks` | Print the Claude Code hook snippet and exit | |
| `--install-hooks` | Merge the hook snippet into `~/.claude/settings.json` after showing a diff, asking, and writing a backup | |
| `--verbose` | Record-level detail in the log | `log_level: "debug"` |
| `--host <addr>` | Bind address (default `127.0.0.1`; Docker uses `0.0.0.0` inside the container) | `host` |

Keyboard in the page: `Esc` clears the selection or leaves the maximised view, `+`/`-` zoom, `F` full screen, `0` fit. URL hash: `#session=<id>`, `#pin=<agentId>`, `#theme=<name>`.

## Demo recording

`--demo` replays a recorded timeline so the page can be run, demoed and smoke-tested with no Claude Code
running. The recording is not kept in this repo. Point `demo_file` at one:

```json
{ "demo_file": "/path/to/demo.jsonl" }
```

in `agentdeck.json`, or drop a file at `fixtures/demo.jsonl`. Without it, `--demo` and the smoke test say so
and stop. Live mode is unaffected.

## Live approval alerts (hooks)

The transcript only records the outcome of a permission prompt, not the wait. Without a hook, Agent Deck shows "waiting for approval" a moment late, when the tool result lands. A `PermissionRequest` hook makes it immediate: Claude Code runs the hook command while the prompt is up, the command posts the payload to Agent Deck, and the agent raises a hand with a bouncing amber `?`.

Hooks are optional, fire-and-forget and never block a session: the command is `curl --max-time 0.3 -s`, always exits 0, and the server treats the payload as untrusted data. Nothing is written under `~/.claude` unless you choose one of the two ways below (ADR-0006).

**Way 1, print and paste.** Print the snippet for your port, then add it to the `hooks` object in `~/.claude/settings.json` (create the file if it does not exist):

```sh
node server.js --print-hooks
```

The output looks like this (the printed version is authoritative, it uses your configured port):

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [ { "type": "command",
          "command": "curl --max-time 0.3 -s -X POST http://127.0.0.1:7777/hook/PermissionRequest -d @- >/dev/null 2>&1 || true" } ] }
    ]
  }
}
```

`SubagentStart`, `SubagentStop`, `PreCompact` and `Notification` follow the same one-line pattern with their own `/hook/<Event>` path and are nice to have: the transcript covers them with a small delay anyway.

**Way 2, guided install.**

```sh
node server.js --install-hooks
```

This reads `~/.claude/settings.json`, shows the exact change as a diff, asks for confirmation, writes a backup `settings.json.bak` next to the file, and only then merges the entries. Existing hooks are kept.

Check it works: open `http://127.0.0.1:7777/api/health` and look for `"hooksSeen": true` after the first permission prompt. Until a hook has been received the panel says "approval hook: not installed".

## Configuration

Optional file `agentdeck.json`, searched in the working directory (next to `server.js`) and then in `~/.config/agentdeck/`. Every key has a default; flags override the file. Start from [`agentdeck.example.json`](agentdeck.example.json), which lists every key with a comment:

```sh
cp agentdeck.example.json agentdeck.json
```

A small example that changes only what matters:

```json
{
  "port": 7777,
  "theme": "office",
  "context_warn_pct": 80,
  "sessions_exclude": ["**/scratch/**"],
  "context_limits": { "default": 200000, "claude-fable-5-1": 1000000 }
}
```

## Docker

Native is the primary way to run (it sees your processes). Docker works with a read-only bind mount of `~/.claude` (ADR-0009):

```sh
cd agent-deck
docker compose up --build         # then open http://localhost:7777
```

Without compose:

```sh
docker build -t agent-deck .
docker run --rm -p 127.0.0.1:7777:7777 -v "$HOME/.claude:/data/claude:ro" agent-deck
```

What differs inside a container:

- The mount is read-only; the container never writes to your files. `--install-hooks` is a host-side action, run it natively.
- The container cannot see host processes, so session liveness comes from file freshness: a session with no file change for `stale_after_s` (default 180 s) is labelled "stale?". `/api/health` reports `"mode": "docker"`.
- File-change notifications do not cross the Docker Desktop VM boundary; Agent Deck polls anyway, so nothing is lost.
- Hooks on the host post to `http://127.0.0.1:7777/hook/...` as usual because the port is published.

## Windows and WSL

- **Native Windows**: install Node 20+, run `node server.js` in PowerShell. The default data root is `%USERPROFILE%\.claude`; process liveness uses `tasklist`.
- **Claude Code in WSL, Agent Deck in WSL** (simplest): run `node server.js --no-open` inside the distro and open `http://127.0.0.1:7777` from a Windows browser; WSL2 forwards localhost.
- **Claude Code in WSL, Agent Deck on Windows**: point at the WSL home, for example `node server.js --data-root \\wsl$\Ubuntu\home\<user>\.claude`. PIDs cannot be checked across the boundary, so liveness falls back to file freshness like Docker.
- Claude Code encodes each project's working directory into a folder name under `projects/`; the separators differ per OS and `server/platform.js` decodes them, so mixed setups still show the right `cwd`.

## Architecture in ten lines

1. `server/registry.js` polls `~/.claude/sessions/*.json` every 500 ms and upserts `Session`s.
2. `server/tailer.js` tracks each transcript, reads only appended bytes, and hands lines to the adapter.
3. `shared/adapter.js` is the only code that knows raw Claude Code shapes; it is pure, runs in Node and the browser, and turns records into domain events. Missing fields become `drift` alerts, never exceptions.
4. `server/state.js` applies events to the in-memory model and derives huddles (several `Agent` calls in one assistant message), alerts and the feed.
5. `server/sse.js` streams a full snapshot on connect and deltas after; `server/http.js` serves the static page, `/api/state`, `/api/health`, `/hook/<event>`.
6. `web/js/store.js` mirrors the model in the page; `stream.js` reconnects on its own.
7. `web/js/layout.js` turns state into a `Scene` (tiles, walls, props, people, pods) and owns every transition timer: walk paths, pod rise, beam out and in.
8. `web/js/renderer/*` draws a scene behind one interface: `createRenderer(kind, canvas, theme)` returning `resize`, `setCamera`, `render`, `project`, `pick`, `portrait`, `destroy`. `iso2d` is the only implementation today; a 3D one would implement the same seven functions.
9. `overlays.js`, `panel.js` and `rooms.js` sit above the canvas in HTML and place themselves with `project()` and `pick()` only, so they work with any renderer.
10. `themes/*.json` are data, not code: palette, prop colours, figure palettes per agent type, state colours, model chips, labels. `theme.js` validates them and falls back to `spaceship` for missing keys.

## Adding a theme

1. Copy `themes/spaceship.json` to `themes/<name>.json`.
2. Set `name` and `label`, then edit the sections you care about: `palette`, `props`, `figures` (one entry per subagent type plus `lead` and `default`), `states`, `models`, `text` (deck, door, board, pod, pad labels) and `features` (`stars`, `viewports`, `planet`). Unknown keys are ignored; anything missing falls back to `spaceship`, so a partial file is fine.
3. Select it with `"theme": "<name>"` in `agentdeck.json`, with `#theme=<name>` in the URL, or from the theme select in the top bar.

No JavaScript changes are needed. If a look needs new geometry rather than new colours, that is a renderer change, not a theme.

## Tests and smoke

```sh
node --test tests/        # adapter, paths, state, layout unit tests against recorded fixtures
node tools/smoke.mjs      # headless-Chrome smoke test against --demo, ~45 s, needs Chrome
```

The smoke script starts its own server on port 7799, drives a headless Chrome over the DevTools protocol, and checks the DOM contract: ids present, no error toasts, hover card on a person, pin and Escape, wheel zoom, recenter, rooms list click, full screen, and a huddle card plus a live stream after 25 s of the demo. It writes one screenshot per step, `server.log`, `console.log` and `results.json` to `tools/smoke-out/` and exits 1 if any step failed. Set `CHROME=/path/to/chrome` if Chrome is not in the default place; `SMOKE_HEADFUL=1` shows the browser. See [`tests/README.md`](tests/README.md) for what each test covers and how to record a fixture for a new Claude Code version.

## Troubleshooting

- **"data root missing"** at start: Claude Code has not written `~/.claude` yet on this machine, or it lives elsewhere. Run Claude Code once, or pass `--data-root <dir>` (or set `data_root`). In Docker, check the bind mount path in `compose.yaml` and that it is your home directory, not the container's.
- **"port 7777 in use"**: another Agent Deck or something else has the port. Use `--port 7778`, or find the owner with `lsof -i :7777` (macOS/Linux) or `netstat -ano | findstr 7777` (Windows).
- **"format changed" warnings** (drift alerts): a Claude Code update renamed or dropped a field the adapter expects. The affected value shows as unknown and everything else keeps working. `/api/health` lists the fields under `drift` with a sample record id. Please record a fixture for that version (see `tests/README.md`) and open an issue.
- **Stale sessions in Docker**: without process visibility a session that ended without removing its registry file stays visible as "stale?" until `stale_after_s` passes, and a session that is quietly waiting for you can also look stale after that time. Tune `stale_after_s`, or run natively for exact liveness.
- **A session is missing**: check `sessions_include` / `sessions_exclude`, then `/api/health` for the session count and last errors. An unreadable transcript marks only that session `unreadable`; the others continue.
- **Nothing updates, footer counter is red**: click the footer counter to see the error toasts; each has a copy button. The connection strip in the top bar says live / reconnecting / disconnected with the age of the last event.
- **Smoke test: "Chrome not found"**: set `CHROME`. On Node 20 or 21 the script re-runs itself with `--experimental-websocket`; Node 22+ needs nothing.
- **Node too old**: the server needs Node 20+ (`node --version`).

## Zero tokens, read-only

Agent Deck never calls a model and sends nothing to the network except the optional Google Fonts request (system fonts are the fallback). It reads Claude Code's files and hook payloads; it does not send prompts, does not summarise, and does not invent conversations between agents. The only write under `~/.claude` is the hook snippet, and only through `--install-hooks` after you confirm the diff.

## Project layout

```
agent-deck/
  server.js                 entry: parse flags, load config, start http + watchers
  server/
    config.js               defaults + agentdeck.json loader + flags
    platform.js             data root per OS, slug decoding, pid alive, WSL paths
    log.js                  leveled logger to stderr + rotating file
    registry.js             poll ~/.claude/sessions/*.json → Session upserts/removals
    tailer.js               track transcript files, read appended bytes, emit lines
    state.js                in-memory model + event bus (huddles, alerts, feed)
    sse.js                  /events endpoint: snapshot on connect, deltas after
    http.js                 static files, /api/state, /api/health, /hook/<event>, /control (disabled)
    hooks.js                --print-hooks / --install-hooks (diff, backup, confirm)
    demo.js                 --demo and --replay: feed recorded events on a timeline
  shared/
    types.js                JSDoc typedefs (domain model, scene model, events)
    adapter.js              raw Claude Code records → domain events (pure, Node and browser)
    paths.js                extract file paths from tool inputs (pure)
  web/
    index.html              shell: top bar, stage, panel, footer
    css/app.css
    js/main.js              wires store, stream, theme, camera, renderer, overlays, panel, errors
    js/store.js             state container: apply(event), getState(), subscribe()
    js/stream.js            EventSource client with reconnect + status
    js/layout.js            state → Scene (positions, seats, pods, hallway, transitions)
    js/camera.js            pan, stepped zoom about a point, glide, fit, fullscreen
    js/theme.js             load + validate theme JSON, expose lookups
    js/overlays.js          bubbles, name plates, chips, hover/pin card, portraits
    js/panel.js             right panel: attention, session, assignment, huddles, crew, feed, how-to
    js/rooms.js             drop-up rooms list with click-to-fly
    js/errors.js            toasts, footer counter, global handlers, guarded loop helper
    js/renderer/index.js    createRenderer(kind, canvas, theme) factory
    js/renderer/iso2d/      renderer.js, primitives.js, figure.js, props.js
  themes/spaceship.json, themes/office.json
  fixtures/                 real recorded files (see fixtures/README.md)
  tests/                    node:test — adapter, paths, layout, state
  tools/smoke.mjs           headless Chrome via CDP against --demo
  Dockerfile, compose.yaml, agentdeck.example.json
```
