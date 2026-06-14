// SELECT tool behavior on a minimal headless SceneContext.
//
// Paradigm under test (the fist-based controls): a LEFT-hand FIST steps the focus cursor to the
// next shape, and a RIGHT-hand FIST toggles the focused shape in/out of the selection. Each gesture
// is debounced (5 frames) and fires on the rising edge, so one fist-close = one cursor step / one
// toggle — holding the fist must not repeat, and you re-open then re-close to fire again.
//
// Pure-logic test: vitest runs in the `node` environment, so the renderer is never invoked and the
// DOM the tool's Panel touches is provided by the tiny stub below. We drive createSelectMenu()
// .update() frame-by-frame and assert on ctx.focusIndex / ctx.selected.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as THREE from "three";
import { createSelectMenu } from "../src/menu/select";
import { selectedCount, isSelected } from "../src/core/shapes";
import { isFist, isOpenPalm } from "../src/gesture/predicates";
import type { HandPose, Handedness, SceneContext, ScratchMath, Vec3 } from "../src/types";

// gesture/detect.GestureDebouncer commits a discrete pose after this many identical frames.
const DEBOUNCE_FRAMES = 5;

// MediaPipe Hands landmark indices the fixtures set.
const WRIST = 0;
const MIDDLE_MCP = 9;

// ---------- Minimal headless DOM (the tool's Panel builds real nodes in enter()) ----------
interface FakeEl {
    className: string;
    textContent: string;
    innerHTML: string;
    readonly offsetWidth: number;
    style: Record<string, string>;
    appendChild(child: FakeEl): FakeEl;
    remove(): void;
}

function makeFakeEl(): FakeEl {
    return {
        className: "",
        textContent: "",
        innerHTML: "",
        offsetWidth: 0,
        style: {},
        appendChild(child: FakeEl): FakeEl { return child; },
        remove(): void { /* detached */ },
    };
}

let saved_document: unknown;
let saved_window: unknown;

beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    saved_document = g.document;
    saved_window = g.window;
    g.document = {
        createElement: (_tag: string): FakeEl => makeFakeEl(),
        body: makeFakeEl(),
    };
    g.window = {
        setTimeout: (fn: () => void, _ms?: number): number => { void fn; return 0; },
        clearTimeout: (_id: number): void => { /* no-op */ },
    };
});

afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    g.document = saved_document;
    g.window = saved_window;
});

// ---------- Landmark fixtures ----------
// 21 zeroed Vec3 landmarks; callers overwrite the indices the predicates inspect.
function blankHand(): Vec3[] {
    return Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
}

// Fist: all four fingers curled (tip nearer the wrist than its PIP) and the thumb–index gap
// > 0.6·S → isFist true. Wrist at origin and middle-MCP at (0,1,0) fix the hand scale S = 1.
function fistHand(): Vec3[] {
    const a = blankHand();
    a[WRIST] = { x: 0, y: 0, z: 0 };
    a[MIDDLE_MCP] = { x: 0, y: 1, z: 0 };       // S = 1
    a[3] = { x: -0.3, y: 0.4, z: 0 };           // thumb IP
    a[4] = { x: -0.8, y: 0.6, z: 0 };           // thumb tip splayed → ‖tip4 − tip8‖ large
    const pips = [6, 10, 14, 18];
    const tips = [8, 12, 16, 20];
    for (let k = 0; k < 4; k++) {
        a[pips[k]] = { x: (k - 1.5) * 0.1, y: 0.9, z: 0 };   // PIPs out near the knuckles
        a[tips[k]] = { x: (k - 1.5) * 0.1, y: 0.3, z: 0 };   // tips curled in toward the palm
    }
    return a;
}

