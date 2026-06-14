import { describe, it, expect } from "vitest";
import { GunArbiter, type GunAction } from "../src/gesture/gunArbiter";

// CONFIRM_FRAMES in gunArbiter.ts. A lone right gun fires "carousel" only after it has been
// held this many frames with no left gun joining. Kept in sync with the source constant.
const CONFIRM_FRAMES = 6;

// Drive the arbiter for n frames with fixed gun booleans; return every emitted action.
function run(arb: GunArbiter, execGun: boolean, navGun: boolean, n: number): GunAction[] {
    const out: GunAction[] = [];
    for (let i = 0; i < n; i++) out.push(arb.step(execGun, navGun));
    return out;
}

describe("GunArbiter", () => {
    it("does nothing while idle", () => {
        const arb = new GunArbiter();
        expect(run(arb, false, false, 10).every((a) => a === null)).toBe(true);
    });

    it("a lone LEFT gun never acts (only the right hand drives the carousel)", () => {
        const arb = new GunArbiter();
        expect(run(arb, false, true, 20).every((a) => a === null)).toBe(true);
    });

    describe("lone right gun -> carousel", () => {
        it("commits to carousel exactly once after the confirmation window", () => {
            const arb = new GunArbiter();
            // Holds for CONFIRM_FRAMES with no action, then fires carousel on that frame.
            for (let i = 0; i < CONFIRM_FRAMES - 1; i++) expect(arb.step(true, false)).toBeNull();
            expect(arb.step(true, false)).toBe("carousel");
            // Held past the commit: no repeats.
            expect(run(arb, true, false, 10).every((a) => a === null)).toBe(true);
        });

        it("re-arms after the gun releases, so a fresh gun fires again", () => {
            const arb = new GunArbiter();
            run(arb, true, false, CONFIRM_FRAMES); // first carousel toggle
            run(arb, false, false, 3);             // release
            const second = run(arb, true, false, CONFIRM_FRAMES);
            expect(second.filter((a) => a === "carousel").length).toBe(1);
        });
    });

    describe("both guns -> wireframe", () => {
        it("fires wireframe immediately and once per episode", () => {
            const arb = new GunArbiter();
            const out = run(arb, true, true, 10);
            expect(out[0]).toBe("wireframe");
            expect(out.slice(1).every((a) => a === null)).toBe(true);
        });

        it("a right gun that the left joins within the window toggles wireframe, NOT carousel", () => {
            const arb = new GunArbiter();
            // Right gun alone for a couple frames (still inside the confirmation window)...
            expect(arb.step(true, false)).toBeNull();
            expect(arb.step(true, false)).toBeNull();
            // ...then the left joins: this is a both-gun, so wireframe fires and carousel is cancelled.
            expect(arb.step(true, true)).toBe("wireframe");
            // Continuing to hold both: no carousel leaks out.
            expect(run(arb, true, true, 10).every((a) => a === null)).toBe(true);
        });

        it("toggles back on a second both-gun after release (mesh <-> solid)", () => {
            const arb = new GunArbiter();
            expect(arb.step(true, true)).toBe("wireframe"); // -> wireframe
            run(arb, false, false, 3);                      // release both
            expect(arb.step(true, true)).toBe("wireframe"); // -> back to solid (same event, caller flips)
        });
    });
});
