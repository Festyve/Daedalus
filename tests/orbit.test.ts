// OrbitController — wrist-rotation camera orbit.
//
// Both hands must be closed fists to engage (left = deadman, right = control).
// Right fist punch direction (wrist→middleMCP) drives azimuth + elevation; wrist roll
// (side vector rotation around punch axis) rotates the active mesh. Radius is fixed.
//
// Tests synthesize world landmarks with specific punch directions and side vectors so
// the controller geometry can be exercised headlessly without WebGL/DOM.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import type { HandPose, Handedness, SceneContext, Vec3 } from "../src/types";
import { OrbitController } from "../src/menu/orbit";
import { CameraRig } from "../src/render/cameraRig";

const COMMIT_FRAMES = 3;
const N_LANDMARKS = 21;
const HAND_SCALE = 0.09;

function v(x: number, y: number, z: number): Vec3 { return { x, y, z }; }

// World landmarks for a closed fist with punch direction (px,py,pz) and side (sx,sy,sz).
// Fingers curled: TIP at dist 0.03 from wrist < PIP at dist 0.05 → isClosedHand() true.
function closedWorldDir(px: number, py: number, pz: number, sx = 1, sy = 0, sz = 0): Vec3[] {
    const plen = Math.sqrt(px * px + py * py + pz * pz);
    const ps = 0.09 / plen;
    const lm: Vec3[] = Array.from({ length: N_LANDMARKS }, () => v(0, 0, 0));
    lm[0]  = v(0, 0, 0);
    lm[9]  = v(px * ps, py * ps, pz * ps);          // middleMCP → punch direction
    lm[17] = v(sx * 0.09, sy * 0.09, sz * 0.09);   // pinkyMCP → side reference
    for (const pip of [6, 10, 14, 18]) lm[pip] = v(0, 0.05, 0);
    for (const tip of [8, 12, 16, 20]) lm[tip] = v(0, 0.03, 0);
    return lm;
}

// World landmarks for an open palm (fingers extended + spread).
function openWorld(): Vec3[] {
    const lm: Vec3[] = Array.from({ length: N_LANDMARKS }, () => v(0, 0, 0));
    lm[0]  = v(0, 0, 0);
    lm[9]  = v(0, 0.09, 0);
    for (const pip of [6, 10, 14, 18]) lm[pip] = v(0, 0.07, 0);
    lm[8]  = v(-0.06, 0.12, 0);
    lm[12] = v(-0.02, 0.13, 0);
    lm[16] = v(0.02,  0.13, 0);
    lm[20] = v(0.06,  0.12, 0);
    lm[3]  = v(0.04,  0.03, 0);
    lm[4]  = v(0.08,  0.05, 0);
    return lm;
}

function hand(handedness: Handedness, world: Vec3[]): HandPose {
    const lm: Vec3[] = Array.from({ length: N_LANDMARKS }, () => v(0.5, 0.5, 0));
    return { handedness, landmarks: lm, world, confidence: 1, handScale: HAND_SCALE, timestamp: 0 };
}

// Default closed fist: punch along +Z, side along +X
function closed(handedness: Handedness, px = 0, py = 0, pz = 1, sx = 1, sy = 0, sz = 0): HandPose {
    return hand(handedness, closedWorldDir(px, py, pz, sx, sy, sz));
}
function open(handedness: Handedness): HandPose {
    return hand(handedness, openWorld());
}

function baseRig(): CameraRig {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.set(0, 0.35, 5);
    cam.lookAt(0, 0, 0);
    return new CameraRig(cam);
}

function mockCtx(mesh: THREE.Mesh | null = null): SceneContext {
    return { mesh } as SceneContext;
}

// Engage both hands closed (default punch +Z, side +X) for COMMIT_FRAMES.
function engage(orbit: OrbitController, rig: CameraRig, ctx: SceneContext): void {
    for (let i = 0; i < COMMIT_FRAMES; i++) {
        orbit.update(closed("Left"), closed("Right"), rig, ctx, 16);
    }
}

