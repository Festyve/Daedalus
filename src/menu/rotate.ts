// §5.4 ROTATE — paradigm: hand-twist quaternion.
//
// The right hand pinches near the object to "grab" its rotation. On engage we snapshot
// the hand's orientation as a reference quaternion Q_start and the mesh's current
// rotation R_start. Each frame we measure the hand orientation again (Q_current) and
// apply the rotation it has swept since engage:
//
//     deltaQ          = Q_current · Q_start⁻¹      (the hand-applied rotation, §5.4)
//     mesh.quaternion = deltaQ · R_start           (premultiply: deltaQ acts in the
//                                                   parent frame, so there is no drift)
//
// Pinch release latches the rotation in place (it is already written to the mesh).
// Quaternions are used throughout — there is NO Euler in the math path, so there is no
// gimbal lock. Euler appears only as a human-readable readout on the panel (§5.4).
//
// Hand orientation is built from the right-hand *world* landmarks (metric 3D, so
// roll/pitch/yaw are all real) via an orthonormal basis:
//     yHand = wrist → indexMCP                       (up the fingers)
//     zHand = (indexMCP-wrist) × (pinkyMCP-wrist)    (palm normal)
//     xHand = yHand × zHand                          (re-orthogonalized, right-handed)
//
// Affordances (§4.3, §5.4): an arcball of three colored TorusGeometry rings (X/Y/Z) around
// the mesh; the ring whose axis the hand is most turning about lights up. Rings live on
// Layer 1 via asMenuLayer() so they always draw above the mesh. A plain-DOM Panel fixed to
// the right shows the live display-only Euler readout.
import * as THREE from "three";
import type { MenuModule, SceneContext, HandPose } from "../types";
import { MenuId } from "../types";
import { Panel } from "./panel";
import { asMenuLayer } from "../render/layers";
import { isPinching, pinchAmount, handScale } from "../gesture/predicates";
import { fingertipToWorld } from "../math/coords";
import { MENU_META } from "../render/tokens";
import { selectedShapes, selectedCount, selectionCenter } from "../core/shapes";

// World-landmark indices used to build the hand basis (§5.4).
const WRIST = 0;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const PINKY_MCP = 17;

// Engage once the pinch closes past this; release once it clearly opens (hysteresis so a
// momentary jitter at the threshold cannot chatter the grab on and off).
const PINCH_ENGAGE = 0.7;
const PINCH_RELEASE = 0.5;
// Proximity (world units) of the index fingertip to the mesh center to allow engage.
const ENGAGE_RADIUS = 2.4;

// Arcball ring geometry: radius sits just outside the unit mesh; thin tube.
const RING_RADIUS = 1.55;
const RING_TUBE = 0.022;
const RING_RADIAL_SEG = 8;
const RING_TUBULAR_SEG = 96;

// Per-axis ring colors (X=red, Y=green, Z=blue — the canonical gizmo convention).
const AXIS_COLOR_X = 0xff4d4d;
const AXIS_COLOR_Y = 0x4dff7a;
const AXIS_COLOR_Z = 0x4d8cff;
// Dim vs. highlighted ring opacity (cheap uniform update — no geometry churn).
const RING_DIM = 0.28;
const RING_HOT = 0.95;

// Below this squared rotation-axis magnitude the delta is ~identity and the dominant
// axis is ill-defined, so no ring is highlighted.
const AXIS_EPS_SQ = 1e-6;

const AXIS_NAMES = ["X", "Y", "Z"] as const;

