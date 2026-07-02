/**
 * Minimal 2D math toolkit used by the engine and the game.
 *
 * `Vec2` is immutable-by-convention: every operation returns a new vector.
 * The physics hot paths allocate short-lived vectors freely — modern JS
 * engines handle this well and the clarity is worth far more than the
 * micro-optimisation of in-place mutation.
 */

export class Vec2 {
    constructor(
        public x = 0,
        public y = 0,
    ) {}

    static readonly ZERO = new Vec2(0, 0);
    static readonly X = new Vec2(1, 0);
    static readonly Y = new Vec2(0, 1);

    clone(): Vec2 {
        return new Vec2(this.x, this.y);
    }

    add(v: Vec2): Vec2 {
        return new Vec2(this.x + v.x, this.y + v.y);
    }

    sub(v: Vec2): Vec2 {
        return new Vec2(this.x - v.x, this.y - v.y);
    }

    scale(s: number): Vec2 {
        return new Vec2(this.x * s, this.y * s);
    }

    neg(): Vec2 {
        return new Vec2(-this.x, -this.y);
    }

    dot(v: Vec2): number {
        return this.x * v.x + this.y * v.y;
    }

    /** 2D cross product (z component of the 3D cross). */
    cross(v: Vec2): number {
        return this.x * v.y - this.y * v.x;
    }

    length(): number {
        return Math.hypot(this.x, this.y);
    }

    lengthSq(): number {
        return this.x * this.x + this.y * this.y;
    }

    distance(v: Vec2): number {
        return Math.hypot(this.x - v.x, this.y - v.y);
    }

    distanceSq(v: Vec2): number {
        const dx = this.x - v.x;
        const dy = this.y - v.y;
        return dx * dx + dy * dy;
    }

    /** Unit vector, or `fallback` (default zero) when the length is ~0. */
    normalize(fallback: Vec2 = Vec2.ZERO): Vec2 {
        const len = this.length();
        return len > 1e-8 ? new Vec2(this.x / len, this.y / len) : fallback.clone();
    }

    lerp(v: Vec2, t: number): Vec2 {
        return new Vec2(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t);
    }

    min(v: Vec2): Vec2 {
        return new Vec2(Math.min(this.x, v.x), Math.min(this.y, v.y));
    }

    max(v: Vec2): Vec2 {
        return new Vec2(Math.max(this.x, v.x), Math.max(this.y, v.y));
    }

    equals(v: Vec2): boolean {
        return this.x === v.x && this.y === v.y;
    }

    /** Angle of the vector in radians (atan2 convention). */
    angle(): number {
        return Math.atan2(this.y, this.x);
    }
}

export class Rect {
    constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
    ) {}

    get right(): number {
        return this.x + this.width;
    }

    get bottom(): number {
        return this.y + this.height;
    }

    position(): Vec2 {
        return new Vec2(this.x, this.y);
    }

    size(): Vec2 {
        return new Vec2(this.width, this.height);
    }

    center(): Vec2 {
        return new Vec2(this.x + this.width / 2, this.y + this.height / 2);
    }

    clone(): Rect {
        return new Rect(this.x, this.y, this.width, this.height);
    }

    translate(d: Vec2): Rect {
        return new Rect(this.x + d.x, this.y + d.y, this.width, this.height);
    }

    /** Strict overlap test (shared edges do not count as intersecting). */
    intersects(o: Rect): boolean {
        return this.x < o.right && this.right > o.x && this.y < o.bottom && this.bottom > o.y;
    }

    containsPoint(p: Vec2): boolean {
        return p.x >= this.x && p.x <= this.right && p.y >= this.y && p.y <= this.bottom;
    }

    /** Area of the overlap between two rectangles (0 when disjoint). */
    intersectionArea(o: Rect): number {
        const w = Math.min(this.right, o.right) - Math.max(this.x, o.x);
        const h = Math.min(this.bottom, o.bottom) - Math.max(this.y, o.y);
        return w > 0 && h > 0 ? w * h : 0;
    }

    /** Smallest rect containing both. */
    union(o: Rect): Rect {
        const x = Math.min(this.x, o.x);
        const y = Math.min(this.y, o.y);
        return new Rect(x, y, Math.max(this.right, o.right) - x, Math.max(this.bottom, o.bottom) - y);
    }

    grow(margin: number): Rect {
        return new Rect(this.x - margin, this.y - margin, this.width + 2 * margin, this.height + 2 * margin);
    }

    static fromPoints(a: Vec2, b: Vec2): Rect {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return new Rect(x, y, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }
}

export class Circle {
    constructor(
        public center: Vec2,
        public radius: number,
    ) {}

    containsPoint(p: Vec2): boolean {
        return this.center.distanceSq(p) <= this.radius * this.radius;
    }

    equals(o: Circle): boolean {
        return this.center.equals(o.center) && this.radius === o.radius;
    }
}

export function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
}
