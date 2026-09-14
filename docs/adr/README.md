# Architecture Decision Records

One decision per file. Status is Proposed until John accepts it. Supersede rather than edit accepted records.

| # | Decision |
|---|---|
| 0001 | Data comes from local Claude Code files and optional hooks; no model calls; read-only |
| 0002 | One dependency-free Node server, plain ES-module frontend, server-sent events, polling |
| 0003 | A single adapter normalises Claude Code records into a small domain model, with drift detection |
| 0004 | Scene model and renderer interface; Canvas 2D isometric renderer first; themes are data |
| 0005 | Server state is truth; animations are presentation derived from state transitions; demo fixtures |
| 0006 | Hooks are optional, fire-and-forget, and installed only on explicit opt-in |
| 0007 | Configuration in one file with per-OS defaults; customisation through data, not plugins |
| 0008 | Errors are always visible: page toasts, stream events, logs, health endpoint; fail-soft per session |
| 0009 | Platforms: native first, Docker with read-only mount second, packaged executable later |
| 0010 | Testing: recorded fixtures, adapter unit tests, scene snapshot tests, headless-browser smoke |
