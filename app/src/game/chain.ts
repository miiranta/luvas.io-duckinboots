import { Rect, Vec2 } from '../engine/math';
import {
    Collider,
    ColliderGrid,
    colliderBounds,
    movePointSwept,
    pushPointOutOf,
} from './collision';

interface Joint {
    pos: Vec2;
    /** Previous position, used for Verlet inertia on slack joints. */
    oldPos: Vec2;
    /**
     * Recent-motion measure in [0, 1], bumped when the joint moves or is
     * under tension and decaying otherwise. Drives the link animation: the
     * crawling pattern only plays where the rope is actually alive.
     */
    heat: number;
}

function makeJoint(pos: Vec2): Joint {
    return { pos, oldPos: pos.clone(), heat: 0 };
}

/**
 * One contiguous stretch of rope. The last span is *active* (simulated,
 * following the player); every earlier span is *frozen*: pinned between two
 * fixed anchors (the world anchor or a portal exit on one side, a portal
 * entrance on the other) and only ever tightened, never simulated.
 */
interface Span {
    joints: Joint[];
    /** Straight-line length between the pinned ends (rope consumed fully taut). */
    fMin: number;
}

/** Velocity retention per second for slack (un-tensioned) joints. */
const DAMPING = 0.025;
/** Bend resistance as the rope stretches (0 floppy … 1 cable-straight). */
const STRAIGHTNESS = 0.7;
/** Distance-constraint iterations per frame. */
const CONSTRAINT_ITERATIONS = 12;
/** Fraction of post-constraint velocity kept on tensioned joints. */
const INERTIA_KEEP = 0.15;
/** Stop iterating once corrections are sub-pixel. */
const CONSTRAINT_EPS_SQ = 0.0001;
/** Midpoint-relaxation strength used to tighten frozen spans. */
const TIGHTEN_STRENGTH = 0.35;
/**
 * Slack headroom (in segments) the active span keeps ahead of the player
 * after a portal crossing. Rope starts paying through the portal as soon as
 * the active span comes within this margin of taut, so walking away from an
 * exit portal feels like the rope slides freely — with a small margin the
 * rope only fed once fully stretched, which read as heavy portal friction.
 */
const PULLTHROUGH_HEADROOM_SEGMENTS = 16;
/**
 * The rope's physical half-thickness. Every point sweep and push-out inflates
 * obstacles by this radius **with rounded corners**, so the rope keeps a
 * standoff on flat faces and — crucially — its contact normal rotates
 * continuously around corners: multi-wall contacts at any angle slide like a
 * rope over a pulley instead of snagging where two faces meet.
 */
const ROPE_RADIUS = 1.5;
/** Heat threshold above which a rope cell plays the crawl animation. */
const HEAT_ANIMATE = 0.06;

/**
 * A rope tethering the player to a fixed anchor, able to thread through
 * portals.
 *
 * The rope is a list of [`Span`]s sharing one fixed length `budget`. Crossing
 * a portal `split`s the rope: the active span freezes in place and a new
 * collapsed active span emerges from the exit portal. Crossing back `merge`s:
 * the frozen span is reabsorbed, continuing from its current shape. As the
 * player pulls rope through, frozen spans tighten toward taut, giving their
 * slack to the active span.
 *
 * # Physics model
 *
 * - **Swept joints** — every joint movement (simulation *and* frozen-span
 *   tightening) goes through a swept point query against the same obstacle
 *   set, so no part of the rope can ever pass through geometry. This is the
 *   single invariant the no-clip guarantee rests on.
 * - **Bucket coverage** — per-joint obstacle buckets are re-gathered whenever
 *   a move would leave the neighbourhood they were built for, so a hard yank
 *   cascading down the rope can never outrun the broad phase.
 * - **Propagation from the player end** — constraints run end→anchor first,
 *   so when slack only the links near the player move.
 * - **Pulley tightening** — frozen spans shorten by midpoint relaxation with
 *   swept moves: the rope wraps corners (and squeezables) like a rope over a
 *   pulley, tightening exactly as far as the obstacles allow.
 */
export class Chain {
    /** `[frozen…, active]`; always at least one span. */
    private spans: Span[];
    /** Total rope length, conserved across all spans. */
    private readonly budget: number;
    readonly linkSize: number;
    readonly segmentLength: number;
    private readonly color: string;

