import { Rect, Vec2 } from '../engine/math';
import { Chain } from './chain';
import { Collider, aabb } from './collision';

/**
 * Squeezable objects: round things a chain can lasso. When a chain winds a
 * full loop around one and cinches it tight, the object is crushed and every
 * registered listener is notified.
 */

export interface SqueezeEvent {
    id: number;
    pos: Vec2;
    radius: number;
}

interface Squeezable {
    id: number;
    pos: Vec2;
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

    spawn(pos: Vec2, radius: number): number {
        const id = this.nextId++;
        this.items.push({ id, pos: pos.clone(), radius, alive: true });
        return id;
    }

    onSqueeze(listener: (ev: SqueezeEvent) => void): void {
        this.listeners.push(listener);
    }

    /** Bring every object back to life (fresh run). Listeners are kept. */
    reviveAll(): void {
        for (const s of this.items) s.alive = true;
    }

    get aliveCount(): number {
        return this.items.filter((s) => s.alive).length;
    }

    get totalCount(): number {
        return this.items.length;
    }

    /** Append an AABB collider for each living object. */
    extendColliders(out: Collider[]): void {
        for (const s of this.items) {
            if (s.alive) out.push(aabb(boundsOf(s.pos, s.radius)));
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
     * Check every living object against every chain snippet; crush the ones a
     * chain has looped tight and fire the listeners. Call once per frame after
     * the chains have been simulated.
     */
    update(chains: readonly Chain[]): void {
        const crushed: SqueezeEvent[] = [];
        for (const s of this.items) {
            if (!s.alive) continue;
            if (chains.some((c) => chainCinches(c, s.pos, s.radius))) {
                s.alive = false;
                crushed.push({ id: s.id, pos: s.pos, radius: s.radius });
            }
        }
        for (const ev of crushed) {
            for (const listener of this.listeners) listener(ev);
        }
    }

    draw(ctx: CanvasRenderingContext2D): void {
        for (const s of this.items) {
            if (!s.alive) continue;
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
}

function boundsOf(center: Vec2, radius: number): Rect {
    return new Rect(center.x - radius, center.y - radius, radius * 2, radius * 2);
}

/**
 * Does `chain` wind a full, tight loop around the circle at `center`?
 * Three conditions must hold together:
 * 1. **Winding** — the path's radial vector sweeps ≥ one full turn;
 * 2. **Tight loop** — the polygon area of joints hugging the object is close
 *    to the object's own area;
 * 3. **Force** — the overall chain is stretched (pulled tight, not draped).
 */
function chainCinches(chain: Chain, center: Vec2, radius: number): boolean {
    const inner = radius * LOOP_INNER_FACTOR;
    const outer = radius * LOOP_OUTER_FACTOR;
    let winding = 0;
    const loopPoints: Vec2[] = [];
    let prev: Vec2 | null = null;

    for (const p of chain.jointPositions()) {
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
        chain.stretch() >= MIN_CHAIN_STRETCH
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
