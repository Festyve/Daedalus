// Live hand tracking input source (SPEC §3.1, §3.4, §3.5, §11).
//
// Wraps MediaPipe `@mediapipe/tasks-vision` HandLandmarker (GPU delegate, VIDEO
// mode, numHands: 2) behind the `InputSource` contract. Each `pump(dt)` runs one
// synchronous `detectForVideo` on the live <video>, smooths both the normalized
// image-space and the metric world landmarks through a per-hand One Euro filter
// bank, and returns the latest filtered `PoseFrame` (source: "live").
//
// Adapted from the earlier `handLandmarker.ts`: the old `LandmarkFilter` is
// replaced by `HandFilterBank` (126 scalar One Euro filters per hand), handedness
// keying drives Left/Right, every HandPose now carries `handScale`, `timestamp`,
// and the frame carries `source`. Drawing/overlay is NOT done here — that is a
// render concern (render/overlay.ts). The render loop never awaits this source
// inline: init() is awaited once up front, and pump() is fully synchronous.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type {
    Category,
    HandLandmarkerResult,
    Landmark as MpLandmark,
    NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { HandFilterBank } from "../tracking/oneEuro";
import { handScale } from "../gesture/predicates";
import type { Handedness, HandPose, InputSource, PoseFrame, Vec3 } from "../types";

// MediaPipe model + WASM CDN endpoints. If a self-hosted model is present at
// /models/hand_landmarker.task it is preferred (offline / faster), otherwise the
// canonical float16 model is loaded from Google's storage bucket.
const MODEL_CDN =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_LOCAL = "/models/hand_landmarker.task";
const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm";

// One Euro params. Image-space landmarks are normalized [0..1]; world landmarks
// are metric (~10x larger units) so they take a proportionally larger min-cutoff
// to suppress jitter without lag (§3.3).
const IMAGE_MIN_CUTOFF = 1.5;
const IMAGE_BETA = 0.02;
const WORLD_MIN_CUTOFF = 15.0;
const WORLD_BETA = 0.2;

const HANDS: readonly Handedness[] = ["Left", "Right"];

/**
 * Real MediaPipe-backed input source. Construct with the playing <video>, await
 * init() once, then call pump(dt) every render frame.
 */
export class LiveInputSource implements InputSource {
    private readonly video: HTMLVideoElement;
    private landmarker: HandLandmarker | null = null;

    // One Euro filter bank per hand label; image + world channels live inside
    // each bank (126 scalar filters apiece).
    private readonly banks: Record<Handedness, HandFilterBank> = {
        Left: new HandFilterBank(IMAGE_MIN_CUTOFF, IMAGE_BETA),
        Right: new HandFilterBank(IMAGE_MIN_CUTOFF, IMAGE_BETA),
    };

    // Tracks which hands were present last frame so a vanished hand can reset its
    // filter state and restart clean rather than snapping when it reappears.
    private readonly seen: Record<Handedness, boolean> = { Left: false, Right: false };

    // detectForVideo demands strictly increasing timestamps; guard duplicates.
    private last_ts = -1;

    // Last good frame, returned (held) when detection is unavailable.
    private latest: PoseFrame = emptyFrame(performance.now());

    ready = false;

    constructor(video: HTMLVideoElement) {
        this.video = video;
    }