    // Simulation scratch for the active span (index-aligned with its joints).
    private wasConstrained: boolean[] = [];
    private obstacleConstrained: boolean[] = [];
    private jointObstacles: Collider[][] = [];
    private bucketOrigin: (Vec2 | null)[] = [];
    private bucketMargin = 0;
    /** Collision context of the current update, for bucket refreshes. */
    private frameGrid: ColliderGrid | null = null;
    private frameDynamics: readonly Collider[] = [];
    /** Every obstacle near the active span this frame (one grid query). */
    private chainObstacles: Collider[] = [];
    /** Animated dash offset that makes the link pattern crawl along the rope. */
    private dashPhase = 0;
    /** Rope freed by pull-through but not yet converted into an active joint. */
    private pendingRope = 0;

    constructor(anchor: Vec2, end: Vec2, totalLength: number, linkSize: number, color: string) {
        const numSegments = Math.max(1, Math.ceil(totalLength / linkSize));
        this.segmentLength = totalLength / numSegments;
        this.budget = totalLength;
        this.linkSize = linkSize;
        this.color = color;
        this.spans = [this.straightSpan(anchor, end, numSegments + 1)];
        this.resizeScratch();
    }

    // ── Span helpers ─────────────────────────────────────────────────────────

    private straightSpan(a: Vec2, b: Vec2, jointCount: number): Span {
        const joints: Joint[] = [];
        for (let i = 0; i < jointCount; i++) {
            const pos = a.lerp(b, i / (jointCount - 1));
            joints.push(makeJoint(pos));
        }
        return { joints, fMin: 0 };
    }

    private active(): Span {
        return this.spans[this.spans.length - 1];
    }

    /**
     * Joint count for a span holding `rope` length of rope.
     *
     * The active span is created with the rope *actually* left over at split
     * time and **grows** via [`feedActiveSpan`] as pull-through frees rope —
     * so the rope's total capacity never exceeds the budget, even when
     * geometry stops a frozen span from ever reaching its straight-line
     * minimum. (The original sized the active span off that theoretical
     * minimum up front, which made the chain grow at every portal crossing.)
     */
    private jointCountForRope(rope: number): number {
        const clamped = Math.max(rope, this.segmentLength);
        return Math.max(2, Math.round(clamped / this.segmentLength) + 1);
    }

    /** Hard ceiling on active joints: every frozen span pulled fully taut. */
    private maxActiveJointCount(): number {
        const frozenMin = this.spans.slice(0, -1).reduce((s, span) => s + span.fMin, 0);
        return this.jointCountForRope(this.budget - frozenMin);
    }

    /** Grow the scratch arrays to cover the active span's joints. */
    private resizeScratch(): void {
        const n = this.active().joints.length;
        while (this.wasConstrained.length < n) this.wasConstrained.push(false);
        while (this.obstacleConstrained.length < n) this.obstacleConstrained.push(false);
        while (this.jointObstacles.length < n) this.jointObstacles.push([]);
        while (this.bucketOrigin.length < n) this.bucketOrigin.push(null);
    }

    private static spanLength(span: Span): number {
        let sum = 0;
        for (let i = 1; i < span.joints.length; i++) {
            sum += span.joints[i - 1].pos.distance(span.joints[i].pos);
        }
        return sum;
    }

    // ── Public state ─────────────────────────────────────────────────────────

    /** Total rope budget. */
    maxLength(): number {
        return this.budget;
    }

    /** Pin the world anchor (only meaningful while un-split). */
    setStart(anchor: Vec2): void {
        if (this.spans.length === 1) {
            const first = this.spans[0].joints[0];
            first.pos = anchor.clone();
            first.oldPos = anchor.clone();
        }
    }

    /** Pin the active span's player-side end. */
    setEnd(playerPt: Vec2): void {
        const joints = this.active().joints;
        const last = joints[joints.length - 1];
        last.pos = playerPt.clone();
        last.oldPos = playerPt.clone();
    }

    /** True when every active-span joint's frame displacement is tiny. */
    isStill(threshold: number): boolean {
        const tSq = threshold * threshold;
        return this.active().joints.every((j) => j.pos.distanceSq(j.oldPos) < tSq);
    }

    /** Whole-rope stretch in [0, 1]: total path length across spans / budget. */
    stretch(): number {
        const total = this.spans.reduce((s, span) => s + Chain.spanLength(span), 0);
        return Math.min(1, Math.max(0, total / this.budget));
    }

