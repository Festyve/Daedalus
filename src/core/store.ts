// §2 (threading) / §3.1 — latest-value pose store. The decoupling primitive between
// inference and render: MediaPipe (pumped from rAF) writes the most recent filtered
// PoseFrame; the render loop reads it without ever awaiting inference inline.
//
// Single slot, last-write-wins, no locks (§2 Threading model). The store holds only
// the most recent frame — older frames are dropped, never queued — so a slow render
// or inference tick can never build backpressure. get() performs zero allocation: it
// returns the stored reference (or null) directly, making it safe to call every frame
// in the hot loop (§11). World starts empty, so callers must treat null as "no pose yet".
import type { PoseFrame } from "../types";

export class PoseStore {
    private latest: PoseFrame | null = null;

    /** Inference writes the newest filtered pose, overwriting any prior unread frame. */
    set(frame: PoseFrame): void {
        this.latest = frame;
    }

    /** Render reads the most recent pose, or null before the first frame arrives. */
    get(): PoseFrame | null {
        return this.latest;
    }
}
