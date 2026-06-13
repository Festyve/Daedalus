// Carousel navigation + selection — logic level (SPEC §10.1, §4.1). The vitest env is
// `node` (vite.config.ts test.environment), so there is no DOM and no WebGL: the real
// `Carousel` constructor calls `document.createElement("canvas")` and bakes CanvasTextures.
// We install a tiny headless canvas stub (no GPU needed — MeshBasicMaterial/CanvasTexture/
// Group all build CPU-side) so the genuine `Carousel` can be exercised end-to-end, AND we
// drive the pure `CarouselFSM` directly. Both share the same wrap-around contract.
//
// Coverage:
//   - CarouselFSM: flick wraps (6→1, 1→6), pinch commits centered MenuId, fist/close drop
//     selection, mutators are no-ops while closed.
//   - Carousel (headless): open()/close() toggle isOpen; a committed flick steps the active
//     index with wrap; a pinch fires onSelect(centered MenuId) once the close fade completes.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as THREE from "three";
import { CarouselFSM } from "../src/gesture/stateMachine";
import { MenuId, MENU_ORDER } from "../src/types";
import type { GestureState } from "../src/types";
import { Carousel } from "../src/menu/carousel";

// ---- Swipe driving for the headless carousel. The carousel now uses the shared
//      SwipeDetector (gesture/swipe.ts), which integrates g.vx over a window: a single fast
//      frame (SWIPE_VX) commits one step, a hard cooldown blocks the sweep's tail, and the
//      accumulator must SETTLE (vx ≈ 0 for a stretch) before the next step arms. So the
//      re-arm phase is driven with vx = 0, not a sustained sub-threshold velocity. ----
const SWIPE_VX = 0.6;        // one frame at this vx commits a step (net ≥ detector distance)
const SETTLE_FRAMES = 30;    // vx=0 frames to decay the accumulator + clear the cooldown

// ---- Headless DOM canvas stub so the real Carousel constructor + label bake run in node.
//      Every 2D-context method the carousel touches is a no-op; setters swallow writes. ----
function makeStubCanvasContext(): CanvasRenderingContext2D {
    const noop = () => {};
    const ctx: Record<string, unknown> = {
        clearRect: noop,
        beginPath: noop,
        moveTo: noop,
        arcTo: noop,
        closePath: noop,
        stroke: noop,
        fill: noop,
        fillRect: noop,
        fillText: noop,
        save: noop,
        restore: noop,
        translate: noop,
        scale: noop,
        lineWidth: 0,
        strokeStyle: "",
        fillStyle: "",
        font: "",
        textAlign: "",
        textBaseline: "",
        shadowColor: "",
        shadowBlur: 0,
    };
    return ctx as unknown as CanvasRenderingContext2D;
}

let PRIOR_DOCUMENT: unknown;

beforeAll(() => {
    PRIOR_DOCUMENT = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
        createElement(tag: string) {
            if (tag === "canvas") {
                return {
                    width: 0,
                    height: 0,
                    getContext: () => makeStubCanvasContext(),
                };
            }
            return {};
        },
    };
});

afterAll(() => {
    (globalThis as Record<string, unknown>).document = PRIOR_DOCUMENT;
});

// Build a GestureState for a frame; defaults are a neutral "none" pose.
function gesture(over: Partial<GestureState> = {}): GestureState {
    return {
        name: "none",
        extended: 0,
        pinch: 0,
        spread: 0,
        vx: 0,
        ...over,
    };
}

// Advance the carousel by `frames` steps of `dtMs` each with a held gesture. navTip is kept
// far from the strip so the proximity glow stays near zero and never perturbs index logic.
function drive(c: Carousel, g: GestureState, frames: number, dtMs = 16): void {
    const navTip = new THREE.Vector3(10, 10, 0);
    const dt = dtMs / 1000;
    for (let i = 0; i < frames; i++) {
        c.update(navTip, g, dt);
    }
}

