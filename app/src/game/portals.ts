import { Circle, Vec2 } from '../engine/math';
import { Animation, SpriteSheet } from '../engine/sprite-sheet';

/**
 * World-level portal system. Portals are placed by the player (Space) and
 * come in pairs: stepping into one circle teleports to its partner. The world
 * can hold any number of completed pairs.
 *
 * Rendered with the sprite-sheet animation system: opening when placed, a
 * looping idle spin while active, closing on level reset. Each pair carries a
 * small coloured side ball so pairs are easy to tell apart.
 */

const PORTAL_RADIUS = 30;
const PORTAL_FRAME_SIZE = 64;
const PORTAL_FPS = 10;
const ROW_IDLE = 0;
const ROW_OPENING = 1;
const ROW_CLOSING = 2;
const PAIR_BALL_RADIUS = 1.5;
const PAIR_BALL_OFFSET = new Vec2(0.75, -0.75);

const PAIR_COLORS = [
    '#e62937',
    '#66bfff',
    '#fdf900',
    '#009e2f',
    '#ff6dc2',
    '#ffa100',
    '#873cbe',
    '#00752c',
    '#7f6a4f',
    '#701f7e',
];

type PortalState = 'opening' | 'idle' | 'closing';

class PortalInstance {
    anim: Animation;
    state: PortalState = 'opening';

    constructor(
        readonly circle: Circle,
        private readonly sheet: SpriteSheet,
    ) {
        this.anim = new Animation(sheet, ROW_OPENING, PORTAL_FPS, false);
    }

    startClosing(): void {
        if (this.state === 'closing') return;
        this.state = 'closing';
        this.anim = new Animation(this.sheet, ROW_CLOSING, PORTAL_FPS, false);
    }

    update(dt: number): void {
        this.anim.update(dt);
        if (this.state === 'opening' && this.anim.isFinished()) {
            this.state = 'idle';
            this.anim = new Animation(this.sheet, ROW_IDLE, PORTAL_FPS, true);
        }
    }

    isClosed(): boolean {
        return this.state === 'closing' && this.anim.isFinished();
    }
}

interface PortalPair {
    a: PortalInstance;
    b: PortalInstance;
    color: string;
}

export class Portals {
    private pairs: PortalPair[] = [];
    /** First circle of a pair, placed but not yet paired. */
    private pending: PortalInstance | null = null;

    constructor(
        private readonly purpleSheet: SpriteSheet,
        private readonly greenSheet: SpriteSheet,
    ) {}

    /**
     * Place a portal at `center`. The first placement is held pending; the
     * second completes a pair, retained alongside any earlier pairs.
     */
    place(center: Vec2): void {
        const circle = new Circle(center.clone(), PORTAL_RADIUS);
        const sheet = this.pending ? this.greenSheet : this.purpleSheet;
        const instance = new PortalInstance(circle, sheet);
        if (!this.pending) {
            this.pending = instance;
        } else {
            const color = PAIR_COLORS[this.pairs.length % PAIR_COLORS.length];
            this.pairs.push({ a: this.pending, b: instance, color });
            this.pending = null;
        }
    }

    update(dt: number): void {
        for (const pair of this.pairs) {
            pair.a.update(dt);
            pair.b.update(dt);
        }
        this.pending?.update(dt);

        this.pairs = this.pairs.filter((p) => !(p.a.isClosed() && p.b.isClosed()));
        if (this.pending?.isClosed()) this.pending = null;
    }

    /** Begin the closing animation on every live portal. */
    startClosingAll(): void {
        for (const pair of this.pairs) {
            pair.a.startClosing();
            pair.b.startClosing();
        }
        this.pending?.startClosing();
    }

    /** True when every portal has finished closing (or there are none). */
    isFinishedClosing(): boolean {
        return (
            this.pairs.every((p) => p.a.isClosed() && p.b.isClosed()) &&
            (this.pending === null || this.pending.isClosed())
        );
    }

    /**
     * If `point` is inside some portal circle (other than `exclude`, the one
     * the player just exited), return the entry circle and its partner.
     * Closing portals are ignored.
     */
    findEntry(point: Vec2, exclude: Circle | null): { entry: Circle; exit: Circle } | null {
        for (const pair of this.pairs) {
            const combos: [PortalInstance, PortalInstance][] = [
                [pair.a, pair.b],
                [pair.b, pair.a],
            ];
            for (const [entry, exit] of combos) {
                if (entry.state === 'closing') continue;
                if (exclude && entry.circle.equals(exclude)) continue;
                if (entry.circle.containsPoint(point)) {
                    return { entry: entry.circle, exit: exit.circle };
                }
            }
        }
        return null;
    }

    draw(ctx: CanvasRenderingContext2D): void {
        for (const pair of this.pairs) {
            drawInstance(ctx, pair.a);
            drawInstance(ctx, pair.b);
            drawPairBall(ctx, pair.a.circle.center, pair.color);
            drawPairBall(ctx, pair.b.circle.center, pair.color);
        }
        if (this.pending) {
            drawInstance(ctx, this.pending);
            drawPairBall(ctx, this.pending.circle.center, '#c8c8c8');
        }
    }
}

function drawInstance(ctx: CanvasRenderingContext2D, instance: PortalInstance): void {
    const scale = (instance.circle.radius * 2) / PORTAL_FRAME_SIZE;
    const pos = instance.circle.center.sub(new Vec2(instance.circle.radius, instance.circle.radius));
    instance.anim.draw(ctx, pos, scale, { alpha: instance.state === 'closing' ? 0.6 : 1 });
}

function drawPairBall(ctx: CanvasRenderingContext2D, center: Vec2, color: string): void {
    const offset = PAIR_BALL_OFFSET.scale(PORTAL_RADIUS);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(center.x + offset.x, center.y + offset.y, PAIR_BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
}
