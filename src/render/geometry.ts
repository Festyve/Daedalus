// Sculpt geometry factory (SPEC §6.1 baseline, §7.1 authored morph).
//
// Produces the single sculptable primitive Daedalus deforms: a high-resolution
// indexed icosphere with position/normal/color attributes, ready for
// `geometry.computeBoundsTree()` (three-mesh-bvh) and incremental dirty-region
// refit. The donut morph target is built by warping the icosphere's OWN vertices
// onto a torus — so the morph attribute shares vertex count AND ordering with the
// base by construction (§7.1), which is what `morphTargetInfluences[0]` requires.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Default subdivision. NOTE: three r160's PolyhedronGeometry subdivides each of
// the 20 icosahedron faces by LINEAR edge splitting, so detail=d yields
// 20·(d+1)² triangles — NOT the recursive 20·4^d. To hit the SPEC §6.1 target of
// "~40k triangles" we therefore need d≈44:
//   detail 44 → 40500 tris / 20387 verts (this default)
//   detail 45 → 42320 tris / 21309 verts
// 20387 verts stays < 65536, so mergeVertices keeps a Uint16 index — matching the
// SculptEngine's Uint16Array|Uint32Array expectation. (The plan card's "detail
// ~5-6" hint assumed the 4^d formula, under which 5-6 reached tens of thousands;
// it does not in r160, so we honor the triangle-count requirement instead.)
const DEFAULT_DETAIL = 44;
const DEFAULT_RADIUS = 1.0;

// Low-poly subdivision for SPAWNED shapes (§9.2 minimal wireframe look). Kept far below
// makeIcosphere's DEFAULT_DETAIL so the wireframe reads as a clean triangulated mesh
// rather than a dense blob. Sphere detail 12 → 20·13² = 3380 tris; cube 6 seg/side →
// 6·2·6² = 432 tris; tetra detail 3 → 4·4² = 64 tris. (makeIcosphere is left untouched so
// the existing unit tests that build their own spheres keep their vertex counts.)
const SHAPE_SPHERE_DETAIL = 12;
const SHAPE_CUBE_SEGMENTS = 6;
const SHAPE_TETRA_DETAIL = 3;

// Donut morph defaults (SPEC §7.1).
const DONUT_R = 1.0;   // major radius (ring center → tube center)
const DONUT_r = 0.42;  // minor radius (tube)

/**
 * High-res indexed icosphere with position/normal/color attributes (§6.1).
 *
 * IcosahedronGeometry emits an unindexed (flat-shaded) buffer; `mergeVertices`
 * welds coincident vertices into a shared indexed buffer so the BVH and Taubin
 * adjacency see a watertight mesh. A white per-vertex color attribute is added
 * up front so the matcap material (vertexColors:true) and later icing writes have
 * a buffer to target.
 */
export function makeIcosphere(radius: number = DEFAULT_RADIUS, detail: number = DEFAULT_DETAIL): THREE.BufferGeometry {
    const raw = new THREE.IcosahedronGeometry(radius, detail);
    // Weld duplicated seam vertices → indexed geometry with shared vertices.
    const geo = mergeVertices(raw);
    raw.dispose();

    geo.computeVertexNormals();

    const vertex_count = geo.attributes.position.count;
    const color = new Float32Array(vertex_count * 3).fill(1); // white icing base
    const color_attr = new THREE.BufferAttribute(color, 3);
    color_attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", color_attr);

    // These attributes are mutated in place every frame (sculpt loop rewrites
    // position/normal arrays, icing rewrites color spans), so hint DYNAMIC_DRAW
    // for repeated re-upload instead of the default STATIC_DRAW.
    (geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (geo.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);

    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
}

/**
 * Build the authored donut (torus) morph target by warping the icosphere's own
 * vertices (§7.1). The result is stored at `geo.morphAttributes.position[0]` and
 * shares vertex count + ordering with the base — required for a clean blend.
 *
 * Per-vertex sphere→torus map (hole axis = Y):
 *   ring angle  θ = atan2(z, x)          — longitude around the hole
 *   tube angle  φ = π·(1 − y/|p|)        — latitude → wraps the tube once
 *       (north pole y=+1 → φ=0 outer equator of tube; south pole → φ=2π)
 *   target:  x = (R + r·cos φ)·cos θ
 *            y =        r·sin φ
 *            z = (R + r·cos φ)·sin θ
 * Degenerate poles (x=z=0) fall back to θ=0 so atan2 is well-defined.
 *
 * Morph normals are computed from a throwaway geometry sharing the base index so
 * the blended surface shades correctly mid-morph.
 */
export function buildDonutMorph(geo: THREE.BufferGeometry, R: number = DONUT_R, r: number = DONUT_r): void {
    const base = geo.attributes.position as THREE.BufferAttribute;
    const n = base.count;
    const torus = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
        const x = base.getX(i);
        const y = base.getY(i);
        const z = base.getZ(i);

        const len = Math.hypot(x, y, z) || 1;
        // Longitude around the Y hole axis. Poles collapse to θ=0.
        const theta = (x === 0 && z === 0) ? 0 : Math.atan2(z, x);
        // Latitude → tube angle: north pole maps to outer tube edge, sweeping
        // once around the tube down to the south pole.
        const phi = Math.PI * (1 - y / len);

        const ring = R + r * Math.cos(phi);
        torus[i * 3]     = ring * Math.cos(theta);
        torus[i * 3 + 1] = r * Math.sin(phi);
        torus[i * 3 + 2] = ring * Math.sin(theta);
    }

    const torus_attr = new THREE.BufferAttribute(torus, 3);

    // Derive correct morph normals from a temp geometry with the same topology.
    const tmp = new THREE.BufferGeometry();
    tmp.setAttribute("position", torus_attr);
    if (geo.index) tmp.setIndex(geo.index);
    tmp.computeVertexNormals();
    const torus_normals = (tmp.attributes.normal as THREE.BufferAttribute).clone();
    tmp.dispose();

    geo.morphAttributes.position = [torus_attr];
    geo.morphAttributes.normal = [torus_normals];
}

/**
 * Primitive shapes for the ADD SHAPES tool (§5.1). Each is welded to an indexed
 * geometry with normals and a white color attribute, matching the icosphere's
 * attribute layout so any spawned shape is immediately sculptable / BVH-ready.
 */
export function makeShape(kind: "cube" | "sphere" | "tetra"): THREE.BufferGeometry {
    let raw: THREE.BufferGeometry;
    switch (kind) {
        case "cube":
            raw = new THREE.BoxGeometry(1.4, 1.4, 1.4, SHAPE_CUBE_SEGMENTS, SHAPE_CUBE_SEGMENTS, SHAPE_CUBE_SEGMENTS);
            break;
        case "sphere":
            raw = new THREE.IcosahedronGeometry(DEFAULT_RADIUS, SHAPE_SPHERE_DETAIL);
            break;
        case "tetra":
            raw = new THREE.TetrahedronGeometry(1.2, SHAPE_TETRA_DETAIL);
            break;
    }

    const geo = mergeVertices(raw);
    raw.dispose();

    geo.computeVertexNormals();

    const vertex_count = geo.attributes.position.count;
    const color_attr = new THREE.BufferAttribute(new Float32Array(vertex_count * 3).fill(1), 3);
    color_attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("color", color_attr);

    // These attributes are mutated in place every frame (sculpt loop rewrites
    // position/normal arrays, icing rewrites color spans), so hint DYNAMIC_DRAW
    // for repeated re-upload instead of the default STATIC_DRAW.
    (geo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (geo.attributes.normal as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);

    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
}
