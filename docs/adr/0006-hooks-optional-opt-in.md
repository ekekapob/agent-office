# ADR-0006 · Hooks are optional, fire-and-forget, and installed only on explicit opt-in

Status: Accepted · 2026-09-13

## Context
Only a hook can report "waiting for approval" while it is happening. Hooks run inside every session on every event, so a slow or failing hook would hurt the very sessions we watch. Editing `~/.claude/settings.json` is a sensitive write.

## Decision
- Everything works without hooks, with approval waits appearing once resolved. Hooks add immediacy.
- Hooks used: `PermissionRequest` (P0), `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification` (nice-to-have). Each is a one-line `curl --max-time 0.3 -s -X POST localhost:7777/hook -d @-` reading the payload from stdin. Never blocks, never fails the session, exit code always 0.
- Installation: `node agent-deck/server.js --print-hooks` prints the JSON snippet. `--install-hooks` merges it into settings after showing a diff and asking for confirmation, and writes a backup next to the file. Default is print only.
- The server treats hook payloads as untrusted data: validated shape, size-capped, never executed.

## Consequences
- Zero risk to sessions by default; users choose the trade-off.
- A missing hook is visible: the health endpoint and the panel say "approval hook: not installed".
