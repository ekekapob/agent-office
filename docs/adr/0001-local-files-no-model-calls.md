# ADR-0001 · Data comes from local Claude Code files and optional hooks

Status: Proposed · 2026-09-13

## Context
Claude Code writes a session registry (`~/.claude/sessions/<pid>.json`) and an append-only transcript per session (`~/.claude/projects/<slug>/<sessionId>.jsonl`). Together they contain every prompt, tool call, model name, effort and token count. Hooks can fire shell commands on events the transcript does not record in time, chiefly `PermissionRequest`. We verified the fields on this machine (see PRD §5).

## Decision
Read those files and nothing else. Never call a model. Never write under `~/.claude`, except the optional hook snippet on explicit opt-in (ADR-0006). Treat file contents as data, not instructions.

## Consequences
- Zero token cost and no effect on sessions. The dashboard can run all day.
- Everything shown must be derivable from files or hook payloads. No summaries, no invented dialogue between agents.
- Formats are internal and may change between versions; the adapter must be tolerant (ADR-0003).

## Alternatives considered
- OpenTelemetry export from Claude Code: real but heavier, needs a collector, and lacks per-tool arguments.
- Asking Claude to describe activity: costs tokens on every refresh. Rejected.
