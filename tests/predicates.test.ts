// Unit tests for the gesture predicates (SPEC §10.1, §12). Pure math only — no
// camera, no browser, no MediaPipe. Every fixture is a hand-crafted 21-landmark
// array; thresholds are validated as fractions of the hand scale S = ‖wrist − middleMCP‖.
import { describe, it, expect } from "vitest";
import {
    handScale,
    pinchAmount,
    isPinching,
    fingerExtended,
    spreadAmount,
    isGun,
    isFist,
    isOpenPalm,
} from "../src/gesture/predicates";
import type { Vec3 } from "../src/types";

// MediaPipe Hands landmark indices used by the fixtures below.
const WRIST = 0;
const THUMB_IP = 3;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

// The four non-thumb fingers as [tip, pip] pairs (matches predicates.ts scans).
const FINGERS: ReadonlyArray<readonly [number, number]> = [
    [INDEX_TIP, INDEX_PIP],
    [MIDDLE_TIP, MIDDLE_PIP],
    [RING_TIP, RING_PIP],
    [PINKY_TIP, PINKY_PIP],
];

/** Fresh 21-landmark array, all at the origin. Callers overwrite the ones they care about. */
function blankHand(): Vec3[] {
    return Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
}

/**
 * Wrist at origin, middleMCP at +0.3·y → handScale S = 0.3. Fingers point along +y:
 * each tip sits beyond its pip when `extend` is true (extended) and short of it when
 * false (curled). Thumb tip is parked off to the side so it neither pinches the index
 * nor counts as "up". Spread is controlled by spacing the four fingertips along x.
 */
function syntheticHand(opts: {
    extend: boolean;
    spread?: number;        // x-gap between adjacent fingertips (0 → all colinear)
    thumbTip?: Vec3;        // override thumb tip (pinch / fist / gun control)
    thumbExtended?: boolean; // place thumb tip beyond its IP joint from the wrist
}): Vec3[] {
    const lm = blankHand();
    lm[WRIST] = { x: 0, y: 0, z: 0 };
    lm[MIDDLE_MCP] = { x: 0, y: 0.3, z: 0 }; // S = 0.3

    const tip_y = opts.extend ? 0.9 : 0.25;
    const pip_y = 0.5;
    const gap = opts.spread ?? 0;
    // Center the four fingers on x so the spread is symmetric about the middle finger.
    const base_x = -1.5 * gap;
    FINGERS.forEach(([tip, pip], i) => {
        const fx = base_x + i * gap;
        lm[tip] = { x: fx, y: tip_y, z: 0 };
        lm[pip] = { x: fx, y: pip_y, z: 0 };
    });

    // MCP anchors for the thumb-extension geometry (only INDEX_MCP is read indirectly).
    lm[INDEX_MCP] = { x: 0, y: 0.4, z: 0 };

    // Thumb: IP joint fixed; tip is either an explicit override or a parked default.
    lm[THUMB_IP] = { x: 0.2, y: 0.3, z: 0 };
    if (opts.thumbTip) {
        lm[THUMB_TIP] = opts.thumbTip;
    } else if (opts.thumbExtended) {
        // Beyond the IP joint relative to the wrist → fingerExtended(thumb) is true.
        lm[THUMB_TIP] = { x: 0.45, y: 0.45, z: 0 };
    } else {
        // Off to the side, close to the wrist → not extended, not "up".
        lm[THUMB_TIP] = { x: 0.25, y: 0.15, z: 0 };
    }
    return lm;
}

describe("handScale", () => {
    it("equals ‖wrist − middleMCP‖", () => {
        const lm = syntheticHand({ extend: true });
        expect(handScale(lm)).toBeCloseTo(0.3, 6);
    });

    it("is floored to a tiny positive epsilon when wrist and middleMCP coincide", () => {
        const lm = blankHand(); // every point at origin
        const s = handScale(lm);
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThan(1e-3);
    });
});

describe("isPinching", () => {
    it("is true when ‖tip4 − tip8‖ / S < 0.30", () => {
        // index tip at (0, 0.9); place thumb tip 0.06 away → ratio 0.06/0.3 = 0.20 < 0.30.
        const lm = syntheticHand({ extend: true, thumbTip: { x: 0.06, y: 0.9, z: 0 } });
        expect(isPinching(lm, handScale(lm))).toBe(true);
    });

    it("is false when the tips are far apart", () => {
        // ratio 0.25/0.3 ≈ 0.83 ≫ 0.30.
        const lm = syntheticHand({ extend: true, thumbTip: { x: 0.25, y: 0.9, z: 0 } });
        expect(isPinching(lm, handScale(lm))).toBe(false);
    });

    it("is false exactly at the 0.30 boundary (strict <)", () => {
        // ratio = 0.09/0.3 = 0.30 exactly → not pinching.
        const lm = syntheticHand({ extend: true, thumbTip: { x: 0.09, y: 0.9, z: 0 } });
        expect(isPinching(lm, handScale(lm))).toBe(false);
    });
});

