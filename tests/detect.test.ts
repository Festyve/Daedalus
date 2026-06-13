// Detect-level wiring tests (SPEC §3.5, §12). classify() must measure the pose-shape
// thresholds in the SAME coordinate space as the hand scale S — world landmarks
// (meters) — so detection stays invariant to hand size and camera distance. These
// guard the wiring in detect.ts, which the predicate unit tests cannot catch: those
// feed a single consistent landmark set to both the numerator and S, so an image/world
// space mismatch is invisible there. See predicates.test.ts for the threshold math.
import { describe, it, expect } from "vitest";
import { classify } from "../src/gesture/detect";
import type { Vec3 } from "../src/types";

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

/** Fresh 21-landmark array, all at the origin. */
function blankHand(): Vec3[] {
    return Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
}

/**
 * A pinching hand scaled uniformly by `scale`: wrist at origin, middleMCP at
 * (0, scale, 0) so S = scale, index tip just past it, thumb tip gap_ratio·S away
 * along x. The thumb–index gap is gap_ratio·S at EVERY scale, so this is the same
 * real pose at any size — only the overall scale changes (≈ camera distance in image
 * space, or metric hand size in world space). gap_ratio < 0.30 ⇒ a pinch.
 */
function pinchHandAtScale(scale: number, gap_ratio: number): Vec3[] {
    const lm = blankHand();
    lm[WRIST] = { x: 0, y: 0, z: 0 };
    lm[MIDDLE_MCP] = { x: 0, y: scale, z: 0 };                       // S = scale
    lm[INDEX_TIP] = { x: 0, y: 1.2 * scale, z: 0 };
    lm[THUMB_TIP] = { x: gap_ratio * scale, y: 1.2 * scale, z: 0 };  // gap = gap_ratio·S
    return lm;
}

describe("classify scale wiring (§3.5)", () => {
    // A genuine pinch (thumb–index gap = 0.2·S < 0.30). The world hand is metric
    // (S ≈ 0.12 m); the image hands are the SAME pose rendered larger/smaller in the
    // frame depending on how close the hand is to the camera.
    const world = pinchHandAtScale(0.12, 0.2);
    const imageClose = pinchHandAtScale(0.45, 0.2); // hand near camera → large in frame
    const imageFar = pinchHandAtScale(0.15, 0.2);   // hand far → small in frame

    it("detects a pinch using world-space S, not the image-space gap", () => {
        // Buggy wiring divides the large image gap (0.09) by the world S (0.12) → 0.75,
        // far above the 0.30 pinch threshold, so it misses the pinch. Correct wiring
        // measures gap and S in the same (world) space: 0.024/0.12 = 0.20 < 0.30 → pinch.
        expect(classify(imageClose, world).name).toBe("pinch");
    });

    it("classifies the same world hand identically regardless of image scale (§3.5)", () => {
        // Camera distance changes only the image-space landmark scale; the metric world
        // hand is unchanged, so the detected pose must not change with it.
        expect(classify(imageFar, world).name).toBe(classify(imageClose, world).name);
    });

    it("does not report a pinch when the world thumb–index gap is wide", () => {
        // gap = 0.8·S in world → 0.8 ≫ 0.30 → not a pinch, at any image scale.
        const wideWorld = pinchHandAtScale(0.12, 0.8);
        const wideImage = pinchHandAtScale(0.45, 0.8);
        expect(classify(wideImage, wideWorld).name).not.toBe("pinch");
    });
});
