# ADR-0003 · One adapter normalises Claude Code records into a small domain model

Status: Proposed · 2026-09-13

## Context
Raw records mix concerns: registry entries, transcript records of several types, assistant messages with nested content blocks, hook payloads. Their shapes are internal to Claude Code and will drift. Every consumer (server logic, page, tests) should see one stable shape.

## Decision
`server/adapter.py` (a section of the single server file, kept separable) is the only code that knows raw shapes. It emits events into a domain model:

- `Session {id, pid, name, cwd, branch, startedAt, status, version, model, ctxUsed, ctxLimit, tokens, lastPrompt}`
- `Agent {id, sessionId, parentId, type, name, model, effort, state, tool, args, brief, tokens, cache, ctxUsed, tools{}, spawnedAt, transcriptPath}`
- `ToolCall {agentId, t, tool, args, paths[]}` — `paths` extracted once, here, for shared-file logic
- `Huddle {id, sessionId, goal, memberIds[], startedAt, reports}` — derived from several Agent calls in one assistant message
- `Alert {kind: approval|context|conflict|drift, sessionId, agentId?, text, since}`

Rules:
- Unknown record types are ignored, counted, and logged once.
- Missing expected fields produce a `drift` alert with one sample line, once per field per version, and a `null` in the model. Never an exception.
- Parsing is pure: input lines, output events. That makes fixtures and unit tests trivial (ADR-0010).
- The adapter records the Claude Code `version` per session so fixtures can be tagged.

## Consequences
- The page and the renderer never see raw records.
- Adding support for a new record type or hook is a change in one place.
- Subagent transcript layout is unknown today; the adapter gets a stub and a TODO until milestone 1 records real files.

## Alternatives considered
- Streaming raw records to the page and parsing there: spreads the fragile code across two places and two languages. Rejected.
