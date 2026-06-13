// §4.1 — Horizontal tool carousel, top-center of screen. Pure Three.js geometry on
// Layer 1 (renderOrder=1, depthTest=false, depthWrite=false via asMenuLayer). The LEFT
// hand drives it: finger gun opens it (handled by the caller, which calls open()), a
// horizontal flick navigates next/prev with wrap, a pinch selects the centered tool, a
// fist dismisses with no selection.
//
// Visual model (§4.1, §14.4):
//   - 6 tools in a horizontal strip. Active tool centered, full-brightness cyan. The wheel
//     shows up to two neighbors each side, smaller and dimmer the further out (a depth-faded
//     strip); everything past that is hidden.
//   - The active tool's name + icon are drawn centered below the strip.
//   - An index-finger swipe (index-tip horizontal velocity, supplied as g.vx) slides to the
//     next/prev tool — swiping left drags the strip left so the tool on the right slides to
//     center. The index wraps (6→1, 1→6). The slide is a 100ms ease-out snap.
//   - Pinch fires onSelect(id) then closes the carousel with an 80ms fade.
//   - Fist closes the carousel with no selection.
//   - Idle (non-active) items breathe on a slow 2s sine pulse; the active item also gets a
//     proximity glow that brightens as the navigation fingertip nears the strip.
//
// The whole Group is meant to be parented to the camera by the caller so it stays pinned
// at top-center; everything here is laid out in the group's local space around its origin.
// No per-frame allocation: every Vector3/Color/Matrix used in update() is a field reused
// across frames. Geometry/material/texture are created in the constructor and disposed in
// dispose(); open()/close() only toggle visibility + drive the fade, never reallocate.
import * as THREE from "three";
import type { GestureState } from "../types";
import { MENU_ORDER } from "../types";
import { MENU_META, T, FONT } from "../render/tokens";
import { asMenuLayer } from "../render/layers";
import { SwipeDetector } from "../gesture/swipe";

// A carousel entry. The wheel is generic over these, so the SAME component renders the tool
// wheel, the ADD SHAPES shape picker, and the INTERACT operation picker (item 5). `id` is an
// opaque string the caller maps back to its own enum / kind.
export interface CarouselItem {
    id: string;
    icon: string;
    label: string;
    accent: string;
}

// ---- Layout (group-local units; tuned so a camera-parented group reads top-center) ----
const ITEM_SPACING = 0.42;     // horizontal gap between adjacent tool centers
const ITEM_SIZE = 0.34;        // edge length of each square tool tile
const LABEL_W = 1.4;           // width of the name+icon label plane below the strip
const LABEL_H = 0.34;          // height of the label plane
const LABEL_DROP = 0.42;       // vertical offset of the label below the strip center
const VISIBLE_RADIUS = 2;      // how many neighbors each side are rendered (2 = up to 5 tiles)

// ---- Depth fade (§4.1) — opacity + scale by wheel-distance from the active tile, indexed
//      0 / 1 / 2. Tiles read as a depth-faded strip: smaller and dimmer the further out;
//      anything past VISIBLE_RADIUS is hidden. Opacity here is multiplied by the open fade.
const DIST_OPACITY = [1.0, 0.62, 0.32];  // centered / one out / two out — neighbours read clearer
const DIST_SCALE = [1.15, 0.85, 0.62];   // centered / one out / two out

// ---- Motion (§14.4) ----
const SNAP_MS = 100;           // ease-out slide between tools
const FADE_MS = 80;            // open/close fade (selection + fist dismiss)
const PULSE_PERIOD_MS = 2000;  // ambient idle pulse: slow 2s sine on emission
const PULSE_DEPTH = 0.18;      // peak-to-trough amplitude of the idle pulse
const PROXIMITY_RANGE = 0.6;   // navTip distance (group-local) over which glow ramps in