    /** Each span's joint positions (used by the squeeze detection). */
    spanPoints(): readonly Vec2[][] {
        return this.spans.map((span) => span.joints.map((j) => j.pos));
    }

    /**
     * Tether point and remaining free length for the player constraint: the
     * last obstacle-contact joint of the active span (walking back from the
     * player end) and the rope left beyond it. Call after `update`.
     */
    tether(): { tether: Vec2; freeLength: number } {
        const joints = this.active().joints;
        const n = joints.length;
        let contactIdx = 0;
        for (let i = n - 2; i >= 0; i--) {
            if (this.obstacleConstrained[i]) {
                contactIdx = i;
                break;
            }
        }
        return {
            tether: joints[contactIdx].pos,
            freeLength: (n - 1 - contactIdx) * this.segmentLength,
        };
    }

    // ── Portal crossings ─────────────────────────────────────────────────────

    /**
     * Split at a portal: freeze the active span in place (player end snapped
     * to `inCenter`) and start a fresh collapsed active span at `outCenter`.
     */
    split(inCenter: Vec2, outCenter: Vec2, playerPt: Vec2): void {
        const span = this.active();
        if (span.joints.length < 2) return;
        const last = span.joints[span.joints.length - 1];
        last.pos = inCenter.clone();
        last.oldPos = inCenter.clone();
        span.fMin = span.joints[0].pos.distance(inCenter);

        // Rope actually left over right now: the budget minus what every
        // (now-frozen) span currently holds. `spans` has no active entry at
        // this point, so sum them all explicitly.
        const consumed = this.spans.reduce((s, sp) => s + Chain.spanLength(sp), 0);
        this.pendingRope = 0;
        this.spans.push(
            this.straightSpan(outCenter, playerPt, this.jointCountForRope(this.budget - consumed)),
        );
        this.resizeScratch();
        this.clearContacts();
    }

    /**
     * Undo the most recent split (the player went back the same way): drop
     * the collapsed far-side span and reabsorb the frozen one it came from.
     *
     * The rebuilt active span continues from the frozen span's **current
     * shape** (resampled to the new joint budget) — never from a straight
     * anchor→player line, which could cut through walls (the original game's
     * main chain-through-wall vector).
     */
    merge(playerPt: Vec2): void {
        if (this.spans.length < 2) return;
        this.spans.pop(); // the collapsed active span on the far side
        const reabsorbed = this.spans.pop()!;
        reabsorbed.fMin = 0;

        const shape = reabsorbed.joints.map((j) => j.pos);
        shape.push(playerPt.clone());
        this.pendingRope = 0;
        // Capacity for the merged span: budget minus the remaining frozen
        // spans (all entries left in `spans` right now), never less than the
        // reabsorbed shape itself.
        const consumed = this.spans.reduce((s, sp) => s + Chain.spanLength(sp), 0);
        let shapeLen = 0;
        for (let i = 1; i < shape.length; i++) shapeLen += shape[i - 1].distance(shape[i]);
        const rope = Math.max(this.budget - consumed, shapeLen);
        const points = resamplePolyline(shape, this.jointCountForRope(rope));
        this.spans.push({
            joints: points.map((p) => makeJoint(p)),
            fMin: 0,
        });
        this.resizeScratch();
        this.clearContacts();
    }

    private clearContacts(): void {
        this.wasConstrained.fill(false);
        this.obstacleConstrained.fill(false);
        this.bucketOrigin.fill(null);
    }

    // ── Update ───────────────────────────────────────────────────────────────

    /**
     * Advance the rope one step: simulate the active span (unless
     * `simulateActive` is false — the caller's stillness fast path), then
     * tighten the frozen spans by however much rope the active span demands.
     * Both phases share the same `staticGrid` + `dynamics` obstacle context.
     */
    update(
        dt: number,
        staticGrid: ColliderGrid,
        dynamics: readonly Collider[],
        simulateActive = true,
    ): void {
        this.dashPhase += dt * 14;
        this.frameGrid = staticGrid;
        this.frameDynamics = dynamics;

        // Motion heat cools everywhere; the phases below re-heat whatever
        // actually moves this frame.
        const cool = Math.exp(-5 * dt);
        for (const span of this.spans) {
            for (const j of span.joints) j.heat *= cool;
        }

        if (simulateActive) this.simulateActive(dt, staticGrid, dynamics);
        this.applyPullthrough(staticGrid, dynamics);
    }

