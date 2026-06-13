// Calibration logic (SPEC §0.6). Pure profile derivation + the 5-step ritual
// state machine + a live responsiveness slider. UI rendering lives in
// ui/calibrationUI.ts (P2); this module is logic only. DEFAULT_CALIBRATION
// (types.ts) is the skip path.
import type { CalibrationProfile, Handedness } from "../types";
import { DEFAULT_CALIBRATION } from "../types";
import type { LandmarkFilter } from "./oneEuro";

// ---- Mapping constants (anchored so default inputs reproduce §0.6.4) -------
const BASELINE_JITTER = 0.0025;     // §0.6.4: min_cutoff=1.0 at this jitter
const MIN_CUTOFF_FLOOR = 0.3;       // heavy smoothing cap (very jittery hand)
const MIN_CUTOFF_CEIL = 3.0;        // light smoothing cap (very steady hand)
const BASELINE_VELOCITY = 2.0;      // §0.6.4: beta=0.007 at this peak velocity
const BASELINE_BETA = 0.007;
const BETA_FLOOR = 0.001;
const BETA_CEIL = 0.05;
const PINCH_THRESHOLD_FRACTION = 0.6; // §0.6.2: pinch threshold at 60% of recorded
const RESPONSIVENESS_RANGE = 0.5;   // responsiveness scales params over +/-50%

function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}

// §0.6.2: more resting jitter -> more smoothing -> lower One Euro min_cutoff.
// Inverse map anchored so jitter == BASELINE_JITTER yields exactly 1.0.
export function jitterToMinCutoff(resting_jitter: number): number {
    const safe = Math.max(resting_jitter, 1e-6);
    return clamp(BASELINE_JITTER / safe, MIN_CUTOFF_FLOOR, MIN_CUTOFF_CEIL);
}

// §0.6.2: faster peak swipe velocity -> higher One Euro beta (track fast moves).
// Linear map anchored so velocity == BASELINE_VELOCITY yields exactly 0.007.
export function velocityToBeta(peak_velocity: number): number {
    const safe = Math.max(peak_velocity, 1e-6);
    return clamp(BASELINE_BETA * (safe / BASELINE_VELOCITY), BETA_FLOOR, BETA_CEIL);
}

// Standard deviation of a scalar sample stream — our resting-jitter measure.
export function sampleStdDev(samples: number[]): number {
    if (samples.length === 0) return 0;
    let mean = 0;
    for (const s of samples) mean += s;
    mean /= samples.length;
    let variance = 0;
    for (const s of samples) {
        const d = s - mean;
        variance += d * d;
    }
    variance /= samples.length;
    return Math.sqrt(variance);
}

// Inputs recorded by the 5-step ritual (§0.6.2), one field group per step.
export interface RitualSamples {
    restPositions: number[];        // positional samples while holding still -> jitter
    restPinchFraction: number;      // thumb-index distance / S while open at rest -> pinchOpen
    recordedPinchFraction: number;  // thumb-index distance / S at full pinch -> pinchClosed
    depthSweep: number[];           // world-z samples during reach forward/back
    peakVelocity: number;           // measured max speed during the swipe step
    handScaleMeters: number;        // S in meters, from world landmarks
    responsiveness?: number;        // 0..1 master sensitivity (default 0.6)
    handedness?: Handedness;        // menu-navigating hand (default "Left")
}

// Pure mapping from ritual samples to a CalibrationProfile (§0.6.2/§0.6.3).
export function deriveProfileFromSamples(s: RitualSamples): CalibrationProfile {
    const resting_jitter = sampleStdDev(s.restPositions);
    const depth_near = s.depthSweep.length ? Math.min(...s.depthSweep) : DEFAULT_CALIBRATION.depthNear;
    const depth_far = s.depthSweep.length ? Math.max(...s.depthSweep) : DEFAULT_CALIBRATION.depthFar;
    return {
        handScaleMeters: s.handScaleMeters,
        restingJitter: resting_jitter,
        peakVelocity: s.peakVelocity,
        pinchClosed: PINCH_THRESHOLD_FRACTION * s.recordedPinchFraction,
        pinchOpen: s.restPinchFraction,
        depthNear: depth_near,
        depthFar: depth_far,
        responsiveness: s.responsiveness ?? DEFAULT_CALIBRATION.responsiveness,
        handedness: s.handedness ?? DEFAULT_CALIBRATION.handedness,
    };
}

