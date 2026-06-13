import { describe, it, expect } from "vitest";
import { CarouselFSM, UndoRing } from "../src/gesture/stateMachine";
import { MenuId, MENU_ORDER } from "../src/types";

// The six-tool carousel FSM is pure: state = (open/closed, centered index).
// MENU_ORDER has six tools; "6→1" and "1→6" below mean wrapping past either end
// of that array. Index persists across open/close so reopening returns to the
// last-viewed tool.
const LAST = MENU_ORDER.length - 1; // index of the 6th tool

describe("CarouselFSM", () => {
    it("starts closed, centered on the first tool", () => {
        const fsm = new CarouselFSM();
        expect(fsm.state).toBe("closed");
        expect(fsm.index).toBe(0);
        expect(fsm.centered).toBe(MENU_ORDER[0]);
        expect(fsm.centered).toBe(MenuId.ADD_SHAPES);
    });

    describe("open / close / dismiss transitions", () => {
        it("gun pose opens the carousel", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            expect(fsm.state).toBe("open");
        });

        it("open() is idempotent while already open", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            fsm.open();
            expect(fsm.state).toBe("open");
        });

        it("close() returns to closed without changing the centered index", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            fsm.flick(1); // move to index 1
            fsm.close();
            expect(fsm.state).toBe("closed");
            expect(fsm.index).toBe(1);
        });

        it("fist dismisses to closed and preserves the index", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            fsm.flick(1);
            fsm.flick(1); // index 2
            fsm.dismiss();
            expect(fsm.state).toBe("closed");
            expect(fsm.index).toBe(2);
        });

        it("reopening returns to the last-viewed tool", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            fsm.flick(1);
            fsm.flick(1); // index 2
            fsm.dismiss();
            fsm.open();
            expect(fsm.state).toBe("open");
            expect(fsm.index).toBe(2);
            expect(fsm.centered).toBe(MENU_ORDER[2]);
        });
    });

    describe("flick navigation + wrapping", () => {
        it("flick(+1) advances the centered tool by one slot", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            const next = fsm.flick(1);
            expect(fsm.index).toBe(1);
            expect(next).toBe(MENU_ORDER[1]);
            expect(fsm.centered).toBe(MENU_ORDER[1]);
        });

        it("flick(-1) moves the centered tool back by one slot", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            fsm.flick(1);
            fsm.flick(1); // index 2
            const prev = fsm.flick(-1);
            expect(fsm.index).toBe(1);
            expect(prev).toBe(MENU_ORDER[1]);
        });

        it("flick(+1) wraps from the last tool back to the first (6→1)", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            for (let i = 0; i < LAST; i++) fsm.flick(1); // walk to the 6th tool
            expect(fsm.index).toBe(LAST);
            expect(fsm.centered).toBe(MENU_ORDER[LAST]);
            const wrapped = fsm.flick(1);
            expect(fsm.index).toBe(0);
            expect(wrapped).toBe(MENU_ORDER[0]);
            expect(fsm.centered).toBe(MenuId.ADD_SHAPES);
        });

        it("flick(-1) wraps from the first tool to the last (1→6)", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            expect(fsm.index).toBe(0);
            const wrapped = fsm.flick(-1);
            expect(fsm.index).toBe(LAST);
            expect(wrapped).toBe(MENU_ORDER[LAST]);
            expect(fsm.centered).toBe(MENU_ORDER[LAST]);
        });

        it("a full forward lap returns to the starting tool", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            for (let i = 0; i < MENU_ORDER.length; i++) fsm.flick(1);
            expect(fsm.index).toBe(0);
            expect(fsm.centered).toBe(MENU_ORDER[0]);
        });

        it("flick is a no-op while closed and returns the unchanged centered tool", () => {
            const fsm = new CarouselFSM();
            const result = fsm.flick(1);
            expect(fsm.state).toBe("closed");
            expect(fsm.index).toBe(0);
            expect(result).toBe(MENU_ORDER[0]);
        });
    });

    describe("pinchSelect", () => {
        it("returns the centered tool and closes the carousel", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            fsm.flick(1);
            fsm.flick(1); // index 2
            const selected = fsm.pinchSelect();
            expect(selected).toBe(MENU_ORDER[2]);
            expect(fsm.state).toBe("closed");
        });

        it("selecting the first tool returns ADD_SHAPES", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            expect(fsm.pinchSelect()).toBe(MenuId.ADD_SHAPES);
        });

        it("selecting after wrapping returns the wrapped tool", () => {
            const fsm = new CarouselFSM();
            fsm.open();
            fsm.flick(-1); // wrap to the last tool
            const selected = fsm.pinchSelect();
            expect(selected).toBe(MENU_ORDER[LAST]);
            expect(fsm.state).toBe("closed");
        });

        it("returns null when the carousel is not open", () => {
            const fsm = new CarouselFSM();
            expect(fsm.pinchSelect()).toBeNull();
            expect(fsm.state).toBe("closed");
        });
    });
});

describe("UndoRing", () => {
    it("push then undo returns the most recent snapshot (LIFO)", () => {
        const ring = new UndoRing<number>(4);
        ring.push(1);
        ring.push(2);
        ring.push(3);
        expect(ring.size).toBe(3);
        expect(ring.undo()).toBe(3);
        expect(ring.undo()).toBe(2);
        expect(ring.size).toBe(1);
    });

    it("undo on an empty ring returns undefined", () => {
        const ring = new UndoRing<string>();
        expect(ring.undo()).toBeUndefined();
        expect(ring.size).toBe(0);
    });

    it("respects capacity by overwriting the oldest snapshot", () => {
        const ring = new UndoRing<number>(3);
        ring.push(1);
        ring.push(2);
        ring.push(3);
        ring.push(4); // evicts 1
        expect(ring.size).toBe(3);
        expect(ring.undo()).toBe(4);
        expect(ring.undo()).toBe(3);
        expect(ring.undo()).toBe(2);
        expect(ring.undo()).toBeUndefined(); // 1 was dropped
    });

    it("never exceeds capacity no matter how many are pushed", () => {
        const CAP = 8;
        const ring = new UndoRing<number>(CAP);
        for (let i = 0; i < 100; i++) ring.push(i);
        expect(ring.size).toBe(CAP);
        // The retained window is the last CAP pushes, newest first.
        for (let i = 0; i < CAP; i++) expect(ring.undo()).toBe(99 - i);
        expect(ring.size).toBe(0);
    });

    it("clamps a non-positive or fractional capacity to at least one slot", () => {
        const ring = new UndoRing<number>(0);
        ring.push(10);
        ring.push(20); // evicts 10
        expect(ring.size).toBe(1);
        expect(ring.undo()).toBe(20);
        expect(ring.undo()).toBeUndefined();
    });

    it("defaults to a 16-slot capacity", () => {
        const ring = new UndoRing<number>();
        for (let i = 0; i < 20; i++) ring.push(i);
        expect(ring.size).toBe(16);
    });
});