    // ── Active-span simulation ───────────────────────────────────────────────

    private simulateActive(
        dt: number,
        staticGrid: ColliderGrid,
        dynamics: readonly Collider[],
    ): void {
        const joints = this.active().joints;
        const n = joints.length;
        if (n < 2) return;

        // Snapshot positions so motion heat can be measured after the phases.
        const prev = joints.map((j) => j.pos);

        // Broad phase: one grid query over the span's bounds, then a cheap
        // per-joint filter into reusable buckets.
        const margin = this.segmentLength * 2 + 8;
        this.bucketMargin = margin;
        this.chainObstacles.length = 0;
        if (!staticGrid.isEmpty) {
            staticGrid.query(jointsBounds(joints, margin), this.chainObstacles);
        }
        this.chainObstacles.push(...dynamics);

        for (let i = 1; i < n - 1; i++) {
            const bucket = this.jointObstacles[i];
            bucket.length = 0;
            this.bucketOrigin[i] = joints[i].pos.clone();
            if (this.chainObstacles.length === 0) continue;
            const region = threePointBounds(
                joints[i - 1].pos,
                joints[i].pos,
                joints[i + 1].pos,
                margin,
            );
            for (const c of this.chainObstacles) {
                if (region.intersects(colliderBounds(c))) bucket.push(c);
            }
        }

        // 0. Re-establish the "outside all obstacles" invariant (only a fresh
        // spawn can violate it — all movement below is swept).
        for (let i = 1; i < n - 1; i++) {
            const unstuck = pushPointOutOf(joints[i].pos, this.jointObstacles[i], ROPE_RADIUS);
            if (!unstuck.equals(joints[i].pos)) {
                joints[i].pos = unstuck;
                joints[i].oldPos = unstuck.clone();
            }
        }

        // 1. Residual Verlet inertia for slack joints (swept).
        const retention = Math.pow(DAMPING, dt);
        for (let i = 1; i < n - 1; i++) {
            const vel = joints[i].pos.sub(joints[i].oldPos).scale(retention);
            const target = joints[i].pos.add(vel);
            joints[i].oldPos = joints[i].pos;
            joints[i].pos = this.jointMove(i, joints[i].pos, target).pos;
        }

        // 2. Bidirectional max-length constraints (swept).
        this.wasConstrained.fill(false);
        this.obstacleConstrained.fill(false);
        for (let iter = 0; iter < CONSTRAINT_ITERATIONS; iter++) {
            if (this.constraintPass(joints, true) < CONSTRAINT_EPS_SQ) break;
        }

        // 3. Partial velocity retention.
        for (let i = 1; i < n - 1; i++) {
            if (this.obstacleConstrained[i]) {
                // Resting against a wall: drop all velocity, or the joint
                // would try to move through the obstacle next frame.
                joints[i].oldPos = joints[i].pos;
            } else if (this.wasConstrained[i]) {
                const vel = joints[i].pos.sub(joints[i].oldPos);
                joints[i].oldPos = joints[i].pos.sub(vel.scale(INERTIA_KEEP));
            }
        }

        // 4. Bend resistance (only while under tension).
        let underTension = false;
        for (let i = 1; i < n - 1; i++) underTension ||= this.wasConstrained[i];
        const stretch = this.stretch();
        if (underTension && STRAIGHTNESS > 0 && stretch > 0.1) {
            const strength = STRAIGHTNESS * stretch * stretch;
            for (let iter = 0; iter < 8; iter++) {
                let maxDeltaSq = 0;
                for (let i = 1; i < n - 1; i++) {
                    const ideal = joints[i - 1].pos.add(joints[i + 1].pos).scale(0.5);
                    const current = joints[i].pos;
                    const target = current.add(ideal.sub(current).scale(strength));
                    const moved = this.jointMove(i, current, target);
                    joints[i].pos = moved.pos;
                    if (moved.hit) this.obstacleConstrained[i] = true;
                    maxDeltaSq = Math.max(maxDeltaSq, moved.pos.distanceSq(current));
                }
                if (maxDeltaSq < 0.01) break;
            }
            for (let iter = 0; iter < 5; iter++) {
                if (this.constraintPass(joints, false) < CONSTRAINT_EPS_SQ) break;
            }
            // Under tension the rope settles crisply: drop all velocity.
            for (let i = 1; i < n - 1; i++) joints[i].oldPos = joints[i].pos;
        }

        // Re-heat what moved this frame; taut (constrained) joints stay warm
        // even when barely moving, so a stretched rope keeps animating.
        for (let i = 0; i < n; i++) {
            const moved = joints[i].pos.distance(prev[i]);
            joints[i].heat = Math.max(joints[i].heat, Math.min(1, moved * 0.5));
            if (this.wasConstrained[i]) joints[i].heat = Math.max(joints[i].heat, 0.2);
        }
        // Pinned endpoints inherit their neighbour's motion (they are set by
        // the caller before the update, so their own delta reads as zero).
        joints[0].heat = Math.max(joints[0].heat, joints[1].heat);
        joints[n - 1].heat = Math.max(joints[n - 1].heat, joints[n - 2].heat);
    }

