// §5 INTERACT — N-ary boolean (CSG) on a minimal headless SceneContext.
//
// Verifies UNION at the geometry level (the previewed result's bounding box reaches both shapes'
// extent → they fused) and that applying replaces the operands with the single result, without a
// renderer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as THREE from "three";
import { createInteractMenu } from "../src/menu/interaction";
import { selectedCount } from "../src/core/shapes";
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
//   UNION → result reaches B's far edge (~x=1.1).
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

describe("INTERACT boolean (CSG)", () => {
    it("UNION fuses the operands (result spans both shapes)", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);                                // default op = UNION
        const maxX = previewMaxX(ctx, a, b);
        expect(maxX).toBeGreaterThan(0.9);              // reaches B's far edge → fused
        tool.exit(ctx);
    });

    it("UNION merges geometries and spans both shapes", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);

        // Find the preview mesh
        let preview: THREE.Mesh | null = null;
        for (const c of ctx.scene.children) {
            if (c instanceof THREE.Mesh && c !== a && c !== b) preview = c;
        }
        expect(preview).not.toBeNull();

        preview!.geometry.computeBoundingBox();
        const box = preview!.geometry.boundingBox!;
        const minX = box.min.x;
        const maxX = box.max.x;
        const width = maxX - minX;
        console.log(`UNION result: x=[${minX.toFixed(3)}, ${maxX.toFixed(3)}] width=${width.toFixed(3)}`);

        // Union should span from A's left (-0.5) to B's right (1.1) ≈ width 1.6
        expect(minX).toBeLessThan(-0.4);               // extends to A's left edge
        expect(maxX).toBeGreaterThan(1.0);             // extends to B's right edge
        expect(width).toBeGreaterThan(1.4);            // total width should be ~1.6

        tool.exit(ctx);
    });

    it("SUBTRACT primary minus other operand", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);

        // Let initial fade finish
        const execNeutral = pose(false);
        const navNeutral = pose(false);
        for (let f = 0; f < 10; f++) tool.update(ctx, execNeutral, navNeutral, 16);

        // Advance to SUBTRACT operation (carousel index 1: UNION=0, SUBTRACT=1)
        const execPinch = pose(true);
        // Pinch and update repeatedly to advance carousel
        for (let i = 0; i < 30; i++) tool.update(ctx, execPinch, navNeutral, 16);
        // Release pinch and let carousel settle
        for (let i = 0; i < 30; i++) tool.update(ctx, execNeutral, navNeutral, 16);

        // Find the preview mesh
        let preview: THREE.Mesh | null = null;
        for (const c of ctx.scene.children) {
            if (c instanceof THREE.Mesh && c !== a && c !== b) preview = c;
        }

        // SUBTRACT should compute A - B. A spans [-0.5, 0.5], B spans [0.1, 1.1]
        // Result should be the left part of A: approximately [-0.5, 0.1] width ≈ 0.6
        if (preview) {
            preview.geometry.computeBoundingBox();
            const box = preview.geometry.boundingBox!;
            const width = box.max.x - box.min.x;
            const minX = box.min.x;
            const maxX = box.max.x;
            console.log(`SUBTRACT result: x=[${minX.toFixed(3)}, ${maxX.toFixed(3)}] width=${width.toFixed(3)}`);
            expect(minX).toBeLessThan(-0.4);            // should reach A's left edge
            expect(maxX).toBeLessThan(0.2);             // should stop before B's right edge (~0.1)
            expect(width).toBeGreaterThan(0.5);         // but should have some content (~0.6)
        } else {
            expect(preview).not.toBeNull();
        }

        tool.exit(ctx);
    });

    it("INTERSECT keeps only the overlap region", () => {
        const { ctx, a, b } = makeCtx();
        const tool = createInteractMenu();
        tool.enter(ctx);

        // Let initial fade finish
        const execNeutral = pose(false);
        const navNeutral = pose(false);
        for (let f = 0; f < 10; f++) tool.update(ctx, execNeutral, navNeutral, 16);

        // Advance to INTERSECT operation (carousel index 2: UNION=0, SUBTRACT=1, INTERSECT=2)
        const execPinch = pose(true);
        // Pinch twice to advance carousel: UNION→SUBTRACT→INTERSECT
        for (let i = 0; i < 30; i++) tool.update(ctx, execPinch, navNeutral, 16);
        for (let i = 0; i < 30; i++) tool.update(ctx, execNeutral, navNeutral, 16);
        for (let i = 0; i < 30; i++) tool.update(ctx, execPinch, navNeutral, 16);
        for (let i = 0; i < 30; i++) tool.update(ctx, execNeutral, navNeutral, 16);

        // Find the preview mesh
        let preview: THREE.Mesh | null = null;
        for (const c of ctx.scene.children) {
            if (c instanceof THREE.Mesh && c !== a && c !== b) preview = c;
        }

        // INTERSECT of overlapping boxes should produce a smaller result (the overlap region)
        // A spans x: [-0.5, 0.5]; B spans x: [0.1, 1.1] → overlap is [0.1, 0.5] width ≈ 0.4
        if (preview) {
            preview.geometry.computeBoundingBox();
            const box = preview.geometry.boundingBox!;
            const width = box.max.x - box.min.x;
            const minX = box.min.x;
            const maxX = box.max.x;
            console.log(`INTERSECT result: x=[${minX.toFixed(3)}, ${maxX.toFixed(3)}] width=${width.toFixed(3)}`);
            expect(minX).toBeGreaterThan(0.05);         // should reach B's left edge (~0.1)
            expect(maxX).toBeLessThan(0.55);            // should stop at A's right edge (~0.5)
            expect(width).toBeLessThan(0.5);            // overlap region is narrow (~0.4)
            expect(width).toBeGreaterThan(0.3);         // but not empty
        } else {
            expect(preview).not.toBeNull();
        }

        tool.exit(ctx);
    });

    it("a nav pinch applies: both operands are replaced by one selected result", () => {
        const { ctx, a, b } = makeCtx();
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
