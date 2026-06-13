// §5.3 — the in-menu spatial panel: a floating billboard card rendered in 3D space
// beside the active object. It is a real scene object (a Plane mesh carrying a
// CanvasTexture), NOT an HTML overlay, so it lights/composites with the rest of the
// scene. Each menu module owns one SpatialPanel, repaints it via draw() with its own
// affordance content, and re-places it beside the mesh every frame via placeBeside().
//
// Visual spec (§5.3, §15): black #0A0A0A background, an accent-colored border, and
// JetBrains Mono text. The card is billboard-locked on the world Y axis (it never
// tips forward/back) and angled to face the camera horizontally so it stays legible.
import * as THREE from "three";

// Canvas backing resolution. 4:3 card; high enough that JetBrains Mono stays crisp at
// the on-screen size without paying for a 1024-square texture every repaint.
const TEX_W = 512;
const TEX_H = 384;

// World-space size of the plane (metres). Tuned to sit comfortably beside the unit
// sphere/donut (radius ~1) at the camera distance set in scene.ts.
const PLANE_W = 1.6;
const PLANE_H = 1.2;

// Card background and typography (§5.3 / §15.1).
const BG_HEX = "#0A0A0A";
const FONT_FAMILY = '"JetBrains Mono", monospace';

// Horizontal gap from the object's centre to the card's centre (metres), placed to
// the object's right from the camera's point of view. Far enough that the card clears
// the donut (outer radius ~1.4) while the card stays comfortably on screen.
const SIDE_OFFSET = 2.2;

export class SpatialPanel {
    readonly object: THREE.Object3D;
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx2d: CanvasRenderingContext2D;
    private readonly texture: THREE.CanvasTexture;
    private readonly material: THREE.MeshBasicMaterial;
    private readonly geometry: THREE.PlaneGeometry;
    private readonly accent: string;
    // Scratch reused by placeBeside so the panel itself never allocates per frame.
    private readonly camRight = new THREE.Vector3();
    private readonly target = new THREE.Vector3();
    private readonly lookAt = new THREE.Vector3();

    constructor(accentHex: string) {
        this.accent = accentHex;

        this.canvas = document.createElement("canvas");
        this.canvas.width = TEX_W;
        this.canvas.height = TEX_H;
        const ctx2d = this.canvas.getContext("2d");
        if (!ctx2d) throw new Error("SpatialPanel: 2D canvas context unavailable");
        this.ctx2d = ctx2d;

        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.colorSpace = THREE.SRGBColorSpace;
        // Card texture is not power-of-two; clamp + linear keeps text edges clean.
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.wrapS = THREE.ClampToEdgeWrapping;
        this.texture.wrapT = THREE.ClampToEdgeWrapping;

        this.material = new THREE.MeshBasicMaterial({
            map: this.texture,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
        });
        this.geometry = new THREE.PlaneGeometry(PLANE_W, PLANE_H);
        this.object = new THREE.Mesh(this.geometry, this.material);
        this.object.renderOrder = 10;

        // Paint an empty bordered card up front so the panel is legible the instant a
        // menu adds it, before its first content draw() call.
        this.draw(() => {});
    }

    // Repaint the card. The module supplies a paint callback that draws affordance
    // content (labels, sliders, readouts) onto the 2D context; this method first lays
    // down the standard black background + accent border, then invokes the callback,
    // then flags the GPU texture for re-upload.
    draw(paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): void {
        const g = this.ctx2d;
        g.clearRect(0, 0, TEX_W, TEX_H);

        // Background.
        g.fillStyle = BG_HEX;
        g.fillRect(0, 0, TEX_W, TEX_H);

        // Accent border, inset so the full stroke is visible.
        g.strokeStyle = this.accent;
        g.lineWidth = 4;
        g.strokeRect(2, 2, TEX_W - 4, TEX_H - 4);

        // Sensible defaults so a module can paint text without re-stating the font.
        g.fillStyle = this.accent;
        g.font = `bold 30px ${FONT_FAMILY}`;
        g.textBaseline = "top";

        paint(g, TEX_W, TEX_H);
        this.texture.needsUpdate = true;
    }

    // Re-place the card beside the object each frame: offset to the object's right
    // (camera-relative right, flattened to horizontal) and Y-billboarded so it faces
    // the camera without tipping. We zero the vertical component of the camera-right
    // vector so the offset never lifts/sinks the card, then lookAt a point that shares
    // the card's own height — keeping it upright (no pitch/roll) while yawing to camera.
    placeBeside(objectWorldPos: THREE.Vector3, camera: THREE.Camera): void {
        // Camera-relative right = column 0 of the camera world matrix.
        this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
        this.camRight.y = 0;
        if (this.camRight.lengthSq() < 1e-8) {
            this.camRight.set(1, 0, 0); // degenerate top-down view fallback
        }
        this.camRight.normalize();

        this.target.copy(objectWorldPos).addScaledVector(this.camRight, SIDE_OFFSET);
        this.object.position.copy(this.target);

        // Y-locked billboard: look toward the camera but at the card's own height, so
        // only the yaw changes (card stays vertical).
        this.lookAt.set(camera.position.x, this.target.y, camera.position.z);
        this.object.up.set(0, 1, 0);
        this.object.lookAt(this.lookAt);
    }

    // Free GPU/CPU resources. The owning module removes object from the scene first.
    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
        this.texture.dispose();
    }
}