// The One Euro params a profile implies, after responsiveness scaling.
// responsiveness 0.5 == neutral (derived values); 1 sharpens, 0 smooths.
export function profileToOneEuroParams(p: CalibrationProfile): { minCutoff: number; beta: number } {
    const scale = 1 + (p.responsiveness - 0.5) * 2 * RESPONSIVENESS_RANGE;
    return {
        minCutoff: clamp(jitterToMinCutoff(p.restingJitter) * scale, MIN_CUTOFF_FLOOR, MIN_CUTOFF_CEIL),
        beta: clamp(velocityToBeta(p.peakVelocity) * scale, BETA_FLOOR, BETA_CEIL),
    };
}

// ---- Ritual state machine -------------------------------------------------
export type CalibrationStep = "rest" | "pinch" | "depth" | "swipe" | "done";
const STEP_ORDER: CalibrationStep[] = ["rest", "pinch", "depth", "swipe", "done"];

// Frames a pose must be held before a step advances (~0.75s at 60fps).
const HOLD_FRAMES = 45;

// One per-frame measurement fed in during the ritual.
export interface RitualFrame {
    poseHeld: boolean;      // is the prompted pose currently held?
    restValue: number;      // scalar position sample (rest step)
    pinchFraction: number;  // thumb-index distance / S (rest + pinch steps)
    depthZ: number;         // world-z (depth step)
    velocity: number;       // instantaneous speed (swipe step)
    handScaleMeters: number;
}

// Runs the rest -> pinch -> depth -> swipe -> done ritual. Each step advances
// once the prompted pose is held HOLD_FRAMES consecutive frames. On completion
// it derives the profile; an optional LandmarkFilter is retuned live.
export class Calibration {
    step: CalibrationStep = "rest";
    profile: CalibrationProfile = { ...DEFAULT_CALIBRATION };
    private hold = 0;
    private rest_positions: number[] = [];
    private rest_pinch_sum = 0;
    private rest_pinch_n = 0;
    private pinch_sum = 0;
    private pinch_n = 0;
    private depth_sweep: number[] = [];
    private peak_velocity = 0;
    private hand_scale_meters = DEFAULT_CALIBRATION.handScaleMeters;

    constructor(private filter: LandmarkFilter | null = null) {}

    get done(): boolean {
        return this.step === "done";
    }

    // Feed one measured frame. Returns true when the ritual just finished.
    update(frame: RitualFrame): boolean {
        if (this.step === "done") return false;
        this.hand_scale_meters = frame.handScaleMeters;
        switch (this.step) {
            case "rest":
                this.rest_positions.push(frame.restValue);
                this.rest_pinch_sum += frame.pinchFraction;
                this.rest_pinch_n++;
                break;
            case "pinch":
                this.pinch_sum += frame.pinchFraction;
                this.pinch_n++;
                break;
            case "depth":
                this.depth_sweep.push(frame.depthZ);
                break;
            case "swipe":
                this.peak_velocity = Math.max(this.peak_velocity, frame.velocity);
                break;
        }
        if (frame.poseHeld) {
            this.hold++;
            if (this.hold >= HOLD_FRAMES) return this.advance();
        } else {
            this.hold = 0;
        }
        return false;
    }

    private advance(): boolean {
        this.hold = 0;
        const next = STEP_ORDER[STEP_ORDER.indexOf(this.step) + 1];
        this.step = next;
        if (this.step === "done") {
            this.finish();
            return true;
        }
        return false;
    }

    private finish(): void {
        this.profile = deriveProfileFromSamples({
            restPositions: this.rest_positions,
            restPinchFraction: this.rest_pinch_n ? this.rest_pinch_sum / this.rest_pinch_n : DEFAULT_CALIBRATION.pinchOpen,
            recordedPinchFraction: this.pinch_n ? this.pinch_sum / this.pinch_n : DEFAULT_CALIBRATION.pinchClosed,
            depthSweep: this.depth_sweep,
            peakVelocity: this.peak_velocity || DEFAULT_CALIBRATION.peakVelocity,
            handScaleMeters: this.hand_scale_meters,
            responsiveness: this.profile.responsiveness,
            handedness: this.profile.handedness,
        });
        this.applyFilter();
    }

    // Skip the ritual: keep DEFAULT_CALIBRATION and jump to done (§0.6.4).
    skip(): CalibrationProfile {
        this.step = "done";
        this.profile = { ...DEFAULT_CALIBRATION };
        this.applyFilter();
        return this.profile;
    }

    // Live 0..1 sensitivity dial — scales One Euro smoothing via the profile (§0.6.3).
    setResponsiveness(value: number): void {
        this.profile.responsiveness = clamp(value, 0, 1);
        this.applyFilter();
    }

    private applyFilter(): void {
        if (!this.filter) return;
        const { minCutoff, beta } = profileToOneEuroParams(this.profile);
        this.filter.setParams(minCutoff, beta);
    }
}
