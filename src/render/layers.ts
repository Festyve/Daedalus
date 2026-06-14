// Render layer order — HARD RULE (SPEC §4.3). Menu/HUD geometry always renders above
// the mesh regardless of depth: renderOrder=1, depthTest=false, depthWrite=false.
import * as THREE from "three";

export const LAYER = {
    SCENE: 0, // meshes: depthTest=true, depthWrite=true, renderOrder=0
    MENU: 1,  // carousel / affordances / arcball / bbox: above mesh always
} as const;

/** Apply Layer-1 menu rules to an object and all descendants (§4.3). Call on every
 *  carousel / affordance / arcball / bbox object before adding it to the scene. */
export function asMenuLayer(obj: THREE.Object3D): void {
    obj.traverse((o) => {
        o.renderOrder = LAYER.MENU;
        // Put menu geometry on three.js camera-layer 1 so the corner-preview pass can
        // exclude it (main camera enables both layers; the preview disables MENU) — the
        // preview then shows only the sculpted objects, no carousel / affordance gizmos.
        o.layers.set(LAYER.MENU);
        const mesh = o as THREE.Mesh;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        const apply = (m: THREE.Material) => {
            m.depthTest = false;
            m.depthWrite = false;
            m.transparent = true;
        };
        if (Array.isArray(mat)) mat.forEach(apply);
        else apply(mat);
    });
}
