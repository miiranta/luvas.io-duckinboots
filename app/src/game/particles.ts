import { Vec2 } from '../engine/math';

interface Particle {
    pos: Vec2;
    vel: Vec2;
    life: number;
    maxLife: number;
    size: number;
    color: string;
    /** Fraction of velocity kept per second (0..1). */
    drag: number;
}

/**
 * A tiny world-space particle system: short-lived circles with velocity,
 * drag and alpha fade-out. Used for squeeze bursts, portal sparkles and
 * footstep dust. Deliberately simple — everything is one array and one draw
 * pass; heavier effects belong in the shader layer.
 */
export class Particles {
    private items: Particle[] = [];

    /** Radial burst, e.g. a squeezable popping. */
    burst(center: Vec2, colors: readonly string[], count: number, speed: number, life = 0.6): void {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const v = speed * (0.35 + Math.random() * 0.65);
            this.items.push({
                pos: center.clone(),
                vel: new Vec2(Math.cos(angle) * v, Math.sin(angle) * v),
                life: life * (0.6 + Math.random() * 0.4),
                maxLife: life,
                size: 1.5 + Math.random() * 2.5,
                color: colors[Math.floor(Math.random() * colors.length)],
                drag: 0.02,
            });
        }
    }

    /** A single soft sparkle, e.g. shimmering on an idle portal's ring. */
    sparkle(pos: Vec2, color: string): void {
        this.items.push({
            pos: pos.clone(),
            vel: new Vec2((Math.random() - 0.5) * 8, -6 - Math.random() * 10),
            life: 0.5 + Math.random() * 0.4,
            maxLife: 0.9,
            size: 0.8 + Math.random() * 1.2,
            color,
            drag: 0.3,
        });
    }

    /** Ground dust kicked up by the player's feet. */
    dust(pos: Vec2, dir: Vec2): void {
        this.items.push({
            pos: pos.add(new Vec2((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 2)),
            vel: dir.scale(-14).add(new Vec2((Math.random() - 0.5) * 12, -4 - Math.random() * 6)),
            life: 0.3 + Math.random() * 0.25,
            maxLife: 0.55,
            size: 1 + Math.random() * 1.6,
            color: 'rgb(214 202 158)',
            drag: 0.05,
        });
    }

    update(dt: number): void {
        let write = 0;
        for (const p of this.items) {
            p.life -= dt;
            if (p.life <= 0) continue;
            p.pos = p.pos.add(p.vel.scale(dt));
            p.vel = p.vel.scale(Math.pow(p.drag, dt));
            this.items[write++] = p;
        }
        this.items.length = write;
    }

    /**
     * Pixel-art rendering: each particle is a square snapped to the world
     * pixel grid, with its alpha quantized to a few levels so the fade reads
     * as discrete pixel steps rather than a smooth dissolve.
     */
    draw(ctx: CanvasRenderingContext2D): void {
        if (this.items.length === 0) return;
        ctx.save();
        for (const p of this.items) {
            const a = Math.min(1, (p.life / p.maxLife) * 1.4);
            ctx.globalAlpha = Math.ceil(a * 4) / 4;
            ctx.fillStyle = p.color;
            const s = Math.max(1, Math.round(p.size));
            ctx.fillRect(Math.floor(p.pos.x - s / 2), Math.floor(p.pos.y - s / 2), s, s);
        }
        ctx.restore();
    }
}