describe("pinchAmount", () => {
    it("clamps to 1 at or below the pinch threshold (r ≤ 0.30)", () => {
        const lm = syntheticHand({ extend: true, thumbTip: { x: 0.0, y: 0.9, z: 0 } });
        expect(pinchAmount(lm, handScale(lm))).toBe(1);
    });

    it("clamps to 0 at or beyond the release threshold (r ≥ 0.90)", () => {
        // ratio 0.30/0.3 = 1.0 ≥ 0.90 → 0.
        const lm = syntheticHand({ extend: true, thumbTip: { x: 0.30, y: 0.9, z: 0 } });
        expect(pinchAmount(lm, handScale(lm))).toBe(0);
    });

    it("interpolates linearly between the thresholds", () => {
        // ratio 0.18/0.3 = 0.60, midway in [0.30, 0.90] → 0.5.
        const lm = syntheticHand({ extend: true, thumbTip: { x: 0.18, y: 0.9, z: 0 } });
        expect(pinchAmount(lm, handScale(lm))).toBeCloseTo(0.5, 6);
    });

    it("stays within [0, 1] for any input", () => {
        for (const dx of [-1, 0, 0.05, 0.18, 0.27, 0.9, 5]) {
            const lm = syntheticHand({ extend: true, thumbTip: { x: dx, y: 0.9, z: 0 } });
            const a = pinchAmount(lm, handScale(lm));
            expect(a).toBeGreaterThanOrEqual(0);
            expect(a).toBeLessThanOrEqual(1);
        }
    });
});

describe("fingerExtended", () => {
    it("is true when the tip is farther from the wrist than the pip", () => {
        const lm = syntheticHand({ extend: true });
        expect(fingerExtended(lm, INDEX_TIP, INDEX_PIP)).toBe(true);
    });

    it("is false when the tip is curled in closer than the pip", () => {
        const lm = syntheticHand({ extend: false });
        expect(fingerExtended(lm, INDEX_TIP, INDEX_PIP)).toBe(false);
    });
});

describe("spreadAmount", () => {
    it("is zero when the four fingertips are colinear", () => {
        const lm = syntheticHand({ extend: true, spread: 0 });
        expect(spreadAmount(lm, handScale(lm))).toBeCloseTo(0, 6);
    });

    it("grows with fingertip separation and is finite", () => {
        const tight = spreadAmount(syntheticHand({ extend: true, spread: 0.05 }), 0.3);
        const wide = spreadAmount(syntheticHand({ extend: true, spread: 0.2 }), 0.3);
        expect(wide).toBeGreaterThan(tight);
        expect(Number.isFinite(wide)).toBe(true);
    });

    it("normalizes by S — mean adjacent gap over S", () => {
        // Three equal gaps of 0.12 each → mean 0.12; over S=0.3 → 0.4.
        const lm = syntheticHand({ extend: true, spread: 0.12 });
        expect(spreadAmount(lm, handScale(lm))).toBeCloseTo(0.4, 6);
    });
});

describe("isFist", () => {
    it("is true when all four fingers are curled and the thumb–index gap > 0.6·S", () => {
        // curled fingers; thumb parked far from the curled index tip (0,0.25).
        const lm = syntheticHand({ extend: false, thumbTip: { x: 0.3, y: 0.15, z: 0 } });
        // sanity: separation ratio must exceed 0.6.
        const sep = Math.hypot(lm[THUMB_TIP].x - lm[INDEX_TIP].x, lm[THUMB_TIP].y - lm[INDEX_TIP].y);
        expect(sep / handScale(lm)).toBeGreaterThan(0.6);
        expect(isFist(lm, handScale(lm))).toBe(true);
    });

    it("is false when any finger is extended", () => {
        const lm = syntheticHand({ extend: true, thumbTip: { x: 0.3, y: 0.15, z: 0 } });
        expect(isFist(lm, handScale(lm))).toBe(false);
    });

    it("is false when the thumb hugs the index (separation ≤ 0.6·S)", () => {
        // fingers curled but thumb tip right next to the curled index tip → tiny gap.
        const lm = syntheticHand({ extend: false, thumbTip: { x: 0.0, y: 0.25, z: 0 } });
        expect(isFist(lm, handScale(lm))).toBe(false);
    });
});

