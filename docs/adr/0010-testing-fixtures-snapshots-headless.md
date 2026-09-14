# ADR-0010 · Testing: recorded fixtures, adapter unit tests, scene snapshots, headless-browser smoke

Status: Proposed · 2026-09-13

## Context
The riskiest code is the adapter (fragile inputs) and the layout (many transitions). Rendering is visual and best checked by eye plus a smoke test.

## Decision
- `fixtures/`: real transcript excerpts and registry files, anonymised where needed, tagged by Claude Code version. Milestone 1 records the first set, including a subagent batch, a permission wait, a compaction.
- Adapter tests (`tests/adapter.test.js`, Node's built-in `node:test`): fixture in, expected domain events out; drift fixtures produce alerts not exceptions.
- Layout tests (Node, no browser): scene-model snapshots for given store states, including pod slot order and paths.
- Smoke test: the CDP scripts used during the mockups, kept in `tools/`, load the page against `--demo`, hover an agent, click a rooms row, zoom, full-screen, and screenshot. Run manually before a release; not a CI gate in v1.

## Consequences
- The fragile parts are covered where they are cheap to cover.
- Visual quality remains a human check, with screenshots to compare.
