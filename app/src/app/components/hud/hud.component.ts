import { Component, inject } from '@angular/core';
import { GameService } from '../../services/game.service';
import { I18nService } from '../../services/i18n.service';
import { formatDuration } from '../../util/time';

/** In-game HUD: squeeze progress, run timer, FPS, controls hint, pause. */
@Component({
    selector: 'app-hud',
    templateUrl: './hud.component.html',
    styleUrl: './hud.component.scss',
})
export class HudComponent {
    protected readonly game = inject(GameService);
    protected readonly i18n = inject(I18nService);
    protected readonly formatDuration = formatDuration;
}
