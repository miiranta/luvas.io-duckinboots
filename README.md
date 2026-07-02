# Duck in Boots — luvas.io

A web remake of *GameJanina2026* (originally Rust + WGPU), rebuilt as an
Angular 21 app with a TypeScript engine rendering to a 2D canvas. Menus, HUD
and overlays are Angular components; the simulation is plain TypeScript.

## Gameplay

Top-down puzzle: the duck is tethered to an anchor by a chain. Place portal
pairs (SPACE) to thread the chain through space, push/pull boxes, and cinch
the chain tight around every magenta ball to squeeze them all and win.

| Key | Action |
| --- | --- |
| WASD / arrows | Move |
| SPACE | Place portal (alternates in / out) |
| Mouse wheel | Zoom |
| P / ESC | Pause |
| F | Fullscreen (while playing) |
| F3 | Collision debug overlay |

## Structure

```
api/            Express server that serves the compiled app (deploy stage)
app/            Angular 21 application
  public/assets Sprites, level.json, fonts (only assets the level references)
  src/engine/   Reusable engine: math, loop, input, camera, sprites, level IO
  src/game/     Game logic: collision, chain, portals, squeezables, world
  src/app/      Angular UI: menus, HUD, overlays, i18n, game service
```

**Engine vs game:** `src/engine` has no game knowledge (could power another
project); `src/game` is pure simulation with no Angular imports; `src/app`
contains all UI and wiring. The map editor from the original project was not
ported — `level.json` is consumed as authored.

**Physics notes:** collision is continuous (swept AABB/point with slide), so
nothing tunnels at any speed; the broad phase is a uniform spatial hash grid
built once from the static level. The chain is a swept-Verlet constraint
solver. Two fixes over the original: portal pull-through tightens frozen
snippets by midpoint relaxation with swept joint moves (they wrap corners
like a rope over a pulley instead of lerping straight through walls), and
merging back through a portal rebuilds the chain from its current shape
rather than a straight line (which could cross geometry). Squeezables are
circle colliders, so the chain hugs them roundly and the tight-loop squeeze
test is actually attainable. Off-screen sprites are culled at draw time.

## Development

```sh
cd app
npm install
npm start          # dev server on http://localhost:4200
npm run build      # production build to dist/
```

## Deploy

Same standard as the other luvas.io apps (multi-stage Docker build, Express
serving the compiled bundle):

```sh
docker compose up --build -d   # serves on port 7115
```
