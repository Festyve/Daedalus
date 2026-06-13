// SwipeDetector — the robust windowed swipe used by every menu (SPEC §12, hardened).
// Pure + deterministic: feed it per-frame vx (units of hand-scale S/frame) and dt, assert the
// committed steps. Covers the four properties that fix the reported gesture bugs:
//   1. a finger-only flick (low per-frame vx, but real net displacement) registers,
//   2. zero-mean jitter never fires a phantom step,
//   3. one physical sweep == exactly one step (cooldown + settle re-arm),
//   4. direction sign is correct and reset() clears state.
import { describe, it, expect } from "vitest";
import { SwipeDetector, SWIPE_DEFAULTS } from "../src/gesture/swipe";

const DT = 16; // ~60 fps

// Drive the detector for `frames` frames at a constant vx; return how many steps fired and
// the last non-zero direction seen.
function run(d: SwipeDetector, vx: number, frames: number): { steps: number; lastDir: number } {
    let steps = 0;
    let lastDir = 0;
    for (let i = 0; i < frames; i++) {
        const s = d.update(vx, DT);
        if (s !== 0) { steps++; lastDir = s; }
    }
    return { steps, lastDir };
}

describe("SwipeDetector", () => {
    it("fires one step on a single fast frame, with the right direction", () => {
        const d = new SwipeDetector();
        expect(d.update(SWIPE_DEFAULTS.distance + 0.2, DT)).toBe(1);  // rightward
        const d2 = new SwipeDetector();
        expect(d2.update(-(SWIPE_DEFAULTS.distance + 0.2), DT)).toBe(-1); // leftward
    });

    it("registers a finger-only flick: several moderate frames whose per-frame vx is well below the old single-frame bar", () => {
        const d = new SwipeDetector();
        // 0.12/frame is far below the old 0.3–0.4 single-frame threshold, but the net
        // displacement over the flick crosses the distance bar.
        const { steps, lastDir } = run(d, 0.12, 6);
        expect(steps).toBe(1);
        expect(lastDir).toBe(1);
    });

    it("never fires on zero-mean jitter", () => {
        const d = new SwipeDetector();
        let steps = 0;
        for (let i = 0; i < 120; i++) {
            const vx = (i % 2 === 0 ? 1 : -1) * 0.18; // big-ish but alternating → ~0 net
            if (d.update(vx, DT) !== 0) steps++;
        }
        expect(steps).toBe(0);
    });

    it("one sustained sweep is exactly one step (cooldown blocks the tail)", () => {
        const d = new SwipeDetector();
        // Hold a fast velocity for 10 frames (160 ms < cooldown): only the first frame steps.
        const { steps } = run(d, 0.6, 10);
        expect(steps).toBe(1);
    });

    it("re-arms after the hand settles, so a second deliberate swipe steps again", () => {
        const d = new SwipeDetector();
        expect(run(d, 0.6, 1).steps).toBe(1);   // first step
        run(d, 0, 30);                            // settle: decay below `settle` + clear cooldown
        expect(run(d, 0.6, 1).steps).toBe(1);   // second deliberate swipe steps
    });

    it("reset() clears the accumulator and cooldown", () => {
        const d = new SwipeDetector();
        run(d, 0.6, 3);     // fire + load the accumulator
        d.reset();
        // A lone sub-threshold frame right after reset must not fire.
        expect(d.update(0.1, DT)).toBe(0);
    });
});
