/**
 * 2D collision toolkit built around **continuous (swept) resolution**.
 *
 * Movers travel through `resolveAabb`, which sweeps an AABB against a set of
 * colliders (rectangles and circles) and slides along the first surface it
 * touches — fast movers can never tunnel. `depenetrateAabb` is the static
 * safety net run afterwards. The chain solver uses the point-based swept
 * queries (`movePointSwept`).
 *
 * The broad phase is a **uniform spatial hash grid** (`ColliderGrid`) over the
 * static world, built once at level load. It replaces the original quadtree:
 * simpler, allocation-free queries, and O(1) cell lookup — the fastest broad
 * phase for a static set of a few hundred shapes.
 */

import { Circle, Rect, Vec2 } from '../engine/math';

// ── Colliders ────────────────────────────────────────────────────────────────

export type Collider =
    | { kind: 'aabb'; rect: Rect }
    | { kind: 'circle'; center: Vec2; radius: number };

export function aabb(rect: Rect): Collider {
    return { kind: 'aabb', rect };
}

export function circleCollider(center: Vec2, radius: number): Collider {
    return { kind: 'circle', center, radius };
}

export function colliderBounds(c: Collider): Rect {
    return c.kind === 'aabb'
        ? c.rect
        : new Rect(c.center.x - c.radius, c.center.y - c.radius, c.radius * 2, c.radius * 2);
}

export interface Hit {
    /** First-contact time in [0, 1] along the frame displacement. */
    t: number;
    /** Contact normal (unit, axis-aligned for AABB faces). */
    normal: Vec2;
}

// ── Slab math (NaN-safe swept ray vs AABB) ───────────────────────────────────

/**
 * Below this speed an axis counts as *parallel* to its slab: the swept query
 * can't divide by it, so it falls back to a containment test instead of a
 * `1/vel` reciprocal that would be ±∞ (and `0 * ∞ = NaN`).
 */
const PARALLEL_EPS = 1e-8;

/**
 * Entry/exit times for one axis of a swept ray against the slab `[lo, hi]`.
 * Returns `null` when contact is impossible this frame. Exact edge alignment
 * counts as *outside* (strict comparisons), which is what lets two flush
 * boxes slide past each other instead of snagging — the classic `0 * ∞` trap
 * the original engine fixed and this port preserves.
 */
function slab(origin: number, vel: number, lo: number, hi: number): [number, number] | null {
    if (Math.abs(vel) <= PARALLEL_EPS) {
        return origin > lo && origin < hi ? [-Infinity, Infinity] : null;
    }
    const inv = 1 / vel;
    const tLo = (lo - origin) * inv;
    const tHi = (hi - origin) * inv;
    return tLo < tHi ? [tLo, tHi] : [tHi, tLo];
}

/** Combine per-axis slab spans into a first-contact hit, or `null`. */
function slabHit(tx: [number, number], ty: [number, number], vel: Vec2): Hit | null {
    const tEntry = Math.max(tx[0], ty[0]);
    const tExit = Math.min(tx[1], ty[1]);
    if (tEntry >= tExit || tEntry >= 1 || tExit <= 0) return null;
    const t = Math.max(tEntry, 0);
    // The axis that entered *last* is the one actually struck.
    const normal =
        tx[0] > ty[0] ? new Vec2(vel.x < 0 ? 1 : -1, 0) : new Vec2(0, vel.y < 0 ? 1 : -1);
    return { t, normal };
}

// ── Swept queries ────────────────────────────────────────────────────────────

/**
 * Sweep a moving AABB (top-left `pos`, `size`, frame displacement `vel`)
 * against a static AABB via Minkowski expansion + ray-box intersection.
 */
export function sweepRect(pos: Vec2, size: Vec2, vel: Vec2, rect: Rect): Hit | null {
    const tx = slab(pos.x, vel.x, rect.x - size.x, rect.right);
    if (!tx) return null;
    const ty = slab(pos.y, vel.y, rect.y - size.y, rect.bottom);
    if (!ty) return null;
    return slabHit(tx, ty, vel);
}

/** Swept **point** vs static AABB. */
export function sweepPointAabb(pos: Vec2, vel: Vec2, rect: Rect): Hit | null {
    const tx = slab(pos.x, vel.x, rect.x, rect.right);
    if (!tx) return null;
    const ty = slab(pos.y, vel.y, rect.y, rect.bottom);
    if (!ty) return null;
    return slabHit(tx, ty, vel);
}

