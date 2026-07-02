import { Injectable } from '@angular/core';
import { LevelDocument, cloneLevel, normalizeLevel } from '../../engine/level';
import { loadJson } from '../../engine/assets';

/** Lightweight listing info (the full document can embed megabytes of art). */
export interface LevelSummary {
    id: string;
    name: string;
    updatedAt: string;
    colliderCount: number;
    assetCount: number;
    /** Built-in levels ship with the app and can't be deleted. */
    builtin: boolean;
    /** Completion progress, when the level has been beaten. */
    progress?: LevelProgress;
}

/** Per-level completion record. */
export interface LevelProgress {
    levelId: string;
    bestTimeMs: number;
    completedAt: string;
}

const DB_NAME = 'duckinboots';
const DB_VERSION = 2;
const STORE = 'levels';
const PROGRESS_STORE = 'progress';

/** Built-in level files shipped under `assets/levels/`. */
const BUILTIN_LEVEL_URLS = ['assets/levels/test-level.json'];

function summarize(level: LevelDocument, builtin: boolean): LevelSummary {
    return {
        id: level.id,
        name: level.name,
        updatedAt: level.updatedAt,
        colliderCount: level.colliders.length,
        assetCount: level.assets.length,
        builtin,
    };
}

/**
 * Level persistence: built-in levels are fetched from `assets/levels/`,
 * user levels live in IndexedDB (object store `levels`, keyed by level id).
 * Documents are stored whole — embedded data-URL assets included — so a
 * saved level is fully self-contained.
 */
@Injectable({ providedIn: 'root' })
export class LevelStoreService {
    private db?: Promise<IDBDatabase>;
    private builtins?: Promise<LevelDocument[]>;

    private open(): Promise<IDBDatabase> {
        this.db ??= new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE, { keyPath: 'id' });
                }
                if (!req.result.objectStoreNames.contains(PROGRESS_STORE)) {
                    req.result.createObjectStore(PROGRESS_STORE, { keyPath: 'levelId' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this.db;
    }

    private async tx<T>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore) => IDBRequest<T>,
        storeName: string = STORE,
    ): Promise<T> {
        const db = await this.open();
        return new Promise<T>((resolve, reject) => {
            const req = run(db.transaction(storeName, mode).objectStore(storeName));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    private loadBuiltins(): Promise<LevelDocument[]> {
        this.builtins ??= Promise.all(
            BUILTIN_LEVEL_URLS.map(async (url) => normalizeLevel(await loadJson<unknown>(url))),
        );
        return this.builtins;
    }

    /** All levels, built-ins first, user levels newest-first. */
    async list(): Promise<LevelSummary[]> {
        const [builtins, saved, progress] = await Promise.all([
            this.loadBuiltins(),
            this.tx('readonly', (s) => s.getAll() as IDBRequest<LevelDocument[]>),
            this.tx(
                'readonly',
                (s) => s.getAll() as IDBRequest<LevelProgress[]>,
                PROGRESS_STORE,
            ),
        ]);
        const progressById = new Map(progress.map((p) => [p.levelId, p]));
        const builtinIds = new Set(builtins.map((b) => b.id));
        const user = saved
            .filter((l) => !builtinIds.has(l.id))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return [
            ...builtins.map((l) => summarize(l, true)),
            ...user.map((l) => summarize(l, false)),
        ].map((s) => ({ ...s, progress: progressById.get(s.id) }));
    }

    /** Record a completed run, keeping the best (lowest) time. */
    async recordWin(levelId: string, timeMs: number): Promise<void> {
        const existing = await this.tx(
            'readonly',
            (s) => s.get(levelId) as IDBRequest<LevelProgress | undefined>,
            PROGRESS_STORE,
        );
        if (existing && existing.bestTimeMs <= timeMs) return;
        const record: LevelProgress = {
            levelId,
            bestTimeMs: Math.round(timeMs),
            completedAt: new Date().toISOString(),
        };
        await this.tx('readwrite', (s) => s.put(record), PROGRESS_STORE);
    }

    /** Fetch a full level document by id (IndexedDB first, then built-ins). */
    async get(id: string): Promise<LevelDocument | null> {
        const saved = await this.tx('readonly', (s) => s.get(id) as IDBRequest<LevelDocument | undefined>);
        if (saved) return normalizeLevel(saved);
        const builtin = (await this.loadBuiltins()).find((l) => l.id === id);
        return builtin ? cloneLevel(builtin) : null;
    }

    /** Save (insert or overwrite) a level. Stamps `updatedAt`. */
    async save(level: LevelDocument): Promise<void> {
        level.updatedAt = new Date().toISOString();
        await this.tx('readwrite', (s) => s.put(cloneLevel(level)));
    }

    async delete(id: string): Promise<void> {
        await this.tx('readwrite', (s) => s.delete(id));
    }

    async isBuiltin(id: string): Promise<boolean> {
        return (await this.loadBuiltins()).some((l) => l.id === id);
    }
}
