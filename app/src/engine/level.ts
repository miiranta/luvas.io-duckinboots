import { Rect, Vec2 } from './math';

/**
 * Level format v2 — `duckinboots.level`.
 *
 * A level is a single self-contained JSON document: geometry, gameplay
 * classification, embedded art assets (data URLs, so a level saved to
 * IndexedDB or exported as a file carries its own images/GIFs), and sprite
 * placements. Nothing is inferred at load time: colliders carry explicit
 * gameplay tags, and sprites explicitly reference the asset and (optionally)
 * the collider they ride on.
 */

export const LEVEL_FORMAT = 'duckinboots.level';
export const LEVEL_VERSION = 3;

/** What a collider *is* in gameplay terms. */
export type ColliderTag =
    | 'wall' /* solid to everything */
    | 'movable' /* pushable/pullable box */
    | 'item' /* chain-crushable squeezable */
    | 'bar' /* solid to the player, transparent to the chain */
    | 'water' /* solid; rendered as water */
    | 'plate' /* non-solid; active while a chain lies over it */
    | 'button'; /* non-solid; latches pressed when the player steps on it */

export interface RectShape {
    kind: 'rect';
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface CircleShape {
    kind: 'circle';
    x: number;
    y: number;
    r: number;
}

export type Shape = RectShape | CircleShape;

export interface LevelCollider {
    id: string;
    tag: ColliderTag;
    shape: Shape;
    /**
     * Trigger/squeeze group. Grouped `item`s must all be cinched in the same
     * frame to be crushed; a grouped `plate` event fires only when every
     * plate in the group is held at once. Rules can target a group name.
     */
    group?: string;
}

/** One chain tethering the player, with its own anchor and rope length. */
export interface LevelChain {
    id: string;
    anchor: { x: number; y: number };
    length: number;
}

/** The player's starting toolkit; rules can change these mid-level. */
export interface LevelAbilities {
    push: boolean;
    pull: boolean;
    /** Max portal pairs the player may have open at once (0 = none). */
    portalPairs: number;
}

export type RuleEventType = 'buttonPressed' | 'plateActive' | 'squeezed';

/** The condition side of a rule: an event on a collider id or group name. */
export interface RuleEvent {
    type: RuleEventType;
    /** A collider id, or a group name (matches every collider in the group). */
    target: string;
}

export type RuleAction =
    | { type: 'breakChain'; chainId: string }
    | { type: 'setAbility'; ability: 'push' | 'pull'; value: boolean }
    | { type: 'addPortalPairs'; amount: number }
    | { type: 'setMovable'; colliderId: string; movable: boolean }
    | { type: 'removeCollider'; colliderId: string };

/**
 * Causality: when the event's condition becomes true, the actions run once
 * (rules are latched — they never fire twice in a run; reset re-arms them).
 */
export interface LevelRule {
    id: string;
    when: RuleEvent;
    actions: RuleAction[];
}

/**
 * An embedded art asset. `data` is a data URL, so the asset travels with the
 * level document. Animated formats (GIF, animated WebP/PNG) are decoded to
 * frames at load time; `fps` optionally overrides the file's own timing.
 */
export interface LevelAsset {
    id: string;
    name: string;
    mime: string;
    data: string;
    fps?: number;
}

/** A placed instance of an asset in the world. */
export interface LevelSprite {
    id: string;
    assetId: string;
    x: number;
    y: number;
    scale: number;
    /** `background` draws under everything; `entity` joins the Y-sort. */
    layer: 'background' | 'entity';
    /** When set, the sprite rides this (movable) collider rigidly. */
    colliderId?: string | null;
}

export interface LevelDocument {
    format: typeof LEVEL_FORMAT;
    version: number;
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    /** Editor snap grid, world px. */
    gridSize: number;
    playerStart: { x: number; y: number };
    /** Every chain tethering the player (may be empty: a free duck). */
    chains: LevelChain[];
    /** Where the duck must go to win. `null` = win by squeezing everything. */
    goal: { x: number; y: number; w: number; h: number } | null;
    abilities: LevelAbilities;
    rules: LevelRule[];
    colliders: LevelCollider[];
    assets: LevelAsset[];
    sprites: LevelSprite[];
}

/** Editor palette + debug colours, one per tag. */
export const TAG_COLORS: Record<ColliderTag, string> = {
    wall: '#5a6377',
    movable: '#e8bd4a',
    item: '#f5008c',
    bar: '#ff8a2a',
    water: '#3fa3ff',
    plate: '#2fd6ad',
    button: '#ff5555',
};

/** Human labels for the editor UI. */
export const TAG_LABELS: Record<ColliderTag, string> = {
    wall: 'Wall',
    movable: 'Box',
    item: 'Item',
    bar: 'Bar',
    water: 'Water',
    plate: 'Plate',
    button: 'Button',
};

export const ALL_TAGS: ColliderTag[] = [
    'wall',
    'movable',
    'item',
    'bar',
    'water',
    'plate',
    'button',
];

/** Short, collision-safe id for level objects. */
export function newId(): string {
    return (
        Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8)
    );
}

