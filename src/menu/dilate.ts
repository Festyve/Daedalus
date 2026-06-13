// §5.3 DILATE — two-hand spread/together scaling.
//
// Both hands frame the object. The distance between the two wrists drives a uniform
// scale: spreading the hands apart grows the object, bringing them together shrinks it.
// On engage (both hands first present) we latch the starting wrist distance and the
// object's current scale; thereafter
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
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { asMenuLayer } from "../render/layers";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";

// MediaPipe wrist landmark index (image space, mirrored [0,1]).
const WRIST = 0;

// Clamp the resulting object scale so a wild gesture can't invert or explode the mesh.
const SCALE_MIN = 0.15;
const SCALE_MAX = 6.0;

// Floor for the engage distance so a momentary hand overlap can't divide by ~0.
const MIN_DIST = 1e-3;

// Bounding-box wireframe styling — translucent, menu-accent coloured (§5.3 / §14).
const BOX_OPACITY = 0.4;

// Padding (world units) added around the mesh's true bounds so the cage reads as a frame
// hugging the object rather than clipping its silhouette.
const BOX_PAD = 0.08;

const INSTRUCTIONS =
    "SPREAD HANDS · SCALE UP<br>BRING TOGETHER · SCALE DOWN";

export function createDilateMenu(): MenuModule {
    const accent = MENU_META[MenuId.DILATE].accent;

    let panel: Panel | null = null;

    // Wireframe cage + its backing Box3. The helper's geometry is a unit cube; we drive its
    // world transform each frame from the mesh's live bounds, so it never needs rebuilding.
    let box_helper: Box3Helper | null = null;
    const box3 = new Box3();

    // Engagement state.
    let engaged = false;
    let start_dist = MIN_DIST;              // ‖wristL − wristR‖ (image space) at engage
    const start_scale = new Vector3(1, 1, 1); // mesh.scale at engage
    let factor = 1;                          // latest applied scale factor (for the readout)

    // Module-owned scratch (zero per-frame allocation beyond ctx.scratch).
    const wrist_l = new Vector3();
    const wrist_r = new Vector3();

    // Distance between the two wrists in normalized image space (§5.3). Floored so the ratio
    // stays finite when the hands momentarily coincide.
    function wristDist(exec: HandPose, nav: HandPose): number {
        const a = exec.landmarks[WRIST];
        const b = nav.landmarks[WRIST];
        wrist_r.set(a.x, a.y, a.z);
        wrist_l.set(b.x, b.y, b.z);
        return Math.max(wrist_r.distanceTo(wrist_l), MIN_DIST);
    }

    // Fit the wireframe cage to the mesh's current world-space bounds. setFromObject walks
    // the mesh's geometry under its full world matrix, so the cage tracks the object's live
    // scale/position/rotation rig exactly. A small uniform pad lifts the cage off the surface.
    function syncBox(ctx: SceneContext): void {
        if (!box_helper || !ctx.mesh) return;
        ctx.mesh.updateWorldMatrix(true, false);
        box3.setFromObject(ctx.mesh);
        if (box3.isEmpty()) return;
        box3.expandByScalar(BOX_PAD);
        box_helper.box.copy(box3);
        box_helper.updateMatrixWorld(true);
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
        const status = engaged ? "scaling" : "frame with both hands";
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
            factor = 1;
            start_dist = MIN_DIST;

            panel = new Panel({ title: "DILATE", accent });
            panel.setInstructions(INSTRUCTIONS);

            // Build the wireframe cage on Layer 1. The mesh may be null (empty world); the
            // cage is created regardless and simply tracks nothing until a mesh exists.
            box3.makeEmpty();
            box_helper = new Box3Helper(box3, new Color(accent));
            (box_helper.material as { opacity: number }).opacity = BOX_OPACITY;
            box_helper.visible = ctx.mesh !== null;
            // HARD RULE (§4.3): menu geometry renders above the mesh — renderOrder=1,
            // depthTest=false, depthWrite=false, transparent. asMenuLayer applies all of it.
            asMenuLayer(box_helper);
            ctx.scene.add(box_helper);

            if (ctx.mesh) start_scale.copy(ctx.mesh.scale);
            syncBox(ctx);
            paintPanel(ctx.mesh !== null);
            panel.show();
        },

        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            void dt;

            // No object → no-op. Keep the cage hidden and the panel in its placeholder state.
            if (!ctx.mesh) {
                if (engaged) engaged = false;
                if (box_helper) box_helper.visible = false;
                paintPanel(false);
                return;
            }
            if (box_helper) box_helper.visible = true;

            const both = exec !== null && nav !== null;

            if (both) {
                const cur = wristDist(exec!, nav!);
                if (!engaged) {
                    // Rising edge: latch the baseline distance and the object's scale so the
                    // factor reads exactly 1.0 the instant both hands engage (§5.3).
                    engaged = true;
                    start_dist = cur;
                    start_scale.copy(ctx.mesh.scale);
                    factor = 1;
                } else {
                    // factor = ‖wristL − wristR‖ / startDist, applied uniformly relative to the
                    // scale captured at engage. Clamp so the mesh can't invert or explode.
                    factor = cur / start_dist;
                    const s = Math.min(
                        SCALE_MAX,
                        Math.max(SCALE_MIN, start_scale.x * factor),
                    );
                    ctx.mesh.scale.setScalar(s);
                }
            } else if (engaged) {
                // A hand was lost: latch the current scale and disengage (§3.6).
                engaged = false;
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
