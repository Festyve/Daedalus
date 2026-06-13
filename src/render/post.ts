// Post-processing pipeline (SPEC §9.4): RenderPass -> GTAOPass (subtle contact AO) ->
// UnrealBloomPass (high threshold so only glowing affordances bloom) -> OutputPass
// (tone map + color space) -> vignette ShaderPass (darken-the-corners). The composer
// is resized alongside the renderer; setBloom() lets the app dial glow up/down (e.g.
// pulse on a proximity affordance) without rebuilding the pipeline.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

// Bloom tuning: high threshold so the matte steel body stays dark and only bright
// rim / affordance pixels (luminance > BLOOM_THRESHOLD) glow.
const BLOOM_STRENGTH = 0.9;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.7;

// Subtle ground-truth ambient occlusion: small radius so creases darken without
// washing the silhouette.
const GTAO_RADIUS = 0.25;

// Darken-the-corners vignette applied to the already tone-mapped image. Kept gentle
// so it frames the scene without crushing the periphery.
const VIGNETTE_OFFSET = 1.05;
const VIGNETTE_DARKNESS = 1.1;

const VIGNETTE_SHADER = {
    uniforms: {
        tDiffuse: { value: null as THREE.Texture | null },
        uOffset: { value: VIGNETTE_OFFSET },
        uDarkness: { value: VIGNETTE_DARKNESS },
    },
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
    `,
    fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uOffset;
        uniform float uDarkness;
        void main() {
            vec4 texel = texture2D( tDiffuse, vUv );
            vec2 uv = ( vUv - 0.5 ) * 2.0;
            float vignette = clamp( pow( 1.0 - dot( uv, uv ) * 0.25, uDarkness * uOffset ), 0.0, 1.0 );
            gl_FragColor = vec4( texel.rgb * vignette, texel.a );
        }
    `,
};

// Build the composer for the given scene/camera/renderer. Returns the composer plus:
//   resize(w, h)        — keep every pass in sync with the canvas.
//   setBloom(strength)  — set UnrealBloomPass strength (0 = off) for glow pulses.
export function makeComposer(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
): { composer: EffectComposer; resize: (w: number, h: number) => void; setBloom: (strength: number) => void } {
    const width = innerWidth;
    const height = innerHeight;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));

    const gtao_pass = new GTAOPass(scene, camera, width, height);
    // OUTPUT.Default composites AO into the rendered scene; OUTPUT.Denoise (etc.) emit
    // the raw AO buffer as a debug visualization, which floods the screen flat gray.
    gtao_pass.output = GTAOPass.OUTPUT.Default;
    gtao_pass.updateGtaoMaterial({ radius: GTAO_RADIUS });
    composer.addPass(gtao_pass);

    const bloom_pass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
    );
    composer.addPass(bloom_pass);

    // Tone map + convert to the renderer's output color space. Must precede the
    // vignette so corner darkening happens in display space, not linear HDR.
    composer.addPass(new OutputPass());

    const vignette_pass = new ShaderPass(VIGNETTE_SHADER);
    composer.addPass(vignette_pass);

    const resize = (w: number, h: number): void => {
        // composer.setSize cascades to each pass (RenderPass, GTAOPass, OutputPass,
        // ShaderPass); UnrealBloomPass tracks its own mip chain via resolution.
        composer.setSize(w, h);
        bloom_pass.resolution.set(w, h);
    };

    const setBloom = (strength: number): void => {
        bloom_pass.strength = strength;
    };

    addEventListener("resize", () => resize(innerWidth, innerHeight));

    return { composer, resize, setBloom };
}
