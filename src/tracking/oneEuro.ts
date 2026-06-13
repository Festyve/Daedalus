// One Euro Filter for landmark smoothing (SPEC §3.3).
// 126 scalar filters per hand: (21 image + 21 world) landmarks x 3 axes.
// Defaults: min_cutoff=1.0, beta=0.007 — lower min_cutoff if jitter at rest,
// raise beta if lag during fast moves. Pure & deterministic; no three.js.
import type { Vec3 } from "../types";

const TWO_PI = Math.PI * 2;

// Fallback frame interval (ms) used for the very first sample and whenever two
// timestamps coincide. 60 fps cadence keeps the first response neutral.
const DEFAULT_DT_MS = 1000 / 60;

/** Exponential-smoothing factor for a given cutoff frequency (Hz) and dt (s). */
function alpha(cutoff: number, dt: number): number {
    const tau = 1 / (TWO_PI * cutoff);
    return 1 / (1 + tau / dt);
}

/** Single-channel low-pass with lazy initialization. */
class LowPass {
    private has_prev = false;
    private prev = 0;
    filter(x: number, a: number): number {
        if (!this.has_prev) {
            this.has_prev = true;
            this.prev = x;
            return x;
        }
        const r = a * x + (1 - a) * this.prev;
        this.prev = r;
        return r;
    }
    reset(): void {
        this.has_prev = false;
        this.prev = 0;
    }
}

/**
 * One Euro Filter (Casiez et al.). Adaptive low-pass: cutoff rises with signal
 * speed so fast motion has low lag while slow motion is heavily smoothed.
 * `filter(x, tMs)` takes an absolute timestamp in milliseconds and derives dt
 * internally, so callers pass raw frame timestamps rather than deltas.
 */
export class OneEuroFilter {
    private readonly min_cutoff: number;
    private readonly beta: number;
    private readonly d_cutoff: number;
    private readonly x_lp = new LowPass();
    private readonly dx_lp = new LowPass();
    private x_prev = 0;
    private t_prev = 0;
    private has_prev = false;

    constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
        this.min_cutoff = minCutoff;
        this.beta = beta;
        this.d_cutoff = dCutoff;
    }

    filter(x: number, tMs: number): number {
        // dt in seconds; first sample (or duplicate timestamp) uses a neutral
        // default so the adaptive cutoff stays well-defined.
        let dt = this.has_prev ? (tMs - this.t_prev) / 1000 : DEFAULT_DT_MS / 1000;
        if (!(dt > 0)) dt = DEFAULT_DT_MS / 1000;

        const dx = this.has_prev ? (x - this.x_prev) / dt : 0;
        const edx = this.dx_lp.filter(dx, alpha(this.d_cutoff, dt));
        const cutoff = this.min_cutoff + this.beta * Math.abs(edx);
        const r = this.x_lp.filter(x, alpha(cutoff, dt));

        this.x_prev = x;
        this.t_prev = tMs;
        this.has_prev = true;
        return r;
    }

    reset(): void {
        this.x_lp.reset();
        this.dx_lp.reset();
        this.x_prev = 0;
        this.t_prev = 0;
        this.has_prev = false;
    }
}

const LANDMARK_COUNT = 21;
const AXES = 3;

/**
 * Smooths one hand's full landmark set: 21 image-space + 21 world-space points,
 * 3 axes each = 126 independent One Euro filters. Image and world channels are
 * filtered separately so metric and normalized streams never cross-contaminate.
 */
export class HandFilterBank {
    // Flat [landmark*3 + axis] layout; index 0 = x, 1 = y, 2 = z.
    private readonly image: OneEuroFilter[] = [];
    private readonly world: OneEuroFilter[] = [];

    constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
        const total = LANDMARK_COUNT * AXES;
        for (let i = 0; i < total; i++) {
            this.image.push(new OneEuroFilter(minCutoff, beta, dCutoff));
            this.world.push(new OneEuroFilter(minCutoff, beta, dCutoff));
        }
    }

    filter(landmarks: Vec3[], world: Vec3[], tMs: number): { landmarks: Vec3[]; world: Vec3[] } {
        return {
            landmarks: this.filterSet(landmarks, this.image, tMs),
            world: this.filterSet(world, this.world, tMs),
        };
    }

    // Live-retune both channels (§11.2 auto quality fallback: increase smoothing under
    // sustained low FPS / tracking confidence). Lowering min_cutoff smooths harder.
    // Rebuilds the filters so the new params take effect cleanly without leaking the
    // previous adaptive state. d_cutoff stays at its default.
    setSmoothing(imageMinCutoff: number, imageBeta: number, worldMinCutoff: number, worldBeta: number): void {
        const total = LANDMARK_COUNT * AXES;
        for (let i = 0; i < total; i++) {
            this.image[i] = new OneEuroFilter(imageMinCutoff, imageBeta);
            this.world[i] = new OneEuroFilter(worldMinCutoff, worldBeta);
        }
    }

    private filterSet(src: Vec3[], filters: OneEuroFilter[], tMs: number): Vec3[] {
        const out: Vec3[] = new Array(LANDMARK_COUNT);
        for (let i = 0; i < LANDMARK_COUNT; i++) {
            const p = src[i];
            const base = i * AXES;
            out[i] = {
                x: filters[base].filter(p.x, tMs),
                y: filters[base + 1].filter(p.y, tMs),
                z: filters[base + 2].filter(p.z, tMs),
            };
        }
        return out;
    }

    reset(): void {
        for (let i = 0; i < this.image.length; i++) {
            this.image[i].reset();
            this.world[i].reset();
        }
    }
}

/**
 * Legacy single-set landmark smoother used by handLandmarker.ts. Wraps 63 scalar
 * One Euro filters (21 landmarks x 3 axes) and accepts a per-frame dt (ms) delta,
 * accumulating it into an absolute clock so it can drive the timestamp-based
 * OneEuroFilter underneath. Params are retunable live via setParams (calibration).
 */
export class LandmarkFilter {
    private readonly filters: OneEuroFilter[] = [];
    private min_cutoff: number;
    private beta: number;
    private readonly d_cutoff: number;
    private t_ms = 0;

    constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
        this.min_cutoff = minCutoff;
        this.beta = beta;
        this.d_cutoff = dCutoff;
        const total = LANDMARK_COUNT * AXES;
        for (let i = 0; i < total; i++) {
            this.filters.push(new OneEuroFilter(minCutoff, beta, dCutoff));
        }
    }

    // Live-retune cutoff/beta; rebuilds the filter bank so new params take effect
    // cleanly without leaking the previous adaptive state.
    setParams(minCutoff: number, beta: number): void {
        this.min_cutoff = minCutoff;
        this.beta = beta;
        const total = LANDMARK_COUNT * AXES;
        for (let i = 0; i < total; i++) {
            this.filters[i] = new OneEuroFilter(minCutoff, beta, this.d_cutoff);
        }
        this.t_ms = 0;
    }

    // Smooth one landmark set. `dtMs` is a frame delta; it is accumulated into an
    // absolute timestamp the underlying timestamp-based filters consume.
    apply(landmarks: Vec3[], dtMs: number): Vec3[] {
        this.t_ms += dtMs > 0 ? dtMs : DEFAULT_DT_MS;
        const out: Vec3[] = new Array(LANDMARK_COUNT);
        for (let i = 0; i < LANDMARK_COUNT; i++) {
            const p = landmarks[i];
            const base = i * AXES;
            out[i] = {
                x: this.filters[base].filter(p.x, this.t_ms),
                y: this.filters[base + 1].filter(p.y, this.t_ms),
                z: this.filters[base + 2].filter(p.z, this.t_ms),
            };
        }
        return out;
    }

    reset(): void {
        for (let i = 0; i < this.filters.length; i++) this.filters[i].reset();
        this.t_ms = 0;
    }
}
