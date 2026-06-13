// §5.2 — the radial ring menu. When the LEFT hand forms a "gun" pose, main.ts (P3)
// opens this ring around the left index fingertip in 3D space: the 8 menus (MENU_ORDER)
// laid out in a circle, each a glowing icon+label tile. The left hand rotates to aim
// the index finger at a tile (dwell-highlight); a left pinch selects it; a left fist
// dismisses (main.ts calls close()). This module owns ONLY the ring visuals + hit-test;
// it does not read poses or know about MenuRouter — main.ts feeds it world vectors.
import * as THREE from "three";
import type { MenuId } from "../types";
import { MENU_ORDER } from "../types";
import { MENU_META } from "../render/tokens";

// Per-tile canvas resolution (square icon + label card).
const TILE_TEX = 192;
// World size of each tile and the radius of the circle the tiles sit on (metres),
// scaled so the ring frames the user's fingertip without occluding the object.
const TILE_SIZE = 0.42;
const RING_RADIUS = 1.15;
// Fade-in duration on open (§5.2).
const FADE_MS = 120;
// A tile counts as "aimed at" when the angle between the aim direction and the tile's
// direction-from-centre is within this cone (radians ~30°).
const AIM_CONE = Math.PI / 6;
// Pinch closure (0..1) above which a pinch is considered "closed" for selection.
const PINCH_SELECT = 0.7;
const BG_HEX = "#0A0A0A";
const FONT_FAMILY = '"JetBrains Mono", monospace';

interface Tile {
    id: MenuId;
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    texture: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
    accent: string;
    // Unit direction from ring centre to this tile, in the ring's local plane.
    dir: THREE.Vector3;
    highlighted: boolean;
}

export class RadialRing {
    readonly object: THREE.Object3D;
    private readonly tiles: Tile[] = [];
    private open_ = false;
    private fadeStart = 0;
    private hovered: MenuId | null = null;
    // Rising-edge latch: only fire a selection on the transition open->closed pinch.
    private pinchWasClosed = false;
    // Scratch reused by update() — zero per-frame allocation.
    private readonly toTip = new THREE.Vector3();
    private readonly aimFlat = new THREE.Vector3();
    private readonly tileDir = new THREE.Vector3();

