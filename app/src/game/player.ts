import { Rect, Vec2 } from '../engine/math';
import { Animation, SpriteSheet } from '../engine/sprite-sheet';
import { Input } from '../engine/input';

/** Row indices into the ducky sprite sheet (each row is one state). */
const ANIM_IDLE = 0;
const ANIM_WALK = 1;

/** How fast the player gathers speed toward the input direction (px/s²). */
const ACCELERATION = 1100;
/** How fast the player coasts to a stop when there is no input (px/s²). */
const FRICTION = 3200;
/** Below this speed (px/s) the player is treated as idle (animation/facing). */
const MOVING_EPS = 1;
/** Maximum movement speed in px/s. */
const MAX_SPEED = 300;

export class Player {
    pos = new Vec2();
    /** Collision hit-box size (slightly smaller than the 32×32 sprite). */
    readonly shape = new Vec2(28, 28);
    velocity = new Vec2();
    /** Where the chain attaches, as an offset from the top-left `pos`. */
    readonly chainOffset = new Vec2(16, 16);
    /** Unlockable interactions with movable boxes. */
    readonly abilities = { push: true, pull: true };

    private readonly anim: Animation;
    private facingLeft = false;

    constructor(private readonly sheet: SpriteSheet) {
        this.anim = new Animation(sheet, ANIM_IDLE, 10, true);
    }

    /**
     * Read WASD / arrow input and integrate `velocity` from it: acceleration
     * toward the input while keys are held, friction to a stop otherwise,
     * clamped to `MAX_SPEED`. Also drives the walk/idle animation and facing.
     */
    integrateInput(input: Input, dt: number): void {
        let dir = new Vec2();
        if (input.isDown('KeyW') || input.isDown('ArrowUp')) dir.y -= 1;
        if (input.isDown('KeyS') || input.isDown('ArrowDown')) dir.y += 1;
        if (input.isDown('KeyA') || input.isDown('ArrowLeft')) dir.x -= 1;
        if (input.isDown('KeyD') || input.isDown('ArrowRight')) dir.x += 1;
        dir = dir.normalize();

        if (dir.lengthSq() > 0) {
            this.velocity = this.velocity.add(dir.scale(ACCELERATION * dt));
            const speed = this.velocity.length();
            if (speed > MAX_SPEED) this.velocity = this.velocity.scale(MAX_SPEED / speed);
        } else {
            const speed = this.velocity.length();
            const drop = FRICTION * dt;
            this.velocity =
                drop >= speed ? new Vec2() : this.velocity.scale((speed - drop) / speed);
        }

        // Walk while actually moving (keeps walking while decelerating), idle
        // once stopped; face the last horizontal direction travelled.
        const moving = this.velocity.lengthSq() > MOVING_EPS * MOVING_EPS;
        this.anim.setState(moving ? ANIM_WALK : ANIM_IDLE);
        if (this.velocity.x < -MOVING_EPS) this.facingLeft = true;
        else if (this.velocity.x > MOVING_EPS) this.facingLeft = false;
        this.anim.update(dt);
    }

    /** The player's world-space collision hit-box. */
    collider(): Rect {
        return new Rect(this.pos.x, this.pos.y, this.shape.x, this.shape.y);
    }

    /** World-space point where the chains attach to the player. */
    chainPoint(): Vec2 {
        return this.pos.add(this.chainOffset);
    }

    /** Smaller drawn sprite dimension in world px (used by the Y-sort). */
    spriteMinDim(): number {
        return Math.min(this.sheet.frameW, this.sheet.frameH);
    }

    draw(ctx: CanvasRenderingContext2D): void {
        // Centre the 32×32 sprite on the 28×28 hit box.
        const spriteSize = this.anim.frameSize();
        const drawPos = this.pos.add(this.shape.sub(spriteSize).scale(0.5));
        this.anim.draw(ctx, drawPos, 1, { flipX: this.facingLeft });
    }
}
