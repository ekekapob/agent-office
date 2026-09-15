# Character presets

One JSON per preset. Each holds only the character part of a theme, so it can be applied on top of
any room without changing the room.

Made in the Character Lab (`npm run charlab`), applied with `node tools/charlab/apply.mjs <name> --theme <theme>`.

## Shape

```json
{
  "kind": "agentdeck-character-preset",
  "version": 1,
  "name": "office-default",
  "label": "Office default",
  "note": "free text, up to 200 chars",
  "palette": {
    "skin": "#f2c9a0", "hat": "#ffcc33", "cap": "#2f9e6b", "gold": "#e0b354",
    "jewel": "#ff4d4d", "tie": "#ffd166", "lens": "#dfe6ee",
    "outline": "#0a0f1e", "ink": "#111111",
    "earInner": "#e8a0a8", "beak": "#ffb347", "coat": "#e8edf5",
    "visor": "#7fe7ff", "metal": "#9aa8c0", "lip": "#c2695f", "blush": "#e8a0a8"
  },
  "figures": {
    "lead":    { "shirt": "#2b2b2e", "hair": "#d9c89a", "pants": "#26282e", "acc": "glasses", "outfit": "turtleneck", "head": "swept", "face": "john", "crown": true },
    "Explore": { "shirt": "#2f9e6b", "hair": "#5a3a1a", "pants": "#2b3a4b", "acc": "cap", "outfit": "tank", "head": "rabbit" },
    "default": { "shirt": "#7f8ba6", "hair": "#3a2a1a", "pants": "#2b3a4b", "acc": null, "outfit": "shirt", "head": "human" }
  }
}
```

## Saved presets

| Preset | What it is |
|---|---|
| `office-default` | The stock office cast — the way back to the original look |
| `john` | Blond swept hair, black turtleneck and glasses on the lead; dark hair and a white shirt on everyone else |
| `showcase` | One figure per head type, one per outfit and one per face, 26 in all. Load it to see what the renderer can draw |

## Rules

- `palette` may hold only those sixteen keys. They are `theme.palette` keys the figure renderer
  reads. A room colour such as `bg` or `floor1` is dropped when the preset is saved.
- `figures` keys are subagent type names. `lead` is the session owner, `default` is the fallback for
  a type with no entry of its own. Keep both.
- `acc` is one of `tie`, `cap`, `hat`, `glasses`, `badge`, or `null`.
- `outfit` is one of `shirt`, `suit`, `turtleneck`, `tank`, `hoodie`, `bikini`, `dress`, `labcoat`,
  `armor`. It changes the torso, the legs and the sleeves. Missing means `shirt`.
- `head` is one of `human`, `swept`, `rabbit`, `cat`, `fox`, `bear`, `bird`, `robot`, `frog`. The
  human head stays in every one; the type adds ears, a beak, a visor or a side fringe. Missing means
  `human`.
- `face` is one of `plain`, `john`, `smile`, `focused`, `tired`, `wink`. It draws brow, eyes, nose
  and mouth on the front of the head. Missing means `plain`, which is the original two-pixel eyes,
  so an old theme looks exactly as before. A `robot` head ignores `face` and shows its visor.
- A value the renderer cannot draw is rejected, not ignored. `drawFigure()` in
  `web/js/renderer/iso2d/figure.js` is the source of truth for all three lists.
- Colours are `#rrggbb`. The renderer derives the lit top face and the shaded right face itself.
- Applying a preset **replaces** the theme's whole `figures` block. A type in the theme but not in
  the preset is removed.
