// §5 INTERACT — NEGATIVE shapes + N-ary boolean (CSG) on a minimal headless SceneContext.
//
// Paradigm under test: a shape tagged NEGATIVE (a "hole" / cutter, drawn red) is SUBTRACTED by
// UNION instead of added — so "mark one negative, then union" drills a hole. With the cutter left
// positive, UNION fuses both. This verifies the carve at the geometry level (the previewed result's
// bounding box), plus the negative-tag helpers + red highlight, without a renderer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as THREE from "three";
import { createInteractMenu } from "../src/menu/interaction";
import { isNegative, toggleNegative, refreshHighlight, selectedCount } from "../src/core/shapes";
import type { SceneContext, ScratchMath } from "../src/types";

// ---- Headless DOM: a canvas (for the Carousel's CanvasTextures) + plain elements (for Panel) ----
function makeStubCanvasContext(): CanvasRenderingContext2D {
    const noop = (): void => {};
    return {
        clearRect: noop, beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop,
        stroke: noop, fill: noop, fillRect: noop, fillText: noop, save: noop, restore: noop,
        translate: noop, scale: noop, lineWidth: 0, strokeStyle: "", fillStyle: "", font: "",
        textAlign: "", textBaseline: "", shadowColor: "", shadowBlur: 0,
    } as unknown as CanvasRenderingContext2D;
}
function makeFakeEl(): Record<string, unknown> {
    return {
        className: "", textContent: "", innerHTML: "", offsetWidth: 0, style: {},
        appendChild(c: unknown): unknown { return c; }, remove(): void {},
    };
}
let PRIOR_DOC: unknown;
let PRIOR_WIN: unknown;
beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    PRIOR_DOC = g.document;
    PRIOR_WIN = g.window;
    g.document = {
        createElement(tag: string) {
            if (tag === "canvas") return { width: 0, height: 0, getContext: () => makeStubCanvasContext() };
            return makeFakeEl();
        },
        body: makeFakeEl(),
    };
    g.window = {
        setTimeout: (fn: () => void): number => { void fn; return 0; },
        clearTimeout: (): void => {},
    };
});
afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    g.document = PRIOR_DOC;
    g.window = PRIOR_WIN;
});

function makeScratch(): ScratchMath {
    return {
        v1: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), v4: new THREE.Vector3(),
        m1: new THREE.Matrix4(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion(),
        plane: new THREE.Plane(), ray: new THREE.Ray(),
    };
}

// A spans x∈[-0.5,0.5]; B spans x∈[0.1,1.1] — overlap x∈[0.1,0.5].
//   UNION (both positive)  → result reaches B's far edge (~x=1.1).
//   UNION (B negative)     → A−B, the slab is carved away → result reaches only ~x=0.1.
function makeCtx(): { ctx: SceneContext; a: THREE.Mesh; b: THREE.Mesh } {
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    b.position.set(0.6, 0, 0);
    const scene = new THREE.Scene();
    scene.add(a, b);
    a.updateWorldMatrix(true, false);
    b.updateWorldMatrix(true, false);
    const ctx: SceneContext = {
        scene, camera, renderer: null as any,
        mesh: a, bvh: null, extraMeshes: [b], selected: [a, b], focusIndex: 0,
        morphT: 0, stage: "EMPTY", viewMode: "scene", activeMenu: null, wireframe: false,
        scratch: makeScratch(), interactionPlaneZ: 0,
    };
    return { ctx, a, b };
}

// The preview is the one mesh in the scene that is neither operand; return its bbox max.x.
function previewMaxX(ctx: SceneContext, a: THREE.Mesh, b: THREE.Mesh): number {
    let preview: THREE.Mesh | null = null;
    for (const c of ctx.scene.children) {
        if (c instanceof THREE.Mesh && c !== a && c !== b) preview = c;
    }
    expect(preview).not.toBeNull();
    preview!.geometry.computeBoundingBox();
    return preview!.geometry.boundingBox!.max.x;
}

