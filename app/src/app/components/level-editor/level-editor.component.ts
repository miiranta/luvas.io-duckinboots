import {
    Component,
    ElementRef,
    HostListener,
    OnDestroy,
    afterNextRender,
    inject,
    signal,
    viewChild,
} from '@angular/core';
import { GameService } from '../../services/game.service';
import { LevelStoreService } from '../../services/level-store.service';
import { I18nService } from '../../services/i18n.service';
import {
    ALL_TAGS,
    ColliderTag,
    LevelAsset,
    LevelCollider,
    LevelDocument,
    LevelSprite,
    TAG_COLORS,
    TAG_LABELS,
    cloneLevel,
    createEmptyLevel,
    newId,
    normalizeLevel,
    shapeBounds,
} from '../../../engine/level';
import { GameTexture, decodeAsset, fileToDataUrl } from '../../../engine/textures';
import { Rect, Vec2, clamp } from '../../../engine/math';

type Tool = 'select' | 'rect' | 'circle' | 'sprite' | 'start' | 'anchor' | 'erase';

type Selection = { kind: 'collider' | 'sprite'; id: string } | null;

/** What a pointer-drag is currently doing. */
type DragState =
    | { op: 'pan'; last: Vec2 }
    | { op: 'draw'; from: Vec2; to: Vec2 }
    | { op: 'move'; sel: NonNullable<Selection>; grab: Vec2 }
    | { op: 'resize'; id: string; corner: number }
    | { op: 'radius'; id: string }
    | null;

const HANDLE_PX = 7;
const MAX_UNDO = 60;

/**
 * The in-game level editor: a pannable/zoomable canvas over the level
 * document, with tools for drawing tagged colliders, placing imported
 * image/GIF sprites, and setting the player start / chain anchor. Levels
 * save to IndexedDB and can be exported/imported as JSON files.
 */
@Component({
    selector: 'app-level-editor',
    templateUrl: './level-editor.component.html',
    styleUrl: './level-editor.component.scss',
})
export class LevelEditorComponent implements OnDestroy {
    protected readonly game = inject(GameService);
    protected readonly store = inject(LevelStoreService);
    protected readonly i18n = inject(I18nService);

    private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

    protected readonly tags = ALL_TAGS;
    protected readonly tagColors = TAG_COLORS;
    protected readonly tagLabels = TAG_LABELS;

    protected level: LevelDocument = createEmptyLevel();
    protected readonly tool = signal<Tool>('rect');
    protected readonly tag = signal<ColliderTag>('wall');
    protected readonly selection = signal<Selection>(null);
    protected readonly placingAssetId = signal<string | null>(null);
    protected readonly spriteLayer = signal<'background' | 'entity'>('entity');
    protected readonly snapEnabled = signal(true);
    protected readonly status = signal('');
    protected readonly dirty = signal(false);
    /** Bumped on every level mutation so computed panel state refreshes. */
    protected readonly rev = signal(0);

