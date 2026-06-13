// Rendering scene (SPEC §9.2, §9.6). Owns the WebGL2 renderer, the fixed-framing
// camera with a slight idle parallax, the reusable scratch-math pool, and the
// matcap material. The world starts EMPTY: ctx.mesh / ctx.bvh are null until ADD
// SHAPES calls attachMesh() to build the first sculptable object.
//
// Exports (the v5 contract — callers compile against these exactly):
//   makeContext():SceneContext
//   makeMatcapMaterial():THREE.MeshMatcapMaterial
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
const CAM_BASE_Y = 2.4;
const CAM_BASE_Z = 4.4;
// Idle parallax: a tiny Lissajous drift around the base position so the frame
// feels alive without the matcap shifting noticeably (§9.6).
const PARALLAX_X = 0.12;
const PARALLAX_Y = 0.07;
const PARALLAX_SPEED_X = 0.00021; // rad/ms
const PARALLAX_SPEED_Y = 0.00033; // rad/ms

// ---- matcap (§9.2: blue-steel luminous matcap) ------------------------------
const MATCAP_URL = "/matcaps/blue-steel.png";
const MATCAP_FALLBACK_SIZE = 256;
// §9.3 cold Fresnel rim — cyan (T.rimColor), not white. Higher power = tighter edge.
// Tighter power keeps the glow on the true silhouette; intensity pushes the cyan
// edge above the UnrealBloom threshold (§9.4) so it reads as a luminous JARVIS rim.
const RIM_POWER = 3.0;
const RIM_INTENSITY = 1.35;
// Glassy-jam sheen (aspect #59). Where the surface is iced (vertex color strongly
// red), the blue-steel matcap is dark over most of the surface, so a plain multiply
// reads as dark maroon. We (a) lift the iced regions with a partial EMISSIVE jam
// glow so the red is luminous regardless of matcap darkness, and (b) add a white
// specular highlight from the matcap's key light so the jam reads WET / glassy.
// Bare steel (vColor ~white) is untouched.
const GLOSS_STRENGTH = 1.1;
const GLOSS_POWER = 3.0;
const JAM_EMISSIVE = 0.55;

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
 * Procedural blue-steel gradient matcap (§9.2), generated as a DataTexture so the
 * build runs fully offline when /matcaps/blue-steel.png is absent. A matcap encodes
 * the lit sphere in screen space: the disc centre faces the camera (bright cold
 * steel), the rim faces away (dark blue silhouette). Outside the disc is the dark
 * background. A cool key highlight sits upper-left for the brushed-steel sheen.
 */
function generateBlueSteelMatcap(size: number = MATCAP_FALLBACK_SIZE): THREE.DataTexture {
    const data = new Uint8Array(size * size * 4);
    const r = size / 2;

    // Cold blue-steel ramp, centre (camera-facing) → silhouette.
    const centre = [0x7a, 0x9a, 0xc4]; // luminous steel-blue
    const mid    = [0x33, 0x4a, 0x66];
    const edge   = [0x0a, 0x12, 0x22]; // near-black blue silhouette
    const bg     = [0x04, 0x06, 0x0e]; // outside the lit disc (matches T.bg tone)
    // Cool key highlight, offset upper-left.
    const hiX = size * 0.34;
    const hiY = size * 0.30;
    const hiR = size * 0.42;

    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const ramp = (a: number[], b: number[], t: number, ch: number): number => lerp(a[ch], b[ch], t);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const dx = x - r;
            const dy = y - r;
            const dist = Math.hypot(dx, dy) / r; // 0 centre → 1 rim of disc

            let cr: number, cg: number, cb: number;
            if (dist >= 1) {
                cr = bg[0]; cg = bg[1]; cb = bg[2];
            } else {
                // Two-segment ramp: centre→mid (inner 55%), mid→edge (outer).
                if (dist < 0.55) {
                    const t = dist / 0.55;
                    cr = ramp(centre, mid, t, 0);
                    cg = ramp(centre, mid, t, 1);
                    cb = ramp(centre, mid, t, 2);
                } else {
                    const t = (dist - 0.55) / 0.45;
                    cr = ramp(mid, edge, t, 0);
                    cg = ramp(mid, edge, t, 1);
                    cb = ramp(mid, edge, t, 2);
                }
                // Additive cool highlight (brushed-steel sheen), additive + clamped.
                const hd = Math.hypot(x - hiX, y - hiY) / hiR;
                if (hd < 1) {
                    const k = (1 - hd) * (1 - hd) * 150;
                    cr = Math.min(255, cr + k * 0.92);
                    cg = Math.min(255, cg + k * 0.98);
                    cb = Math.min(255, cb + k);
                }
            }

            data[i] = cr;
            data[i + 1] = cg;
            data[i + 2] = cb;
            data[i + 3] = 255;
        }
    }

    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Inject the cold cyan Fresnel rim into the matcap shader (§9.3):
 *   outgoingLight += uRimColor * uRimIntensity * pow(1 - dot(n, viewDir), uRimPower)
 * The matcap fragment shader exposes `normal` and `vViewPosition`; vViewPosition
 * points from the fragment toward the camera in view space, so its normalized
 * value is the view direction. Uniforms are allocated once at compile time.
 * uRimIntensity drives the cyan edge above the bloom threshold (§9.4) so the
 * silhouette glows like a JARVIS hologram rather than a flat outline.
 */
