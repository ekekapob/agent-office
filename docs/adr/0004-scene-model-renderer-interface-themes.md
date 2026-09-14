# ADR-0004 · Scene model and renderer interface; Canvas 2D isometric renderer first; themes are data

Status: Proposed · 2026-09-13

## Context
The mockups draw with hand-written Canvas 2D code in one file. John wants the frame to stay flexible for a future 3D renderer or a different art style, without the rest of the app changing.

## Decision
Split into three layers that only talk downward:

1. **Store** (`web/js/store.js`): domain model from the server, plus UI state (selected agent, focused room, camera).
2. **Layout** (`web/js/layout.js`): turns the domain model into a *scene model*: a list of entities with world positions on a tile grid, facing, state, and optional path. It owns desk assignment, pod slots, hallway length, paths to the door, seat positions, and transitions (joining, leaving, beam). It knows nothing about pixels.
3. **Renderer** (`web/js/renderer/*`): draws a scene model. Interface:

```
createRenderer(canvas, theme) -> {
  resize(w, h), setCamera({x, y, zoom}),
  render(scene, timeMs),                 // draws one frame
  project(worldPos) -> {x, y},           // world -> CSS px, used by every HTML overlay
  pick(cssX, cssY) -> entityId | null,   // hit test
  portrait(canvas, entity, timeMs),      // small figure for the hover card
  destroy()
}
```

- `renderer/iso2d/` is the first implementation: the mockups' projection, scanline rasteriser, cuboid figures and props, moved into modules. A `renderer/three/` could implement the same interface later.
- HTML overlays (bubbles, name plates, cards, rooms list) live above the canvas and place themselves with `project()`. They never touch the renderer's internals, so they work with any renderer.
- **Theme is JSON**, not code: palette, floor and wall styles, prop set per role (desk, chair, door, board, core, pad), figure palette per agent type (shirt, hair, accessory), model chip colours, state colours, and text (deck, airlock, huddle). `theme/spaceship.json` and `theme/office.json` ship first. A renderer reads the theme; adding a theme adds no code.
- Camera is its own module (`camera.js`): pan, stepped zoom about a point, glide-to, fit, full screen. Renderer-independent.

## Consequences
- Swapping renderer means implementing five functions. Layout, store, panels and overlays are untouched.
- The scene model is a plain array of objects and can be snapshot-tested without a browser (ADR-0010).
- Slightly more files than the mockup, but each with one job. Target: store, layout, camera, overlays, panel, errors, sse, theme loader, one renderer folder.

## Alternatives considered
- Keep the mockup's single file and add features: fastest now, unmaintainable within weeks. Rejected.
- Adopt PixiJS or Phaser now: real engines, but they pull in a build step and their own scene graph; the current 2D needs are met by ~600 lines of our own. Revisit if sprite counts grow or a 3D renderer is chosen (Three.js would then be the natural second implementation).
