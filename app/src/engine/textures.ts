import { LevelAsset } from './level';

/**
 * Runtime decoding of level assets (data-URL images) into drawable textures.
 * Animated formats (GIF, animated WebP/APNG) are decoded frame-by-frame with
 * the WebCodecs `ImageDecoder` when the browser provides it; otherwise (and
 * for plain images) the asset renders as a single static frame.
 */

/** Minimal WebCodecs ImageDecoder surface (not yet in the TS DOM lib). */
interface ImageDecoderLike {
    decode(options: { frameIndex: number }): Promise<{ image: VideoFrame & { duration: number | null } }>;
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; animated: boolean } | null };
    close(): void;
}
declare const ImageDecoder: {
    new (init: { data: ArrayBuffer; type: string }): ImageDecoderLike;
    isTypeSupported(type: string): Promise<boolean>;
} | undefined;

/** A decoded texture: one or more frames plus their display timings. */
export class GameTexture {
    readonly totalDuration: number;
    private readonly starts: number[];

    constructor(
        readonly frames: CanvasImageSource[],
        /** Per-frame display time, ms. Single-frame textures use `[Infinity]`. */
        readonly delays: number[],
        readonly width: number,
        readonly height: number,
    ) {
        this.starts = [];
        let t = 0;
        for (const d of delays) {
            this.starts.push(t);
            t += d;
        }
        this.totalDuration = t;
    }

    get animated(): boolean {
        return this.frames.length > 1;
    }

    /** The frame to show at `timeMs` (looping). */
    frameAt(timeMs: number): CanvasImageSource {
        if (!this.animated) return this.frames[0];
        const t = timeMs % this.totalDuration;
        // Frame counts are small; a linear scan is fine.
        for (let i = this.starts.length - 1; i >= 0; i--) {
            if (t >= this.starts[i]) return this.frames[i];
        }
        return this.frames[0];
    }

    dispose(): void {
        for (const f of this.frames) {
            if (f instanceof ImageBitmap) f.close();
        }
    }
}

function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function loadStatic(dataUrl: string): Promise<GameTexture> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () =>
            resolve(new GameTexture([img], [Infinity], img.naturalWidth, img.naturalHeight));
        img.onerror = () => reject(new Error('Failed to decode image asset'));
        img.src = dataUrl;
    });
}

/** Formats worth running through the animated decoder. */
const ANIMATED_MIMES = new Set(['image/gif', 'image/webp', 'image/apng', 'image/png']);

async function tryDecodeAnimated(asset: LevelAsset): Promise<GameTexture | null> {
    if (typeof ImageDecoder === 'undefined' || !ANIMATED_MIMES.has(asset.mime)) return null;
    if (!(await ImageDecoder.isTypeSupported(asset.mime))) return null;

    const decoder = new ImageDecoder({ data: dataUrlToBuffer(asset.data), type: asset.mime });
    try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || !track.animated || track.frameCount <= 1) return null;

        const frames: CanvasImageSource[] = [];
        const delays: number[] = [];
        const forcedDelay = asset.fps && asset.fps > 0 ? 1000 / asset.fps : null;
        for (let i = 0; i < track.frameCount; i++) {
            const { image } = await decoder.decode({ frameIndex: i });
            frames.push(await createImageBitmap(image));
            // VideoFrame durations are in microseconds; default 100ms.
            delays.push(forcedDelay ?? (image.duration ? image.duration / 1000 : 100));
            image.close();
        }
        const first = frames[0] as ImageBitmap;
        return new GameTexture(frames, delays, first.width, first.height);
    } catch {
        return null;
    } finally {
        decoder.close();
    }
}

/** Decode one asset, animated when possible, static otherwise. */
export async function decodeAsset(asset: LevelAsset): Promise<GameTexture> {
    return (await tryDecodeAnimated(asset)) ?? (await loadStatic(asset.data));
}

/**
 * Decode every asset of a level, keyed by asset id. Assets that fail to
 * decode are skipped (a missing texture must not break the level).
 */
export async function decodeAssets(
    assets: readonly LevelAsset[],
): Promise<Map<string, GameTexture>> {
    const entries = await Promise.all(
        assets.map(async (a): Promise<[string, GameTexture] | null> => {
            try {
                return [a.id, await decodeAsset(a)];
            } catch (e) {
                console.warn(`Failed to decode asset "${a.name}"`, e);
                return null;
            }
        }),
    );
    return new Map(entries.filter((e): e is [string, GameTexture] => e !== null));
}

/** Read a user-picked file into a data URL (for the level editor). */
export function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}
