import { Component, inject, input } from '@angular/core';
import { GameService } from '../../services/game.service';
import { I18nService } from '../../services/i18n.service';

/** Win / defeat end screen over the frozen world. */
@Component({
    selector: 'app-end-overlay',
    templateUrl: './end-overlay.component.html',
    styleUrl: './end-overlay.component.scss',
})
export class EndOverlayComponent {
    readonly kind = input.required<'win' | 'defeat'>();
    protected readonly game = inject(GameService);
    protected readonly i18n = inject(I18nService);
}
