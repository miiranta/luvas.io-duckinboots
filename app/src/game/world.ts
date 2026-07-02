import { Camera2D } from '../engine/camera';
import { Input } from '../engine/input';
import { Circle, Rect, Vec2, clamp } from '../engine/math';
import {
    LevelAbilities,
    LevelCollider,
    LevelDocument,
    LevelSprite,
    RuleAction,
    RuleEvent,
    Shape,
    TAG_COLORS,
    playerStart,
    shapeBounds,
} from '../engine/level';
import { GameTexture } from '../engine/textures';
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
    ItemSpriteLink,
    MovableBox,
    barCollidersFrom,
    itemSpriteLinksFrom,
    movableBoxesFrom,
    spawnItemSqueezables,
    staticCollidersFrom,
} from './level-setup';
import { Player } from './player';
import { Chain } from './chain';
import { Particles } from './particles';
import { Portals } from './portals';
import { Squeezables } from './squeezables';

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
    level: LevelDocument;
    /** Decoded level textures keyed by asset id. */
    textures: Map<string, GameTexture>;
}

/** Physics link spacing of the chain (also its visual granularity). */
const CHAIN_LINK_SIZE = 4;
/** The chain's rope colour (theme gold). */
const CHAIN_COLOR = '#e8bd4a';

/** Handle to a thing the player can push/pull. */
type MovableRef = { kind: 'box'; index: number } | { kind: 'squeezable'; index: number };

/** One live chain plus its authored identity (rules break chains by id). */
interface ChainEntry {
    id: string;
    anchor: Vec2;
    chain: Chain;
}

