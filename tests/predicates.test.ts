import { describe, it, expect } from "vitest";
import { classify, palmCenter, handScale, fingerSpread } from "../src/gesture/predicates";

// minimal synthetic hand: wrist at origin, fingers along +y
function hand(extend: boolean) {
    const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    lm[0] = { x: 0, y: 0, z: 0 };       // wrist
    lm[9] = { x: 0, y: 0.3, z: 0 };     // middle MCP → handScale 0.3
    const tipY = extend ? 0.9 : 0.25, pipY = 0.5;
    for (const [tip, pip] of [[8,6],[12,10],[16,14],[20,18]]) { lm[tip] = { x: 0, y: tipY, z: 0 }; lm[pip] = { x: 0, y: pipY, z: 0 }; }
    lm[4] = { x: 0.25, y: 0.15, z: 0 }; // thumb tip, off to the side (not touching the index tip)
    return lm;
}
describe("predicates", () => {
    it("handScale = ||wrist - middleMCP||", () => { expect(handScale(hand(true))).toBeCloseTo(0.3, 5); });
    it("open hand → 'open'", () => { expect(classify(hand(true)).name).toBe("open"); });
    it("curled hand → 'fist'", () => { expect(classify(hand(false)).name).toBe("fist"); });
    it("spread is normalized & finite", () => { const s = fingerSpread(hand(true)); expect(s).toBeGreaterThanOrEqual(0); expect(Number.isFinite(s)).toBe(true); });
});
