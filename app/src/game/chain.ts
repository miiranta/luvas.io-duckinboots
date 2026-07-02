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
}

/** Velocity retention per second for slack (un-tensioned) joints. */
const DAMPING = 0.025;
/** Bend resistance as the chain stretches (0 floppy … 1 cable-straight). */
const STRAIGHTNESS = 0.7;
/** Distance-constraint iterations per frame. */
const CONSTRAINT_ITERATIONS = 12;
/** Fraction of post-constraint velocity kept on tensioned joints (organic ripple). */
const INERTIA_KEEP = 0.15;
/** Stop iterating once corrections are sub-pixel. */
const CONSTRAINT_EPS_SQ = 0.0001;

/**
 * A chain simulated as a series of rigid links between two pinned endpoints —
 * a heavy cable dragged across a flat (top-down, gravity-free) surface.
 *
 * Physics model, preserved from the original and hardened:
 *
 * - **Swept joints** — every joint movement goes through a swept point query,
 *   so joints can never tunnel through geometry. This is the single invariant
 *   the whole no-teleport guarantee rests on.
 * - **Propagation from the player end** — constraints run end→anchor first,
 *   so when slack only the links near the player move.
 * - **Immediate settling** — joints pressed against a wall drop all velocity;
 *   tensioned joints keep only a small ripple (`INERTIA_KEEP`).
 * - **Bend resistance** — joints are pulled toward their neighbours' midpoint,
 *   scaled by path stretch, so the chain reads as taut when extended.
 *
 * Broad phase: one grid query over the chain's bounding box per frame, then a
 * cheap per-joint AABB filter — the grid is walked once per chain, not once
 * per joint.
 */
export class Chain {
    private readonly joints: Joint[];
    readonly segmentLength: number;
    readonly linkSize: number;
    private readonly color: string;

    private readonly wasConstrained: boolean[];
    private readonly obstacleConstrained: boolean[];
    /** Per-joint obstacle candidates, rebuilt each frame (arrays reused). */
    private readonly jointObstacles: Collider[][];
    /** Every obstacle near the whole chain this frame (one grid query). */
    private chainObstacles: Collider[] = [];
    /** Animated dash offset that makes the link pattern crawl along the rope. */
    private dashPhase = 0;

    constructor(start: Vec2, end: Vec2, totalLength: number, linkSize: number, color: string) {
        const numSegments = Math.max(1, Math.ceil(totalLength / linkSize));
        this.segmentLength = totalLength / numSegments;
        this.linkSize = linkSize;
        this.color = color;

        this.joints = [];
        for (let i = 0; i <= numSegments; i++) {
            const pos = start.lerp(end, i / numSegments);
            this.joints.push({ pos, oldPos: pos.clone() });
        }
        const n = this.joints.length;
        this.wasConstrained = new Array(n).fill(false);
        this.obstacleConstrained = new Array(n).fill(false);
        this.jointObstacles = Array.from({ length: n }, () => []);
    }

    /**
     * Build a chain directly from an explicit polyline — used for **frozen
     * snippets** captured when a chain splits at a portal, and for rebuilding
     * the active snippet from a known-good (collision-respecting) shape.
     */
    static fromPoints(
        points: readonly Vec2[],
        segmentLength: number,
        linkSize: number,
        color: string,
    ): Chain {
        const chain = Object.create(Chain.prototype) as Chain;
        Object.assign(chain, {
            segmentLength,
            linkSize,
            color,
            joints: points.map((p) => ({ pos: p.clone(), oldPos: p.clone() })),
            wasConstrained: new Array(points.length).fill(false),
            obstacleConstrained: new Array(points.length).fill(false),
            jointObstacles: Array.from({ length: points.length }, () => []),
            chainObstacles: [],
            dashPhase: 0,
        });
        return chain;
    }

    get length(): number {
        return this.joints.length;
    }

    /** Current joint positions as a polyline, anchor → player order. */
    pathPoints(): Vec2[] {
        return this.joints.map((j) => j.pos.clone());
    }

    /** Current geometric path length (sum of segment distances). */
    pathLength(): number {
        let sum = 0;
        for (let i = 1; i < this.joints.length; i++) {
            sum += this.joints[i - 1].pos.distance(this.joints[i].pos);
        }
        return sum;
    }

    /** Total maximum length of the chain. */
    maxLength(): number {
        return this.segmentLength * (this.joints.length - 1);
    }

    /** Overwrite every joint (used to straighten frozen snippets). */
    setJointPositions(points: readonly Vec2[]): void {
        for (let i = 0; i < this.joints.length && i < points.length; i++) {
            this.joints[i].pos = points[i].clone();
            this.joints[i].oldPos = points[i].clone();
        }
    }

    setStart(pos: Vec2): void {
        this.joints[0].pos = pos.clone();
        this.joints[0].oldPos = pos.clone();
    }

