import { Injectable, signal } from '@angular/core';
import { GameLoop } from '../../engine/loop';
import { Input } from '../../engine/input';
import { loadImage, loadImageMap, loadJson } from '../../engine/assets';
import { LevelData } from '../../engine/level';
import { SpriteSheet } from '../../engine/sprite-sheet';
import { World } from '../../game/world';

/** The screen the game shell is currently on. Menus/overlays are Angular. */
export type Screen = 'loading' | 'menu' | 'playing' | 'paused' | 'win' | 'defeat';

/** Seconds each half of the fade-to-black screen transition takes. */
const FADE_SECONDS = 0.3;

/**
 * Owns the engine loop, the input, the world simulation, and the high-level
 * screen state. Angular components read the signals and call the intents
 * (`play`, `pause`, `resume`, …); the world stays a plain TS simulation.
 */
@Injectable({ providedIn: 'root' })
export class GameService {
    readonly screen = signal<Screen>('loading');
    readonly fadeOpacity = signal(0);
    readonly squeezed = signal(0);
    readonly squeezeTotal = signal(0);
    readonly fps = signal(0);

    private world?: World;
    private loop?: GameLoop;
    private readonly input = new Input();
    private canvas?: HTMLCanvasElement;
    private ctx?: CanvasRenderingContext2D;
    private transitioning = false;

    /** Load all assets and start the loop. Called once by the canvas component. */
    async init(canvas: HTMLCanvasElement): Promise<void> {
        if (this.loop) return;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d') ?? undefined;

        const [duckyImg, purpleImg, greenImg, level] = await Promise.all([
            loadImage('assets/sprites/ducky_spritesheet.png'),
            loadImage('assets/sprites/portal_purple.png'),
            loadImage('assets/sprites/portal_green.png'),
            loadJson<LevelData>('assets/level.json'),
        ]);
        const paths = (level.sprite_instances ?? []).map((i) => `assets/${i.path}`);
        const textureFiles = await loadImageMap(paths);
        // The level references paths as `sprites/...`; re-key without the prefix.
        const textures = new Map<string, HTMLImageElement>();
        for (const [key, img] of textureFiles) textures.set(key.replace(/^assets\//, ''), img);

        this.world = new World({
            ducky: new SpriteSheet(duckyImg, 32, 32),
            portalPurple: new SpriteSheet(purpleImg, 64, 64),
            portalGreen: new SpriteSheet(greenImg, 64, 64),
            level,
            textures,
        });
        this.squeezeTotal.set(this.world.squeezables.totalCount);

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
    }

    // ── Intents (called by the UI) ───────────────────────────────────────────

    /** Start a fresh run from the menu or an end screen. */
    play(): void {
        this.goTo('playing', () => this.world?.reset());
    }

    pause(): void {
        if (this.screen() === 'playing') this.screen.set('paused');
    }

    resume(): void {
        if (this.screen() === 'paused') this.screen.set('playing');
    }

    backToMenu(): void {
        this.goTo('menu');
    }

    toggleFullscreen(): void {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
    }

    // ── Loop ─────────────────────────────────────────────────────────────────

    private update(dt: number): void {
        const world = this.world;
        if (!world) return;

        switch (this.screen()) {
            case 'playing': {
                if (this.input.wasPressed('KeyP') || this.input.wasPressed('Escape')) {
                    this.pause();
                    break;
                }
                if (this.input.wasPressed('KeyF')) this.toggleFullscreen();
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
                else if (this.input.wasPressed('KeyM')) this.backToMenu();
                break;
            }
            case 'win':
            case 'defeat': {
                if (this.input.wasPressed('Enter')) this.play();
                else if (this.input.wasPressed('KeyM')) this.backToMenu();
                break;
            }
            default:
                break;
        }
        this.input.endStep();
    }

    private render(): void {
        const { canvas, ctx, world } = this;
        if (!canvas || !ctx || !world) return;

        // Keep the backing store in sync with the displayed size.
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        const screen = this.screen();
        if (screen === 'playing' || screen === 'paused' || screen === 'win' || screen === 'defeat') {
            world.draw(ctx, w, h);
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
