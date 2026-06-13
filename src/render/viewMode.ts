// View-mode toggle (SPEC §0.7, §9.5). Two render modes switched by one bilateral
// "parting curtains" gesture: both palms open near the centre of frame, then sweep
// outward along the horizontal axis within 600ms.
//
//   ar    — live full-colour webcam feed as the MAIN full-screen background. The feed is
//           a real DOM <video> (#camera, styles.css) layered BEHIND a transparent WebGL
//           canvas, so it is never touched by the post-processing (bloom / tone map) and
//           stays a normal crisp image. In AR mode this controller makes the canvas clear
//           transparent (scene.background = null, clear alpha 0) so the video shows through.
//           Default starting mode (the camera is the main view).
//   scene — pure #000814 canvas, camera <video> hidden.
//
// On every toggle a horizontal cyan scan line sweeps the full canvas (80ms) and
// fades, like a display switching input. The scan line and the camera-layer toggle are
// owned here so callers only have to forward poses + dt.
//
// Hot-loop discipline (§6.2, §11): no per-frame allocation. The scan-line DOM element is
// created once and reused; detection keeps only scalar per-hand state between frames. The
// camera feed is a plain DOM element — zero three.js cost.
import * as THREE from "three";
import type { HandPose, ViewMode } from "../types";
import { isOpenPalm } from "../gesture/predicates";
import { T } from "./tokens";

// MediaPipe Hands landmark indices used for image-space velocity + framing checks.
const WRIST = 0;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const EPS = 1e-6;

// §0.7 detection thresholds. Velocity is expressed in units of hand-scale S per
// frame, so it stays invariant to hand size and camera distance.
const VX_THRESHOLD = 0.3;        // |vx| must exceed 0.3·S/frame, split outward
const PARTING_WINDOW_MS = 600;   // the outward sweep must complete within 600ms
const COOLDOWN_MS = 1500;        // lockout after a trigger, prevents re-toggle
// Both palms must start "near centre" of the normalized [0,1] frame before parting.
const CENTER_MIN = 0.2;
const CENTER_MAX = 0.8;

// §0.7 scan-line feedback. Full-canvas horizontal sweep, then a short fade.
const SWEEP_MS = 80;
const FADE_MS = 180;

// Per-hand sample carried between frames to derive image-space horizontal velocity.
interface HandSample {
    x: number;        // index-tip x in normalized image space
    valid: boolean;   // whether the previous frame produced a usable sample
}

// Image-space hand scale S = ‖wrist − middleMCP‖ in normalized image coordinates.
// World-metric handScale is the wrong unit here (we measure image-space motion), so
// we recompute scale in the same space as the velocity. Floored to avoid /0.
function imageHandScale(lm: ReadonlyArray<{ x: number; y: number }>): number {
    const wrist = lm[WRIST];
    const mcp = lm[MIDDLE_MCP];
    const dx = wrist.x - mcp.x;
    const dy = wrist.y - mcp.y;
    return Math.max(Math.sqrt(dx * dx + dy * dy), EPS);
}

// True when the index tip sits within the central band of the frame (both hands must
// start near centre before the outward sweep counts as a parting-curtains gesture).
function nearCenter(lm: ReadonlyArray<{ x: number }>): boolean {
    const x = lm[INDEX_TIP].x;
    return x > CENTER_MIN && x < CENTER_MAX;
}

export class ViewModeController {
    mode: ViewMode = "ar";

    private readonly scene: THREE.Scene;
    private readonly camera: THREE.PerspectiveCamera;
    private readonly renderer: THREE.WebGLRenderer;
    private readonly getVideo: () => HTMLVideoElement | null;
    private readonly bgColor: THREE.Color;   // scene-mode clear (#000814)
    private readonly blackBg: THREE.Color;   // AR-mode clear (black; screen-blend reveals the feed)

    // Parting-curtains detection state (scalars only — no per-frame alloc).
    private prevLeft: HandSample = { x: 0, valid: false };
    private prevRight: HandSample = { x: 0, valid: false };
    private partingActive = false;   // an outward sweep is mid-flight
    private partingElapsed = 0;      // ms accumulated inside the current window
    private cooldown = 0;            // ms remaining before another trigger may fire

