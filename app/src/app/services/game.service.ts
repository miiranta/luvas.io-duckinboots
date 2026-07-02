import { Injectable, computed, signal } from '@angular/core';
import { GameLoop } from '../../engine/loop';
import { Input } from '../../engine/input';
import { loadImage } from '../../engine/assets';
import { LevelDocument, cloneLevel } from '../../engine/level';
import { decodeAssets } from '../../engine/textures';
import { PostProcessor } from '../../engine/post-processor';
import { SpriteSheet } from '../../engine/sprite-sheet';
import { World } from '../../game/world';

/** The screen the game shell is currently on. Menus/overlays are Angular. */
export type Screen = 'loading' | 'menu' | 'editor' | 'playing' | 'paused' | 'win' | 'defeat';

/** Seconds each half of the fade-to-black screen transition takes. */
const FADE_SECONDS = 0.3;

/** Core sprites shared by every level, loaded once at boot. */
interface CoreAssets {
    ducky: SpriteSheet;
    portalPurple: SpriteSheet;
    portalGreen: SpriteSheet;
}

/**
 * Owns the engine loop, the input, the world simulation, and the high-level
 * screen state. Angular components read the signals and call the intents
 * (`playLevel`, `pause`, `resume`, …); the world stays a plain TS simulation.
 *
 * Worlds are built per level: `playLevel` decodes the level's embedded
 * assets and spins up a fresh `World`, so any level — built-in, saved in
 * IndexedDB, or straight from the editor — plays through the same path.
 */
@Injectable({ providedIn: 'root' })
export class GameService {
    readonly screen = signal<Screen>('loading');
    /** The level handed to the editor (null = start from a blank level). */
    readonly editorLevel = signal<LevelDocument | null>(null);
    readonly fadeOpacity = signal(0);
    readonly squeezed = signal(0);
    readonly squeezeTotal = signal(0);
    readonly fps = signal(0);
    /** User toggle for the shader effects (F4). */
    readonly shadersEnabled = signal(true);
    /** Whether WebGPU post-processing is available on this device. */
    readonly shadersSupported = signal(false);
    /** True when the effect canvas is the one being shown. */
    readonly shadersActive = computed(
        () => this.shadersSupported() && this.shadersEnabled() && this.inWorld(),
    );
    private readonly inWorld = signal(false);

    private core?: CoreAssets;
    private world?: World;
    private loop?: GameLoop;
    private readonly input = new Input();
    private canvas?: HTMLCanvasElement;
    private ctx?: CanvasRenderingContext2D;
    private post: PostProcessor | null = null;
    private elapsed = 0;
    private transitioning = false;
    /** Where leaving the pause/end screens returns to (menu or editor). */
    private returnTo: 'menu' | 'editor' = 'menu';

    /** Load core assets and start the loop. Called once by the canvas component. */
    async init(canvas: HTMLCanvasElement, effectCanvas?: HTMLCanvasElement): Promise<void> {
        if (this.loop) return;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d') ?? undefined;
        if (effectCanvas) {
            this.post = await PostProcessor.create(effectCanvas);
            this.shadersSupported.set(this.post !== null);
        }

        const [duckyImg, purpleImg, greenImg] = await Promise.all([
            loadImage('assets/sprites/ducky_spritesheet.png'),
            loadImage('assets/sprites/portal_purple.png'),
            loadImage('assets/sprites/portal_green.png'),
        ]);
        this.core = {
            ducky: new SpriteSheet(duckyImg, 32, 32),
            portalPurple: new SpriteSheet(purpleImg, 64, 64),
            portalGreen: new SpriteSheet(greenImg, 64, 64),
        };

        this.input.attach();
        this.loop = new GameLoop(
            60,
            (dt) => this.update(dt),
            () => this.render(),
        );
        this.loop.start();
        this.screen.set('menu');
    }

    destroy(): void {
        this.loop?.stop();
        this.loop = undefined;
        this.input.detach();
        this.post?.destroy();
        this.post = null;
    }

    // ── Intents (called by the UI) ───────────────────────────────────────────