    /**
     * One bidirectional distance-constraint sweep over the active span
     * (player→anchor then anchor→player). Returns the squared magnitude of
     * the largest correction.
     */
    private constraintPass(joints: Joint[], markConstrained: boolean): number {
        const n = joints.length;
        const sl = this.segmentLength;
        const slSq = sl * sl;
        let maxMoveSq = 0;

        const solve = (i: number, neighbourIdx: number) => {
            const neighbour = joints[neighbourIdx].pos;
            const delta = joints[i].pos.sub(neighbour);
            const distSq = delta.lengthSq();
            if (distSq <= slSq) return;
            const dist = Math.sqrt(distSq);
            const target = neighbour.add(delta.scale(sl / dist));
            const oldPos = joints[i].pos;
            const moved = this.jointMove(i, oldPos, target);
            joints[i].pos = moved.pos;
            maxMoveSq = Math.max(maxMoveSq, moved.pos.distanceSq(oldPos));
            if (markConstrained) this.wasConstrained[i] = true;
            if (moved.hit) this.obstacleConstrained[i] = true;
        };

        for (let i = n - 2; i >= 1; i--) solve(i, i + 1); // player end → anchor
        for (let i = 1; i <= n - 2; i++) solve(i, i - 1); // anchor → player end
        return maxMoveSq;
    }

    /**
     * Move active-span joint `i` swept against its obstacle bucket.
     *
     * The bucket only covers a Chebyshev-`bucketMargin` neighbourhood of
     * where the joint was when it was gathered. A long tension-propagation
     * move (an end yank cascading down the rope) can leave that
     * neighbourhood — the original engine kept using the stale bucket there,
     * which is exactly how fast-moving chains passed through walls. When a
     * move would exit the covered region, the bucket is re-gathered from the
     * grid around the move first, so the sweep can never miss a wall.
     */
    private jointMove(i: number, from: Vec2, to: Vec2): { pos: Vec2; hit: boolean } {
        const origin = this.bucketOrigin[i];
        // Coverage slack accounts for the rope radius inflating every shape.
        const m = this.bucketMargin - 1 - 2 * ROPE_RADIUS;
        const covered =
            origin !== null &&
            Math.abs(from.x - origin.x) < m &&
            Math.abs(from.y - origin.y) < m &&
            Math.abs(to.x - origin.x) < m &&
            Math.abs(to.y - origin.y) < m;
        if (!covered) this.refreshBucket(i, from, to);

        const obstacles = this.jointObstacles[i];
        return obstacles.length === 0
            ? { pos: to, hit: false }
            : movePointSwept(from, to, obstacles, ROPE_RADIUS);
    }

    /** Re-gather joint `i`'s obstacle bucket around the move `from → to`. */
    private refreshBucket(i: number, from: Vec2, to: Vec2): void {
        const margin = this.bucketMargin;
        const region = Rect.fromPoints(from, to).grow(margin);
        const bucket = this.jointObstacles[i];
        bucket.length = 0;
        if (this.frameGrid && !this.frameGrid.isEmpty) this.frameGrid.query(region, bucket);
        for (const c of this.frameDynamics) {
            if (region.intersects(colliderBounds(c))) bucket.push(c);
        }
        // The new bucket covers `margin` around the move's midpoint.
        this.bucketOrigin[i] = from.add(to).scale(0.5);
    }

    // ── Frozen-span tightening (portal pull-through) ─────────────────────────