    private textures = new Map<string, GameTexture>();
    private cam = { x: 0, y: 0, zoom: 1 };
    private drag: DragState = null;
    private hover = new Vec2(0, 0);
    private spaceHeld = false;
    private undoStack: string[] = [];
    private redoStack: string[] = [];
    private raf = 0;
    private statusTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        afterNextRender(() => {
            void this.loadInitial();
            const tick = () => {
                this.render();
                this.raf = requestAnimationFrame(tick);
            };
            this.raf = requestAnimationFrame(tick);
        });
    }

    ngOnDestroy(): void {
        cancelAnimationFrame(this.raf);
        for (const t of this.textures.values()) t.dispose();
    }

    private async loadInitial(): Promise<void> {
        const requested = this.game.editorLevel();
        this.setLevel(requested ? cloneLevel(requested) : createEmptyLevel());
    }

    private setLevel(doc: LevelDocument): void {
        for (const t of this.textures.values()) t.dispose();
        this.textures = new Map();
        this.level = doc;
        this.selection.set(null);
        this.undoStack = [];
        this.redoStack = [];
        this.cam = { x: doc.playerStart.x, y: doc.playerStart.y, zoom: 1 };
        this.dirty.set(false);
        this.rev.update((r) => r + 1);
        void this.decodeAll();
    }

    private async decodeAll(): Promise<void> {
        for (const asset of this.level.assets) void this.decodeOne(asset);
    }

    private async decodeOne(asset: LevelAsset): Promise<void> {
        try {
            const tex = await decodeAsset(asset);
            this.textures.get(asset.id)?.dispose();
            this.textures.set(asset.id, tex);
        } catch (e) {
            console.warn(`Failed to decode asset "${asset.name}"`, e);
        }
    }

    // ── Undo / mutation bookkeeping ──────────────────────────────────────────

    private snapshot(): void {
        this.undoStack.push(JSON.stringify(this.level));
        if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
        this.redoStack = [];
    }

    private touched(): void {
        this.dirty.set(true);
        this.rev.update((r) => r + 1);
    }

    protected undo(): void {
        const prev = this.undoStack.pop();
        if (!prev) return;
        this.redoStack.push(JSON.stringify(this.level));
        this.level = normalizeLevel(JSON.parse(prev));
        this.selection.set(null);
        this.touched();
        void this.decodeAll();
    }

    protected redo(): void {
        const next = this.redoStack.pop();
        if (!next) return;
        this.undoStack.push(JSON.stringify(this.level));
        this.level = normalizeLevel(JSON.parse(next));
        this.selection.set(null);
        this.touched();
        void this.decodeAll();
    }

    private flash(msg: string): void {
        this.status.set(msg);
        clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => this.status.set(''), 2200);
    }

    // ── Coordinate helpers ───────────────────────────────────────────────────

    private canvas(): HTMLCanvasElement {
        return this.canvasRef().nativeElement;
    }

    private worldFrom(e: PointerEvent | WheelEvent): Vec2 {
        const c = this.canvas();
        const r = c.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        return new Vec2(
            (sx - r.width / 2) / this.cam.zoom + this.cam.x,
            (sy - r.height / 2) / this.cam.zoom + this.cam.y,
        );
    }

    private snap(v: number): number {
        if (!this.snapEnabled()) return Math.round(v);
        const g = this.level.gridSize;
        return Math.round(v / g) * g;
    }

    private snapVec(v: Vec2): Vec2 {
        return new Vec2(this.snap(v.x), this.snap(v.y));
    }

    // ── Hit testing ──────────────────────────────────────────────────────────

    private colliderById(id: string): LevelCollider | undefined {
        return this.level.colliders.find((c) => c.id === id);
    }

    private spriteById(id: string): LevelSprite | undefined {
        return this.level.sprites.find((s) => s.id === id);
    }

    private spriteBounds(s: LevelSprite): Rect {
        const tex = this.textures.get(s.assetId);
        const w = tex ? tex.width * s.scale : 32;
        const h = tex ? tex.height * s.scale : 32;
        return new Rect(s.x, s.y, w, h);
    }

    private hitTest(p: Vec2): Selection {
        for (let i = this.level.sprites.length - 1; i >= 0; i--) {
            const s = this.level.sprites[i];
            if (this.spriteBounds(s).containsPoint(p)) return { kind: 'sprite', id: s.id };
        }
        for (let i = this.level.colliders.length - 1; i >= 0; i--) {
            const c = this.level.colliders[i];
            if (c.shape.kind === 'rect') {
                if (shapeBounds(c.shape).containsPoint(p)) return { kind: 'collider', id: c.id };
            } else {
                const d = new Vec2(c.shape.x, c.shape.y).distance(p);
                if (d <= c.shape.r) return { kind: 'collider', id: c.id };
            }
        }
        return null;
    }

    /** Corner handle (0..3: TL,TR,BR,BL) of the selected rect under `p`. */
    private hitHandle(p: Vec2): number | null {
        const sel = this.selection();
        if (!sel || sel.kind !== 'collider') return null;
        const c = this.colliderById(sel.id);
        if (!c || c.shape.kind !== 'rect') return null;
        const { x, y, w, h } = c.shape;
        const corners = [new Vec2(x, y), new Vec2(x + w, y), new Vec2(x + w, y + h), new Vec2(x, y + h)];
        const reach = HANDLE_PX / this.cam.zoom + 2;
        for (let i = 0; i < 4; i++) {
            if (corners[i].distance(p) <= reach) return i;
        }
        return null;
    }

    private hitRadiusHandle(p: Vec2): boolean {
        const sel = this.selection();
        if (!sel || sel.kind !== 'collider') return false;
        const c = this.colliderById(sel.id);
        if (!c || c.shape.kind !== 'circle') return false;
        const edge = new Vec2(c.shape.x + c.shape.r, c.shape.y);
        return edge.distance(p) <= HANDLE_PX / this.cam.zoom + 2;
    }

    // ── Pointer input ────────────────────────────────────────────────────────

    protected onPointerDown(e: PointerEvent): void {
        this.canvas().setPointerCapture(e.pointerId);
        const p = this.worldFrom(e);

        if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceHeld)) {
            this.drag = { op: 'pan', last: new Vec2(e.clientX, e.clientY) };
            return;
        }
        if (e.button !== 0) return;

        switch (this.tool()) {
            case 'rect':
            case 'circle':
                this.drag = { op: 'draw', from: this.snapVec(p), to: this.snapVec(p) };
                break;
            case 'sprite': {
                const assetId = this.placingAssetId();
                if (!assetId) {
                    this.flash(this.i18n.t('ed_pick_asset'));
                    break;
                }
                this.snapshot();
                this.level.sprites.push({
                    id: newId(),
                    assetId,
                    x: this.snap(p.x),
                    y: this.snap(p.y),
                    scale: 1,
                    layer: this.spriteLayer(),
                    colliderId: null,
                });
                this.touched();
                break;
            }
            case 'start':
                this.snapshot();
                this.level.playerStart = { x: this.snap(p.x), y: this.snap(p.y) };
                this.touched();
                break;
            case 'anchor':
                this.snapshot();
                this.level.chainAnchor = { x: this.snap(p.x), y: this.snap(p.y) };
                this.touched();
                break;
            case 'erase': {
                const hit = this.hitTest(p);
                if (hit) {
                    this.snapshot();
                    this.deleteSelectionObj(hit);
                    this.touched();
                }
                break;
            }
            case 'select': {
                const corner = this.hitHandle(p);
                if (corner !== null) {
                    const sel = this.selection() as { id: string };
                    this.snapshot();
                    this.drag = { op: 'resize', id: sel.id, corner };
                    break;
                }
                if (this.hitRadiusHandle(p)) {
                    const sel = this.selection() as { id: string };
                    this.snapshot();
                    this.drag = { op: 'radius', id: sel.id };
                    break;
                }
                const hit = this.hitTest(p);
                this.selection.set(hit);
                if (hit) {
                    this.snapshot();
                    const origin =
                        hit.kind === 'sprite'
                            ? this.spriteById(hit.id)
                            : this.colliderById(hit.id)?.shape;
                    this.drag = {
                        op: 'move',
                        sel: hit,
                        grab: origin ? p.sub(new Vec2(origin.x, origin.y)) : new Vec2(),
                    };
                }
                break;
            }
        }
    }

    protected onPointerMove(e: PointerEvent): void {
        const p = this.worldFrom(e);
        this.hover = p;
        const d = this.drag;
        if (!d) return;

        switch (d.op) {
            case 'pan': {
                const now = new Vec2(e.clientX, e.clientY);
                this.cam.x -= (now.x - d.last.x) / this.cam.zoom;
                this.cam.y -= (now.y - d.last.y) / this.cam.zoom;
                d.last = now;
                break;
            }
            case 'draw':
                d.to = this.snapVec(p);
                break;
            case 'move': {
                const at = this.snapVec(p.sub(d.grab));
                if (d.sel.kind === 'sprite') {
                    const s = this.spriteById(d.sel.id);
                    if (s) [s.x, s.y] = [at.x, at.y];
                } else {
                    const c = this.colliderById(d.sel.id);
                    if (c) [c.shape.x, c.shape.y] = [at.x, at.y];
                }
                this.touched();
                break;
            }
            case 'resize': {
                const c = this.colliderById(d.id);
                if (!c || c.shape.kind !== 'rect') break;
                const s = c.shape;
                const right = s.x + s.w;
                const bottom = s.y + s.h;
                const px = this.snap(p.x);
                const py = this.snap(p.y);
                if (d.corner === 0 || d.corner === 3) {
                    s.x = Math.min(px, right - 1);
                    s.w = right - s.x;
                } else {
                    s.w = Math.max(1, px - s.x);
                }
                if (d.corner === 0 || d.corner === 1) {
                    s.y = Math.min(py, bottom - 1);
                    s.h = bottom - s.y;
                } else {
                    s.h = Math.max(1, py - s.y);
                }
                this.touched();
                break;
            }
            case 'radius': {
                const c = this.colliderById(d.id);
                if (!c || c.shape.kind !== 'circle') break;
                c.shape.r = Math.max(2, this.snap(new Vec2(c.shape.x, c.shape.y).distance(p)));
                this.touched();
                break;
            }
        }
    }

    protected onPointerUp(): void {
        const d = this.drag;
        this.drag = null;
        if (!d || d.op !== 'draw') return;

        const from = d.from;
        const to = d.to;
        if (this.tool() === 'rect') {
            const x = Math.min(from.x, to.x);
            const y = Math.min(from.y, to.y);
            const w = Math.abs(to.x - from.x);
            const h = Math.abs(to.y - from.y);
            if (w < 2 || h < 2) return;
            this.snapshot();
            const collider: LevelCollider = {
                id: newId(),
                tag: this.tag(),
                shape: { kind: 'rect', x, y, w, h },
            };
            this.level.colliders.push(collider);
            this.selection.set({ kind: 'collider', id: collider.id });
        } else {
            const r = from.distance(to);
            if (r < 2) return;
            this.snapshot();
            const collider: LevelCollider = {
                id: newId(),
                tag: this.tag(),
                shape: { kind: 'circle', x: from.x, y: from.y, r: this.snap(r) || r },
            };
            this.level.colliders.push(collider);
            this.selection.set({ kind: 'collider', id: collider.id });
        }
        this.touched();
    }

    protected onWheel(e: WheelEvent): void {
        e.preventDefault();
        const before = this.worldFrom(e);
        this.cam.zoom = clamp(this.cam.zoom * Math.pow(1.15, -Math.sign(e.deltaY)), 0.1, 8);
        const after = this.worldFrom(e);
        this.cam.x += before.x - after.x;
        this.cam.y += before.y - after.y;
    }

    @HostListener('window:keydown', ['$event'])
    onKeyDown(e: KeyboardEvent): void {
        const target = e.target as HTMLElement;
        if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;

        if (e.code === 'Space') {
            this.spaceHeld = true;
            e.preventDefault();
            return;
        }
        if (e.ctrlKey || e.metaKey) {
            if (e.code === 'KeyZ') {
                e.preventDefault();
                if (e.shiftKey) this.redo();
                else this.undo();
            } else if (e.code === 'KeyY') {
                e.preventDefault();
                this.redo();
            } else if (e.code === 'KeyS') {
                e.preventDefault();
                void this.save();
            }
            return;
        }
        switch (e.code) {
            case 'Delete':
            case 'Backspace':
                this.deleteSelected();
                break;
            case 'Escape':
                this.selection.set(null);
                break;
            case 'KeyV':
                this.tool.set('select');
                break;
            case 'KeyR':
                this.tool.set('rect');
                break;
            case 'KeyC':
                this.tool.set('circle');
                break;
            case 'KeyG':
                this.snapEnabled.update((v) => !v);
                break;
            case 'ArrowLeft':
            case 'ArrowRight':
            case 'ArrowUp':
            case 'ArrowDown':
                this.nudge(e.code, e.shiftKey);
                break;
        }
    }

    @HostListener('window:keyup', ['$event'])
    onKeyUp(e: KeyboardEvent): void {
        if (e.code === 'Space') this.spaceHeld = false;
    }

    private nudge(code: string, fine: boolean): void {
        const sel = this.selection();
        if (!sel) return;
        const step = fine ? 1 : this.level.gridSize;
        const dx = code === 'ArrowLeft' ? -step : code === 'ArrowRight' ? step : 0;
        const dy = code === 'ArrowUp' ? -step : code === 'ArrowDown' ? step : 0;
        this.snapshot();
        const obj = sel.kind === 'sprite' ? this.spriteById(sel.id) : this.colliderById(sel.id)?.shape;
        if (obj) {
            obj.x += dx;
            obj.y += dy;
            this.touched();
        }
    }

    // ── Selection editing (panel + keys) ─────────────────────────────────────

    protected selectedCollider(): LevelCollider | null {
        this.rev();
        const sel = this.selection();
        return sel?.kind === 'collider' ? (this.colliderById(sel.id) ?? null) : null;
    }

    protected selectedSprite(): LevelSprite | null {
        this.rev();
        const sel = this.selection();
        return sel?.kind === 'sprite' ? (this.spriteById(sel.id) ?? null) : null;
    }

    /** Movable rect colliders a sprite can ride. */
    protected movableColliders(): LevelCollider[] {
        this.rev();
        return this.level.colliders.filter((c) => c.tag === 'movable' && c.shape.kind === 'rect');
    }

    private deleteSelectionObj(sel: NonNullable<Selection>): void {
        if (sel.kind === 'sprite') {
            this.level.sprites = this.level.sprites.filter((s) => s.id !== sel.id);
        } else {
            this.level.colliders = this.level.colliders.filter((c) => c.id !== sel.id);
            for (const s of this.level.sprites) {
                if (s.colliderId === sel.id) s.colliderId = null;
            }
        }
        if (this.selection()?.id === sel.id) this.selection.set(null);
    }

    protected deleteSelected(): void {
        const sel = this.selection();
        if (!sel) return;
        this.snapshot();
        this.deleteSelectionObj(sel);
        this.touched();
    }

    protected editShape(prop: 'x' | 'y' | 'w' | 'h' | 'r', value: string): void {
        const c = this.selectedCollider();
        const v = Number(value);
        if (!c || !Number.isFinite(v)) return;
        this.snapshot();
        const s = c.shape as unknown as Record<string, number>;
        if (prop in s) s[prop] = v;
        this.touched();
    }

    protected editTag(tag: string): void {
        const c = this.selectedCollider();
        if (!c) return;
        this.snapshot();
        c.tag = tag as ColliderTag;
        this.touched();
    }

    protected editSprite(prop: 'x' | 'y' | 'scale', value: string): void {
        const s = this.selectedSprite();
        const v = Number(value);
        if (!s || !Number.isFinite(v)) return;
        this.snapshot();
        s[prop] = v;
        this.touched();
    }

    protected editSpriteLayer(layer: string): void {
        const s = this.selectedSprite();
        if (!s) return;
        this.snapshot();
        s.layer = layer === 'background' ? 'background' : 'entity';
        this.touched();
    }

    protected editSpriteRide(colliderId: string): void {
        const s = this.selectedSprite();
        if (!s) return;
        this.snapshot();
        s.colliderId = colliderId || null;
        this.touched();
    }

    protected editName(name: string): void {
        this.level.name = name;
        this.dirty.set(true);
    }

    protected editGridSize(value: string): void {
        const v = Number(value);
        if (Number.isFinite(v) && v >= 1) {
            this.level.gridSize = Math.round(v);
            this.touched();
        }
    }

    protected editChainLength(value: string): void {
        const v = Number(value);
        if (Number.isFinite(v) && v >= 100) {
            this.level.chainLength = Math.round(v);
            this.touched();
        }
    }

    // ── Assets ───────────────────────────────────────────────────────────────

    protected async importAssets(event: Event): Promise<void> {
        const files = (event.target as HTMLInputElement).files;
        if (!files?.length) return;
        this.snapshot();
        for (const file of Array.from(files)) {
            const asset: LevelAsset = {
                id: newId(),
                name: file.name.replace(/\.[^.]+$/, ''),
                mime: file.type || 'image/png',
                data: await fileToDataUrl(file),
            };
            this.level.assets.push(asset);
            await this.decodeOne(asset);
            this.placingAssetId.set(asset.id);
        }
        this.tool.set('sprite');
        this.touched();
        (event.target as HTMLInputElement).value = '';
    }

    protected deleteAsset(id: string): void {
        this.snapshot();
        this.level.assets = this.level.assets.filter((a) => a.id !== id);
        this.level.sprites = this.level.sprites.filter((s) => s.assetId !== id);
        this.textures.get(id)?.dispose();
        this.textures.delete(id);
        if (this.placingAssetId() === id) this.placingAssetId.set(null);
        this.touched();
    }

    protected async editAssetFps(asset: LevelAsset, value: string): Promise<void> {
        const v = Number(value);
        asset.fps = Number.isFinite(v) && v > 0 ? v : undefined;
        this.dirty.set(true);
        await this.decodeOne(asset);
    }

    protected pickAsset(id: string): void {
        this.placingAssetId.set(id);
        this.tool.set('sprite');
    }

    protected isAnimated(id: string): boolean {
        return this.textures.get(id)?.animated ?? false;
    }

    // ── File / store operations ──────────────────────────────────────────────

    protected async save(): Promise<void> {
        // Editing a built-in level forks it into a user copy.
        if (await this.store.isBuiltin(this.level.id)) {
            this.level.id = newId();
            this.level.name = `${this.level.name} (copy)`;
            this.rev.update((r) => r + 1);
        }
        await this.store.save(this.level);
        this.dirty.set(false);
        this.flash(this.i18n.t('ed_saved'));
    }

    protected exportJson(): void {
        const blob = new Blob([JSON.stringify(this.level, null, 2)], {
            type: 'application/json',
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${this.level.name.replace(/[^\w-]+/g, '_') || 'level'}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    protected async importJson(event: Event): Promise<void> {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
            const doc = normalizeLevel(JSON.parse(await file.text()));
            this.setLevel(doc);
            this.flash(this.i18n.t('ed_imported'));
        } catch {
            this.flash(this.i18n.t('ed_import_failed'));
        }
        (event.target as HTMLInputElement).value = '';
    }

    protected newLevel(): void {
        this.setLevel(createEmptyLevel());
    }

    protected async playTest(): Promise<void> {
        await this.save();
        this.game.editorLevel.set(this.level);
        await this.game.playLevel(this.level, 'editor');
    }

    protected backToMenu(): void {
        this.game.backToMenu();
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private render(): void {
        const canvas = this.canvas();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (!w || !h) return;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#0a0e1c';
        ctx.fillRect(0, 0, w / dpr, h / dpr);

        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        ctx.translate(cw / 2, ch / 2);
        ctx.scale(this.cam.zoom, this.cam.zoom);
        ctx.translate(-this.cam.x, -this.cam.y);
        ctx.imageSmoothingEnabled = false;

        const view = new Rect(
            this.cam.x - cw / 2 / this.cam.zoom,
            this.cam.y - ch / 2 / this.cam.zoom,
            cw / this.cam.zoom,
            ch / this.cam.zoom,
        );

        this.drawGrid(ctx, view);
        this.drawSprites(ctx, 'background');
        this.drawColliders(ctx);
        this.drawSprites(ctx, 'entity');
        this.drawMarkers(ctx);
        this.drawSelection(ctx);
        this.drawDragPreview(ctx);
        this.drawGhost(ctx);
    }

    private drawGrid(ctx: CanvasRenderingContext2D, view: Rect): void {
        const g = this.level.gridSize;
        if (g * this.cam.zoom >= 6) {
            ctx.strokeStyle = 'rgb(255 255 255 / 5%)';
            ctx.lineWidth = 1 / this.cam.zoom;
            ctx.beginPath();
            for (let x = Math.floor(view.x / g) * g; x < view.right; x += g) {
                ctx.moveTo(x, view.y);
                ctx.lineTo(x, view.bottom);
            }
            for (let y = Math.floor(view.y / g) * g; y < view.bottom; y += g) {
                ctx.moveTo(view.x, y);
                ctx.lineTo(view.right, y);
            }
            ctx.stroke();
        }
        // Origin axes.
        ctx.strokeStyle = 'rgb(232 189 74 / 25%)';
        ctx.lineWidth = 1 / this.cam.zoom;
        ctx.beginPath();
        ctx.moveTo(view.x, 0);
        ctx.lineTo(view.right, 0);
        ctx.moveTo(0, view.y);
        ctx.lineTo(0, view.bottom);
        ctx.stroke();
    }

    private drawColliders(ctx: CanvasRenderingContext2D): void {
        for (const { tag, shape } of this.level.colliders) {
            const color = TAG_COLORS[tag];
            ctx.fillStyle = color + '55';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2 / this.cam.zoom;
            if (shape.kind === 'rect') {
                ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
                ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
            } else {
                ctx.beginPath();
                ctx.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
    }

    private drawSprites(ctx: CanvasRenderingContext2D, layer: 'background' | 'entity'): void {
        const now = performance.now();
        for (const s of this.level.sprites) {
            if (s.layer !== layer) continue;
            const tex = this.textures.get(s.assetId);
            if (!tex) {
                ctx.fillStyle = 'rgb(255 0 128 / 30%)';
                ctx.fillRect(s.x, s.y, 32, 32);
                continue;
            }
            ctx.drawImage(
                tex.frameAt(now),
                s.x,
                s.y,
                tex.width * s.scale,
                tex.height * s.scale,
            );
        }
    }

    private drawMarkers(ctx: CanvasRenderingContext2D): void {
        const lw = 2 / this.cam.zoom;
        // Player start: green duck box.
        const ps = this.level.playerStart;
        ctx.strokeStyle = '#3fe36f';
        ctx.lineWidth = lw;
        ctx.strokeRect(ps.x, ps.y, 32, 32);
        this.label(ctx, 'START', ps.x + 16, ps.y - 6, '#3fe36f');
        // Chain anchor: gold ring.
        const an = this.level.chainAnchor;
        ctx.strokeStyle = '#e8bd4a';
        ctx.beginPath();
        ctx.arc(an.x, an.y, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#e8bd4a';
        ctx.beginPath();
        ctx.arc(an.x, an.y, 3, 0, Math.PI * 2);
        ctx.fill();
        this.label(ctx, 'ANCHOR', an.x, an.y - 14, '#e8bd4a');
    }

    private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = `${12 / this.cam.zoom}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    private drawSelection(ctx: CanvasRenderingContext2D): void {
        const sel = this.selection();
        if (!sel) return;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5 / this.cam.zoom;
        ctx.setLineDash([6 / this.cam.zoom, 4 / this.cam.zoom]);

        const hs = HANDLE_PX / this.cam.zoom;
        if (sel.kind === 'sprite') {
            const s = this.spriteById(sel.id);
            if (s) {
                const b = this.spriteBounds(s);
                ctx.strokeRect(b.x, b.y, b.width, b.height);
            }
        } else {
            const c = this.colliderById(sel.id);
            if (c?.shape.kind === 'rect') {
                const { x, y, w, h } = c.shape;
                ctx.strokeRect(x, y, w, h);
                ctx.setLineDash([]);
                ctx.fillStyle = '#fff';
                for (const [hx, hy] of [
                    [x, y],
                    [x + w, y],
                    [x + w, y + h],
                    [x, y + h],
                ]) {
                    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
                }
            } else if (c) {
                ctx.beginPath();
                ctx.arc(c.shape.x, c.shape.y, c.shape.r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#fff';
                ctx.fillRect(c.shape.x + c.shape.r - hs / 2, c.shape.y - hs / 2, hs, hs);
            }
        }
        ctx.setLineDash([]);
    }

    private drawDragPreview(ctx: CanvasRenderingContext2D): void {
        const d = this.drag;
        if (!d || d.op !== 'draw') return;
        const color = TAG_COLORS[this.tag()];
        ctx.fillStyle = color + '44';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 / this.cam.zoom;
        if (this.tool() === 'rect') {
            const x = Math.min(d.from.x, d.to.x);
            const y = Math.min(d.from.y, d.to.y);
            ctx.fillRect(x, y, Math.abs(d.to.x - d.from.x), Math.abs(d.to.y - d.from.y));
            ctx.strokeRect(x, y, Math.abs(d.to.x - d.from.x), Math.abs(d.to.y - d.from.y));
        } else {
            ctx.beginPath();
            ctx.arc(d.from.x, d.from.y, d.from.distance(d.to), 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }

    /** Translucent preview of the asset about to be placed. */
    private drawGhost(ctx: CanvasRenderingContext2D): void {
        if (this.tool() !== 'sprite' || this.drag) return;
        const assetId = this.placingAssetId();
        const tex = assetId ? this.textures.get(assetId) : undefined;
        if (!tex) return;
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.drawImage(
            tex.frameAt(performance.now()),
            this.snap(this.hover.x),
            this.snap(this.hover.y),
            tex.width,
            tex.height,
        );
        ctx.restore();
    }
}
