// Gesture predicate math (SPEC §12). Pure, unit-testable. Every threshold is a
// fraction of hand scale S = ‖wrist(0) − middleMCP(9)‖, so detection is invariant to
// hand size and distance from the camera (§3.5). All distances are 3D (Vec3).
import type { Vec3 } from "../types";

// MediaPipe Hands landmark indices.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

// Fingertip / PIP pairs for the four non-thumb fingers, used by spread + extension scans.
const FINGER_TIPS = [8, 12, 16, 20];
const FINGER_PIPS = [6, 10, 14, 18];

// §12 thresholds (fractions of S unless noted).
const PINCH_RATIO = 0.45;        // pinch:   ‖tip4−tip8‖/S < 0.45 (touching ≈ depth/landmark noise)
const FIST_SEPARATION = 0.6;     // fist:    ‖tip4−tip8‖/S > 0.6 (plus all curled)
const OPEN_SPREAD = 0.4;         // open:    spread > 0.4·S
const THUMB_UP_RATIO = 0.5;      // gun:     thumb tip raised away from index MCP region
const PINCH_RELEASE = 0.62;      // pinchAmount maps [PINCH_RATIO, RELEASE] → [1, 0]
const EPS = 1e-6;

/** Euclidean distance between two 3D landmarks. */
function dist(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Hand scale S = ‖wrist(0) − middleMCP(9)‖ (§3.5). Floored to avoid divide-by-zero. */
export function handScale(world: Vec3[]): number {
    return Math.max(dist(world[WRIST], world[MIDDLE_MCP]), EPS);
}

/**
 * Pinch closure in 0..1 (1 = fully pinched). Maps the normalized thumb–index gap
 * r = ‖tip4−tip8‖/S from [PINCH_RATIO .. PINCH_RELEASE] onto [1 .. 0] and clamps.
 * isPinching() fires when this exceeds the PINCH_RATIO crossing (§12).
 */
export function pinchAmount(lm: Vec3[], s: number): number {
    const denom = Math.max(s, EPS);
    const r = dist(lm[THUMB_TIP], lm[INDEX_TIP]) / denom;
    const t = (PINCH_RELEASE - r) / (PINCH_RELEASE - PINCH_RATIO);
    return Math.min(1, Math.max(0, t));
}

/** Pinch: ‖tip4−tip8‖/S < 0.45 (§12). */
export function isPinching(lm: Vec3[], s: number): boolean {
    const denom = Math.max(s, EPS);
    return dist(lm[THUMB_TIP], lm[INDEX_TIP]) / denom < PINCH_RATIO;
}

/**
 * A finger is extended when its tip is farther from the wrist than its PIP joint —
 * the joint chain is straightened rather than curled. Indices are caller-supplied so
 * detect.ts can scan any finger (§12).
 */
export function fingerExtended(lm: Vec3[], tipIdx: number, pipIdx: number): boolean {
    const wrist = lm[WRIST];
    return dist(lm[tipIdx], wrist) > dist(lm[pipIdx], wrist);
}

/**
 * Mean adjacent-fingertip separation across index→middle→ring→pinky, in units of S.
 * Open palm requires spread > 0.4 (i.e. spread·S > 0.4·S, §12).
 */
export function spreadAmount(lm: Vec3[], s: number): number {
    const denom = Math.max(s, EPS);
    const gaps =
        dist(lm[8], lm[12]) +
        dist(lm[12], lm[16]) +
        dist(lm[16], lm[20]);
    return gaps / 3 / denom;
}

/** Gun pose: index extended + thumb up + ring & pinky curled (§12). */
export function isGun(lm: Vec3[], s: number): boolean {
    const indexExtended = fingerExtended(lm, INDEX_TIP, FINGER_PIPS[0]);
    const ringCurled = !fingerExtended(lm, RING_TIP, RING_PIP);
    const pinkyCurled = !fingerExtended(lm, PINKY_TIP, PINKY_PIP);
    // Thumb "up": tip stands clear of the wrist–index span, > THUMB_UP_RATIO·S out.
    const denom = Math.max(s, EPS);
    const thumbUp = dist(lm[THUMB_TIP], lm[WRIST]) / denom > THUMB_UP_RATIO;
    return indexExtended && thumbUp && ringCurled && pinkyCurled;
}

/** Fist: all four fingers curled AND thumb–index separation ‖tip4−tip8‖/S > 0.6 (§12). */
export function isFist(lm: Vec3[], s: number): boolean {
    for (let i = 0; i < FINGER_TIPS.length; i++) {
        if (fingerExtended(lm, FINGER_TIPS[i], FINGER_PIPS[i])) return false;
    }
    const denom = Math.max(s, EPS);
    return dist(lm[THUMB_TIP], lm[INDEX_TIP]) / denom > FIST_SEPARATION;
}

/** Open palm: all five fingers extended AND spread > 0.4·S (§12). */
export function isOpenPalm(lm: Vec3[], s: number): boolean {
    for (let i = 0; i < FINGER_TIPS.length; i++) {
        if (!fingerExtended(lm, FINGER_TIPS[i], FINGER_PIPS[i])) return false;
    }
    // Thumb extension: tip farther from wrist than its IP joint (landmark 3).
    if (!fingerExtended(lm, THUMB_TIP, 3)) return false;
    return spreadAmount(lm, s) > OPEN_SPREAD;
}

/**
 * Three-finger sign: index + middle + ring extended, pinky curled (thumb ignored). A deliberate
 * pose that a fist's release never passes through (release opens toward a flat palm, not three
 * fingers) and that the gun predicate can't match (gun needs the ring CURLED) — so it is a safe,
 * collision-free, gun-proof trigger. SELECT uses it to mark a shape as a cutter.
 */
export function isThreeFingers(lm: Vec3[]): boolean {
    return fingerExtended(lm, INDEX_TIP, FINGER_PIPS[0]) &&
        fingerExtended(lm, FINGER_TIPS[1], FINGER_PIPS[1]) &&
        fingerExtended(lm, RING_TIP, RING_PIP) &&
        !fingerExtended(lm, PINKY_TIP, PINKY_PIP);
}

/**
 * Rock / "horns" sign: index + pinky extended, middle + ring curled (thumb ignored). Distinct from
 * the gun (which needs the pinky CURLED) and from a fist's release, so it is a safe, gun-proof
 * trigger — SELECT uses it to deselect everything.
 */
export function isHorns(lm: Vec3[]): boolean {
    return fingerExtended(lm, INDEX_TIP, FINGER_PIPS[0]) &&
        !fingerExtended(lm, FINGER_TIPS[1], FINGER_PIPS[1]) &&
        !fingerExtended(lm, RING_TIP, RING_PIP) &&
        fingerExtended(lm, PINKY_TIP, PINKY_PIP);
}
