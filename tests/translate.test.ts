// §5.2 / §10.1 — TRANSLATE behavior on a minimal headless SceneContext.
//
// Paradigm under test (§5.2): an OPEN PALM grabs the active mesh and it tracks the
// right hand's unprojected world position; closing to a FIST latches the mesh in
// place. With an empty world (ctx.mesh === null, §5.1) the tool is a strict no-op.
//
// This is a pure-logic test: vitest runs in the `node` environment (vite.config.ts),
// so the renderer is never invoked (update() must not touch ctx.renderer) and the DOM
// used by the tool's plain-DOM Panel (§4.2) is provided by a tiny stub below. We drive
// createTranslateMenu().update() frame-by-frame and assert on mesh.position.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as THREE from "three";
import { createTranslateMenu } from "../src/menu/translate";
import type { HandPose, SceneContext, ScratchMath, Vec3 } from "../src/types";
import { isOpenPalm, isFist } from "../src/gesture/predicates";

// MediaPipe Hands landmark indices the tool / predicates read.
const WRIST = 0;
const MIDDLE_MCP = 9;       // palm anchor (§5.2): mesh tracks this landmark
const PALM_ANCHOR = MIDDLE_MCP;

// The tool commits a discrete grab/lock only after COMMIT_FRAMES identical frames
// (§12 debounce). Mirrors the private constant inside translate.ts.
const COMMIT_FRAMES = 5;

// ---------- Minimal headless DOM ----------
// The tool's Panel (src/menu/panel.ts) builds real DOM nodes in enter(). The `node`
// test environment has no `document`/`window`, so we install the smallest stub the
// Panel touches: createElement, body.appendChild, element style/innerHTML/remove,
// offsetWidth (forced reflow in show()), and window timers.
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
    const a: Vec3[] = [];
    for (let i = 0; i < 21; i++) a.push({ x: 0, y: 0, z: 0 });
    return a;
}

// Open palm (world space): all four non-thumb fingers + thumb extended (tip farther
// from the wrist than its PIP) and well spread → isOpenPalm true, isFist false.
// Wrist at the origin and middle-MCP at (0,1,0) fix the hand scale S = 1.
function openPalmWorld(): Vec3[] {
    const a = blankHand();
    a[WRIST] = { x: 0, y: 0, z: 0 };
    a[MIDDLE_MCP] = { x: 0, y: 1, z: 0 };       // S = ||wrist - MCP9|| = 1
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

// Fist (world space): all four fingers curled (tip nearer the wrist than its PIP) and
// the thumb–index gap > 0.6·S → isFist true, isOpenPalm false.
function fistWorld(): Vec3[] {
    const a = blankHand();
    a[WRIST] = { x: 0, y: 0, z: 0 };
    a[MIDDLE_MCP] = { x: 0, y: 1, z: 0 };       // S = 1
    a[3] = { x: -0.3, y: 0.4, z: 0 };           // thumb IP
    a[4] = { x: -0.8, y: 0.6, z: 0 };           // thumb tip splayed → ||tip4 - tip8|| large
    const pips = [6, 10, 14, 18];
    const tips = [8, 12, 16, 20];
    for (let k = 0; k < 4; k++) {
        a[pips[k]] = { x: (k - 1.5) * 0.1, y: 0.9, z: 0 };   // PIPs out near the knuckles
        a[tips[k]] = { x: (k - 1.5) * 0.1, y: 0.3, z: 0 };   // tips curled in toward the palm
    }
    return a;
}

// Build a HandPose. `world` drives gesture classification (§3.5); `imageX`/`imageY`
// set the palm-anchor landmark (image space, normalized mirrored [0,1]) that the tool
// unprojects to a world tracking target.
function makePose(world: Vec3[], imageX: number, imageY: number): HandPose {
    const landmarks = blankHand();
    landmarks[PALM_ANCHOR] = { x: imageX, y: imageY, z: 0 };
    return {
        handedness: "Right",
        landmarks,
        world,
        confidence: 1,
        handScale: 1,
        timestamp: 0,
    };
}

// Independently reproduce the tool's image→world unprojection (src/math/coords.ts):
// raycast camera → NDC, intersect the z = planeZ plane. Used to predict where a given
// image-space palm anchor lands in world space so tests can assert exact tracking.
function unprojectImage(
    camera: THREE.PerspectiveCamera,
    planeZ: number,
    imageX: number,
    imageY: number,
): THREE.Vector3 {
    const ndc_x = imageX * 2 - 1;
    const ndc_y = -(imageY * 2 - 1);
    const ray = new THREE.Ray();
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(ndc_x, ndc_y, 0.5).unproject(camera).sub(ray.origin).normalize();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
    const out = new THREE.Vector3();
    ray.intersectPlane(plane, out);
    return out;
}

function worldXForImageX(camera: THREE.PerspectiveCamera, planeZ: number, imageX: number): number {
    return unprojectImage(camera, planeZ, imageX, 0.5).x;
}

function worldYForImageY(camera: THREE.PerspectiveCamera, planeZ: number, imageY: number): number {
    return unprojectImage(camera, planeZ, 0.5, imageY).y;
}

// ---------- Headless SceneContext ----------
function makeScratch(): ScratchMath {
    return {
        v1: new THREE.Vector3(),
        v2: new THREE.Vector3(),
        v3: new THREE.Vector3(),
        v4: new THREE.Vector3(),
        m1: new THREE.Matrix4(),
        q1: new THREE.Quaternion(),
        q2: new THREE.Quaternion(),
        plane: new THREE.Plane(),
        ray: new THREE.Ray(),
    };
}

// A real THREE.Mesh plus a configured camera, so fingertipToWorld() unprojects to a
// finite world point. renderer is cast to `any` — update() must never call it (§11.1).
function makeCtx(withMesh: boolean): SceneContext {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    const mesh = withMesh
        ? new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), new THREE.MeshBasicMaterial())
        : null;

    return {
        scene: new THREE.Scene(),
        camera,
        // The test never renders; update() must not touch the renderer (§11.1).
        renderer: null as any,
        mesh,
        bvh: null,
        extraMeshes: [],
        morphT: 0,
        stage: "EMPTY",
        viewMode: "scene",
        activeMenu: null,
        scratch: makeScratch(),
        interactionPlaneZ: 0,   // mesh depth: unproject onto z = 0 plane
    };
}

