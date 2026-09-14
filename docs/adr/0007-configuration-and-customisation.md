# ADR-0007 · Configuration in one file with per-OS defaults; customisation through data, not plugins

Status: Proposed · 2026-09-13

## Context
John asked for flexibility in customisation and for simple code. Plugin systems are flexible and complex; data files are flexible and simple.

## Decision
One optional file, `agentdeck.toml` (or JSON if TOML parsing is unavailable), searched in the working directory then `~/.config/agentdeck/`. Every key has a default. Command-line flags override the file.

Keys, v1:
- `data_root` (default per OS: `~/.claude`, `%USERPROFILE%\.claude`, WSL path if detected)
- `port` (7777), `open_browser` (true), `poll_ms` (500)
- `theme` ("spaceship"), `themes_dir` for user themes
- `context_warn_pct` (85), `context_compact_pct` (96)
- `context_limits` map model → tokens, with a built-in default table
- `models` map model id → {chip, colour}
- `agent_types` map subagent_type → {label, figure palette key}
- `stale_after_s` (180) for liveness when PIDs cannot be checked
- `sessions_include` / `sessions_exclude` path globs (default: all)
- `hooks_enabled` (false)

What is intentionally *not* configurable in v1: layout geometry, animation timings, renderer internals. Those live in the theme or the code.

## Consequences
- A user changes colours, labels, thresholds, and which sessions appear, without touching code.
- No plugin API to design, version or support. If someone needs code-level extension, the renderer interface (ADR-0004) is the seam.
