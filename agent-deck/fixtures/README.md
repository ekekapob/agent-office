# Fixtures

> Email addresses and anything token-shaped are redacted (`user@example.com`, `REDACTED-TOKEN`). Home paths and session ids are kept: the parser depends on their shape. Re-run the redaction pass in `tests/README.md` after capturing new fixtures.

Real files written by Claude Code 2.1.270 on macOS, captured 2026-09-13 during milestone 1. Paths and prompts are John's own.

- `v2.1.270/sessions/*.json` — three live registry entries. Keyed by pid; `sessionId` is the stable identity (a resumed session gets a new pid file).
- `v2.1.270/parent/excerpt.jsonl` — lines from the parent session transcript: first user prompt, title records, an assistant record with `usage`, the `Agent` tool_use, and the tool_result whose `toolUseResult` carries `agentId`, `resolvedModel`, `description`, `prompt`, `outputFile`.
- `v2.1.270/parent/batch-spawn.jsonl` — one assistant message (`message.id` msg_011Cf14ykhqeGwZQNYAZ1sNp) holding **five** `Agent` tool_use blocks, plus their five tool_results. This is the huddle signal: several spawns in one message.
- `v2.1.270/subagent-explore/` — a complete subagent transcript (24 records) and its `.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`, `model`). Records carry `agentId`, `isSidechain: true`, `sessionId`, `attributionAgent`.
- `hooks/PermissionRequest.example.json` — expected hook payload; **not captured live yet**.

Notes: `.meta.json` has `model: null` when the Agent call gave no model override; the actual model is then `message.model` in the subagent's own assistant records. Registry files disappear and reappear under a new pid when a session is resumed.

Confirmed against live sessions on 2026-09-13: the server reads 4 sessions and 15 agents from these shapes with zero drift.

Not captured yet: a compaction (`PreCompact`), a permission wait, `SubagentStop`. Add them here when observed, in a folder named for the Claude Code version.