/** Swept **point** vs static circle (ray–circle, entering from outside). */
export function sweepPointCircle(pos: Vec2, vel: Vec2, center: Vec2, radius: number): Hit | null {
    const d = pos.sub(center);
    const a = vel.dot(vel);
    if (a < 1e-12) return null;
    const c = d.dot(d) - radius * radius;
    if (c < 0) {
        // Already inside (shouldn't happen under the invariant) → radial contact.
        return { t: 0, normal: d.normalize(Vec2.Y) };
    }
    const b = 2 * d.dot(vel);
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > 1) return null;
    const normal = pos.add(vel.scale(t)).sub(center).normalize(Vec2.Y);
    return { t, normal };
}

/**
 * Swept **box** vs static circle via the Minkowski sum (a rounded rectangle):
 * in the box's centre frame the circle centre becomes a moving point tested
 * against two expanded boxes and four corner circles; the earliest entry into
 * any piece is the earliest contact with the whole shape.
 */
function sweepAabbCircle(pos: Vec2, size: Vec2, vel: Vec2, center: Vec2, radius: number): Hit | null {
    const half = size.scale(0.5);
    const origin = center.sub(pos.add(half));
    const dir = vel.neg();

    const candidates = [
        sweepPointAabb(
            origin,
            dir,
            new Rect(-(half.x + radius), -half.y, 2 * (half.x + radius), 2 * half.y),
        ),
        sweepPointAabb(
            origin,
            dir,
            new Rect(-half.x, -(half.y + radius), 2 * half.x, 2 * (half.y + radius)),
        ),
        sweepPointCircle(origin, dir, new Vec2(-half.x, -half.y), radius),
        sweepPointCircle(origin, dir, new Vec2(-half.x, half.y), radius),
        sweepPointCircle(origin, dir, new Vec2(half.x, -half.y), radius),
        sweepPointCircle(origin, dir, new Vec2(half.x, half.y), radius),
    ];

    let best: Hit | null = null;
    for (const hit of candidates) {
        if (hit && (!best || hit.t < best.t)) best = hit;
    }
    return best;
}

/** Swept box query against any collider. */
export function sweepAabbCollider(c: Collider, pos: Vec2, size: Vec2, vel: Vec2): Hit | null {
    return c.kind === 'aabb'
        ? sweepRect(pos, size, vel, c.rect)
        : sweepAabbCircle(pos, size, vel, c.center, c.radius);
}

/** Swept point query against any collider. */
export function sweepPointCollider(c: Collider, pos: Vec2, vel: Vec2): Hit | null {
    return c.kind === 'aabb'
        ? sweepPointAabb(pos, vel, c.rect)
        : sweepPointCircle(pos, vel, c.center, c.radius);
}

/**
 * Swept point against a collider **inflated by `r` with rounded corners**
 * (the Minkowski sum of the shape and a disk of radius `r`).
 *
 * This is how a rope point with thickness slides: on a flat face it keeps an
 * `r` standoff, and around a corner the contact normal rotates *continuously*
 * along the corner circle instead of flipping 90° between faces — which is
 * what lets a chain wrap and slide over multi-wall contacts at any angle
 * without snagging in the crease.
 */
export function sweepPointColliderRounded(c: Collider, pos: Vec2, vel: Vec2, r: number): Hit | null {
    if (r <= 0) return sweepPointCollider(c, pos, vel);
    if (c.kind === 'circle') return sweepPointCircle(pos, vel, c.center, c.radius + r);

    const rect = c.rect;
    const candidates = [
        // Faces: the rect expanded along each axis.
        sweepPointAabb(pos, vel, new Rect(rect.x - r, rect.y, rect.width + 2 * r, rect.height)),
        sweepPointAabb(pos, vel, new Rect(rect.x, rect.y - r, rect.width, rect.height + 2 * r)),
        // Corners: quarter circles of radius r.
        sweepPointCircle(pos, vel, new Vec2(rect.x, rect.y), r),
        sweepPointCircle(pos, vel, new Vec2(rect.right, rect.y), r),
        sweepPointCircle(pos, vel, new Vec2(rect.x, rect.bottom), r),
        sweepPointCircle(pos, vel, new Vec2(rect.right, rect.bottom), r),
    ];
    let best: Hit | null = null;
    for (const hit of candidates) {
        if (hit && (!best || hit.t < best.t)) best = hit;
    }
    return best;
}

