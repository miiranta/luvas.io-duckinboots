import { Component, inject } from '@angular/core';
import { GameService } from './services/game.service';
import { I18nService } from './services/i18n.service';
import { GameCanvasComponent } from './components/game-canvas/game-canvas.component';
import { MainMenuComponent } from './components/main-menu/main-menu.component';
import { HudComponent } from './components/hud/hud.component';
import { PauseOverlayComponent } from './components/pause-overlay/pause-overlay.component';
import { EndOverlayComponent } from './components/end-overlay/end-overlay.component';

@Component({
    selector: 'app-root',
    imports: [
        GameCanvasComponent,
        MainMenuComponent,
        HudComponent,
        PauseOverlayComponent,
        EndOverlayComponent,
    ],
    templateUrl: './app.html',
    styleUrl: './app.scss',
})
export class App {
    protected readonly game = inject(GameService);
    protected readonly i18n = inject(I18nService);
}