// Sanity-check the fixtures against the real predicates so the behavior tests below
// can't silently pass on a hand that classifies as neither pose.
describe("translate fixtures", () => {
    it("open-palm fixture is an open palm and not a fist", () => {
        const w = openPalmWorld();
        expect(isOpenPalm(w, 1)).toBe(true);
        expect(isFist(w, 1)).toBe(false);
    });
    it("fist fixture is a fist and not an open palm", () => {
        const w = fistWorld();
        expect(isFist(w, 1)).toBe(true);
        expect(isOpenPalm(w, 1)).toBe(false);
    });
});

describe("TRANSLATE grab + track", () => {
    it("open palm grabs the mesh and it tracks toward the hand", () => {
        const tool = createTranslateMenu();
        const ctx = makeCtx(true);
        const mesh = ctx.mesh!;
        tool.enter(ctx);

        // Park the mesh away from the hand's world point so tracking is observable.
        mesh.position.set(3, 0, 0);

        // Hand held open at image-center (x = 0.5 → world x = 0). It takes
        // COMMIT_FRAMES of open palm before the grab latches; the first frame past the
        // threshold captures the offset (no snap), so the mesh does not move yet.
        const open_center = makePose(openPalmWorld(), 0.5, 0.5);

        let before = mesh.position.x;
        for (let f = 0; f < COMMIT_FRAMES; f++) {
            before = mesh.position.x;
            tool.update(ctx, open_center, null, 16);
        }
        // Offset latched on the committing frame → still parked, no teleport snap.
        expect(mesh.position.x).toBeCloseTo(before, 6);
        expect(mesh.position.x).toBeCloseTo(3, 6);

        // Now move the hand left in image space (x = 0.2 → world x < 0). The grabbed
        // mesh chases the hand's *motion* (offset preserved, §5.2): as the hand moves in
        // −x, the mesh moves in −x by the same world delta — position.x decreases.
        const open_left = makePose(openPalmWorld(), 0.2, 0.5);
        const start_x = mesh.position.x;
        tool.update(ctx, open_left, null, 16);
        const after_one = mesh.position.x;
        expect(after_one).toBeLessThan(start_x);

        // Keep tracking: it converges monotonically toward grabX + (handΔ). The hand
        // moved from world x = 0 to x = handWorldX(0.2), so the mesh settles at
        // 3 + handWorldX (a smaller, still-positive value) — the mesh follows the hand's
        // displacement, it does not teleport onto the hand.
        let prev = after_one;
        for (let f = 0; f < 40; f++) {
            tool.update(ctx, open_left, null, 16);
            expect(mesh.position.x).toBeLessThanOrEqual(prev + 1e-9);
            prev = mesh.position.x;
        }
        const hand_world_x = worldXForImageX(ctx.camera, ctx.interactionPlaneZ, 0.2);
        expect(mesh.position.x).toBeCloseTo(3 + hand_world_x, 3);
        expect(mesh.position.x).toBeLessThan(3);

        tool.exit(ctx);
    });

    it("the mesh follows the hand's motion (same direction, same world delta)", () => {
        const tool = createTranslateMenu();
        const ctx = makeCtx(true);
        const mesh = ctx.mesh!;
        tool.enter(ctx);
        mesh.position.set(0, 0, 0);

        // Grab at image-center, then move the open hand up-and-to-the-right: image
        // x = 0.85 (> 0.5 → world +x) and y = 0.2 (< 0.5 → world +y, NDC y flipped).
        const open_center = makePose(openPalmWorld(), 0.5, 0.5);
        for (let f = 0; f < COMMIT_FRAMES; f++) {
            tool.update(ctx, open_center, null, 16);
        }
        const open_hi_right = makePose(openPalmWorld(), 0.85, 0.2);
        for (let f = 0; f < 60; f++) {
            tool.update(ctx, open_hi_right, null, 16);
        }
        // Grab world point was (0,0); the hand moved to (+x,+y) so the mesh, starting at
        // the origin, lands at the same (+x,+y) world delta.
        const target_x = worldXForImageX(ctx.camera, ctx.interactionPlaneZ, 0.85);
        const target_y = worldYForImageY(ctx.camera, ctx.interactionPlaneZ, 0.2);
        expect(mesh.position.x).toBeGreaterThan(0);
        expect(mesh.position.y).toBeGreaterThan(0);
        expect(mesh.position.x).toBeCloseTo(target_x, 3);
        expect(mesh.position.y).toBeCloseTo(target_y, 3);

        tool.exit(ctx);
    });
});

