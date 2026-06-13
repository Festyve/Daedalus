// View-mode toggle (SPEC §0.7, §9.5). Two render modes switched by one bilateral
// "parting curtains" gesture: both palms open near the centre of frame, then sweep
// outward along the horizontal axis within 600ms.
//
//   scene — pure #000814 canvas, no camera feed. Default starting mode.
//   ar    — live webcam feed as a desaturated background plane behind the geometry.
//
// On every toggle a horizontal cyan scan line sweeps the full canvas (80ms) and
// fades, like a display switching input. The scan line and the AR plane are owned
// here so callers only have to forward poses + dt.
//
// Hot-loop discipline (§6.2, §11): no per-frame allocation. The AR plane, its video
// texture, and the scan-line DOM element are created once and reused; detection
// keeps only scalar per-hand state between frames.
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

// AR background plane sizing. The plane is parented to the camera-facing backdrop at
// a fixed depth well behind any sculptable geometry; it is large enough to fill the
// frame at that depth and is rebuilt to the video's aspect ratio when it first loads.
const AR_PLANE_DEPTH = -8;
const AR_PLANE_HEIGHT = 9;

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
    mode: ViewMode = "scene";

    private readonly scene: THREE.Scene;
    private readonly getVideo: () => HTMLVideoElement | null;

    // Parting-curtains detection state (scalars only — no per-frame alloc).
    private prevLeft: HandSample = { x: 0, valid: false };
    private prevRight: HandSample = { x: 0, valid: false };
    private partingActive = false;   // an outward sweep is mid-flight
    private partingElapsed = 0;      // ms accumulated inside the current window
    private cooldown = 0;            // ms remaining before another trigger may fire

    // AR background plane (created lazily on first AR activation).
    private arPlane: THREE.Mesh | null = null;
    private arTexture: THREE.VideoTexture | null = null;
    private arAspectApplied = false;

    // Scan-line feedback overlay (plain DOM, full canvas — §0.7, no CSS3D).
    private scanEl: HTMLDivElement | null = null;
    private scanElapsed = 0;
    private scanActive = false;

    constructor(scene: THREE.Scene, getVideo: () => HTMLVideoElement | null) {
        this.scene = scene;
        this.getVideo = getVideo;
    }

    /** Flip scene<->ar, show/hide the webcam plane, and fire the scan-line sweep. */
    toggle(): void {
        this.mode = this.mode === "scene" ? "ar" : "scene";
        if (this.mode === "ar") {
            this.ensureArPlane();
            if (this.arPlane) this.arPlane.visible = true;
        } else if (this.arPlane) {
            this.arPlane.visible = false;
        }
        this.startScanLine();
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
        // threshold reads in S/frame. Selfie space is mirrored, so the user's left hand
        // physically sweeping outward (toward the screen's left edge) decreases x.
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
     * Per-frame upkeep: advance the scan-line animation and, in AR mode, push the
     * latest webcam frame into the background plane's texture. dt is in milliseconds.
     */
    update(dt: number): void {
        if (this.scanActive) this.advanceScanLine(dt);

        if (this.mode === "ar" && this.arPlane && this.arPlane.visible) {
            this.applyArAspect();
            if (this.arTexture) this.arTexture.needsUpdate = true;
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

    // Build the AR webcam plane once: a desaturated, contrast-raised video texture on a
    // large quad parented to the scene at a fixed depth behind all geometry. Created on
    // the first AR activation so a webcam that never opens costs nothing.
    private ensureArPlane(): void {
        if (this.arPlane) return;
        const video = this.getVideo();
        if (!video) return;

        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;

        // Desaturate + raise contrast in-shader (§9.5) so real-world video reads as a
        // cool backdrop rather than competing with the cyan UI. Selfie space is
        // mirrored, so flip U to match the tracked skeleton's mirrored image space.
        const material = new THREE.ShaderMaterial({
            uniforms: { uMap: { value: texture } },
            depthTest: false,
            depthWrite: false,
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D uMap;
                varying vec2 vUv;
                void main() {
                    vec3 c = texture2D(uMap, vec2(1.0 - vUv.x, vUv.y)).rgb;
                    float g = dot(c, vec3(0.299, 0.587, 0.114));
                    vec3 desat = mix(vec3(g), c, 0.15);          // mostly grayscale
                    vec3 contrast = (desat - 0.5) * 1.18 + 0.5;  // raised contrast
                    gl_FragColor = vec4(clamp(contrast, 0.0, 1.0), 1.0);
                }
            `,
        });

        const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        plane.position.set(0, 0, AR_PLANE_DEPTH);
        plane.renderOrder = -1;   // draw behind sculptable geometry (renderOrder 0)
        plane.frustumCulled = false;
        plane.scale.set(AR_PLANE_HEIGHT * (16 / 9), AR_PLANE_HEIGHT, 1);
        this.scene.add(plane);

        this.arPlane = plane;
        this.arTexture = texture;
        this.arAspectApplied = false;
    }

    // Once the video reports real dimensions, size the plane to its aspect ratio so the
    // feed isn't stretched. Runs at most once per loaded stream.
    private applyArAspect(): void {
        if (this.arAspectApplied || !this.arPlane) return;
        const video = this.getVideo();
        if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
        const aspect = video.videoWidth / video.videoHeight;
        this.arPlane.scale.set(AR_PLANE_HEIGHT * aspect, AR_PLANE_HEIGHT, 1);
        this.arAspectApplied = true;
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