    /**
     * Build a world for `level` and start playing it. `from` decides where
     * quitting the run returns to (the menu, or the editor for test plays).
     */
    async playLevel(level: LevelDocument, from: 'menu' | 'editor' = 'menu'): Promise<void> {
        const core = this.core;
        if (!core || this.transitioning) return;
        this.transitioning = true;
        this.returnTo = from;
        this.fadeOpacity.set(1);
        await sleep(FADE_SECONDS * 1000);

        // The world mutates sprite positions at runtime; play a copy.
        const doc = cloneLevel(level);
        const textures = await decodeAssets(doc.assets);
        this.world = new World({ ...core, level: doc, textures });
        this.squeezeTotal.set(this.world.squeezables.totalCount);
        this.squeezed.set(0);

        this.screen.set('playing');
        this.fadeOpacity.set(0);
        await sleep(FADE_SECONDS * 1000);
        this.transitioning = false;
    }

    /** Restart the current run (end screens / pause). */
    replay(): void {
        if (!this.world) return;
        this.goTo('playing', () => this.world?.reset());
    }

    pause(): void {
        if (this.screen() === 'playing') this.screen.set('paused');
    }

    resume(): void {
        if (this.screen() === 'paused') this.screen.set('playing');
    }

    /** Leave the current run for wherever it was started from. */
    quitRun(): void {
        this.goTo(this.returnTo);
    }

    backToMenu(): void {
        this.goTo('menu');
    }

    openEditor(level: LevelDocument | null = null): void {
        this.editorLevel.set(level);
        this.goTo('editor');
    }

    toggleFullscreen(): void {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
    }

    // ── Loop ─────────────────────────────────────────────────────────────────

    private update(dt: number): void {
        const world = this.world;

        switch (this.screen()) {
            case 'playing': {
                if (!world) break;
                if (this.input.wasPressed('KeyP') || this.input.wasPressed('Escape')) {
                    this.pause();
                    break;
                }
                if (this.input.wasPressed('KeyF')) this.toggleFullscreen();
                if (this.input.wasPressed('F4')) this.shadersEnabled.update((v) => !v);
                world.update(this.input, dt);
                this.squeezed.set(world.squeezeCount);
                this.fps.set(this.loop?.fps ?? 0);

                // Win when every squeezable has been crushed. K/L remain as
                // hidden debug shortcuts for the end screens.
                if (world.allSqueezed || this.input.wasPressed('KeyL')) this.goTo('win');
                else if (this.input.wasPressed('KeyK')) this.goTo('defeat');
                break;
            }
            case 'paused': {
                if (this.input.wasPressed('KeyP') || this.input.wasPressed('Escape')) this.resume();
                else if (this.input.wasPressed('KeyM')) this.quitRun();
                break;
            }
            case 'win':
            case 'defeat': {
                if (this.input.wasPressed('Enter')) this.replay();
                else if (this.input.wasPressed('KeyM')) this.quitRun();
                break;
            }
            default:
                break;
        }
        this.input.endStep();
    }

    private render(): void {
        const { canvas, ctx, world } = this;
        if (!canvas || !ctx) return;

        // Keep the backing store in sync with the displayed size.
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        const screen = this.screen();
        const inWorld =
            screen === 'playing' || screen === 'paused' || screen === 'win' || screen === 'defeat';
        this.inWorld.set(inWorld);
        if (!inWorld || !world) return;

        world.draw(ctx, w, h);
        this.elapsed += 1 / 60;
        if (this.shadersActive() && this.post) {
            this.post.render(canvas, this.elapsed, 1);
        }
    }

    /**
     * Fade to black, switch screens at the midpoint (running `atMidpoint`
     * while fully black), then fade back in. Ignored while one is running.
     */
    private goTo(target: Screen, atMidpoint?: () => void): void {
        if (this.transitioning) return;
        this.transitioning = true;
        this.fadeOpacity.set(1);
        setTimeout(() => {
            atMidpoint?.();
            this.squeezed.set(this.world?.squeezeCount ?? 0);
            this.screen.set(target);
            this.fadeOpacity.set(0);
            setTimeout(() => (this.transitioning = false), FADE_SECONDS * 1000);
        }, FADE_SECONDS * 1000);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
