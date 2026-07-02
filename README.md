# Duck in Boots — luvas.io

A web remake of *GameJanina2026* (originally Rust + WGPU), rebuilt as an
Angular 21 app with a TypeScript engine rendering to a 2D canvas. Menus, HUD
and overlays are Angular components; the simulation is plain TypeScript.

## Gameplay

Top-down puzzle: the duck is tethered to an anchor by three chains of
different lengths. Place portal pairs (SPACE) to thread the chains through
space, push/pull boxes, and cinch a chain tight around every magenta ball to
squeeze them all and win.

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
solver. Portal pull-through of frozen chain snippets is collision-aware — a
fix over the original, where straightened snippets could clip through walls.

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
