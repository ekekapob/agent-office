# Contract change requests

Append a dated entry when you need a change to `CONTRACTS.md` or `shared/types.js`. Do not diverge silently. The lead merges or rejects.

(empty)

## 2026-09-13 · E (QA/tools/docs/docker)

Requests, none blocking; the files I own already code against them optionally.

1. **B, `web/js/main.js`** — expose a debug hook `window.__agentdeck = { store, scene, renderer, camera }`. `scene` must be the *current* scene (a getter, or reassigned each frame), `store.getState()` per §1, `renderer` the object from `createRenderer` (so `project`/`pick` are callable). `tools/smoke.mjs` uses it to project the first person for the hover step and to read session/huddle counts; without it the script falls back to timing and a mouse sweep. Not a contract for production code.
2. **A, `server/config.js`** — add `--host <addr>` to the flag list in §8 (the `host` key exists, the flag does not). `Dockerfile` CMD is `node server.js --no-open --host 0.0.0.0 --data-root /data/claude`.
3. **A, `server/platform.js` / `config.js`** — honour env `AGENTDECK_MODE=docker` (set by the Dockerfile): `Health.mode = 'docker'`, liveness by file freshness (`stale_after_s`), no PID checks.
4. **A, `server/config.js`** — ignore top-level keys starting with `_` (comments in `agentdeck.example.json`), and treat `"data_root": null` as "per-OS default".
5. **A/B, `--demo`** — the stream must still connect so `#status` reads "live" in demo mode; smoke step (i) asserts `/live/i` on `#status` and a huddle card in `#panel` 25 s after load (demo spawns a huddle at 5 s).


**Lead decision 2026-09-13:** all five requests from E accepted and merged into CONTRACTS.md §8 and §11.

## 2026-09-13 · C (renderer)

Observations, neither blocking — the iso2d renderer already draws correctly against the Scene as shipped; these are optional fidelity/consistency notes for B if `layout.js`/`layout-pods.js` change again.

1. **B, `layout-pods.js` `podScene()`** — `glassI` is emitted as one wall entity spanning the pod's full `j0..j1`, where the mockup split it per unit column so each segment could be depth-sorted independently against a figure standing inside that column. The renderer sorts the single `glassI` entity as one item (`i + (j0+j1)/2 + 0.5`), which is correct in the common case but can very occasionally let a seated pod occupant draw in front of/behind the whole glass wall instead of just the segment they're actually behind. Cosmetic only; not worth splitting unless it's visibly wrong in practice.
2. **B, `layout.js`** — the `board` prop gives the *inner* screen rect (`j0,j1,z0,z1`) while `sign` gives the *outer* plate rect (`i0,i1,z0,z1`); the renderer infers `board`'s outer frame with a fixed 0.1 tile / 1 art-px margin to match the mockup's look. Harmless, but the two props follow different conventions for the same kind of field — worth aligning if either is touched again.

## 2026-09-13 · A (server + adapter)

Implemented as described below; none of these change a shape the page already consumes, so nothing is blocking. Lead to confirm or correct.

1. **`shared/types.js` · `AdapterEvent`** — three fields the adapter already emits are not in the typedef and `state.js` relies on them. Please fold them in:
   - `assistant_turn.stopReason: string|null` — `message.stop_reason`. This is how "the lead finished a turn" (`end_turn`) is told apart from "a tool is still open" (`tool_use`); without it there is no `idle`.
   - `tool_call.isEdit: boolean` — true for `Edit`/`Write`/`MultiEdit`/`NotebookEdit`. The conflict alert is "two agents *edited* the same path", so a read must not count.
   - `agent_spawn.parentAgentId: string|null` — the agent that made the `Agent` call, so `Agent.parentId` is right at spawn depth ≥ 2.
   Also `drift.repeat?: boolean`: a marker meaning "this field/version was already reported in this file", which `state.js` drops. It keeps the dedupe in the adapter's caller-owned context rather than in the state.

2. **`parseSubagentMeta` returns `toolUseId` (and `spawnDepth` as `depth`)** beyond `Partial<Agent>` — §3 says it returns `Partial<Agent>`, but the `.meta.json` carries `toolUseId`, and that is the only link from a discovered subagent file back to the assistant message that spawned it. Without it, a subagent found on disk before its parent's `tool_result` has been read cannot be placed in its huddle. Signature is now `Partial<Agent> & {toolUseId?, depth?}`.

3. **Huddle detection needs no new adapter field** — §3 says huddles are found in `state.js` from `message.id`, but `agent_spawn` has no `messageId`. Resolved without a contract change: `state.js` keeps a `tool_use id → message id` map from the `tool_call` events it has already seen, and looks up the spawn's `toolUseId`. Confirmed against `fixtures/v2.1.270/parent/batch-spawn.jsonl`.

4. **One assistant message is written as several records** — each content block is its own `assistant` record sharing one `message.id` (five `Agent` blocks = five records in `batch-spawn.jsonl`). So `assistant_turn` fires several times per message. `state.js` adds tokens and counts a turn once per `message.id`, and takes `ctxUsed` from the latest record. Worth a sentence in §3 for whoever writes the next consumer.

5. **`Session` gained an optional `unreadable: boolean`** to back the `SessionStatus` value of the same name, which ADR-0008 requires but nothing set.

6. **Record types added to the adapter's ignore list** — observed live on this machine and carrying nothing we model, so they produce no `drift`: `file-history-delta`, `relocated`, `worktree-state`, `pr-link`, `continued-in`. Before this, a normal session raised six drift alerts on startup.

7. **`server/state.js` was split** into `state.js` (containers, bus, snapshot), `server/transcript.js` (what each event and hook payload means) and `server/derive.js` (huddles, alerts, feed, session status), to stay under the ~400-line rule. §1's file list should gain the two new modules.
