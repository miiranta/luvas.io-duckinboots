import { Rect, Vec2 } from '../engine/math';
import { LevelDocument, Shape } from '../engine/level';
import { Collider, aabb, circleCollider } from './collision';
import { Squeezables } from './squeezables';

/** Map a level shape to its world-space collider. */
export function shapeToCollider(shape: Shape): Collider {
    if (shape.kind === 'rect') return aabb(new Rect(shape.x, shape.y, shape.w, shape.h));
    return circleCollider(new Vec2(shape.x, shape.y), shape.r);
}

/**
 * The level's *static* collision layer: walls and water. Solid to both the
 * player and the chain.
 */
export function staticCollidersFrom(level: LevelDocument): Collider[] {
    return level.colliders
        .filter((c) => c.tag === 'wall' || c.tag === 'water')
        .map((c) => shapeToCollider(c.shape));
}

/** `bar` colliders: solid to the player, transparent to the chain. */
export function barCollidersFrom(level: LevelDocument): Collider[] {
    return level.colliders.filter((c) => c.tag === 'bar').map((c) => shapeToCollider(c.shape));
}

/**
 * Spawn a chain-crushable squeezable for every `item` collider, centred on
 * the shape with a radius from its smaller half-extent.
 */
export function spawnItemSqueezables(level: LevelDocument, squeezables: Squeezables): void {
    for (const { tag, shape } of level.colliders) {
        if (tag !== 'item') continue;
        if (shape.kind === 'rect') {
            squeezables.spawn(
                new Vec2(shape.x + shape.w / 2, shape.y + shape.h / 2),
                Math.min(shape.w, shape.h) / 2,
            );
        } else {
            squeezables.spawn(new Vec2(shape.x, shape.y), shape.r);
        }
    }
}

/** A pushable box derived from a `movable` collider rectangle. */
export interface MovableBox {
    /** Current world-space AABB. */
    rect: Rect;
    /** Initial top-left, restored on reset. */
    origin: Vec2;
    /** `(sprite index, offset from box top-left)` for rigidly-linked artwork. */
    sprites: { index: number; offset: Vec2 }[];
}

/**
 * Build the pushable boxes from the `movable` collider rectangles, each
 * linked to every sprite that names it via `colliderId`. Only rectangles
 * become boxes (a movable tag on a circle is ignored).
 */
export function movableBoxesFrom(level: LevelDocument, snap: (v: number) => number): MovableBox[] {
    const boxes: MovableBox[] = [];
    for (const { id, tag, shape } of level.colliders) {
        if (tag !== 'movable' || shape.kind !== 'rect') continue;
        // Start on the grid; keep each sprite at its authored position by
        // baking the sub-cell difference into its offset.
        const rect = new Rect(snap(shape.x), snap(shape.y), shape.w, shape.h);
        const sprites = level.sprites
            .map((sprite, index) => ({ sprite, index }))
            .filter(({ sprite }) => sprite.colliderId === id)
            .map(({ sprite, index }) => ({
                index,
                offset: new Vec2(sprite.x - rect.x, sprite.y - rect.y),
            }));
        boxes.push({ rect, origin: rect.position(), sprites });
    }
    return boxes;
}