/** Push a point out of a collider inflated by `r` (rounded), or `null`. */
function pushPointOutOfRounded(pos: Vec2, c: Collider, r: number): Vec2 | null {
    if (c.kind === 'circle') return pushPointOutOfCircle(pos, c.center, c.radius + r);
    if (r <= 0) return pushPointOutOfAabb(pos, c.rect);

    const rect = c.rect;
    const inside =
        pos.x > rect.x && pos.x < rect.right && pos.y > rect.y && pos.y < rect.bottom;
    if (inside) {
        // Deep inside: escape through the nearest face, plus the standoff.
        const dl = pos.x - rect.x;
        const dr = rect.right - pos.x;
        const dt = pos.y - rect.y;
        const db = rect.bottom - pos.y;
        const m = Math.min(dl, dr, dt, db);
        if (m === dl) return new Vec2(rect.x - r - 0.1, pos.y);
        if (m === dr) return new Vec2(rect.right + r + 0.1, pos.y);
        if (m === dt) return new Vec2(pos.x, rect.y - r - 0.1);
        return new Vec2(pos.x, rect.bottom + r + 0.1);
    }
    // Outside the rect but within the rounded margin: push radially from the
    // closest point on the rect.
    const closest = new Vec2(
        Math.min(Math.max(pos.x, rect.x), rect.right),
        Math.min(Math.max(pos.y, rect.y), rect.bottom),
    );
    const d = pos.sub(closest);
    const distSq = d.lengthSq();
    if (distSq >= r * r) return null;
    const n = distSq > 1e-12 ? d.scale(1 / Math.sqrt(distSq)) : Vec2.Y;
    return closest.add(n.scale(r + 0.1));
}

// ── Continuous AABB resolution (the player's movement phase) ─────────────────

/** Max slide iterations per movement step (corners a move can wrap around). */
const MAX_SLIDES = 4;
/**
 * Perpendicular clearance kept between a mover and a surface after contact so
 * the next sweep starts cleanly outside the surface's slab. Applied along the
 * *normal* (not the travel direction) so grazing contacts stay robust.
 */
const SKIN = 0.1;

/**
 * Move an axis-aligned box by `vel` against every collider using continuous
 * collision detection: sweep to the first time-of-impact, stop just short,
 * slide the remaining motion along the surface. Returns the final top-left.
 */
export function resolveAabb(pos: Vec2, size: Vec2, vel: Vec2, colliders: readonly Collider[]): Vec2 {
    let p = pos;
    let v = vel;
    for (let i = 0; i < MAX_SLIDES; i++) {
        if (v.lengthSq() < 1e-8) break;

        let tMin = 1;
        let normal = Vec2.ZERO;
        let hit = false;
        for (const c of colliders) {
            const h = sweepAabbCollider(c, p, size, v);
            if (h && h.t < tMin) {
                tMin = h.t;
                normal = h.normal;
                hit = true;
            }
        }

        if (!hit) {
            p = p.add(v);
            break;
        }

        // Orient the normal to oppose the motion, then advance to the contact
        // and lift off the surface by SKIN so the next sweep starts outside.
        const n = normal.dot(v) > 0 ? normal.neg() : normal;
        p = p.add(v.scale(tMin)).add(n.scale(SKIN));

        // Slide: drop the into-surface component of the remaining motion.
        const remaining = v.scale(1 - tMin);
        v = remaining.sub(n.scale(remaining.dot(n)));
    }
    return p;
}

// ── Static push-out (depenetration) ──────────────────────────────────────────

const PUSH_EPS = 0.1;

/** Push a point out of an AABB through the nearest face, or `null` if outside. */
export function pushPointOutOfAabb(pos: Vec2, rect: Rect): Vec2 | null {
    if (pos.x <= rect.x || pos.x >= rect.right || pos.y <= rect.y || pos.y >= rect.bottom) {
        return null;
    }
    const dl = pos.x - rect.x;
    const dr = rect.right - pos.x;
    const dt = pos.y - rect.y;
    const db = rect.bottom - pos.y;
    if (dl <= dr && dl <= dt && dl <= db) return new Vec2(rect.x - PUSH_EPS, pos.y);
    if (dr <= dl && dr <= dt && dr <= db) return new Vec2(rect.right + PUSH_EPS, pos.y);
    if (dt <= db) return new Vec2(pos.x, rect.y - PUSH_EPS);
    return new Vec2(pos.x, rect.bottom + PUSH_EPS);
}

