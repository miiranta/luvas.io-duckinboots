import { Vec2 } from '../engine/math';
import { Chain } from './chain';
import { Collider, circleCollider } from './collision';

/**
 * Squeezable objects: round things a chain can lasso. When a chain winds a
 * full loop around one and cinches it tight, the object is crushed and every
 * registered listener is notified.
 */

export interface SqueezeEvent {
    id: number;
    /** Level collider id this squeezable was spawned from (rules target it). */
    colliderId: string;
    group?: string;
    pos: Vec2;
    radius: number;
}

interface Squeezable {
    id: number;
    colliderId: string;
    /** Multi-squeeze group: every alive member must be cinched at once. */
    group?: string;
    pos: Vec2;
    /** Spawn position, restored on revive. */
    origin: Vec2;
    radius: number;
    alive: boolean;
}

// ── Tuning ───────────────────────────────────────────────────────────────────

/** A squeeze needs at least one full revolution of winding. */
const FULL_LOOP_TURNS = 1.0;
/** Inner/outer radius factors for joints that belong to the loop. */
const LOOP_INNER_FACTOR = 0.95;
const LOOP_OUTER_FACTOR = 1.1;
/** Max allowed area difference between the chain loop and the object. */
const MAX_AREA_DIFF_RATIO = 0.07;
/** Minimum overall chain stretch — proves the loop is being pulled tight. */
const MIN_CHAIN_STRETCH = 0.999;

export class Squeezables {
    private items: Squeezable[] = [];
    private listeners: ((ev: SqueezeEvent) => void)[] = [];
    private nextId = 0;

    spawn(pos: Vec2, radius: number, colliderId = '', group?: string): number {
        const id = this.nextId++;
        this.items.push({
            id,
            colliderId,
            group,
            pos: pos.clone(),
            origin: pos.clone(),
            radius,
            alive: true,
        });
        return id;
    }

    onSqueeze(listener: (ev: SqueezeEvent) => void): void {
        this.listeners.push(listener);
    }

    /** Revive every object at its spawn position (fresh run). Listeners are kept. */
    reviveAll(): void {
        for (const s of this.items) {
            s.alive = true;
            s.pos = s.origin.clone();
        }
    }

    /** Centre of the object at `index` (regardless of alive state). */
    centerOf(index: number): Vec2 {
        return this.items[index].pos;
    }

    isAlive(index: number): boolean {
        return this.items[index]?.alive ?? false;
    }

    get aliveCount(): number {
        return this.items.filter((s) => s.alive).length;
    }

    get totalCount(): number {
        return this.items.length;
    }

    /**
     * Append a **circle** collider for each living object, so the chain hugs
     * the round shape (the original used the bounding box, which made chains
     * wrap a square and the tight-loop squeeze test nearly impossible).
     */
    extendColliders(out: Collider[]): void {
        for (const s of this.items) {
            if (s.alive) out.push(circleCollider(s.pos.clone(), s.radius));
        }
    }

    /** `(index, center, radius)` of each living object. */
    eachAlive(): { index: number; center: Vec2; radius: number }[] {
        return this.items
            .map((s, index) => ({ index, center: s.pos, radius: s.radius, alive: s.alive }))
            .filter((s) => s.alive);
    }

    /** Translate the living object at `index` by `delta`. */
    translate(index: number, delta: Vec2): void {
        const s = this.items[index];
        if (s?.alive) s.pos = s.pos.add(delta);
    }

    /**
     * Check every living object against every rope span; crush the ones a
     * chain has looped tight and fire the listeners. Grouped objects only
     * die when **every alive member of the group is cinched in the same
     * frame** (the multi-squeeze mechanic). Call once per frame after the
     * chains have been simulated.
     */
    update(chains: readonly Chain[]): void {
        const cinched = new Set<Squeezable>();
        for (const s of this.items) {
            if (!s.alive) continue;
            const hit = chains.some((chain) => {
                const stretch = chain.stretch();
                return chain.spanPoints().some((pts) => spanCinches(pts, stretch, s.pos, s.radius));
            });
            if (hit) cinched.add(s);
        }

        const crushed: SqueezeEvent[] = [];
        for (const s of cinched) {
            if (s.group) {
                const members = this.items.filter((o) => o.alive && o.group === s.group);
                if (!members.every((o) => cinched.has(o))) continue;
            }
            s.alive = false;
            crushed.push({
                id: s.id,
                colliderId: s.colliderId,
                group: s.group,
                pos: s.pos,
                radius: s.radius,
            });
        }
        for (const ev of crushed) {
            for (const listener of this.listeners) listener(ev);
        }
    }

    /** True when the collider id / group name has been fully squeezed. */
    allSqueezedFor(target: string): boolean {
        const members = this.items.filter(
            (s) => s.colliderId === target || s.group === target,
        );
        return members.length > 0 && members.every((s) => !s.alive);
    }

    /** Draw one living object (used by the world's Y-sort). */
    drawItem(ctx: CanvasRenderingContext2D, index: number): void {
        const s = this.items[index];
        if (!s?.alive) return;
        ctx.fillStyle = '#f5008c';
        ctx.beginPath();
        ctx.arc(s.pos.x, s.pos.y, s.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff8fc8';
        ctx.beginPath();
        ctx.arc(s.pos.x, s.pos.y, s.radius * 0.7, 0, Math.PI * 2);
        ctx.fill();
    }
}

/**
 * Does a rope span wind a full, tight loop around the circle at `center`?
 * Three conditions must hold together:
 * 1. **Winding** — the path's radial vector sweeps ≥ one full turn;
 * 2. **Tight loop** — the polygon area of joints hugging the object is close
 *    to the object's own area;
 * 3. **Force** — the whole rope is stretched (pulled tight, not draped).
 */
function spanCinches(
    points: readonly Vec2[],
    stretch: number,
    center: Vec2,
    radius: number,
): boolean {
    const inner = radius * LOOP_INNER_FACTOR;
    const outer = radius * LOOP_OUTER_FACTOR;
    let winding = 0;
    const loopPoints: Vec2[] = [];
    let prev: Vec2 | null = null;

    for (const p of points) {
        const v = p.sub(center);
        const dist = v.length();
        if (dist >= inner && dist <= outer) loopPoints.push(p);
        if (prev) winding += Math.atan2(prev.cross(v), prev.dot(v));
        prev = v;
    }

    if (loopPoints.length < 3) return false;

    const loopArea = loopPolygonArea(loopPoints, center);
    const circleArea = Math.PI * radius * radius;
    const areaDiffRatio = Math.abs(loopArea - circleArea) / circleArea;

    return (
        Math.abs(winding) / (Math.PI * 2) >= FULL_LOOP_TURNS &&
        areaDiffRatio <= MAX_AREA_DIFF_RATIO &&
        stretch >= MIN_CHAIN_STRETCH
    );
}

/** Area of the polygon formed by sorting loop points by angle around `center`. */
function loopPolygonArea(points: Vec2[], center: Vec2): number {
    if (points.length < 3) return 0;
    const ordered = [...points].sort(
        (a, b) => a.sub(center).angle() - b.sub(center).angle(),
    );
    let sum = 0;
    for (let i = 0; i < ordered.length; i++) {
        const j = (i + 1) % ordered.length;
        sum += ordered[i].x * ordered[j].y - ordered[j].x * ordered[i].y;
    }
    return Math.abs(sum) / 2;
}