    /**
     * Shrink the frozen spans by however much rope the active span currently
     * demands, nearest-the-player first, and **feed the freed rope into the
     * active span** as new joints at the portal mouth. Rope pays through the
     * portal exactly as fast as the frozen side physically gives it up, so
     * total rope is conserved at all times.
     */
    private applyPullthrough(staticGrid: ColliderGrid, dynamics: readonly Collider[]): void {
        const frozenCount = this.spans.length - 1;
        if (frozenCount === 0) return;
        const lengths = this.spans.slice(0, -1).map((s) => Chain.spanLength(s));
        const consumed = lengths.reduce((s, l) => s + l, 0);
        const active = this.active();
        const activePath = Chain.spanLength(active);
        const capacity = (active.joints.length - 1) * this.segmentLength;
        const slack = this.spans
            .slice(0, -1)
            .reduce((s, span, i) => s + Math.max(0, lengths[i] - span.fMin), 0);

        // Rope is requested when the active span nears its current capacity
        // (the player is pulling), or when total rope has crept over budget.
        let demand = Math.max(
            activePath - (capacity - PULLTHROUGH_HEADROOM_SEGMENTS * this.segmentLength),
            activePath - (this.budget - consumed),
            0,
        );
        demand = Math.min(demand, slack);

        for (let idx = frozenCount - 1; idx >= 0 && demand > 0.25; idx--) {
            const targetLen = Math.max(this.spans[idx].fMin, lengths[idx] - demand);
            const freed = this.tightenSpan(this.spans[idx], targetLen, staticGrid, dynamics);
            demand -= freed;
            this.pendingRope += freed;
        }
        this.feedActiveSpan();
    }

    /**
     * Convert freed rope into new active-span joints, inserted at the portal
     * mouth (the active span's pinned start), one per `segmentLength` of rope.
     * Capped so the active span can never exceed the all-frozen-spans-taut
     * ceiling.
     */
    private feedActiveSpan(): void {
        const joints = this.active().joints;
        const cap = this.maxActiveJointCount();
        while (this.pendingRope >= this.segmentLength && joints.length < cap) {
            this.pendingRope -= this.segmentLength;
            const joint = makeJoint(joints[0].pos.clone());
            joint.heat = 1;
            joints.splice(1, 0, joint);
        }
        this.resizeScratch();
    }

