import { Rect, Vec2 } from '../engine/math';
import { Chain } from './chain';
import { Collider, ColliderGrid, movePointSwept } from './collision';

/**
 * A chain that can thread through portals.
 *
 * Holds an ordered list of [`Chain`] **snippets**. Only the last is *active*
 * (simulated, following the player); every earlier one is *frozen*: pinned
 * between two fixed anchors and never simulated. As the player drags rope
 * through a portal, frozen snippets straighten toward taut, conserving a
 * single fixed rope budget:
 *
 * - each frozen snippet consumes between `fMin` (straight-line taut length)
 *   and `fInit` (its captured path length at split time);
 * - the active snippet's reach cap is `budget − Σ fMin`;
 * - `applyPullthrough` decides per frame how straight each frozen snippet
 *   currently is, nearest-the-player first.
 */
export class PortalChain {
    /** `[frozen…, active]`; always `frozen.length + 1` entries. */
    private snippets: Chain[];
    private frozen: FrozenMeta[] = [];
    /** Total rope length, conserved across all snippets. */
    private readonly budget: number;
    private readonly linkSize: number;
    private readonly color: string;
    private readonly segmentLength: number;

    constructor(start: Vec2, end: Vec2, totalLength: number, linkSize: number, color: string) {
        const active = new Chain(start, end, totalLength, linkSize, color);
        this.snippets = [active];
        this.budget = totalLength;
        this.linkSize = linkSize;
        this.color = color;
        this.segmentLength = active.segmentLength;
    }

    private sumFMin(): number {
        return this.frozen.reduce((s, f) => s + f.fMin, 0);
    }

    /** Rope left for the active snippet once every frozen one is fully taut. */
    private activeBudget(): number {
        return Math.max(this.budget - this.sumFMin(), this.segmentLength);
    }

    private active(): Chain {
        return this.snippets[this.snippets.length - 1];
    }

    /** Total rope budget (used to order chains for layered drawing). */
    maxLength(): number {
        return this.budget;
    }

    /** Pin the world anchor (only meaningful while un-split). */
    setStart(anchor: Vec2): void {
        if (this.frozen.length === 0) this.snippets[0].setStart(anchor);
    }

    /** Pin the active snippet's player-side end. */
    setEnd(playerPt: Vec2): void {
        this.active().setEnd(playerPt);
    }

    /** Simulate the active snippet only. */
    updateActive(dt: number, staticGrid: ColliderGrid, dynamics: readonly Collider[]): void {
        this.active().update(dt, staticGrid, dynamics);
    }

    /** Tether point + remaining free length for clamping the player. */
    activeTether(): { tether: Vec2; freeLength: number } {
        return this.active().playerTether();
    }

    isStill(threshold: number): boolean {
        return this.active().isStill(threshold);
    }

    /** All snippets (frozen then active), for drawing and squeeze detection. */
    allSnippets(): readonly Chain[] {
        return this.snippets;
    }

    /**
     * Split at a portal: freeze the active snippet's shape (player end snapped
     * to `inCenter`) and start a fresh collapsed active snippet at `outCenter`.
     */
    split(inCenter: Vec2, outCenter: Vec2, playerPt: Vec2): void {
        const captured = this.active().pathPoints();
        if (captured.length < 2) return;
        captured[captured.length - 1] = inCenter.clone();
        const a = captured[0];

        this.snippets[this.snippets.length - 1] = Chain.fromPoints(
            captured,
            this.segmentLength,
            this.linkSize,
            this.color,
        );
        this.frozen.push({ a: a.clone(), b: inCenter.clone(), fMin: a.distance(inCenter) });
        this.snippets.push(
            new Chain(outCenter, playerPt, this.activeBudget(), this.linkSize, this.color),
        );
    }

    /**
     * Undo the most recent split (the player went back the same way): drop the
     * active snippet and reabsorb the frozen one that fed it.
     *
     * The rebuilt active snippet starts from the frozen snippet's **current
     * shape** (resampled to the new joint budget), not from a straight
     * anchor→player line as the original did — a straight respawn cuts through
     * any wall between the two points and was the main way chains ended up
     * threaded through geometry. Continuing from a shape that already respects
     * collision can never introduce a crossing.
     */
    merge(playerPt: Vec2): void {
        const meta = this.frozen.pop();
        if (!meta) return;
        this.snippets.pop(); // the (collapsed) active snippet on the far side
        const reabsorbed = this.snippets.pop();

        const budget = this.activeBudget();
        const jointCount = Math.max(2, Math.ceil(budget / this.linkSize) + 1);
        const shape = reabsorbed ? reabsorbed.pathPoints() : [meta.a.clone()];
        shape.push(playerPt.clone());
        const points = resamplePolyline(shape, jointCount);
        this.snippets.push(Chain.fromPoints(points, this.segmentLength, this.linkSize, this.color));
    }

