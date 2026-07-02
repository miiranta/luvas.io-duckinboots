import { Component, ElementRef, OnDestroy, afterNextRender, inject, viewChild } from '@angular/core';
import { GameService } from '../../services/game.service';

/**
 * Hosts the two full-viewport canvases: the 2D canvas the world renders into,
 * and the WebGPU canvas the post-processing shaders output to. When shaders
 * are active the 2D canvas is hidden and the effect canvas shows on top;
 * without WebGPU (or with effects toggled off) the 2D canvas shows directly.
 */
@Component({
    selector: 'app-game-canvas',
    template: `
        <canvas #source [class.hidden]="game.shadersActive()"></canvas>
        <canvas #output [class.hidden]="!game.shadersActive()"></canvas>
    `,
    styles: `
        :host {
            position: fixed;
            inset: 0;
        }

        canvas {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            display: block;
            image-rendering: pixelated;

            &.hidden {
                visibility: hidden;
            }
        }
    `,
})
export class GameCanvasComponent implements OnDestroy {
    protected readonly game = inject(GameService);
    private readonly source = viewChild.required<ElementRef<HTMLCanvasElement>>('source');
    private readonly output = viewChild.required<ElementRef<HTMLCanvasElement>>('output');

    constructor() {
        afterNextRender(() =>
            void this.game.init(this.source().nativeElement, this.output().nativeElement),
        );
    }

    ngOnDestroy(): void {
        this.game.destroy();
    }
}
