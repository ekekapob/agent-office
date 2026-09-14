# Tests

Everything runs on Node's built-in test runner, no packages.

```sh
cd agent-deck
node --test tests/                    # all unit tests
node --test tests/adapter.test.js     # one file
node --test --watch tests/            # rerun on change
node tools/smoke.mjs                  # browser smoke test, not part of node --test (needs Chrome, ~45 s)
```

Tests read fixtures with `fs.readFileSync(new URL('../fixtures/<...>', import.meta.url))`, pass a fixed `now` where time matters, never touch the network, and never write outside `os.tmpdir()`.

## What each file covers

| File | Owner | Covers |
|---|---|---|
| `adapter.test.js` | A | `shared/adapter.js`: `parseRegistryFile` on `fixtures/v*/sessions/*.json`; `parseTranscriptLine` on the parent excerpt (prompt, titles, `assistant_turn` with usage and context estimate, `tool_call`, `agent_spawn` from the `Agent` tool_use plus its tool_result, `compaction`); `parseSubagentMeta` on `.meta.json`. Unknown record types yield `[]` plus one `drift` per type per version; a missing field yields a `drift` with the record `uuid`, never a throw. |
| `paths.test.js` | A | `shared/paths.js`: paths pulled from `Read`/`Edit`/`Write` `file_path`, `Grep`/`Glob` `path` and `pattern`, `Bash` command tokens that look like paths; no false positives on flags, URLs and prose. |
| `state.test.js` | A | `server/state.js`: applying adapter events builds sessions, agents and the feed; two or more `agent_spawn` from the same `message.id` form one `Huddle` with the lead's last prompt as goal; `reports` counts finished members and closes the huddle; context alerts appear at `context_warn_pct`; approval alerts from hook payloads; removals and the 500-per-session feed cap. |
| `layout.test.js` | B | `web/js/layout.js` as a pure function of `(state, prevScene, nowMs, layoutConfig)` with a fake clock: desk assignment order, pod slots alternating sides of the hallway with the newest furthest out, hallway length, walk paths at 1.7 tiles/s, pod rise over 1.2 s, beam out then in, leave-then-remove, and that a Scene snapshot for a given state is stable. |
| `../tools/smoke.mjs` | E | The page against `--demo` in headless Chrome: DOM ids, no error toasts, hover card, pin and Escape, wheel zoom, recenter, rooms list click, full screen, huddle card and live stream after 25 s. Screenshots land in `tools/smoke-out/`. |

## Adding a fixture for a new Claude Code version

Fixtures are real files, kept small, in a folder named for the Claude Code version that wrote them. Ground truth about the current set is in [`../fixtures/README.md`](../fixtures/README.md).

### 1. Find the version

`claude --version`, or the `version` field of any `~/.claude/sessions/<pid>.json`. Create the folder:

```sh
mkdir -p fixtures/v<version>/{sessions,parent,subagent-explore,hooks}
```

### 2. Produce the events you want to capture

In a Claude Code session in a throw-away project: ask for something that makes it spawn two or more subagents in one turn (a huddle), trigger a permission prompt (edit a file outside the project), and if you can, a compaction (`/compact`). Let the subagents finish.

### 3. Copy the files

| What | From | To |
|---|---|---|
| Registry entries, one per live session | `~/.claude/sessions/<pid>.json` | `sessions/<pid>.json` |
| Parent transcript (trimmed, see below) | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | `parent/excerpt.jsonl` |
| One complete subagent transcript and its meta | `~/.claude/projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl` and `agent-<id>.meta.json` | `subagent-<type>/` |
| Hook payloads | captured with the temporary hook below | `hooks/<Event>.json` |

`<cwd-slug>` is the working directory with path separators replaced by `-` (for example `-Users-john-Documents-GitHub-agent-workspace`). Pick a short subagent (a few dozen records) and copy it whole; it is the only complete transcript in the set.

To capture hook payloads, add a temporary hook that appends stdin to a file, run the session, then split the lines into one file per event and remove the hook again:

