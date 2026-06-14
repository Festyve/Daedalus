// Multi-shape registry + multi-SELECTION helpers, layered on SceneContext (§5.1 extended).
//
// The world can hold several sculptable shapes at once, and the user can SELECT any subset of
// them (the SELECT tool toggles membership). We keep the single-active-mesh contract intact so
// every single-shape edit tool (MORPH / DECORATE / sculpt) keeps operating on `ctx.mesh`:
//
//   ctx.mesh        = the PRIMARY selected shape (= ctx.selected[0]); null when nothing is
//                     selected. Single-shape tools act on this.
//   ctx.extraMeshes = every OTHER shape in the scene (selected-but-not-primary OR unselected)
//   allShapes(ctx)  = [ctx.mesh?, ...extraMeshes]  — the full set, in no particular order
//   ctx.selected    = the SELECTION SET (primary first); a subset of allShapes
//   ctx.focusIndex  = the SELECT tool's focus cursor into allShapes (what a pinch toggles)
//
// Multi-shape tools (TRANSLATE / DILATE / ROTATE / INTERACT / DESTROY) act on ctx.selected and
// pivot on selectionCenter(). Selected shapes are drawn bright; the primary brightest; the rest
// are ghosted — so the selection reads at a glance in BOTH the main view and the corner preview.
import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import type { SceneContext } from "../types";
import { T } from "../render/tokens";

// Ghosted (unselected) vs full (selected) opacity. Selection persists across tools, so the cue
// must read without any active tool. Unselected is kept clearly visible (not a faint ghost) so
// every shape stays readable on screen; the selected/unselected split is carried by the brighter
// tint + depth-write below, not by making the rest nearly invisible.
const UNSELECTED_OPACITY = 0.6;
const SELECTED_OPACITY = 1.0;

// Wireframe tints by selection tier. WIRE_BASE matches makeMatcapMaterial's colour; decoration
// (per-vertex colour) still multiplies through, so a decorated shape keeps its look — it is just
// lifted (primary), full (selected) or dimmed (unselected). No extra render passes, so the tier
// shows identically in the main AR view and the corner preview.
const WIRE_BASE = new THREE.Color(T.cyan).lerp(new THREE.Color(T.white), 0.15);
const WIRE_DIM = WIRE_BASE.clone().multiplyScalar(0.7);
const WIRE_PRIMARY = WIRE_BASE.clone().lerp(new THREE.Color(T.white), 0.55);

// Scratch for selectionCenter (no per-frame allocation, §6.2).
const TMP_POS = new THREE.Vector3();

// Read the boundsTree (BVH) three-mesh-bvh stashed on a geometry, if present.
function bvhOf(mesh: THREE.Mesh): MeshBVH | null {
    return (mesh.geometry as unknown as { boundsTree?: MeshBVH }).boundsTree ?? null;
}

/** The full set of shapes in the scene: the primary one first (if any), then the rest. */
export function allShapes(ctx: SceneContext): THREE.Mesh[] {
    return ctx.mesh ? [ctx.mesh, ...ctx.extraMeshes] : [...ctx.extraMeshes];
}

/** How many shapes exist in total. */
export function shapeCount(ctx: SceneContext): number {
    return (ctx.mesh ? 1 : 0) + ctx.extraMeshes.length;
}

/** The current selection set (primary first). */
export function selectedShapes(ctx: SceneContext): THREE.Mesh[] {
    return ctx.selected;
}

/** How many shapes are currently selected. */
export function selectedCount(ctx: SceneContext): number {
    return ctx.selected.length;
}

/** Whether `mesh` is in the selection set. */
export function isSelected(ctx: SceneContext, mesh: THREE.Mesh): boolean {
    return ctx.selected.indexOf(mesh) >= 0;
}

/**
 * Make `mesh` the PRIMARY (ctx.mesh) while keeping allShapes the same set: the previous primary
 * (if any, and different) moves into extraMeshes and `mesh` is pulled out of extraMeshes. ctx.bvh
 * is repointed at the new primary's boundsTree. Internal — selection mutators call it to keep
 * ctx.mesh === ctx.selected[0].
 */
function setPrimary(ctx: SceneContext, mesh: THREE.Mesh): void {
    if (ctx.mesh === mesh) return;
    const i = ctx.extraMeshes.indexOf(mesh);
    if (i >= 0) ctx.extraMeshes.splice(i, 1);
    if (ctx.mesh) ctx.extraMeshes.push(ctx.mesh);
    ctx.mesh = mesh;
    ctx.bvh = bvhOf(mesh);
}

// Drop the primary into extraMeshes and leave nothing primary (selection became empty).
function clearPrimary(ctx: SceneContext): void {
    if (ctx.mesh) ctx.extraMeshes.push(ctx.mesh);
    ctx.mesh = null;
    ctx.bvh = null;
}

/**
 * Toggle `mesh` in/out of the selection set (the SELECT tool's pinch). Adding the first shape
 * makes it primary; removing the primary promotes the next selected shape (or clears the primary
 * if the set is now empty). Repaints the highlight.
 */