    // Tracks whether the camera <video> has been shown at least once, so the lazy
    // "video became ready" path in update() only re-applies the mode when needed.
    private videoShown = false;

    // Scan-line feedback overlay (plain DOM, full canvas — §0.7, no CSS3D).
    private scanEl: HTMLDivElement | null = null;
    private scanElapsed = 0;
    private scanActive = false;

    constructor(
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        renderer: THREE.WebGLRenderer,
        getVideo: () => HTMLVideoElement | null,
    ) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.getVideo = getVideo;
        this.bgColor = new THREE.Color(T.bg);
        this.blackBg = new THREE.Color(0x000000);
        // Start in AR: clear black so the canvas's screen-blend reveals the #camera video.
        this.applyMode();
    }

    /** Flip scene<->ar, show/hide the webcam <video>, and fire the scan-line sweep. */
    toggle(): void {
        this.mode = this.mode === "scene" ? "ar" : "scene";
        this.applyMode();
        this.startScanLine();
    }

    /**
     * Apply the current mode's render state. In AR the scene clears to BLACK and the #camera
     * video is shown: the canvas uses `mix-blend-mode: screen` (styles.css), so black drops out
     * and the live feed shows through untouched while the bright wireframe composites on top. In
     * scene mode the clear is #000814 and the video is hidden (screen-over-#000 is a no-op, so the
     * scene view is unchanged). Idempotent — safe to call every frame.
     */
    private applyMode(): void {
        const video = this.getVideo();
        if (this.mode === "ar") {
            if (video) { video.style.display = "block"; this.videoShown = true; }
            this.scene.background = this.blackBg;
            this.renderer.setClearColor(0x000000, 1);
        } else {
            if (video) video.style.display = "none";
            this.scene.background = this.bgColor;
            this.renderer.setClearColor(this.bgColor, 1);
        }
    }

    /**
     * Re-apply ONLY the renderer clear colour for the current mode. main.ts calls this after its
     * corner-preview pass (which sets the #000814 clear colour) so the next frame's composer
     * clears correctly: black in AR (screen-blend reveals the feed), #000814 in scene mode.
     */
    syncClear(): void {
        if (this.mode === "ar") this.renderer.setClearColor(0x000000, 1);
        else this.renderer.setClearColor(this.bgColor, 1);
    }

    /**
     * Parting-curtains detector (§0.7). Returns true on the frame the gesture
     * completes — both palms open and near centre, the left tip sweeping left
     * (vx < −0.3·S/frame) while the right sweeps right (vx > +0.3·S/frame), the whole
     * sweep finishing within 600ms, then a 1500ms cooldown. On a true return the
     * controller has already toggled the mode and started the scan line.
     *
     * dt is the frame delta in milliseconds.
     */
    detectPartingCurtains(left: HandPose | null, right: HandPose | null, dt: number): boolean {
        if (this.cooldown > 0) {
            this.cooldown = Math.max(0, this.cooldown - dt);
            this.sampleHands(left, right);
            return false;
        }

        // Need both hands, both open palms, both starting near the centre band.
        const bothPresent = left !== null && right !== null;
        const bothOpen =
            bothPresent &&
            isOpenPalm(left!.landmarks, left!.handScale) &&
            isOpenPalm(right!.landmarks, right!.handScale);
        const bothCentered =
            bothPresent && nearCenter(left!.landmarks) && nearCenter(right!.landmarks);

        if (!bothOpen || !bothCentered) {
            this.partingActive = false;
            this.partingElapsed = 0;
            this.sampleHands(left, right);
            return false;
        }

        // Image-space horizontal velocity per hand, normalized by image-space S so the
        // threshold reads in S/frame. The feed is MIRRORED (selfie space): the user's left
        // hand (our "Left" pose) appears on the image's LEFT, so sweeping it outward (toward
        // screen-left) DECREASES x; the user's right hand (our "Right" pose) appears on the
        // image's RIGHT, so sweeping it outward (toward screen-right) INCREASES x. Parting
        // therefore means lVx < 0 and rVx > 0.
        const lScale = imageHandScale(left!.landmarks);
        const rScale = imageHandScale(right!.landmarks);
        const lVx = this.prevLeft.valid ? (left!.landmarks[INDEX_TIP].x - this.prevLeft.x) / lScale : 0;
        const rVx = this.prevRight.valid ? (right!.landmarks[INDEX_TIP].x - this.prevRight.x) / rScale : 0;
        const movingApart = lVx < -VX_THRESHOLD && rVx > VX_THRESHOLD;

        this.sampleHands(left, right);

        if (movingApart) {
            // Start (or continue) the sweep window; trigger as soon as the split is seen
            // within the 600ms budget.
            if (!this.partingActive) {
                this.partingActive = true;
                this.partingElapsed = 0;
            }
            if (this.partingElapsed <= PARTING_WINDOW_MS) {
                this.partingActive = false;
                this.partingElapsed = 0;
                this.cooldown = COOLDOWN_MS;
                this.toggle();
                return true;
            }
            this.partingActive = false;
            this.partingElapsed = 0;
            return false;
        }

        // Palms open + centred but not yet parting: hold the window open, expiring it if
        // the sweep takes longer than 600ms.
        if (this.partingActive) {
            this.partingElapsed += dt;
            if (this.partingElapsed > PARTING_WINDOW_MS) {
                this.partingActive = false;
                this.partingElapsed = 0;
            }
        } else {
            this.partingActive = true;
            this.partingElapsed = 0;
        }
        return false;
    }

    /**
     * Per-frame upkeep: advance the scan-line animation. dt is in milliseconds.
     *
     * AR is the default mode. The webcam feed is a DOM <video> (#camera) shown by
     * applyMode(); if it was not ready when AR mode started, show it the moment it appears.
     * In mock / no-camera runs getVideo() stays null and the main view simply stays dark.
     */
    update(dt: number): void {
        if (this.scanActive) this.advanceScanLine(dt);

        if (this.mode === "ar" && !this.videoShown && this.getVideo()) {
            this.applyMode();
        }
    }

    // ---- internal ----------------------------------------------------------

    // Record this frame's index-tip x for both hands so the next frame can difference
    // it into a velocity. A missing hand invalidates its sample.
    private sampleHands(left: HandPose | null, right: HandPose | null): void {
        if (left) {
            this.prevLeft.x = left.landmarks[INDEX_TIP].x;
            this.prevLeft.valid = true;
        } else {
            this.prevLeft.valid = false;
        }
        if (right) {
            this.prevRight.x = right.landmarks[INDEX_TIP].x;
            this.prevRight.valid = true;
        } else {
            this.prevRight.valid = false;
        }
    }

    // Create-or-reset the full-canvas scan-line element and start its sweep. Plain DOM
    // overlay fixed over the canvas; pointer events pass through.
    private startScanLine(): void {
        if (!this.scanEl) {
            const el = document.createElement("div");
            el.style.position = "fixed";
            el.style.left = "0";
            el.style.width = "100%";
            el.style.height = "3px";
            el.style.pointerEvents = "none";
            el.style.zIndex = "40";
            el.style.background = `linear-gradient(180deg, transparent, ${T.cyan}, transparent)`;
            el.style.boxShadow = `0 0 14px ${T.cyan}, 0 0 36px ${T.cyanDim}`;
            el.style.willChange = "top, opacity";
            document.body.appendChild(el);
            this.scanEl = el;
        }
        this.scanElapsed = 0;
        this.scanActive = true;
        this.scanEl.style.display = "block";
        this.scanEl.style.top = "0";
        this.scanEl.style.opacity = "1";
    }

    // Advance the scan-line sweep (top->bottom over SWEEP_MS) then fade it out over
    // FADE_MS, hiding the element when finished. dt is in milliseconds.
    private advanceScanLine(dt: number): void {
        if (!this.scanEl) {
            this.scanActive = false;
            return;
        }
        this.scanElapsed += dt;
        const sweep = Math.min(1, this.scanElapsed / SWEEP_MS);
        this.scanEl.style.top = `${sweep * 100}%`;

        if (this.scanElapsed >= SWEEP_MS) {
            const fade = Math.min(1, (this.scanElapsed - SWEEP_MS) / FADE_MS);
            this.scanEl.style.opacity = `${1 - fade}`;
            if (fade >= 1) {
                this.scanActive = false;
                this.scanEl.style.display = "none";
            }
        }
    }
}
