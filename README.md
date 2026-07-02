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
| F4 | Toggle shader effects |

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
built once from the static level. The chain is a single unified class
(`game/chain.ts`): the rope is a list of *spans* — frozen ones pinned between
portals plus one active, simulated span — so simulation, portal pull-through,
split and merge all share the same obstacle context (statics **and**
dynamics) by construction. Fixes over the original: pull-through tightens
frozen spans by midpoint relaxation with swept joint moves (the rope wraps
corners and squeezables like a rope over a pulley instead of lerping straight
through them); merging back through a portal continues from the rope's
current shape rather than a straight line; and per-joint obstacle buckets are
re-gathered when a tension cascade moves a joint beyond their coverage (the
original's fast-motion clipping). Squeezables are circle colliders, so loops
hug them roundly and the tight-loop squeeze test is attainable. Chains and
portals draw as ground decals under the Y-sorted entities; off-screen sprites
are culled at draw time.

**Visual effects:** a WebGPU post-processing pass (`engine/post-processor.ts`,
WGSL) runs the rendered 2D frame through bloom-lite, subtle chromatic
aberration, colour grading, vignette and film grain; it degrades gracefully
(no WebGPU → raw canvas) and F4 toggles it at runtime. In-world effects are a
small particle system (`game/particles.ts`: squeeze bursts, portal sparkles,
footstep dust) plus elliptical contact shadows under the duck and the balls.
Tile sprites snap their destination rects to whole device pixels, which
removes the black seam lines fractional scaling otherwise leaves between
flush tiles.

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