describe("negative-tag helpers + red highlight", () => {
    it("toggleNegative flips the userData flag both ways", () => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
        expect(isNegative(m)).toBe(false);
        toggleNegative(m);
        expect(isNegative(m)).toBe(true);
        toggleNegative(m);
        expect(isNegative(m)).toBe(false);
    });

    it("refreshHighlight tints a selected negative shape red", () => {
        const { ctx, a } = makeCtx();
        toggleNegative(a);
        refreshHighlight(ctx);
        const col = (a.material as THREE.MeshStandardMaterial).color;
        expect(col.r).toBeGreaterThan(0.8);            // red dominant
        expect(col.r).toBeGreaterThan(col.g + 0.3);
        expect(col.r).toBeGreaterThan(col.b + 0.3);
    });
});

describe("INTERACT UNION respects the NEGATIVE tag", () => {
    it("both positive → UNION fuses (result spans both shapes)", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);                                // default op = UNION
        const maxX = previewMaxX(ctx, a, b);
        expect(maxX).toBeGreaterThan(0.9);              // reaches B's far edge → fused
        tool.exit(ctx);
    });

    it("B negative → UNION carves it out (result is the hole-bearing A−B)", () => {
        const { ctx, a, b } = makeCtx();
        toggleNegative(b);                              // B is now a cutter
        const tool = createInteractMenu();
        tool.enter(ctx);                                // UNION = fuse positives, carve negatives
        const maxX = previewMaxX(ctx, a, b);
        expect(maxX).toBeLessThan(0.6);                 // B's slab removed → far edge gone
        tool.exit(ctx);
        expect(a.visible).toBe(true);                   // operands restored on exit
        expect(b.visible).toBe(true);
    });

    it("a nav pinch applies: both operands are replaced by one selected result", () => {
        const { ctx, a, b } = makeCtx();
        toggleNegative(b);
        const tool = createInteractMenu();
        tool.enter(ctx);

        // Let the carousel's open fade finish first (you wouldn't pinch in the first 120ms either),
        // then drive the nav/left pinch — onSelect fires the apply once the close fade completes.
        const execNeutral = pose(false);                // right hand present, not pinching
        const navNeutral = pose(false);                 // left hand present, not pinching
        const navPinch = pose(true);                    // left hand pinched → carousel select
        for (let f = 0; f < 10; f++) tool.update(ctx, execNeutral, navNeutral, 16); // finish open fade
        for (let f = 0; f < 16; f++) tool.update(ctx, execNeutral, navPinch, 16);    // pinch → apply

        expect(selectedCount(ctx)).toBe(1);             // two operands → one result, sole selection
        const shapeCount = (ctx.mesh ? 1 : 0) + ctx.extraMeshes.length;
        expect(shapeCount).toBe(1);
        expect(ctx.mesh).not.toBe(a);
        expect(ctx.mesh).not.toBe(b);

        tool.exit(ctx);
    });
});

// A hand pose: pinched (thumb tip on index tip → pinch ≈ 1) or open. handedness picks which hand
// the INTERACT tool reads (exec = Right advance, nav = Left apply).
function pose(pinch: boolean): import("../src/types").HandPose {
    const a: import("../src/types").Vec3[] = [];
    for (let i = 0; i < 21; i++) a.push({ x: 0, y: 0, z: 0 });
    a[0] = { x: 0, y: 0, z: 0 };
    a[9] = { x: 0, y: 1, z: 0 };
    a[8] = { x: 0.2, y: 1.5, z: 0 };
    a[6] = { x: 0.2, y: 1.0, z: 0 };
    a[4] = pinch ? { x: 0.2, y: 1.5, z: 0 } : { x: -0.6, y: 0.4, z: 0 };
    a[3] = { x: -0.2, y: 0.3, z: 0 };
    return { handedness: "Right", landmarks: a, world: a, confidence: 1, handScale: 1, timestamp: 0 };
}
