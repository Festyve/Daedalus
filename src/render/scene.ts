// Rendering scene (SPEC §9.2, §9.6). Owns the WebGL2 renderer, the fixed-framing
// camera with a slight idle parallax, the reusable scratch-math pool, the scene
// lighting rig, and the solid lit material. The world starts EMPTY: ctx.mesh / ctx.bvh
// are null until ADD SHAPES calls attachMesh() to build the first sculptable object.
//
// Exports (the v5 contract — callers compile against these exactly):
//   makeContext():SceneContext
//   makeMatcapMaterial():THREE.MeshStandardMaterial
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
import { buildTorusMorph } from "./geometry";

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
 * Solid, lit blue-steel material for the sculptable mesh (§9.2, reworked). The mesh is no
 * longer a transparent wireframe hologram: it is a SOLID surface shaded by the scene's
 * artificial lights (makeContext) so it reads as a real 3D object — diffuse falloff on the
 * shaded side, a specular highlight on the lit side, contact AO from the GTAO pass. A faint
 * cyan emissive keeps the dark side readable (and on-brand) without washing the shading out.
 * vertexColors:true is retained so the per-vertex icing buffer (§8.3) and the selection-tier
 * tint (core/shapes.ts) still MULTIPLY through onto the albedo.
 */
export function makeMatcapMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
        color: new THREE.Color(T.cyan).lerp(new THREE.Color(T.white), 0.15),
        vertexColors: true,
        metalness: 0.25,
        roughness: 0.45,
        emissive: new THREE.Color(T.cyan),
        emissiveIntensity: 0.06,
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
 * Artificial lighting so the SOLID meshes read as 3D (§9.2 rework). A three-point-ish rig:
 * a soft cool ambient lifts the shadow side off pure black; a bright warm key from the upper
 * front-right casts the primary diffuse falloff + specular highlight; a cyan rim from
 * behind-left picks out the silhouette against the dark background (the on-brand JARVIS edge
 * glow, now from real lighting rather than a wire); a dim cool fill softens the key's shadow.
 * Lights are static — no per-frame cost, zero allocation in the hot loop (§6.2, §11).
 */
function addLights(scene: THREE.Scene): void {
    const ambient = new THREE.AmbientLight(0x8092a6, 0.55);
    const key = new THREE.DirectionalLight(0xfff1de, 2.2);
    key.position.set(4, 6, 5);
    const rim = new THREE.DirectionalLight(T.cyan, 1.1);
    rim.position.set(-5, 2, -4);
    const fill = new THREE.DirectionalLight(0x6fa8ff, 0.5);
    fill.position.set(-4, -1, 3);
    scene.add(ambient, key, rim, fill);
}

/**
 * Construct the single shared-state channel every module reads/writes (§3.4).
 * The world starts EMPTY (§5.1): mesh and bvh are null until ADD SHAPES calls
 * attachMesh(). The scene is lit by addLights() so the solid meshes shade in 3D.
 */
export function makeContext(): SceneContext {
    const renderer = makeRenderer();
    const camera = makeCamera();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(T.bg);
    addLights(scene);

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
        selected: [],
        focusIndex: 0,
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
 * - Mesh uses the solid lit blue-steel material (vertexColors for icing).
 * - renderOrder=0, depthTest/Write=true (scene layer; menus stay above via §4.3).
 * - BVH built once and stored on both ctx.bvh and geometry.boundsTree so the
 *   SculptEngine / icing reuse it instead of rebuilding (dirty-region refit only).
 * - morphTargetInfluences array registered ([0] = torus blend, §7.2).
 */
export function attachMesh(ctx: SceneContext, geometry: THREE.BufferGeometry): THREE.Mesh {
    patchPrototypes();

    // Ensure the authored torus morph target exists BEFORE the mesh is built, so the
    // Mesh constructor's updateMorphTargets() seeds morphTargetInfluences from it.
    // attachMesh is the single chokepoint for the active sculpt target, so authoring the
    // morph here means EVERY spawned shape (cube / sphere / cylinder) can morph to
    // the torus (§7.1, §7.2) — makeShape() deliberately leaves morph authoring to this layer.
    if (!geometry.morphAttributes.position || geometry.morphAttributes.position.length === 0) {
        buildTorusMorph(geometry);
    }

    const mesh = new THREE.Mesh(geometry, makeMatcapMaterial());
    mesh.renderOrder = LAYER.SCENE;

    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.depthTest = true;
    mat.depthWrite = true;

    // The Mesh constructor seeds morphTargetInfluences from geometry.morphAttributes;
    // guarantee the [0] slot (torus blend, §7.2) exists for setMorphT / the MORPH tool.
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