export function createRotateMenu(): MenuModule {
    const ACCENT = MENU_META[MenuId.ROTATE].accent;

    // ----- affordance objects (created in enter, freed in exit) -----
    let panel: Panel | null = null;
    let arcball: THREE.Group | null = null;
    let rings: THREE.Mesh[] = []; // [X, Y, Z]

    // ----- engage / rotation state (quaternion only; never Euler) -----
    // The whole SELECTION rotates as a rigid group about its centroid: on engage we snapshot the
    // centroid, each selected mesh's start position + quaternion, and the hand orientation; each
    // frame we apply the hand-swept delta to every snapshot (orbiting positions around the
    // centroid AND spinning each mesh). With one shape this reduces to spinning it in place.
    let engaged = false;
    const Q_START_INV = new THREE.Quaternion(); // (Q_start)⁻¹
    const Q_CURRENT = new THREE.Quaternion();    // this frame's hand orientation
    const engageCenter = new THREE.Vector3();    // group centroid at engage
    const engagedMeshes: THREE.Mesh[] = [];      // selection snapshot at engage
    const startPositions: THREE.Vector3[] = [];  // per-mesh position at engage
    const startQuats: THREE.Quaternion[] = [];   // per-mesh quaternion at engage

    // ----- basis scratch (module-owned; zero per-frame alloc, §6.2) -----
    const wrist = new THREE.Vector3();
    const idx_mcp = new THREE.Vector3();
    const pnk_mcp = new THREE.Vector3();
    const x_hand = new THREE.Vector3();
    const y_hand = new THREE.Vector3();
    const z_hand = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const axis_vec = new THREE.Vector3();   // delta rotation axis, for ring highlight
    const mesh_center = new THREE.Vector3(); // group centroid (live)
    const rel_pos = new THREE.Vector3();     // scratch: mesh offset from centroid
    const new_pos = new THREE.Vector3();     // scratch: rotated mesh position
    const euler = new THREE.Euler();         // display-only; never feeds the math path

    // The local X/Y/Z axes a delta rotation can be "closest to", paired with their ring
    // index. Module constants — built once, never reallocated.
    const LOCK_AXES: ReadonlyArray<{ axis: THREE.Vector3; ring: 0 | 1 | 2 }> = [
        { axis: new THREE.Vector3(1, 0, 0), ring: 0 },
        { axis: new THREE.Vector3(0, 1, 0), ring: 1 },
        { axis: new THREE.Vector3(0, 0, 1), ring: 2 },
    ];

    // Copy a world landmark into a Vector3 (MediaPipe metric space).
    function readWorld(hand: HandPose, i: number, out: THREE.Vector3): THREE.Vector3 {
        const w = hand.world[i];
        return out.set(w.x, w.y, w.z);
    }

    // Build the hand-orientation quaternion from the right-hand world landmarks. Returns
    // false if the basis is degenerate (collapsed landmarks) so the caller can hold the
    // last rotation rather than snapping to garbage.
    function computeHandQuat(hand: HandPose, out: THREE.Quaternion): boolean {
        readWorld(hand, WRIST, wrist);
        readWorld(hand, INDEX_MCP, idx_mcp);
        readWorld(hand, PINKY_MCP, pnk_mcp);

        y_hand.copy(idx_mcp).sub(wrist);            // up the fingers
        pnk_mcp.sub(wrist);                         // across the palm (reused as scratch)
        z_hand.copy(y_hand).cross(pnk_mcp);         // palm normal
        if (y_hand.lengthSq() < 1e-10 || z_hand.lengthSq() < 1e-10) return false;
        y_hand.normalize();
        z_hand.normalize();
        x_hand.copy(y_hand).cross(z_hand).normalize(); // re-orthogonalized right-handed x
        basis.makeBasis(x_hand, y_hand, z_hand);
        out.setFromRotationMatrix(basis);
        return true;
    }

    // The local axis (0=X,1=Y,2=Z) closest to a delta rotation's axis of rotation, used to
    // light the matching arcball ring while rotating. Returns null near identity.
    function dominantAxis(delta: THREE.Quaternion): 0 | 1 | 2 | null {
        // A quaternion's rotation axis is the normalized vector part; near identity it is
        // ill-defined, so we report "no axis" and dim every ring.
        axis_vec.set(delta.x, delta.y, delta.z);
        if (axis_vec.lengthSq() < AXIS_EPS_SQ) return null;
        let best: 0 | 1 | 2 = 0;
        let best_dot = -1;
        for (const entry of LOCK_AXES) {
            const dot = Math.abs(axis_vec.dot(entry.axis));
            if (dot > best_dot) { best_dot = dot; best = entry.ring; }
        }
        return best;
    }

    // Highlight one ring (or none) by axis index; others fade to dim. Opacity-only update.
    function highlightRing(active: 0 | 1 | 2 | null): void {
        for (let i = 0; i < rings.length; i++) {
            const mat = rings[i].material as THREE.MeshBasicMaterial;
            mat.opacity = i === active ? RING_HOT : RING_DIM;
        }
    }

    // Index fingertip → world via the shared unprojection (§12). Writes ctx.scratch.v1 and
    // returns it; reuses ctx.scratch.ray / .plane as documented in fingertipToWorld.
    function fingertipWorld(ctx: SceneContext, hand: HandPose): THREE.Vector3 {
        return fingertipToWorld(
            hand.landmarks[INDEX_TIP], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v1,
        );
    }

    function makeRing(color: number, orient: 0 | 1 | 2): THREE.Mesh {
        const geo = new THREE.TorusGeometry(
            RING_RADIUS, RING_TUBE, RING_RADIAL_SEG, RING_TUBULAR_SEG,
        );
        const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: RING_DIM,
            toneMapped: false,
        });
        const ring = new THREE.Mesh(geo, mat);
        // A TorusGeometry lies in its local XY plane (hole axis = local Z). Orient each ring
        // so its hole axis aligns with world X / Y / Z respectively.
        if (orient === 0) ring.rotation.y = Math.PI / 2;      // hole axis → X
        else if (orient === 1) ring.rotation.x = Math.PI / 2; // hole axis → Y
        // orient === 2: default, hole axis → Z
        return ring;
    }

    // Repaint the panel body: title, status, and the display-only Euler (degrees). The
    // Euler is derived from the mesh quaternion purely for the readout — it never feeds the
    // rotation math (which stays quaternion-only, §5.4).
    function paintPanel(mesh: THREE.Mesh, active: 0 | 1 | 2 | null): void {
        if (!panel) return;
        euler.setFromQuaternion(mesh.quaternion, "XYZ");
        const deg = (r: number) => (r * 180 / Math.PI).toFixed(0);
        const axis_label = active === null ? "—" : AXIS_NAMES[active];
        const status = engaged ? "grabbing" : "pinch to grab";
        panel.setBody(
            `<div style="font-size:11px;letter-spacing:0.06em;color:rgba(255,255,255,0.55);` +
                `text-transform:uppercase;margin-bottom:14px;">// ${status}</div>` +
            `<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;` +
                `font-size:22px;font-variant-numeric:tabular-nums;">` +
                `<span style="color:#ff4d4d;">X</span><span>${deg(euler.x)}°</span>` +
                `<span style="color:#4dff7a;">Y</span><span>${deg(euler.y)}°</span>` +
                `<span style="color:#4d8cff;">Z</span><span>${deg(euler.z)}°</span>` +
            `</div>` +
            `<div style="margin-top:16px;font-size:11px;letter-spacing:0.06em;` +
                `text-transform:uppercase;color:${ACCENT};">turn axis ${axis_label}</div>`,
        );
    }

    return {
        id: MenuId.ROTATE,

        enter(ctx: SceneContext): void {
            engaged = false;

            // Nothing selected → nothing to rotate; build no affordances and open no panel.
            if (selectedCount(ctx) === 0 || !ctx.mesh) return;

            arcball = new THREE.Group();
            const ring_x = makeRing(AXIS_COLOR_X, 0);
            const ring_y = makeRing(AXIS_COLOR_Y, 1);
            const ring_z = makeRing(AXIS_COLOR_Z, 2);
            rings = [ring_x, ring_y, ring_z];
            arcball.add(ring_x, ring_y, ring_z);
            // HARD RULE (§4.3): arcball is menu geometry — renderOrder=1, depthTest=false,
            // depthWrite=false, applied to the group and every ring.
            asMenuLayer(arcball);
            ctx.scene.add(arcball);

            panel = new Panel({ title: "Rotate", accent: ACCENT });
            panel.setInstructions("Right pinch near object · twist to rotate · release to latch");
            paintPanel(ctx.mesh, null);
            panel.show();
        },

        update(ctx: SceneContext, right: HandPose | null, _left: HandPose | null, _dt: number): void {
            // Nothing selected or affordances never built: nothing to do.
            const primary = ctx.mesh;
            if (!primary || !arcball || selectedCount(ctx) === 0) return;

            // Keep the arcball centered on the SELECTION centroid (the pivot the group orbits).
            selectionCenter(ctx, mesh_center);
            arcball.position.copy(mesh_center);

            if (!right) {
                // Hand lost: release any grab and hold the group where it is.
                engaged = false;
                highlightRing(null);
                paintPanel(primary, null);
                return;
            }

            const lm = right.landmarks;
            const s = handScale(right.world);

            // --- engage / release with hysteresis ---
            if (!engaged) {
                // Engage requires a firm pinch AND the index fingertip near the group centroid.
                if (isPinching(lm, s) && pinchAmount(lm, s) >= PINCH_ENGAGE) {
                    const tip_world = fingertipWorld(ctx, right);
                    if (tip_world.distanceTo(mesh_center) <= ENGAGE_RADIUS &&
                        computeHandQuat(right, Q_CURRENT)) {
                        // Snapshot the reference: the centroid, each selected mesh's start
                        // pose, and the hand orientation. deltaQ is measured against this.
                        Q_START_INV.copy(Q_CURRENT).invert();
                        engageCenter.copy(mesh_center);
                        engagedMeshes.length = 0;
                        startPositions.length = 0;
                        startQuats.length = 0;
                        for (const m of selectedShapes(ctx)) {
                            engagedMeshes.push(m);
                            startPositions.push(m.position.clone());
                            startQuats.push(m.quaternion.clone());
                        }
                        engaged = true;
                    }
                }
            } else if (pinchAmount(lm, s) <= PINCH_RELEASE) {
                // Release: latch the rotation already written to the meshes.
                engaged = false;
            }

            // --- apply rotation to the whole group while engaged ---
            let active: 0 | 1 | 2 | null = null;
            if (engaged && computeHandQuat(right, Q_CURRENT)) {
                // deltaQ = Q_current · Q_start⁻¹  → scratch.q1 (§5.4). Quaternion only.
                ctx.scratch.q1.multiplyQuaternions(Q_CURRENT, Q_START_INV);
                active = dominantAxis(ctx.scratch.q1);
                // Rigid-body transform about the engage-time centroid: each mesh orbits the
                // centroid AND spins. Premultiply against the engage snapshot so there is no
                // incremental drift. (With one shape, rel_pos = 0 → it spins in place.)
                for (let i = 0; i < engagedMeshes.length; i++) {
                    const m = engagedMeshes[i];
                    rel_pos.copy(startPositions[i]).sub(engageCenter).applyQuaternion(ctx.scratch.q1);
                    new_pos.copy(engageCenter).add(rel_pos);
                    m.position.copy(new_pos);
                    m.quaternion.copy(startQuats[i]).premultiply(ctx.scratch.q1);
                }
            }

            highlightRing(active);
            paintPanel(primary, active);
        },

        exit(ctx: SceneContext): void {
            if (arcball) {
                ctx.scene.remove(arcball);
                for (const ring of rings) {
                    ring.geometry.dispose();
                    (ring.material as THREE.MeshBasicMaterial).dispose();
                }
                rings = [];
                arcball = null;
            }
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            engaged = false;
        },
    };
}
