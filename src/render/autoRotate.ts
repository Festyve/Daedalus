// Idle auto-spin for the sculptable object (SPEC §9.6: "Object rotates — slow auto-spin
// or hand-twist. Camera mostly static so the framing reads consistently.").
//
// The object slowly rotates about its Y axis while the user is NOT focused on it, and
// eases to a stop the moment they are. "Focused" is decided by the caller (the main loop —
// a tool is active, the carousel is open, or a hand is in frame) and passed in as
// `idle = false`. This module owns only the damped angular-velocity easing, so the spin
// ramps up / winds down smoothly instead of snapping on or off.
//
// It rotates the MESH (never the camera), preserving the fixed camera framing of §9.6.
// Zero per-frame allocation: only scalar state is mutated.
import type * as THREE from "three";

// Idle angular velocity, radians per millisecond. 2π / 16000 ≈ one slow revolution every
// ~16 seconds — alive, but unhurried.
const IDLE_SPEED = 0.00039;

// Exponential approach rate (per ms) of the current velocity toward its target, applied as
// 1 - e^(-RAMP·dt) so the easing is frame-rate independent. Higher = snappier spin-up/down.
const RAMP = 0.0035;

// Below this speed the spin is treated as stopped (skip the rotation write entirely).
const EPS = 1e-7;

export class AutoRotate {
    private velocity = 0; // current spin speed, rad/ms

    /**
     * Advance the object's idle spin by one frame.
     * @param mesh  the sculptable object (null before the first shape is added — no-op).
     * @param idle  true = not focused (spin up); false = focused (ease to a stop).
     * @param dtMs  clamped per-frame delta in milliseconds.
     */
    update(mesh: THREE.Object3D | null, idle: boolean, dtMs: number): void {
        const target = idle ? IDLE_SPEED : 0;
        const k = 1 - Math.exp(-RAMP * dtMs);
        this.velocity += (target - this.velocity) * k;
        if (mesh && this.velocity > EPS) {
            mesh.rotation.y += this.velocity * dtMs;
        }
    }
}