    /**
     * Pull rope through the portals: shrink the frozen snippets by however
     * much rope the active snippet currently demands, nearest-the-player
     * first. Call every frame after `updateActive`.
     *
     * **Collision-aware** (fixes the original game's clipping bug): the
     * original lerped every joint toward the straight anchor→portal line,
     * which cuts through any wall the snippet wraps — chains visibly ignored
     * collision the moment they crossed a portal. Instead each snippet is
     * tightened by the same *local midpoint relaxation with swept moves* the
     * live chain uses for bend resistance: joints slide along wall faces and
     * wrap corners like a rope over a pulley, so the snippet pulls exactly as
     * taut as the geometry allows and can never pass through it.
     */
    applyPullthrough(staticGrid?: ColliderGrid): void {
        if (this.frozen.length === 0) return;
        const lengths = this.frozen.map((_, i) => this.snippets[i].pathLength());
        const consumed = lengths.reduce((s, l) => s + l, 0);
        const activePath = this.active().pathLength();
        const slack = this.frozen.reduce(
            (s, f, i) => s + Math.max(0, lengths[i] - f.fMin),
            0,
        );
        let demand = Math.min(Math.max(activePath - (this.budget - consumed), 0), slack);

        for (let idx = this.frozen.length - 1; idx >= 0 && demand > 0.25; idx--) {
            const targetLen = Math.max(this.frozen[idx].fMin, lengths[idx] - demand);
            demand -= this.tightenSnippet(idx, targetLen, staticGrid);
        }
    }

    /**
     * Shorten frozen snippet `idx` toward `targetLen` by midpoint relaxation
     * with swept joint moves (endpoints pinned). Returns the length actually
     * given up — less than requested when walls block further tightening.
     */
    private tightenSnippet(idx: number, targetLen: number, staticGrid?: ColliderGrid): number {
        const snippet = this.snippets[idx];
        const pts = snippet.pathPoints();
        const n = pts.length;
        if (n < 3) return 0;
        const before = polylineLength(pts);
        if (before <= targetLen + 0.05) return 0;

        const obstacles: Collider[] = [];
        if (staticGrid && !staticGrid.isEmpty) {
            staticGrid.query(boundsOfPoints(pts, 8), obstacles);
        }

        const STRENGTH = 0.35;
        for (let iter = 0; iter < 24; iter++) {
            let maxMoveSq = 0;
            for (let i = 1; i < n - 1; i++) {
                const mid = pts[i - 1].add(pts[i + 1]).scale(0.5);
                const target = pts[i].lerp(mid, STRENGTH);
                const moved =
                    obstacles.length === 0 ? target : movePointSwept(pts[i], target, obstacles).pos;
                maxMoveSq = Math.max(maxMoveSq, moved.distanceSq(pts[i]));
                pts[i] = moved;
            }
            if (polylineLength(pts) <= targetLen || maxMoveSq < 1e-4) break;
        }
        snippet.setJointPositions(pts);
        return before - polylineLength(pts);
    }

    draw(ctx: CanvasRenderingContext2D, alpha: number): void {
        for (const snippet of this.snippets) snippet.draw(ctx, alpha);
    }
}

/** Bookkeeping for one frozen snippet (parallel to `snippets[i]`). */
interface FrozenMeta {
    /** Start anchor (world anchor or a portal exit). */
    a: Vec2;
    /** End anchor (a portal entrance). */
    b: Vec2;
    /** Straight-line a→b length — rope consumed when fully taut. */
    fMin: number;
}

function polylineLength(points: readonly Vec2[]): number {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += points[i - 1].distance(points[i]);
    return sum;
}

/**
 * Resample a polyline to `count` points spaced evenly by arc length. The
 * endpoints are preserved exactly.
 */
function resamplePolyline(points: readonly Vec2[], count: number): Vec2[] {
    if (points.length === 1) return Array.from({ length: count }, () => points[0].clone());
    const total = polylineLength(points);
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

/** AABB of a point set, grown by `margin` on every side. */
function boundsOfPoints(points: readonly Vec2[], margin: number): Rect {
    let min = points[0];
    let max = points[0];
    for (const p of points) {
        min = min.min(p);
        max = max.max(p);
    }
    return new Rect(min.x - margin, min.y - margin, max.x - min.x + 2 * margin, max.y - min.y + 2 * margin);
}