describe("OrbitController — wrist-rotation orbit", () => {
    it("engages only after the debounce window of both hands closed", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        orbit.update(closed("Left"), closed("Right"), rig, ctx, 16);
        expect(orbit.active).toBe(false);
        orbit.update(closed("Left"), closed("Right"), rig, ctx, 16);
        expect(orbit.active).toBe(false);
        orbit.update(closed("Left"), closed("Right"), rig, ctx, 16);
        expect(orbit.active).toBe(true);
    });

    it("does NOT engage when only one hand is closed", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        for (let i = 0; i < 6; i++) {
            orbit.update(closed("Left"), open("Right"), rig, ctx, 16);
        }
        expect(orbit.active).toBe(false);
    });

    it("engage frame produces zero camera motion", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        const theta0 = rig.azimuth, phi0 = rig.polar, r0 = rig.radiusValue;
        engage(orbit, rig, ctx);
        expect(rig.azimuth).toBeCloseTo(theta0, 9);
        expect(rig.polar).toBeCloseTo(phi0, 9);
        expect(rig.radiusValue).toBeCloseTo(r0, 9);
    });

    it("rotating fist right (90° around Y) increases azimuth by π/2", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        const theta0 = rig.azimuth;
        engage(orbit, rig, ctx);                           // punch = (0,0,1), theta_engage = 0
        // Punch now points along +X → atan2(1,0) = π/2
        orbit.update(closed("Left"), closed("Right", 1, 0, 0, 0, 1, 0), rig, ctx, 16);
        expect(rig.azimuth).toBeCloseTo(theta0 + Math.PI / 2, 5);
    });

    it("tilting fist up 45° increases polar by π/4", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        const phi0 = rig.polar;
        engage(orbit, rig, ctx);                           // punch = (0,0,1), phi_engage = 0
        // Punch tilted to (0, 1/√2, 1/√2) → phi_now = π/4
        const s = 1 / Math.SQRT2;
        orbit.update(closed("Left"), closed("Right", 0, s, s, 1, 0, 0), rig, ctx, 16);
        expect(rig.polar).toBeCloseTo(phi0 + Math.PI / 4, 5);
    });

    it("hand spread does NOT change radius (orbit at fixed distance)", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        const r0 = rig.radiusValue;
        engage(orbit, rig, ctx);
        orbit.update(closed("Left"), closed("Right"), rig, ctx, 16);
        expect(rig.radiusValue).toBeCloseTo(r0, 9);
    });

    it("wrist roll 90° rotates the mesh π/2 about the punch axis", () => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry());
        const ctx = mockCtx(mesh);
        const rig = baseRig(); const orbit = new OrbitController();
        // Engage: punch = (0,0,1), side0 = (1,0,0)
        engage(orbit, rig, ctx);
        // Roll 90°: pinkyMCP moves from +X to +Y → side becomes (0,1,0)
        // signedAngle((1,0,0), (0,1,0), (0,0,1)) = π/2
        orbit.update(closed("Left"), closed("Right", 0, 0, 1, 0, 1, 0), rig, ctx, 16);
        const angle = 2 * Math.acos(Math.min(1, Math.abs(mesh.quaternion.w)));
        expect(angle).toBeCloseTo(Math.PI / 2, 4);
    });

    it("releases on a sustained open palm and locks the camera", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        engage(orbit, rig, ctx);
        const lockedAzimuth = rig.azimuth;
        for (let i = 0; i < COMMIT_FRAMES; i++) {
            orbit.update(open("Left"), open("Right"), rig, ctx, 16);
        }
        expect(orbit.active).toBe(false);
        expect(rig.azimuth).toBeCloseTo(lockedAzimuth, 9);
    });

    it("losing a hand ends the orbit immediately", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        engage(orbit, rig, ctx);
        orbit.update(null, closed("Right"), rig, ctx, 16);
        expect(orbit.active).toBe(false);
    });

    it("reset() cancels an in-flight orbit", () => {
        const rig = baseRig(); const orbit = new OrbitController(); const ctx = mockCtx();
        engage(orbit, rig, ctx);
        orbit.reset();
        expect(orbit.active).toBe(false);
    });
});
