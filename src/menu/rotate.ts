// §6.4 ROTATE — paradigm: hand-twist quaternion.
//
// The right hand pinches near the object to "grab" its rotation. On engage we
// snapshot the hand's orientation as a reference quaternion Q_start and the mesh's
// current rotation R_start. Each frame we measure the hand orientation again
// (Q_current) and apply the rotation it has swept since engage:
//
//     deltaQ = Q_current · Q_start⁻¹      (the hand-applied rotation, §13.4)
//     mesh.quaternion = deltaQ · R_start  (premultiply so deltaQ acts in the
//                                          parent frame, never accumulating drift)
//
// Quaternions are used throughout — there is NO Euler in the math path, so there is
// no gimbal lock. Euler appears only as a human-readable readout on the panel.
//
// Hand orientation is built from the right-hand *world* landmarks (metric 3D, so
// roll/pitch/yaw are all real) via an orthonormal basis:
//     yHand   = wrist → indexMCP            (up the fingers)
//     zHand   = (indexMCP-wrist) × (pinkyMCP-wrist)   (palm normal)
//     xHand   = yHand × zHand               (re-orthogonalized, right-handed)
//
// Affordances (§6.4, §11.5): an arcball of three colored TorusGeometry rings (X/Y/Z)
// around the mesh; the ring whose axis the hand is turning about lights up. A
// SpatialPanel shows the live Euler readout and the axis-lock state.
//
// Axis lock (§6.4): a brief right-hand "gun" pose locks rotation to the X/Y/Z axis
// closest to the pointing index direction; subsequent twist is constrained to that
// single axis via swing-twist decomposition. Another "gun" clears the lock.
import * as THREE from "three";
import type { MenuModule, SceneContext, HandPose } from "../types";
import { MenuId } from "../types";
import { SpatialPanel, drawPanelHints } from "./spatialPanel";
import { MENU_HINTS } from "../ui/gestureGuide";
import { classify, pinchAmount } from "../gesture/predicates";
import { fingertipToWorld } from "../math/coords";
import { MENU_META } from "../render/tokens";

// World-landmark indices used to build the hand basis (§6.4).
const WRIST = 0;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const PINKY_MCP = 17;

// Engage when the pinch closes past this and the fingertip is near the object.
const PINCH_ENGAGE = 0.7;
const PINCH_RELEASE = 0.5; // hysteresis: release only once clearly open
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
// Dim vs. highlighted ring opacity (cheap uniform update, §12.2).
const RING_DIM = 0.28;
const RING_HOT = 0.95;

// "Gun" pose must persist this long (ms) before it toggles the axis lock, so a
// transient classification blip can't flip it.
const GUN_HOLD_MS = 220;

// Local mesh axes the lock can snap to, paired with their ring index (0=X,1=Y,2=Z).
const LOCK_AXES: ReadonlyArray<{ axis: THREE.Vector3; ring: 0 | 1 | 2 }> = [
    { axis: new THREE.Vector3(1, 0, 0), ring: 0 },
    { axis: new THREE.Vector3(0, 1, 0), ring: 1 },
    { axis: new THREE.Vector3(0, 0, 1), ring: 2 },
];

