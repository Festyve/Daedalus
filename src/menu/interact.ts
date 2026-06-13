// §6.5 INTERACT — boolean / CSG operations between two objects.
//
// Paradigm (SPEC §6.5):
//   1. The active sculptable object (ctx.mesh) is the "source" (highlighted blue).
//   2. The right-hand INDEX_TIP, when brought near a mesh in ctx.extraMeshes, "taps"
//      it → that mesh becomes the "target" (highlighted red).
//   3. The SpatialPanel shows three operation icons: UNION (A∪B), SUBTRACT (A−B),
//      INTERSECT (A∩B).
//   4. Right hand point + dwell on an operation slot → a ghosted preview of the
//      result mesh appears.
//   5. Right hand pinch confirms → three-bvh-csg Evaluator.evaluate(source, target,
//      op) runs; the result geometry replaces the source's geometry, and the target
//      is removed from the scene + ctx.extraMeshes.
//
// Gotcha (SPEC §6.5): three-bvh-csg is experimental, so results can be non-manifold.
// The panel exposes a REPAIR slot (mergeVertices + recompute normals) and an UNDO
// slot (restore the source's prior geometry). Both are reachable the same way as the
// op slots (point + dwell to arm, pinch to fire).
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import type { CSGOperation } from "three-bvh-csg";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { MENU_META, TOKENS } from "../render/tokens";
import { SpatialPanel } from "./spatialPanel";
import { fingertipToWorld } from "../math/coords";
import { classify } from "../gesture/predicates";

// Highlight tints (emissive-style overlay via material.color on the matcap; the
// matcap multiplies by color so a slightly tinted color reads as a colored cast).
const SOURCE_HEX = TOKENS.menuBlue; // source highlight (blue)
const TARGET_HEX = TOKENS.menuRed;  // target highlight (red)

// INDEX_TIP world-space distance under which a right-hand tap selects a target.
// Tuned to the unit-ish scene scale (mesh radius ~1, camera at z=6).
const TAP_RADIUS = 0.9;

// Dwell time (seconds) the right finger must hover a panel slot before it arms.
const DWELL_TIME = 0.6;

// Pinch closure (0..1) above which an armed slot fires. classify().pinch is 1 at a
// full pinch; require a firm pinch and a release before the next fire.
const PINCH_FIRE = 0.7;
const PINCH_RELEASE = 0.4;

// The four selectable panel slots, laid out as a vertical list on the card.
type SlotId = "union" | "subtract" | "intersect" | "repair" | "undo";
interface Slot {
    id: SlotId;
    label: string;
    sub: string;
}
const SLOTS: Slot[] = [
    { id: "union", label: "UNION", sub: "A union B" },
    { id: "subtract", label: "SUBTRACT", sub: "A minus B" },
    { id: "intersect", label: "INTERSECT", sub: "A and B" },
    { id: "repair", label: "REPAIR", sub: "weld + renormal" },
    { id: "undo", label: "UNDO", sub: "restore source" },
];

const CSG_OP: Record<"union" | "subtract" | "intersect", CSGOperation> = {
    union: ADDITION,
    subtract: SUBTRACTION,
    intersect: INTERSECTION,
};

// One ghost preview material reused for whichever op is being previewed.
function makeGhostMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
        color: new THREE.Color(TOKENS.rim),
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
}

// Restore a plain white vertex-color buffer on a CSG result so the source mesh's
// MeshMatcapMaterial (vertexColors:true, icing buffer) keeps rendering. The boolean
// output only carries position/normal, so the color attribute must be rebuilt.
function ensureWhiteColors(geometry: THREE.BufferGeometry): void {
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3).fill(1);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

