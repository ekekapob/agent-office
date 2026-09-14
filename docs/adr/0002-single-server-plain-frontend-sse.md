# ADR-0002 · One dependency-free Node server, plain ES-module frontend, server-sent events, polling

Status: Accepted (language decided by John) · 2026-09-13

## Context
Must be maintainable by one person, run without setup beyond Python, and push updates to the page within a second. File change notifications are unreliable across Docker Desktop's VM boundary and unnecessary at this scale.

## Decision
- Server: Node 20+, plain JavaScript, zero npm dependencies, entry `agent-deck/server.js` with a few small modules under `agent-deck/server/`. Built-in `http`, `fs`, `path`, `child_process`. Serves static files, `/api/state`, `/api/health`, `/events` (SSE), `/hook/<event>` (POST from hooks), and `/control` (stubbed disabled in v1).
- Shared code: the transcript adapter (ADR-0003) is one ES module used by both the server and the page, so a saved transcript can be replayed in the browser with no server.
- Watching: poll the registry directory and each transcript's size every 500 ms; read only appended bytes; parse line by line.
- Transport: server-sent events with a full snapshot on connect and deltas after. Browser `EventSource` reconnects on its own.
- Frontend: ES modules under `web/js/`, no framework, no bundler, no npm. Fonts from Google with system fallbacks.

## Consequences
- `node agent-deck/server.js` is the whole install wherever Node exists; a per-OS single executable comes later if the tool is handed to machines without Node.
- SSE is one-way; fine for read-only. If control features arrive later, add a small POST endpoint rather than switching to WebSocket.
- Polling costs a few stat calls per second. Acceptable.

## Alternatives considered
- Python stdlib server: equally simple, but a second language and a duplicated parser. Go: best for zero-setup binaries, but a third language and clumsy with drifting JSON. Bun/Deno: nice types and easy binaries, less common tooling. Decision: Node, revisit Go for the server only if wide distribution becomes a goal.
- WebSocket: two-way, more code, no benefit for read-only.
- inotify/FSEvents: fast natively, broken through Docker file sharing. Polling everywhere is simpler.
