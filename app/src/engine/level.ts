import { Rect, Vec2 } from './math';

/**
 * The serialized level format authored in the (Rust) map editor. The JSON is
 * loaded verbatim from `assets/level.json`; these types mirror its schema.
 */

export interface RectShape {
    Rect: {
        id: string;
        x: number;
        y: number;
        width: number;
        height: number;
        color: LevelColor;
    };
}

export interface CircleShape {
    Circle: {
        id: string;
        x: number;
        y: number;
        radius: number;
        color: LevelColor;
    };
}

export type LevelShape = RectShape | CircleShape;

export interface LevelColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

export interface SpriteInstance {
    id: string;
    path: string;
    x: number;
    y: number;
    scale: number;
    background?: boolean;
}

export interface ClassificationEntry {
    object_id: string;
    tag: string;
}

export interface LevelData {
    sprite_shapes?: LevelShape[];
    collision_shapes?: LevelShape[];
    sprite_instances?: SpriteInstance[];
    classifications?: ClassificationEntry[];
    player_start?: { x: number; y: number } | null;
    grid_size?: number;
}

export function isRect(shape: LevelShape): shape is RectShape {
    return 'Rect' in shape;
}

export function shapeId(shape: LevelShape): string {
    return isRect(shape) ? shape.Rect.id : shape.Circle.id;
}

export function setShapeId(shape: LevelShape, id: string): void {
    if (isRect(shape)) shape.Rect.id = id;
    else shape.Circle.id = id;
}

export function shapeColor(shape: LevelShape): LevelColor {
    return isRect(shape) ? shape.Rect.color : shape.Circle.color;
}

export function shapeBounds(shape: LevelShape): Rect {
    if (isRect(shape)) {
        const r = shape.Rect;
        return new Rect(r.x, r.y, r.width, r.height);
    }
    const c = shape.Circle;
    return new Rect(c.x - c.radius, c.y - c.radius, c.radius * 2, c.radius * 2);
}

/** Classification tag lookup: the first entry matching the object id wins. */
export function getTag(level: LevelData, id: string): string | undefined {
    return level.classifications?.find((e) => e.object_id === id)?.tag;
}

export function playerStart(level: LevelData): Vec2 | undefined {
    const p = level.player_start;
    return p ? new Vec2(p.x, p.y) : undefined;
}
