import { Component, HostListener, inject, signal } from '@angular/core';
import { GameService } from '../../services/game.service';
import { LevelStoreService, LevelSummary } from '../../services/level-store.service';
import { I18nService } from '../../services/i18n.service';
import { Lang } from '../../i18n/translations';

type MenuScreen = 'main' | 'levels' | 'instructions' | 'credits' | 'language';

interface FallingDuck {
    left: number;
    delay: number;
    duration: number;
    scale: number;
    flip: boolean;
    rotation: number;
}

const CREDITS = ['Ana Clara Zoppi', 'Lucas Miranda', 'Lucas Nogueira', 'Nícolas Hecker'];

@Component({
    selector: 'app-main-menu',
    templateUrl: './main-menu.component.html',
    styleUrl: './main-menu.component.scss',
})
export class MainMenuComponent {
    protected readonly game = inject(GameService);
    protected readonly store = inject(LevelStoreService);
    protected readonly i18n = inject(I18nService);

    protected readonly screen = signal<MenuScreen>('main');
    protected readonly selected = signal(0);
    protected readonly credits = CREDITS;
    protected readonly levels = signal<LevelSummary[] | null>(null);

    /** Decorative duck rain, randomized once per menu visit. */
    protected readonly ducks: FallingDuck[] = Array.from({ length: 18 }, () => ({
        left: Math.random() * 100,
        delay: -Math.random() * 14,
        duration: 6 + Math.random() * 10,
        scale: 1 + Math.random() * 2,
        flip: Math.random() < 0.5,
        rotation: -12 + Math.random() * 24,
    }));

    protected readonly items = [
        { key: 'play', icon: 'assets/icons/play.png', action: () => this.openLevels() },
        {
            key: 'level_editor',
            icon: 'assets/icons/pause.png',
            action: () => this.game.openEditor(),
        },
        {
            key: 'instructions',
            icon: 'assets/icons/info.png',
            action: () => this.screen.set('instructions'),
        },
        {
            key: 'credits',
            icon: 'assets/icons/people.png',
            action: () => this.screen.set('credits'),
        },
        {
            key: 'language',
            icon: 'assets/icons/language.png',
            action: () => this.screen.set('language'),
        },
    ] as const;

    @HostListener('window:keydown', ['$event'])
    onKeyDown(event: KeyboardEvent): void {
        if (this.screen() !== 'main') {
            if (event.code === 'Escape' || event.code === 'Backspace') this.screen.set('main');
            return;
        }
        switch (event.code) {
            case 'ArrowUp':
            case 'KeyW':
                this.selected.update((s) => (s + this.items.length - 1) % this.items.length);
                break;
            case 'ArrowDown':
            case 'KeyS':
                this.selected.update((s) => (s + 1) % this.items.length);
                break;
            case 'Enter':
            case 'Space':
                // Prevent a focused button's default keyboard "click" from
                // firing a second, possibly different action.
                event.preventDefault();
                this.items[this.selected()].action();
                break;
            default:
                break;
        }
    }

    protected openLevels(): void {
        this.screen.set('levels');
        void this.refreshLevels();
    }

    private async refreshLevels(): Promise<void> {
        this.levels.set(await this.store.list());
    }

    protected async playLevel(id: string): Promise<void> {
        const doc = await this.store.get(id);
        if (doc) await this.game.playLevel(doc);
    }

    protected async editLevel(id: string): Promise<void> {
        const doc = await this.store.get(id);
        if (doc) this.game.openEditor(doc);
    }

    protected async deleteLevel(id: string, event: Event): Promise<void> {
        event.stopPropagation();
        await this.store.delete(id);
        await this.refreshLevels();
    }

    protected selectLang(lang: Lang): void {
        this.i18n.setLang(lang);
        this.screen.set('main');
    }
}
