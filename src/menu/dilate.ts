// §6.3 DILATE — two-hand pinch-spread scaling. Both hands form a loose pinch near the
// object; the distance between the two pinch points drives ctx.mesh.scale. On engage
// (both hands pinched) we latch the starting hand distance and the object's starting
// scale; thereafter scale = (currentDist / startDist) · startScale. Moving the hands
// apart scales up, together scales down. If only one hand moves, the scaling is biased
// along the axis connecting the two hands (non-uniform); when both move symmetrically it
// stays uniform (§13.5). A translucent wireframe bounding box hugs the object while
// dilation is active and a live scale readout is painted on the spatial panel (§5.3).
//
// This paradigm releases left-hand menu-nav for its duration (§6.3) — both hands feed
// the gesture here, not the radial ring.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { SpatialPanel } from "./spatialPanel";
import { pinchAmount, palmCenter } from "../gesture/predicates";

// A "loose pinch" engages the gesture: thumb-index closure past this fraction (§6.3).
// Lower than a full sculpt-grade pinch so the natural framing gesture engages readily.
const PINCH_ENGAGE = 0.45;
// Below this the pinch is considered released (hysteresis margin under PINCH_ENGAGE so
// the gesture does not flicker on/off at the threshold).
const PINCH_RELEASE = 0.32;

// Clamp the resulting object scale so a wild gesture can't invert or explode the mesh.
const SCALE_MIN = 0.15;
const SCALE_MAX = 6.0;

// Non-uniform bias: how strongly a one-handed move concentrates scaling along the
// hand-connecting axis. 0 = always uniform; 1 = fully axis-only. The blend is driven by
// how asymmetric the two hands' motion is (one still, one moving → toward axis-only).
const ANISO_STRENGTH = 0.85;

// Bounding-box wireframe styling — translucent, menu-accent coloured (§6.3 / §15).
const BOX_OPACITY = 0.35;
// Corner scale-handle cubes (visual only, not interactive, §6.3).
const HANDLE_SIZE = 0.08;
const HANDLE_OPACITY = 0.6;

