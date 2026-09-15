# Character Lab

A separate local page for designing the people Agent Deck draws, and saving each design as a
**preset** file you can apply to any theme later.

It is not part of the dashboard. It runs on its own port, never reads `~/.claude`, never opens a
session, and never calls a model. It imports the real renderer modules from `web/js/renderer/iso2d/`,
so what you see in the lab is exactly what the deck draws.

## Run it

```sh
npm run charlab              # http://127.0.0.1:4800/
npm run charlab -- --port 4900
```

Leave the deck running or not — the two do not talk to each other.

## Run it in Docker

```sh
npm run charlab:docker       # docker compose up --build -d charlab
npm run charlab:docker:stop
```

Or straight from compose, in the `agent-deck` folder:

```sh
docker compose up --build charlab    # the lab alone, on http://127.0.0.1:4800/
docker compose up --build            # the lab and the deck together
docker compose logs -f charlab
docker compose down
```

It shares the `agent-deck:local` image with the deck and only changes the command, so there is no
second build. The lab container reads nothing under `~/.claude`, so it runs on a machine that has no
Claude Code on it.

Four bind mounts do the work:

| Host path | In the container | Why |
|---|---|---|
| `./presets` | `/app/presets` read-write | **Save preset** writes into your checkout, not into the container |
| `./themes` | `/app/themes` read-only | pick a room |
| `./web` | `/app/web` read-only | the renderer; edit on the host and reload, no rebuild |
| `./tools/charlab` | `/app/tools/charlab` read-only | the lab page itself, same deal |

The container runs as the `node` user (uid 1000). Docker Desktop on Windows and macOS ignores that
for bind mounts, so saving works. On plain Linux, if a save fails with a permission error, either
run `chown -R 1000:1000 presets` or add `user: "${UID}:${GID}"` to the `charlab` service.

Port `4800` is published on `127.0.0.1` only. Change it to `"4800:4800"` in `compose.yaml` to reach
the lab from another machine.

## What you can change

| Control | Effect |
|---|---|
| Shared colours | `skin`, hard hat, cap, crown, crown jewel, tie/badge, glasses lens, outline, eyes, ear lining, beak, lab coat, robot visor, metal — one value each, used by every figure |
| Per type: shirt / hair / pants | The three body colours for that agent type |
| Per type: outfit | `shirt`, `suit`, `turtleneck`, `tank`, `hoodie`, `bikini`, `dress`, `labcoat`, `armor` — changes torso, legs and sleeves |
| Per type: head | `human`, `swept`, `rabbit`, `cat`, `fox`, `bear`, `bird`, `robot`, `frog` — the human head plus ears, a beak, a visor or a side fringe |
| Per type: face | `plain`, `john`, `smile`, `focused`, `tired`, `wink` — brow, eyes, nose and mouth drawn on the front of the head. `plain` is the original two-pixel eyes |
| Per type: accessory | `tie`, `cap`, `hat`, `glasses`, `badge`, or none |
| Per type: crown | The gold crown the lead wears |
| Add / remove type | The key is the subagent type name, e.g. `Explore`, `code-review`. `lead` and `default` are the fallbacks |
| Room | Which theme's floor and background sit behind the preview. Not saved in the preset |
| State, facing, seated, context warning, zoom | Preview only |

Body geometry — head size, height, leg length — is **not** in the lab. Those numbers are hard-coded in
`web/js/renderer/iso2d/figure.js` and changing them is a renderer change.

Load the `showcase` preset to see every outfit and every head at once.

### Adding a new outfit, head or face

Two files, in this order:

1. `web/js/renderer/iso2d/figure.js` — add the name to `OUTFITS`, `HEADS` or `FACES`, then draw it in
   `drawFigure`. A face is easier than the other two: add a row to `FACE_ART` and nothing else.
2. `tools/charlab/serve.mjs` — add the same name to its matching list, or the lab rejects it on save.

`tests/charlab.test.js` walks the lists, so the new name is covered with no test change. A new colour
goes in `DETAIL` in `iso2d/colors.js` and in `SHARED_KEYS` in `serve.mjs`.

A face is 6 columns by 5 rows of characters. Row 0 sits under the fringe, row 4 is the mouth line.
`b` brow · `k` ink · `n` skin shadow · `m` lip · `p` blush · `.` nothing:

```js
smile: ['.b..b.', '.k..k.', '.k..k.', 'p.n..p', '.mmmm.'],
```

## Save and apply

**Save preset** writes `presets/<name>.json` through the lab's own server. The name is slugified:
lowercase letters, digits and dashes.

Apply it to a theme:

```sh
node tools/charlab/apply.mjs --list
node tools/charlab/apply.mjs my-team --theme office --dry   # show the changes, write nothing
node tools/charlab/apply.mjs my-team --theme office         # edit themes/office.json in place
node tools/charlab/apply.mjs my-team --theme office --as night   # write themes/night.json instead
```

A preset only carries character data, so applying it never touches floors, walls, props, state
colours, model chips or room text. With `--as`, add `{ name: 'night', label: '...' }` to `THEMES` in
`web/js/main.js` to get it in the theme picker.

## Files

```
tools/charlab/
  index.html    the lab page: panels, preview, preset load/save
  serve.mjs     static files (web/, themes/, presets/, tools/charlab/) + the preset API
  apply.mjs     merge a preset into a theme file
presets/        saved presets, one JSON per preset
tests/charlab.test.js   validation and merge tests
```

## API

| Method | Path | Does |
|---|---|---|
| GET | `/api/themes` | theme names in `themes/` |
| GET | `/api/presets` | saved presets with label and type count |
| GET | `/api/presets/<name>` | one preset |
| POST | `/api/presets/<name>` | validate, then write `presets/<name>.json` |

Validation rejects a colour that is not `#rrggbb`, an accessory the renderer cannot draw, a bad
preset or type name, and a preset with no agent types. A room colour such as `bg` or `floor1` is
dropped with a note, so a preset stays character-only.

The server binds `127.0.0.1` and serves only those four directories. It is a local design tool, not
something to expose.
