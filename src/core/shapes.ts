// Multi-shape registry + selection helpers, layered on SceneContext (§5.1 extended).
//
// The world can now hold several sculptable shapes at once. We keep the existing
// single-active-mesh contract intact so every edit tool (TRANSLATE / DILATE / ROTATE /
// MORPH / DECORATE) keeps operating on `ctx.mesh` with NO change:
//
//   ctx.mesh        = the SELECTED shape (what the edit tools act on)
//   ctx.extraMeshes = every OTHER shape currently in the scene
//   allShapes(ctx)  = [ctx.mesh, ...extraMeshes]  (the full set)
//
// The selected shape is drawn at full intensity; the others are dimmed so the active
// selection always reads clearly. SELECT cycles the selection, ADD SHAPES appends,
// DESTROY removes, and INTERACT (CSG) fuses two shapes into one.
import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import type { SceneContext } from "../types";

// Selected = full opacity; unselected shapes are ghosted so the active one stands out.
const SELECTED_OPACITY = 1.0;
const UNSELECTED_OPACITY = 0.3;

// Read the boundsTree (BVH) three-mesh-bvh stashed on a geometry, if present.
function bvhOf(mesh: THREE.Mesh): MeshBVH | null {
    return (mesh.geometry as unknown as { boundsTree?: MeshBVH }).boundsTree ?? null;
}

/** The full set of shapes in the scene: the selected one first, then the rest. */
export function allShapes(ctx: SceneContext): THREE.Mesh[] {
    return ctx.mesh ? [ctx.mesh, ...ctx.extraMeshes] : [...ctx.extraMeshes];
}

/** How many shapes exist in total. */
export function shapeCount(ctx: SceneContext): number {
    return (ctx.mesh ? 1 : 0) + ctx.extraMeshes.length;
}

/**
 * Re-apply the selection highlight: the selected shape (ctx.mesh) is full-opacity and
 * writes depth; the others are ghosted (dim, no depth-write) so they read as background
 * shapes behind the active one. Cheap material-flag writes only — safe every frame.
 */
export function refreshHighlight(ctx: SceneContext): void {
    for (const m of allShapes(ctx)) {
        const mat = m.material as THREE.MeshBasicMaterial;
        const selected = m === ctx.mesh;
        mat.transparent = true;
        mat.opacity = selected ? SELECTED_OPACITY : UNSELECTED_OPACITY;
        mat.depthWrite = selected;
    }
}

/**
 * Make `mesh` the selected shape: it becomes ctx.mesh and the previously-selected mesh
 * (if any, and different) moves into extraMeshes. ctx.bvh is repointed at the new
 * selection's boundsTree so tools that read ctx.bvh pick up the right one.
 */
export function selectMesh(ctx: SceneContext, mesh: THREE.Mesh): void {
    if (ctx.mesh !== mesh) {
        const i = ctx.extraMeshes.indexOf(mesh);
        if (i >= 0) ctx.extraMeshes.splice(i, 1);
        if (ctx.mesh) ctx.extraMeshes.push(ctx.mesh);
        ctx.mesh = mesh;
        ctx.bvh = bvhOf(mesh);
    }
    refreshHighlight(ctx);
}

/** Cycle the selection by ±1 through the full shape set (wrapping). No-op with <2 shapes. */
export function cycleSelection(ctx: SceneContext, dir: 1 | -1): void {
    const shapes = allShapes(ctx);
    if (shapes.length < 2 || !ctx.mesh) return;
    const idx = shapes.indexOf(ctx.mesh);
    selectMesh(ctx, shapes[(idx + dir + shapes.length) % shapes.length]);
}

/**
 * Remove a shape from the scene and dispose its GPU resources. If it was the selected
 * shape, the next shape (if any) is promoted to selected, else ctx.mesh becomes null.
 */
export function removeShape(ctx: SceneContext, mesh: THREE.Mesh): void {
    ctx.scene.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();

    const i = ctx.extraMeshes.indexOf(mesh);
    if (i >= 0) ctx.extraMeshes.splice(i, 1);

    if (ctx.mesh === mesh) {
        const next = ctx.extraMeshes.shift() ?? null;
        ctx.mesh = next;
        ctx.bvh = next ? bvhOf(next) : null;
    }
    refreshHighlight(ctx);
}