export function createInteractMenu(): MenuModule {
    const meta = MENU_META[MenuId.INTERACT];
    const panel = new SpatialPanel(meta.accent);

    // CSG state.
    const evaluator = new Evaluator();
    evaluator.useGroups = false;          // single-material source → simple result
    evaluator.attributes = ["position", "normal"];

    // Reused scratch (no per-frame allocation beyond the texture repaint).
    const index_tip_world = new THREE.Vector3();
    const mesh_world_pos = new THREE.Vector3();
    const target_world_pos = new THREE.Vector3();
    const ghost_material = makeGhostMaterial();

    // Mutable per-session state.
    let target: THREE.Mesh | null = null;
    let armed: SlotId | null = null;      // slot currently hovered long enough to fire
    let dwell_slot: SlotId | null = null; // slot the finger is presently over
    let dwell_acc = 0;                    // seconds hovered on dwell_slot
    let pinch_latched = false;            // require release between fires
    let ghost: THREE.Mesh | null = null;  // current preview mesh
    let ghost_op: SlotId | null = null;   // which op the ghost currently shows
    let prev_geometry: THREE.BufferGeometry | null = null; // undo snapshot
    let status = "TAP A SHAPE";           // short status line painted on the panel

    // --- highlight helpers ----------------------------------------------------
    // The matcap material has no emissive; tint via `.color` (matcap multiplies by
    // it). We stash the original color so exit()/deselect restores it exactly.
    const original_colors = new WeakMap<THREE.Material, THREE.Color>();
    function tint(mesh: THREE.Mesh, hex: string): void {
        const mat = mesh.material as THREE.Material & { color?: THREE.Color };
        if (!mat.color) return;
        if (!original_colors.has(mat)) original_colors.set(mat, mat.color.clone());
        mat.color.set(hex);
    }
    function untint(mesh: THREE.Mesh): void {
        const mat = mesh.material as THREE.Material & { color?: THREE.Color };
        if (!mat.color) return;
        const orig = original_colors.get(mat);
        if (orig) mat.color.copy(orig);
        else mat.color.set("#ffffff");
    }

    // --- ghost preview --------------------------------------------------------
    function clearGhost(ctx: SceneContext): void {
        if (ghost) {
            ctx.scene.remove(ghost);
            ghost.geometry.dispose();
            ghost = null;
        }
        ghost_op = null;
    }

    // Build (or rebuild) the ghost for op `slot`, placed at the source mesh's world
    // transform (the Evaluator aligns results to brush A = the source).
    function buildGhost(ctx: SceneContext, slot: "union" | "subtract" | "intersect"): void {
        if (!target) return;
        clearGhost(ctx);
        const result = runCsg(ctx, slot);
        if (!result) return;
        ghost = new THREE.Mesh(result, ghost_material);
        // The result is in source-local space; place the ghost at the source's world
        // transform so it overlays the live mesh exactly.
        ctx.mesh.updateWorldMatrix(true, false);
        ctx.mesh.matrixWorld.decompose(ghost.position, ghost.quaternion, ghost.scale);
        ghost.renderOrder = 5;
        ctx.scene.add(ghost);
        ghost_op = slot;
    }

    // Run the boolean between source (ctx.mesh) and target, returning fresh result
    // geometry in source-local space, or null if it could not be evaluated. Brush A
    // and B are baked to their world transforms so the cut lands where they visually
    // overlap; the Evaluator returns geometry aligned to brush A.
    function runCsg(ctx: SceneContext, slot: "union" | "subtract" | "intersect"): THREE.BufferGeometry | null {
        if (!target) return null;
        ctx.mesh.updateWorldMatrix(true, false);
        target.updateWorldMatrix(true, false);

        const source_brush = new Brush(ctx.mesh.geometry);
        source_brush.matrix.copy(ctx.mesh.matrixWorld);
        source_brush.matrix.decompose(source_brush.position, source_brush.quaternion, source_brush.scale);
        source_brush.updateMatrixWorld(true);

        const target_brush = new Brush(target.geometry);
        target_brush.matrix.copy(target.matrixWorld);
        target_brush.matrix.decompose(target_brush.position, target_brush.quaternion, target_brush.scale);
        target_brush.updateMatrixWorld(true);

        const out = evaluator.evaluate(source_brush, target_brush, CSG_OP[slot]) as Brush;
        const geometry = out.geometry;
        ensureWhiteColors(geometry);
        return geometry;
    }

    // Record a new UNDO snapshot, disposing any superseded snapshot (only one level
    // of undo is kept). Never disposes the geometry currently on the mesh.
    function setUndoSnapshot(ctx: SceneContext, geom: THREE.BufferGeometry): void {
        if (prev_geometry && prev_geometry !== geom && prev_geometry !== ctx.mesh.geometry) {
            prev_geometry.dispose();
        }
        prev_geometry = geom;
    }

    // --- commits --------------------------------------------------------------
    // Replace the source geometry with the boolean result (mirrors the prototype's
    // Modeler.bore(): swap mesh.geometry, dispose the old). The mesh object, material,
    // and scene-graph placement are preserved so downstream sculpt/morph still target
    // the same mesh. The morph attributes do not survive a boolean — that is expected;
    // INTERACT is a post-morph editing beat.
    function commitOp(ctx: SceneContext, slot: "union" | "subtract" | "intersect"): void {
        if (!target) return;
        const geometry = (ghost && ghost_op === slot) ? ghost.geometry : runCsg(ctx, slot);
        if (!geometry) return;

        // Snapshot for UNDO before mutating; detach the ghost's geometry so clearing
        // the ghost does not dispose the geometry we are about to install.
        setUndoSnapshot(ctx, ctx.mesh.geometry);
        if (ghost && ghost.geometry === geometry) {
            ctx.scene.remove(ghost);
            ghost = null;
            ghost_op = null;
        } else {
            clearGhost(ctx);
        }

        ctx.mesh.geometry = geometry;
        // The morph targets/influences no longer match the new topology; clear them so
        // the renderer does not read a stale, mismatched morph attribute.
        ctx.mesh.morphTargetInfluences = undefined;
        // Invalidate the shared BVH — its node bounds reference the old geometry.
        ctx.bvh = null;
        const geom_holder = ctx.mesh.geometry as unknown as { boundsTree?: unknown };
        geom_holder.boundsTree = undefined;

        removeTarget(ctx);
        status = slot.toUpperCase() + " DONE";
    }

    // Repair a (possibly non-manifold) result: weld coincident vertices by position
    // then recompute normals. Drops normal/uv first so the weld merges by geometry,
    // matching the prototype's bore() cleanup.
    function repair(ctx: SceneContext): void {
        const original = ctx.mesh.geometry;
        // Weld on a throwaway clone (sans normal/uv/color so the merge is purely
        // positional); the original is retained as the UNDO snapshot, not disposed.
        const work = original.clone();
        work.deleteAttribute("normal");
        work.deleteAttribute("uv");
        work.deleteAttribute("color");
        const welded = mergeVertices(work);
        welded.computeVertexNormals();
        ensureWhiteColors(welded);
        work.dispose();

        setUndoSnapshot(ctx, original);
        ctx.mesh.geometry = welded;
        ctx.bvh = null;
        const geom_holder = ctx.mesh.geometry as unknown as { boundsTree?: unknown };
        geom_holder.boundsTree = undefined;
        status = "REPAIRED";
    }

    // Restore the geometry captured before the last commit/repair.
    function undo(ctx: SceneContext): void {
        if (!prev_geometry) {
            status = "NOTHING TO UNDO";
            return;
        }
        const restore = prev_geometry;
        prev_geometry = null;
        ctx.mesh.geometry.dispose();
        ctx.mesh.geometry = restore;
        ctx.bvh = null;
        const geom_holder = ctx.mesh.geometry as unknown as { boundsTree?: unknown };
        geom_holder.boundsTree = undefined;
        status = "UNDONE";
    }

    // --- target selection -----------------------------------------------------
    function removeTarget(ctx: SceneContext): void {
        if (!target) return;
        untint(target);
        ctx.scene.remove(target);
        const i = ctx.extraMeshes.indexOf(target);
        if (i >= 0) ctx.extraMeshes.splice(i, 1);
        target = null;
    }

    function deselectTarget(): void {
        if (target) untint(target);
        target = null;
    }

    // Pick the nearest extra mesh whose world position is within TAP_RADIUS of the
    // right INDEX_TIP world position; null if none qualify.
    function nearestTapped(ctx: SceneContext, right: HandPose): THREE.Mesh | null {
        fingertipToWorld(
            right.landmarks[8], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, index_tip_world,
        );
        let best: THREE.Mesh | null = null;
        let best_d2 = TAP_RADIUS * TAP_RADIUS;
        for (const m of ctx.extraMeshes) {
            m.getWorldPosition(target_world_pos);
            const d2 = target_world_pos.distanceToSquared(index_tip_world);
            if (d2 <= best_d2) {
                best_d2 = d2;
                best = m;
            }
        }
        return best;
    }

    // --- panel slot hit-testing ----------------------------------------------
    // The right INDEX_TIP NDC.x/.y maps onto the panel's slot list. The panel is a
    // billboard beside the mesh; we cannot cheaply ray-test the card from a fingertip,
    // so (per the radial/panel dwell paradigm) we map the fingertip's vertical image
    // position to the slot list and require the finger to be on the panel's side
    // (right half of the frame) and pointing.
    function slotUnderFinger(right: HandPose): SlotId | null {
        const g = classify(right.landmarks);
        if (g.name !== "point" && g.name !== "gun") return null;
        const tip = right.landmarks[8];
        // Panel sits to the object's right (camera-right); require the finger on the
        // right portion of the (mirrored) image to address it.
        if (tip.x < 0.5) return null;
        // Map vertical position (0 top .. 1 bottom) to a slot row.
        const row = Math.floor(tip.y * SLOTS.length);
        if (row < 0 || row >= SLOTS.length) return null;
        return SLOTS[row].id;
    }

    // --- panel paint ----------------------------------------------------------
    function repaint(): void {
        panel.draw((g, w, h) => {
            // Title.
            g.fillStyle = meta.accent;
            g.font = 'bold 30px "JetBrains Mono", monospace';
            g.textBaseline = "top";
            g.fillText("INTERACT", 20, 16);

            // Source / target status row.
            g.font = '16px "JetBrains Mono", monospace';
            g.fillStyle = SOURCE_HEX;
            g.fillText("SRC: object", 20, 52);
            g.fillStyle = target ? TARGET_HEX : TOKENS.textDim;
            g.fillText(target ? "TGT: shape" : "TGT: tap a shape", 200, 52);

            // Slot list.
            const top = 86;
            const row_h = (h - top - 36) / SLOTS.length;
            for (let i = 0; i < SLOTS.length; i++) {
                const slot = SLOTS[i];
                const y = top + i * row_h;
                const is_dwell = dwell_slot === slot.id;
                const is_armed = armed === slot.id;

                // Row background highlight when hovered / armed.
                if (is_armed) {
                    g.fillStyle = meta.accent;
                    g.globalAlpha = 0.30;
                    g.fillRect(12, y, w - 24, row_h - 6);
                    g.globalAlpha = 1;
                } else if (is_dwell) {
                    g.fillStyle = meta.accent;
                    g.globalAlpha = 0.12;
                    g.fillRect(12, y, w - 24, row_h - 6);
                    g.globalAlpha = 1;
                }

                g.fillStyle = is_armed ? "#FFFFFF" : meta.accent;
                g.font = 'bold 22px "JetBrains Mono", monospace';
                g.fillText(slot.label, 22, y + 6);
                g.fillStyle = TOKENS.textDim;
                g.font = '14px "JetBrains Mono", monospace';
                g.fillText(slot.sub, 22, y + 32);
            }

            // Status footer.
            g.fillStyle = meta.accent;
            g.font = '16px "JetBrains Mono", monospace';
            g.fillText("> " + status, 20, h - 28);
        });
    }

    return {
        id: MenuId.INTERACT,

        enter(ctx: SceneContext): void {
            target = null;
            armed = null;
            dwell_slot = null;
            dwell_acc = 0;
            pinch_latched = false;
            ghost = null;
            ghost_op = null;
            prev_geometry = null;
            status = ctx.extraMeshes.length ? "TAP A SHAPE" : "ADD A SHAPE FIRST";

            tint(ctx.mesh, SOURCE_HEX);

            ctx.mesh.updateWorldMatrix(true, false);
            mesh_world_pos.setFromMatrixPosition(ctx.mesh.matrixWorld);
            panel.placeBeside(mesh_world_pos, ctx.camera);
            ctx.scene.add(panel.object);
            repaint();
        },

        update(ctx: SceneContext, right: HandPose | null, _left: HandPose | null, dt: number): void {
            // Keep the panel beside the (possibly spinning) mesh.
            ctx.mesh.updateWorldMatrix(true, false);
            mesh_world_pos.setFromMatrixPosition(ctx.mesh.matrixWorld);
            panel.placeBeside(mesh_world_pos, ctx.camera);

            if (!right) {
                dwell_slot = null;
                dwell_acc = 0;
                repaint();
                return;
            }

            const g = classify(right.landmarks);

            // (2) Tapping a shape with the index tip selects/swaps the target. Only
            // act on a tap when not actively pointing at the panel, so addressing the
            // panel slots does not also re-pick targets.
            const over_slot = slotUnderFinger(right);
            if (!over_slot) {
                const tapped = nearestTapped(ctx, right);
                if (tapped && tapped !== target) {
                    deselectTarget();
                    target = tapped;
                    tint(target, TARGET_HEX);
                    clearGhost(ctx);
                    armed = null;
                    status = "PICK AN OP";
                }
            }

            // (4) Dwell on a panel slot arms it; (5) pinch fires the armed slot.
            if (over_slot) {
                if (over_slot === dwell_slot) {
                    dwell_acc += dt;
                } else {
                    dwell_slot = over_slot;
                    dwell_acc = 0;
                }
                if (dwell_acc >= DWELL_TIME) {
                    armed = over_slot;
                    // Preview ghost for the three boolean ops as soon as armed.
                    if ((armed === "union" || armed === "subtract" || armed === "intersect")) {
                        if (target && ghost_op !== armed) buildGhost(ctx, armed);
                    } else {
                        clearGhost(ctx);
                    }
                }
            } else {
                dwell_slot = null;
                dwell_acc = 0;
            }

            // Pinch confirm (latched so one pinch = one fire).
            if (g.pinch >= PINCH_FIRE && !pinch_latched && armed) {
                pinch_latched = true;
                fireSlot(ctx, armed);
                armed = null;
                dwell_slot = null;
                dwell_acc = 0;
            } else if (g.pinch <= PINCH_RELEASE) {
                pinch_latched = false;
            }

            repaint();
        },

        exit(ctx: SceneContext): void {
            untint(ctx.mesh);
            deselectTarget();
            clearGhost(ctx);
            ctx.scene.remove(panel.object);
            // Drop any undo snapshot we are still holding (it is not on the mesh).
            if (prev_geometry && prev_geometry !== ctx.mesh.geometry) {
                prev_geometry.dispose();
            }
            prev_geometry = null;
        },
    };

    // Dispatch a fired slot to its action.
    function fireSlot(ctx: SceneContext, slot: SlotId): void {
        if (slot === "repair") {
            repair(ctx);
        } else if (slot === "undo") {
            undo(ctx);
        } else if (slot === "union" || slot === "subtract" || slot === "intersect") {
            if (!target) {
                status = "TAP A SHAPE FIRST";
                return;
            }
            commitOp(ctx, slot);
        }
    }
}