export function createRotateMenu(): MenuModule {
    const accent = MENU_META[MenuId.ROTATE].accent;

    // ----- affordance objects (created in enter, freed in exit) -----
    let panel: SpatialPanel | null = null;
    let arcball: THREE.Group | null = null;
    let rings: THREE.Mesh[] = []; // [X, Y, Z]

    // ----- engage / rotation state -----
    let engaged = false;
    const Q_START_INV = new THREE.Quaternion(); // (Q_start)⁻¹
    const R_START = new THREE.Quaternion();      // mesh rotation at engage
    const Q_CURRENT = new THREE.Quaternion();    // this frame's hand orientation

    // ----- axis lock state -----
    let lockedRing: 0 | 1 | 2 | null = null;
    let gunMs = 0;          // how long a gun pose has been held this episode
    let gunConsumed = false; // prevents repeat toggles within one continuous gun hold

    // ----- basis scratch (module-owned; zero per-frame alloc, §12.2) -----
    const wrist = new THREE.Vector3();
    const idxMcp = new THREE.Vector3();
    const pnkMcp = new THREE.Vector3();
    const idxTip = new THREE.Vector3();
    const xHand = new THREE.Vector3();
    const yHand = new THREE.Vector3();
    const zHand = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const aimDir = new THREE.Vector3();    // index direction, world
    const twistAxisV = new THREE.Vector3();
    const meshCenter = new THREE.Vector3();
    const euler = new THREE.Euler();

    // Copy a world landmark into a Vector3 (MediaPipe metric space).
    function readWorld(hand: HandPose, i: number, out: THREE.Vector3): THREE.Vector3 {
        const w = hand.world[i];
        return out.set(w.x, w.y, w.z);
    }

    // Build Q_current from the right-hand world landmarks. Returns false if the basis
    // is degenerate (collapsed landmarks) so the caller can hold the last rotation.
    function computeHandQuat(hand: HandPose, out: THREE.Quaternion): boolean {
        readWorld(hand, WRIST, wrist);
        readWorld(hand, INDEX_MCP, idxMcp);
        readWorld(hand, PINKY_MCP, pnkMcp);

        yHand.copy(idxMcp).sub(wrist);              // up the fingers
        pnkMcp.sub(wrist);                          // across the palm (reused as scratch)
        zHand.copy(yHand).cross(pnkMcp);            // palm normal
        if (yHand.lengthSq() < 1e-10 || zHand.lengthSq() < 1e-10) return false;
        yHand.normalize();
        zHand.normalize();
        xHand.copy(yHand).cross(zHand).normalize(); // re-orthogonalized right-handed x
        basis.makeBasis(xHand, yHand, zHand);
        out.setFromRotationMatrix(basis);
        return true;
    }

    // World-space index pointing direction (indexMCP → indexTip).
    function computeAimDir(hand: HandPose, out: THREE.Vector3): boolean {
        readWorld(hand, INDEX_MCP, idxMcp);
        readWorld(hand, INDEX_TIP, idxTip);
        out.copy(idxTip).sub(idxMcp);
        if (out.lengthSq() < 1e-10) return false;
        out.normalize();
        return true;
    }

    // Pick the arcball axis (world X/Y/Z) whose direction is closest (by |dot|) to the
    // world-space index aim. Rotation is applied in the world-aligned parent frame and
    // the rings are world-aligned, so the lock axis is chosen in world space too — the
    // highlighted ring is exactly the axis the constrained twist turns about.
    function nearestLockRing(worldAim: THREE.Vector3): 0 | 1 | 2 {
        let best: 0 | 1 | 2 = 0;
        let bestDot = -1;
        for (const entry of LOCK_AXES) {
            const dot = Math.abs(worldAim.dot(entry.axis));
            if (dot > bestDot) { bestDot = dot; best = entry.ring; }
        }
        return best;
    }

    // Swing-twist: constrain a full delta rotation to its twist component about a unit
    // axis k, so axis-locked rotation only turns about that one axis (no gimbal lock).
    function constrainToAxis(delta: THREE.Quaternion, k: THREE.Vector3, out: THREE.Quaternion): void {
        twistAxisV.set(delta.x, delta.y, delta.z);
        const dot = twistAxisV.dot(k);
        out.set(k.x * dot, k.y * dot, k.z * dot, delta.w);
        if (out.lengthSq() < 1e-12) { out.identity(); return; } // 180° edge case
        out.normalize();
    }

    // Highlight one ring (or none) by axis index; others fade to dim.
    function highlightRing(active: 0 | 1 | 2 | null): void {
        for (let i = 0; i < rings.length; i++) {
            const mat = rings[i].material as THREE.MeshBasicMaterial;
            mat.opacity = i === active ? RING_HOT : RING_DIM;
        }
    }

    // Repaint the panel: title, live Euler (degrees), and the lock state.
    function paintPanel(active: 0 | 1 | 2 | null): void {
        if (!panel) return;
        euler.setFromQuaternion(panelQuat, "XYZ"); // display-only; never feeds the math
        const deg = (r: number) => (r * 180 / Math.PI).toFixed(0).padStart(4, " ");
        const lockLabel = lockedRing === null
            ? "FREE"
            : `LOCK ${AXIS_NAMES[lockedRing]}`;
        const axisLabel = active === null ? "--" : AXIS_NAMES[active];
        panel.draw((g, w, h) => {
            g.fillStyle = accent;
            g.font = 'bold 30px "JetBrains Mono", monospace';
            g.fillText("ROTATE", 24, 26);

            g.font = '18px "JetBrains Mono", monospace';
            g.fillStyle = "rgba(255,255,255,0.55)";
            g.fillText(engaged ? "// grabbing" : "// pinch to grab", 24, 70);

            g.font = '26px "JetBrains Mono", monospace';
            g.fillStyle = "#FFFFFF";
            g.fillText(`X ${deg(euler.x)}°`, 24, 120);
            g.fillText(`Y ${deg(euler.y)}°`, 24, 158);
            g.fillText(`Z ${deg(euler.z)}°`, 24, 196);

            // Lock + active-axis chips along the bottom.
            g.font = 'bold 22px "JetBrains Mono", monospace';
            g.fillStyle = lockedRing === null ? "rgba(255,255,255,0.45)" : accent;
            g.fillText(lockLabel, 24, 300);
            g.fillStyle = "rgba(255,255,255,0.45)";
            g.fillText(`turn ${axisLabel}`, w - 200, 300);

            // Lock hint.
            g.font = '15px "JetBrains Mono", monospace';
            g.fillStyle = "rgba(255,255,255,0.35)";
            g.fillText('"gun" pose = lock axis', 24, 340);

            // Operate hints sit in the open band above the lock/turn chips (y=300).
            drawPanelHints(g, w, h, MENU_HINTS[MenuId.ROTATE], accent, 100);
        });
    }

    // The quaternion the panel reads for its Euler display: the mesh rotation. Kept as
    // a field so paintPanel can read it without re-querying the mesh.
    const panelQuat = new THREE.Quaternion();
    const AXIS_NAMES = ["X", "Y", "Z"] as const;

    function makeRing(color: number, orient: 0 | 1 | 2): THREE.Mesh {
        const geo = new THREE.TorusGeometry(
            RING_RADIUS, RING_TUBE, RING_RADIAL_SEG, RING_TUBULAR_SEG,
        );
        const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: RING_DIM,
            depthWrite: false,
            toneMapped: false,
        });
        const ring = new THREE.Mesh(geo, mat);
        // A TorusGeometry lies in its local XY plane (hole axis = local Z). Orient each
        // ring so its hole axis aligns with world X / Y / Z respectively.
        if (orient === 0) ring.rotation.y = Math.PI / 2;   // hole axis → X
        else if (orient === 1) ring.rotation.x = Math.PI / 2; // hole axis → Y
        // orient === 2: default, hole axis → Z
        ring.renderOrder = 9;
        return ring;
    }

    return {
        id: MenuId.ROTATE,

        enter(ctx: SceneContext): void {
            engaged = false;
            lockedRing = null;
            gunMs = 0;
            gunConsumed = false;

            arcball = new THREE.Group();
            const ringX = makeRing(AXIS_COLOR_X, 0);
            const ringY = makeRing(AXIS_COLOR_Y, 1);
            const ringZ = makeRing(AXIS_COLOR_Z, 2);
            rings = [ringX, ringY, ringZ];
            arcball.add(ringX, ringY, ringZ);
            ctx.scene.add(arcball);

            panel = new SpatialPanel(accent);
            ctx.scene.add(panel.object);

            // Initial paint reflects the mesh's current rotation.
            panelQuat.copy(ctx.mesh.quaternion);
            paintPanel(null);
        },

        update(ctx: SceneContext, right: HandPose | null, _left: HandPose | null, dt: number): void {
            if (!arcball || !panel) return;

            // Keep the arcball centered on the mesh in world space (the mesh lives in
            // tilt/spin groups, so its world position can differ from origin).
            ctx.mesh.updateWorldMatrix(true, false);
            ctx.mesh.getWorldPosition(meshCenter);
            arcball.position.copy(meshCenter);
            panel.placeBeside(meshCenter, ctx.camera);

            let activeAxis: 0 | 1 | 2 | null = lockedRing;

            if (!right) {
                // No hand: release any grab, hold the mesh where it is.
                engaged = false;
                gunMs = 0;
                gunConsumed = false;
                highlightRing(activeAxis);
                panelQuat.copy(ctx.mesh.quaternion);
                paintPanel(activeAxis);
                return;
            }

            const lm = right.landmarks;
            const gesture = classify(lm);
            const pinch = pinchAmount(lm);

            // --- axis-lock toggle on a held "gun" pose (§6.4) ---
            if (gesture.name === "gun") {
                gunMs += dt * 1000;
                if (gunMs >= GUN_HOLD_MS && !gunConsumed) {
                    if (computeAimDir(right, aimDir)) {
                        const ring = nearestLockRing(aimDir);
                        // Toggle: same axis again clears the lock.
                        lockedRing = lockedRing === ring ? null : ring;
                        activeAxis = lockedRing;
                    }
                    gunConsumed = true; // one toggle per continuous hold
                }
            } else {
                gunMs = 0;
                gunConsumed = false;
            }

            // --- engage / release with hysteresis ---
            // Engage requires the fingertip near the object (world-space proximity).
            if (!engaged) {
                if (pinch >= PINCH_ENGAGE) {
                    // Index fingertip in world space via the shared unprojection.
                    const tipWorld = fingertipWorld(ctx, lm);
                    if (tipWorld.distanceTo(meshCenter) <= ENGAGE_RADIUS) {
                        if (computeHandQuat(right, Q_CURRENT)) {
                            Q_START_INV.copy(Q_CURRENT).invert();
                            R_START.copy(ctx.mesh.quaternion);
                            engaged = true;
                        }
                    }
                }
            } else if (pinch <= PINCH_RELEASE) {
                // Release: latch the current rotation (already written to the mesh).
                engaged = false;
            }

            // --- apply rotation while engaged ---
            if (engaged && computeHandQuat(right, Q_CURRENT)) {
                // deltaQ = Q_current · Q_start⁻¹  → scratch.q1 (§13.4).
                ctx.scratch.q1.multiplyQuaternions(Q_CURRENT, Q_START_INV);

                if (lockedRing !== null) {
                    // Constrain the delta to a single mesh-local axis (swing-twist).
                    constrainToAxis(ctx.scratch.q1, LOCK_AXES[lockedRing].axis, ctx.scratch.q1);
                    activeAxis = lockedRing;
                } else {
                    // Free rotate: highlight the ring whose axis the hand is most
                    // turning about (the delta's dominant rotation axis, mesh-local).
                    activeAxis = dominantAxis(ctx.scratch.q1);
                }

                // mesh.quaternion = deltaQ · R_start (premultiply applies delta in the
                // parent frame; no incremental accumulation, so it stays drift-free).
                ctx.mesh.quaternion.copy(R_START).premultiply(ctx.scratch.q1);
            }

            highlightRing(activeAxis);
            panelQuat.copy(ctx.mesh.quaternion);
            paintPanel(activeAxis);
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
                ctx.scene.remove(panel.object);
                panel.dispose();
                panel = null;
            }
            engaged = false;
            lockedRing = null;
        },
    };

    // ----- helpers that need module scratch but no per-instance state -----

    // Index fingertip → world via the shared unprojection (§13.2). Writes ctx.scratch.v1
    // and returns it; uses ctx.scratch.ray / plane as documented in coords.fingertipToWorld.
    function fingertipWorld(ctx: SceneContext, lm: HandPose["landmarks"]): THREE.Vector3 {
        return fingertipToWorld(
            lm[INDEX_TIP], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v1,
        );
    }

    // The mesh-local axis (0=X,1=Y,2=Z) closest to a delta rotation's axis of rotation,
    // used to light the matching arcball ring during free rotate.
    function dominantAxis(delta: THREE.Quaternion): 0 | 1 | 2 {
        // The rotation axis is the normalized vector part of the quaternion; near
        // identity it is ill-defined, so fall back to no strong axis (default X but
        // dim — the magnitude is tiny anyway).
        twistAxisV.set(delta.x, delta.y, delta.z);
        if (twistAxisV.lengthSq() < 1e-8) return lockedRing ?? 0;
        let best: 0 | 1 | 2 = 0;
        let bestDot = -1;
        for (const entry of LOCK_AXES) {
            const dot = Math.abs(twistAxisV.dot(entry.axis));
            if (dot > bestDot) { bestDot = dot; best = entry.ring; }
        }
        return best;
    }
}
