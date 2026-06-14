// §5 INTERACT — no-pinch boolean (CSG) on a minimal headless SceneContext.
//
// Paradigm under test: with two shapes selected the tool previews their boolean combination.
// A horizontal SWIPE of the nav (left) index finger cycles the operation (subtract → union →
// intersect) and the live preview rebuilds; a GRAB (closing the nav hand into a fist) applies
// it — the two operands are removed and replaced by the single result, which becomes the sole
// selection. There is no pinch. SUBTRACT is the default (the hole-maker).
//
// Pure-logic test (vitest `node` env): three-bvh-csg + the BVH patch run on geometry arrays,
// no renderer. The tool's plain-DOM Panel is fed by the tiny document/window stub below.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as THREE from "three";
import { createInteractMenu } from "../src/menu/interaction";
import { selectedCount } from "../src/core/shapes";
import type { HandPose, SceneContext, ScratchMath, Vec3 } from "../src/types";

const WRIST = 0;
const MIDDLE_MCP = 9;
const INDEX_TIP = 8;
const GRAB_FRAMES = 5;   // mirrors interaction.ts (§12 debounce)

// ---------- Headless DOM (Panel touches just these) ----------
interface FakeEl {
    className: string; textContent: string; innerHTML: string; readonly offsetWidth: number;
    style: Record<string, string>; appendChild(child: FakeEl): FakeEl; remove(): void;
}
function makeFakeEl(): FakeEl {
    return {
        className: "", textContent: "", innerHTML: "", offsetWidth: 0, style: {},
        appendChild(child: FakeEl): FakeEl { return child; }, remove(): void { /* detached */ },
    };
}
let saved_document: unknown;
let saved_window: unknown;
beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    saved_document = g.document; saved_window = g.window;
    g.document = { createElement: (_t: string): FakeEl => makeFakeEl(), body: makeFakeEl() };
    g.window = {
        setTimeout: (fn: () => void): number => { void fn; return 0; },
        clearTimeout: (_id: number): void => { /* no-op */ },
    };
});
afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    g.document = saved_document; g.window = saved_window;
});

// ---------- Landmark fixtures (image == world; classify reads pose from the image set) ----------
function blankHand(): Vec3[] {
    const a: Vec3[] = [];
    for (let i = 0; i < 21; i++) a.push({ x: 0, y: 0, z: 0 });
    return a;
}
function fistShape(): Vec3[] {
    const a = blankHand();
    a[WRIST] = { x: 0, y: 0, z: 0 };
    a[MIDDLE_MCP] = { x: 0, y: 1, z: 0 };
    a[3] = { x: -0.3, y: 0.4, z: 0 };
    a[4] = { x: -0.8, y: 0.6, z: 0 };
    const pips = [6, 10, 14, 18];
    const tips = [8, 12, 16, 20];
    for (let k = 0; k < 4; k++) {
        a[pips[k]] = { x: (k - 1.5) * 0.1, y: 0.9, z: 0 };
        a[tips[k]] = { x: (k - 1.5) * 0.1, y: 0.3, z: 0 };
    }
    return a;
}
function pointShape(indexX: number): Vec3[] {
    const a = blankHand();
    a[WRIST] = { x: 0, y: 0, z: 0 };
    a[MIDDLE_MCP] = { x: 0, y: 1, z: 0 };
    a[3] = { x: -0.1, y: 0.15, z: 0 };
    a[4] = { x: -0.2, y: 0.2, z: 0 };
    a[6] = { x: indexX, y: 1.0, z: 0 };
    a[INDEX_TIP] = { x: indexX, y: 2.0, z: 0 };
    const pips = [10, 14, 18];
    const tips = [12, 16, 20];
    for (let k = 0; k < 3; k++) {
        a[pips[k]] = { x: (k - 1) * 0.1, y: 0.9, z: 0 };
        a[tips[k]] = { x: (k - 1) * 0.1, y: 0.35, z: 0 };
    }
    return a;
}
function pose(shape: Vec3[]): HandPose {
    return { handedness: "Left", landmarks: shape, world: shape, confidence: 1, handScale: 1, timestamp: 0 };
}