// Open palm: all five fingers extended and well spread → isOpenPalm true, isFist false. Used as
// the "release" pose between fist-closes so the rising-edge latch re-arms.
function openHand(): Vec3[] {
    const a = blankHand();
    a[WRIST] = { x: 0, y: 0, z: 0 };
    a[MIDDLE_MCP] = { x: 0, y: 1, z: 0 };       // S = 1
    a[3] = { x: -1.0, y: 0.4, z: 0 };           // thumb IP
    a[4] = { x: -1.6, y: 0.7, z: 0 };           // thumb tip (extended, off to the side)
    const pips = [6, 10, 14, 18];
    const tips = [8, 12, 16, 20];
    const fan = [1.1, 0.6, 0.1, -0.4];          // radians: fingers fanned out → spread
    for (let k = 0; k < 4; k++) {
        a[pips[k]] = { x: Math.sin(fan[k]) * 1.0, y: Math.cos(fan[k]) * 1.0, z: 0 };
        a[tips[k]] = { x: Math.sin(fan[k]) * 2.0, y: Math.cos(fan[k]) * 2.0, z: 0 };
    }
    return a;
}

// Build a HandPose. classify() reads the discrete pose from `landmarks` (image space) and the hand
// scale from `world`; this test makes both the same fixture so the geometry is self-consistent.
function makePose(handedness: Handedness, fixture: Vec3[]): HandPose {
    return {
        handedness,
        landmarks: fixture,
        world: fixture,
        confidence: 1,
        handScale: 1,
        timestamp: 0,
    };
}

function fistPose(handedness: Handedness): HandPose { return makePose(handedness, fistHand()); }
function openPose(handedness: Handedness): HandPose { return makePose(handedness, openHand()); }

// ---------- Headless SceneContext ----------
function makeScratch(): ScratchMath {
    return {
        v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(),
        m1: new THREE.Matrix4(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion(),
        plane: new THREE.Plane(), ray: new THREE.Ray(),
    };
}

function makeMesh(): THREE.Mesh {
    return new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), new THREE.MeshBasicMaterial());
}

// `shapes` shapes in the scene, none selected (mesh null, all in extraMeshes), cursor at 0.
function makeCtx(shapes: number): { ctx: SceneContext; meshes: THREE.Mesh[] } {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const meshes = Array.from({ length: shapes }, makeMesh);
    const ctx: SceneContext = {
        scene: new THREE.Scene(), camera, renderer: null as any,
        mesh: null, bvh: null, extraMeshes: [...meshes], selected: [], focusIndex: 0,
        morphT: 0, stage: "EMPTY", viewMode: "scene", wireframe: false, activeMenu: null,
        scratch: makeScratch(), interactionPlaneZ: 0,
    };
    return { ctx, meshes };
}

// Drive the tool for `frames` frames at a fixed 16ms dt.
function drive(
    tool: ReturnType<typeof createSelectMenu>,
    ctx: SceneContext,
    exec: HandPose | null,
    nav: HandPose | null,
    frames: number,
): void {
    for (let f = 0; f < frames; f++) tool.update(ctx, exec, nav, 16);
}

// One deliberate fist "click" on a single hand: open to re-arm the rising-edge latch, then close
// to fire exactly once. `role` picks which hand drives (exec = right, nav = left).
function clickFist(
    tool: ReturnType<typeof createSelectMenu>,
    ctx: SceneContext,
    role: "exec" | "nav",
    handedness: Handedness,
): void {
    const open = openPose(handedness);
    const fist = fistPose(handedness);
    if (role === "exec") {
        drive(tool, ctx, open, null, DEBOUNCE_FRAMES + 1);
        drive(tool, ctx, fist, null, DEBOUNCE_FRAMES + 1);
    } else {
        drive(tool, ctx, null, open, DEBOUNCE_FRAMES + 1);
        drive(tool, ctx, null, fist, DEBOUNCE_FRAMES + 1);
    }
}

// ---------- Fixture sanity ----------
describe("select fixtures", () => {
    it("fist fixture is a fist and not an open palm", () => {
        expect(isFist(fistHand(), 1)).toBe(true);
        expect(isOpenPalm(fistHand(), 1)).toBe(false);
    });
    it("open fixture is an open palm and not a fist", () => {
        expect(isOpenPalm(openHand(), 1)).toBe(true);
        expect(isFist(openHand(), 1)).toBe(false);
    });
});