export function createEmptyLevel(name = 'Untitled level'): LevelDocument {
    const now = new Date().toISOString();
    return {
        format: LEVEL_FORMAT,
        version: LEVEL_VERSION,
        id: newId(),
        name,
        createdAt: now,
        updatedAt: now,
        gridSize: 32,
        playerStart: { x: 0, y: 0 },
        chains: [{ id: newId(), anchor: { x: 0, y: -96 }, length: 1600 }],
        goal: null,
        abilities: { push: true, pull: true, portalPairs: 99 },
        rules: [],
        colliders: [],
        assets: [],
        sprites: [],
    };
}

export function cloneLevel(level: LevelDocument): LevelDocument {
    return structuredClone(level);
}

/** World-space AABB of a shape. */
export function shapeBounds(shape: Shape): Rect {
    if (shape.kind === 'rect') return new Rect(shape.x, shape.y, shape.w, shape.h);
    return new Rect(shape.x - shape.r, shape.y - shape.r, shape.r * 2, shape.r * 2);
}

export function playerStart(level: LevelDocument): Vec2 {
    return new Vec2(level.playerStart.x, level.playerStart.y);
}

/**
 * Validate + repair an untrusted level document (imported JSON, old saves).
 * Throws on documents that aren't recognizably levels; fills defaults and
 * drops malformed entries otherwise, so a slightly-broken file still loads.
 */