export function createDilateMenu(): MenuModule {
    const accent = MENU_META[MenuId.DILATE].accent;

    let panel: SpatialPanel | null = null;
    // Group holding the wireframe box + corner handles; parented to the mesh's parent so
    // it co-rotates with the object's tilt/spin rig and only needs scale/position synced.
    let box_group: THREE.Group | null = null;
    let box_lines: THREE.LineSegments | null = null;
    let box_material: THREE.LineBasicMaterial | null = null;
    let handle_geometry: THREE.BoxGeometry | null = null;
    let handle_material: THREE.MeshBasicMaterial | null = null;
    const handle_meshes: THREE.Mesh[] = [];

    // The mesh's local-space bounding box half-extents (geometry is centred at origin),
    // captured on enter so the wireframe matches the object's true silhouette.
    const box_half = new THREE.Vector3(1, 1, 1);

    // Engagement state.
    let engaged = false;
    let start_dist = 0;         // hand distance (image space) at engage
    const start_scale = new THREE.Vector3(1, 1, 1);
    // Axis (object/world space) connecting the two hands at engage, for non-uniform mode.
    const start_axis = new THREE.Vector3(1, 0, 0);

    // Live readout (latest applied factor) for the panel.
    let last_factor = 1;

    // Distance between the two hands' pinch points in normalized image space. We use the
    // thumb-index midpoint of each hand (the natural pinch location) so the gesture reads
    // off where the fingers actually meet, not the palm.
    function pinchPointDist(right: HandPose, left: HandPose): number {
        const rx = (right.landmarks[4].x + right.landmarks[8].x) * 0.5;
        const ry = (right.landmarks[4].y + right.landmarks[8].y) * 0.5;
        const lx = (left.landmarks[4].x + left.landmarks[8].x) * 0.5;
        const ly = (left.landmarks[4].y + left.landmarks[8].y) * 0.5;
        return Math.hypot(rx - lx, ry - ly) || 1e-3;
    }

    // World-space axis between the two hands (camera-facing plane), for non-uniform bias.
    // Reuses ctx.scratch; writes the normalized direction into `out`.
    function handAxisWorld(
        ctx: SceneContext, right: HandPose, left: HandPose, out: THREE.Vector3,
    ): void {
        const rp = palmCenter(right.landmarks);
        const lp = palmCenter(left.landmarks);
        // image space (mirrored [0,1]) → rough world direction on the interaction plane.
        const a = ctx.scratch.v2.set(rp.x * 2 - 1, -(rp.y * 2 - 1), 0).unproject(ctx.camera);
        const b = ctx.scratch.v3.set(lp.x * 2 - 1, -(lp.y * 2 - 1), 0).unproject(ctx.camera);
        out.subVectors(a, b);
        out.z = 0; // keep the bias in the screen plane; object depth is fixed (§13.2)
        if (out.lengthSq() < 1e-8) out.set(1, 0, 0);
        out.normalize();
    }

    function syncBox(ctx: SceneContext): void {
        if (!box_group) return;
        // The wireframe is a unit cube scaled to the geometry half-extents; multiply by the
        // object's live scale so it tracks dilation exactly. Position follows the mesh's
        // local position within the rig (origin in practice, but synced for correctness).
        box_group.scale.set(
            box_half.x * ctx.mesh.scale.x,
            box_half.y * ctx.mesh.scale.y,
            box_half.z * ctx.mesh.scale.z,
        );
        box_group.position.copy(ctx.mesh.position);
        box_group.quaternion.copy(ctx.mesh.quaternion);
    }

    // Latest object scale, shown on the panel; updated each frame before paint so the
    // readout reflects live (possibly non-uniform) state.
    const current_scale_readout = new THREE.Vector3(1, 1, 1);

    function paintPanel(): void {
        if (!panel) return;
        const factor = last_factor;
        const s = current_scale_readout;
        panel.draw((g) => {
            g.fillStyle = accent;
            g.font = 'bold 30px "JetBrains Mono", monospace';
            g.textBaseline = "top";
            g.fillText("DILATE", 24, 22);

            g.fillStyle = "rgba(255,255,255,0.45)";
            g.font = '16px "JetBrains Mono", monospace';
            g.fillText("two-hand pinch + spread", 24, 64);

            // Big live scale factor.
            g.fillStyle = "#FFFFFF";
            g.font = 'bold 84px "JetBrains Mono", monospace';
            g.fillText(`${factor.toFixed(2)}x`, 24, 150);

            // Per-axis scale, exposing non-uniform results.
            g.fillStyle = "rgba(255,255,255,0.7)";
            g.font = '18px "JetBrains Mono", monospace';
            g.fillText(
                `x ${s.x.toFixed(2)}  y ${s.y.toFixed(2)}  z ${s.z.toFixed(2)}`,
                24, 268,
            );

            // Engagement hint / status.
            g.fillStyle = engaged ? accent : "rgba(255,255,255,0.35)";
            g.font = '16px "JetBrains Mono", monospace';
            g.fillText(engaged ? "[ scaling ]" : "pinch both hands", 24, 308);
        });
    }

    return {
        id: MenuId.DILATE,

        enter(ctx: SceneContext): void {
            // Capture the object's local-space silhouette so the wireframe box fits it.
            ctx.mesh.geometry.computeBoundingBox();
            const bb = ctx.mesh.geometry.boundingBox;
            if (bb) {
                box_half.set(
                    Math.max((bb.max.x - bb.min.x) * 0.5, 1e-3),
                    Math.max((bb.max.y - bb.min.y) * 0.5, 1e-3),
                    Math.max((bb.max.z - bb.min.z) * 0.5, 1e-3),
                );
            } else {
                box_half.set(1, 1, 1);
            }

            // Translucent wireframe of a unit cube (edges of a 2×2×2 box → ±1 corners),
            // scaled to box_half × mesh.scale each frame in syncBox.
            const unit = new THREE.BoxGeometry(2, 2, 2);
            const edges = new THREE.EdgesGeometry(unit);
            unit.dispose();
            box_material = new THREE.LineBasicMaterial({
                color: new THREE.Color(accent),
                transparent: true,
                opacity: BOX_OPACITY,
                depthWrite: false,
            });
            box_lines = new THREE.LineSegments(edges, box_material);
            box_lines.renderOrder = 5;

            box_group = new THREE.Group();
            box_group.add(box_lines);

            // Eight corner handle cubes at ±1 (visual only).
            handle_geometry = new THREE.BoxGeometry(HANDLE_SIZE, HANDLE_SIZE, HANDLE_SIZE);
            handle_material = new THREE.MeshBasicMaterial({
                color: new THREE.Color(accent),
                transparent: true,
                opacity: HANDLE_OPACITY,
                depthWrite: false,
            });
            for (const cx of [-1, 1]) {
                for (const cy of [-1, 1]) {
                    for (const cz of [-1, 1]) {
                        const h = new THREE.Mesh(handle_geometry, handle_material);
                        h.position.set(cx, cy, cz);
                        // Counter the group's non-uniform scale so handles stay cubic.
                        h.renderOrder = 6;
                        handle_meshes.push(h);
                        box_group.add(h);
                    }
                }
            }

            // Parent the box rig to the mesh's parent (the spin group) so it inherits the
            // same tilt/spin transform and only needs local scale/position/rotation synced.
            const parent = ctx.mesh.parent ?? ctx.scene;
            parent.add(box_group);

            panel = new SpatialPanel(accent);
            ctx.scene.add(panel.object);

            engaged = false;
            last_factor = 1;
            current_scale_readout.copy(ctx.mesh.scale);
            syncBox(ctx);
            paintPanel();
        },

        update(ctx: SceneContext, right: HandPose | null, left: HandPose | null, dt: number): void {
            void dt;

            const both = right !== null && left !== null;
            const right_pinch = right ? pinchAmount(right.landmarks) : 0;
            const left_pinch = left ? pinchAmount(left.landmarks) : 0;

            if (!engaged) {
                // Engage when both hands are present and loosely pinched.
                if (both && right_pinch > PINCH_ENGAGE && left_pinch > PINCH_ENGAGE) {
                    engaged = true;
                    start_dist = pinchPointDist(right!, left!);
                    start_scale.copy(ctx.mesh.scale);
                    handAxisWorld(ctx, right!, left!, start_axis);
                }
            } else {
                // Disengage if a hand is lost or either pinch opens past the release margin.
                if (!both || right_pinch < PINCH_RELEASE || left_pinch < PINCH_RELEASE) {
                    engaged = false;
                } else {
                    const cur = pinchPointDist(right!, left!);
                    const factor = THREE.MathUtils.clamp(cur / start_dist, 0.05, 20);
                    last_factor = factor;

                    // Current hand axis vs. the engage axis: the more the connecting line has
                    // changed (one hand moved more), the more we bias scaling onto that axis.
                    handAxisWorld(ctx, right!, left!, ctx.scratch.v1);
                    const align = Math.abs(ctx.scratch.v1.dot(start_axis)); // 1 = parallel
                    // Symmetric two-hand spread keeps the axis ~parallel → uniform. A single
                    // hand moving rotates the connecting line → align drops → more anisotropy.
                    const aniso = ANISO_STRENGTH * (1 - align);

                    // Per-axis exponent: along the hand axis we apply the full factor; across
                    // it we blend toward 1 (no change) by the anisotropy amount.
                    const ax = start_axis;
                    const wx = 1 - aniso * (1 - Math.abs(ax.x));
                    const wy = 1 - aniso * (1 - Math.abs(ax.y));
                    const wz = 1 - aniso * (1 - Math.abs(ax.z));

                    ctx.mesh.scale.set(
                        THREE.MathUtils.clamp(start_scale.x * Math.pow(factor, wx), SCALE_MIN, SCALE_MAX),
                        THREE.MathUtils.clamp(start_scale.y * Math.pow(factor, wy), SCALE_MIN, SCALE_MAX),
                        THREE.MathUtils.clamp(start_scale.z * Math.pow(factor, wz), SCALE_MIN, SCALE_MAX),
                    );
                }
            }

            current_scale_readout.copy(ctx.mesh.scale);

            // Sync the wireframe box to the object's live transform, then re-place + repaint
            // the panel beside the object. Compute the mesh world position via scratch (the
            // mesh sits inside tilt/spin groups, so its local position is not world).
            syncBox(ctx);

            // Keep corner handle cubes visually cubic despite the group's (possibly
            // non-uniform) scale: counter the group scale on each handle so HANDLE_SIZE
            // stays constant in world units.
            if (box_group) {
                const inv_x = 1 / Math.max(box_group.scale.x, 1e-3);
                const inv_y = 1 / Math.max(box_group.scale.y, 1e-3);
                const inv_z = 1 / Math.max(box_group.scale.z, 1e-3);
                for (const h of handle_meshes) h.scale.set(inv_x, inv_y, inv_z);
            }

            ctx.mesh.updateWorldMatrix(true, false);
            ctx.scratch.v1.setFromMatrixPosition(ctx.mesh.matrixWorld);
            if (panel) {
                panel.placeBeside(ctx.scratch.v1, ctx.camera);
                paintPanel();
            }
        },

        exit(ctx: SceneContext): void {
            if (box_group) {
                (box_group.parent ?? ctx.scene).remove(box_group);
                box_group = null;
            }
            if (box_lines) {
                box_lines.geometry.dispose();
                box_lines = null;
            }
            box_material?.dispose();
            box_material = null;
            handle_geometry?.dispose();
            handle_geometry = null;
            handle_material?.dispose();
            handle_material = null;
            handle_meshes.length = 0;

            if (panel) {
                ctx.scene.remove(panel.object);
                panel.dispose();
                panel = null;
            }
            engaged = false;
        },
    };
}
