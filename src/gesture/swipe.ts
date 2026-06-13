// Robust horizontal-swipe detector (SPEC §12, hardened).
//
// Replaces the fragile single-frame "|vx| > threshold" test that every menu used to do
// independently. The problem with single-frame velocity: a real flick is spread across
// several frames AND the One-Euro filter damps the per-frame peak, so a quick finger flick
// frequently never crosses a per-frame bar — you had to whip your whole wrist to register.
//
// This detector instead integrates the per-frame velocity `vx` (already normalized to units
// of hand-scale S per frame by classify(), so it is invariant to hand size / distance) into
// a LEAKY accumulator with a ~110 ms time constant. Σ vx telescopes to net horizontal
// displacement, so:
//   - a finger-only flick accumulates past the distance threshold even though no single
//     frame is fast (larger error margin → reliable without big movements),
//   - zero-mean jitter cancels in the sum and decays away (it never fires a random step),
//   - a step arms a cooldown + requires the accumulator to settle before the next step, so
//     ONE physical swipe is exactly ONE step,
//   - it is identical for both hands (no handedness branch), fixing the left/right gap.
//
// It is fed `vx` (not raw landmarks) so callers that only have a GestureState (the carousel)
// and callers that have landmarks (SELECT / ADD SHAPES / INTERACT) share one implementation.
// Allocation-free per frame (a single scalar accumulator), honoring the hot-loop rule.

// Leaky-integrator time constant: motion older than ~this fades from the accumulator.
const TAU_MS = 110;
// Net |Σ vx| (units of S) the accumulator must reach to commit one step. A deliberate
// finger flick moves the index tip ~0.5 S horizontally in <200 ms — comfortably past this —
// while a slow drift settles below it.
const DEFAULT_DISTANCE = 0.42;
// Hard lockout after a step so the flick's own tail (or a velocity wobble) cannot double-step.
const DEFAULT_COOLDOWN_MS = 260;
// The accumulator must decay below this before another step can arm (one swipe = one step).
const DEFAULT_SETTLE = 0.12;

export interface SwipeConfig {
    distance?: number;
    cooldownMs?: number;
    settle?: number;
}

// Exposed so tests / callers can reason about the tuning without duplicating magic numbers.
export const SWIPE_DEFAULTS = {
    distance: DEFAULT_DISTANCE,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    settle: DEFAULT_SETTLE,
    tauMs: TAU_MS,
} as const;

export class SwipeDetector {
    private readonly distance: number;
    private readonly cooldownMs: number;
    private readonly settle: number;

    private net = 0;          // leaky-integrated net displacement (units of S)
    private cooldown = 0;     // ms remaining in the post-step lockout
    private armed = true;     // false from a committed step until the accumulator settles

    constructor(cfg: SwipeConfig = {}) {
        this.distance = cfg.distance ?? DEFAULT_DISTANCE;
        this.cooldownMs = cfg.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.settle = cfg.settle ?? DEFAULT_SETTLE;
    }

    /**
     * Advance one frame with the current per-frame horizontal velocity `vx` (units of S per
     * frame, e.g. from classify().vx) and the frame delta `dtMs`. Returns +1 for a committed
     * rightward swipe, -1 for leftward, 0 for no step this frame. Callers map the sign to
     * their own next/prev semantics.
     */
    update(vx: number, dtMs: number): -1 | 0 | 1 {
        // Leak older motion, then add this frame's displacement.
        const decay = Math.exp(-Math.max(0, dtMs) / TAU_MS);
        this.net = this.net * decay + vx;

        if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dtMs);

        const mag = Math.abs(this.net);
        if (this.armed && this.cooldown <= 0 && mag >= this.distance) {
            this.armed = false;
            this.cooldown = this.cooldownMs;
            return this.net > 0 ? 1 : -1;
        }
        // Re-arm only once the hand has settled (accumulator decayed back toward rest), so a
        // single sustained sweep cannot keep stepping.
        if (mag < this.settle) this.armed = true;
        return 0;
    }

    /** Clear all state — call when the driving hand is lost so a re-acquired hand does not
     *  inherit stale motion or fire a phantom step. */
    reset(): void {
        this.net = 0;
        this.cooldown = 0;
        this.armed = true;
    }
}
