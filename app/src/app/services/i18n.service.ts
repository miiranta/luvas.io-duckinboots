import { Injectable, computed, effect, signal } from '@angular/core';
import { LANGS, Lang, TRANSLATIONS, TranslationKey } from '../i18n/translations';

const STORAGE_KEY = 'duckinboots.lang';

@Injectable({ providedIn: 'root' })
export class I18nService {
    readonly lang = signal<Lang>(loadInitialLang());
    readonly langs = LANGS;

    /** Text direction for the current language (Arabic is RTL). */
    readonly dir = computed<'ltr' | 'rtl'>(() => (this.lang() === 'ar' ? 'rtl' : 'ltr'));

    constructor() {
        effect(() => {
            localStorage.setItem(STORAGE_KEY, this.lang());
            document.documentElement.lang = this.lang();
            document.documentElement.dir = this.dir();
        });
    }

    setLang(lang: Lang): void {
        this.lang.set(lang);
    }

    /** Translate a key in the current language. */
    t(key: TranslationKey): string {
        return TRANSLATIONS[this.lang()][key];
    }
}

function loadInitialLang(): Lang {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'pt' || stored === 'ar') return stored;
    return navigator.language.startsWith('pt') ? 'pt' : 'en';
}
