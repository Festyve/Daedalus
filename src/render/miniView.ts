// Top-right mini viewport — the AutoCAD/Blender-style orientation indicator for Camera Orbit
// Mode (SPEC — Camera Orbit Mode, Part 1).
//
// A small fixed-size box in the top-right corner showing an X/Y/Z axis triad rendered from
// the SAME orientation the main camera currently views the world. As the user orbits, the
// triad turns with the view, so they always read which way the world axes point — "know your
// orientation". It is its own tiny scene + camera, drawn as a scissored pass over the main
// canvas (the same technique main.ts uses for the bottom-right black-scene preview).
//
// The triad mirrors the main camera by copying its world orientation onto the mini camera and
// standing the mini camera off the origin along the view's back-vector — so the fixed triad at
// the mini scene's origin is seen at the identical azimuth/elevation as the real view.
import * as THREE from "three";
import { makeAxisTriad, type AxisTriad } from "./axisTriad";
import { T } from "./tokens";

// Box size as a fraction of the smaller screen dimension, clamped to a sane pixel range, with
// a margin from the screen edges (CSS/logical pixels — three applies devicePixelRatio itself).
const SIZE_FRAC = 0.16;
const SIZE_MIN = 96;
const SIZE_MAX = 200;
const MARGIN = 16;

// Mini scene framing: a chunky short triad viewed from a fixed standoff so it fills the box.
const TRIAD_LENGTH = 0.8;
const TRIAD_THICKNESS = 0.05;
const MINI_FOV = 40;
const MINI_STANDOFF = 2.8;   // mini-camera distance from the triad origin

export class MiniView {
    private readonly scene: THREE.Scene;
    private readonly camera: THREE.PerspectiveCamera;
    private readonly triad: AxisTriad;
    private readonly bg: THREE.Color;

    // Reused scratch — zero per-frame allocation.
    private readonly fwd = new THREE.Vector3();

    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(MINI_FOV, 1, 0.1, 100);
        this.triad = makeAxisTriad(TRIAD_LENGTH, TRIAD_THICKNESS);
        this.scene.add(this.triad.group);
        this.bg = new THREE.Color(T.bg);
    }

    /**
     * Draw the mini viewport for this frame as a scissored top-right pass. `opacity` fades the
     * triad in/out with orbit mode; the caller skips this entirely when opacity ≈ 0, so the box
     * only appears while orbiting. The mini camera copies `mainCamera`'s orientation so the
     * triad reads at the live view angle.
     *
     * Leaves the renderer's scissor test off and the viewport restored to full screen; the
     * clear COLOUR is left at the mini background (main.ts calls viewMode.syncClear() after the
     * corner passes, which resets it for the next composite).
     */
    render(renderer: THREE.WebGLRenderer, mainCamera: THREE.PerspectiveCamera, opacity: number): void {
        this.triad.setOpacity(opacity);

        // Mirror the main camera's orientation; stand the mini camera off along the view's
        // back-vector so the origin-centered triad is framed from the same angle.
        mainCamera.getWorldDirection(this.fwd);
        this.camera.quaternion.copy(mainCamera.quaternion);
        this.camera.position.copy(this.fwd).multiplyScalar(-MINI_STANDOFF);
        this.camera.updateMatrixWorld(true);

        const W = window.innerWidth;
        const H = window.innerHeight;
        const size = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.min(W, H) * SIZE_FRAC)));
        // GL viewport origin is BOTTOM-left, so a top-right box sits at y = H − size − margin.
        const vx = W - size - MARGIN;
        const vy = H - size - MARGIN;

        renderer.setRenderTarget(null);
        renderer.setScissorTest(true);
        renderer.setViewport(vx, vy, size, size);
        renderer.setScissor(vx, vy, size, size);
        renderer.setClearColor(this.bg, 1);
        renderer.clear();
        renderer.render(this.scene, this.camera);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, W, H);
    }

    dispose(): void {
        this.triad.dispose();
    }
}