/** Push a point radially out of a circle, or `null` if outside. */
export function pushPointOutOfCircle(pos: Vec2, center: Vec2, radius: number): Vec2 | null {
    const d = pos.sub(center);
    const distSq = d.lengthSq();
    if (distSq >= radius * radius) return null;
    const dist = Math.sqrt(distSq);
    const n = dist > 1e-6 ? d.scale(1 / dist) : Vec2.Y;
    return center.add(n.scale(radius + PUSH_EPS));
}

/**
 * Push a rectangle out of an AABB along the axis of least overlap. Returns
 * `[newPos, mtv]` or `null` when there is no overlap.
 */
export function pushRectOutOfAabb(pos: Vec2, size: Vec2, rect: Rect): [Vec2, Vec2] | null {
    const ox = Math.min(pos.x + size.x, rect.right) - Math.max(pos.x, rect.x);
    const oy = Math.min(pos.y + size.y, rect.bottom) - Math.max(pos.y, rect.y);
    if (ox <= 0 || oy <= 0) return null;
    let newPos: Vec2;
    if (ox < oy) {
        newPos =
            pos.x < rect.x
                ? new Vec2(rect.x - size.x - PUSH_EPS, pos.y)
                : new Vec2(rect.right + PUSH_EPS, pos.y);
    } else {
        newPos =
            pos.y < rect.y
                ? new Vec2(pos.x, rect.y - size.y - PUSH_EPS)
                : new Vec2(pos.x, rect.bottom + PUSH_EPS);
    }
    return [newPos, newPos.sub(pos)];
}

/** Push a rectangle out of a circle (closest-point push-out). */
export function pushRectOutOfCircle(
    pos: Vec2,
    size: Vec2,
    center: Vec2,
    radius: number,
): Vec2 | null {
    const cx = Math.min(Math.max(center.x, pos.x), pos.x + size.x);
    const cy = Math.min(Math.max(center.y, pos.y), pos.y + size.y);
    const d = new Vec2(cx, cy).sub(center);
    const distSq = d.lengthSq();
    if (distSq >= radius * radius) return null;
    if (distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const n = d.scale(1 / dist);
        return pos.add(n.scale(radius - dist + PUSH_EPS));
    }
    // Centre inside the rect: escape through the nearest edge.
    const dl = center.x - pos.x;
    const dr = pos.x + size.x - center.x;
    const dt = center.y - pos.y;
    const db = pos.y + size.y - center.y;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return pos.add(new Vec2(-(dl + radius + PUSH_EPS), 0));
    if (m === dr) return pos.add(new Vec2(dr + radius + PUSH_EPS, 0));
    if (m === dt) return pos.add(new Vec2(0, -(dt + radius + PUSH_EPS)));
    return pos.add(new Vec2(0, db + radius + PUSH_EPS));
}

/**
 * Static depenetration pass: nudge the box out of every collider it currently
 * overlaps. The continuous resolver keeps the box outside during motion, so
 * this only handles edge cases (spawning inside a shape, float drift).
 */
export function depenetrateAabb(pos: Vec2, size: Vec2, colliders: readonly Collider[]): Vec2 {
    let p = pos;
    for (const c of colliders) {
        if (c.kind === 'aabb') {
            const push = pushRectOutOfAabb(p, size, c.rect);
            if (push) p = push[0];
        } else {
            const push = pushRectOutOfCircle(p, size, c.center, c.radius);
            if (push) p = push;
        }
    }
    return p;
}

/** Static push-out of a point against a candidate slice (rounded by `radius`). */
export function pushPointOutOf(pos: Vec2, colliders: readonly Collider[], radius = 0): Vec2 {
    let p = pos;
    for (const c of colliders) {
        const pushed = pushPointOutOfRounded(p, c, radius);
        if (pushed) p = pushed;
    }
    return p;
}

// ── Swept point movement (the chain solver's primitive) ─────────────────────

