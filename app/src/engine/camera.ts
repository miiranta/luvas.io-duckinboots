import { Vec2 } from './math';

/**
 * A 2D camera: world-space `target` is drawn at screen-space `offset`, scaled
 * by `zoom`. The design zoom is authored against a 720px-tall reference view,
 * so the world looks identical at any canvas resolution.
 */
export class Camera2D {
    target = new Vec2();
    offset = new Vec2();
    zoom = 1;

    /** Reference viewport height the zoom values are authored against. */
    static readonly REFERENCE_HEIGHT = 720;

    /** Effective scale for a canvas of the given pixel height. */
    effectiveZoom(canvasHeight: number): number {
        return this.zoom * (canvasHeight / Camera2D.REFERENCE_HEIGHT);
    }

    /** Push the camera transform onto `ctx` (pair with `ctx.restore()`). */
    apply(ctx: CanvasRenderingContext2D, canvasHeight: number): void {
        const scale = this.effectiveZoom(canvasHeight);
        ctx.save();
        ctx.translate(this.offset.x, this.offset.y);
        ctx.scale(scale, scale);
        ctx.translate(-this.target.x, -this.target.y);
    }
}
