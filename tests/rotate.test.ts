// §5.4 ROTATE — quaternion math test (SPEC §10.1).
//
// The rotation math lives inside the createRotateMenu() closure and is not exported, so
// (per the file's acceptance criteria) we exercise it through a ctx-driven update: drive a
// known pinch-drag and assert mesh.quaternion behaves as the spec demands —
//
//     deltaQ          = Q_current · Q_start⁻¹      (the hand-applied rotation, §5.4)
//     mesh.quaternion = deltaQ · R_start           (premultiply, parent-frame, drift-free)
//
// We also pin down the underlying quaternion identities directly (no gimbal lock; composing
// two rotations equals quaternion multiplication) so a regression in the math path — Euler
// creeping in, a wrong multiply order — fails loudly.
//
// The menu's enter()/update() touch a plain-DOM Panel (§4.2). vitest runs under the "node"
// environment (vite.config.ts), so we install a minimal document/window stub before enter()
// builds the panel. The stub only needs to satisfy Panel's constructor + setBody/setInstructions
// and the arcball Group construction; no real layout is required for the math we assert.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as THREE from "three";
import type { SceneContext, HandPose, ScratchMath, Vec3 } from "../src/types";
import { MenuId } from "../src/types";
import { createRotateMenu } from "../src/menu/rotate";

// ---------------------------------------------------------------------------
// Minimal DOM stub. createRotateMenu().enter() constructs a Panel, which calls
// document.createElement / document.body.appendChild and (on hide) window.setTimeout.
// None of it affects the quaternion math; we only need the calls not to throw.
// ---------------------------------------------------------------------------
interface StubNode {
    className: string;
    textContent: string;
    innerHTML: string;
    style: { cssText: string; [k: string]: unknown };
    readonly offsetWidth: number;
    appendChild(child: StubNode): StubNode;
    remove(): void;
}

function makeNode(): StubNode {
    return {
        className: "",
        textContent: "",
        innerHTML: "",
        style: { cssText: "" },
        offsetWidth: 0,
        appendChild(child) { return child; },
        remove() { /* no-op */ },
    };
}

let dom_installed = false;
const saved: Record<string, PropertyDescriptor | undefined> = {};

function installDom(): void {
    const g = globalThis as Record<string, unknown>;
    for (const key of ["document", "window"]) {
        saved[key] = Object.getOwnPropertyDescriptor(g, key);
    }
    const documentStub = {
        body: makeNode(),
        createElement: () => makeNode(),
    };
    g.document = documentStub;
    // Panel uses window.setTimeout / clearTimeout; delegate to the real timers.
    g.window = {
        setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number,
        clearTimeout: (id: number) => clearTimeout(id),
    };
    dom_installed = true;
}

function restoreDom(): void {
    if (!dom_installed) return;
    const g = globalThis as Record<string, unknown>;
    for (const key of ["document", "window"]) {
        const desc = saved[key];
        if (desc) Object.defineProperty(g, key, desc);
        else delete g[key];
    }
    dom_installed = false;
}

beforeAll(installDom);
afterAll(restoreDom);

// ---------------------------------------------------------------------------
// Scratch + context factories. The menu reuses ctx.scratch (zero per-frame alloc, §6.2);
// the test owns a real set of THREE objects so the math runs against genuine quaternions.
// ---------------------------------------------------------------------------
function makeScratch(): ScratchMath {
    return {
        v1: new THREE.Vector3(), v2: new THREE.Vector3(),
        v3: new THREE.Vector3(), v4: new THREE.Vector3(),
        m1: new THREE.Matrix4(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion(),
        plane: new THREE.Plane(), ray: new THREE.Ray(),
    };
}

function makeContext(mesh: THREE.Mesh | null): SceneContext {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 6);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    if (mesh) scene.add(mesh);
    return {
        scene,
        camera,
        // No real WebGL context under node; the menu never touches the renderer.
        renderer: {} as THREE.WebGLRenderer,
        mesh,
        bvh: null,
        extraMeshes: [],
        selected: mesh ? [mesh] : [],
        focusIndex: 0,
        morphT: 0,
        stage: mesh ? "SPHERE" : "EMPTY",
        viewMode: "scene",
        activeMenu: MenuId.ROTATE,
        scratch: makeScratch(),
        interactionPlaneZ: 0,
    };
}

function makeMesh(): THREE.Mesh {
    // A unit-ish box at the origin; ROTATE only reads its world position + writes its
    // quaternion, so the geometry is incidental. BVH/normals are untouched here.
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(0, 0, 0);
    mesh.updateMatrixWorld(true);
    return mesh;
}

