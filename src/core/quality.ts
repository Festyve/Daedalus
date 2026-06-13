// Auto quality fallback (SPEC §11.2).
//
// Watches per-frame FPS and tracking confidence. If FPS < 25 OR tracking confidence
// < 0.5 stays true for more than 30 consecutive frames, it fires a one-shot degrade:
// the caller drops to single-hand tracking, dials the One Euro filter to heavier
// smoothing, and shows a quiet HUD note (the webcam is already 720p per §11.1, so no
// resolution change is needed). Latching — it degrades once and never oscillates.
//
// Pure and allocation-free: a single integer counter and a boolean. No three.js, no DOM.

// §11.2 thresholds.
const FPS_FLOOR = 25;
const CONFIDENCE_FLOOR = 0.5;
const BAD_FRAMES_TO_DEGRADE = 30;

export class QualityGuard {
    private badStreak = 0;
    private degraded = false;
    private readonly onDegrade: () => void;

    constructor(onDegrade: () => void) {
        this.onDegrade = onDegrade;
    }

    /** True once the fallback has fired (so the caller can stop re-applying it). */
    get isDegraded(): boolean {
        return this.degraded;
    }

    /**
     * Feed one frame's stats. `fps` is the instantaneous frame rate; `confidence` is
     * the best tracking confidence among hands present this frame, or null when no hand
     * is in frame (an empty frame is not "low confidence" — the user just isn't tracking,
     * which is §3.6 territory, not a quality problem).
     */
    sample(fps: number, confidence: number | null): void {
        if (this.degraded) return;

        const badFps = fps > 0 && fps < FPS_FLOOR;
        const badConf = confidence !== null && confidence < CONFIDENCE_FLOOR;

        if (badFps || badConf) {
            this.badStreak++;
            if (this.badStreak > BAD_FRAMES_TO_DEGRADE) {
                this.degraded = true;
                this.onDegrade();
            }
        } else {
            // A single good frame resets the streak — the trigger requires a sustained
            // run of bad frames, not a scattered few.
            this.badStreak = 0;
        }
    }
}
