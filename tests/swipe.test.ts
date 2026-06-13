import { describe, it, expect } from "vitest";
import { SwipeDetector } from "../src/gesture/swipe";

const DT = 16; // ~60 fps

describe("SwipeDetector", () => {
    it("fires one step on a single high-velocity frame, with correct direction", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);  // rightward, > 0.5 threshold
        const d2 = new SwipeDetector();
        expect(d2.update(-0.6, DT)).toBe(-1); // leftward
    });

    it("does not fire below threshold on single low-velocity frame", () => {
        const d = new SwipeDetector();
        expect(d.update(0.2, DT)).toBe(0);  // single frame below distance threshold
        // Accumulator decays away without firing
        for (let i = 0; i < 10; i++) {
            expect(d.update(0, DT)).toBe(0);
        }
    });

    it("cooldown blocks subsequent high-velocity frames", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);   // fires, cooldown = 250ms
        expect(d.update(0.6, DT)).toBe(0);   // blocked by cooldown (still ~234ms left)
        expect(d.update(0.6, DT)).toBe(0);   // still blocked
    });

    it("re-fires after cooldown expires", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);   // fires, cooldown = 250ms
        // Advance ~260ms (16 frames) to exceed cooldown
        for (let i = 0; i < 16; i++) {
            d.update(0, DT);
        }
        expect(d.update(0.6, DT)).toBe(1);   // cooldown expired, fires again
    });

    it("reset() clears cooldown", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);   // fires, cooldown = 250ms
        d.reset();
        expect(d.update(0.6, DT)).toBe(1);   // immediately fires after reset
    });

    it("direction sign is preserved and correct", () => {
        const d = new SwipeDetector();
        const r1 = d.update(0.7, DT);
        expect(r1).toBe(1);

        const d2 = new SwipeDetector();
        const r2 = d2.update(-0.8, DT);
        expect(r2).toBe(-1);
    });

    it("handles zero or negative dtMs gracefully", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, 0)).toBe(1);      // zero dt, should still fire
        expect(d.update(0.6, -5)).toBe(0);     // negative dt, cooldown already set
    });

    it("cooldown decays on each frame", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);  // fires, cooldown = 260ms, armed = false
        expect(d.update(0.1, 50)).toBe(0);  // 50ms passes, cooldown now ~210ms
        expect(d.update(0.1, 50)).toBe(0);  // 50ms more, ~160ms left
        expect(d.update(0.1, 50)).toBe(0);  // 50ms more, ~110ms left
        expect(d.update(0.1, 60)).toBe(0);  // 60ms more, ~50ms left
        // Cooldown expires after 260ms total, but net hasn't settled below settle (0.12)
        expect(d.update(0, 50)).toBe(0);    // net decays but still > 0.12, armed still false
        expect(d.update(0, 60)).toBe(0);    // enough decay: net should now be < 0.12, armed re-arms
        expect(d.update(0.6, DT)).toBe(1);   // fires again (armed + cooldown expired + threshold met)
    });
});