/**
 * Move a point from `from` toward `to`, but never through any collider: on
 * contact it stops at the surface and slides the remaining motion along it
 * (up to 3 surfaces). Returns the final position and whether anything blocked
 * the move. Provided `from` is outside every collider, the result is too —
 * the invariant the chain solver relies on to make joint teleporting
 * impossible.
 */
export function movePointSwept(
    from: Vec2,
    to: Vec2,
    colliders: readonly Collider[],
    radius = 0,
): { pos: Vec2; hit: boolean } {
    const POINT_SKIN = 0.02;
    let pos = from;
    let vel = to.sub(from);
    let hit = false;

    for (let i = 0; i < 4; i++) {
        if (vel.lengthSq() < 1e-10) break;
        let tMin = 1;
        let normal = Vec2.ZERO;
        for (const c of colliders) {
            const h = sweepPointColliderRounded(c, pos, vel, radius);
            if (h && h.t < tMin) {
                tMin = h.t;
                normal = h.normal;
            }
        }
        pos = pos.add(vel.scale(tMin));
        if (tMin < 1) {
            hit = true;
            pos = pos.add(normal.scale(POINT_SKIN));
            const remaining = vel.scale(1 - tMin);
            vel = remaining.sub(normal.scale(remaining.dot(normal)));
        } else {
            break;
        }
    }
    return { pos, hit };
}

// ── Spatial hash grid (broad phase over the static world) ───────────────────

/**
 * A uniform grid spatial index over a fixed snapshot of colliders. Built once
 * at level load (the static world never changes at runtime) and queried with
 * a reusable output buffer; per-query de-duplication uses a generation stamp,
 * so queries allocate nothing.
 */
export class ColliderGrid {
    private readonly cellSize: number;
    private readonly originX: number;
    private readonly originY: number;
    private readonly cols: number;
    private readonly rows: number;
    /** Per cell, indices into `colliders`. */
    private readonly cells: number[][];
    private readonly colliders: Collider[];
    private readonly lastQuery: Uint32Array;
    private queryId = 0;

    constructor(colliders: readonly Collider[], cellSize = 128) {
        this.colliders = [...colliders];
        this.cellSize = cellSize;
        this.lastQuery = new Uint32Array(this.colliders.length);

        if (this.colliders.length === 0) {
            this.originX = 0;
            this.originY = 0;
            this.cols = 1;
            this.rows = 1;
            this.cells = [[]];
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const c of this.colliders) {
            const b = colliderBounds(c);
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.right);
            maxY = Math.max(maxY, b.bottom);
        }
        this.originX = minX;
        this.originY = minY;
        this.cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
        this.rows = Math.max(1, Math.ceil((maxY - minY) / cellSize));
        this.cells = Array.from({ length: this.cols * this.rows }, () => []);

        for (let i = 0; i < this.colliders.length; i++) {
            this.forEachCell(colliderBounds(this.colliders[i]), (cell) => cell.push(i));
        }
    }

    get isEmpty(): boolean {
        return this.colliders.length === 0;
    }

    /**
     * Append every collider whose bounds intersect `area` to `out` (which is
     * not cleared, so callers can reuse a buffer). Each collider is returned
     * at most once per query.
     */
    query(area: Rect, out: Collider[]): void {
        if (this.colliders.length === 0) return;
        this.queryId++;
        this.forEachCell(area, (cell) => {
            for (const idx of cell) {
                if (this.lastQuery[idx] === this.queryId) continue;
                this.lastQuery[idx] = this.queryId;
                const c = this.colliders[idx];
                if (colliderBounds(c).intersects(area)) out.push(c);
            }
        });
    }

    private forEachCell(area: Rect, fn: (cell: number[]) => void): void {
        const x0 = Math.max(0, Math.floor((area.x - this.originX) / this.cellSize));
        const y0 = Math.max(0, Math.floor((area.y - this.originY) / this.cellSize));
        const x1 = Math.min(this.cols - 1, Math.floor((area.right - this.originX) / this.cellSize));
        const y1 = Math.min(this.rows - 1, Math.floor((area.bottom - this.originY) / this.cellSize));
        for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) {
                fn(this.cells[gy * this.cols + gx]);
            }
        }
    }
}

/** Circle containment helper shared by portals and squeezables. */
export function circleContains(circle: Circle, p: Vec2): boolean {
    return circle.containsPoint(p);
}
