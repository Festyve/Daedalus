// §14 — the Director: tracks the demo arc stage and the active interaction mode.
// Stage milestones advance automatically (guided/assist/freeplay); in `safety`
// mode the operator advances stages by keypress using authored snapshots.
import type { DirectorMode, Stage } from "../types";

const STAGE_ORDER: Stage[] = ["SPHERE", "DONUT", "DECORATED", "CONSUMED"];
const MORPH_DONE = 0.95; // morphT past this → the sphere has become a donut

export class Director {
    mode: DirectorMode;
    stage: Stage = "SPHERE";

    constructor(mode: DirectorMode = "guided") {
        this.mode = mode;
    }

    private stageIndex(s: Stage): number {
        return STAGE_ORDER.indexOf(s);
    }

    // Advance to `next` only if it is strictly ahead of the current stage, so a
    // milestone can never move the arc backwards.
    private advanceTo(next: Stage): boolean {
        if (this.stageIndex(next) > this.stageIndex(this.stage)) {
            this.stage = next;
            return true;
        }
        return false;
    }

    // SPHERE → DONUT once the morph completes. No-op in `safety` (operator-driven).
    onMorph(morphT: number): boolean {
        if (this.mode === "safety") return false;
        if (this.stage === "SPHERE" && morphT > MORPH_DONE) return this.advanceTo("DONUT");
        return false;
    }

    // → DECORATED when the decorate chat panel opens.
    onChatOpened(): boolean {
        if (this.mode === "safety") return false;
        return this.advanceTo("DECORATED");
    }

    // → CONSUMED when the dissolve finale finishes.
    onDissolveDone(): boolean {
        if (this.mode === "safety") return false;
        return this.advanceTo("CONSUMED");
    }

    // `safety` mode: step to the next authored stage on a keypress.
    advanceManual(): boolean {
        const i = this.stageIndex(this.stage);
        if (i < STAGE_ORDER.length - 1) {
            this.stage = STAGE_ORDER[i + 1];
            return true;
        }
        return false;
    }

    setMode(mode: DirectorMode): void {
        this.mode = mode;
    }

    reset(): void {
        this.stage = "SPHERE";
    }
}