export function normalizeLevel(raw: unknown): LevelDocument {
    if (typeof raw !== 'object' || raw === null) throw new Error('Not a level document');
    const doc = raw as Partial<LevelDocument> & Record<string, unknown>;
    if (doc.format !== LEVEL_FORMAT) throw new Error('Unrecognized level format');

    const num = (v: unknown, fallback: number): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    const point = (v: unknown, fx: number, fy: number): { x: number; y: number } => {
        const p = (v ?? {}) as { x?: unknown; y?: unknown };
        return { x: num(p.x, fx), y: num(p.y, fy) };
    };

    const colliders: LevelCollider[] = [];
    for (const c of Array.isArray(doc.colliders) ? doc.colliders : []) {
        const col = c as Partial<Omit<LevelCollider, 'shape'>> & { shape?: unknown };
        const shape = col.shape as
            | { kind?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; r?: unknown }
            | undefined;
        if (!shape || !col.tag || !ALL_TAGS.includes(col.tag)) continue;
        const group =
            typeof col.group === 'string' && col.group.trim() ? col.group.trim() : undefined;
        if (shape.kind === 'rect') {
            colliders.push({
                id: col.id || newId(),
                tag: col.tag,
                group,
                shape: { kind: 'rect', x: num(shape.x, 0), y: num(shape.y, 0), w: num(shape.w, 32), h: num(shape.h, 32) },
            });
        } else if (shape.kind === 'circle') {
            colliders.push({
                id: col.id || newId(),
                tag: col.tag,
                group,
                shape: { kind: 'circle', x: num(shape.x, 0), y: num(shape.y, 0), r: num(shape.r, 16) },
            });
        }
    }

    const assets: LevelAsset[] = [];
    for (const a of Array.isArray(doc.assets) ? doc.assets : []) {
        const asset = a as Partial<LevelAsset>;
        if (!asset.id || typeof asset.data !== 'string') continue;
        assets.push({
            id: asset.id,
            name: asset.name || asset.id,
            mime: asset.mime || 'image/png',
            data: asset.data,
            fps: typeof asset.fps === 'number' ? asset.fps : undefined,
        });
    }
    const assetIds = new Set(assets.map((a) => a.id));
    const colliderIds = new Set(colliders.map((c) => c.id));

    const sprites: LevelSprite[] = [];
    for (const s of Array.isArray(doc.sprites) ? doc.sprites : []) {
        const sprite = s as Partial<LevelSprite>;
        if (!sprite.assetId || !assetIds.has(sprite.assetId)) continue;
        sprites.push({
            id: sprite.id || newId(),
            assetId: sprite.assetId,
            x: num(sprite.x, 0),
            y: num(sprite.y, 0),
            scale: num(sprite.scale, 1),
            layer: sprite.layer === 'background' ? 'background' : 'entity',
            colliderId:
                sprite.colliderId && colliderIds.has(sprite.colliderId) ? sprite.colliderId : null,
        });
    }

    // Chains: current array form, migrating older single-chain documents
    // (`chainAnchor` + `chainLength`) into a one-entry list.
    const chains: LevelChain[] = [];
    if (Array.isArray(doc.chains)) {
        for (const c of doc.chains) {
            const chain = c as Partial<LevelChain>;
            chains.push({
                id: chain.id || newId(),
                anchor: point(chain.anchor, 0, -96),
                length: Math.max(100, num(chain.length, 1600)),
            });
        }
    } else if ('chainAnchor' in doc) {
        chains.push({
            id: newId(),
            anchor: point(doc['chainAnchor'], 0, -96),
            length: Math.max(100, num(doc['chainLength'], 1600)),
        });
    }
    const chainIds = new Set(chains.map((c) => c.id));

    const goalRaw = doc.goal as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
    const goal =
        goalRaw && typeof goalRaw === 'object'
            ? {
                  x: num(goalRaw.x, 0),
                  y: num(goalRaw.y, 0),
                  w: Math.max(8, num(goalRaw.w, 64)),
                  h: Math.max(8, num(goalRaw.h, 64)),
              }
            : null;

    const abilitiesRaw = (doc.abilities ?? {}) as Partial<LevelAbilities>;
    const abilities: LevelAbilities = {
        push: abilitiesRaw.push !== false,
        pull: abilitiesRaw.pull !== false,
        portalPairs: Math.max(0, num(abilitiesRaw.portalPairs, 99)),
    };

    const rules: LevelRule[] = [];
    for (const r of Array.isArray(doc.rules) ? doc.rules : []) {
        const rule = r as Partial<LevelRule>;
        const when = rule.when as Partial<RuleEvent> | undefined;
        if (
            !when ||
            !['buttonPressed', 'plateActive', 'squeezed'].includes(when.type as string) ||
            typeof when.target !== 'string'
        ) {
            continue;
        }
        const actions: RuleAction[] = [];
        for (const a of Array.isArray(rule.actions) ? rule.actions : []) {
            const action = a as RuleAction;
            switch (action.type) {
                case 'breakChain':
                    if (chainIds.has(action.chainId)) actions.push(action);
                    break;
                case 'setAbility':
                    if (action.ability === 'push' || action.ability === 'pull') {
                        actions.push({ ...action, value: action.value !== false });
                    }
                    break;
                case 'addPortalPairs':
                    actions.push({ type: 'addPortalPairs', amount: num(action.amount, 1) });
                    break;
                case 'setMovable':
                case 'removeCollider':
                    if (colliders.some((c) => c.id === action.colliderId)) actions.push(action);
                    break;
            }
        }
        if (actions.length > 0) {
            rules.push({ id: rule.id || newId(), when: { type: when.type as RuleEventType, target: when.target }, actions });
        }
    }

    const now = new Date().toISOString();
    return {
        format: LEVEL_FORMAT,
        version: LEVEL_VERSION,
        id: typeof doc.id === 'string' && doc.id ? doc.id : newId(),
        name: typeof doc.name === 'string' && doc.name.trim() ? doc.name : 'Untitled level',
        createdAt: typeof doc.createdAt === 'string' ? doc.createdAt : now,
        updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : now,
        gridSize: Math.max(1, num(doc.gridSize, 32)),
        playerStart: point(doc.playerStart, 0, 0),
        chains,
        goal,
        abilities,
        rules,
        colliders,
        assets,
        sprites,
    };
}