export function toggleSelect(ctx: SceneContext, mesh: THREE.Mesh): void {
    const i = ctx.selected.indexOf(mesh);
    if (i >= 0) {
        ctx.selected.splice(i, 1);
        if (ctx.mesh === mesh) {
            const head = ctx.selected[0] ?? null;
            if (head) setPrimary(ctx, head);
            else clearPrimary(ctx);
        }
    } else {
        ctx.selected.push(mesh);
        if (ctx.mesh === null) setPrimary(ctx, mesh);
    }
    refreshHighlight(ctx);
}

/** Make `mesh` the SOLE selection (spawn / INTERACT result). Clears any prior selection, makes
 *  it primary, and parks the focus cursor on it. */
export function selectOnly(ctx: SceneContext, mesh: THREE.Mesh): void {
    ctx.selected.length = 0;
    ctx.selected.push(mesh);
    setPrimary(ctx, mesh);
    ctx.focusIndex = Math.max(0, allShapes(ctx).indexOf(mesh));
    refreshHighlight(ctx);
}

/** Clear the whole selection (nothing selected; ctx.mesh becomes null). */
export function clearSelection(ctx: SceneContext): void {
    ctx.selected.length = 0;
    clearPrimary(ctx);
    refreshHighlight(ctx);
}

/** The shape under the SELECT focus cursor (what a pinch would toggle), or null when empty. */
export function focusedShape(ctx: SceneContext): THREE.Mesh | null {
    const shapes = allShapes(ctx);
    if (shapes.length === 0) return null;
    const i = Math.min(Math.max(ctx.focusIndex, 0), shapes.length - 1);
    return shapes[i];
}

/** Step the SELECT focus cursor by ±1 through the full shape set (wrapping). */
export function moveFocus(ctx: SceneContext, dir: 1 | -1): void {
    const n = shapeCount(ctx);
    if (n === 0) return;
    ctx.focusIndex = (((ctx.focusIndex + dir) % n) + n) % n;
}

/**
 * World-space centroid of the SELECTED shapes (falls back to all shapes if nothing is selected),
 * written into `out`. The pivot for multi-shape ROTATE / DILATE / TRANSLATE so they act on the
 * group as a whole rather than one shape. Reuses a module scratch — no per-call allocation.
 */
export function selectionCenter(ctx: SceneContext, out: THREE.Vector3): THREE.Vector3 {
    const set = ctx.selected.length ? ctx.selected : allShapes(ctx);
    out.set(0, 0, 0);
    if (set.length === 0) return out;
    for (const m of set) {
        m.updateWorldMatrix(true, false);
        m.getWorldPosition(TMP_POS);
        out.add(TMP_POS);
    }
    return out.multiplyScalar(1 / set.length);
}

/**
 * Re-apply the selection highlight in three tiers (cheap material-flag writes, safe every frame):
 *   - primary selected (ctx.mesh): brightest, opaque, writes depth
 *   - selected (non-primary):      full wire tint, opaque, writes depth
 *   - unselected:                  dimmed + ghosted (no depth write), reads as background
 */
export function refreshHighlight(ctx: SceneContext): void {
    for (const m of allShapes(ctx)) {
        const mat = m.material as THREE.MeshBasicMaterial;
        const selected = ctx.selected.indexOf(m) >= 0;
        const primary = m === ctx.mesh;
        mat.transparent = true;
        mat.opacity = selected ? SELECTED_OPACITY : UNSELECTED_OPACITY;
        mat.depthWrite = selected;
        mat.color.copy(primary ? WIRE_PRIMARY : selected ? WIRE_BASE : WIRE_DIM);
    }
}

/**
 * Remove a shape from the scene and dispose its GPU resources. Drops it from the selection set;
 * if it was the primary, the next selected shape is promoted (or the primary is cleared when the
 * selection is now empty). The focus cursor is clamped to the new shape count.
 */
export function removeShape(ctx: SceneContext, mesh: THREE.Mesh): void {
    ctx.scene.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();

    const e = ctx.extraMeshes.indexOf(mesh);
    if (e >= 0) ctx.extraMeshes.splice(e, 1);
    const s = ctx.selected.indexOf(mesh);
    if (s >= 0) ctx.selected.splice(s, 1);

    if (ctx.mesh === mesh) {
        const head = ctx.selected[0] ?? null;
        if (head) {
            const hi = ctx.extraMeshes.indexOf(head);
            if (hi >= 0) ctx.extraMeshes.splice(hi, 1);
            ctx.mesh = head;
            ctx.bvh = bvhOf(head);
        } else {
            ctx.mesh = null;
            ctx.bvh = null;
        }
    }

    const n = shapeCount(ctx);
    if (n === 0) ctx.focusIndex = 0;
    else if (ctx.focusIndex >= n) ctx.focusIndex = n - 1;

    refreshHighlight(ctx);
}