describe("TRANSLATE fist latch", () => {
    it("a fist locks the mesh in place after a grab", () => {
        const tool = createTranslateMenu();
        const ctx = makeCtx(true);
        const mesh = ctx.mesh!;
        tool.enter(ctx);
        mesh.position.set(0, 0, 0);

        // Grab at center, then drag the open hand left so the mesh actually moves off
        // the origin (it follows the hand's −x motion).
        const open_center = makePose(openPalmWorld(), 0.5, 0.5);
        for (let f = 0; f < COMMIT_FRAMES; f++) {
            tool.update(ctx, open_center, null, 16);
        }
        const open_left = makePose(openPalmWorld(), 0.25, 0.5);
        for (let f = 0; f < 40; f++) {
            tool.update(ctx, open_left, null, 16);
        }
        const moved_x = mesh.position.x;
        expect(moved_x).toBeLessThan(-0.1);   // the grab really displaced the mesh

        // Close to a fist for COMMIT_FRAMES → lock. Holding the fist at the same anchor
        // must latch the position; the mesh stops following the hand.
        const fist_left = makePose(fistWorld(), 0.25, 0.5);
        for (let f = 0; f < COMMIT_FRAMES; f++) {
            tool.update(ctx, fist_left, null, 16);
        }
        const after_lock = mesh.position.x;

        // Move the hand far right while keeping the fist closed; the mesh stays put.
        const fist_right = makePose(fistWorld(), 0.9, 0.5);
        for (let f = 0; f < 20; f++) {
            tool.update(ctx, fist_right, null, 16);
        }
        expect(mesh.position.x).toBeCloseTo(after_lock, 6);

        tool.exit(ctx);
    });
});

describe("TRANSLATE empty-world / debounce guards", () => {
    it("is a no-op when ctx.mesh is null", () => {
        const tool = createTranslateMenu();
        const ctx = makeCtx(false);
        expect(ctx.mesh).toBeNull();
        tool.enter(ctx);

        const open_center = makePose(openPalmWorld(), 0.5, 0.5);
        // Many open-palm frames against an empty world must neither throw nor create a
        // mesh — only ADD SHAPES makes the first mesh (§5.1).
        expect(() => {
            for (let f = 0; f < COMMIT_FRAMES + 10; f++) {
                tool.update(ctx, open_center, null, 16);
            }
        }).not.toThrow();
        expect(ctx.mesh).toBeNull();

        tool.exit(ctx);
    });

    it("does nothing when there is no execution hand", () => {
        const tool = createTranslateMenu();
        const ctx = makeCtx(true);
        const mesh = ctx.mesh!;
        tool.enter(ctx);
        mesh.position.set(1, 2, 3);

        for (let f = 0; f < COMMIT_FRAMES + 5; f++) {
            tool.update(ctx, null, null, 16);
        }
        // With no hand the mesh is never grabbed and never moves.
        expect(mesh.position.x).toBeCloseTo(1, 6);
        expect(mesh.position.y).toBeCloseTo(2, 6);
        expect(mesh.position.z).toBeCloseTo(3, 6);

        tool.exit(ctx);
    });

    it("does not grab before the debounce threshold", () => {
        const tool = createTranslateMenu();
        const ctx = makeCtx(true);
        const mesh = ctx.mesh!;
        tool.enter(ctx);
        mesh.position.set(2, 0, 0);

        // Only COMMIT_FRAMES - 1 open frames: below the commit threshold, so no grab.
        const open_center = makePose(openPalmWorld(), 0.5, 0.5);
        for (let f = 0; f < COMMIT_FRAMES - 1; f++) {
            tool.update(ctx, open_center, null, 16);
        }
        // No grab latched → the mesh has not tracked toward world x = 0.
        expect(mesh.position.x).toBeCloseTo(2, 6);

        tool.exit(ctx);
    });
});
