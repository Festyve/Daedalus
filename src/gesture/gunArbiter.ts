// Bimanual finger-gun arbiter. The gun pose is bound to TWO actions:
//   exec (right) hand gun, alone  -> toggle the tool carousel (existing behavior, §4.1)
//   BOTH hands gun                -> toggle solid/shaded <-> wireframe mesh
// Because the carousel action is a subset of the wireframe action (both include a right gun),
// they would otherwise collide: doing "both guns" would also open/close the carousel.
//
// The two hands almost never commit the pose on the exact same frame, so a LONE right gun is
// not acted on immediately — it is held for CONFIRM_FRAMES, giving the left hand a window to
// join into a both-gun (which fires "wireframe" at once and cancels the pending carousel).
// If the window expires with only the right hand gunning, it commits to "carousel".
//
// Pure and frame-counted (no time, no DOM, no Three.js) — fully unit-testable. Callers feed
// the per-frame *committed* (debounced) gun booleans for each hand and act on the returned event.
export type GunAction = "carousel" | "wireframe" | null;

// Frames a lone right gun is held before it commits to "carousel". Must comfortably exceed the
// frame gap between the two hands' debounced gun commits when both are raised together, so a
// genuine both-gun is never misread as a carousel toggle. The 5-frame gesture debounce
// (detect.ts) means hands raised together commit within ~1-2 frames; 12 provides more margin.
const CONFIRM_FRAMES = 12;

export class GunArbiter {
    private execHeld = false;   // right gun committed on the previous frame (rising-edge detect)
    private bothHeld = false;   // both-gun latched — held true until at least one gun releases
    private pending = 0;        // frames left before a lone right gun fires "carousel"
    private armed = false;      // a lone-right confirmation countdown is in flight

    /** Advance one frame with this frame's committed gun booleans; returns the action to fire. */
    step(execGun: boolean, navGun: boolean): GunAction {
        // Both guns: the dominant gesture. Fire "wireframe" once per episode (rising edge of
        // both-held) and cancel any pending carousel so the shared right gun can't double-act.
        if (execGun && navGun) {
            this.armed = false;
            this.pending = 0;
            this.execHeld = true;
            if (!this.bothHeld) {
                this.bothHeld = true;
                return "wireframe";
            }
            return null;
        }
        this.bothHeld = false;

        // Right gun alone: start the confirmation countdown on its rising edge, then commit to
        // "carousel" if the left hand never joins before the window closes.
        if (execGun && !navGun) {
            if (!this.execHeld) {
                this.armed = true;
                this.pending = CONFIRM_FRAMES;
            }
            this.execHeld = true;
            if (this.armed && --this.pending <= 0) {
                this.armed = false;
                return "carousel";
            }
            return null;
        }

        // No right gun: idle. A lone LEFT gun (or no hands) does nothing.
        this.execHeld = false;
        this.armed = false;
        this.pending = 0;
        return null;
    }
}
