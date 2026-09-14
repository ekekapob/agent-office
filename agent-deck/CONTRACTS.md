# Agent Deck — Build Contracts

Read this before writing any file. It is the agreement between the modules so five people can build in parallel and integrate without surprises. Decisions come from `../docs/adr/`. Ground truth about Claude Code's files is in `fixtures/README.md`.

## 0. Rules

- Node 20+, plain JavaScript, **zero npm dependencies**, ES modules everywhere (`"type": "module"`). No TypeScript, no bundler, no framework.
- Every exported function gets a JSDoc comment with types from `shared/types.js`.
- Never throw across a module boundary for expected failures (bad line, missing field, unreadable file). Return `null`/skip and call `log.warn` or `errors.report`. Only programmer errors throw.
- No file under `~/.claude` is ever written by this program, except the opt-in `--install-hooks` (server owner only).
- Keep each module under ~400 lines. If it grows, split by responsibility, not by layer.
- Text shown to the user is plain and short. Colours and labels come from the theme or config, not literals in logic.

## 1. Layout of the repo

```
agent-deck/
  server.js                 entry: parse flags, load config, start http + watchers
  server/
    config.js               defaults + agentdeck.json/TOML-less JSON loader + flags
    platform.js             data root per OS, slug decoding, pid alive, WSL paths
    log.js                  leveled logger to stderr + rotating file
    registry.js             poll ~/.claude/sessions/*.json → Session upserts/removals
    tailer.js               track transcript files, read appended bytes, emit lines
    state.js                in-memory model + event bus (containers, snapshot, housekeeping)
    transcript.js           what each adapter event and hook payload means: the agent state machine
    derive.js               huddles, alerts, feed, session status
    sse.js                  /events endpoint: snapshot on connect, deltas after
    http.js                 static files, /api/state, /api/health, /hook/<event>, /control (disabled)
    hooks.js                --print-hooks / --install-hooks (diff, backup, confirm)
    demo.js                 --demo and --replay: feed recorded events on a timeline
  shared/
    types.js                JSDoc typedefs (domain model, scene model, events)
    adapter.js              raw Claude Code records → domain events (pure, runs in Node and browser)
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
    js/overlays.js          bubbles, name plates, chips, hover/pin card, portraits (via renderer.project)
    js/panel.js             right panel: attention, session, assignment, huddles, crew, feed, how-to
    js/rooms.js             drop-up rooms list with click-to-fly
    js/errors.js            toasts, footer counter, global handlers, guarded loop helper
    js/renderer/index.js    createRenderer(kind, canvas, theme) factory
    js/renderer/iso2d/      renderer.js (interface impl), primitives.js, figure.js, props.js
  themes/spaceship.json, themes/office.json
  fixtures/                 real recorded files (see fixtures/README.md)
  tests/                    node:test — adapter.test.js, paths.test.js, layout.test.js, state.test.js
  tools/smoke.mjs           headless Chrome via CDP: load --demo, hover, click rooms row, zoom, screenshot
  Dockerfile, compose.yaml, README.md
```

## 2. Domain model (server truth) — see `shared/types.js`

Identity: `Session.id` = Claude Code `sessionId` (UUID). `Agent.id` = `"<sessionId>"` for the lead, `"<sessionId>/<agentId>"` for subagents. Never key on pid.

States for agents: `working | thinking | waiting | idle | done | joining | leaving | compacting`. The server emits `joining`/`done` around subagent lifetimes; `leaving`, `teleporting` are presentation-only and exist only in the Scene.

## 3. Adapter (`shared/adapter.js`) — pure functions

```js
parseRegistryFile(json, {now}) -> Session | null
parseTranscriptLine(line, ctx) -> AdapterEvent[]      // ctx: {sessionId, agentId|null, version}
parseSubagentMeta(json, {sessionId, agentId}) -> Partial<Agent> & {toolUseId}   // toolUseId links a subagent file back to the assistant message that spawned it, and so to its huddle
```
`AdapterEvent` union (see types): `session_meta`, `prompt`, `assistant_turn` (model, effort, usage, ctx estimate), `tool_call` (tool, input, paths, isBatchStart), `tool_result`, `agent_spawn` (from Agent tool_use + its tool_result), `agent_end`, `compaction`, `title`, `drift` (fieldPath, sample).

Rules: unknown `type` → `[]` plus one `drift` event per unknown type per version. Missing expected field → `drift` with the record `uuid` as sample, never a throw. `paths` are extracted with `shared/paths.js` from `tool_use.input` (Read/Edit/Write file_path, Grep/Glob path+pattern, Bash command tokens that look like paths).

One assistant message can be written as several records: the five `Agent` blocks of a batch share one `message.id` across five records. Count tokens and turns once per `message.id`; `ctxUsed` takes the latest.