describe("isOpenPalm", () => {
    it("is true when all five fingers are extended and spread > 0.4·S", () => {
        // spread 0.12 → spreadAmount 0.4 exactly is NOT > 0.4, so widen to 0.15 → 0.5.
        const lm = syntheticHand({ extend: true, spread: 0.15, thumbExtended: true });
        expect(spreadAmount(lm, handScale(lm))).toBeGreaterThan(0.4);
        expect(isOpenPalm(lm, handScale(lm))).toBe(true);
    });

    it("is false when the spread is too small even if all fingers are extended", () => {
        const lm = syntheticHand({ extend: true, spread: 0.05, thumbExtended: true });
        expect(spreadAmount(lm, handScale(lm))).toBeLessThan(0.4);
        expect(isOpenPalm(lm, handScale(lm))).toBe(false);
    });

    it("is false when the thumb is not extended", () => {
        // wide spread + extended fingers, but thumb tucked → not an open palm.
        const lm = syntheticHand({ extend: true, spread: 0.15, thumbExtended: false });
        expect(isOpenPalm(lm, handScale(lm))).toBe(false);
    });

    it("is false for a curled (fist) hand", () => {
        const lm = syntheticHand({ extend: false, spread: 0.15, thumbExtended: true });
        expect(isOpenPalm(lm, handScale(lm))).toBe(false);
    });
});

describe("isGun", () => {
    /**
     * Gun pose: index extended, thumb "up" (‖tip4 − wrist‖/S > 0.5), ring & pinky curled.
     * Build it landmark by landmark so the middle finger's curl state is irrelevant to
     * the predicate (it only reads index/ring/pinky + thumb).
     */
    function gunHand(overrides: Partial<{
        indexExtended: boolean;
        ringCurled: boolean;
        pinkyCurled: boolean;
        thumbUp: boolean;
    }> = {}): Vec3[] {
        const o = {
            indexExtended: true,
            ringCurled: true,
            pinkyCurled: true,
            thumbUp: true,
            ...overrides,
        };
        const lm = blankHand();
        lm[WRIST] = { x: 0, y: 0, z: 0 };
        lm[MIDDLE_MCP] = { x: 0, y: 0.3, z: 0 }; // S = 0.3

        const pip_y = 0.5;
        // Index: extended → tip beyond pip; otherwise curled in.
        lm[INDEX_PIP] = { x: 0, y: pip_y, z: 0 };
        lm[INDEX_TIP] = { x: 0, y: o.indexExtended ? 0.95 : 0.3, z: 0 };
        // Ring: curled → tip nearer the wrist than its pip.
        lm[RING_PIP] = { x: 0.2, y: pip_y, z: 0 };
        lm[RING_TIP] = { x: 0.2, y: o.ringCurled ? 0.3 : 0.95, z: 0 };
        // Pinky: curled → tip nearer the wrist than its pip.
        lm[PINKY_PIP] = { x: 0.35, y: pip_y, z: 0 };
        lm[PINKY_TIP] = { x: 0.35, y: o.pinkyCurled ? 0.3 : 0.95, z: 0 };
        // Thumb "up": ‖tip4 − wrist‖/S > 0.5 → distance > 0.15 (S=0.3) when up.
        lm[THUMB_TIP] = o.thumbUp ? { x: 0.4, y: 0.4, z: 0 } : { x: 0.05, y: 0.05, z: 0 };
        return lm;
    }

    it("is true for index-extended + thumb-up + ring/pinky curled", () => {
        const lm = gunHand();
        expect(isGun(lm, handScale(lm))).toBe(true);
    });

    it("is false when the index is curled", () => {
        const lm = gunHand({ indexExtended: false });
        expect(isGun(lm, handScale(lm))).toBe(false);
    });

    it("is false when the ring finger is extended", () => {
        const lm = gunHand({ ringCurled: false });
        expect(isGun(lm, handScale(lm))).toBe(false);
    });

    it("is false when the pinky is extended", () => {
        const lm = gunHand({ pinkyCurled: false });
        expect(isGun(lm, handScale(lm))).toBe(false);
    });

    it("is false when the thumb is tucked down (not up)", () => {
        const lm = gunHand({ thumbUp: false });
        expect(isGun(lm, handScale(lm))).toBe(false);
    });
});