// ---------- Headless SceneContext with two overlapping boxes selected ----------
function makeScratch(): ScratchMath {
    return {
        v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(),
        m1: new THREE.Matrix4(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion(),
        plane: new THREE.Plane(), ray: new THREE.Ray(),
    };
}
// A spans x∈[-0.5,0.5]; B spans x∈[0.1,1.1] — they overlap in x∈[0.1,0.5].
//   SUBTRACT (A−B) removes B's slab → result reaches only to ~x=0.1.
//   UNION    (A∪B) spans both → result reaches to ~x=1.1.
// That gap in bbox.max.x lets the test tell the operations apart without reading private state.
function makeCtx(): { ctx: SceneContext; a: THREE.Mesh; b: THREE.Mesh } {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    b.position.set(0.6, 0, 0);
    const scene = new THREE.Scene();
    scene.add(a, b);
    a.updateWorldMatrix(true, false);
    b.updateWorldMatrix(true, false);
    const ctx: SceneContext = {
        scene, camera, renderer: null as any,
        mesh: a, bvh: null, extraMeshes: [b], selected: [a, b], focusIndex: 0,
        morphT: 0, stage: "EMPTY", viewMode: "scene", activeMenu: null,
        scratch: makeScratch(), interactionPlaneZ: 0,
    };
    return { ctx, a, b };
}

// The live preview is the one mesh in the scene that is neither operand.
function findPreview(ctx: SceneContext, a: THREE.Mesh, b: THREE.Mesh): THREE.Mesh | null {
    for (const c of ctx.scene.children) {
        if (c instanceof THREE.Mesh && c !== a && c !== b) return c;
    }
    return null;
}
function previewMaxX(ctx: SceneContext, a: THREE.Mesh, b: THREE.Mesh): number {
    const p = findPreview(ctx, a, b);
    expect(p).not.toBeNull();
    p!.geometry.computeBoundingBox();
    return p!.geometry.boundingBox!.max.x;
}

describe("INTERACT defaults to SUBTRACT and previews live", () => {
    it("on enter the preview is the subtract (carved) result, with the operands hidden", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);

        // Default op = SUBTRACT (A−B): the preview only reaches to the cut (~x=0.1), well short
        // of B's far edge (~x=1.1). The two operands are hidden behind the preview.
        const subMaxX = previewMaxX(ctx, a, b);
        expect(subMaxX).toBeLessThan(0.6);
        expect(a.visible).toBe(false);
        expect(b.visible).toBe(false);

        tool.exit(ctx);
        // Exit restores the operands and tears down the preview.
        expect(a.visible).toBe(true);
        expect(b.visible).toBe(true);
        expect(findPreview(ctx, a, b)).toBeNull();
    });

    it("a swipe cycles SUBTRACT → UNION and the preview rebuilds to the larger union", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);
        const subMaxX = previewMaxX(ctx, a, b);

        // One rightward swipe (point at x=0 then x=0.6 → vx 0.6 > 0.5 threshold) → next op.
        tool.update(ctx, null, pose(pointShape(0.0)), 16);
        tool.update(ctx, null, pose(pointShape(0.6)), 16);

        // UNION spans both boxes → the preview now reaches B's far edge, much further than the cut.
        const uniMaxX = previewMaxX(ctx, a, b);
        expect(uniMaxX).toBeGreaterThan(subMaxX + 0.3);

        tool.exit(ctx);
    });
});

describe("INTERACT grab applies the boolean (no pinch)", () => {
    it("a sustained fist replaces the two operands with one selected result", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);
        expect(selectedCount(ctx)).toBe(2);

        const fist = pose(fistShape());
        // Below threshold: not applied yet (operands still hidden behind the preview, still 2 sel).
        for (let f = 0; f < GRAB_FRAMES - 1; f++) tool.update(ctx, null, fist, 16);
        expect(selectedCount(ctx)).toBe(2);

        // The committing frame applies: A and B are gone, the result is the lone selection.
        tool.update(ctx, null, fist, 16);
        expect(selectedCount(ctx)).toBe(1);
        const shapeCount = (ctx.mesh ? 1 : 0) + ctx.extraMeshes.length;
        expect(shapeCount).toBe(1);
        expect(ctx.mesh).not.toBeNull();
        expect(ctx.mesh).not.toBe(a);
        expect(ctx.mesh).not.toBe(b);

        // Holding the fist must not apply again (rising-edge latch; nothing left to combine).
        for (let f = 0; f < 10; f++) tool.update(ctx, null, fist, 16);
        expect(selectedCount(ctx)).toBe(1);

        tool.exit(ctx);
    });
});