Context estimate per turn: `usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens` of the latest assistant record; `ctxLimit` from config `context_limits[model]` (default table in config.js).

Huddle detection (in `state.js`, not adapter): two or more `agent_spawn` events whose `tool_use` blocks sit in the **same assistant message** (`message.id`) form one Huddle; goal = the lead's last user prompt text at that time (fallback: the first `description`).

## 4. Stream protocol (`/events`, SSE)

Each SSE message: `event: <type>` and `data: <json>`. Types and payloads:

- `snapshot` → `Snapshot` (full state) on connect and every 30 s as a heartbeat.
- `session` → `Session` upsert · `session_removed` → `{id}`
- `agent` → `Agent` upsert · `agent_removed` → `{id}`
- `feed` → `FeedItem`
- `huddle` → `Huddle` upsert · `huddle_removed` → `{id}`
- `alert` → `Alert` upsert · `alert_cleared` → `{id}`
- `error` → `{when, msg, detail?}`
- `health` → `Health`

Client applies each to the store with `store.apply({type, data})`. `demo.js` replays the same event shapes from the recording named by `demo_file` (`{t: msOffset, type, data}` per line).

## 5. Scene model (`web/js/layout.js` output) — renderer input

```js
Scene {
  room:   {w:11, d:9, wallH:46},
  tiles:  [{i,j,kind:'floor'|'aisle'|'pod'|'hall', alpha}],
  walls:  [{kind:'north'|'west'|'podNorth'|'glassI'|'railJ', ...geometry, alpha}],
  props:  [{id, kind:'desk'|'chair'|'core'|'plant'|'dispenser'|'pad'|'door'|'board'|'sign'|'table'|'stool'|'laptop', i,j, w?,d?, z?, alpha, state?, text?}],
  people: [{id, name, type, isLead, model, state, pos:{i,j}, seated, facing:'SW'|'SE'|'NW'|'NE', walkT, alpha, beam:null|{t,dir:'out'|'in'}, ctxWarn, plate:{i,j,z}, bubble:{text, tool, kind}}],
  pods:   [{id, n, slot:{bay,side}, h, goal, reports, size, tableAt:{i,j}}],
  hallway:{len},
  hilite: {selectedId|null, hoverId|null},
}
```
Layout owns all timers for transitions (walk paths at 1.7 tiles/s, pod rise 1.2 s, beam 1 s out + 1 s in, leave then remove). Layout is a pure-ish function of `(state, prevScene, nowMs, layoutConfig)` so it can be unit-tested with fake clocks.

## 6. Renderer interface (`web/js/renderer/*`)

```js
createRenderer(kind, canvas, theme) -> {
  resize(cssW, cssH, pixelScale),      // pixelScale: integer 1..4 for pixel renderers
  setCamera({x, y, zoom}),             // x,y in world art px; zoom multiplies pixelScale
  render(scene, timeMs),
  project({i, j, z}) -> {x, y},        // world tile coords → CSS px within the canvas
  pick(cssX, cssY, scene) -> id|null,
  portrait(canvas2d, person, timeMs),  // 84×120 preview for cards
  destroy()
}
```
Only `iso2d` is implemented now. Everything above the renderer (overlays, rooms list, cards) uses `project()` and `pick()` and nothing else.

## 7. Theme JSON (`themes/*.json`) — validated by `theme.js`

```json
{ "name": "spaceship", "label": "Spaceship deck",
  "palette": { "floor1": "#2a3242", "floor2": "#303a4d", "grout": "#1c2230", "aisle1": "#12424f", "aisle2": "#155062",
               "wall": "#3a4658", "wall2": "#44526a", "wainscot": "#2b3546", "trim": "#19d3e6", "trimDim": "#0e7f8c",
               "steel1": "#5b6a80", "steel2": "#3f4b5e", "steel3": "#2e3747", "base1": "#1a212e", "base2": "#131924",
               "glass": "#7fe7ff", "pod1": "#1e3a44", "pod2": "#22414c", "podGrout": "#142a31", "bg": "#04070f" },
  "props":   { "desk": ["#4a5870","#34405a","#262f45"], "chair": ["#5b6a80","#3f4b5e","#2e3747"], "table": ["#2a6d78","#1e515a","#163d44"] },
  "figures": { "lead": {"shirt":"#3b4fd8","hair":"#2b1d0e","pants":"#26305c","acc":"tie","crown":true},
               "Explore": {"shirt":"#2f9e6b","hair":"#5a3a1a","pants":"#2b3a4b","acc":"cap"},
               "Plan": {"shirt":"#7b5bd6","hair":"#8a8a8a","pants":"#3a2a5a","acc":"glasses"},
               "general-purpose": {"shirt":"#e07a2f","hair":"#1a1a1a","pants":"#3a2a1a","acc":"hat"},
               "code-review": {"shirt":"#d64b4b","hair":"#3a2a1a","pants":"#2a1a1a","acc":"badge"},
               "default": {"shirt":"#7f8ba6","hair":"#3a2a1a","pants":"#2b3a4b","acc":null} },
  "states":  { "working":"#3ddc97","thinking":"#6aa6ff","waiting":"#ffb347","idle":"#7f8ba6","done":"#b48cff","joining":"#b48cff","leaving":"#b48cff","compacting":"#ff4d4d","teleporting":"#7fe7ff" },
  "models":  { "claude-fable-5-1":{"chip":"F5.1","color":"#e0b354"}, "claude-opus-5":{"chip":"O5","color":"#b48cff"},
               "claude-sonnet-5":{"chip":"S5","color":"#6aa6ff"}, "claude-haiku-4-5-20251001":{"chip":"H4.5","color":"#3ddc97"} },
  "text":    { "deck":"DECK 1", "door":"AIRLOCK", "board":"ASSIGNMENT", "pod":"HUDDLE", "pad":"TRANSPORTER" },
  "features":{ "stars": true, "viewports": true, "planet": true } }
```
`office.json` uses the same keys with wood/brick colours and `features` off. Unknown keys are ignored; missing keys fall back to `spaceship`.

