// §3.1 / §12.2 — single-slot pose store. Inference writes the latest PoseFrame;
// the render loop reads the latest and never blocks waiting on inference.
import type { PoseFrame } from "../types";

export class PoseStore {
    private latest: PoseFrame | null = null;

    set(frame: PoseFrame): void {
        this.latest = frame;
    }

    get(): PoseFrame | null {
        return this.latest;
    }
}
