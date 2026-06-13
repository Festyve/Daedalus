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

    it("does not fire below threshold", () => {
        const d = new SwipeDetector();
        expect(d.update(0.3, DT)).toBe(0);  // < 0.5, no step
        expect(d.update(0.3, DT)).toBe(0);  // still < 0.5
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
});