// ---------- Right-hand fist cycles the focus cursor (same hand as the main-menu swipe) ----------
describe("SELECT right fist → cycle focus", () => {
    it("steps the cursor once per fist-close, holding does not repeat, and it wraps", () => {
        const tool = createSelectMenu();
        const { ctx } = makeCtx(3);
        tool.enter(ctx);
        expect(ctx.focusIndex).toBe(0);

        // Open hand re-arms the latch but moves nothing.
        drive(tool, ctx, openPose("Right"), null, DEBOUNCE_FRAMES + 1);
        expect(ctx.focusIndex).toBe(0);

        // One deliberate fist-close → exactly one step.
        clickFist(tool, ctx, "exec", "Right");
        expect(ctx.focusIndex).toBe(1);

        // Holding the fist must NOT keep stepping.
        drive(tool, ctx, fistPose("Right"), null, 20);
        expect(ctx.focusIndex).toBe(1);

        // Re-open then re-close → a second step.
        clickFist(tool, ctx, "exec", "Right");
        expect(ctx.focusIndex).toBe(2);

        // Third close wraps 2 → 0 over the 3-shape set.
        clickFist(tool, ctx, "exec", "Right");
        expect(ctx.focusIndex).toBe(0);

        tool.exit(ctx);
    });
});

// ---------- Left-hand fist toggles the focused shape (same hand as the main-menu select) ----------
describe("SELECT left fist → toggle + multi-select", () => {
    it("toggles the focused shape in, does not double-toggle when held, and builds a set", () => {
        const tool = createSelectMenu();
        const { ctx, meshes } = makeCtx(3);
        tool.enter(ctx);

        expect(selectedCount(ctx)).toBe(0);

        // Left fist toggles the focused shape (meshes[0]) into the selection.
        clickFist(tool, ctx, "nav", "Left");
        expect(selectedCount(ctx)).toBe(1);
        expect(isSelected(ctx, meshes[0])).toBe(true);

        // Holding the left fist must NOT toggle it back out.
        drive(tool, ctx, null, fistPose("Left"), 20);
        expect(selectedCount(ctx)).toBe(1);

        // Right fist advances the cursor to the next shape (meshes[1]).
        clickFist(tool, ctx, "exec", "Right");
        expect(ctx.focusIndex).toBe(1);

        // Left fist again → add meshes[1] too: a two-shape selection.
        clickFist(tool, ctx, "nav", "Left");
        expect(selectedCount(ctx)).toBe(2);
        expect(isSelected(ctx, meshes[1])).toBe(true);

        // A fresh left fist on an already-selected shape removes it (toggle off).
        clickFist(tool, ctx, "nav", "Left");
        expect(selectedCount(ctx)).toBe(1);
        expect(isSelected(ctx, meshes[1])).toBe(false);

        tool.exit(ctx);
    });
});

// ---------- Guards ----------
describe("SELECT guards", () => {
    it("does nothing with no hands", () => {
        const tool = createSelectMenu();
        const { ctx } = makeCtx(3);
        tool.enter(ctx);
        drive(tool, ctx, null, null, 30);
        expect(ctx.focusIndex).toBe(0);
        expect(selectedCount(ctx)).toBe(0);
        tool.exit(ctx);
    });

    it("is a no-op on an empty world (no shapes) — fists neither throw nor select", () => {
        const tool = createSelectMenu();
        const { ctx } = makeCtx(0);
        tool.enter(ctx);
        expect(() => {
            drive(tool, ctx, fistPose("Right"), fistPose("Left"), 30);
        }).not.toThrow();
        expect(selectedCount(ctx)).toBe(0);
        expect(ctx.focusIndex).toBe(0);
        tool.exit(ctx);
    });
});
