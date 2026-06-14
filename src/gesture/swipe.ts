// Simplified horizontal-swipe detector (SPEC §12).
//
// Direct frame-by-frame velocity threshold: if index-tip horizontal velocity
// exceeds 0.5 S/frame and cooldown is expired, emit a step. Cooldown blocks
// re-firing for 250ms, preventing one swipe from generating multiple steps.
// No accumulation, no decay math, no state machine.

// Threshold velocity (units of S per frame) to trigger a step.
const DEFAULT_SWIPE_VX = 0.5;
// Hard lockout after a step to prevent double-firing from velocity tail.
const DEFAULT_COOLDOWN_MS = 250;

export interface SwipeConfig {
    vxThreshold?: number;
    cooldownMs?: number;
}

// Exposed so tests / callers can reason about tuning.
export const SWIPE_DEFAULTS = {
    vxThreshold: DEFAULT_SWIPE_VX,
    cooldownMs: DEFAULT_COOLDOWN_MS,
} as const;

export class SwipeDetector {
    private readonly vxThreshold: number;
    private readonly cooldownMs: number;
    private cooldown = 0;

    constructor(cfg: SwipeConfig = {}) {
        this.vxThreshold = cfg.vxThreshold ?? DEFAULT_SWIPE_VX;
        this.cooldownMs = cfg.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    }

    /**
     * Advance one frame with the current per-frame horizontal velocity `vx`
     * (units of S per frame, e.g. from classify().vx) and the frame delta `dtMs`.
     * Returns +1 for a committed rightward swipe, -1 for leftward, 0 for no step.
     */
    update(vx: number, dtMs: number): -1 | 0 | 1 {
        if (this.cooldown > 0) {
            this.cooldown = Math.max(0, this.cooldown - dtMs);
        }

        if (Math.abs(vx) > this.vxThreshold && this.cooldown === 0) {
            this.cooldown = this.cooldownMs;
            return vx > 0 ? 1 : -1;
        }

        return 0;
    }

    /** Clear all state when the driving hand is lost. */
    reset(): void {
        this.cooldown = 0;
    }
}
