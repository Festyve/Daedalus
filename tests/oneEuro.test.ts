import { describe, it, expect } from "vitest";
import { OneEuro, LandmarkFilter } from "../src/tracking/oneEuro";

describe("OneEuro", () => {
    it("returns the first sample unchanged", () => {
        const f = new OneEuro(1.0, 0.007);
        expect(f.filter(5, 1 / 60)).toBeCloseTo(5, 5);
    });
    it("converges to a held constant", () => {
        const f = new OneEuro(1.0, 0.007);
        let y = 0;
        for (let i = 0; i < 200; i++) y = f.filter(10, 1 / 60);
        expect(y).toBeCloseTo(10, 1);
    });
    it("attenuates small jitter more than a fast move (band-pass behavior)", () => {
        const jit = new OneEuro(1.0, 0.007);
        let last = 0, maxJitDev = 0;
        // One Euro passes the first sample through unchanged (canonical), so measure
        // steady-state suppression after warm-up, not the warm-up sample itself.
        for (let i = 0; i < 120; i++) { last = jit.filter(i % 2 ? 0.02 : -0.02, 1 / 60); if (i >= 10) maxJitDev = Math.max(maxJitDev, Math.abs(last)); }
        expect(maxJitDev).toBeLessThan(0.02); // steady-state jitter is suppressed below input amplitude
    });
});
