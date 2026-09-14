# ADR-0008 · Errors are always visible; fail-soft per session

Status: Proposed · 2026-09-13

## Context
A monitoring tool that fails silently is worse than none. Formats will drift; files will be half-written; a session will be unreadable one day.

## Decision
- Server: every caught error is logged with timestamp, level, session id and a one-line cause, to stderr and to `~/.config/agentdeck/agentdeck.log` (rotating, 5 MB). `--verbose` adds record-level detail.
- Stream: errors are also sent as `error` events so the page can show them; `/api/health` returns the last 20.
- Page: the mockups' reporter is kept as `errors.js`: toast with time, message, copy button; footer counter; guarded render loop; global `error` and `unhandledrejection` handlers. A connection strip shows live / reconnecting / disconnected with time since last event.
- Fail-soft: parsing runs per session in isolation. A broken transcript marks that session `unreadable` (badge in scene and panel) and the others continue. A missing field produces one `drift` alert, not a crash.
- Startup checks say what is wrong in plain words and how to fix it: data root missing, no read permission, port in use, Node too old.

## Consequences
- Users can always tell whether they are looking at a true picture or a stale one.
- Slightly more code in the adapter for guards; worth it.
