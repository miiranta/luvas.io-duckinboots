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
}

const DB_NAME = 'duckinboots';
const DB_VERSION = 1;
const STORE = 'levels';

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
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this.db;
    }

    private async tx<T>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore) => IDBRequest<T>,
    ): Promise<T> {
        const db = await this.open();
        return new Promise<T>((resolve, reject) => {
            const req = run(db.transaction(STORE, mode).objectStore(STORE));
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
        const [builtins, saved] = await Promise.all([
            this.loadBuiltins(),
            this.tx('readonly', (s) => s.getAll() as IDBRequest<LevelDocument[]>),
        ]);
        const builtinIds = new Set(builtins.map((b) => b.id));
        const user = saved
            .filter((l) => !builtinIds.has(l.id))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return [
            ...builtins.map((l) => summarize(l, true)),
            ...user.map((l) => summarize(l, false)),
        ];
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