// ---------------------------------------------------------------------------
// HandPose builder. ROTATE's hand basis (§5.4) is built from WORLD landmarks:
//     yHand = wrist → indexMCP(5)
//     zHand = (indexMCP-wrist) × (pinkyMCP(17)-wrist)
//     xHand = yHand × zHand
// and engage needs: a firm pinch (thumb tip 4 near index tip 8, in image space, scaled by
// S = ‖wrist−middleMCP(9)‖) AND the index fingertip (8) projecting within ENGAGE_RADIUS of
// the mesh center. We synthesize a full 21-landmark hand whose palm orientation we control
// via a single quaternion, then place the pinch landmarks to satisfy those predicates.
// ---------------------------------------------------------------------------
const N_LANDMARKS = 21;
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;

function v(x: number, y: number, z: number): Vec3 { return { x, y, z }; }

// Build the 21 world landmarks for a hand whose palm orientation is `q`. We start from a
// canonical right-hand layout (fingers along +Y, palm normal +Z) and rotate the three basis
// landmarks the menu actually reads. handScale S = ‖wrist − middleMCP‖ is held at ~0.09 m.
function worldLandmarks(q: THREE.Quaternion): Vec3[] {
    const lm: Vec3[] = [];
    for (let i = 0; i < N_LANDMARKS; i++) lm.push(v(0, 0, 0));

    const wrist = new THREE.Vector3(0, 0, 0);
    // Canonical offsets from the wrist (metric-ish, in the hand's own frame).
    const index_mcp = new THREE.Vector3(0.02, 0.09, 0).applyQuaternion(q);
    const pinky_mcp = new THREE.Vector3(-0.03, 0.08, 0).applyQuaternion(q);
    const middle_mcp = new THREE.Vector3(0.0, 0.09, 0); // sets S; orientation-independent length

    lm[WRIST] = v(wrist.x, wrist.y, wrist.z);
    lm[INDEX_MCP] = v(index_mcp.x, index_mcp.y, index_mcp.z);
    lm[PINKY_MCP] = v(pinky_mcp.x, pinky_mcp.y, pinky_mcp.z);
    lm[MIDDLE_MCP] = v(middle_mcp.x, middle_mcp.y, middle_mcp.z);
    return lm;
}

// Image-space landmarks (normalized [0,1], mirrored). Only three indices matter to ROTATE:
//   tip4 & tip8 → pinch closure (isPinching / pinchAmount), scaled by S
//   tip8        → fingertip projected to world, must land within ENGAGE_RADIUS of center
// We place tip4≈tip8 near image center so the unprojected fingertip sits at the origin plane
// (z=0, the mesh center) and the pinch gap is ~0. S here is ‖wrist−middleMCP‖ in image space.
function imageLandmarks(pinched: boolean): Vec3[] {
    const lm: Vec3[] = [];
    for (let i = 0; i < N_LANDMARKS; i++) lm.push(v(0.5, 0.5, 0));
    // Establish a sane image-space hand scale S = ‖wrist − middleMCP‖ ≈ 0.18.
    lm[WRIST] = v(0.5, 0.68, 0);
    lm[MIDDLE_MCP] = v(0.5, 0.5, 0);
    // Index fingertip dead-center → unprojects onto the interaction plane at the origin.
    lm[INDEX_TIP] = v(0.5, 0.5, 0);
    // Thumb tip: coincident (gap≈0 → fully pinched) or far away (gap large → released).
    lm[THUMB_TIP] = pinched ? v(0.5, 0.5, 0) : v(0.5, 0.92, 0);
    return lm;
}

function makePose(palm: THREE.Quaternion, pinched: boolean): HandPose {
    return {
        handedness: "Right",
        landmarks: imageLandmarks(pinched),
        world: worldLandmarks(palm),
        confidence: 1,
        handScale: 0.09,
        timestamp: 0,
    };
}

// Convenience: a pinch about a world axis by `angle` radians, applied to the canonical palm.
function palmRotated(axis: THREE.Vector3, angle: number): THREE.Quaternion {
    return new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), angle);
}

// Quaternion comparisons run in single precision (three stores components as float32),
// so identity round-trips settle around 1e-7; 1e-6 is a tight-but-honest correctness bound.
const QUAT_EPS = 1e-6;