    setEnd(pos: Vec2): void {
        const last = this.joints[this.joints.length - 1];
        last.pos = pos.clone();
        last.oldPos = pos.clone();
    }

    start(): Vec2 {
        return this.joints[0].pos;
    }

    /** True when every joint's frame displacement is below `threshold`. */
    isStill(threshold: number): boolean {
        const tSq = threshold * threshold;
        return this.joints.every((j) => j.pos.distanceSq(j.oldPos) < tSq);
    }

    /**
     * Geometric stretch in [0, 1]: actual path length / max length. Reflects
     * the real chain path, so a chain wrapped around an obstacle reads 1.0
     * when fully extended.
     */
    stretch(): number {
        return Math.min(1, Math.max(0, this.pathLength() / this.maxLength()));
    }

    /**
     * Tether point and remaining free length for the player constraint: the
     * last obstacle-contact joint (walking back from the player end) and the
     * rope left beyond it. With no contact it degenerates to the anchor and
     * the full length. Call after `update`.
     */
    playerTether(): { tether: Vec2; freeLength: number } {
        const n = this.joints.length;
        let contactIdx = 0;
        for (let i = n - 2; i >= 0; i--) {
            if (this.obstacleConstrained[i]) {
                contactIdx = i;
                break;
            }
        }
        return {
            tether: this.joints[contactIdx].pos,
            freeLength: (n - 1 - contactIdx) * this.segmentLength,
        };
    }

    /** Every joint position — used by the squeeze detection. */
    jointPositions(): readonly Vec2[] {
        return this.joints.map((j) => j.pos);
    }

    /** Move joint `i` swept against its per-frame obstacle list. */
    private jointMove(i: number, from: Vec2, to: Vec2): { pos: Vec2; hit: boolean } {
        const obstacles = this.jointObstacles[i];
        return obstacles.length === 0 ? { pos: to, hit: false } : movePointSwept(from, to, obstacles);
    }

    /** AABB of every joint grown by `margin` (the once-per-chain broad phase). */
    private jointsBounds(margin: number): Rect {
        let min = this.joints[0].pos;
        let max = this.joints[0].pos;
        for (const j of this.joints) {
            min = min.min(j.pos);
            max = max.max(j.pos);
        }
        return new Rect(min.x - margin, min.y - margin, max.x - min.x + 2 * margin, max.y - min.y + 2 * margin);
    }

    /**
     * Advance the simulation. Both anchors must be pinned via `setStart` /
     * `setEnd` first. `staticGrid` indexes the immovable world; `dynamics` are
     * the few moving obstacles scanned linearly.
     */
    update(dt: number, staticGrid: ColliderGrid, dynamics: readonly Collider[]): void {
        const n = this.joints.length;
        if (n < 2) return;

        this.dashPhase += dt * 14;

        // ── Broad phase: one grid query per chain, filtered per joint ───────
        const margin = this.segmentLength * 2 + 8;
        this.chainObstacles.length = 0;
        if (!staticGrid.isEmpty) staticGrid.query(this.jointsBounds(margin), this.chainObstacles);
        this.chainObstacles.push(...dynamics);

        for (let i = 1; i < n - 1; i++) {
            const bucket = this.jointObstacles[i];
            bucket.length = 0;
            if (this.chainObstacles.length === 0) continue;
            const region = threePointBounds(
                this.joints[i - 1].pos,
                this.joints[i].pos,
                this.joints[i + 1].pos,
                margin,
            );
            for (const c of this.chainObstacles) {
                if (region.intersects(colliderBounds(c))) bucket.push(c);
            }
        }

        // ── 0. Re-establish the "outside all obstacles" invariant ───────────
        // Only a fresh spawn can violate it (all movement below is swept).
        for (let i = 1; i < n - 1; i++) {
            const unstuck = pushPointOutOf(this.joints[i].pos, this.jointObstacles[i]);
            if (!unstuck.equals(this.joints[i].pos)) {
                this.joints[i].pos = unstuck;
                this.joints[i].oldPos = unstuck.clone();
            }
        }

        // ── 1. Residual Verlet inertia for slack joints (swept) ─────────────
        const retention = Math.pow(DAMPING, dt);
        for (let i = 1; i < n - 1; i++) {
            const vel = this.joints[i].pos.sub(this.joints[i].oldPos).scale(retention);
            const target = this.joints[i].pos.add(vel);
            this.joints[i].oldPos = this.joints[i].pos;
            this.joints[i].pos = this.jointMove(i, this.joints[i].pos, target).pos;
        }

        // ── 2. Bidirectional max-length constraints (swept) ─────────────────
        this.wasConstrained.fill(false);
        this.obstacleConstrained.fill(false);
        for (let iter = 0; iter < CONSTRAINT_ITERATIONS; iter++) {
            const maxMove = this.constraintPass(true);
            if (maxMove < CONSTRAINT_EPS_SQ) break;
        }

        // ── 3. Partial velocity retention ────────────────────────────────────
        for (let i = 1; i < n - 1; i++) {
            if (this.obstacleConstrained[i]) {
                // Resting against a wall: no velocity, or it would try to move
                // through the obstacle next frame.
                this.joints[i].oldPos = this.joints[i].pos;
            } else if (this.wasConstrained[i]) {
                const vel = this.joints[i].pos.sub(this.joints[i].oldPos);
                this.joints[i].oldPos = this.joints[i].pos.sub(vel.scale(INERTIA_KEEP));
            }
        }

        // ── 4. Bend resistance (only while under tension) ────────────────────
        const underTension = this.wasConstrained.some((c, i) => c && i > 0 && i < n - 1);
        const stretch = this.stretch();
        if (underTension && STRAIGHTNESS > 0 && stretch > 0.1) {
            const strength = STRAIGHTNESS * stretch * stretch;
            for (let iter = 0; iter < 8; iter++) {
                let maxDeltaSq = 0;
                for (let i = 1; i < n - 1; i++) {
                    const ideal = this.joints[i - 1].pos.add(this.joints[i + 1].pos).scale(0.5);
                    const current = this.joints[i].pos;
                    const target = current.add(ideal.sub(current).scale(strength));
                    const moved = this.jointMove(i, current, target);
                    this.joints[i].pos = moved.pos;
                    if (moved.hit) this.obstacleConstrained[i] = true;
                    maxDeltaSq = Math.max(maxDeltaSq, moved.pos.distanceSq(current));
                }
                if (maxDeltaSq < 0.01) break;
            }

            // Re-enforce max length broken by straightening.
            for (let iter = 0; iter < 5; iter++) {
                if (this.constraintPass(false) < CONSTRAINT_EPS_SQ) break;
            }

            // Under tension the chain settles crisply: drop all velocity.
            for (let i = 1; i < n - 1; i++) {
                this.joints[i].oldPos = this.joints[i].pos;
            }
        }
    }

