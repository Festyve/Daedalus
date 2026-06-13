// Optional CSG bites for the "Eat It" finale (SPEC §10.3).
//
// Subtracts a small sphere from the active mesh geometry at the bite origin so
// the donut visibly loses chunks before the dissolve shader takes over — for
// tactile credibility. three-bvh-csg is experimental, so this is GUARDED: per
// the §18 risk register ("three-bvh-csg artifacts → cut booleans; dissolve-only
// finale"), set BITES_ENABLED = false to skip every bite and fall back to a
// dissolve-only finale. The caller (the destroy module) imports biteAt and is
// expected to no-op gracefully when bites are skipped.
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { Brush, Evaluator, SUBTRACTION } from "three-bvh-csg";
import type { SceneContext } from "../types";

// §18 risk fallback: bites are OFF — the donut is a blend-shape morph carrying a
// vertex `color` (icing) attribute and no `uv`, while the cutter sphere has `uv` and
// no `color`; three-bvh-csg requires matching attribute sets across brushes, so the
// boolean throws. Per §18 ("three-bvh-csg artifacts → cut booleans; dissolve-only
// finale") biteAt is an immediate no-op and the finale dissolves only — which already
// consumes the morphed donut correctly in-shader. Flip to true only with a manifold,
// attribute-matched geometry.
const BITES_ENABLED = false;

// At most 2–3 bites (§10.3); further calls are ignored so a held fist can't grind
// the whole donut away through CSG.
const MAX_BITES = 3;

// Cutter sphere radius as a fraction of the requested bite radius. The bite reads
// a little smaller than the brush so successive bites stay distinct, not merged.
const CUTTER_FRAC = 0.85;

// Reused across bites — a single Evaluator pools geometry buffers internally and
// must outlive individual calls (§7 zero-per-call-alloc spirit).
const EVALUATOR = new Evaluator();
EVALUATOR.useGroups = false; // single material → simpler, transform-free result

let biteCount = 0;

// Subtract a small sphere from ctx.mesh.geometry centered at worldOrigin.
//
// worldOrigin is in WORLD space (the right-hand fingertip); the mesh lives inside
// rotated spin/tilt groups, so we convert it into the mesh's OBJECT space before
// positioning the cutter — the boolean operates on the mesh's own geometry, whose
// frame is local. The resulting geometry replaces ctx.mesh.geometry (welded +
// normals recomputed, matching the js/modeling.js bore() pattern). The mesh's BVH
// (if any) is invalidated; rebuilding it is the caller's concern (the dissolve
// finale does not sculpt, so it is left null here).
//
// Returns true if a bite was applied, false if skipped (disabled, over the cap,
// or the operation produced empty geometry).
export function biteAt(ctx: SceneContext, worldOrigin: THREE.Vector3, radius: number): boolean {
    if (!BITES_ENABLED) return false;
    if (biteCount >= MAX_BITES) return false;
    if (radius <= 0) return false;

    const mesh = ctx.mesh;

    // Convert the world bite point into the mesh's local frame. Use scratch.v1 so
    // we never mutate the caller's vector and avoid a per-call allocation.
    mesh.updateWorldMatrix(true, false);
    const localOrigin = ctx.scratch.v1.copy(worldOrigin);
    mesh.worldToLocal(localOrigin);

    // Base brush: the current geometry, identity transform (already local space).
    const base = new Brush(mesh.geometry);
    base.updateMatrixWorld();

    // Cutter: a small sphere positioned at the local bite point.
    const cutterGeom = new THREE.SphereGeometry(radius * CUTTER_FRAC, 24, 16);
    const cutter = new Brush(cutterGeom);
    cutter.position.copy(localOrigin);
    cutter.updateMatrixWorld();

    const result = EVALUATOR.evaluate(base, cutter, SUBTRACTION);

    // Weld coincident verts so the result is clean, then recompute normals. Drop
    // normal/uv first so the seam welds by position (same as bore()).
    let geom = result.geometry;
    if (geom.getAttribute("position").count === 0) {
        // Degenerate boolean (e.g. cutter missed the surface) — discard and keep
        // the existing geometry untouched.
        geom.dispose();
        cutterGeom.dispose();
        return false;
    }
    geom.deleteAttribute("normal");
    geom.deleteAttribute("uv");
    geom = mergeVertices(geom);
    geom.computeVertexNormals();

    const oldGeom = mesh.geometry;
    mesh.geometry = geom;
    oldGeom.dispose();
    cutterGeom.dispose();

    // The sculpt BVH (if present) described the old geometry; it is now stale.
    ctx.bvh = null;

    biteCount++;
    // §10.4 ("crunch SFX on each bite") is the caller's responsibility: it owns
    // the Sfx instance and plays "crunch" when biteAt returns true. We do not
    // construct a second AudioContext here.
    return true;
}

// Reset the bite cap so a fresh finale (e.g. after a director restart) can bite
// again. Call before re-running the eat sequence.
export function resetBites(): void {
    biteCount = 0;
}
