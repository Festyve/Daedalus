// Orbit camera rig (SPEC §9.6 reworked — Camera Orbit Mode).
//
// The v5 camera was "fixed framing" driven by an independent idle-parallax rAF that, every
// frame, overwrote camera.position and called lookAt(0,0,0). That left no place to stand a
// real orbit. This rig REPLACES that loop: it owns the camera as spherical state about a
// fixed target and is driven from the single master loop (§2) via update(dt).
//
//   position = target + r · ( cosφ·sinθ , sinφ , cosφ·cosθ )
//
//   θ (azimuth)   — orbit around world Y. θ=0 places the camera on +Z (the v5 base view).
//   φ (elevation) — orbit around the horizon. +φ lifts the camera above the XZ plane.
//   r (radius)    — distance from target (zoom).
//
// The committed (θ, φ, r) is the orbit state the OrbitController writes (menu/orbit.ts). The
// old idle parallax survives as a tiny Lissajous DRIFT added on top of θ/φ at render time so
// the frame still breathes — it never accumulates into the committed state, so releasing an
// orbit leaves the camera exactly where the user left it (plus the same sub-degree breath).
//
// HOT LOOP: zero per-frame allocation — one module-owned scratch vector, reused every update.
import * as THREE from "three";

// Elevation is clamped just short of the poles so the camera never flips over the top (where
// lookAt's up-vector degenerates) and azimuth stays meaningful.
const MAX_PHI = THREE.MathUtils.degToRad(85);
// Zoom bounds (world units). Base radius is ~5; allow a close-in inspect and a pulled-back
// overview without letting a wild gesture clip into the object or fly to infinity.
const RADIUS_MIN = 2.0;
const RADIUS_MAX = 14.0;

// Idle breath: a slow Lissajous drift on θ/φ (radians), matching the feel of the old
// position parallax (±0.12 / ±0.07 world units at r≈5 ≈ ±0.024 / ±0.014 rad). Speeds are the
// original parallax speeds (rad/ms). The drift is layered on at render time only.
const DRIFT_THETA = 0.024;
const DRIFT_PHI = 0.014;
const DRIFT_SPEED_X = 0.00021;
const DRIFT_SPEED_Y = 0.00033;

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Spherical orbit controller for the scene camera. Construct once with the live camera; the
 * rig seeds its (θ, φ, r) from the camera's current position relative to `target`, so the
 * opening frame is identical to the v5 base framing. Thereafter update(dt) is the ONLY thing
 * that moves the camera (the independent parallax rAF is removed in scene.ts).
 */
export class CameraRig {
    private readonly camera: THREE.PerspectiveCamera;
    private readonly target: THREE.Vector3;

    // Committed orbit state (what OrbitController reads back + writes). Drift is NOT stored here.
    private theta: number;
    private phi: number;
    private radius: number;

    // Idle-drift phase accumulator (ms). Internal so the rig stays deterministic for tests
    // (no performance.now()): the master loop feeds dt.
    private driftMs = 0;

    // Reused scratch — zero per-frame allocation.
    private readonly pos = new THREE.Vector3();

    constructor(camera: THREE.PerspectiveCamera, target: THREE.Vector3 = new THREE.Vector3(0, 0, 0)) {
        this.camera = camera;
        this.target = target.clone();

        const off = this.pos.copy(camera.position).sub(this.target);
        this.radius = clamp(off.length() || RADIUS_MIN, RADIUS_MIN, RADIUS_MAX);
        this.phi = clamp(Math.asin(clamp(off.y / this.radius, -1, 1)), -MAX_PHI, MAX_PHI);
        // atan2(x, z): θ=0 ⇒ camera on +Z, matching position = (0,*,+r).
        this.theta = Math.atan2(off.x, off.z);
    }

    /** Committed azimuth (radians), drift excluded — the value OrbitController latches at engage. */
    get azimuth(): number {
        return this.theta;
    }

    /** Committed elevation (radians), drift excluded. */
    get polar(): number {
        return this.phi;
    }

    /** Committed radius (world units). */
    get radiusValue(): number {
        return this.radius;
    }

    /** Orbit center (cloned — callers must not mutate the rig's target through this). */
    getTarget(out: THREE.Vector3): THREE.Vector3 {
        return out.copy(this.target);
    }

    /**
     * Set the committed orbit state. Elevation and radius are clamped to their safe ranges;
     * azimuth wraps freely. OrbitController calls this every frame while engaged.
     */
    setOrbit(theta: number, phi: number, radius: number): void {
        this.theta = theta;
        this.phi = clamp(phi, -MAX_PHI, MAX_PHI);
        this.radius = clamp(radius, RADIUS_MIN, RADIUS_MAX);
    }

    /**
     * Advance the idle breath and write the camera transform from (committed state + drift).
     * dt is the per-frame delta in milliseconds. Always re-aims the camera at the target.
     */
    update(dtMs: number): void {
        this.driftMs += dtMs;
        const drift_theta = Math.sin(this.driftMs * DRIFT_SPEED_X) * DRIFT_THETA;
        const drift_phi = Math.sin(this.driftMs * DRIFT_SPEED_Y) * DRIFT_PHI;

        const th = this.theta + drift_theta;
        const ph = clamp(this.phi + drift_phi, -MAX_PHI, MAX_PHI);
        const cos_ph = Math.cos(ph);

        this.pos.set(
            this.radius * cos_ph * Math.sin(th),
            this.radius * Math.sin(ph),
            this.radius * cos_ph * Math.cos(th),
        ).add(this.target);

        this.camera.position.copy(this.pos);
        this.camera.lookAt(this.target);
    }
}
