// Post-processing pipeline (SPEC §9.4 — minimal). RenderPass -> OutputPass (tone map +
// output color space) only. The heavy "hard shader" passes — GTAOPass, UnrealBloomPass,
// and the vignette ShaderPass — were removed for the minimal wireframe look: nothing in
// the scene relies on bloom anymore (the matcap rim glow is gone). RenderPass still
// composites the AR webcam background plane (§9.5) when that mode is active, and OutputPass
// keeps color correct.
//
// makeComposer keeps its { composer, resize, setBloom } shape so existing callers compile
// unchanged; setBloom is now a no-op because there is no bloom pass to drive.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// Build the composer for the given scene/camera/renderer. Returns the composer plus:
//   resize(w, h)        — keep the composer in sync with the canvas.
//   setBloom(strength)  — no-op (kept for call-site compatibility; no bloom pass).
export function makeComposer(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
): { composer: EffectComposer; resize: (w: number, h: number) => void; setBloom: (strength: number) => void } {
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // Tone map + convert to the renderer's output color space.
    composer.addPass(new OutputPass());

    const resize = (w: number, h: number): void => {
        composer.setSize(w, h);
    };

    // No bloom pass in the minimal pipeline; kept as a no-op so callers still compile.
    const setBloom = (_strength: number): void => {};

    addEventListener("resize", () => resize(innerWidth, innerHeight));

    return { composer, resize, setBloom };
}