    constructor() {
        this.object = new THREE.Group();
        this.object.renderOrder = 20;
        this.object.visible = false;

        // Lay the 8 tiles out evenly around the circle, first tile at the top (+Y),
        // proceeding clockwise so the on-screen order matches MENU_ORDER.
        const count = MENU_ORDER.length;
        for (let i = 0; i < count; i++) {
            const id = MENU_ORDER[i];
            const angle = Math.PI / 2 - (i / count) * Math.PI * 2;
            const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);

            const canvas = document.createElement("canvas");
            canvas.width = TILE_TEX;
            canvas.height = TILE_TEX;
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;

            const material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
                toneMapped: false,
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE), material);
            mesh.position.copy(dir).multiplyScalar(RING_RADIUS);
            mesh.renderOrder = 21;

            const tile: Tile = {
                id,
                mesh,
                material,
                texture,
                canvas,
                accent: MENU_META[id].accent,
                dir,
                highlighted: false,
            };
            this.paintTile(tile, false);
            this.object.add(mesh);
            this.tiles.push(tile);
        }
    }

    get isOpen(): boolean {
        return this.open_;
    }

    // Show the ring centred at the fingertip and start the 120ms fade-in.
    open(centerWorld: THREE.Vector3): void {
        this.object.position.copy(centerWorld);
        this.object.visible = true;
        this.open_ = true;
        this.fadeStart = performance.now();
        this.hovered = null;
        this.pinchWasClosed = false;
        for (const t of this.tiles) this.setHighlight(t, false);
    }

    close(): void {
        this.open_ = false;
        this.object.visible = false;
        this.hovered = null;
        this.pinchWasClosed = false;
        for (const t of this.tiles) {
            t.material.opacity = 1;
            this.setHighlight(t, false);
        }
    }

    // Per-frame: ramp the fade-in, billboard the ring to face the camera, and
    // dwell-highlight whichever tile the left index is aiming at. main.ts supplies the
    // left index fingertip world position (ring centre follows it), the aim direction
    // (the index-finger pointing direction in world space), and the camera.
    update(leftIndexTipWorld: THREE.Vector3, leftAimDir: THREE.Vector3, camera: THREE.Camera): void {
        if (!this.open_) return;

        // Follow the fingertip and face the camera (full billboard — the ring is a flat
        // disc of tiles, so it should squarely face the viewer, not Y-lock).
        this.object.position.copy(leftIndexTipWorld);
        this.object.quaternion.copy(camera.quaternion);

        // Fade-in ramp over FADE_MS.
        const k = Math.min(1, (performance.now() - this.fadeStart) / FADE_MS);
        for (const t of this.tiles) t.material.opacity = k;

        // Project the aim direction into the ring's plane so the dwell test is 2D within
        // the tile circle. The ring's orientation was just set equal to the camera's, so
        // its world right/up axes ARE the camera's right/up — read them straight from the
        // camera world matrix (columns 0 and 1), which is up to date this frame. This
        // avoids depending on the ring's own matrixWorld, which is only refreshed during
        // the render traversal (one frame stale at this point).
        this.aimFlat.copy(leftAimDir);
        const right = this.tileDir.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        const up = this.toTip.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
        const ax = this.aimFlat.dot(right);
        const ay = this.aimFlat.dot(up);
        const aLen = Math.hypot(ax, ay);

        let best: MenuId | null = null;
        if (aLen > 1e-4) {
            const nx = ax / aLen;
            const ny = ay / aLen;
            let bestDot = Math.cos(AIM_CONE);
            for (const t of this.tiles) {
                // Tile direction is in the same local plane (its mesh.position dir).
                const dot = t.dir.x * nx + t.dir.y * ny;
                if (dot > bestDot) {
                    bestDot = dot;
                    best = t.id;
                }
            }
        }

        if (best !== this.hovered) {
            this.hovered = best;
            for (const t of this.tiles) this.setHighlight(t, t.id === best);
        }
    }

    // Edge-triggered selection: when the left pinch transitions into the closed state
    // (closure crosses PINCH_SELECT upward), return the currently hovered MenuId (or
    // null if none is hovered). Returns null on every other frame, including while the
    // pinch is held closed, so a single pinch selects exactly once.
    pickOnPinch(leftPinchAmount: number): MenuId | null {
        if (!this.open_) return null;
        const closed = leftPinchAmount >= PINCH_SELECT;
        let picked: MenuId | null = null;
        if (closed && !this.pinchWasClosed) picked = this.hovered;
        this.pinchWasClosed = closed;
        return picked;
    }

    private setHighlight(tile: Tile, on: boolean): void {
        if (tile.highlighted === on) return;
        tile.highlighted = on;
        this.paintTile(tile, on);
    }

    // Draw a tile's icon (large, centred) above its label. Highlighted tiles fill the
    // background with a dim accent wash and draw a brighter border (rim/selection glow,
    // §5.4); idle tiles use the black card with a thin accent border.
    private paintTile(tile: Tile, highlighted: boolean): void {
        const g = tile.canvas.getContext("2d");
        if (!g) return;
        const s = TILE_TEX;
        g.clearRect(0, 0, s, s);

        g.fillStyle = BG_HEX;
        g.fillRect(0, 0, s, s);
        if (highlighted) {
            g.fillStyle = this.withAlpha(tile.accent, 0.22);
            g.fillRect(0, 0, s, s);
        }

        g.strokeStyle = tile.accent;
        g.lineWidth = highlighted ? 8 : 3;
        g.strokeRect(2, 2, s - 4, s - 4);

        const meta = MENU_META[tile.id];
        g.fillStyle = tile.accent;
        g.textAlign = "center";

        g.textBaseline = "middle";
        g.font = `bold 84px ${FONT_FAMILY}`;
        g.fillText(meta.icon, s / 2, s * 0.40);

        g.textBaseline = "alphabetic";
        g.font = `bold 22px ${FONT_FAMILY}`;
        g.fillText(meta.label, s / 2, s * 0.86);

        tile.texture.needsUpdate = true;
    }

    // Expand a #RRGGBB accent to an rgba() string at the given alpha for the wash fill.
    private withAlpha(hex: string, alpha: number): string {
        const h = hex.replace("#", "");
        const r = parseInt(h.slice(0, 2), 16);
        const gg = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        return `rgba(${r},${gg},${b},${alpha})`;
    }
}