/** A plate or button zone with its live activation state. */
interface TriggerZone {
    id: string;
    group?: string;
    shape: Shape;
    active: boolean;
}

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
    private readonly level: LevelDocument;
    private readonly textures: Map<string, GameTexture>;
    /** Pristine copies for reset: rules mutate colliders/abilities live. */
    private readonly pristine: {
        colliders: LevelCollider[];
        sprites: LevelSprite[];
        abilities: LevelAbilities;
    };

    private staticColliders: Collider[] = [];
    private barColliders: Collider[] = [];
    /** Statics + bars: the solid set (rebuilt when rules alter geometry). */
    private immovableColliders: Collider[] = [];
    private staticGrid: ColliderGrid = new ColliderGrid([]);
    private boxes: MovableBox[] = [];
    private readonly playerStartPos: Vec2;
    /** Sprites riding item colliders, index-aligned with the squeezables. */
    private readonly itemSprites: ItemSpriteLink[];
    /** sprite index → squeezable index, for hiding art of crushed items. */
    private readonly spriteItem = new Map<number, number>();

    private chainEntries: ChainEntry[] = [];
    private plates: TriggerZone[] = [];
    private buttons: TriggerZone[] = [];
    private firedRules = new Set<string>();
    private portalAllowance = 0;
    /** Seconds spent in the current run (shown in the HUD, saved on win). */
    levelTime = 0;
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
    /** Where the wheel wants the zoom to be; `zoom` eases toward it. */
    private targetZoom = 3;
    debugCollisions = false;
    /** World clock (seconds), drives animated textures and water. */
    private time = 0;

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
        this.pristine = {
            colliders: structuredClone(this.level.colliders),
            sprites: structuredClone(this.level.sprites),
            abilities: { ...this.level.abilities },
        };

        this.rebuildColliderWorld();
        this.playerStartPos = playerStart(this.level);

        this.player = new Player(assets.ducky);
        this.player.pos = this.playerStartPos.clone();
        this.prevPlayerPos = this.player.pos.clone();
        this.applyAbilities(this.level.abilities);

        spawnItemSqueezables(this.level, this.squeezables);
        this.itemSprites = itemSpriteLinksFrom(this.level);
        this.itemSprites.forEach((link, item) => {
            for (const { index } of link.sprites) this.spriteItem.set(index, item);
        });
        this.squeezables.onSqueeze((ev) => {
            this.squeezeCount++;
            this.particles.burst(ev.pos, ['#f5008c', '#ff8fc8', '#ffd6ea'], 26, 150, 0.8);
        });

        this.chainEntries = this.newChains();
        this.portals = new Portals(assets.portalPurple, assets.portalGreen);
    }

    /** The live chains (used wherever the identity doesn't matter). */
    private get chains(): Chain[] {
        return this.chainEntries.map((e) => e.chain);
    }

    /** Build one chain per level chain definition, tethered to the player. */
    private newChains(): ChainEntry[] {
        const start = this.player.pos.add(this.player.chainOffset);
        return this.level.chains.map((def) => {
            const anchor = new Vec2(def.anchor.x, def.anchor.y);
            return {
                id: def.id,
                anchor,
                chain: new Chain(anchor, start, def.length, CHAIN_LINK_SIZE, CHAIN_COLOR),
            };
        });
    }

    private applyAbilities(abilities: LevelAbilities): void {
        this.player.abilities.push = abilities.push;
        this.player.abilities.pull = abilities.pull;
        this.portalAllowance = abilities.portalPairs;
    }

    /**
     * (Re)derive every collider-based structure from `level.colliders`. Runs
     * at construction and again whenever a rule mutates the geometry
     * (`setMovable` / `removeCollider`); box positions survive because
     * `syncBoxShapesToLevel` writes them back into the shapes first.
     */
    private rebuildColliderWorld(): void {
        this.staticColliders = staticCollidersFrom(this.level);
        this.staticGrid = new ColliderGrid(this.staticColliders);
        this.barColliders = barCollidersFrom(this.level);
        this.immovableColliders = [...this.staticColliders, ...this.barColliders];
        this.boxes = movableBoxesFrom(this.level, snapToGrid);
        const zones = (tag: string): TriggerZone[] =>
            this.level.colliders
                .filter((c) => c.tag === tag)
                .map((c) => ({ id: c.id, group: c.group, shape: c.shape, active: false }));
        const prevButtons = new Map(this.buttons.map((b) => [b.id, b.active]));
        this.plates = zones('plate');
        this.buttons = zones('button');
        // Buttons latch: a rebuild must not un-press them mid-run.
        for (const b of this.buttons) b.active = prevButtons.get(b.id) ?? false;
    }

    /** Write the boxes' live positions back into their collider shapes. */
    private syncBoxShapesToLevel(): void {
        for (const box of this.boxes) {
            const collider = this.level.colliders.find((c) => c.id === box.id);
            if (collider && collider.shape.kind === 'rect') {
                collider.shape.x = box.rect.x;
                collider.shape.y = box.rect.y;
            }
        }
    }

    /** True when every squeezable has been crushed. */
    get allSqueezed(): boolean {
        return this.squeezables.totalCount > 0 && this.squeezables.aliveCount === 0;
    }

    /** True while the player stands in the goal zone. */
    get goalReached(): boolean {
        const g = this.level.goal;
        if (!g) return false;
        return this.player.collider().intersects(new Rect(g.x, g.y, g.w, g.h));
    }

    /** The win condition: reach the goal if one exists, else squeeze all. */
    get hasWon(): boolean {
        return this.level.goal ? this.goalReached : this.allSqueezed;
    }

    /** Reset world state for a fresh run. Reuses loaded assets and level. */
    reset(): void {
        // Rules mutate colliders/abilities live; restore the pristine level.
        this.level.colliders = structuredClone(this.pristine.colliders);
        this.level.sprites = structuredClone(this.pristine.sprites);
        this.level.abilities = { ...this.pristine.abilities };
        this.firedRules.clear();
        this.buttons = [];
        this.rebuildColliderWorld();
        this.applyAbilities(this.level.abilities);

        this.player.pos = this.playerStartPos.clone();
        this.player.velocity = new Vec2();
        this.chainEntries = this.newChains();
        this.portals.startClosingAll();
        this.portalsRestarting = true;
        this.crossingExits = [];
        this.crossingGuard = null;
        this.guardDwell = 0;
        this.zoom = 3;
        this.targetZoom = 3;
        this.levelTime = 0;
        this.squeezables.reviveAll();
        this.squeezeCount = 0;
        this.prevPlayerPos = this.player.pos.clone();
        this.playerStillFor = 0;
        this.syncItemSprites();
    }

    /** Advance the world one fixed step. Pausing simply stops calling this. */
    update(input: Input, dt: number): void {
        if (input.wasPressed('F3')) this.debugCollisions = !this.debugCollisions;
        this.time += dt;
        this.levelTime += dt;

        // Smooth zoom: the wheel moves a *target* (multiplicatively, so a
        // notch feels the same at every zoom level) and the camera eases
        // toward it exponentially, frame-rate independent.
        this.targetZoom = clamp(this.targetZoom * Math.pow(1.12, input.wheelMove()), 0.5, 6);
        this.zoom += (this.targetZoom - this.zoom) * (1 - Math.exp(-12 * dt));

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
        // Portal placement, limited to the level's (rule-adjustable) pair
        // allowance; completing a pending pair is always allowed.
        if (!this.portalsRestarting && input.wasPressed('Space')) {
            if (this.portals.hasPending || this.portals.pairCount < this.portalAllowance) {
                this.portals.place(this.player.chainPoint());
                this.particles.burst(this.player.chainPoint(), ['#c39bff', '#fff'], 14, 90, 0.5);
            }
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
        this.syncItemSprites();

        // Triggers + causality: refresh plate/button states, then fire any
        // rule whose condition just became true.
        this.updateTriggers();
        this.evaluateRules();
    }

    // ── Triggers + rules ─────────────────────────────────────────────────────

    private static pointInShape(p: Vec2, shape: Shape): boolean {
        if (shape.kind === 'rect') return shapeBounds(shape).containsPoint(p);
        return p.distanceSq(new Vec2(shape.x, shape.y)) <= shape.r * shape.r;
    }

    /**
     * Plates are *held*: active only while some chain joint lies over them.
     * Buttons *latch*: once the player steps on one it stays pressed.
     */
    private updateTriggers(): void {
        for (const plate of this.plates) {
            const wasActive = plate.active;
            plate.active = this.chainEntries.some((e) =>
                e.chain
                    .spanPoints()
                    .some((pts) => pts.some((p) => World.pointInShape(p, plate.shape))),
            );
            if (plate.active && !wasActive) {
                const b = shapeBounds(plate.shape);
                this.particles.burst(b.center(), ['#2fd6ad', '#b8fff0'], 10, 70, 0.4);
            }
        }
        const playerRect = this.player.collider();
        for (const button of this.buttons) {
            if (button.active) continue;
            if (playerRect.intersects(shapeBounds(button.shape))) {
                button.active = true;
                this.particles.burst(shapeBounds(button.shape).center(), ['#ff5555', '#ffd0d0'], 12, 80, 0.5);
            }
        }
    }

    /** Do all zones matching `target` (an id or group name) satisfy it? */
    private static zonesSatisfied(zones: TriggerZone[], target: string): boolean {
        const matched = zones.filter((z) => z.id === target || z.group === target);
        return matched.length > 0 && matched.every((z) => z.active);
    }

    private ruleConditionMet(when: RuleEvent): boolean {
        switch (when.type) {
            case 'buttonPressed':
                return World.zonesSatisfied(this.buttons, when.target);
            case 'plateActive':
                return World.zonesSatisfied(this.plates, when.target);
            case 'squeezed':
                return this.squeezables.allSqueezedFor(when.target);
        }
    }

    /** Fire (once each) every rule whose condition currently holds. */
    private evaluateRules(): void {
        for (const rule of this.level.rules) {
            if (this.firedRules.has(rule.id)) continue;
            if (!this.ruleConditionMet(rule.when)) continue;
            this.firedRules.add(rule.id);
            for (const action of rule.actions) this.applyRuleAction(action);
        }
    }

    private applyRuleAction(action: RuleAction): void {
        switch (action.type) {
            case 'breakChain': {
                const idx = this.chainEntries.findIndex((e) => e.id === action.chainId);
                if (idx < 0) break;
                const entry = this.chainEntries[idx];
                // The rope shatters: sparks along its final shape.
                for (const pts of entry.chain.spanPoints()) {
                    for (let i = 0; i < pts.length; i += 12) {
                        this.particles.burst(pts[i], ['#e8bd4a', '#fff2c8'], 4, 60, 0.6);
                    }
                }
                this.chainEntries.splice(idx, 1);
                break;
            }
            case 'setAbility':
                this.player.abilities[action.ability] = action.value;
                break;
            case 'addPortalPairs':
                this.portalAllowance = Math.max(0, this.portalAllowance + action.amount);
                break;
            case 'setMovable': {
                const collider = this.level.colliders.find((c) => c.id === action.colliderId);
                if (!collider) break;
                this.syncBoxShapesToLevel();
                collider.tag = action.movable ? 'movable' : 'wall';
                this.rebuildColliderWorld();
                break;
            }
            case 'removeCollider': {
                const idx = this.level.colliders.findIndex((c) => c.id === action.colliderId);
                if (idx < 0) break;
                const b = shapeBounds(this.level.colliders[idx].shape);
                this.particles.burst(b.center(), ['#9aa4bd', '#fff'], 20, 120, 0.7);
                this.syncBoxShapesToLevel();
                this.level.colliders.splice(idx, 1);
                this.rebuildColliderWorld();
                break;
            }
        }
    }

    /** Keep sprites riding item colliders glued to their squeezable. */
    private syncItemSprites(): void {
        for (let item = 0; item < this.itemSprites.length; item++) {
            const link = this.itemSprites[item];
            if (link.sprites.length === 0 || !this.squeezables.isAlive(item)) continue;
            const center = this.squeezables.centerOf(item);
            for (const { index, offset } of link.sprites) {
                this.level.sprites[index].x = center.x + offset.x;
                this.level.sprites[index].y = center.y + offset.y;
            }
        }
    }

    /** True for sprites whose linked squeezable has been crushed. */
    private spriteHidden(i: number): boolean {
        const item = this.spriteItem.get(i);
        return item !== undefined && !this.squeezables.isAlive(item);
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
        for (const { index, offset } of box.sprites) {
            this.level.sprites[index].x = box.rect.x + offset.x;
            this.level.sprites[index].y = box.rect.y + offset.y;
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

        for (const { anchor, chain } of this.chainEntries) {
            chain.setStart(anchor);
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

        // A pair the chain is already threaded through is *locked*: the only
        // allowed crossing is going back the way we came (the merge below).
        // Anything else would double-thread the pair, so the portal simply
        // refuses — the player walks over it like normal ground.
        const lastExit = this.crossingExits[this.crossingExits.length - 1];
        const isMergeBack = !!lastExit && lastExit.equals(entry);
        if (!isMergeBack && this.chainEntries.length > 0) {
            const threaded = this.crossingExits.some(
                (c) => this.portals.pairIndexOf(c) === found.pairIndex,
            );
            if (threaded) return;
        }

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

        // Floor first: flat level geometry (walls/water/bars render as tinted
        // slabs — levels need no artwork to be playable), then background
        // sprites, then the floor decals (chains, anchor, portals): the rope
        // lies on the ground, so Y-sorted entities draw *over* it.
        this.drawGeometry(ctx, view);
        this.drawBackgroundSprites(ctx, view);
        this.drawGoal(ctx);

        // Longest rope first so the smallest chain draws last, on top —
        // it's the tightest constraint, so it should be the most visible.
        const byLength = [...this.chainEntries].sort(
            (a, b) => b.chain.maxLength() - a.chain.maxLength(),
        );
        for (const { chain } of byLength) chain.draw(ctx, 1);
        for (const { anchor } of this.chainEntries) {
            ctx.fillStyle = '#ffcb00';
            ctx.beginPath();
            ctx.arc(anchor.x, anchor.y, 6, 0, Math.PI * 2);
            ctx.fill();
        }
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

    /**
     * Flat rendering of the level geometry, so a level is fully playable
     * with zero imported artwork. Water shimmers on the world clock; walls
     * get a subtle top-edge highlight; movable boxes render at their *live*
     * physics rects with a crate look.
     */
    private drawGeometry(ctx: CanvasRenderingContext2D, view: Rect): void {
        for (const collider of this.level.colliders) {
            const { tag, shape } = collider;
            if (tag === 'movable' || tag === 'item') continue; // live entities
            if (tag === 'plate' || tag === 'button') {
                this.drawTrigger(ctx, collider);
                continue;
            }
            const bounds =
                shape.kind === 'rect'
                    ? new Rect(shape.x, shape.y, shape.w, shape.h)
                    : new Rect(shape.x - shape.r, shape.y - shape.r, shape.r * 2, shape.r * 2);
            if (!bounds.intersects(view)) continue;

            const base = TAG_COLORS[tag];
            if (shape.kind === 'circle') {
                ctx.fillStyle = base;
                ctx.beginPath();
                ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
                ctx.fill();
                continue;
            }

            if (tag === 'water') {
                // Two-tone shimmer: base fill plus drifting lighter bands.
                ctx.fillStyle = '#1d5f9e';
                ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
                ctx.save();
                ctx.beginPath();
                ctx.rect(shape.x, shape.y, shape.w, shape.h);
                ctx.clip();
                ctx.fillStyle = 'rgb(120 190 255 / 25%)';
                const phase = (this.time * 14) % 48;
                for (let y = shape.y - 48 + phase; y < shape.y + shape.h; y += 48) {
                    ctx.fillRect(shape.x, y, shape.w, 6);
                }
                ctx.restore();
            } else if (tag === 'bar') {
                // Bars read as railings: posts under a solid top rail.
                ctx.fillStyle = 'rgb(255 138 42 / 30%)';
                ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
                ctx.fillStyle = base;
                if (shape.w >= shape.h) {
                    ctx.fillRect(shape.x, shape.y, shape.w, 4);
                    for (let x = shape.x + 4; x < shape.x + shape.w - 4; x += 16) {
                        ctx.fillRect(x, shape.y, 4, shape.h);
                    }
                } else {
                    ctx.fillRect(shape.x, shape.y, 4, shape.h);
                    for (let y = shape.y + 4; y < shape.y + shape.h - 4; y += 16) {
                        ctx.fillRect(shape.x, y, shape.w, 4);
                    }
                }
            } else {
                // Walls: dark slab, lighter lid, faint inner border.
                ctx.fillStyle = '#2a3040';
                ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
                ctx.fillStyle = base;
                ctx.fillRect(shape.x, shape.y, shape.w, Math.min(6, shape.h));
                ctx.strokeStyle = 'rgb(255 255 255 / 6%)';
                ctx.lineWidth = 2;
                ctx.strokeRect(shape.x + 1, shape.y + 1, shape.w - 2, shape.h - 2);
            }
        }
    }

    /** Crate look for a movable box without linked artwork. */
    private drawBoxFlat(ctx: CanvasRenderingContext2D, r: Rect): void {
        ctx.fillStyle = '#8a6a2f';
        ctx.fillRect(r.x, r.y, r.width, r.height);
        ctx.fillStyle = '#e8bd4a';
        ctx.fillRect(r.x + 3, r.y + 3, r.width - 6, r.height - 6);
        ctx.strokeStyle = '#8a6a2f';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.right, r.bottom);
        ctx.moveTo(r.right, r.y);
        ctx.lineTo(r.x, r.bottom);
        ctx.stroke();
    }

    /** Pressure plates and buttons: floor decals with a live "on" state. */
    private drawTrigger(ctx: CanvasRenderingContext2D, collider: LevelCollider): void {
        const isPlate = collider.tag === 'plate';
        const zones = isPlate ? this.plates : this.buttons;
        const active = zones.find((z) => z.id === collider.id)?.active ?? false;
        const bounds = shapeBounds(collider.shape);
        const base = TAG_COLORS[collider.tag];

        if (isPlate) {
            // A recessed plate: dark bed, glowing surface when held.
            ctx.fillStyle = '#101722';
            ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
            const inset = 3;
            const pulse = active ? 0.55 + 0.25 * Math.sin(this.time * 6) : 0.18;
            ctx.save();
            ctx.globalAlpha *= pulse;
            ctx.fillStyle = base;
            ctx.fillRect(
                bounds.x + inset,
                bounds.y + inset,
                bounds.width - inset * 2,
                bounds.height - inset * 2,
            );
            ctx.restore();
            ctx.strokeStyle = base;
            ctx.lineWidth = 2;
            ctx.strokeRect(bounds.x + 1, bounds.y + 1, bounds.width - 2, bounds.height - 2);
        } else {
            // A round button cap; pressed caps sink and darken.
            const c = bounds.center();
            const r = Math.min(bounds.width, bounds.height) / 2;
            ctx.fillStyle = '#3a1620';
            ctx.beginPath();
            ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = active ? '#7c2f2f' : base;
            ctx.beginPath();
            ctx.arc(c.x, c.y - (active ? 0 : 2), r * 0.72, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    /** The goal zone: a pulsing golden pad the duck must reach. */
    private drawGoal(ctx: CanvasRenderingContext2D): void {
        const g = this.level.goal;
        if (!g) return;
        const cx = g.x + g.w / 2;
        const cy = g.y + g.h / 2;
        ctx.save();
        ctx.fillStyle = 'rgb(232 189 74 / 14%)';
        ctx.fillRect(g.x, g.y, g.w, g.h);
        ctx.strokeStyle = '#e8bd4a';
        ctx.lineWidth = 2;
        ctx.strokeRect(g.x, g.y, g.w, g.h);
        // Expanding ring pulse.
        const t = (this.time % 1.4) / 1.4;
        const r = (Math.min(g.w, g.h) / 2) * (0.3 + 0.6 * t);
        ctx.globalAlpha *= 1 - t;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    private spriteVisible(i: number, view: Rect): boolean {
        const sprite = this.level.sprites[i];
        const tex = this.textures.get(sprite.assetId);
        if (!tex) return false;
        return (
            sprite.x < view.right &&
            sprite.x + tex.width * sprite.scale > view.x &&
            sprite.y < view.bottom &&
            sprite.y + tex.height * sprite.scale > view.y
        );
    }

    /** The flat ground layer: background-layer sprites, under everything. */
    private drawBackgroundSprites(ctx: CanvasRenderingContext2D, view: Rect): void {
        const sprites = this.level.sprites;
        for (let i = 0; i < sprites.length; i++) {
            if (
                sprites[i].layer === 'background' &&
                !this.spriteHidden(i) &&
                this.spriteVisible(i, view)
            ) {
                this.drawSprite(ctx, i);
            }
        }
    }

    /**
     * Entities with depth ordering: a Y-sort (by bottom edge, "feet") of the
     * player, the squeezable balls, movable boxes, and every entity-layer
     * sprite at least as large as the player; smaller props draw last on top.
     */
    private drawYSorted(ctx: CanvasRenderingContext2D, view: Rect): void {
        const sprites = this.level.sprites;
        const playerMin = this.player.spriteMinDim();

        const order: { y: number; draw: () => void }[] = [];
        const small: number[] = [];
        for (let i = 0; i < sprites.length; i++) {
            const sprite = sprites[i];
            if (sprite.layer === 'background' || this.spriteHidden(i)) continue;
            if (!this.spriteVisible(i, view)) continue;
            const tex = this.textures.get(sprite.assetId);
            const w = tex ? tex.width * sprite.scale : 0;
            const h = tex ? tex.height * sprite.scale : 0;
            if (Math.min(w, h) < playerMin) small.push(i);
            else order.push({ y: sprite.y + h, draw: () => this.drawSprite(ctx, i) });
        }
        for (const b of this.boxes) {
            // Boxes with linked artwork are drawn by their sprites instead.
            if (b.sprites.length === 0 && b.rect.intersects(view)) {
                order.push({ y: b.rect.bottom, draw: () => this.drawBoxFlat(ctx, b.rect) });
            }
        }
        order.push({
            y: this.player.pos.y + this.player.shape.y,
            draw: () => this.player.draw(ctx),
        });
        for (const { index, center, radius } of this.squeezables.eachAlive()) {
            // Items with linked artwork are drawn by their sprites instead.
            if (this.itemSprites[index]?.sprites.length) continue;
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
     * Draw a sprite (its current animation frame) with its destination rect
     * **snapped to whole device pixels**. Adjacent tiles authored flush share
     * the same world edge, so after rounding they share the same device edge —
     * this removes the seam lines fractional scaling otherwise leaves.
     */
    private drawSprite(ctx: CanvasRenderingContext2D, i: number): void {
        const sprite = this.level.sprites[i];
        const tex = this.textures.get(sprite.assetId);
        if (!tex) return;
        const s = this.frameScale;
        const x0 = Math.round(sprite.x * s + this.frameTx);
        const y0 = Math.round(sprite.y * s + this.frameTy);
        const x1 = Math.round((sprite.x + tex.width * sprite.scale) * s + this.frameTx);
        const y1 = Math.round((sprite.y + tex.height * sprite.scale) * s + this.frameTy);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(tex.frameAt(this.time * 1000), x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
    }

    /** Debug overlay: collision shapes, movable boxes, player collider. */
    private drawDebug(ctx: CanvasRenderingContext2D): void {
        for (const { tag, shape } of this.level.colliders) {
            if (tag === 'movable' || tag === 'plate' || tag === 'button') continue;
            ctx.fillStyle = 'rgba(200 60 60 / 40%)';
            if (shape.kind === 'rect') {
                ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
            } else {
                ctx.beginPath();
                ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
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
