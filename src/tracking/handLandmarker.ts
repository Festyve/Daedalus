// Hand tracking: mirrored webcam frame -> MediaPipe HandLandmarker -> One-Euro
// filtered poses, emitted as a PoseFrame (src/types.ts) carrying BOTH normalized
// image-space landmarks AND MediaPipe metric world landmarks, plus per-hand
// confidence and handScale. Ported from js/handTracking.js; EMA replaced by the
// One Euro filter and world landmarks added.
//
// The camera frame is mirrored (selfie) for BOTH detection and display, so the
// handedness labels read intuitively (your left hand == "Left") and the overlay
// landmarks line up with the preview without any extra flipping.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { HandLandmarkerResult, Category, NormalizedLandmark, Landmark as MpLandmark } from "@mediapipe/tasks-vision";
import { LandmarkFilter } from "../tracking/oneEuro";
import type { Handedness, HandPose, Landmark, PoseFrame, WorldLandmark } from "../types";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// One Euro defaults for normalized image-space landmarks (calibration may retune
// these live via setFilterParams; SPEC §0.6.2). World landmarks (metres) need a
// proportionally larger min-cutoff since their units are ~10x the image space.
const IMAGE_MIN_CUTOFF = 1.5;
const IMAGE_BETA = 0.02;
const WORLD_MIN_CUTOFF = 15.0;
const WORLD_BETA = 0.2;

// pairs of landmark indices that form the hand skeleton, for the overlay
const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
];

const HANDS: readonly Handedness[] = ["Left", "Right"];

// One Euro filter pair (image + world) for a single hand label.
interface HandFilters {
    image: LandmarkFilter;
    world: LandmarkFilter;
}

export class HandLandmarkerEngine {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private video: HTMLVideoElement;
    private landmarker: HandLandmarker | null = null;
    private last_ts = -1;
    private filters: Record<Handedness, HandFilters>;
    private seen: Record<Handedness, boolean> = { Left: false, Right: false };
    ready = false;

    // `video` must already be playing (see capture/webcam.ts); `previewCanvas` is
    // the mirrored detection surface that overlay.ts later composites.
    constructor(previewCanvas: HTMLCanvasElement, video: HTMLVideoElement) {
        this.canvas = previewCanvas;
        const ctx = previewCanvas.getContext("2d");
        if (!ctx) throw new Error("2D context unavailable for preview canvas");
        this.ctx = ctx;
        this.video = video;
        this.filters = {
            Left: { image: new LandmarkFilter(IMAGE_MIN_CUTOFF, IMAGE_BETA), world: new LandmarkFilter(WORLD_MIN_CUTOFF, WORLD_BETA) },
            Right: { image: new LandmarkFilter(IMAGE_MIN_CUTOFF, IMAGE_BETA), world: new LandmarkFilter(WORLD_MIN_CUTOFF, WORLD_BETA) },
        };
    }

    async init(): Promise<void> {
        const w = this.video.videoWidth || 1280;
        const h = this.video.videoHeight || 720;
        this.canvas.width = w;
        this.canvas.height = h;

        const fileset = await FilesetResolver.forVisionTasks(WASM);
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 2,
        });
        this.ready = true;
    }

    // Live-retune the image-space One Euro params from calibration (responsiveness).
    setFilterParams(minCutoff: number, beta: number): void {
        this.filters.Left.image.setParams(minCutoff, beta);
        this.filters.Right.image.setParams(minCutoff, beta);
    }

    // Run one detection. Draws the mirrored frame onto the preview canvas (the
    // surface MediaPipe reads), then returns a One-Euro-filtered PoseFrame.
    pump(dt: number): PoseFrame {
        const t_ms = performance.now();
        if (!this.ready || !this.landmarker) {
            return { Left: null, Right: null, count: 0, tMs: t_ms };
        }
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        // Draw the mirrored frame; this canvas is both what we detect on and what
        // overlay.ts later shows in the corner.
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(this.video, 0, 0, w, h);
        ctx.restore();

        let ts = t_ms;
        if (ts <= this.last_ts) ts = this.last_ts + 1; // timestamps must increase
        this.last_ts = ts;
        const res: HandLandmarkerResult = this.landmarker.detectForVideo(this.canvas, ts);

        const frame: PoseFrame = { Left: null, Right: null, count: 0, tMs: t_ms };
        const present: Record<Handedness, boolean> = { Left: false, Right: false };

        const n = res.landmarks ? res.landmarks.length : 0;
        frame.count = n;
        for (let i = 0; i < n; i++) {
            const label = this.labelFor(res.handedness, i);
            present[label] = true;
            frame[label] = this.buildPose(label, res.landmarks[i], res.worldLandmarks[i], res.handedness[i], dt);
        }

        // Reset the One Euro state for any hand that vanished so it restarts clean.
        for (const k of HANDS) {
            if (!present[k] && this.seen[k]) {
                this.filters[k].image.reset();
                this.filters[k].world.reset();
            }
            this.seen[k] = present[k];
        }
        return frame;
    }

    // Build a HandPose: filter both landmark sets, compute confidence + handScale.
    private buildPose(
        label: Handedness,
        lm: NormalizedLandmark[],
        world_lm: MpLandmark[],
        handedness: Category[] | undefined,
        dt: number,
    ): HandPose {
        const image = this.filters[label].image.apply(lm, dt) as Landmark[];
        const world = this.filters[label].world.apply(world_lm, dt) as WorldLandmark[];
        const confidence = handedness && handedness[0] ? handedness[0].score : 0;
        // S = ||wrist(0) - middleMCP(9)|| in WORLD landmarks (§0.6.2).
        const hand_scale = dist3(world[0], world[9]);
        return { handedness: label, landmarks: image, world, confidence, handScale: hand_scale };
    }

    // MediaPipe handedness category -> our label; fall back when absent.
    private labelFor(handedness: Category[][] | undefined, i: number): Handedness {
        const name = handedness && handedness[i] && handedness[i][0] ? handedness[i][0].categoryName : "";
        if (name === "Left" || name === "Right") return name;
        return i === 0 ? "Right" : "Left";
    }

    // Draw the green skeleton for both hands onto the preview canvas. The mirrored
    // frame is already drawn by pump(); overlay.ts handles corner placement and
    // desaturation. Ported from js/handTracking.js _drawOverlay.
    drawOverlay(frame: PoseFrame): void {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        for (const k of HANDS) {
            const hand = frame[k];
            if (!hand) continue;
            const lm = hand.landmarks;
            const col = k === "Left" ? "#5fd0ff" : "#ffd35f";
            ctx.strokeStyle = col;
            ctx.lineWidth = 2;
            for (const [a, b] of CONNECTIONS) {
                ctx.beginPath();
                ctx.moveTo(lm[a].x * w, lm[a].y * h);
                ctx.lineTo(lm[b].x * w, lm[b].y * h);
                ctx.stroke();
            }
            ctx.fillStyle = col;
            for (const p of lm) {
                ctx.beginPath();
                ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

function dist3(a: WorldLandmark, b: WorldLandmark): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.hypot(dx, dy, dz) || 1e-3;
}
