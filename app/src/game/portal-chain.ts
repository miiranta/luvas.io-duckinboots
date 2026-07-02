import { Rect, Vec2 } from '../engine/math';
import { SpriteSheet } from '../engine/sprite-sheet';
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
    private readonly sheet: SpriteSheet;

    constructor(
        start: Vec2,
        end: Vec2,
        totalLength: number,
        linkSize: number,
        color: string,
        sheet: SpriteSheet,
    ) {
        const active = new Chain(start, end, totalLength, linkSize, color, sheet);
        this.snippets = [active];
        this.budget = totalLength;
        this.linkSize = linkSize;
        this.color = color;
        this.segmentLength = active.segmentLength;
        this.sheet = sheet;
    }

    private sumFMin(): number {
        return this.frozen.reduce((s, f) => s + f.fMin, 0);
    }

    private sumFInit(): number {
        return this.frozen.reduce((s, f) => s + f.fInit, 0);
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
        const fInit = polylineLength(captured);
        const fMin = a.distance(inCenter);

        this.snippets[this.snippets.length - 1] = Chain.fromPoints(
            captured,
            this.segmentLength,
            this.linkSize,
            this.color,
            this.sheet,
        );
        this.frozen.push({ captured, fInit, fMin, a: a.clone(), b: inCenter.clone() });
        this.snippets.push(
            new Chain(outCenter, playerPt, this.activeBudget(), this.linkSize, this.color, this.sheet),
        );
    }

    /**
     * Undo the most recent split (the player went back the same way): drop the
     * active snippet and the frozen one that fed it, rebuilding a single
     * active snippet from the merged anchor to the player.
     */
    merge(playerPt: Vec2): void {
        const meta = this.frozen.pop();
        if (!meta) return;
        this.snippets.pop(); // active
        this.snippets.pop(); // the snippet frozen at this crossing
        this.snippets.push(
            new Chain(meta.a, playerPt, this.activeBudget(), this.linkSize, this.color, this.sheet),
        );
    }

    /**
     * Straighten each frozen snippet according to how much rope the active
     * snippet is pulling through. Call every frame after `updateActive`.
     *
     * **Collision-aware** (fixes the original game's clipping bug): the
     * straight anchor→portal line a snippet is lerped toward can cut through
     * walls, so each internal joint is moved from its current position toward
     * its straightened target through the same swept query the live chain
     * uses — a frozen snippet pulls as taut as the geometry allows and can
     * never pass through it.
     */
    applyPullthrough(staticGrid?: ColliderGrid): void {
        if (this.frozen.length === 0) return;
        const activePath = this.active().pathLength();
        const available = this.budget - this.sumFInit();
        const slack = this.sumFInit() - this.sumFMin();
        let remaining = Math.min(Math.max(activePath - available, 0), slack);

        // Nearest-the-player frozen snippet (last) gives up rope first.
        for (let idx = this.frozen.length - 1; idx >= 0; idx--) {
            const m = this.frozen[idx];
            const giveCap = m.fInit - m.fMin;
            let t = 0;
            if (giveCap > 1e-4) {
                const give = Math.min(remaining, giveCap);
                remaining -= give;
                t = give / giveCap;
            }
            const n = m.captured.length;
            const straight = m.captured.map((p, j) => {
                const onLine = m.a.lerp(m.b, j / (n - 1));
                return p.lerp(onLine, t);
            });

            if (!staticGrid || staticGrid.isEmpty) {
                this.snippets[idx].setJointPositions(straight);
                continue;
            }

            // Sweep each internal joint from where it is toward its target so
            // straightening can press a joint against a wall but never through
            // it. Endpoints are pinned anchors and stay put.
            const current = this.snippets[idx].pathPoints();
            const obstacles: Collider[] = [];
            staticGrid.query(boundsOfPoints([...current, ...straight], 8), obstacles);
            const resolved = straight.map((target, j) => {
                if (j === 0 || j === n - 1 || obstacles.length === 0) return target;
                return movePointSwept(current[j] ?? target, target, obstacles).pos;
            });
            this.snippets[idx].setJointPositions(resolved);
        }
    }

    draw(ctx: CanvasRenderingContext2D, alpha: number): void {
        for (const snippet of this.snippets) snippet.draw(ctx, alpha);
    }
}

/** Bookkeeping for one frozen snippet (parallel to `snippets[i]`). */
interface FrozenMeta {
    /** The snippet's shape captured at split time (anchor → portal-in order). */
    captured: Vec2[];
    /** Path length of `captured` — rope consumed when slack. */
    fInit: number;
    /** Straight-line a→b length — rope consumed when fully taut. */
    fMin: number;
    /** Start anchor (world anchor or a portal exit). */
    a: Vec2;
    /** End anchor (a portal entrance). */
    b: Vec2;
}

function polylineLength(points: readonly Vec2[]): number {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += points[i - 1].distance(points[i]);
    return sum;
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
