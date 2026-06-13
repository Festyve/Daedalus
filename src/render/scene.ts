// Rendering scene (SPEC §9.2, §9.6). Owns the WebGL2 renderer, the fixed-framing
// camera with a slight idle parallax, the reusable scratch-math pool, and the
// wireframe material. The world starts EMPTY: ctx.mesh / ctx.bvh are null until ADD
// SHAPES calls attachMesh() to build the first sculptable object.
//
// Exports (the v5 contract — callers compile against these exactly):
//   makeContext():SceneContext
//   makeMatcapMaterial():THREE.MeshBasicMaterial
//   attachMesh(ctx, geometry):THREE.Mesh
import * as THREE from "three";
import {
    MeshBVH,
    computeBoundsTree,
    disposeBoundsTree,
    acceleratedRaycast,
} from "three-mesh-bvh";
import type { SceneContext, ScratchMath } from "../types";
import { T } from "./tokens";
import { LAYER } from "./layers";
import { buildDonutMorph } from "./geometry";

// ---- camera framing (§9.6: fixed framing, slight idle parallax) -------------
const CAM_FOV = 45;
const CAM_NEAR = 0.1;
const CAM_FAR = 100;
// Base camera position. The object sits at the origin; the camera reads it from a
// slight 3/4 elevation so the matcap stays consistent.
const CAM_BASE_X = 0;
const CAM_BASE_Y = 0.35;
const CAM_BASE_Z = 5.0;
// Idle parallax: a tiny Lissajous drift around the base position so the frame
// feels alive without the matcap shifting noticeably (§9.6).
const PARALLAX_X = 0.12;
const PARALLAX_Y = 0.07;
const PARALLAX_SPEED_X = 0.00021; // rad/ms
const PARALLAX_SPEED_Y = 0.00033; // rad/ms

// Patch three.js prototypes exactly once so geometry.computeBoundsTree() and
// accelerated raycasting are available. Idempotent and shared with SculptEngine /
// icing (which reuse geometry.boundsTree set here rather than rebuilding).
let PROTOTYPES_PATCHED = false;
function patchPrototypes(): void {
    if (PROTOTYPES_PATCHED) return;
    (THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
    (THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;
    (THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast;
    PROTOTYPES_PATCHED = true;
}

/**
 * Holographic wireframe material for the sculptable mesh (§9.2). A bright cyan
 * (T.cyan) wire mesh, unlit and toneMapped:false so the wire stays at full
 * intensity — the UnrealBloom pass (§9.4) then blooms the bright edges into a
 * glowing JARVIS hologram. vertexColors:true so the per-vertex icing buffer
 * (§8.3) tints the wires.
 */
export function makeMatcapMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
        wireframe: true,
        color: new THREE.Color(T.cyan),
        vertexColors: true,
        toneMapped: false,
    });
}

// Allocate the reused scratch-math pool once (§6.2, §11): zero per-frame
// allocation. Every module borrows these instead of constructing new objects.
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

// Build the WebGL2 renderer (§9.1, §11.1: high-performance power preference) and
// append its canvas to the document.
function makeRenderer(): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.id = "webgl";
    document.body.appendChild(renderer.domElement);
    return renderer;
}

// Fixed-framing camera (§9.6). The idle parallax is driven by startIdleParallax,
// which mutates this camera's pre-allocated position with zero per-frame alloc.
function makeCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(
        CAM_FOV,
        window.innerWidth / window.innerHeight,
        CAM_NEAR,
        CAM_FAR,
    );
    camera.position.set(CAM_BASE_X, CAM_BASE_Y, CAM_BASE_Z);
    camera.lookAt(0, 0, 0);
    return camera;
}

// Slight idle parallax for life (§9.6). Runs on its own rAF so it is independent
// of the main update loop; the camera mostly stays put (small Lissajous drift)
// while always looking at the origin so the matcap reads consistently. Reuses a
// single closure-scoped target — no per-frame allocation.
function startIdleParallax(camera: THREE.PerspectiveCamera): void {
    const t0 = performance.now();
    const tick = (now: number): void => {
        const t = now - t0;
        camera.position.x = CAM_BASE_X + Math.sin(t * PARALLAX_SPEED_X) * PARALLAX_X;
        camera.position.y = CAM_BASE_Y + Math.sin(t * PARALLAX_SPEED_Y) * PARALLAX_Y;
        camera.position.z = CAM_BASE_Z;
        camera.lookAt(0, 0, 0);
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

/**
 * Construct the single shared-state channel every module reads/writes (§3.4).
 * The world starts EMPTY (§5.1): mesh and bvh are null until ADD SHAPES calls
 * attachMesh(). No lights are added — the wireframe material is unlit.
 */
export function makeContext(): SceneContext {
    const renderer = makeRenderer();
    const camera = makeCamera();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(T.bg);

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    startIdleParallax(camera);

    return {
        scene,
        camera,
        renderer,
        mesh: null,
        bvh: null,
        extraMeshes: [],
        morphT: 0,
        stage: "EMPTY",
        viewMode: "scene",
        activeMenu: null,
        scratch: makeScratch(),
        interactionPlaneZ: 0,
    };
}

/**
 * Build the active sculptable mesh from a geometry (icosphere / spawned shape) and
 * wire it into the context (§5.1, §6.1). This is the ONLY path that creates the
 * first mesh — until it runs, ctx.mesh is null and every module no-ops.
 *
 * - Mesh uses the holographic wireframe material (vertexColors for icing).
 * - renderOrder=0, depthTest/Write=true (scene layer; menus stay above via §4.3).
 * - BVH built once and stored on both ctx.bvh and geometry.boundsTree so the
 *   SculptEngine / icing reuse it instead of rebuilding (dirty-region refit only).
 * - morphTargetInfluences array registered ([0] = donut blend, §7.2).
 */
export function attachMesh(ctx: SceneContext, geometry: THREE.BufferGeometry): THREE.Mesh {
    patchPrototypes();

    // Ensure the authored donut morph target exists BEFORE the mesh is built, so the
    // Mesh constructor's updateMorphTargets() seeds morphTargetInfluences from it.
    // attachMesh is the single chokepoint for the active sculpt target, so authoring the
    // morph here means EVERY spawned shape (cube / sphere / tetra) can morph to the donut
    // (§7.1, §7.2) — makeShape() deliberately leaves morph authoring to this layer.
    if (!geometry.morphAttributes.position || geometry.morphAttributes.position.length === 0) {
        buildDonutMorph(geometry);
    }

    const mesh = new THREE.Mesh(geometry, makeMatcapMaterial());
    mesh.renderOrder = LAYER.SCENE;

    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.depthTest = true;
    mat.depthWrite = true;

    // The Mesh constructor seeds morphTargetInfluences from geometry.morphAttributes;
    // guarantee the [0] slot (donut blend, §7.2) exists for setMorphT / the MORPH tool.
    if (!mesh.morphTargetInfluences || mesh.morphTargetInfluences.length === 0) {
        mesh.morphTargetInfluences = [0];
    }

    // Build (or reuse) the BVH and expose it on the geometry so downstream sculpt
    // / icing modules pick it up rather than rebuilding (§6.2 dirty-region only).
    const geo = geometry as unknown as { boundsTree?: MeshBVH; computeBoundsTree: typeof computeBoundsTree };
    let bvh = geo.boundsTree;
    if (!bvh) {
        geo.computeBoundsTree();
        bvh = geo.boundsTree;
    }

    ctx.scene.add(mesh);
    ctx.mesh = mesh;
    ctx.bvh = bvh ?? null;

    return mesh;
}
