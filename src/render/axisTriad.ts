// Reusable X/Y/Z axis triad — three colored arrows (shaft + cone tip) along +X, +Y, +Z.
//
// Used twice in Camera Orbit Mode: as the large gizmo pinned at the scene center while
// orbiting, and as the small ViewCube-style indicator inside the top-right mini viewport.
// Colors follow the canonical gizmo convention (X red, Y green, Z blue) — the same palette
// the ROTATE arcball uses — so axis identity reads consistently across the app.
//
// Built once; setOpacity() fades every material together (orbit-mode show/hide) and toggles
// the group's visibility so a fully-faded triad costs nothing to draw. MeshBasicMaterial with
// toneMapped:false keeps the colors crisp and unaffected by the scene lighting / bloom.
import * as THREE from "three";

// Canonical gizmo axis colors (match ROTATE's arcball rings).
const AXIS_COLOR_X = 0xff4d4d;
const AXIS_COLOR_Y = 0x4dff7a;
const AXIS_COLOR_Z = 0x4d8cff;

// Arrow proportions as fractions of the overall axis length.
const SHAFT_FRAC = 0.8;   // shaft spans 0 .. 0.8·length
const TIP_FRAC = 0.2;     // cone tip spans the remaining 0.2·length
const TIP_RADIUS_MULT = 2.2; // cone base radius relative to shaft radius

export interface AxisTriad {
    group: THREE.Group;
    /** Fade all three arrows together (0 = hidden, hides the group; 1 = full). */
    setOpacity(alpha: number): void;
    /** Release all geometries + materials. */
    dispose(): void;
}

// Build one arrow pointing +Y (shaft from origin, cone on top), then the caller rotates it
// onto the target axis. Returns the arrow group plus its two materials for fading.
function makeArrow(
    color: number,
    length: number,
    thickness: number,
    materials: THREE.MeshBasicMaterial[],
    geometries: THREE.BufferGeometry[],
): THREE.Group {
    const shaft_len = length * SHAFT_FRAC;
    const tip_len = length * TIP_FRAC;

    const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        toneMapped: false,
    });
    materials.push(mat);

    const shaft_geo = new THREE.CylinderGeometry(thickness, thickness, shaft_len, 8);
    const cone_geo = new THREE.ConeGeometry(thickness * TIP_RADIUS_MULT, tip_len, 12);
    geometries.push(shaft_geo, cone_geo);

    const shaft = new THREE.Mesh(shaft_geo, mat);
    shaft.position.y = shaft_len * 0.5;
    const tip = new THREE.Mesh(cone_geo, mat);
    tip.position.y = shaft_len + tip_len * 0.5;

    const arrow = new THREE.Group();
    arrow.add(shaft, tip);
    return arrow;
}

/**
 * Construct an X/Y/Z arrow triad of the given axis length and shaft thickness. The triad sits
 * at its group origin; the caller positions / parents it. Arrows start fully transparent —
 * call setOpacity() to reveal.
 */
export function makeAxisTriad(length: number, thickness: number): AxisTriad {
    const group = new THREE.Group();
    const materials: THREE.MeshBasicMaterial[] = [];
    const geometries: THREE.BufferGeometry[] = [];

    // +Y arrow stays as built; +X is the +Y arrow rotated −90° about Z; +Z is +90° about X.
    const arrow_x = makeArrow(AXIS_COLOR_X, length, thickness, materials, geometries);
    arrow_x.rotation.z = -Math.PI / 2;
    const arrow_y = makeArrow(AXIS_COLOR_Y, length, thickness, materials, geometries);
    const arrow_z = makeArrow(AXIS_COLOR_Z, length, thickness, materials, geometries);
    arrow_z.rotation.x = Math.PI / 2;

    group.add(arrow_x, arrow_y, arrow_z);
    group.visible = false;

    return {
        group,
        setOpacity(alpha: number): void {
            const a = Math.max(0, Math.min(1, alpha));
            for (const m of materials) m.opacity = a;
            group.visible = a > 0.001;
        },
        dispose(): void {
            for (const g of geometries) g.dispose();
            for (const m of materials) m.dispose();
        },
    };
}
