import { Camera2D } from '../engine/camera';
import { Input } from '../engine/input';
import { Circle, Rect, Vec2, clamp } from '../engine/math';
import { LevelData, getTag, isRect, shapeId } from '../engine/level';
import { SpriteSheet } from '../engine/sprite-sheet';
import {
    Collider,
    ColliderGrid,
    aabb,
    circleCollider,
    depenetrateAabb,
    pushRectOutOfAabb,
    pushRectOutOfCircle,
    resolveAabb,
} from './collision';
import {
    MovableBox,
    barCollidersFrom,
    bindCollisionsToAssets,
    isMovableTag,
    movableBoxesFrom,
    spawnItemSqueezables,
    staticCollidersFrom,
} from './level-setup';
import { Player } from './player';
import { Chain } from './chain';
import { Particles } from './particles';
import { Portals } from './portals';
import { Squeezables } from './squeezables';

/** Where the chains are anchored, in world coordinates. */
const CHAIN_ANCHOR = new Vec2(992, 128);
/** Fallback player spawn when the level doesn't author one. */
const PLAYER_START = new Vec2(0, 0);
/** Seconds of player stillness before the chains are allowed to freeze. */
const PLAYER_STILL_THRESHOLD = 0.01;
/** Max joint displacement (px/frame) considered "totally still". */
const CHAIN_STILL_THRESHOLD = 0.01;
/** Iterations of the chain-length player constraint per frame. */
const CHAIN_CLAMP_ITERS = 4;
/** Seconds lingering in a just-exited portal before the crossing auto-undoes. */
const PORTAL_RETURN_SECS = 5;
/** Snap grid (world px) that resting movable boxes settle onto. */
const GRID_SIZE = 2;
/** Reach (world px) of a box's extended pull border. */
const PULL_REACH = 6;

/** Assets the world needs, loaded before construction. */
export interface WorldAssets {
    ducky: SpriteSheet;
    portalPurple: SpriteSheet;
    portalGreen: SpriteSheet;
    level: LevelData;
    textures: Map<string, HTMLImageElement>;
}

/** Total rope length of the chain tethering the player to the anchor. */
const CHAIN_LENGTH = 1600;
/** Physics link spacing of the chain (also its visual granularity). */
const CHAIN_LINK_SIZE = 4;
/** The chain's rope colour (theme gold). */
const CHAIN_COLOR = '#e8bd4a';

/** Handle to a thing the player can push/pull. */
type MovableRef = { kind: 'box'; index: number } | { kind: 'squeezable'; index: number };

function sameRef(a: MovableRef, b: MovableRef): boolean {
    return a.kind === b.kind && a.index === b.index;
}