    async init(): Promise<void> {
        const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
        const model_path = await resolveModelPath();
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: model_path, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 2,
        });
        this.ready = true;
    }

    /**
     * Run one detection on the current video frame and return the latest filtered
     * PoseFrame. Synchronous and non-blocking (last-write-wins): if the model is
     * not ready or the video has no frame yet, the previous frame is held.
     */
    pump(dtMs: number): PoseFrame {
        const t_ms = performance.now();
        if (!this.ready || !this.landmarker || this.video.readyState < 2) {
            return this.latest;
        }

        // Strictly increasing timestamps (ms) for the VIDEO running mode.
        let ts = t_ms;
        if (ts <= this.last_ts) ts = this.last_ts + 1;
        this.last_ts = ts;

        const res: HandLandmarkerResult = this.landmarker.detectForVideo(this.video, ts);

        const frame: PoseFrame = {
            Left: null,
            Right: null,
            count: 0,
            tMs: t_ms,
            source: "live",
        };
        const present: Record<Handedness, boolean> = { Left: false, Right: false };

        const n = res.landmarks ? res.landmarks.length : 0;
        frame.count = n;
        for (let i = 0; i < n; i++) {
            const label = labelFor(res.handedness, i);
            // Two hands of the same label can occur on flaky frames; keep the
            // first (higher-confidence) detection for that label.
            if (present[label]) continue;
            present[label] = true;
            frame[label] = this.buildPose(
                label,
                res.landmarks[i],
                res.worldLandmarks[i],
                res.handedness[i],
                dtMs,
                t_ms,
            );
        }

        // Reset the filter bank for any hand that left so it reinitializes cleanly.
        for (const k of HANDS) {
            if (!present[k] && this.seen[k]) this.banks[k].reset();
            this.seen[k] = present[k];
        }

        this.latest = frame;
        return frame;
    }

    dispose(): void {
        this.ready = false;
        this.landmarker?.close();
        this.landmarker = null;
    }

    // Filter both landmark sets through this hand's bank, then derive confidence
    // and hand scale S from the filtered world landmarks (§3.5).
    private buildPose(
        label: Handedness,
        lm: NormalizedLandmark[],
        world_lm: MpLandmark[],
        handedness: Category[] | undefined,
        dtMs: number,
        tMs: number,
    ): HandPose {
        // HandFilterBank.filter derives its own dt from the absolute timestamp;
        // dtMs is accepted for API parity but the bank smooths on tMs.
        void dtMs;
        // Landmarks are mirrored into SELFIE image space (x -> 1 - x) to match the
        // mirrored feed (viewMode.ts AR plane + overlay.ts) — so the user's right hand
        // appears on screen-right and a hand at a screen spot controls things at that
        // spot. The feed display and the landmarks MUST share the same orientation
        // (currently MIRRORED/selfie); to switch to a native/un-mirrored view you would
        // drop the x-flip in BOTH places (here and viewMode.ts). World landmarks are
        // metric and only feed distance-based predicates (§12), so they are left
        // untouched. Mirror x BEFORE filtering so the smoothed stream is in selfie space.
        const mirrored = lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })) as Vec3[];
        const { landmarks, world } = this.banks[label].filter(
            mirrored,
            world_lm as Vec3[],
            tMs,
        );
        const confidence = handedness && handedness[0] ? handedness[0].score : 0;
        return {
            handedness: label,
            landmarks,
            world,
            confidence,
            handScale: handScale(world),
            timestamp: tMs,
        };
    }
}

// Map MediaPipe's per-hand handedness category to our Left/Right label. MediaPipe
// determines handedness ASSUMING the input image is mirrored (selfie); we feed it the
// RAW, non-mirrored camera frame (we mirror the landmarks for display ourselves in
// buildPose, but MediaPipe still sees the raw stream), so its reported label is inverted
// relative to the user's actual hands — swap it so Left = the user's left hand (nav) and
// Right = the user's right hand (exec), per §3.2. When
// the label is missing, fall back so the first detection is Right (execution hand) and
// the second is Left.
function labelFor(handedness: Category[][] | undefined, i: number): Handedness {
    const name =
        handedness && handedness[i] && handedness[i][0]
            ? handedness[i][0].categoryName
            : "";
    if (name === "Left") return "Right";
    if (name === "Right") return "Left";
    return i === 0 ? "Right" : "Left";
}

// Prefer a self-hosted model if one is served at /models/hand_landmarker.task,
// otherwise use the MediaPipe CDN. A HEAD probe avoids a hard failure when the
// local asset is absent.
async function resolveModelPath(): Promise<string> {
    try {
        const res = await fetch(MODEL_LOCAL, { method: "HEAD" });
        if (res.ok) return MODEL_LOCAL;
    } catch {
        // local asset not present — fall through to the CDN.
    }
    return MODEL_CDN;
}

function emptyFrame(tMs: number): PoseFrame {
    return { Left: null, Right: null, count: 0, tMs, source: "live" };
}
