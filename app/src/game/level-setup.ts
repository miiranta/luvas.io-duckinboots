import { Rect, Vec2 } from '../engine/math';
import {
    ClassificationEntry,
    LevelData,
    LevelShape,
    getTag,
    isRect,
    setShapeId,
    shapeBounds,
    shapeColor,
    shapeId,
} from '../engine/level';
import { Collider, aabb, circleCollider } from './collision';
import { Squeezables } from './squeezables';

/** Classification tags authored in the editor (derived here from colours). */
export const TAG_MOVABLE = 'mov';
export const TAG_MOVABLE2 = 'mov2';
export const TAG_ITEM = 'item';
export const TAG_BAR = 'bar';
export const TAG_WATER = 'water';

/** Sprites under this prefix are decorative ground, never bound to a collider. */
const GRASS_PREFIX = 'sprites/TX Tileset Grass';

export function isMovableTag(tag: string | undefined): boolean {
    return tag === TAG_MOVABLE || tag === TAG_MOVABLE2;
}

/**
 * Map a collision box's authored palette colour to its classification tag
 * (the editor's shape palette, matched by exact RGB). `undefined` means
 * "don't classify" — RED is explicitly ignored, as is any off-palette colour.
 */
function tagForColor(c: { r: number; g: number; b: number }): string | undefined {
    const key = `${c.r},${c.g},${c.b}`;
    switch (key) {
        case '255,203,0':
            return TAG_MOVABLE; // GOLD → movable
        case '0,158,47':
            return TAG_MOVABLE2; // LIME → also movable
        case '135,60,190':
            return TAG_ITEM; // VIOLET → squeezable item
        case '255,161,0':
            return TAG_BAR; // ORANGE → bar (player-solid, chain-pass)
        case '102,191,255':
            return TAG_WATER; // SKYBLUE → water (still solid)
        default:
            return undefined; // RED and everything else → untagged static
    }
}

/**
 * Resolve the map designer's missing tag/ID wiring at load time. For every
 * collision box (except RED): derive its tag from its colour, find the sprite
 * instance it overlaps by the greatest intersection area (ignoring grass),
 * and give box + asset a shared object ID with one authoritative
 * classification entry — so movable boxes drag their artwork along.
 */
export function bindCollisionsToAssets(
    level: LevelData,
    textures: ReadonlyMap<string, HTMLImageElement>,
): void {
    const instances = level.sprite_instances ?? [];
    const shapes = level.collision_shapes ?? [];
    level.classifications ??= [];

    const assetRects: (Rect | null)[] = instances.map((inst) => {
        if (inst.path.startsWith(GRASS_PREFIX)) return null;
        const tex = textures.get(inst.path);
        if (!tex) return null;
        return new Rect(inst.x, inst.y, tex.naturalWidth * inst.scale, tex.naturalHeight * inst.scale);
    });

    shapes.forEach((shape, ci) => {
        const tag = tagForColor(shapeColor(shape));
        if (!tag) return;

        const boxRect = shapeBounds(shape);
        let best: { index: number; area: number } | null = null;
        assetRects.forEach((assetRect, ai) => {
            if (!assetRect) return;
            const area = boxRect.intersectionArea(assetRect);
            if (area > 0 && (!best || area > best.area)) best = { index: ai, area };
        });

        const id = shapeId(shape) || `bind_${ci}`;
        setShapeId(shape, id);
        if (best) instances[(best as { index: number }).index].id = id;
        const classifications = level.classifications as ClassificationEntry[];
        const existing = classifications.findIndex((e) => e.object_id === id);
        if (existing >= 0) classifications.splice(existing, 1);
        classifications.push({ object_id: id, tag });
    });
}

/** Map a level shape to its world-space collider. */
export function shapeToCollider(shape: LevelShape): Collider {
    if (isRect(shape)) {
        const r = shape.Rect;
        return aabb(new Rect(r.x, r.y, r.width, r.height));
    }
    const c = shape.Circle;
    return circleCollider(new Vec2(c.x, c.y), c.radius);
}

/**
 * The level's *static* collision layer: every shape not tagged
 * movable/item/bar. Solid to both the player and the chain.
 */
export function staticCollidersFrom(level: LevelData): Collider[] {
    return (level.collision_shapes ?? [])
        .filter((shape) => {
            const tag = getTag(level, shapeId(shape));
            return !isMovableTag(tag) && tag !== TAG_ITEM && tag !== TAG_BAR;
        })
        .map(shapeToCollider);
}

/** `bar`-tagged colliders: solid to the player, transparent to the chain. */
export function barCollidersFrom(level: LevelData): Collider[] {
    return (level.collision_shapes ?? [])
        .filter((shape) => getTag(level, shapeId(shape)) === TAG_BAR)
        .map(shapeToCollider);
}

/**
 * Spawn a chain-crushable squeezable for every `item`-tagged collision shape,
 * centred on the shape with a radius from its smaller half-extent.
 */
export function spawnItemSqueezables(level: LevelData, squeezables: Squeezables): void {
    for (const shape of level.collision_shapes ?? []) {
        if (getTag(level, shapeId(shape)) !== TAG_ITEM) continue;
        if (isRect(shape)) {
            const r = shape.Rect;
            squeezables.spawn(
                new Vec2(r.x + r.width / 2, r.y + r.height / 2),
                Math.min(r.width, r.height) / 2,
            );
        } else {
            const c = shape.Circle;
            squeezables.spawn(new Vec2(c.x, c.y), c.radius);
        }
    }
}

/** A pushable box derived from a `mov`-tagged collision rectangle. */
export interface MovableBox {
    /** Current world-space AABB. */
    rect: Rect;
    /** Initial top-left, restored on reset. */
    origin: Vec2;
    /** `(sprite index, offset from box top-left)` for rigidly-linked artwork. */
    sprites: { index: number; offset: Vec2 }[];
}

/**
 * Build the pushable boxes from the movable-tagged collision rectangles, each
 * linked to every sprite instance sharing its object ID. Only rectangles
 * become boxes (a movable tag on a circle is ignored).
 */
export function movableBoxesFrom(level: LevelData, snap: (v: number) => number): MovableBox[] {
    const boxes: MovableBox[] = [];
    for (const shape of level.collision_shapes ?? []) {
        if (!isMovableTag(getTag(level, shapeId(shape)))) continue;
        if (!isRect(shape)) continue;
        const r = shape.Rect;
        // Start on the grid; keep each sprite at its authored position by
        // baking the sub-cell difference into its offset.
        const rect = new Rect(snap(r.x), snap(r.y), r.width, r.height);
        const sprites = (level.sprite_instances ?? [])
            .map((inst, index) => ({ inst, index }))
            .filter(({ inst }) => inst.id === r.id)
            .map(({ inst, index }) => ({
                index,
                offset: new Vec2(inst.x - rect.x, inst.y - rect.y),
            }));
        boxes.push({ rect, origin: rect.position(), sprites });
    }
    return boxes;
}
