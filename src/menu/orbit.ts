// Camera Orbit Mode controller — wrist-rotation drive.
//
// Both hands must be closed fists to engage (left = deadman, right = control).
// While engaged, the right fist drives two things simultaneously:
//
//   punch direction (wrist→middleMCP) delta  →  camera orbit (azimuth + elevation)
//   wrist roll (side vector rotation around punch axis)  →  object rotation about that axis
//
// Orbit is relative-drag: on engage we latch the rig's (θ, φ, r) and the punch azimuth/
// elevation. Each frame the delta from that reference drives the orbit — hands still = camera
// still. Wrist roll is also relative: latch the side vector at engage, each frame measure the
// signed angle it has rotated around punch0, apply the frame-delta to the mesh.
//
// Engage/release use the same 3-frame debounce as the old midpoint controller.
import * as THREE from "three";
import type { HandPose, SceneContext, Vec3 } from "../types";
import { fingerExtended } from "../gesture/predicates";
import type { CameraRig } from "../render/cameraRig";

const WRIST = 0;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
const FINGER_TIPS = [8, 12, 16, 20];
const FINGER_PIPS = [6, 10, 14, 18];

const COMMIT_FRAMES = 3;

// Punch direction maps 1:1 to orbit angle change (1 radian of fist rotation = 1 radian of orbit).
const AZIMUTH_GAIN = 1.0;
const ELEVATION_GAIN = 1.0;

// Module-level scratch — zero per-frame allocation.
const _punch = new THREE.Vector3();
const _side = new THREE.Vector3();
const _cross = new THREE.Vector3();

function isClosedHand(world: Vec3[]): boolean {
    for (let i = 0; i < FINGER_TIPS.length; i++) {
        if (fingerExtended(world, FINGER_TIPS[i], FINGER_PIPS[i])) return false;
    }
    return true;
}

// Wrist → middle MCP, normalized. Writes into `out`.
function punchDir(world: Vec3[], out: THREE.Vector3): THREE.Vector3 {
    const w = world[WRIST], m = world[MIDDLE_MCP];
    return out.set(m.x - w.x, m.y - w.y, m.z - w.z).normalize();
}

// Wrist → pinky MCP, Gram-Schmidt orthogonalized against `punch`. Writes into `out`.
function sideDir(world: Vec3[], punch: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const w = world[WRIST], p = world[PINKY_MCP];
    out.set(p.x - w.x, p.y - w.y, p.z - w.z).normalize();
    return out.addScaledVector(punch, -out.dot(punch)).normalize();
}

// Signed angle (radians) from vector `a` to `b` around `axis` (right-hand rule).
function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
    return Math.atan2(_cross.crossVectors(a, b).dot(axis), a.dot(b));
}

/**
 * Drives the CameraRig and active mesh from a bilateral fist gesture. The caller (main.ts)
 * feeds the true Left/Right poses each frame ONLY while idle, and calls reset() otherwise.
 * Read `active` to drive the gizmo / mini-view.
 */
export class OrbitController {
    private engaged = false;
    private closedFrames = 0;
    private openFrames = 0;

    // Reference state latched on the engage edge.
    private theta0 = 0;
    private phi0 = 0;
    private r0 = 0;
    private punch0 = new THREE.Vector3();       // right-hand punch dir at engage (world)
    private side0 = new THREE.Vector3();        // orthogonalized side dir at engage
    private theta_engage = 0;                   // atan2(punch0.x, punch0.z)
    private phi_engage = 0;                     // asin(punch0.y)
    private prev_twist = 0;                     // twist angle last frame (radians)

    /** True while the camera is being orbited (gizmo + mini-view visible). */
    get active(): boolean {
        return this.engaged;
    }

    /**
     * Per-frame drive. `left` / `right` are true-handedness poses; `rig` is the camera rig;
     * `ctx` provides the active mesh for object rotation.
     */
    update(left: HandPose | null, right: HandPose | null, rig: CameraRig, ctx: SceneContext, _dtMs: number): void {
        if (!left || !right) {
            this.release();
            return;
        }

        const both_closed = isClosedHand(left.world) && isClosedHand(right.world);
        const either_open = !isClosedHand(left.world) || !isClosedHand(right.world);
        this.closedFrames = both_closed ? this.closedFrames + 1 : 0;
        this.openFrames = either_open ? this.openFrames + 1 : 0;

        punchDir(right.world, _punch);

        if (!this.engaged) {
            if (this.closedFrames >= COMMIT_FRAMES) {
                this.theta0 = rig.azimuth;
                this.phi0 = rig.polar;
                this.r0 = rig.radiusValue;
                this.punch0.copy(_punch);
                sideDir(right.world, _punch, this.side0);
                this.theta_engage = Math.atan2(_punch.x, _punch.z);
                this.phi_engage = Math.asin(Math.max(-1, Math.min(1, _punch.y)));
                this.prev_twist = 0;
                this.engaged = true;
            }
            return;
        }

        if (this.openFrames >= COMMIT_FRAMES) {
            this.engaged = false;
            return;
        }

        // Orbit: map punch direction delta to azimuth/elevation change.
        const theta_now = Math.atan2(_punch.x, _punch.z);
        const phi_now = Math.asin(Math.max(-1, Math.min(1, _punch.y)));
        const theta = this.theta0 + AZIMUTH_GAIN * (theta_now - this.theta_engage);
        const phi = this.phi0 + ELEVATION_GAIN * (phi_now - this.phi_engage);
        rig.setOrbit(theta, phi, this.r0);

        // Twist: wrist roll around punch0 → rotate active mesh about that world axis.
        // Side vector is always projected onto punch0 so twist is measured in a fixed plane.
        sideDir(right.world, this.punch0, _side);
        const twist = signedAngle(this.side0, _side, this.punch0);
        const delta_twist = twist - this.prev_twist;
        this.prev_twist = twist;
        if (ctx.mesh) {
            ctx.mesh.rotateOnWorldAxis(this.punch0, delta_twist);
        }
    }

    /** Cancel any in-flight orbit (camera holds committed state). Called every non-idle frame. */
    reset(): void {
        this.release();
    }

    private release(): void {
        this.engaged = false;
        this.closedFrames = 0;
        this.openFrames = 0;
    }
}
