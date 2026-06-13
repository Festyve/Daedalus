// Gesture classification + debounce (SPEC §12). Turns a single hand's landmarks into
// a GestureState (name + continuous channels), and commits discrete poses only after
// 5 consecutive frames so detection never flickers. Pure and unit-testable; the only
// state lives inside GestureDebouncer. All thresholds come from predicates.ts / §12.
import type { Vec3, GestureState, GestureName } from "../types";
import {
    handScale,
    pinchAmount,
    spreadAmount,
    isPinching,
    isGun,
    isFist,
    isOpenPalm,
    fingerExtended,
} from "./predicates";

// MediaPipe Hands landmark indices used here (mirror of predicates.ts).
const WRIST = 0;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;

// Tip / PIP pairs for the four non-thumb fingers, in finger order (index→pinky).
const FINGER_TIPS = [8, 12, 16, 20];
const FINGER_PIPS = [6, 10, 14, 18];

// §12: flick fires when index-tip horizontal speed exceeds 0.4 of hand scale per frame.
// vx is already normalized by S, so the comparison is against the bare ratio.
const FLICK_VX = 0.4;

// §12: discrete poses (gun / fist / open palm) must persist this many consecutive
// frames before they commit. Flick is intentionally exempt — it is a transient swipe,
// not a held pose, so it passes straight through.
const DEBOUNCE_FRAMES = 5;

const EPS = 1e-6;

/** Count of extended non-thumb fingers (index→pinky), 0..4. */
function countExtended(lm: Vec3[]): number {
    let n = 0;
    for (let i = 0; i < FINGER_TIPS.length; i++) {
        if (fingerExtended(lm, FINGER_TIPS[i], FINGER_PIPS[i])) n++;
    }
    return n;
}

/**
 * Image-space hand scale: ‖wrist(0) − middleMCP(9)‖ over the normalized, mirrored
 * landmarks. Used to make vx dimensionless ("units of S per frame") so it stays
 * invariant to hand size / camera distance, matching the world-space S elsewhere.
 */
function imageScale(lm: Vec3[]): number {
    const a = lm[WRIST];
    const b = lm[MIDDLE_MCP];
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), EPS);
}

/**
 * Classify one hand into a GestureState (§12).
 *
 * - `name`     discrete pose this frame (pre-debounce): pinch > gun > fist > open >
 *              flick > point > none. Callers debounce held poses via GestureDebouncer.
 * - `extended` count of extended non-thumb fingers (0..4).
 * - `pinch`    0..1 closure (1 = fully pinched).
 * - `spread`   mean adjacent-fingertip separation in units of S.
 * - `vx`       index-tip horizontal velocity in units of S per frame; needs `prevLm`
 *              (the previous frame's image-space landmarks). 0 when no previous frame.
 *
 * @param lm     this frame's image-space landmarks (21, normalized, mirrored); used
 *               only for the screen-horizontal velocity channel `vx`.
 * @param world  this frame's metric landmarks (21); source of hand scale S and of all
 *               pose-shape thresholds (§3.5), so numerator and S share one space.
 * @param prevLm previous frame's image-space landmarks, or null/undefined on frame 1.
 */
export function classify(lm: Vec3[], world: Vec3[], prevLm?: Vec3[] | null): GestureState {
    const s = handScale(world);

    // Pose-shape thresholds are fractions of the world-space hand scale S (§3.5/§12),
    // so they must read the WORLD landmarks too — feeding image-space `lm` here would
    // divide an image-space numerator by a metric S, a non-dimensionless ratio that
    // drifts with camera distance and frame aspect. Only `vx` below stays in image
    // space, where a screen-horizontal flick velocity belongs.
    const pinch = pinchAmount(world, s);
    const spread = spreadAmount(world, s);
    const extended = countExtended(world);

    // Horizontal index-tip velocity, normalized by the image-space hand scale so the
    // result is a unitless per-frame ratio. Positive = rightward in mirrored image space.
    let vx = 0;
    if (prevLm) {
        vx = (lm[INDEX_TIP].x - prevLm[INDEX_TIP].x) / imageScale(lm);
    }

    // Discrete name. Pinch wins over poses (it is the select action), then the held
    // poses in §12 order, then flick (transient), then a bare point, else none.
    let name: GestureName = "none";
    if (isPinching(world, s)) {
        name = "pinch";
    } else if (isGun(world, s)) {
        name = "gun";
    } else if (isFist(world, s)) {
        name = "fist";
    } else if (isOpenPalm(world, s)) {
        name = "open";
    } else if (Math.abs(vx) > FLICK_VX) {
        name = "flick";
    } else if (extended === 1 && fingerExtended(world, FINGER_TIPS[0], FINGER_PIPS[0])) {
        // Index alone extended (no thumb-up → not a gun): a plain pointing hand.
        name = "point";
    }

    return { name, extended, pinch, spread, vx };
}

/**
 * Five-frame debounce for discrete gestures (§12). Feed the per-frame `classify` name;
 * `push` returns the currently committed gesture. A new pose only commits after it has
 * been seen DEBOUNCE_FRAMES consecutive frames; until then the previously committed
 * gesture is held. "flick" is transient and commits immediately (no flicker to guard).
 */
export class GestureDebouncer {
    private committed: GestureName = "none";
    private candidate: GestureName = "none";
    private streak = 0;

    /** Advance one frame with the raw classified name; returns the committed name. */
    push(name: GestureName): GestureName {
        // Flick is momentary — pass through without requiring a 5-frame streak, and do
        // not let it disturb the committed held-pose state.
        if (name === "flick") {
            return "flick";
        }

        if (name === this.candidate) {
            this.streak++;
        } else {
            this.candidate = name;
            this.streak = 1;
        }

        if (this.streak >= DEBOUNCE_FRAMES) {
            this.committed = this.candidate;
        }
        return this.committed;
    }
}