// Read the centered tool off a (headless) Carousel via its private `active` index. The index
// is the single source of truth for what a pinch will select; reaching for it keeps the test
// honest without needing a WebGL readback.
function centeredId(c: Carousel): MenuId {
    const active = (c as unknown as { active: number }).active;
    return MENU_ORDER[active];
}

describe("CarouselFSM — pure navigation + selection logic", () => {
    it("starts closed, centered on the first tool", () => {
        const fsm = new CarouselFSM();
        expect(fsm.state).toBe("closed");
        expect(fsm.index).toBe(0);
        expect(fsm.centered).toBe(MENU_ORDER[0]);
    });

    it("open() materializes; close() hides without selecting", () => {
        const fsm = new CarouselFSM();
        fsm.open();
        expect(fsm.state).toBe("open");
        fsm.close();
        expect(fsm.state).toBe("closed");
    });

    it("flick(+1) steps the centered index forward through MENU_ORDER", () => {
        const fsm = new CarouselFSM();
        fsm.open();
        expect(fsm.flick(1)).toBe(MENU_ORDER[1]);
        expect(fsm.flick(1)).toBe(MENU_ORDER[2]);
        expect(fsm.index).toBe(2);
    });

    it("flick wraps forward at the end (last → first, i.e. 6→1)", () => {
        const fsm = new CarouselFSM();
        fsm.open();
        for (let i = 0; i < MENU_ORDER.length - 1; i++) fsm.flick(1);
        expect(fsm.index).toBe(MENU_ORDER.length - 1);
        expect(fsm.centered).toBe(MENU_ORDER[MENU_ORDER.length - 1]);
        // One more forward flick wraps to the first tool.
        expect(fsm.flick(1)).toBe(MENU_ORDER[0]);
        expect(fsm.index).toBe(0);
    });

    it("flick wraps backward at the start (first → last, i.e. 1→6)", () => {
        const fsm = new CarouselFSM();
        fsm.open();
        expect(fsm.index).toBe(0);
        expect(fsm.flick(-1)).toBe(MENU_ORDER[MENU_ORDER.length - 1]);
        expect(fsm.index).toBe(MENU_ORDER.length - 1);
    });

    it("pinchSelect() commits the centered tool and returns to closed", () => {
        const fsm = new CarouselFSM();
        fsm.open();
        fsm.flick(1);
        fsm.flick(1);
        const target = fsm.centered;
        expect(target).toBe(MENU_ORDER[2]);
        const selected = fsm.pinchSelect();
        expect(selected).toBe(target);
        expect(fsm.state).toBe("closed");
    });

    it("mutators are no-ops while closed: flick & pinch never change state/index", () => {
        const fsm = new CarouselFSM();
        // Closed from the start.
        expect(fsm.flick(1)).toBe(MENU_ORDER[0]);
        expect(fsm.index).toBe(0);
        expect(fsm.pinchSelect()).toBeNull();
        expect(fsm.state).toBe("closed");
    });

    it("dismiss() (fist) closes with no selection and preserves the index", () => {
        const fsm = new CarouselFSM();
        fsm.open();
        fsm.flick(1);
        const beforeIndex = fsm.index;
        fsm.dismiss();
        expect(fsm.state).toBe("closed");
        expect(fsm.index).toBe(beforeIndex);
        // Reopening returns to the last-viewed tool.
        fsm.open();
        expect(fsm.index).toBe(beforeIndex);
    });
});

