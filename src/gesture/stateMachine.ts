// Pure carousel FSM + execution latch + small undo ring (SPEC §4.1, plan card
// `gesture/stateMachine.ts`). No Three.js, no DOM, no time — fully deterministic
// and unit-testable. This is the intended canonical FSM, but it is not yet
// consumed: menu/carousel.ts currently implements its own independent carousel
// state and does not drive its navigation off this logic.
//
// Left-hand carousel semantics (§4.1):
//   gun pose  → open()           closed → open
//   flick L/R → flick(dir)       slides centered index, WRAPS (6→1, 1→6)
//   pinch     → pinchSelect()    commits centered tool, returns to closed
//   fist      → dismiss()        returns to closed, no selection
import { MenuId, MENU_ORDER } from "../types";

export type CarouselState = "closed" | "open";

/** Pure FSM for the six-tool horizontal carousel. State = (open/closed, index).
 *  The centered index persists across open/close so reopening returns to the
 *  last-viewed tool. All mutators are no-ops in states where they don't apply. */
export class CarouselFSM {
    private _state: CarouselState = "closed";
    private _index = 0;

    get state(): CarouselState {
        return this._state;
    }

    /** Centered position within MENU_ORDER, 0..MENU_ORDER.length-1. */
    get index(): number {
        return this._index;
    }

    /** The tool currently centered in the strip (always valid; never null). */
    get centered(): MenuId {
        return MENU_ORDER[this._index];
    }

    /** Gun pose: materialize the carousel. Idempotent if already open. */
    open(): void {
        this._state = "open";
    }

    /** Hide the carousel with no selection (covers programmatic close). */
    close(): void {
        this._state = "closed";
    }

    /** Flick: slide the centered tool by one slot. dir=+1 next, -1 prev.
     *  Wraps both ends (6→1 and 1→6). No-op while closed. Returns the centered
     *  tool after the move (unchanged if closed). */
    flick(dir: 1 | -1): MenuId {
        if (this._state !== "open") return this.centered;
        const n = MENU_ORDER.length;
        // +n keeps the operand non-negative before the modulo so dir=-1 wraps.
        this._index = (this._index + dir + n) % n;
        return this.centered;
    }

    /** Pinch: commit the centered tool and return to closed. Returns the
     *  selected tool, or null if the carousel was not open (nothing to select). */
    pinchSelect(): MenuId | null {
        if (this._state !== "open") return null;
        const selected = this.centered;
        this._state = "closed";
        return selected;
    }

    /** Fist: dismiss with no selection. Returns to closed; index is preserved. */
    dismiss(): void {
        this._state = "closed";
    }
}

/** Rising-edge latch for execution gestures: report `true` only on the frame a
 *  boolean condition flips false→true, suppressing the held repeats that follow.
 *  Pure (no time); the caller feeds the per-frame condition. */
export class ExecLatch {
    private _prev = false;

    /** Feed this frame's condition. Returns true exactly once per rising edge. */
    fire(active: boolean): boolean {
        const edge = active && !this._prev;
        this._prev = active;
        return edge;
    }

    /** True while the condition is currently held (post-update). */
    get held(): boolean {
        return this._prev;
    }

    /** Force the latch low so the next active frame re-triggers an edge. */
    reset(): void {
        this._prev = false;
    }
}

/** Fixed-capacity ring buffer of undo snapshots. Oldest entries are overwritten
 *  once `cap` is exceeded; `undo()` pops the most recent. Generic over the
 *  snapshot type so callers store whatever they need to restore. */
export class UndoRing<T> {
    private readonly _cap: number;
    private readonly _buf: T[] = [];

    constructor(cap = 16) {
        // At least one slot; fractional caps floor to an integer.
        this._cap = Math.max(1, Math.floor(cap));
    }

    /** Push a snapshot; drop the oldest if at capacity. */
    push(s: T): void {
        this._buf.push(s);
        if (this._buf.length > this._cap) this._buf.shift();
    }

    /** Pop and return the most recent snapshot, or undefined if empty. */
    undo(): T | undefined {
        return this._buf.pop();
    }

    /** Number of snapshots currently retained. */
    get size(): number {
        return this._buf.length;
    }
}