// ---- Index swipe (§4.1) — swiping the index fingertip horizontally steps the wheel one tool
//      per swipe. Detection is delegated to the shared SwipeDetector (gesture/swipe.ts), which
//      integrates g.vx over a short window so a finger-only flick registers reliably while a
//      single sweep is still exactly one step (cooldown + settle re-arm). Same detector and
//      tuning the SELECT / ADD SHAPES / INTERACT menus use, so the feel is identical.

// Pinch closure (rising edge) that selects the centered tool. Lowered from 0.7 so the
// (non-dominant) nav hand commits a selection as easily as the exec hand applies one.
const PINCH_SELECT = 0.6;

// ---- Texture resolution for the per-tool icon tiles + the label strip ----
const TILE_PX = 128;
const LABEL_PX_W = 512;
const LABEL_PX_H = 128;
const RING_PX = 256;

// ---- Centered-tool glow ring (§4.1 emphasis; §14.4 eased, never bouncy) ----
const RING_SIZE = ITEM_SIZE * 1.9;   // ring plane edge length (larger than the active tile)
const RING_BASE = 0.62;              // resting ring opacity at full fade, glow=0 — slightly brighter
const RING_GLOW = 0.45;              // extra opacity added as proximity glow ramps to 1

// One rendered tool tile: a textured plane (icon glyph baked once) plus its own material
// so opacity + emissive pulse can be driven independently per item.
interface Item {
    id: string;
    icon: string;
    label: string;
    accent: string;
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    texture: THREE.CanvasTexture;
    baseColor: THREE.Color;   // tool accent, premultiplied target at full brightness
}

// The default item set: the nine tools, derived from MENU_META. Passing no items to the
// Carousel constructor yields the tool wheel (so existing callers / tests are unchanged).
const TOOL_ITEMS: CarouselItem[] = MENU_ORDER.map((id) => ({
    id,
    icon: MENU_META[id].icon,
    label: MENU_META[id].label,
    accent: MENU_META[id].accent,
}));

// Ease-out cubic — precise, non-bouncy snap (§14.4 "Nothing bouncy").
function easeOutCubic(t: number): number {
    const u = 1 - t;
    return 1 - u * u * u;
}

