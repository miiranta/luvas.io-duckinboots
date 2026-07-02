import { Vec2 } from './math';

/**
 * Keyboard + mouse state, sampled by the fixed-update loop.
 *
 * `isDown` reflects the live key state; `wasPressed` is an edge trigger that
 * stays true until [`endStep`] is called at the end of a fixed update, so a
 * key press is seen by exactly one simulation step.
 */
export class Input {
    private readonly down = new Set<string>();
    private readonly pressed = new Set<string>();
    private wheelDelta = 0;
    mouse = new Vec2();

    private readonly onKeyDown: EventListener = (e) => {
        const ev = e as KeyboardEvent;
        if (ev.repeat) return;
        this.down.add(ev.code);
        this.pressed.add(ev.code);
    };
    private readonly onKeyUp: EventListener = (e) => {
        this.down.delete((e as KeyboardEvent).code);
    };
    private readonly onWheel: EventListener = (e) => {
        this.wheelDelta += Math.sign(-(e as WheelEvent).deltaY);
    };
    private readonly onMouseMove: EventListener = (e) => {
        const ev = e as MouseEvent;
        this.mouse = new Vec2(ev.clientX, ev.clientY);
    };
    private readonly onBlur = () => this.down.clear();

    attach(target: HTMLElement | Window = window): void {
        target.addEventListener('keydown', this.onKeyDown);
        target.addEventListener('keyup', this.onKeyUp);
        target.addEventListener('wheel', this.onWheel, { passive: true });
        target.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('blur', this.onBlur);
    }

    detach(target: HTMLElement | Window = window): void {
        target.removeEventListener('keydown', this.onKeyDown);
        target.removeEventListener('keyup', this.onKeyUp);
        target.removeEventListener('wheel', this.onWheel);
        target.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('blur', this.onBlur);
    }

    /** Live state of a key (`KeyboardEvent.code`, e.g. `'KeyW'`). */
    isDown(code: string): boolean {
        return this.down.has(code);
    }

    /** True once per key press, consumed at the end of the update step. */
    wasPressed(code: string): boolean {
        return this.pressed.has(code);
    }

    /** Accumulated wheel steps since the last update (+up / −down). */
    wheelMove(): number {
        return this.wheelDelta;
    }

    /** Clear the per-step edge triggers. Call once at the end of each update. */
    endStep(): void {
        this.pressed.clear();
        this.wheelDelta = 0;
    }
}
