import { Component, inject } from '@angular/core';
import { GameService } from '../../services/game.service';
import { I18nService } from '../../services/i18n.service';

/** Dim overlay shown over the frozen world while paused. */
@Component({
    selector: 'app-pause-overlay',
    template: `
        <div class="overlay">
            <h2 class="screen-title title">{{ i18n.t('paused') }}</h2>
            <div class="actions">
                <button class="btn" (click)="game.resume()">
                    {{ i18n.t('resume') }} <kbd>ESC</kbd>
                </button>
                <button class="btn" (click)="game.quitRun()">
                    {{ i18n.t('back_to_menu') }} <kbd>M</kbd>
                </button>
            </div>
        </div>
    `,
    styleUrl: './pause-overlay.component.scss',
})
export class PauseOverlayComponent {
    protected readonly game = inject(GameService);
    protected readonly i18n = inject(I18nService);
}
