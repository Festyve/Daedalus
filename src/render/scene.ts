// Rendering scene: camera + lighting + display rig (tilt/spin groups) ported from
// js/scene.js, plus the active sculptable mesh built from the co-generated
// sphere->donut morph geometry (§8). The mesh uses a MeshMatcapMaterial (steel
// matcap, vertexColors for the icing buffer) with a cold Fresnel rim injected via
// onBeforeCompile (§11.3). A CSS3DRenderer layer is set up for the later chat panel.
import * as THREE from "three";
import { CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import type { SceneContext, ScratchMath } from "../types";
import { DEFAULT_CALIBRATION } from "../types";
import { TOKENS } from "./tokens";
import { buildDonutMorphGeometry } from "./geometry";

// Cold fallback matcap (nidorx/matcaps) used if the local steel asset is missing.
const FALLBACK_MATCAP =
    "https://cdn.jsdelivr.net/gh/nidorx/matcaps@master/1024/3E2335_D36A1B_8E4A2E_2B1810.png";

// §11.3 rim strength: how sharply the cold Fresnel edge ramps.
const RIM_POWER = 2.4;

export interface SceneLayers {
    renderer: THREE.WebGLRenderer;
    css3d: CSS3DRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    mesh: THREE.Mesh;
    tilt: THREE.Group;
    spin: THREE.Group;
}

// Load the steel matcap; on error swap in the CDN cold matcap so the mesh still
// renders even before /matcaps/steel-obsidian.png is vendored.
function loadMatcap(): THREE.Texture {
    const loader = new THREE.TextureLoader();
    const tex = loader.load(
        TOKENS.steel,
        undefined,
        undefined,
        () => {
            loader.load(FALLBACK_MATCAP, (fallback) => {
                fallback.colorSpace = THREE.SRGBColorSpace;
                tex.image = fallback.image;
                tex.needsUpdate = true;
            });
        },
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

// Cold rim light via Fresnel: pow(1 - dot(n, viewDir), RIM_POWER) * rimColor,
// added to the matcap's outgoing light. Matcap's fragment shader exposes both
// `normal` and `vViewPosition`, so we derive the view direction from the latter.
function addRim(material: THREE.MeshMatcapMaterial): void {
    const rim_color = new THREE.Color(TOKENS.rim);
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uRimPower = { value: RIM_POWER };
        shader.uniforms.uRimColor = { value: rim_color };
        shader.fragmentShader = shader.fragmentShader.replace(
            "#include <common>",
            `#include <common>
            uniform float uRimPower;
            uniform vec3 uRimColor;`,
        );
        // outgoingLight exists after <aomap_fragment>; vViewPosition points from the
        // fragment toward the camera in view space, so its normalized value is viewDir.
        shader.fragmentShader = shader.fragmentShader.replace(
            "#include <aomap_fragment>",
            `#include <aomap_fragment>
            vec3 rimViewDir = normalize( vViewPosition );
            float rimFresnel = pow( 1.0 - clamp( dot( normal, rimViewDir ), 0.0, 1.0 ), uRimPower );
            outgoingLight += uRimColor * rimFresnel;`,
        );
    };
}

// Build the camera + lighting + display rig (ported from js/scene.js) and the
// active morph mesh, returning the raw layers used to assemble a SceneContext.
function buildLayers(): SceneLayers {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.id = "webgl";
    document.body.appendChild(renderer.domElement);

    // CSS3D layer sits above the WebGL canvas; pointer events pass through so the
    // chat panel can host interactive DOM later without blocking the scene.
    const css3d = new CSS3DRenderer();
    css3d.setSize(innerWidth, innerHeight);
    css3d.domElement.id = "css3d";
    css3d.domElement.style.position = "absolute";
    css3d.domElement.style.top = "0";
    css3d.domElement.style.left = "0";
    css3d.domElement.style.pointerEvents = "none";
    document.body.appendChild(css3d.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
    camera.position.set(0, 0.4, 6.0);
    camera.lookAt(0, 0, 0);

    // Soft studio lighting (matcap ignores lights, but extra spawned meshes may not).
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20242c, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-4, 1, 2);
    scene.add(fill);

    // The active model: the co-generated sphere<->donut morph, steel matcap with the
    // per-vertex icing color buffer enabled and the cold rim.
    const material = new THREE.MeshMatcapMaterial({
        matcap: loadMatcap(),
        vertexColors: true,
    });
    addRim(material);
    const geometry = buildDonutMorphGeometry();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.morphTargetInfluences = [0];

    // Outer group = fixed 3/4 tilt; inner group = optional spin about the hole axis.
    // Both are display-only; sculpt/CSG work in mesh space.
    const tilt = new THREE.Group();
    tilt.rotation.x = -0.5;
    const spin = new THREE.Group();
    tilt.add(spin);
    spin.add(mesh);
    scene.add(tilt);

    addEventListener("resize", () => {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(innerWidth, innerHeight);
        css3d.setSize(innerWidth, innerHeight);
    });

    return { renderer, css3d, scene, camera, mesh, tilt, spin };
}

// Allocate the reused scratch math objects once (§12.2): zero per-frame allocation.
function makeScratch(): ScratchMath {
    return {
        v1: new THREE.Vector3(),
        v2: new THREE.Vector3(),
        v3: new THREE.Vector3(),
        m1: new THREE.Matrix4(),
        q1: new THREE.Quaternion(),
        plane: new THREE.Plane(),
        ray: new THREE.Ray(),
    };
}

// Construct the full SceneContext: the single shared-state channel every module
// reads/writes. Starts at the SPHERE stage with no active menu and an empty BVH.
export function makeContext(): SceneContext {
    const layers = buildLayers();
    return {
        scene: layers.scene,
        camera: layers.camera,
        renderer: layers.renderer,
        css3d: layers.css3d,
        mesh: layers.mesh,
        bvh: null,
        extraMeshes: [],
        calibration: { ...DEFAULT_CALIBRATION },
        morphT: 0,
        stage: "SPHERE",
        activeMenu: null,
        scratch: makeScratch(),
        interactionPlaneZ: 0,
    };
}
