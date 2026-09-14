# Agent Deck — Open Questions

Answer these and the plan is unblocked. Decided items are bold; answers dated. "Needed by" says which milestone waits on it.

| # | Question | My default if you say nothing | Needed by |
|---|---|---|---|
| 1 | Name. "Agent Deck"? | Agent Deck | M2 |
| 2 | Server language. | **Decided: Node, plain JavaScript, zero dependencies** (2026-09-13). Parser shared between server and page. | M2 |
| 3 | Hooks. | **Decided: both** — snippet printed by default, `--install-hooks` merges after showing the change and writing a backup (2026-09-13). Purpose: live "waiting for approval" alert. | M2 |
| 4 | Which sessions. | **Decided: all sessions** (2026-09-13) | M2 |
| 5 | Ended sessions. Show history (last N days) or live only? | Live only in v1; history in v1.1 | M2 |
| 6 | Default theme. Spaceship, office, or both shipped with spaceship default? | Both, spaceship default | M3 |
| 7 | Subagent display name. The Agent call's `description` (e.g. "Explore hooks"), the agent type, or both? | description, type as subtitle | M3 |
| 8 | Context window sizes per model. Hardcode a table with a config override, or read from somewhere you know of? | Table + override | M3 |
| 9 | Cost in dollars. Out (current plan) or in as a clearly labelled estimate from a pricing table? | Out | M3 |
| 10 | Where the code lives. | **Decided: this repo**, folder `agent-deck/` (2026-09-13) | M2 |
| 11 | Windows. Do your Windows machines run Claude Code natively or in WSL? | Support both, native default | M5 |
| 12 | Docker. Needed for v1 or later? | Later; native first | M5 |
| 13 | Event retention. | **Decided: default** — in memory, derived-event JSONL for replay in v1.1 (2026-09-13) | M2 |
| 14 | Access. | **Decided: localhost only** (2026-09-13) | M2 |
| 15 | Notifications. Desktop notification or sound when an approval is waiting? | Off by default, opt-in later | M3 |
| 16 | Interactivity. | **Decided: read-only in v1, kept flexible** — `/control` route stubbed as disabled, action buttons behind a config flag, socket adapter later (2026-09-13) | M2 |
| 17 | Auto-open. Should `server.py` open the browser on start? | Yes, with `--no-open` | M2 |
| 18 | Frame size. Fixed aspect frame (as mockups) or fill the window? | Fill the window, min 960×540 | M3 |
| 19 | 3D. Is a 3D renderer a real near-term goal (affects how much the interface must cover), or a "keep the door open"? | Keep the door open: interface, no 3D work in v1 | M3 |
| 20 | Team use. Will anyone else run this? Affects config defaults and docs. | Just you for now | M5 |
