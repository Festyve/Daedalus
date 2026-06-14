// Camera Orbit Mode controller (SPEC — Camera Orbit Mode, Part 1).
//
// In the idle state (tool carousel closed, no active tool) BOTH hands closing into a grab
// pose simultaneously engages a camera orbit about the scene center. This is a bilateral
// gesture like the parting-curtains view toggle (render/viewMode.ts): it reads the true
// Left/Right hands directly, independent of the exec/nav role assignment.
//
// Relative-drag drive (the chosen feel): on engage we LATCH the rig's committed (θ, φ, r)
// plus the two-hand image-space midpoint and wrist spread. Each frame thereafter the camera
// tracks the accumulated offset from that latch — hands still ⇒ camera still — so the user
// can land on a precise angle, matching the TRANSLATE grab paradigm.
//
//   hands move left/right  → Δ midpoint.x → orbit azimuth  (around Y)
//   hands move up/down      → Δ midpoint.y → orbit elevation (around X)
//   hands together/apart    → wrist spread  → zoom: r = r₀ · d₀/d  (apart ⇒ zoom in)
//
// Releasing EITHER hand (open palm, debounced) or losing a hand locks the camera where it is
// (the rig keeps its committed state) and ends the mode. Discrete transitions are debounced
// over a few frames (§12) so a single misclassified frame cannot flip engage/release.
//
// Pure logic, no Three.js scene mutation beyond writing the rig — unit-testable headless.
import type { HandPose, Vec3 } from "../types";
import { isOpenPalm, fingerExtended } from "../gesture/predicates";
import type { CameraRig } from "../render/cameraRig";

// MediaPipe wrist landmark — the two-hand midpoint + spread are measured from the wrists in
// normalized image space (same space the parting-curtains velocity uses).
const WRIST = 0;

// Non-thumb fingertip / PIP pairs. A hand is "closed" when all four are curled — the same
// forgiving, thumb-agnostic grab signal TRANSLATE / DILATE / MORPH use (isFist() rarely fires
// on a natural clenched fist because the thumb wraps in toward the index).
const FINGER_TIPS = [8, 12, 16, 20];
const FINGER_PIPS = [6, 10, 14, 18];

// Discrete engage/release commit after this many consecutive frames (§12 debounce).
const COMMIT_FRAMES = 3;

// Drag gains: image-space midpoint travel (normalized [0,1]) → orbit radians. π means a full
// screen-width sweep maps to ~180°; a natural ~0.2-screen hand move is ~36°. Tuned by feel.
const AZIMUTH_GAIN = Math.PI;
const ELEVATION_GAIN = Math.PI;

// Floor the wrist spread so coincident hands can't divide by ~0 in the zoom ratio.
const MIN_SPREAD = 1e-3;

// A closed hand = all four non-thumb fingers curled (thumb-agnostic). World landmarks so the
// curl test is size- and distance-invariant (§3.5).
function isClosedHand(world: Vec3[]): boolean {
    for (let i = 0; i < FINGER_TIPS.length; i++) {
        if (fingerExtended(world, FINGER_TIPS[i], FINGER_PIPS[i])) return false;
    }
    return true;
}

/**
 * Drives the CameraRig from a bilateral two-hand grab. The caller (main.ts) feeds the true
 * Left/Right poses each frame ONLY while idle, and calls reset() otherwise so opening a tool
 * or the carousel cancels any in-flight orbit. Read `active` to drive the gizmo / mini-view.
 */
export class OrbitController {
    private engaged = false;
    private closedFrames = 0;
    private openFrames = 0;

    // Latched reference captured on the engage edge (relative-drag origin).
    private theta0 = 0;
    private phi0 = 0;
    private r0 = 0;
    private mid0x = 0;
    private mid0y = 0;
    private d0 = MIN_SPREAD;

    /** True while the camera is being orbited (gizmo + mini-view visible). */
    get active(): boolean {
        return this.engaged;
    }

    /**
     * Per-frame drive. `left` / `right` are the true-handedness poses (either may be null when
     * a hand is missing); `rig` is the camera rig to read-latch and write; `dtMs` is unused for
     * now (drive is position-based, not rate-based) but kept for signature symmetry.
     */
    update(left: HandPose | null, right: HandPose | null, rig: CameraRig, _dtMs: number): void {
        // Need BOTH hands for a two-hand orbit. Losing either locks the camera and ends the mode.
        if (!left || !right) {
            this.release();
            return;
        }

        const closed_now = isClosedHand(left.world) && isClosedHand(right.world);
        const open_now =
            isOpenPalm(left.world, left.handScale) && isOpenPalm(right.world, right.handScale);
        this.closedFrames = closed_now ? this.closedFrames + 1 : 0;
        this.openFrames = open_now ? this.openFrames + 1 : 0;

        // Current two-hand image-space metrics (wrist midpoint + spread).
        const lw = left.landmarks[WRIST];
        const rw = right.landmarks[WRIST];
        const mid_x = (lw.x + rw.x) * 0.5;
        const mid_y = (lw.y + rw.y) * 0.5;
        const spread = Math.max(Math.hypot(lw.x - rw.x, lw.y - rw.y), MIN_SPREAD);

        if (!this.engaged) {
            // Engage: both hands closed for COMMIT_FRAMES. Latch the rig state + hand origin so
            // the first driven frame produces zero motion (no teleport snap).
            if (this.closedFrames >= COMMIT_FRAMES) {
                this.theta0 = rig.azimuth;
                this.phi0 = rig.polar;
                this.r0 = rig.radiusValue;
                this.mid0x = mid_x;
                this.mid0y = mid_y;
                this.d0 = spread;
                this.engaged = true;
            } else {
                return;
            }
        } else if (this.openFrames >= COMMIT_FRAMES) {
            // Release: either hand opened. The rig keeps its committed state ⇒ camera locks.
            this.engaged = false;
            return;
        }

        // Engaged: map accumulated hand offset → orbit. Azimuth follows the world like a
        // turntable grab (drag right ⇒ view comes from the right); elevation lifts as the
        // hands rise (image y is top-down, so rising hands DECREASE mid_y). Zoom is the spread
        // ratio (hands apart ⇒ smaller radius ⇒ closer).
        const theta = this.theta0 - AZIMUTH_GAIN * (mid_x - this.mid0x);
        const phi = this.phi0 + ELEVATION_GAIN * (this.mid0y - mid_y);
        const radius = this.r0 * (this.d0 / spread);
        rig.setOrbit(theta, phi, radius);
    }

    /** Cancel any in-flight orbit and clear debounce counters (camera holds its committed
     *  state). main.ts calls this every frame the app is NOT idle. */
    reset(): void {
        this.release();
    }

    private release(): void {
        this.engaged = false;
        this.closedFrames = 0;
        this.openFrames = 0;
    }
}
