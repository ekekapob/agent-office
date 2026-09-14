# Agent Deck — Product Requirements

Status: draft v1 · 2026-09-13 · owner: John · mockups: `mockups/a…f-*.html`

## 1. Summary

Agent Deck is a local web dashboard that shows what every Claude Code session on a machine is doing, as a 2.5D isometric pixel-art office. One session is one room ("deck"). Every agent in it, the session lead and each subagent, is a person at a console with a speech bubble showing the tool it is running right now. Batches of agents spawned together get a glass "huddle" pod that shows their shared goal and the files they converge on. The dashboard reads files Claude Code already writes; it never calls a model, so it costs zero tokens.

The six mockups in `mockups/` are the visual spec. `f-spaceship-deck.html` is the reference for the single-session view. `a-office-building.html` is the reference for the multi-session overview.

## 2. Goals

- See at a glance which sessions exist, which are busy, idle, or waiting for approval.
- See inside one session: who is working on what, with which model, how much context is used, and when compaction is near.
- Make coordination visible without inventing it: batches spawned together, files touched by several agents, files edited by two agents at once.
- Zero token cost, read-only on `~/.claude`, no effect on running sessions.
- Simple enough for one person to maintain: no framework, no bundler, a small dependency-free Node server, plain ES modules, one language.
- Flexible where change is likely: theme and art style, renderer (2D now, 3D later), thresholds, agent-type mapping, data root.

## 3. Non-goals (v1)

- Controlling sessions (sending prompts, approving). Read-only first; see Open Questions.
- Cloud or multi-machine aggregation.
- Faking agent-to-agent conversation. Subagents do not talk to each other; the UI never implies they do.
- Dollar cost accounting. Token counts yes; prices are a moving table and would be an estimate.

## 4. Users

- Primary: a developer running several Claude Code sessions in terminals at once, wanting a second screen that answers "what is everyone doing, and does anything need me".
- Secondary (later): a team sharing one dashboard on a LAN.

## 5. Data sources (verified on this machine, Claude Code 2.1.269, macOS)

