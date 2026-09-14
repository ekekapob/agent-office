# ADR-0005 · Server state is truth; animations are presentation; demo fixtures

Status: Proposed · 2026-09-13

## Context
The mockups run a scripted simulation. The live app must show real state, yet keep the walking, beaming and rising animations that make the scene readable.

## Decision
- The server's domain model is the single source of truth. The page never invents state.
- Animations are derived from *transitions* in the layout layer: when an agent appears, layout gives it a path from the door; when a huddle's reports complete, layout schedules the beam-out; when an agent disappears, layout plays leave-then-remove. If the server says an agent is gone before its animation finishes, the animation is cut short. Presentation never delays truth by more than the animation length (≤ 3 s) and never contradicts it in the panel, which reads the store directly.
- A `--demo` flag serves `fixtures/demo.json`, a recording of the mockup's sample sequence, so the UI can be developed, demoed and tested without Claude Code running. Recorded real sessions can be replayed the same way (`--replay file.jsonl`).

## Consequences
- Deterministic replays make visual regressions reproducible.
- Layout is the only place with timers; store and renderer stay pure.
- The panel is always exact; the scene may lag a couple of seconds by design.