describe("Carousel (headless) — open/close toggle + flick + pinch→onSelect", () => {
    it("constructs closed and toggles isOpen via open()/close()", () => {
        const c = new Carousel();
        try {
            expect(c.isOpen).toBe(false);
            c.open(new THREE.Vector3(0, 0, 0));
            expect(c.isOpen).toBe(true);
            // Re-opening is idempotent (does not throw, stays open).
            c.open(new THREE.Vector3(0, 0, 0));
            expect(c.isOpen).toBe(true);
            c.close();
            expect(c.isOpen).toBe(false);
        } finally {
            c.dispose();
        }
    });

    it("a committed flick steps the centered tool by one (one swipe, one step)", () => {
        const c = new Carousel();
        try {
            c.open(new THREE.Vector3(0, 0, 0));
            // Let the 120ms open fade finish so update() runs gesture handling.
            drive(c, gesture(), 10);
            expect(centeredId(c)).toBe(MENU_ORDER[0]);

            // One fast LEFTWARD swipe (vx<0, finger moves screen-left) commits one forward step…
            drive(c, gesture({ name: "point", vx: -SWIPE_VX }), 1);
            expect(centeredId(c)).toBe(MENU_ORDER[1]);

            // …and holding the same fast velocity does NOT keep stepping (cooldown blocks the tail).
            drive(c, gesture({ name: "point", vx: -SWIPE_VX }), 5);
            expect(centeredId(c)).toBe(MENU_ORDER[1]);

            // Let the hand SETTLE (vx≈0) so the accumulator decays + the cooldown clears, then
            // swipe again → a second step lands.
            drive(c, gesture({ name: "point", vx: 0 }), SETTLE_FRAMES);
            drive(c, gesture({ name: "point", vx: -SWIPE_VX }), 1);
            expect(centeredId(c)).toBe(MENU_ORDER[2]);
        } finally {
            c.dispose();
        }
    });

    it("a rightward flick from the first tool wraps to the last (1→6)", () => {
        const c = new Carousel();
        try {
            c.open(new THREE.Vector3(0, 0, 0));
            drive(c, gesture(), 10);
            expect(centeredId(c)).toBe(MENU_ORDER[0]);
            drive(c, gesture({ name: "point", vx: SWIPE_VX }), 1);
            expect(centeredId(c)).toBe(MENU_ORDER[MENU_ORDER.length - 1]);
        } finally {
            c.dispose();
        }
    });

    it("pinch fires onSelect exactly once with the centered MenuId, then closes", () => {
        const c = new Carousel();
        try {
            const onSelect = vi.fn<[string], void>();
            c.onSelect = onSelect;
            c.open(new THREE.Vector3(0, 0, 0));
            drive(c, gesture(), 10); // finish open fade

            // Swipe (leftward = forward) to the third tool so the selection target is non-trivial.
            drive(c, gesture({ name: "point", vx: -SWIPE_VX }), 1);
            // Settle (vx=0) so the accumulator decays + the cooldown clears, then swipe again.
            drive(c, gesture({ name: "point", vx: 0 }), SETTLE_FRAMES);
            drive(c, gesture({ name: "point", vx: -SWIPE_VX }), 1);
            const target = centeredId(c);
            expect(target).toBe(MENU_ORDER[2]);

            // Pinch (rising edge) latches the select + starts the close fade; onSelect fires
            // only when the 80ms close fade fully completes. Drive enough frames to finish it.
            drive(c, gesture({ name: "pinch", pinch: 1 }), 12);

            expect(onSelect).toHaveBeenCalledTimes(1);
            expect(onSelect).toHaveBeenCalledWith(target);
            expect(c.isOpen).toBe(false);
        } finally {
            c.dispose();
        }
    });

    it("fist dismisses with no selection (onSelect never fires)", () => {
        const c = new Carousel();
        try {
            const onSelect = vi.fn<[string], void>();
            c.onSelect = onSelect;
            c.open(new THREE.Vector3(0, 0, 0));
            drive(c, gesture(), 10);
            // Fist closes; drive past the full close fade.
            drive(c, gesture({ name: "fist" }), 12);
            expect(onSelect).not.toHaveBeenCalled();
            expect(c.isOpen).toBe(false);
        } finally {
            c.dispose();
        }
    });
});