| Need | Source | Verified fields |
|---|---|---|
| Session list, busy/idle, name, cwd, pid | `~/.claude/sessions/<pid>.json` | pid, sessionId, cwd, startedAt, version, name, nameSource, status (`busy`/`idle`), statusUpdatedAt, updatedAt, messagingSocketPath, pidDomain |
| Everything a session does | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (append-only) | record types: user, assistant, attachment, system, ai-title, custom-title, agent-name, permission-mode, mode, last-prompt, file-history-snapshot |
| Model, effort, tokens per turn | assistant records | `message.model`, `effort`, `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens_details.thinking_tokens, service_tier, speed}` |
| Current tool and arguments | assistant `message.content[]` blocks of type `tool_use` | `name`, `input` |
| Subagent spawn, brief, type, model | `tool_use` with `name == "Agent"` | `input.subagent_type`, `input.description`, `input.prompt`, `input.model` (optional) |
| Subagent activity | `projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json` | **verified 2026-09-13** (milestone 1). Meta holds `agentType`, `description`, `toolUseId`, `spawnDepth`, `model` (null when the Agent call gave no override, in which case the real model is in the subagent's own assistant records). Records carry `agentId`, `isSidechain: true`, the parent `sessionId`, and `attributionAgent`. |
| Waiting for approval | registry `status: "waiting"` with `waitingFor` (e.g. "dialog open"), plus the `PermissionRequest` hook for the detail of what is being asked | **verified 2026-09-13**: the registry alone shows that a session is blocked; the hook adds the tool and arguments. |
| Waiting, detail | `PermissionRequest` hook | hook payload on stdin (session_id, tool_name, tool_input); the transcript only records the outcome, not the wait |
| Join/leave, compaction, turn end | `SubagentStart`, `SubagentStop`, `PreCompact`, `Stop`, `Notification` hooks | optional; the transcript alone covers most of it with a small delay |
| Process liveness (native only) | `ps` / PID check | not available inside Docker; fall back to file freshness |

Formats are internal to Claude Code and unversioned. Requirement: tolerate missing or renamed fields, flag drift, never crash on one bad record.

## 6. Functional requirements

IDs are stable for ADR and ticket references. P0 = first usable build, P1 = second, P2 = later.

### Sessions
- FR-1 (P0) List live sessions with name, cwd, branch, pid, uptime, busy/idle, agent count.
- FR-2 (P0) Switch the deck view between sessions via tabs.
- FR-3 (P2) Overview of all sessions as floors of one building (mockup A), with attention items surfaced first.
- FR-4 (P2) Show ended sessions as history, with duration and token totals.

### Agents
- FR-10 (P0) Show the session lead and every live subagent as a figure at a console.
- FR-11 (P0) Agent states: working, thinking, waiting for approval, idle, finished, joining, leaving, compacting, teleporting. Each has a distinct pose or effect, as in the mockups.
- FR-12 (P0) Speech bubble = latest tool call: icon, tool name, argument summary. Compact by default, full on hover.
- FR-13 (P0) Name plate with a model chip (colour and short label per model family).
- FR-14 (P0) Hover card, click to pin, anchored once and left in place: portrait, name, type, state and elapsed, model and effort, current action, brief (the Agent call's prompt) or the user's last prompt for the lead, tool counts, tokens in/out/thinking, cache read and written, context bar against the model's window, spawn time and parent, transcript path. Waiting agents get a banner row.
- FR-15 (P0) Join and leave animations from a door when a subagent starts and stops.
- FR-16 (P0) Session lead wears a crown.

### Context and alerts
- FR-20 (P0) Context alarm above the lead's head when context use passes a threshold (default 85%, configurable), also on the name plate, in the top bar, and as an attention row.
- FR-21 (P0) Compaction shown as a distinct state with a feed entry; context bar resets after.
- FR-22 (P0) "Needs your attention" panel: approvals waiting, context alarms, cross-huddle edit conflicts.
- FR-23 (P0) Approval signal (decided 2026-09-13): a big bouncing amber "?" above the agent's head with the hand raised is the primary mark; the bubble shows the tool and target; backups so it is never missed: top-bar count, red attention row, amber dot on the session tab, browser tab title "(N) approval · Agent Deck". Sound and desktop notification are opt-in later (see Open Questions 15). The "!" glyph is reserved for the context alarm.

### Huddles
- FR-30 (P1) Several Agent calls in one lead turn form a huddle. A glass pod rises off the hallway; members walk in and sit at a round table; a holo sign shows the lead's question.
- FR-31 (P1) Pods alternate sides of the hallway, newest furthest out; the hallway extends and retracts. Any number of pods may be open at once.
- FR-32 (P1) Table card: files touched by two or more members, tagged with other huddles that touched them; red when two agents are editing the same file. Reports back count.
- FR-33 (P1) When the last report is in, the pod collapses, the crew beams to the transporter pad on the deck, then leaves by the airlock.
- FR-34 (P1) Rooms list in the scene: deck plus one row per live pod; click glides the camera there; drop-up, collapsible, scrollable.

### View
- FR-40 (P0) Drag to pan, wheel/pinch to zoom in fixed steps, keyboard +/−, recenter, full screen. Labels scale with zoom within limits.
- FR-41 (P0) Activity feed per session, filterable to one agent by clicking them.
- FR-42 (P1) Theme switch at runtime: spaceship, office, more later. Themes are data, not code.

### Diagnostics
- FR-50 (P0) Every error is visible: toast in the page with copy, footer counter, server log with timestamps, error events on the stream. Render loop guarded.
- FR-51 (P0) Per-session fail-soft: an unreadable transcript marks that session, the rest keep updating. Missing expected fields log once with a sample and show a "format changed" warning.
- FR-52 (P0) `/api/health` with counts, data root, last errors.

### Platform
- FR-60 (P0) Runs natively with `node agent-deck/server.js`; data root configurable; sensible default per OS.
- FR-61 (P1) Docker image with a read-only bind mount of `~/.claude`; liveness by file freshness there.
- FR-62 (P1) Windows: native `%USERPROFILE%\.claude`, WSL path via `\\wsl$\…`; platform path layer.
- FR-63 (P2) Single-file executable per OS.

## 7. Non-functional requirements

- NFR-1 Zero model calls. No network except optional Google Fonts with system fallbacks.
- NFR-2 Read-only on `~/.claude`. The only write is the optional hook snippet, and only with explicit opt-in.
- NFR-3 CPU: poll files at 2 Hz; parse only appended bytes; render at display rate but pause when the tab is hidden.
- NFR-4 Startup to first frame under 2 seconds with 10 sessions and 50 MB of transcripts.
- NFR-5 No build step, no npm packages. Frontend is ES modules served by the same server. Server is plain Node with built-in modules only.
- NFR-6 Maintainable by one person: under ~12 frontend modules, each with one job; theme and config as data.
- NFR-7 Renderer-agnostic scene model so a 3D or different-art renderer can be added without touching data, layout, or panels.

## 8. UX reference

Everything visual is specified by the mockups. When in doubt, match `f-spaceship-deck.html` for the deck and `a-office-building.html` for the overview. Text conventions: bubbles compact, expand on hover; cards anchor once; chips for models; red for anything needing the user.

## 9. Architecture summary

See ADRs. In one paragraph: a dependency-free Node server polls the registry and tails transcripts, normalises them through one adapter into a small domain model (Session, Agent, ToolCall, Huddle, Alert), and streams state deltas over server-sent events. The page keeps a store, derives a scene model (entities with tile positions, states, facings) through a layout module, and hands it to a renderer behind a small interface. The current renderer is the Canvas 2D isometric pixel renderer lifted from the mockups. HTML overlays (bubbles, cards, lists) position themselves through the renderer's `project()` so they work with any renderer.

## 10. Reuse from the mockups

| Mockup piece | Becomes |
|---|---|
| iso projection, scanline `poly`, `box`, `cyl`, tiles, walls | `web/js/renderer/iso2d/primitives.js` |
| `drawFigure` cuboid people, poses, accessories, crown | `iso2d/figure.js` |
| desks, chairs, rack, plant, pad, pods, hallway | `iso2d/props.js`, driven by theme JSON |
| camera: CAM, S, S0, zoom steps, glide, fullscreen | `web/js/camera.js` |
| bubbles, name plates, chips, hover card, portrait | `web/js/overlays.js` |
| rooms list, panel cards, feed | `web/js/panel.js` |
| desk and pod slot assignment, paths | `web/js/layout.js` |
| error toasts, guarded loop | `web/js/errors.js` |
| the scripted sample (sessions, huddles, timings) | `fixtures/demo.json` and a `--demo` flag, so the UI runs without Claude Code |

## 11. Milestones

1. **Ground truth** (half day) — **done 2026-09-13**: subagent folder layout, the parent `Agent` call to subagent link, a five-call batch (one assistant message) and the resumed-session pid change are captured in `agent-deck/fixtures/v2.1.270/`. Permission waits and compaction are still to be recorded.
2. **Server MVP** (1–2 days): registry + tail + adapter (shared ES module) + SSE + health + logs. Test against fixtures.
3. **Deck MVP** (2–3 days): port the renderer, camera, overlays, panel from mockup F onto the live store. P0 requirements.
4. **Huddles** (1–2 days): batch detection, pods, shared files, teleport. P1.
5. **Themes and Windows** (1–2 days): theme JSON, office theme, path layer, Docker file.
6. **Overview** (later): building view from mockup A.

## 12. Risks

- Format drift in Claude Code files. Mitigation: adapter with drift detection, fixtures per version, fail-soft.
- Subagent folder layout unknown until observed. Mitigation: milestone 1 before any code depends on it.
- Approval waits invisible without a hook. Mitigation: hook optional and documented; without it the state appears once the result lands.
- Docker cannot see PIDs. Mitigation: file-freshness liveness with a visible "stale?" label.
- Many agents crowd the scene. Mitigation: compact bubbles, hover to expand, zoom, rooms list; the floor grows by columns.

## 13. Success criteria

- With three sessions running, the dashboard shows all three within 2 seconds of start and reflects a new tool call within 1 second.
- A permission wait appears within 1 second of the hook firing.
- A subagent batch appears as a pod with the right members and goal, and collapses when the last report lands.
- No token usage attributable to the dashboard.
- A theme can be swapped by changing a JSON file, and a mock 3D renderer can be plugged in by implementing the renderer interface only.

## 14. Open questions

See `docs/OPEN-QUESTIONS.md`. Decisions needed before milestone 2 are marked.
