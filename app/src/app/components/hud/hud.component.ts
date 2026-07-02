import { Component, inject } from '@angular/core';
import { GameService } from '../../services/game.service';
import { I18nService } from '../../services/i18n.service';

/** In-game HUD: squeeze progress, FPS, controls hint, pause button. */
@Component({
    selector: 'app-hud',
    templateUrl: './hud.component.html',
    styleUrl: './hud.component.scss',
})
export class HudComponent {
    protected readonly game = inject(GameService);
    protected readonly i18n = inject(I18nService);
}
