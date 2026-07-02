/**
 * Fixed-timestep game loop driven by `requestAnimationFrame`.
 *
 * Updates run at a constant rate (`ups`) through an accumulator, so the
 * simulation is deterministic regardless of display refresh rate. A
 * max-frame-time clamp avoids the "spiral of death" after a stall (tab in
 * background, long GC pause).
 */
export class GameLoop {
    /** Seconds per fixed update step. */
    readonly dt: number;

    private rafId = 0;
    private lastTime = 0;
    private accumulator = 0;
    private running = false;

    // FPS sampling.
    private frames = 0;
    private fpsTimer = 0;
    fps = 0;

    private static readonly MAX_FRAME_TIME = 0.25;

    constructor(
        ups: number,
        private readonly update: (dt: number) => void,
        private readonly render: () => void,
    ) {
        this.dt = 1 / ups;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.lastTime = performance.now();
        this.accumulator = 0;
        const tick = (now: number) => {
            if (!this.running) return;
            let frame = (now - this.lastTime) / 1000;
            this.lastTime = now;
            if (frame > GameLoop.MAX_FRAME_TIME) frame = GameLoop.MAX_FRAME_TIME;

            this.frames++;
            this.fpsTimer += frame;
            if (this.fpsTimer >= 0.5) {
                this.fps = Math.round(this.frames / this.fpsTimer);
                this.frames = 0;
                this.fpsTimer = 0;
            }

            this.accumulator += frame;
            while (this.accumulator >= this.dt) {
                this.update(this.dt);
                this.accumulator -= this.dt;
            }
            this.render();
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    stop(): void {
        this.running = false;
        cancelAnimationFrame(this.rafId);
    }
}