    /**
     * Shorten a frozen span toward `targetLen` by midpoint relaxation with
     * swept joint moves (endpoints pinned). Obstacles include the dynamics —
     * a span frozen around a squeezable stays wrapped around it. Returns the
     * length actually given up (less when obstacles block tightening).
     */
    private tightenSpan(
        span: Span,
        targetLen: number,
        staticGrid: ColliderGrid,
        dynamics: readonly Collider[],
    ): number {
        const joints = span.joints;
        const n = joints.length;
        if (n < 3) return 0;
        const before = Chain.spanLength(span);
        if (before <= targetLen + 0.05) return 0;

        const region = jointsBounds(joints, 8);
        const obstacles: Collider[] = [];
        if (!staticGrid.isEmpty) staticGrid.query(region, obstacles);
        for (const c of dynamics) {
            if (region.intersects(colliderBounds(c))) obstacles.push(c);
        }

        const prev = joints.map((j) => j.pos);
        for (let iter = 0; iter < 24; iter++) {
            let maxMoveSq = 0;
            for (let i = 1; i < n - 1; i++) {
                const mid = joints[i - 1].pos.add(joints[i + 1].pos).scale(0.5);
                const target = joints[i].pos.lerp(mid, TIGHTEN_STRENGTH);
                const moved =
                    obstacles.length === 0
                        ? target
                        : movePointSwept(joints[i].pos, target, obstacles, ROPE_RADIUS).pos;
                maxMoveSq = Math.max(maxMoveSq, moved.distanceSq(joints[i].pos));
                joints[i].pos = moved;
                joints[i].oldPos = moved.clone();
            }
            if (Chain.spanLength(span) <= targetLen || maxMoveSq < 1e-4) break;
        }
        // Rope being pulled through re-heats the cells that gave way.
        for (let i = 0; i < n; i++) {
            const moved = joints[i].pos.distance(prev[i]);
            joints[i].heat = Math.max(joints[i].heat, Math.min(1, moved * 0.5));
        }
        return before - Chain.spanLength(span);
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    /**
     * Draw every span as **pixel-art rope**: the polyline is quantized onto
     * the world-pixel grid and rendered as square cells — a dark outline pass
     * and a 2×2 core whose shade alternates in 3-cell "links". The link
     * pattern crawls only through cells whose motion heat is above
     * [`HEAT_ANIMATE`], so the rope animates where it moves or is stretched
     * and rests as a static texture everywhere else.
     */
    draw(ctx: CanvasRenderingContext2D, alpha: number): void {
        ctx.save();
        ctx.globalAlpha *= alpha;
        const crawl = Math.floor(this.dashPhase * 2.5);

        for (const span of this.spans) {
            const joints = span.joints;
            if (joints.length < 2) continue;

            // Quantize the polyline into unique integer cells, carrying the
            // motion heat of the joints each cell came from.
            const cells: { x: number; y: number; heat: number }[] = [];
            let lastX = Infinity;
            let lastY = Infinity;
            for (let i = 1; i < joints.length; i++) {
                const a = joints[i - 1].pos;
                const b = joints[i].pos;
                const heat = Math.max(joints[i - 1].heat, joints[i].heat);
                const steps = Math.max(1, Math.ceil(a.distance(b)));
                for (let s = 0; s < steps; s++) {
                    const p = a.lerp(b, s / steps);
                    const x = Math.floor(p.x);
                    const y = Math.floor(p.y);
                    if (x === lastX && y === lastY) continue;
                    lastX = x;
                    lastY = y;
                    cells.push({ x, y, heat });
                }
            }

            // Outline pass: one dark 3×3 block per cell (reads as the rope's
            // pixel border and drop shade).
            ctx.fillStyle = 'rgb(26 20 9 / 80%)';
            for (const c of cells) ctx.fillRect(c.x - 1, c.y - 1, 3, 3);

            // Core pass: 2×2 blocks alternating light/dark every 3 cells to
            // read as chain links; moving cells shift the pattern by `crawl`.
            for (let k = 0; k < cells.length; k++) {
                const c = cells[k];
                const phase = c.heat > HEAT_ANIMATE ? k - crawl : k;
                const light = ((phase % 6) + 6) % 6 < 3;
                ctx.fillStyle = light ? this.color : '#b08a2e';
                ctx.fillRect(c.x - 1, c.y - 1, 2, 2);
            }
        }

        ctx.restore();
    }
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** AABB of a joint list grown by `margin` on every side. */
function jointsBounds(joints: readonly Joint[], margin: number): Rect {
    let min = joints[0].pos;
    let max = joints[0].pos;
    for (const j of joints) {
        min = min.min(j.pos);
        max = max.max(j.pos);
    }
    return new Rect(min.x - margin, min.y - margin, max.x - min.x + 2 * margin, max.y - min.y + 2 * margin);
}

/** AABB of three points, grown by `margin` on every side. */
function threePointBounds(a: Vec2, b: Vec2, c: Vec2, margin: number): Rect {
    const min = a.min(b).min(c);
    const max = a.max(b).max(c);
    return new Rect(min.x - margin, min.y - margin, max.x - min.x + 2 * margin, max.y - min.y + 2 * margin);
}

/**
 * Resample a polyline to `count` points spaced evenly by arc length. The
 * endpoints are preserved exactly.
 */
function resamplePolyline(points: readonly Vec2[], count: number): Vec2[] {
    if (points.length === 1) return Array.from({ length: count }, () => points[0].clone());
    let total = 0;
    for (let i = 1; i < points.length; i++) total += points[i - 1].distance(points[i]);
    if (total < 1e-6) return Array.from({ length: count }, () => points[0].clone());

    const out: Vec2[] = [points[0].clone()];
    let seg = 0;
    let segStartDist = 0;
    let segLen = points[0].distance(points[1]);
    for (let i = 1; i < count - 1; i++) {
        const target = (i / (count - 1)) * total;
        while (segStartDist + segLen < target && seg < points.length - 2) {
            segStartDist += segLen;
            seg++;
            segLen = points[seg].distance(points[seg + 1]);
        }
        const t = segLen > 1e-9 ? (target - segStartDist) / segLen : 0;
        out.push(points[seg].lerp(points[seg + 1], t));
    }
    out.push(points[points.length - 1].clone());
    return out;
}