function injectRim(material: THREE.MeshMatcapMaterial): void {
    const rim_color = new THREE.Color(T.rimColor);
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uRimPower = { value: RIM_POWER };
        shader.uniforms.uRimColor = { value: rim_color };
        shader.uniforms.uRimIntensity = { value: RIM_INTENSITY };
        shader.uniforms.uGlossStrength = { value: GLOSS_STRENGTH };
        shader.uniforms.uGlossPower = { value: GLOSS_POWER };
        shader.uniforms.uJamEmissive = { value: JAM_EMISSIVE };
        shader.fragmentShader = shader.fragmentShader
            .replace(
                "#include <common>",
                `#include <common>
                uniform float uRimPower;
                uniform vec3 uRimColor;
                uniform float uRimIntensity;
                uniform float uGlossStrength;
                uniform float uGlossPower;
                uniform float uJamEmissive;`,
            )
            .replace(
                "#include <aomap_fragment>",
                `#include <aomap_fragment>
                vec3 rimViewDir = normalize( vViewPosition );
                float rimFresnel = pow( 1.0 - clamp( dot( normal, rimViewDir ), 0.0, 1.0 ), uRimPower );
                outgoingLight += uRimColor * ( rimFresnel * uRimIntensity );
                // Glassy jam: iced surfaces (vertex color strongly red, r dominating
                // g/b) get a tight white specular sheen from the matcap's own key
                // highlight so the jam reads wet. Bare steel (vColor ~white) → ~0.
                float icedAmt = clamp( ( vColor.r - max( vColor.g, vColor.b ) ) * 2.0, 0.0, 1.0 );
                // Emissive jam lift: make the iced red self-luminous so it pops over the
                // dark steel (multiply alone reads as dark maroon).
                outgoingLight += vColor * ( icedAmt * uJamEmissive );
                // Wet glassy highlight from the matcap key light, on iced regions only.
                float matcapLuma = dot( matcapColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
                float wetSpec = pow( matcapLuma, uGlossPower ) * icedAmt * uGlossStrength;
                outgoingLight += vec3( wetSpec );`,
            );
    };
}

/**
 * Blue-steel matcap material for the sculptable mesh (§9.2). Starts on the
 * procedural fallback (always valid, offline-safe), then upgrades in place to the
 * vendored /matcaps/blue-steel.png if it loads and decodes to a real image. Any
 * network/asset failure simply keeps the procedural matcap. vertexColors:true so
 * the per-vertex icing buffer (§8.3) overlays the steel.
 */
export function makeMatcapMaterial(): THREE.MeshMatcapMaterial {
    const matcap = generateBlueSteelMatcap();
    const material = new THREE.MeshMatcapMaterial({ matcap, vertexColors: true });
    injectRim(material);

    new THREE.TextureLoader().load(
        MATCAP_URL,
        (real) => {
            if (!real.image || real.image.width <= 1) return;
            real.colorSpace = THREE.SRGBColorSpace;
            material.matcap = real;
            material.needsUpdate = true;
            matcap.dispose(); // procedural fallback no longer referenced
        },
        undefined,
        () => { /* keep the procedural matcap — offline-safe */ },
    );

    return material;
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
 * attachMesh(). No lights are added — MeshMatcapMaterial is unlit.
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
 * - Mesh uses the blue-steel matcap (vertexColors for icing).
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

    const mat = mesh.material as THREE.MeshMatcapMaterial;
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