function snapToGrid(v: number): number {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

function isOnGrid(v: number): boolean {
    return Math.abs(v - snapToGrid(v)) < 1e-6;
}

/**
 * Snap one axis of a resting object to the grid, but never *off* a wall it's
 * pressed against: pressed on one side we round toward it so the object stays
 * flush instead of popping back a cell.
 */
function snapAxis(v: number, blockedNeg: boolean, blockedPos: boolean): number {
    const lo = Math.floor(v / GRID_SIZE) * GRID_SIZE;
    const hi = Math.ceil(v / GRID_SIZE) * GRID_SIZE;
    if (blockedPos && !blockedNeg) return hi;
    if (blockedNeg && !blockedPos) return lo;
    return v - lo <= hi - v ? lo : hi;
}

/** Clamp `v` so it never has the opposite sign of `want`. */
function clampToSign(v: number, want: number): number {
    if (want > 0) return Math.max(v, 0);
    if (want < 0) return Math.min(v, 0);
    return v;
}

/**
 * Decide whether the player rect `p` is latched to box `b` for pulling: the
 * player stands in the box's extended border just outside one face and `disp`
 * carries them outward along that face's normal. Returns the outward unit
 * normal, or `null`. When straddling a corner, the face most aligned with
 * `disp` wins.
 */
function pullNormal(p: Rect, b: Rect, disp: Vec2, reach: number): Vec2 | null {
    const overlapX = Math.min(p.right, b.right) - Math.max(p.x, b.x);
    const overlapY = Math.min(p.bottom, b.bottom) - Math.max(p.y, b.y);
    const TOL = 0.5;

    const faces: [number, number, Vec2][] = [
        [b.x - p.right, overlapY, new Vec2(-1, 0)], // player left of box
        [p.x - b.right, overlapY, new Vec2(1, 0)], // player right of box
        [b.y - p.bottom, overlapX, new Vec2(0, -1)], // player above box
        [p.y - b.bottom, overlapX, new Vec2(0, 1)], // player below box
    ];
    let best: { dot: number; n: Vec2 } | null = null;
    for (const [gap, perp, n] of faces) {
        if (perp > 0 && gap >= -TOL && gap <= reach) {
            const dot = disp.dot(n);
            if (dot > 0 && (!best || dot > best.dot)) best = { dot, n };
        }
    }
    return best ? best.n : null;
}

/**
 * The gameplay world: level, player, movable boxes, chains, portals, and
 * squeezables. Pure simulation + world-space rendering; all UI (menus, HUD)
 * lives in Angular components.
 */
export class World {
    readonly player: Player;
    private readonly level: LevelData;
    private readonly textures: Map<string, HTMLImageElement>;

    private readonly staticColliders: Collider[];
    private readonly barColliders: Collider[];
    /** Statics + bars: the never-changing solid set, built once. */
    private readonly immovableColliders: Collider[];
    private readonly staticGrid: ColliderGrid;
    private readonly boxes: MovableBox[];
    private readonly playerStartPos: Vec2;

    private chains: Chain[] = [];
    private portals: Portals;
    private portalsRestarting = false;
    private crossingExits: Circle[] = [];
    private crossingGuard: Circle | null = null;
    private guardDwell = 0;
    private prevPlayerPos: Vec2;
    private playerStillFor = 0;

    readonly squeezables = new Squeezables();
    squeezeCount = 0;
    private readonly particles = new Particles();
    private dustTimer = 0;

    zoom = 3;
    debugCollisions = false;

    // Reusable per-frame collider buffers.
    private colliders: Collider[] = [];
    private playerColliders: Collider[] = [];
    private moveColliders: Collider[] = [];
    private dynamicColliders: Collider[] = [];

    // This frame's world→device transform (x_dev = x * scale + tx), captured
    // in `draw` so sprites can snap their destination rects to whole device
    // pixels — see `drawSprite`.
    private frameScale = 1;
    private frameTx = 0;
    private frameTy = 0;

    constructor(private readonly assets: WorldAssets) {
        this.level = assets.level;
        this.textures = assets.textures;

        // Resolve the designer's missing tag/ID wiring, then derive colliders.
        bindCollisionsToAssets(this.level, this.textures);
        this.staticColliders = staticCollidersFrom(this.level);
        this.staticGrid = new ColliderGrid(this.staticColliders);
        this.barColliders = barCollidersFrom(this.level);
        this.immovableColliders = [...this.staticColliders, ...this.barColliders];
        this.boxes = movableBoxesFrom(this.level, snapToGrid);
        this.playerStartPos = playerStartOf(this.level);

        this.player = new Player(assets.ducky);
        this.player.pos = this.playerStartPos.clone();
        this.prevPlayerPos = this.player.pos.clone();

        spawnItemSqueezables(this.level, this.squeezables);
        this.squeezables.onSqueeze((ev) => {
            this.squeezeCount++;
            this.particles.burst(ev.pos, ['#f5008c', '#ff8fc8', '#ffd6ea'], 26, 150, 0.8);
        });

        this.chains = this.newChains();
        this.portals = new Portals(assets.portalPurple, assets.portalGreen);
    }

    /** Build the chain tethering the player to the anchor. */
    private newChains(): Chain[] {
        const start = this.player.pos.add(this.player.chainOffset);
        return [new Chain(CHAIN_ANCHOR, start, CHAIN_LENGTH, CHAIN_LINK_SIZE, CHAIN_COLOR)];
    }

    /** True when every squeezable has been crushed (the win condition). */
    get allSqueezed(): boolean {
        return this.squeezables.totalCount > 0 && this.squeezables.aliveCount === 0;
    }

    /** Reset world state for a fresh run. Reuses loaded assets and level. */
    reset(): void {
        this.player.pos = this.playerStartPos.clone();
        this.player.velocity = new Vec2();
        this.chains = this.newChains();
        this.portals.startClosingAll();
        this.portalsRestarting = true;
        this.crossingExits = [];
        this.crossingGuard = null;
        this.guardDwell = 0;
        this.zoom = 3;
        this.squeezables.reviveAll();
        this.squeezeCount = 0;
        this.prevPlayerPos = this.player.pos.clone();
        this.playerStillFor = 0;
        for (let i = 0; i < this.boxes.length; i++) {
            this.moveBox(i, this.boxes[i].origin.sub(this.boxes[i].rect.position()));
        }
    }

    /** Advance the world one fixed step. Pausing simply stops calling this. */
    update(input: Input, dt: number): void {
        if (input.wasPressed('F3')) this.debugCollisions = !this.debugCollisions;
        this.zoom = clamp(this.zoom + input.wheelMove() * 0.1, 0.5, 6);

        // Track how long the player has been still.
        if (this.player.pos.distanceSq(this.prevPlayerPos) > 1e-4) {
            this.playerStillFor = 0;
            this.prevPlayerPos = this.player.pos.clone();
        } else {
            this.playerStillFor += dt;
        }

        this.player.integrateInput(input, dt);

        // Portal animations; while resetting, wait for the closing anims to
        // finish before creating a fresh empty set.
        this.portals.update(dt);
        if (this.portalsRestarting && this.portals.isFinishedClosing()) {
            this.portals = new Portals(this.assets.portalPurple, this.assets.portalGreen);
            this.portalsRestarting = false;
        }
        if (!this.portalsRestarting && input.wasPressed('Space')) {
            this.portals.place(this.player.chainPoint());
            this.particles.burst(this.player.chainPoint(), ['#c39bff', '#fff'], 14, 90, 0.5);
        }

        // Ambient sparkles drifting off the idle portal rings.
        for (const p of this.portals.idlePortals()) {
            if (Math.random() < dt * 3) {
                const angle = Math.random() * Math.PI * 2;
                const at = p.center.add(new Vec2(Math.cos(angle), Math.sin(angle)).scale(p.radius * 0.85));
                this.particles.sparkle(at, p.tint);
            }
        }

        // Footstep dust while the duck runs.
        this.dustTimer -= dt;
        const speed = this.player.velocity.length();
        if (speed > 180 && this.dustTimer <= 0) {
            this.dustTimer = 0.07;
            const feet = this.player.pos.add(new Vec2(this.player.shape.x / 2, this.player.shape.y - 2));
            this.particles.dust(feet, this.player.velocity.normalize());
        }
        this.particles.update(dt);

        // ── Collision phase ──────────────────────────────────────────────────
        // Move the player continuously (sliding on the static world), shoving
        // and dragging movables. Then rebuild the collider set, run the portal
        // crossing, simulate the chains, constrain the player to them, and
        // finish with a depenetration pass.
        this.rebuildMoveColliders();
        this.movePlayerAndPush(dt);
        this.rebuildColliders();
        if (!this.portalsRestarting) this.handlePortalCrossing(dt);
        this.stepChains(dt);
        this.constrainPlayerToChains();
        this.depenetratePlayer();
        this.snapPlayer();

        // Sync the chain ends to the player's final attachment point.
        const end = this.player.chainPoint();
        for (const chain of this.chains) chain.setEnd(end);

        // Crush anything a chain has cinched tight.
        this.squeezables.update(this.chains);
    }

    // ── Collider set management ──────────────────────────────────────────────

    /**
     * `colliders` is the **chain** set (statics + boxes + live squeezables —
     * bars excluded so the chain sweeps past them); `playerColliders` adds the
     * bars back for the player's constraint and rest-snap.
     */
    private rebuildColliders(): void {
        this.colliders.length = 0;
        this.colliders.push(...this.staticColliders);
        for (const b of this.boxes) this.colliders.push(aabb(b.rect));
        this.squeezables.extendColliders(this.colliders);

        this.playerColliders.length = 0;
        this.playerColliders.push(...this.colliders, ...this.barColliders);
    }

    /** The player's *movement* set: just the immovable world (statics + bars). */
    private rebuildMoveColliders(): void {
        // The immovable set never changes; share the prebuilt array.
        this.moveColliders = this.immovableColliders;
    }

    /** Every movable this frame as `(handle, current AABB)`. */
    private movables(): { ref: MovableRef; rect: Rect }[] {
        const out: { ref: MovableRef; rect: Rect }[] = this.boxes.map((b, index) => ({
            ref: { kind: 'box', index },
            rect: b.rect,
        }));
        for (const { index, center, radius } of this.squeezables.eachAlive()) {
            out.push({
                ref: { kind: 'squeezable', index },
                rect: new Rect(center.x - radius, center.y - radius, radius * 2, radius * 2),
            });
        }
        return out;
    }

    /**
     * Obstacles a single movable may move against: the immovable world plus
     * every *other* movable (so movables can't be shoved through each other).
     */
    /**
     * Minimum translation that separates a movable from the player, or `null`
     * when they don't overlap. Boxes separate along the axis of least rect
     * overlap; squeezables separate **radially** (they are circles), so
     * pushing one feels round instead of boxy.
     */
    private pushSeparation(ref: MovableRef, rect: Rect): Vec2 | null {
        const player = this.player.collider();
        if (ref.kind === 'box') {
            const push = pushRectOutOfAabb(rect.position(), rect.size(), player);
            return push ? push[0].sub(rect.position()) : null;
        }
        // Circle case: push the *player* out of the circle, then move the
        // circle by the opposite vector (equivalent separation).
        const center = rect.center();
        const radius = rect.width / 2;
        const pushedPlayer = pushRectOutOfCircle(this.player.pos, this.player.shape, center, radius);
        return pushedPlayer ? this.player.pos.sub(pushedPlayer) : null;
    }

    private movableObstacles(skip: MovableRef): Collider[] {
        const obstacles: Collider[] = [...this.immovableColliders];
        this.boxes.forEach((b, index) => {
            if (!sameRef(skip, { kind: 'box', index })) obstacles.push(aabb(b.rect));
        });
        for (const { index, center, radius } of this.squeezables.eachAlive()) {
            if (!sameRef(skip, { kind: 'squeezable', index })) {
                obstacles.push(circleCollider(center, radius));
            }
        }
        return obstacles;
    }

    // ── Player movement + push/pull ──────────────────────────────────────────

    /**
     * Move the player by its velocity (resolved against the static world),
     * then run its movable interactions: **push** (shove a movable it walks
     * into) and **pull** (drag one it's latched to and walks away from).
     * Untouched boxes settle onto the grid.
     */
    private movePlayerAndPush(dt: number): void {
        const displacement = this.player.velocity.scale(dt);
        const oldPos = this.player.pos.clone();

        const movables = this.movables();
        const pull = this.player.abilities.pull
            ? this.findPull(movables, this.player.collider(), displacement)
            : null;

        this.player.pos = resolveAabb(
            this.player.pos,
            this.player.shape,
            displacement,
            this.moveColliders,
        );

        const touched = new Array(this.boxes.length).fill(false);

        // PUSH: shove any movable the player walked into (except the pulled one).
        if (this.player.abilities.push) {
            for (const { ref, rect } of movables) {
                if (pull && sameRef(ref, pull.ref)) continue;
                const want = this.pushSeparation(ref, rect);
                if (!want) continue;
                if (ref.kind === 'box') touched[ref.index] = true;
                const moved = this.resolveMovable(ref, rect, want);
                this.moveMovable(ref, moved);

                // Push the player back by whatever separation it couldn't take.
                const residual = want.sub(moved);
                if (residual.lengthSq() > 1e-6) {
                    this.player.pos = resolveAabb(
                        this.player.pos,
                        this.player.shape,
                        residual.neg(),
                        this.moveColliders,
                    );
                }
            }
        }

        // PULL: drag the latched movable by however far the player actually
        // moved outward. It trails at a constant gap, clamped by the world.
        if (pull) {
            const outward = this.player.pos.sub(oldPos).dot(pull.normal);
            if (outward > 0) {
                const entry = movables.find((m) => sameRef(m.ref, pull.ref));
                if (entry) {
                    const want = pull.normal.scale(outward);
                    const moved = this.resolveMovable(pull.ref, entry.rect, want);
                    this.moveMovable(pull.ref, moved);
                    if (pull.ref.kind === 'box') touched[pull.ref.index] = true;
                }
            }
        }

        // Settle untouched boxes onto the grid so resting boxes sit on exact
        // grid coordinates and never accumulate float drift.
        for (let i = 0; i < this.boxes.length; i++) {
            if (!touched[i]) this.snapBox(i);
        }
    }

    /** First movable the player is latched to for pulling this frame. */
    private findPull(
        movables: { ref: MovableRef; rect: Rect }[],
        player: Rect,
        disp: Vec2,
    ): { ref: MovableRef; normal: Vec2 } | null {
        for (const { ref, rect } of movables) {
            const normal = pullNormal(player, rect, disp, PULL_REACH);
            if (normal) return { ref, normal };
        }
        return null;
    }

    /**
     * Resolve a movable's intended `want` translation against the world and
     * every other movable, clamped so it never travels against the push.
     */
    private resolveMovable(ref: MovableRef, rect: Rect, want: Vec2): Vec2 {
        const obstacles = this.movableObstacles(ref);
        const resolved = resolveAabb(rect.position(), rect.size(), want, obstacles);
        const raw = resolved.sub(rect.position());
        return new Vec2(clampToSign(raw.x, want.x), clampToSign(raw.y, want.y));
    }

    private moveMovable(ref: MovableRef, delta: Vec2): void {
        if (ref.kind === 'box') this.moveBox(ref.index, delta);
        else this.squeezables.translate(ref.index, delta);
    }

    /** Translate box `i`, dragging every sprite linked to it along rigidly. */
    private moveBox(i: number, delta: Vec2): void {
        if (delta.x === 0 && delta.y === 0) return;
        const box = this.boxes[i];
        box.rect.x += delta.x;
        box.rect.y += delta.y;
        const instances = this.level.sprite_instances ?? [];
        for (const { index, offset } of box.sprites) {
            instances[index].x = box.rect.x + offset.x;
            instances[index].y = box.rect.y + offset.y;
        }
    }

    /**
     * Probe whether `rect` is resting against obstacles just past its
     * negative/positive faces along `axis`, by nudging it a pixel each way.
     */
    private blockedAxes(rect: Rect, axis: Vec2, obstacles: Collider[]): [boolean, boolean] {
        const PROBE = 1;
        const pos = rect.position();
        const size = rect.size();
        const movedNeg = resolveAabb(pos, size, axis.scale(-PROBE), obstacles).sub(pos);
        const movedPos = resolveAabb(pos, size, axis.scale(PROBE), obstacles).sub(pos);
        return [movedNeg.length() < PROBE - 1e-3, movedPos.length() < PROBE - 1e-3];
    }

    /** Settle box `i` onto the grid, contact-aware (never off a wall). */
    private snapBox(i: number): void {
        const rect = this.boxes[i].rect;
        // Fast path: resting boxes are already on the grid, so skip the whole
        // obstacle build + contact probing (this runs for every box every
        // frame; the expensive path is only ever taken just after a push).
        if (isOnGrid(rect.x) && isOnGrid(rect.y)) return;
        // The player counts as an obstacle too, so settling never snaps a box
        // *into* the player (which would depenetrate them into a wall).
        const obstacles = this.movableObstacles({ kind: 'box', index: i });
        obstacles.push(aabb(this.player.collider()));
        const [bnX, bpX] = this.blockedAxes(rect, Vec2.X, obstacles);
        const [bnY, bpY] = this.blockedAxes(rect, Vec2.Y, obstacles);
        const target = new Vec2(snapAxis(rect.x, bnX, bpX), snapAxis(rect.y, bnY, bpY));
        const delta = target.sub(rect.position());
        if (delta.lengthSq() < 1e-12) return;
        const resolved = resolveAabb(rect.position(), rect.size(), delta, obstacles);
        this.moveBox(i, resolved.sub(rect.position()));
    }

    /** Snap the player to the grid once it has fully stopped (contact-aware). */
    private snapPlayer(): void {
        if (this.player.velocity.x !== 0 || this.player.velocity.y !== 0) return;
        if (isOnGrid(this.player.pos.x) && isOnGrid(this.player.pos.y)) return;
        const rect = this.player.collider();
        const [bnX, bpX] = this.blockedAxes(rect, Vec2.X, this.playerColliders);
        const [bnY, bpY] = this.blockedAxes(rect, Vec2.Y, this.playerColliders);
        const target = new Vec2(
            snapAxis(this.player.pos.x, bnX, bpX),
            snapAxis(this.player.pos.y, bnY, bpY),
        );
        const delta = target.sub(this.player.pos);
        if (delta.lengthSq() < 1e-12) return;
        this.player.pos = resolveAabb(
            this.player.pos,
            this.player.shape,
            delta,
            this.playerColliders,
        );
    }

    /**
     * Eject the player from any overlaps: movables first, immovable statics
     * **last** — a player squeezed between a box and a wall is always ejected
     * from the wall (at worst clipping the box a hair, cleared next frame).
     */
    private depenetratePlayer(): void {
        const movable: Collider[] = this.boxes.map((b) => aabb(b.rect));
        this.squeezables.extendColliders(movable);
        this.player.pos = depenetrateAabb(this.player.pos, this.player.shape, movable);
        this.player.pos = depenetrateAabb(this.player.pos, this.player.shape, this.immovableColliders);
    }

    // ── Chains + portals ─────────────────────────────────────────────────────

    /**
     * Drive the chains to follow the player and simulate them. They freeze
     * once the player and chains have all gone still, saving work and
     * avoiding micro-oscillation.
     */
    private stepChains(dt: number): void {
        const still =
            this.playerStillFor >= PLAYER_STILL_THRESHOLD &&
            this.chains.every((c) => c.isStill(CHAIN_STILL_THRESHOLD));
        const end = this.player.chainPoint();

        this.dynamicColliders.length = 0;
        for (const b of this.boxes) this.dynamicColliders.push(aabb(b.rect));
        this.squeezables.extendColliders(this.dynamicColliders);

        for (const chain of this.chains) {
            chain.setStart(CHAIN_ANCHOR);
            chain.setEnd(end);
            // When everything is still, skip the active-span simulation (the
            // pull-through tightening still runs — it's demand-driven).
            chain.update(dt, this.staticGrid, this.dynamicColliders, !still);
        }
    }

    /**
     * Detect the player crossing a portal and apply it to every chain in
     * lockstep: re-entering the most recent exit *merges* (undoes) that
     * crossing; entering any other circle *splits* a new snippet. The guard
     * debounces the circle the player stands in so a crossing fires once;
     * lingering `PORTAL_RETURN_SECS` in it auto-undoes the last crossing.
     */
    private handlePortalCrossing(dt: number): void {
        const pt = this.player.chainPoint();

        if (this.crossingGuard) {
            if (this.crossingGuard.containsPoint(pt)) {
                this.guardDwell += dt;
                const last = this.crossingExits[this.crossingExits.length - 1];
                if (
                    this.guardDwell >= PORTAL_RETURN_SECS &&
                    last &&
                    last.equals(this.crossingGuard)
                ) {
                    this.crossingGuard = null;
                    this.guardDwell = 0;
                }
            } else {
                this.crossingGuard = null;
                this.guardDwell = 0;
            }
        }

        const found = this.portals.findEntry(pt, this.crossingGuard);
        if (!found) return;
        const { entry, exit } = found;

        // Teleport, keeping the centre-to-corner offset.
        this.player.pos = exit.center.sub(this.player.chainOffset);
        const playerPt = this.player.chainPoint();

        const last = this.crossingExits[this.crossingExits.length - 1];
        if (last && last.equals(entry)) {
            for (const chain of this.chains) chain.merge(playerPt);
            this.crossingExits.pop();
        } else {
            for (const chain of this.chains) chain.split(entry.center, exit.center, playerPt);
            this.crossingExits.push(exit);
        }
        this.crossingGuard = exit;
        this.guardDwell = 0;
    }

    /**
     * Constrain the player so each chain's attachment point stays within its
     * remaining free length, resolved continuously so a taut chain can't drag
     * the player through a wall.
     */
    private constrainPlayerToChains(): void {
        for (let iter = 0; iter < CHAIN_CLAMP_ITERS; iter++) {
            let target = this.player.chainPoint();
            for (const chain of this.chains) {
                const { tether, freeLength } = chain.tether();
                const dist = tether.distance(target);
                if (dist > freeLength) {
                    const dir = target.sub(tether).normalize(new Vec2(0, -1));
                    target = tether.add(dir.scale(freeLength));
                }
            }
            const delta = target.sub(this.player.chainPoint());
            if (delta.lengthSq() < 1e-4) break;
            this.player.pos = resolveAabb(
                this.player.pos,
                this.player.shape,
                delta,
                this.playerColliders,
            );
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    draw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
        ctx.fillStyle = '#07090f';
        ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = false;

        const camera = new Camera2D();
        camera.target = this.player.pos.add(new Vec2(16, 16));
        camera.offset = new Vec2(width / 2, height / 2);
        camera.zoom = this.zoom;
        camera.apply(ctx, height);

        // The visible world rect (plus a margin) — everything outside is
        // culled, which matters with 1000+ sprite instances in the level.
        const scale = camera.effectiveZoom(height);
        this.frameScale = scale;
        this.frameTx = camera.offset.x - camera.target.x * scale;
        this.frameTy = camera.offset.y - camera.target.y * scale;
        const view = new Rect(
            camera.target.x - width / 2 / scale,
            camera.target.y - height / 2 / scale,
            width / scale,
            height / scale,
        ).grow(64);

        // Floor decals first (chains, anchor, portals): the rope lies on the
        // ground, so tall Y-sorted sprites and the player draw *over* it.
        // Drawing chains above everything (as the original did) made a rope
        // passing "behind" a statue look like it clipped through it.
        this.drawBackgroundSprites(ctx, view);
        for (const chain of this.chains) chain.draw(ctx, 1);
        ctx.fillStyle = '#ffcb00';
        ctx.beginPath();
        ctx.arc(CHAIN_ANCHOR.x, CHAIN_ANCHOR.y, 6, 0, Math.PI * 2);
        ctx.fill();
        this.portals.draw(ctx);

        // Soft contact shadows under the dynamic entities, above the floor
        // decals but below the entities themselves.
        this.drawShadows(ctx);

        this.drawYSorted(ctx, view);
        this.particles.draw(ctx);
        if (this.debugCollisions) this.drawDebug(ctx);

        ctx.restore();
    }

    /**
     * Contact shadows for the duck and the squeezable balls, drawn as
     * **pixel-art ellipses**: stacked 1px rows on the world grid (the same
     * resolution as the sprites), one flat shade, no anti-aliasing.
     */
    private drawShadows(ctx: CanvasRenderingContext2D): void {
        ctx.save();
        ctx.fillStyle = 'rgb(20 26 8 / 30%)';
        const feet = this.player.pos.add(new Vec2(this.player.shape.x / 2, this.player.shape.y));
        pixelEllipse(ctx, feet.x, feet.y + 1, 10, 3);
        for (const { center, radius } of this.squeezables.eachAlive()) {
            pixelEllipse(ctx, center.x, center.y + radius * 0.85, radius * 0.8, radius * 0.28);
        }
        ctx.restore();
    }

    private spriteVisible(i: number, view: Rect): boolean {
        const inst = (this.level.sprite_instances ?? [])[i];
        const tex = this.textures.get(inst.path);
        if (!tex) return false;
        return (
            inst.x < view.right &&
            inst.x + tex.naturalWidth * inst.scale > view.x &&
            inst.y < view.bottom &&
            inst.y + tex.naturalHeight * inst.scale > view.y
        );
    }

    /** The flat ground layer: background-flagged sprites, under everything. */
    private drawBackgroundSprites(ctx: CanvasRenderingContext2D, view: Rect): void {
        const instances = this.level.sprite_instances ?? [];
        for (let i = 0; i < instances.length; i++) {
            if (instances[i].background && this.spriteVisible(i, view)) this.drawSprite(ctx, i);
        }
    }

    /**
     * Entities with depth ordering: a Y-sort (by bottom edge, "feet") of the
     * player, the squeezable balls, and every sprite at least as large as the
     * player; smaller props draw last on top.
     */
    private drawYSorted(ctx: CanvasRenderingContext2D, view: Rect): void {
        const instances = this.level.sprite_instances ?? [];
        const playerMin = this.player.spriteMinDim();

        const order: { y: number; draw: () => void }[] = [];
        const small: number[] = [];
        for (let i = 0; i < instances.length; i++) {
            const inst = instances[i];
            if (inst.background || !this.spriteVisible(i, view)) continue;
            const tex = this.textures.get(inst.path);
            const w = tex ? tex.naturalWidth * inst.scale : 0;
            const h = tex ? tex.naturalHeight * inst.scale : 0;
            if (Math.min(w, h) < playerMin) small.push(i);
            else order.push({ y: inst.y + h, draw: () => this.drawSprite(ctx, i) });
        }
        order.push({
            y: this.player.pos.y + this.player.shape.y,
            draw: () => this.player.draw(ctx),
        });
        for (const { index, center, radius } of this.squeezables.eachAlive()) {
            order.push({
                y: center.y + radius,
                draw: () => this.squeezables.drawItem(ctx, index),
            });
        }
        order.sort((a, b) => a.y - b.y);

        for (const entry of order) entry.draw();
        for (const i of small) this.drawSprite(ctx, i);
    }

    /**
     * Draw a sprite with its destination rect **snapped to whole device
     * pixels**. Adjacent tiles authored flush share the same world edge, so
     * after rounding they share the same device edge — this is what removes
     * the black seam lines that fractional scaling otherwise leaves between
     * tiles (each tile's edges rounding differently exposes the background).
     */
    private drawSprite(ctx: CanvasRenderingContext2D, i: number): void {
        const inst = (this.level.sprite_instances ?? [])[i];
        const tex = this.textures.get(inst.path);
        if (!tex) return;
        const s = this.frameScale;
        const x0 = Math.round(inst.x * s + this.frameTx);
        const y0 = Math.round(inst.y * s + this.frameTy);
        const x1 = Math.round((inst.x + tex.naturalWidth * inst.scale) * s + this.frameTx);
        const y1 = Math.round((inst.y + tex.naturalHeight * inst.scale) * s + this.frameTy);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(tex, x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
    }

    /** Debug overlay: collision shapes, movable boxes, player collider. */
    private drawDebug(ctx: CanvasRenderingContext2D): void {
        for (const shape of this.level.collision_shapes ?? []) {
            if (isMovableTag(getTag(this.level, shapeId(shape)))) continue;
            ctx.fillStyle = 'rgba(200 60 60 / 40%)';
            if (isRect(shape)) {
                const r = shape.Rect;
                ctx.fillRect(r.x, r.y, r.width, r.height);
            } else {
                const c = shape.Circle;
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        for (const b of this.boxes) {
            if (this.player.abilities.pull) {
                ctx.fillStyle = 'rgba(102 191 255 / 12%)';
                ctx.fillRect(
                    b.rect.x - PULL_REACH,
                    b.rect.y - PULL_REACH,
                    b.rect.width + PULL_REACH * 2,
                    b.rect.height + PULL_REACH * 2,
                );
            }
            ctx.fillStyle = 'rgba(255 161 0 / 40%)';
            ctx.fillRect(b.rect.x, b.rect.y, b.rect.width, b.rect.height);
        }
        const r = this.player.collider();
        ctx.fillStyle = 'rgba(0 228 48 / 40%)';
        ctx.fillRect(r.x, r.y, r.width, r.height);
    }
}

function playerStartOf(level: LevelData): Vec2 {
    const p = level.player_start;
    return p ? new Vec2(p.x, p.y) : PLAYER_START.clone();
}

/**
 * Fill an ellipse as stacked 1px rows snapped to the world pixel grid — a
 * blocky pixel-art ellipse matching the sprites' resolution.
 */
function pixelEllipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number): void {
    const rows = Math.max(1, Math.round(ry));
    const y0 = Math.round(cy - rows / 2);
    for (let row = 0; row < rows; row++) {
        // Row centre in [-1, 1] of the vertical radius.
        const t = rows === 1 ? 0 : (row + 0.5) / rows * 2 - 1;
        const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - t * t)));
        if (half <= 0) continue;
        ctx.fillRect(Math.round(cx) - half, y0 + row, half * 2, 1);
    }
}
