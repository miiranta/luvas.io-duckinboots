import { Component, ElementRef, OnDestroy, afterNextRender, inject, viewChild } from '@angular/core';
import { GameService } from '../../services/game.service';

/** Hosts the full-viewport canvas the world renders into. */
@Component({
    selector: 'app-game-canvas',
    template: '<canvas #canvas></canvas>',
    styles: `
        :host {
            position: fixed;
            inset: 0;
        }

        canvas {
            width: 100%;
            height: 100%;
            display: block;
            image-rendering: pixelated;
        }
    `,
})
export class GameCanvasComponent implements OnDestroy {
    private readonly game = inject(GameService);
    private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

    constructor() {
        afterNextRender(() => void this.game.init(this.canvas().nativeElement));
    }

    ngOnDestroy(): void {
        this.game.destroy();
    }
}
