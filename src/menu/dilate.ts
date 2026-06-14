// §5.3 DILATE — two-hand spread/together scaling.
//
// Both hands close into fists to frame the object. The distance between the two wrists
// drives a uniform scale: spreading the hands apart grows the object, bringing them together
// shrinks it. On engage (both hands close into fists) we latch the starting wrist distance
// and the object's current scale; opening either hand latches and releases, so the user can
// spread the hands back apart freely and close the fists again to keep scaling (ratchet) —
// the spread-back no longer undoes the shrink. Thereafter while engaged
//
//     factor = ‖wristL − wristR‖ / startDist          (§5.3)
//     mesh.scale = startScale · factor                (uniform)
//
// A translucent wireframe bounding box hugs the object while DILATE is active and renders
// on Layer 1 (renderOrder=1, depthTest=false, depthWrite=false via asMenuLayer, §4.3) so
// it is always visible above the mesh. A plain-DOM panel fixed to the right edge shows the
// live scale readout.
//
// World starts empty (§5.1): ctx.mesh may be null. Every access is guarded — with no mesh
// this tool is a no-op and shows a placeholder readout.
import { Box3, Box3Helper, Color, Vector3 } from "three";
import type { Mesh } from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { asMenuLayer } from "../render/layers";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { isFist } from "../gesture/predicates";
import { selectedShapes, selectedCount, selectionCenter } from "../core/shapes";

// MediaPipe wrist landmark index (image space, mirrored [0,1]).
const WRIST = 0;

// Fist clutch: BOTH hands must close into a fist to drive scaling; opening either hand
// latches the current scale. This makes the gesture a ratchet — close both fists and bring
// them together to shrink, open up, spread the hands apart freely to reposition, then close
// the fists again to keep shrinking — instead of the spread-back undoing the shrink.
// isFist() is a boolean predicate, so (like TRANSLATE's grab/lock) we debounce each
// transition over a few frames: a single misclassified frame can't chatter the clutch.
const COMMIT_FRAMES = 5;

// Clamp the resulting object scale so a wild gesture can't invert or explode the mesh.
const SCALE_MIN = 0.15;
const SCALE_MAX = 6.0;
// Clamp the raw spread factor too (applied to the group's positions about the centroid).
const FACTOR_MIN = 0.1;
const FACTOR_MAX = 8.0;

// Floor for the engage distance so a momentary hand overlap can't divide by ~0.
const MIN_DIST = 1e-3;

// Bounding-box wireframe styling — translucent, menu-accent coloured (§5.3 / §14).
const BOX_OPACITY = 0.4;

// Padding (world units) added around the mesh's true bounds so the cage reads as a frame
// hugging the object rather than clipping its silhouette.
const BOX_PAD = 0.08;

const INSTRUCTIONS =
    "CLOSE BOTH FISTS TO GRAB<br>SPREAD · UP&nbsp;&nbsp;TOGETHER · DOWN<br>OPEN HANDS TO LATCH";