    /**
     * One bidirectional distance-constraint sweep (player→anchor then
     * anchor→player). Returns the squared magnitude of the largest correction.
     * `markConstrained` also records tension for the inertia/bend phases.
     */
    private constraintPass(markConstrained: boolean): number {
        const n = this.joints.length;
        const sl = this.segmentLength;
        const slSq = sl * sl;
        let maxMoveSq = 0;

        const solve = (i: number, neighbourIdx: number) => {
            const neighbour = this.joints[neighbourIdx].pos;
            const delta = this.joints[i].pos.sub(neighbour);
            const distSq = delta.lengthSq();
            if (distSq <= slSq) return;
            const dist = Math.sqrt(distSq);
            const target = neighbour.add(delta.scale(sl / dist));
            const oldPos = this.joints[i].pos;
            const moved = this.jointMove(i, oldPos, target);
            this.joints[i].pos = moved.pos;
            maxMoveSq = Math.max(maxMoveSq, moved.pos.distanceSq(oldPos));
            if (markConstrained) this.wasConstrained[i] = true;
            if (moved.hit) this.obstacleConstrained[i] = true;
        };

        for (let i = n - 2; i >= 1; i--) solve(i, i + 1); // player end → anchor
        for (let i = 1; i <= n - 2; i++) solve(i, i - 1); // anchor → player end
        return maxMoveSq;
    }

    /**
     * Draw the chain as a clean layered rope: a dark outline, a coloured
     * core, a thin highlight, and an animated dark dash pattern that reads as
     * links crawling along the cable. Widths are in world pixels and kept
     * slim; `alpha` lets the caller fade the whole rope.
     */
    draw(ctx: CanvasRenderingContext2D, alpha: number): void {
        const n = this.joints.length;
        if (n < 2) return;

        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(this.joints[0].pos.x, this.joints[0].pos.y);
        for (let i = 1; i < n; i++) ctx.lineTo(this.joints[i].pos.x, this.joints[i].pos.y);

        // Outline → core → link dashes → highlight, all on the same path.
        ctx.strokeStyle = 'rgb(8 8 14 / 60%)';
        ctx.lineWidth = 3.2;
        ctx.stroke();

        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.setLineDash([3, 2.2]);
        ctx.lineDashOffset = -this.dashPhase;
        ctx.strokeStyle = 'rgb(0 0 0 / 28%)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = 'rgb(255 255 255 / 30%)';
        ctx.lineWidth = 0.7;
        ctx.stroke();

        ctx.restore();
    }
}

/** AABB of three points, grown by `margin` on every side. */
function threePointBounds(a: Vec2, b: Vec2, c: Vec2, margin: number): Rect {
    const min = a.min(b).min(c);
    const max = a.max(b).max(c);
    return new Rect(min.x - margin, min.y - margin, max.x - min.x + 2 * margin, max.y - min.y + 2 * margin);
}