// Bake a single tool's icon glyph onto a transparent canvas, tinted white so the plane's
// material color carries the accent. Returns a CanvasTexture ready for a plane.
function makeTileTexture(icon: string): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;
    const g = canvas.getContext("2d")!;
    g.clearRect(0, 0, TILE_PX, TILE_PX);

    // Rounded-square frame so each tile reads as a discrete chip.
    const pad = TILE_PX * 0.1;
    const r = TILE_PX * 0.16;
    const x0 = pad;
    const y0 = pad;
    const w = TILE_PX - pad * 2;
    const h = TILE_PX - pad * 2;
    g.beginPath();
    g.moveTo(x0 + r, y0);
    g.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
    g.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
    g.arcTo(x0, y0 + h, x0, y0, r);
    g.arcTo(x0, y0, x0 + w, y0, r);
    g.closePath();
    g.lineWidth = TILE_PX * 0.035;
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.stroke();

    // Centered icon glyph.
    g.fillStyle = "#FFFFFF";
    g.font = `bold ${Math.round(TILE_PX * 0.5)}px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(icon, TILE_PX / 2, TILE_PX / 2 + TILE_PX * 0.02);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

// Bake the centered-tool emphasis ring: a soft rounded-square halo tinted white so the
// plane's material color carries the active accent. Drawn once; the per-frame update only
// retints + fades it. Uses shadowBlur (not radial gradients) so it bakes in the headless
// test canvas stub as well as the browser.
function makeRingTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = RING_PX;
    canvas.height = RING_PX;
    const g = canvas.getContext("2d")!;
    g.clearRect(0, 0, RING_PX, RING_PX);

    const pad = RING_PX * 0.16;
    const r = RING_PX * 0.2;
    const x0 = pad;
    const y0 = pad;
    const w = RING_PX - pad * 2;
    const h = RING_PX - pad * 2;
    g.beginPath();
    g.moveTo(x0 + r, y0);
    g.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
    g.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
    g.arcTo(x0, y0 + h, x0, y0, r);
    g.arcTo(x0, y0, x0 + w, y0, r);
    g.closePath();

    // Two stroked passes (wide soft + tight bright) build a luminous rim without a gradient.
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.shadowColor = "rgba(255,255,255,0.9)";
    g.shadowBlur = RING_PX * 0.12;
    g.lineWidth = RING_PX * 0.05;
    g.stroke();
    g.shadowBlur = RING_PX * 0.04;
    g.lineWidth = RING_PX * 0.018;
    g.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

// Bake the active tool's name + icon onto the wide label strip below the carousel.
function drawLabel(canvas: HTMLCanvasElement, icon: string, label: string, accent: string): void {
    const g = canvas.getContext("2d")!;
    g.clearRect(0, 0, LABEL_PX_W, LABEL_PX_H);
    g.fillStyle = accent;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `bold ${Math.round(LABEL_PX_H * 0.42)}px ${FONT}`;
    const text = `${icon}  ${label}`;
    g.shadowColor = accent;
    g.shadowBlur = LABEL_PX_H * 0.18;
    g.fillText(text, LABEL_PX_W / 2, LABEL_PX_H / 2);
}

export class Carousel {
    readonly object: THREE.Group;
    isOpen = false;
    onSelect: ((id: string) => void) | null = null;

    private readonly allIds: string[];                    // every item id this wheel can show
    private readonly items: Item[] = [];
    private readonly itemById = new Map<string, Item>();  // tile lookup for the active subset
    // The navigable subset (in item order). open() sets this from the caller's eligible list;
    // navigation / label / select all run over `order`, and tiles whose id is not in `order`
    // are hidden. Defaults to every item.
    private order: string[];
    private readonly strip: THREE.Group;       // holds the tool tiles; slides horizontally
    private readonly label: THREE.Mesh;
    private readonly labelMat: THREE.MeshBasicMaterial;
    private readonly labelTex: THREE.CanvasTexture;
    private readonly labelCanvas: HTMLCanvasElement;
    private readonly ring: THREE.Mesh;          // glow halo pinned at screen-center behind the active tile
    private readonly ringMat: THREE.MeshBasicMaterial;
    private readonly ringTex: THREE.CanvasTexture;

    private active = 0;                          // index of centered item within `order`
    private slideFrom = 0;                       // strip x-offset at start of current snap
    private slideTo = 0;                         // target strip x-offset
    private slideMs = SNAP_MS;                   // elapsed → done when ≥ SNAP_MS
    private readonly swipe = new SwipeDetector(); // robust windowed swipe → one step per sweep

    private fade = 0;                            // 0 hidden .. 1 fully shown
    private fadeDir: 0 | 1 | -1 = 0;             // 0 idle, +1 opening, -1 closing
    private pendingSelect = false;               // close was triggered by a pinch-select
    private pinchLatched = false;                // pinch edge tracking

    private pulseMs = 0;                          // ambient pulse phase accumulator
    private glow = 0;                             // 0..1 proximity glow toward active tile

    // Reused scratch — zero per-frame allocation.
    private readonly tmpColor = new THREE.Color();
    private readonly tmpLocal = new THREE.Vector3();

    constructor(itemDefs: ReadonlyArray<CarouselItem> = TOOL_ITEMS) {
        this.object = new THREE.Group();
        this.object.name = "tool-carousel";
        this.object.visible = false;

        this.allIds = itemDefs.map((d) => d.id);
        this.order = [...this.allIds];

        // Centered-item glow ring: pinned at the group origin (screen-center) so it always
        // frames whichever tile is active. Added before the strip so the tile draws over it
        // within Layer 1's shared renderOrder; nudged back in z as a second guard.
        this.ringTex = makeRingTexture();
        this.ringMat = new THREE.MeshBasicMaterial({
            map: this.ringTex,
            color: new THREE.Color(itemDefs[0].accent),
            transparent: true,
            opacity: 0,
            toneMapped: false,
        });
        this.ring = new THREE.Mesh(new THREE.PlaneGeometry(RING_SIZE, RING_SIZE), this.ringMat);
        this.ring.position.set(0, 0, -0.01);
        this.object.add(this.ring);

        this.strip = new THREE.Group();
        this.strip.name = "tool-carousel-strip";
        this.object.add(this.strip);

        const tileGeo = new THREE.PlaneGeometry(ITEM_SIZE, ITEM_SIZE);
        for (const def of itemDefs) {
            const texture = makeTileTexture(def.icon);
            const material = new THREE.MeshBasicMaterial({
                map: texture,
                color: new THREE.Color(def.accent),
                transparent: true,
                opacity: 0,
                toneMapped: false,
            });
            const mesh = new THREE.Mesh(tileGeo, material);
            mesh.visible = false;
            this.strip.add(mesh);
            const item: Item = {
                id: def.id,
                icon: def.icon,
                label: def.label,
                accent: def.accent,
                mesh,
                material,
                texture,
                baseColor: new THREE.Color(def.accent),
            };
            this.items.push(item);
            this.itemById.set(def.id, item);
        }

        // Label strip below the carousel: name + icon of the active tool.
        this.labelCanvas = document.createElement("canvas");
        this.labelCanvas.width = LABEL_PX_W;
        this.labelCanvas.height = LABEL_PX_H;
        this.labelTex = new THREE.CanvasTexture(this.labelCanvas);
        this.labelTex.colorSpace = THREE.SRGBColorSpace;
        this.labelTex.anisotropy = 4;
        this.labelMat = new THREE.MeshBasicMaterial({
            map: this.labelTex,
            transparent: true,
            opacity: 0,
            toneMapped: false,
            depthTest: false,
            depthWrite: false,
        });
        this.label = new THREE.Mesh(new THREE.PlaneGeometry(LABEL_W, LABEL_H), this.labelMat);
        this.label.position.set(0, -LABEL_DROP, 0);
        this.object.add(this.label);

        // HARD RULE (§4.3): the ENTIRE object renders on Layer 1.
        asMenuLayer(this.object);

        this.layoutTiles();
        this.redrawLabel();
    }

    // Position every tile along the strip's local x so tile `i` sits at (i-active)*spacing
    // from the strip origin. The strip group itself is then offset by -active*spacing during
    // a snap so the active tile lands at x=0 (screen center).
    private layoutTiles(): void {
        for (let i = 0; i < this.items.length; i++) {
            this.items[i].mesh.position.set(i * ITEM_SPACING, 0, 0);
        }
        this.slideTo = -this.active * ITEM_SPACING;
        this.slideFrom = this.slideTo;
        this.slideMs = SNAP_MS;            // mark snap complete
        this.strip.position.x = this.slideTo;
    }

    private redrawLabel(): void {
        const it = this.itemById.get(this.order[this.active])!;
        drawLabel(this.labelCanvas, it.icon, it.label, it.accent);
        this.labelTex.needsUpdate = true;
    }

    /** The id of the currently centered item (what a pinch-select would emit). Lets a caller
     *  read the live choice when it drives the wheel as a swipe-only picker. */
    get current(): string {
        return this.order[this.active];
    }

    // Begin a 100ms ease-out snap from the current strip offset to the active tile's offset.
    private startSnap(): void {
        this.slideFrom = this.strip.position.x;
        this.slideTo = -this.active * ITEM_SPACING;
        this.slideMs = 0;
    }

    // Step the active index by ±1 with wrap (over the navigable subset), then snap + repaint.
    private step(dir: 1 | -1): void {
        const n = this.order.length;
        this.active = (this.active + dir + n) % n;
        this.startSnap();
        this.redrawLabel();
    }

    /** Materialize the carousel at the navigation fingertip (top-center). Fades in over
     *  120ms (open animation handled as part of the fade ramp). `eligible` is the navigable
     *  subset of tools for the current selection count (defaults to the full menu); the wheel
     *  shows and steps over only those. atTip seeds the proximity glow origin. */
    open(atTip: THREE.Vector3, eligible?: ReadonlyArray<string>): void {
        if (this.isOpen) return;
        this.isOpen = true;
        this.object.visible = true;
        this.fadeDir = 1;
        this.pendingSelect = false;
        this.pinchLatched = false;
        this.swipe.reset();
        this.glow = 0;
        this.tmpLocal.copy(atTip); // touch atTip so callers can rely on it being read
        // Adopt the eligible subset (fall back to all items) and center on its first item.
        this.order = eligible && eligible.length ? [...eligible] : [...this.allIds];
        this.active = 0;
        // Snap instantly to the current active tile on open (no slide from a stale offset).
        this.layoutTiles();
        this.redrawLabel();
    }

    /** Dismiss the carousel with an 80ms fade. No selection is emitted here; pinch-select
     *  routes through update() which sets pendingSelect before calling close(). */
    close(): void {
        if (!this.isOpen && this.fadeDir <= 0) return;
        this.isOpen = false;
        this.fadeDir = -1;
    }

    /**
     * Per-frame drive. `navTip` is the navigation (left) index-fingertip position in the
     * carousel group's local space (caller transforms world→local before passing it in);
     * `g` is the current gesture state of the navigation hand; `dt` is seconds.
     */
    update(navTip: THREE.Vector3, g: GestureState, dt: number): void {
        const dtMs = dt * 1000;

        // ---- Fade (open/close) ----
        if (this.fadeDir !== 0) {
            const span = this.fadeDir > 0 ? 120 : FADE_MS;
            this.fade += (this.fadeDir / span) * dtMs;
            if (this.fade >= 1) {
                this.fade = 1;
                this.fadeDir = 0;
            } else if (this.fade <= 0) {
                this.fade = 0;
                this.fadeDir = 0;
                this.object.visible = false;
                if (this.pendingSelect) {
                    this.pendingSelect = false;
                    this.onSelect?.(this.order[this.active]);
                }
                return; // fully closed: nothing else to drive this frame
            }
        }

        if (!this.object.visible) return;

        // ---- Gesture handling (only while open and not mid-close) ----
        if (this.isOpen) {
            // Fist → dismiss, no selection.
            if (g.name === "fist") {
                this.close();
            } else {
                // Pinch (rising edge) → select centered tool, then close with select pending.
                const pinching = g.name === "pinch" || g.pinch > PINCH_SELECT;
                if (pinching && !this.pinchLatched) {
                    this.pinchLatched = true;
                    this.pendingSelect = true;
                    this.close();
                } else if (!pinching) {
                    this.pinchLatched = false;
                }

                // Index swipe → one tool per swipe via the shared SwipeDetector (integrates
                // g.vx over a window, so a small finger flick registers and one sweep is one
                // step). g.vx > 0 is rightward; swiping LEFT (dir < 0) drags the strip left so
                // the tool on the right slides to center → step +1; rightward → -1.
                const dir = this.swipe.update(g.vx, dtMs);
                if (dir !== 0) this.step(dir > 0 ? -1 : 1);
            }
        }

        // ---- Snap animation (100ms ease-out) ----
        if (this.slideMs < SNAP_MS) {
            this.slideMs = Math.min(SNAP_MS, this.slideMs + dtMs);
            const k = easeOutCubic(this.slideMs / SNAP_MS);
            this.strip.position.x = this.slideFrom + (this.slideTo - this.slideFrom) * k;
        } else {
            this.strip.position.x = this.slideTo;
        }

        // ---- Proximity glow: brighten the active tile as navTip nears the strip center.
        this.tmpLocal.copy(navTip);
        const planar = Math.hypot(this.tmpLocal.x, this.tmpLocal.y);
        const target = Math.max(0, Math.min(1, 1 - planar / PROXIMITY_RANGE));
        // Smooth toward the target so the glow ramps over ~80ms rather than snapping.
        const glowK = Math.min(1, dtMs / 80);
        this.glow += (target - this.glow) * glowK;

        // ---- Ambient idle pulse (slow 2s sine on emission of non-active items) ----
        this.pulseMs = (this.pulseMs + dtMs) % PULSE_PERIOD_MS;
        const pulse = Math.sin((this.pulseMs / PULSE_PERIOD_MS) * Math.PI * 2);

        // ---- Per-item opacity + brightness + depth fade (over the navigable subset) ----
        // Hide every tile first; the loop below re-shows only the tools in `order`, so a tool
        // that is not eligible for the current selection count never appears.
        for (const item of this.items) {
            item.mesh.visible = false;
            item.material.opacity = 0;
        }

        const n = this.order.length;
        for (let oi = 0; oi < n; oi++) {
            const item = this.itemById.get(this.order[oi])!;
            // Shortest signed distance to the active tile around the subset ring, so wrap
            // neighbors read as adjacent. wo ∈ [-n/2, n/2]; tiles past VISIBLE_RADIUS hide.
            let wo = ((oi - this.active) % n + n) % n;
            if (wo > n / 2) wo -= n;
            const dist = Math.abs(wo);

            // Anchored to the active tile's base x (active*spacing) so the snap, which targets
            // -active*spacing, still centers it.
            item.mesh.position.x = (this.active + wo) * ITEM_SPACING;

            const visible = dist <= VISIBLE_RADIUS;
            item.mesh.visible = visible;
            if (!visible) {
                item.material.opacity = 0;
                continue;
            }

            // Active tile: full color, lifted by proximity glow. Idle tiles: dimmed and
            // breathing on the ambient sine (brightness scales the accent toward white-ish).
            this.tmpColor.copy(item.baseColor);
            if (dist === 0) {
                const lift = 1 + this.glow * 0.35;
                this.tmpColor.multiplyScalar(lift);
            } else {
                const breathe = 1 + pulse * PULSE_DEPTH;
                this.tmpColor.multiplyScalar(0.7 * breathe);
            }
            item.material.color.copy(this.tmpColor);
            const di = Math.min(dist, DIST_OPACITY.length - 1);
            item.material.opacity = DIST_OPACITY[di] * this.fade;

            // Shrink with distance for a depth-faded strip; the active tile takes the glow lift.
            const scale = DIST_SCALE[di] + (dist === 0 ? this.glow * 0.06 : 0);
            item.mesh.scale.setScalar(scale);
        }

        // ---- Centered-tool glow ring: tint to the active accent, then breathe + lift with
        //      the same proximity glow that brightens the active tile so the strip reads as a
        //      strip with one unmistakable focus. Color/opacity reuse scratch — no alloc.
        this.ringMat.color.copy(this.itemById.get(this.order[this.active])!.baseColor);
        const ringBreathe = 1 + pulse * (PULSE_DEPTH * 0.5);
        this.ringMat.opacity = (RING_BASE + this.glow * RING_GLOW) * ringBreathe * this.fade;
        this.ring.scale.setScalar((1 + this.glow * 0.08) * ringBreathe);

        // ---- Label opacity tracks the fade ----
        this.labelMat.opacity = this.fade;
    }

    // Release all GPU resources. Geometry is shared across tiles (created once), so dispose
    // it via the first item; per-item textures/materials are disposed individually.
    dispose(): void {
        for (const item of this.items) {
            item.texture.dispose();
            item.material.dispose();
        }
        if (this.items.length > 0) this.items[0].mesh.geometry.dispose();
        this.labelTex.dispose();
        this.labelMat.dispose();
        this.label.geometry.dispose();
        this.ringTex.dispose();
        this.ringMat.dispose();
        this.ring.geometry.dispose();
    }
}
