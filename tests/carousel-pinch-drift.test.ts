import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as THREE from "three";
import { MenuId } from "../src/types";
import { eligibleTools } from "../src/render/tokens";
import type { GestureState } from "../src/types";
import { Carousel } from "../src/menu/carousel";

function makeStubCanvasContext(): CanvasRenderingContext2D {
    const noop = () => {};
    const c: Record<string, unknown> = {
        clearRect: noop, beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop,
        stroke: noop, fill: noop, fillRect: noop, fillText: noop, save: noop, restore: noop,
        translate: noop, scale: noop, lineWidth: 0, strokeStyle: "", fillStyle: "", font: "",
        textAlign: "", textBaseline: "", shadowColor: "", shadowBlur: 0, globalAlpha: 1,
    };
    return c as unknown as CanvasRenderingContext2D;
}
let PRIOR: unknown;
beforeAll(() => {
    PRIOR = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
        createElement(tag: string) {
            if (tag === "canvas") return { width: 0, height: 0, getContext: () => makeStubCanvasContext() };
            return {};
        },
    };
});
afterAll(() => { (globalThis as Record<string, unknown>).document = PRIOR; });

function gesture(over: Partial<GestureState> = {}): GestureState {
    return { name: "none", extended: 0, pinch: 0, spread: 0, vx: 0, ...over };
}
function drive(c: Carousel, rightG: GestureState, frames: number, dtMs = 16, leftG?: GestureState): void {
    const navTip = new THREE.Vector3(10, 10, 0);
    const leftGesture = leftG || { name: "none", extended: 0, pinch: 0, spread: 0, vx: 0 };
    for (let i = 0; i < frames; i++) c.update(navTip, rightG, leftGesture, dtMs / 1000);
}
function activeOrderId(c: Carousel): string {
    const o = (c as unknown as { order: string[] }).order;
    const a = (c as unknown as { active: number }).active;
    return o[a];
}

// Regression (§4.1): left-hand pinch-select must emit the tool that was centered WHEN the
// pinch fired. The selection should not be affected by incidental right-hand motion/vx.
describe("carousel left-hand pinch-select emits the centered tool", () => {
    it("selects the navigated tool (DESTROY), ignoring incidental right-hand motion", () => {
        const c = new Carousel();
        try {
            const onSelect = vi.fn<[string], void>();
            c.onSelect = onSelect;
            // App path: open with eligible subset for 1 selected shape.
            const elig = eligibleTools(1);
            c.open(new THREE.Vector3(0, 0, 0), elig);
            drive(c, gesture(), 10); // finish open fade

            // Right-hand pinch until centered on DESTROY (settle between steps).
            const PINCH_THRESHOLD = 0.6;
            const ADVANCE_COOLDOWN_MS = 250;
            const FRAMES_FOR_COOLDOWN = Math.ceil(ADVANCE_COOLDOWN_MS / 16);
            for (let guard = 0; guard < 20 && activeOrderId(c) !== MenuId.DESTROY; guard++) {
                drive(c, gesture({ name: "pinch", pinch: PINCH_THRESHOLD + 0.1 }), 1);
                drive(c, gesture({ name: "none", pinch: 0 }), FRAMES_FOR_COOLDOWN + 2);
            }
            expect(activeOrderId(c)).toBe(MenuId.DESTROY);

            // Left-hand pinch to select. The right-hand may carry incidental motion (vx),
            // but selection must emit DESTROY, not be affected by the drift.
            const rightG = gesture({ name: "pinch", pinch: PINCH_THRESHOLD + 0.1, vx: -0.6 });
            const leftG = gesture({ name: "pinch", pinch: PINCH_THRESHOLD + 0.1 });
            drive(c, rightG, 12, 16, leftG);

            expect(onSelect).toHaveBeenCalledTimes(1);
            expect(onSelect).toHaveBeenCalledWith(MenuId.DESTROY);
        } finally {
            c.dispose();
        }
    });
});
