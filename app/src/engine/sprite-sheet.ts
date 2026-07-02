import { Vec2 } from './math';

/**
 * A texture cut into a uniform grid of `frameW × frameH` cells.
 *
 * Each **row is a state** (e.g. row 0 = idle, row 1 = walk) and each column a
 * step in time. Rows need not be full: empty cells are detected once at load
 * time (any pixel with non-zero alpha counts) and skipped during playback.
 */
export class SpriteSheet {
    /** Per row, the column indices that contain visible pixels. */
    private readonly rows: number[][];

    constructor(
        readonly image: HTMLImageElement,
        readonly frameW: number,
        readonly frameH: number,
    ) {
        this.rows = scanNonEmptyCells(image, frameW, frameH);
    }

    framesInRow(row: number): readonly number[] {
        return this.rows[row] ?? [];
    }

    frameCount(row: number): number {
        return this.framesInRow(row).length;
    }

    /**
     * Draw the cell at `(col, row)` with its top-left at `pos`, scaled by
     * `scale`, optionally mirrored horizontally and rotated (radians) around
     * the frame centre.
     */
    drawFrame(
        ctx: CanvasRenderingContext2D,
        col: number,
        row: number,
        pos: Vec2,
        scale: number,
        options: { flipX?: boolean; rotation?: number; alpha?: number } = {},
    ): void {
        const { flipX = false, rotation = 0, alpha = 1 } = options;
        const dw = this.frameW * scale;
        const dh = this.frameH * scale;
        ctx.save();
        if (alpha < 1) ctx.globalAlpha *= alpha;
        ctx.translate(pos.x + dw / 2, pos.y + dh / 2);
        if (rotation !== 0) ctx.rotate(rotation);
        if (flipX) ctx.scale(-1, 1);
        ctx.drawImage(
            this.image,
            col * this.frameW,
            row * this.frameH,
            this.frameW,
            this.frameH,
            -dw / 2,
            -dh / 2,
            dw,
            dh,
        );
        ctx.restore();
    }
}

/**
 * A timed playback of one state (row) of a [`SpriteSheet`]. Switch states with
 * `setState`, advance with `update`, render with `draw`.
 */
export class Animation {
    private row: number;
    private readonly frameTime: number;
    private timer = 0;
    /** Index into the current row's non-empty frame list. */
    private current = 0;
    private finished = false;

    constructor(
        readonly sheet: SpriteSheet,
        row: number,
        fps: number,
        private readonly looping: boolean,
    ) {
        this.row = row;
        this.frameTime = fps > 0 ? 1 / fps : Infinity;
    }

    setState(row: number): void {
        if (row !== this.row) {
            this.row = row;
            this.reset();
        }
    }

    reset(): void {
        this.current = 0;
        this.timer = 0;
        this.finished = false;
    }

    update(dt: number): void {
        const count = this.sheet.frameCount(this.row);
        if (this.finished || count <= 1) return;
        this.timer += dt;
        while (this.timer >= this.frameTime) {
            this.timer -= this.frameTime;
            if (this.current + 1 < count) {
                this.current++;
            } else if (this.looping) {
                this.current = 0;
            } else {
                this.finished = true;
                break;
            }
        }
    }

    isFinished(): boolean {
        return this.finished;
    }

    currentFrame(): number {
        return this.current;
    }

    frameSize(): Vec2 {
        return new Vec2(this.sheet.frameW, this.sheet.frameH);
    }

    draw(
        ctx: CanvasRenderingContext2D,
        pos: Vec2,
        scale: number,
        options: { flipX?: boolean; rotation?: number; alpha?: number } = {},
    ): void {
        const frames = this.sheet.framesInRow(this.row);
        const col = frames[this.current];
        if (col === undefined) return; // empty row: nothing to draw
        this.sheet.drawFrame(ctx, col, this.row, pos, scale, options);
    }
}

/**
 * Scan the sheet grid and return, per row, the columns whose cell contains at
 * least one non-transparent pixel. Uses an offscreen canvas readback once at
 * load time.
 */
function scanNonEmptyCells(image: HTMLImageElement, frameW: number, frameH: number): number[][] {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const cols = Math.floor(canvas.width / frameW);
    const rows = Math.floor(canvas.height / frameH);
    const result: number[][] = [];
    for (let row = 0; row < rows; row++) {
        const nonEmpty: number[] = [];
        for (let col = 0; col < cols; col++) {
            if (cellHasPixels(data, canvas.width, col * frameW, row * frameH, frameW, frameH)) {
                nonEmpty.push(col);
            }
        }
        result.push(nonEmpty);
    }
    return result;
}

function cellHasPixels(
    data: Uint8ClampedArray,
    imageW: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
): boolean {
    for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
            if (data[(y * imageW + x) * 4 + 3] !== 0) return true;
        }
    }
    return false;
}