```json
{ "hooks": { "PermissionRequest": [ { "hooks": [ { "type": "command", "command": "cat >> $HOME/agentdeck-hooks.jsonl" } ] } ],
             "PreCompact":        [ { "hooks": [ { "type": "command", "command": "cat >> $HOME/agentdeck-hooks.jsonl" } ] } ],
             "SubagentStop":      [ { "hooks": [ { "type": "command", "command": "cat >> $HOME/agentdeck-hooks.jsonl" } ] } ] } }
```

### 4. Trim the parent transcript

A parent transcript grows to tens of megabytes. Keep one record of every type, the first prompt, the first `tool_use` of every tool, every `Agent` spawn with its result, any compaction, and the first and last three lines. Save this as `trim.mjs` anywhere and run `node trim.mjs <src.jsonl> fixtures/v<version>/parent/excerpt.jsonl`:

```js
import fs from 'node:fs';
const [,, src, dst] = process.argv;
const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
const keep = new Set(), seenType = new Set(), seenTool = new Set();
const blocks = (r) => Array.isArray(r.message?.content) ? r.message.content : [];
lines.forEach((l, i) => {
  let r; try { r = JSON.parse(l); } catch { return; }
  if (i < 3 || i >= lines.length - 3) keep.add(i);
  if (!seenType.has(r.type)) { seenType.add(r.type); keep.add(i); }
  for (const b of blocks(r)) {
    if (b.type === 'tool_use' && !seenTool.has(b.name)) { seenTool.add(b.name); keep.add(i); }
    if (b.type === 'tool_use' && b.name === 'Agent') keep.add(i);
  }
  if (r.type === 'user' && r.toolUseResult?.agentId) keep.add(i);     // the Agent call's result
  if (r.type === 'user' && typeof r.message?.content === 'string' && keep.size < 40) keep.add(i);
  if (/compact/i.test(r.type) || r.isCompactSummary) keep.add(i);
});
fs.writeFileSync(dst, [...keep].sort((a, b) => a - b).map((i) => lines[i]).join('\n') + '\n');
console.log(`kept ${keep.size} of ${lines.length} records`);
```

Read the result once; if a record you need is missing (a specific tool, a compaction), copy that line in by hand.

### 5. Anonymise before sharing

The files carry your home directory, project names, prompts, tool inputs and results. If the fixture leaves your machine:

- Replace your home directory and user name everywhere: `sed -i.bak -e "s#$HOME#/Users/me#g" -e "s#$USER#me#g" fixtures/v<version>/**/*.json*` (check `git diff` afterwards, then delete the `.bak` files).
- Redact free text but keep the structure the adapter reads. Save as `redact.mjs` and run `node redact.mjs <file.jsonl>` (in place):

```js
import fs from 'node:fs';
const file = process.argv[2];
const SECRET = new Set(['text', 'prompt', 'description', 'content', 'result', 'command', 'aiTitle', 'customTitle', 'lastPrompt', 'display']);
const walk = (v, key) => {
  if (typeof v === 'string') return SECRET.has(key) && v.length > 24 ? `[redacted ${v.length} chars]` : v;
  if (Array.isArray(v)) return v.map((x) => walk(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
  return v;
};
const out = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.stringify(walk(JSON.parse(l))));
fs.writeFileSync(file, out.join('\n') + '\n');
```

Keep `type`, `uuid`, `sessionId`, `agentId`, `message.id`, `message.model`, `message.usage`, tool names, `file_path`s and timestamps intact: the tests key on them. Short strings under 24 characters are left alone so tool names and ids survive.

### 6. Register it

- Add a bullet to `fixtures/README.md`: version, date, what is in the folder, what is still missing.
- In `adapter.test.js`, run the existing expectations over the new folder (a `for (const version of versions)` loop over `fixtures/v*`). If the new version renamed a field, the run should produce a `drift` event: assert it, document the change in the fixture README, then teach the adapter the new name while keeping the old one.
- Add the new hook payloads to `state.test.js` if their shape changed.
