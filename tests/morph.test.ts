import { describe, it, expect } from "vitest";
import { buildDonutMorphGeometry } from "../src/render/geometry";

describe("donut morph geometry", () => {
    const g = buildDonutMorphGeometry(64, 48, 1.0, 0.42);
    it("base and target share vertex count", () => {
        const base = g.attributes.position.count;
        const target = g.morphAttributes.position[0].count;
        expect(target).toBe(base);
    });
    it("base is a unit-ish sphere (all radii ~equal)", () => {
        const p = g.attributes.position; let minR = Infinity, maxR = 0;
        for (let i = 0; i < p.count; i++) { const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i)); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
        expect(maxR - minR).toBeLessThan(1e-6);
    });
    it("target hole axis is Y (donut lies in XZ)", () => {
        const t = g.morphAttributes.position[0]; let maxY = 0;
        for (let i = 0; i < t.count; i++) maxY = Math.max(maxY, Math.abs(t.getY(i)));
        expect(maxY).toBeCloseTo(0.42, 2); // tube radius r bounds |y|
    });
});