export function createDilateMenu(): MenuModule {
    const accent = MENU_META[MenuId.DILATE].accent;

    let panel: Panel | null = null;

    // Wireframe cage + its backing Box3. The helper's geometry is a unit cube; we drive its
    // world transform each frame from the SELECTION's live union bounds, so it never rebuilds.
    let box_helper: Box3Helper | null = null;
    const box3 = new Box3();
    const tmp_box = new Box3();

    // Engagement state. The whole SELECTION scales about its centroid: each mesh's distance from
    // the centroid AND its own scale multiply by the spread factor (with one shape, the distance
    // is 0 so it just scales in place).
    let engaged = false;
    let fist_frames = 0;                     // consecutive frames BOTH hands held a fist
    let open_frames = 0;                     // consecutive frames at least one hand opened
    let start_dist = MIN_DIST;              // ‖wristL − wristR‖ (image space) at engage
    let factor = 1;                          // latest applied scale factor (for the readout)
    const engageCenter = new Vector3();      // selection centroid at engage
    const engagedMeshes: Mesh[] = [];        // selection snapshot at engage
    const startScales: number[] = [];        // per-mesh uniform scale at engage
    const startPositions: Vector3[] = [];    // per-mesh position at engage

    // Module-owned scratch (zero per-frame allocation beyond ctx.scratch).
    const wrist_l = new Vector3();
    const wrist_r = new Vector3();
    const rel = new Vector3();               // scratch: mesh offset from centroid
    const center = new Vector3();            // scratch: live centroid

    // Distance between the two wrists in normalized image space (§5.3). Floored so the ratio
    // stays finite when the hands momentarily coincide.
    function wristDist(exec: HandPose, nav: HandPose): number {
        const a = exec.landmarks[WRIST];
        const b = nav.landmarks[WRIST];
        wrist_r.set(a.x, a.y, a.z);
        wrist_l.set(b.x, b.y, b.z);
        return Math.max(wrist_r.distanceTo(wrist_l), MIN_DIST);
    }

    // Fit the wireframe cage to the SELECTION's current world-space union bounds, so the cage
    // frames every selected shape. A small uniform pad lifts the cage off the surfaces.
    function syncBox(ctx: SceneContext): void {
        if (!box_helper) return;
        box3.makeEmpty();
        for (const m of selectedShapes(ctx)) {
            m.updateWorldMatrix(true, false);
            tmp_box.setFromObject(m);
            if (!tmp_box.isEmpty()) box3.union(tmp_box);
        }
        if (box3.isEmpty()) return;
        box3.expandByScalar(BOX_PAD);
        box_helper.box.copy(box3);
        box_helper.updateMatrixWorld(true);
    }

    // Snapshot the selection's poses + centroid at the engage instant (factor reads 1.0).
    function snapshotGroup(ctx: SceneContext): void {
        selectionCenter(ctx, engageCenter);
        engagedMeshes.length = 0;
        startScales.length = 0;
        startPositions.length = 0;
        for (const m of selectedShapes(ctx)) {
            engagedMeshes.push(m);
            startScales.push(m.scale.x);
            startPositions.push(m.position.clone());
        }
    }

    function paintPanel(has_mesh: boolean): void {
        if (!panel) return;
        if (!has_mesh) {
            panel.setBody(
                `<div style="opacity:0.55">No object yet.</div>` +
                `<div style="opacity:0.55;margin-top:6px">Use ADD SHAPES first.</div>`,
            );
            return;
        }
        const status = engaged ? "scaling" : "close both fists to scale";
        panel.setBody(
            `<div style="font-size:64px;font-weight:700;letter-spacing:0.02em">` +
            `${factor.toFixed(2)}<span style="font-size:32px;opacity:0.6">x</span></div>` +
            `<div style="margin-top:10px;opacity:0.6">${status}</div>`,
        );
    }

    return {
        id: MenuId.DILATE,

        enter(ctx: SceneContext): void {
            engaged = false;
            fist_frames = 0;
            open_frames = 0;
            factor = 1;
            start_dist = MIN_DIST;

            panel = new Panel({ title: "DILATE", accent });
            panel.setInstructions(INSTRUCTIONS);

            // Build the wireframe cage on Layer 1. With nothing selected the cage simply stays
            // hidden until a selection exists.
            box3.makeEmpty();
            box_helper = new Box3Helper(box3, new Color(accent));
            (box_helper.material as { opacity: number }).opacity = BOX_OPACITY;
            box_helper.visible = selectedCount(ctx) > 0;
            // HARD RULE (§4.3): menu geometry renders above the mesh — renderOrder=1,
            // depthTest=false, depthWrite=false, transparent. asMenuLayer applies all of it.
            asMenuLayer(box_helper);
            ctx.scene.add(box_helper);

            syncBox(ctx);
            paintPanel(selectedCount(ctx) > 0);
            panel.show();
        },

        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            void dt;

            // Nothing selected → no-op. Keep the cage hidden and the panel in placeholder state.
            if (selectedCount(ctx) === 0) {
                if (engaged) engaged = false;
                if (box_helper) box_helper.visible = false;
                paintPanel(false);
                return;
            }
            if (box_helper) box_helper.visible = true;

            const both = exec !== null && nav !== null;

            if (both) {
                // Fist clutch: both hands must be fists to grab, opening either hand releases.
                // Debounce each transition over COMMIT_FRAMES so a single stray classification
                // can't chatter the clutch (§12). Fist detection uses world landmarks + hand
                // scale so it is size- and distance-invariant (§3.5), matching TRANSLATE.
                const both_fist = isFist(exec!.world, exec!.handScale) &&
                    isFist(nav!.world, nav!.handScale);
                fist_frames = both_fist ? fist_frames + 1 : 0;
                open_frames = both_fist ? 0 : open_frames + 1;

                if (!engaged && fist_frames >= COMMIT_FRAMES) {
                    // Rising edge: latch the baseline distance + the group's poses so the factor
                    // reads exactly 1.0 the instant the fists grab (§5.3). The baseline is taken
                    // from the CURRENT scale, so closing the fists again after spreading the
                    // hands apart continues from where the last grab left off — the gesture
                    // ratchets instead of undoing itself.
                    engaged = true;
                    start_dist = wristDist(exec!, nav!);
                    factor = 1;
                    snapshotGroup(ctx);
                } else if (engaged && open_frames >= COMMIT_FRAMES) {
                    // Either hand opened: latch the current scale and release (§3.6).
                    engaged = false;
                } else if (engaged) {
                    // factor = ‖wristL − wristR‖ / startDist, applied about the engage centroid:
                    // each mesh's offset from the centroid AND its own scale multiply by factor.
                    const cur = wristDist(exec!, nav!);
                    factor = Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, cur / start_dist));
                    for (let i = 0; i < engagedMeshes.length; i++) {
                        const m = engagedMeshes[i];
                        rel.copy(startPositions[i]).sub(engageCenter).multiplyScalar(factor);
                        m.position.copy(engageCenter).add(rel);
                        const s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, startScales[i] * factor));
                        m.scale.setScalar(s);
                    }
                }
            } else if (engaged) {
                // A hand was lost: latch the current scale and disengage (§3.6).
                engaged = false;
                fist_frames = 0;
                open_frames = 0;
            }

            syncBox(ctx);
            paintPanel(true);
        },

        exit(ctx: SceneContext): void {
            if (box_helper) {
                ctx.scene.remove(box_helper);
                box_helper.dispose();
                box_helper = null;
            }
            if (panel) {
                panel.destroy();
                panel = null;
            }
            engaged = false;
            factor = 1;
        },

        get panel(): HTMLElement | undefined {
            return panel?.el;
        },
    };
}