## 8. Config (`server/config.js`) — `agentdeck.json` next to the repo or in `~/.config/agentdeck/`

Keys and defaults: `data_root` (per OS), `port` 7777, `host` "127.0.0.1", `open_browser` true, `poll_ms` 500, `theme` "spaceship", `context_warn_pct` 85, `context_compact_pct` 96, `context_limits` {model→tokens, default 200000; fable/opus/sonnet 1000000; haiku 200000}, `stale_after_s` 180, `sessions_include` [], `sessions_exclude` [], `hooks_enabled` false, `controls_enabled` false, `log_level` "info". Flags: `--port`, `--host` (default 127.0.0.1), `--data-root`, `--demo`, `--replay <file>`, `--no-open`, `--print-hooks`, `--install-hooks`, `--verbose`. Env `AGENTDECK_MODE=docker` → `Health.mode='docker'`, liveness by file freshness, no PID checks. Config keys starting with `_` are ignored (comments); `"data_root": null` means per-OS default. In `--demo` the stream still connects so `#status` reads live.

## 9. Ownership (who writes what)

| Owner | Files |
|---|---|
| A · server | `server.js`, `server/*`, `shared/adapter.js`, `shared/paths.js`, `tests/adapter.test.js`, `tests/paths.test.js`, `tests/state.test.js`, `package.json` |
| B · web core | `web/index.html`, `web/css/app.css`, `web/js/main.js`, `store.js`, `stream.js`, `layout.js`, `camera.js`, `theme.js`, `errors.js`, `themes/*.json`, `tests/layout.test.js` |
| C · renderer | `web/js/renderer/**` |
| D · overlays + panel | `web/js/overlays.js`, `web/js/panel.js`, `web/js/rooms.js`, `web/css/overlays.css` |
| E · QA, tools, docs, docker | `tools/smoke.mjs`, `README.md`, `Dockerfile`, `compose.yaml`, `.gitignore`, `tests/README.md` |

`shared/types.js` is fixed by the lead. Anyone who needs a change to a contract writes the request into `CONTRACT-CHANGES.md` instead of silently diverging.

## 10. Reference implementation

`../mockups/f-spaceship-deck.html` is the visual and behavioural reference for renderer, camera, overlays, panel, rooms list and pods. Port its logic; do not paste the file. Where the mockup mixes concerns, split along the layers above.

## 11. DOM contract (`web/index.html`, owned by B; used by D, E)

Stable ids: `#tabs` (session tabs), `#topstats` (counts), `#status` (stream state: live / reconnecting / disconnected + last event age), `#stage` (scene frame, position:relative, overflow:hidden), `#cv` (canvas), `#ov` (overlay layer, absolute inset 0, pointer-events none; children opt in), `#viewctl` with `#zout #zoomchip #zin #recenter #fs`, `#podlist` (rooms list, bottom-left), `#panel` (right column), `#errbar` (toast stack), `#diag` (footer error counter), `#themesel` (theme select). Hover card element gets class `.hcard` and is appended to `body` (or to `#stage` while fullscreen). Bubbles `.bub`, name plates `.nm`, chips `.chip`, holo signs `.holo`, table chips `.tcard`.

Debug hook (B): `window.__agentdeck = { store, get scene(), renderer, camera }` — current scene each frame; used by tools/smoke.mjs.

Keyboard: `Esc` clear selection / exit maximize, `+`/`-` zoom, `F` fullscreen, `0` fit. URL hash: `#session=<id>`, `#pin=<agentId>`, `#theme=<name>`.