function isNormalized(q: THREE.Quaternion): boolean {
    return Math.abs(q.length() - 1) < 1e-6;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ROTATE quaternion math (§5.4)", () => {
    describe("core identities — deltaQ = Q_cur · Q_start⁻¹, no Euler", () => {
        it("deltaQ recovers the swept rotation exactly", () => {
            const q_start = palmRotated(new THREE.Vector3(0, 1, 0), 0.3);
            const sweep = palmRotated(new THREE.Vector3(1, 0, 0), 0.7);
            const q_cur = sweep.clone().multiply(q_start); // applied in parent frame
            const delta = q_cur.clone().multiply(q_start.clone().invert());
            expect(delta.angleTo(sweep)).toBeLessThan(QUAT_EPS);
        });

        it("composing two rotations equals quaternion multiplication (associative, exact)", () => {
            const a = palmRotated(new THREE.Vector3(0, 0, 1), 0.9);
            const b = palmRotated(new THREE.Vector3(1, 1, 0), 0.5);
            const ab = a.clone().multiply(b);
            // Apply to a vector both ways: q∘(q'∘x) must equal (q·q')∘x.
            const x = new THREE.Vector3(0.3, -0.7, 0.2);
            const stepwise = x.clone().applyQuaternion(b).applyQuaternion(a);
            const fused = x.clone().applyQuaternion(ab);
            expect(stepwise.distanceTo(fused)).toBeLessThan(1e-12);
        });

        it("premultiply applies delta in the parent frame: mesh = deltaQ · R_start", () => {
            const r_start = palmRotated(new THREE.Vector3(0, 1, 0), 1.1);
            const delta = palmRotated(new THREE.Vector3(1, 0, 0), 0.4);
            const expected = delta.clone().multiply(r_start);     // delta · R_start
            const actual = r_start.clone().premultiply(delta);    // three's premultiply
            expect(actual.angleTo(expected)).toBeLessThan(QUAT_EPS);
        });

        it("no gimbal lock: a yaw=90° pole still composes cleanly with further rotation", () => {
            // Euler XYZ at pitch=π/2 is singular; quaternions are not. Rotate to the pole,
            // then apply more rotation and verify the result is a valid unit quaternion that
            // moves a probe vector by the full composed amount (not a degenerate snap).
            const to_pole = palmRotated(new THREE.Vector3(0, 1, 0), Math.PI / 2);
            const more = palmRotated(new THREE.Vector3(0, 0, 1), Math.PI / 2);
            const composed = more.clone().multiply(to_pole);
            expect(isNormalized(composed)).toBe(true);
            const probe = new THREE.Vector3(1, 0, 0).applyQuaternion(composed);
            const direct = new THREE.Vector3(1, 0, 0)
                .applyQuaternion(to_pole).applyQuaternion(more);
            expect(probe.distanceTo(direct)).toBeLessThan(1e-12);
        });
    });

    describe("ctx-driven update — known pinch-drag rotates the mesh", () => {
        let menu: ReturnType<typeof createRotateMenu>;

        beforeEach(() => { menu = createRotateMenu(); });

        it("does nothing destructive when the world is empty (ctx.mesh = null)", () => {
            const ctx = makeContext(null);
            expect(() => {
                menu.enter(ctx);
                menu.update(ctx, makePose(palmRotated(new THREE.Vector3(0, 1, 0), 0.5), true), null, 16);
                menu.exit(ctx);
            }).not.toThrow();
            expect(ctx.mesh).toBeNull();
        });

        it("a pinch-drag turns the mesh and leaves a normalized quaternion", () => {
            const mesh = makeMesh();
            const ctx = makeContext(mesh);
            menu.enter(ctx);

            // Engage at a reference palm orientation (pinch closed, fingertip on the mesh).
            const palm_start = palmRotated(new THREE.Vector3(0, 1, 0), 0.0);
            menu.update(ctx, makePose(palm_start, true), null, 16);
            const after_engage = mesh.quaternion.clone();

            // Drag: rotate the palm; the mesh must follow by the same swept rotation.
            const palm_cur = palmRotated(new THREE.Vector3(0, 1, 0), 0.6);
            menu.update(ctx, makePose(palm_cur, true), null, 16);

            expect(mesh.quaternion.angleTo(after_engage)).toBeGreaterThan(1e-3);
            expect(isNormalized(mesh.quaternion)).toBe(true);
            menu.exit(ctx);
        });

        it("the mesh's swept angle matches the hand's swept angle (deltaQ consistency)", () => {
            const mesh = makeMesh();
            const ctx = makeContext(mesh);
            // Start the mesh at a non-identity rotation so we also prove R_start is honored.
            const r_start = palmRotated(new THREE.Vector3(1, 0, 0), 0.5);
            mesh.quaternion.copy(r_start);
            mesh.updateMatrixWorld(true);
            menu.enter(ctx);

            const axis = new THREE.Vector3(0, 1, 0);
            const palm_start = palmRotated(axis, 0.0);
            const sweep_angle = 0.5;
            const palm_cur = palmRotated(axis, sweep_angle);

            menu.update(ctx, makePose(palm_start, true), null, 16); // engage snapshot
            menu.update(ctx, makePose(palm_cur, true), null, 16);   // apply drag

            // mesh.quaternion should be deltaQ · R_start, so deltaQ = mesh · R_start⁻¹.
            const recovered_delta = mesh.quaternion.clone().multiply(r_start.clone().invert());
            // The hand swept exactly `sweep_angle` about `axis`; the recovered delta must match.
            const expected_delta = palmRotated(axis, sweep_angle);
            expect(recovered_delta.angleTo(expected_delta)).toBeLessThan(1e-6);
            menu.exit(ctx);
        });

        it("releasing the pinch latches the rotation (further hand motion is ignored)", () => {
            const mesh = makeMesh();
            const ctx = makeContext(mesh);
            menu.enter(ctx);

            const axis = new THREE.Vector3(0, 1, 0);
            menu.update(ctx, makePose(palmRotated(axis, 0.0), true), null, 16);  // engage
            menu.update(ctx, makePose(palmRotated(axis, 0.5), true), null, 16);  // drag
            const latched = mesh.quaternion.clone();

            // Release (pinch open), then keep moving the hand: the mesh must not follow.
            menu.update(ctx, makePose(palmRotated(axis, 0.5), false), null, 16);
            menu.update(ctx, makePose(palmRotated(axis, 1.4), false), null, 16);

            expect(mesh.quaternion.angleTo(latched)).toBeLessThan(1e-9);
            expect(isNormalized(mesh.quaternion)).toBe(true);
            menu.exit(ctx);
        });

        it("losing the hand (null pose) releases the grab and holds the mesh", () => {
            const mesh = makeMesh();
            const ctx = makeContext(mesh);
            menu.enter(ctx);

            const axis = new THREE.Vector3(0, 0, 1);
            menu.update(ctx, makePose(palmRotated(axis, 0.0), true), null, 16);  // engage
            menu.update(ctx, makePose(palmRotated(axis, 0.4), true), null, 16);  // drag
            const held = mesh.quaternion.clone();

            menu.update(ctx, null, null, 16); // hand lost
            expect(mesh.quaternion.angleTo(held)).toBeLessThan(1e-9);

            // A fresh pinch after re-acquiring re-engages from the current orientation, so the
            // first post-reacquire frame must not jump the mesh.
            menu.update(ctx, makePose(palmRotated(axis, 0.4), true), null, 16);
            expect(mesh.quaternion.angleTo(held)).toBeLessThan(1e-3);
            menu.exit(ctx);
        });
    });

    describe("group rotation — multiple selected shapes orbit the shared centroid", () => {
        // Build a ctx with two selected meshes straddling the origin so the selection centroid is
        // (0,0,0): the engage fingertip (image-center → origin) is then within ENGAGE_RADIUS.
        function makeGroupCtx(a: THREE.Mesh, b: THREE.Mesh): SceneContext {
            const scene = new THREE.Scene();
            const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
            camera.position.set(0, 0, 6);
            camera.lookAt(0, 0, 0);
            camera.updateMatrixWorld(true);
            scene.add(a, b);
            return {
                scene, camera, renderer: {} as THREE.WebGLRenderer,
                mesh: a, bvh: null, extraMeshes: [b], selected: [a, b], focusIndex: 0,
                morphT: 0, stage: "SPHERE", viewMode: "scene", activeMenu: MenuId.ROTATE,
                scratch: makeScratch(), interactionPlaneZ: 0,
            };
        }

        it("rotates the whole selection rigidly about the centroid (spacing + centroid preserved)", () => {
            const a = makeMesh(); a.position.set(-1, 0, 0); a.updateMatrixWorld(true);
            const b = makeMesh(); b.position.set(1, 0, 0); b.updateMatrixWorld(true);
            const ctx = makeGroupCtx(a, b);
            const menu = createRotateMenu();
            menu.enter(ctx);

            const axis = new THREE.Vector3(0, 1, 0);
            menu.update(ctx, makePose(palmRotated(axis, 0.0), true), null, 16); // engage at centroid
            menu.update(ctx, makePose(palmRotated(axis, 0.7), true), null, 16); // sweep about Y

            // Rigid body: the inter-shape distance is unchanged and the centroid stays at origin.
            expect(a.position.distanceTo(b.position)).toBeCloseTo(2, 5);
            const centroid = a.position.clone().add(b.position).multiplyScalar(0.5);
            expect(centroid.length()).toBeLessThan(1e-5);
            // Both shapes actually orbited (moved off their start positions) and spun.
            expect(a.position.distanceTo(new THREE.Vector3(-1, 0, 0))).toBeGreaterThan(1e-2);
            expect(b.position.distanceTo(new THREE.Vector3(1, 0, 0))).toBeGreaterThan(1e-2);
            expect(isNormalized(a.quaternion)).toBe(true);
            expect(isNormalized(b.quaternion)).toBe(true);
            expect(a.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(1e-3);
            menu.exit(ctx);
        });
    });
});
