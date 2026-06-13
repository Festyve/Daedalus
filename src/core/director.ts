// §13 — the Director: freeplay/safety flow controller.
// Tracks the demo arc stage and advances it forward-only from observable milestones.
// Stages: EMPTY → SPHERE → TORUS → DECORATED (monotonic; never moves backward).
//   - freeplay (default): real sculptor; milestones drive progression.
//   - safety: tracking failed on stage; the operator steps through authored
//     snapshots (§13.2) by keypress via advanceSafety().
import type { DirectorMode, Stage } from "../types";

// Forward-only stage order. The world begins EMPTY; ADD SHAPES yields the first
// mesh (SPHERE), MORPH yields TORUS, DECORATE yields DECORATED.
const STAGE_ORDER: Stage[] = ["EMPTY", "SPHERE", "TORUS", "DECORATED"];

// morphT past this counts the sphere as fully morphed to a torus (mirrors menu/morph.ts).
const MORPH_DONE = 0.95;

// Authored safety snapshots (§13.2), one per stage, in forward order. In safety
// mode each keypress loads the next snapshot, stepping the arc deterministically.
export const SAFETY_SNAPSHOTS: Record<Stage, string> = {
    EMPTY: "snapshot_empty.json",
    SPHERE: "snapshot_sphere.json",
    TORUS: "snapshot_torus.json",
    DECORATED: "snapshot_decorated.json",
};

export class Director {
    private current_mode: DirectorMode;
    private current_stage: Stage = "EMPTY";

    constructor(mode: DirectorMode) {
        this.current_mode = mode;
    }

    /** Current arc stage. Read-only to callers; only milestones/safety mutate it. */
    get stage(): Stage {
        return this.current_stage;
    }

    /** Active director mode (freeplay or safety). */
    get mode(): DirectorMode {
        return this.current_mode;
    }

    private stageIndex(s: Stage): number {
        return STAGE_ORDER.indexOf(s);
    }

    // Move to `next` only when it is strictly ahead of the current stage, so no
    // milestone (or out-of-order event) can ever rewind the arc.
    private advanceTo(next: Stage): boolean {
        if (this.stageIndex(next) > this.stageIndex(this.current_stage)) {
            this.current_stage = next;
            return true;
        }
        return false;
    }

    /** Switch modes at runtime (e.g. fall back to safety when tracking is lost). */
    setMode(mode: DirectorMode): void {
        this.current_mode = mode;
    }

    /** ADD SHAPES spawned the first mesh: EMPTY → SPHERE. */
    onShapeAdded(): void {
        this.advanceTo("SPHERE");
    }

    /** MORPH progress: SPHERE → TORUS once the torus blend completes (t > 0.95). */
    onMorph(t: number): void {
        if (t > MORPH_DONE) this.advanceTo("TORUS");
    }

    /** DECORATE applied icing/sprinkles: → DECORATED. */
    onDecorated(): void {
        this.advanceTo("DECORATED");
    }

    /** Authored snapshot file for the current stage (§13.2). */
    get snapshot(): string {
        return SAFETY_SNAPSHOTS[this.current_stage];
    }

    /** safety mode: step forward one authored snapshot on a keypress. Forces
     *  safety mode (this is the recovery path) and stops at the final stage. */
    advanceSafety(): void {
        this.current_mode = "safety";
        const i = this.stageIndex(this.current_stage);
        if (i < STAGE_ORDER.length - 1) {
            this.current_stage = STAGE_ORDER[i + 1];
        }
    }

    /** Restart the arc at EMPTY (e.g. world cleared). */
    reset(): void {
        this.current_stage = "EMPTY";
    }
}
