# ADR-0009 · Platforms: native first, Docker with read-only mount second, executable later

Status: Proposed · 2026-09-13

## Context
Native runs see host processes and Unix sockets. Docker isolates but cannot see host PIDs, gets no file-change notifications across the VM, and cannot use host Unix sockets. Windows may run Claude Code natively or in WSL.

## Decision
- v1 target: `node agent-deck/server.js` on macOS, Linux, Windows (Node 20+).
- Platform layer (`server/platform.js`): data root default, path slug decoding (Claude Code encodes cwd into the project folder name; separators differ), PID liveness (`kill 0` on POSIX, `OpenProcess`/`tasklist` on Windows), WSL detection and `\\wsl$` path support.
- Docker: `Dockerfile` + `compose.yaml` mounting `~/.claude` read-only at `/data/claude`; `data_root` set accordingly; liveness by freshness only, labelled "file-based" in health.
- Packaging: a single executable per OS (Node single-executable build, or a Go server if that proves smoother) in a later milestone. Not in v1.

## Consequences
- One code path, one setting for where the data is.
- Docker users lose PID liveness and any future control features that need sockets, and are told so.
