// OrbitController — bilateral two-hand grab → relative-drag camera orbit (Part 1).
//
// We synthesize two hands (closed-fist or open-palm world landmarks for engage/release, plus a
// controllable image-space wrist position for the drag) and assert: engage after the debounce,
// the relative-drag mapping (midpoint Δx→azimuth, Δy→elevation, spread→zoom with no teleport
// on the engage frame), and release on open-palm / hand-loss / reset. Drives a real CameraRig
// so the rig clamps + getters are exercised end-to-end. Pure headless math (no DOM/WebGL).
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import type { HandPose, Handedness, Vec3 } from "../src/types";
import { OrbitController } from "../src/menu/orbit";
import { CameraRig } from "../src/render/cameraRig";

const COMMIT_FRAMES = 3;
const N_LANDMARKS = 21;
const HAND_SCALE = 0.09;

function v(x: number, y: number, z: number): Vec3 { return { x, y, z }; }

// World landmarks for a CLOSED hand: all four non-thumb fingertips curled (tip nearer the
// wrist than its PIP) so isClosedHand() is true and isOpenPalm() is false.
function closedWorld(): Vec3[] {
    const lm: Vec3[] = [];
    for (let i = 0; i < N_LANDMARKS; i++) lm.push(v(0, 0, 0));
    lm[0] = v(0, 0, 0);          // wrist
    lm[9] = v(0, 0.09, 0);       // middle MCP ⇒ handScale S = 0.09
    // PIPs (6,10,14,18) farther from the wrist than the TIPs (8,12,16,20) ⇒ curled.
    for (const pip of [6, 10, 14, 18]) lm[pip] = v(0, 0.05, 0);
    for (const tip of [8, 12, 16, 20]) lm[tip] = v(0, 0.03, 0);
    return lm;
}

// World landmarks for an OPEN palm: all four fingers extended + spread > 0.4·S + thumb out.
function openWorld(): Vec3[] {
    const lm: Vec3[] = [];
    for (let i = 0; i < N_LANDMARKS; i++) lm.push(v(0, 0, 0));
    lm[0] = v(0, 0, 0);          // wrist
    lm[9] = v(0, 0.09, 0);       // middle MCP ⇒ S = 0.09
    for (const pip of [6, 10, 14, 18]) lm[pip] = v(0, 0.07, 0);   // PIPs mid-palm
    // Fingertips fanned along X and far from the wrist ⇒ extended + spread.
    lm[8] = v(-0.06, 0.12, 0);
    lm[12] = v(-0.02, 0.13, 0);
    lm[16] = v(0.02, 0.13, 0);
    lm[20] = v(0.06, 0.12, 0);
    lm[3] = v(0.04, 0.03, 0);    // thumb IP
    lm[4] = v(0.08, 0.05, 0);    // thumb tip (farther than IP ⇒ extended)
    return lm;
}

// A hand whose grab/release pose comes from `world`, with the image-space WRIST at (wx, wy)
// — the only image landmark OrbitController reads (two-hand midpoint + spread).
function hand(handedness: Handedness, world: Vec3[], wx: number, wy: number): HandPose {
    const lm: Vec3[] = [];
    for (let i = 0; i < N_LANDMARKS; i++) lm.push(v(0.5, 0.5, 0));
    lm[0] = v(wx, wy, 0);
    return { handedness, landmarks: lm, world, confidence: 1, handScale: HAND_SCALE, timestamp: 0 };
}

function closed(handedness: Handedness, wx: number, wy: number): HandPose {
    return hand(handedness, closedWorld(), wx, wy);
}
function open(handedness: Handedness, wx: number, wy: number): HandPose {
    return hand(handedness, openWorld(), wx, wy);
}

function baseRig(): CameraRig {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.set(0, 0.35, 5);
    cam.lookAt(0, 0, 0);
    return new CameraRig(cam);
}

// Hold both hands closed at fixed wrists for COMMIT_FRAMES so the controller engages.
function engage(orbit: OrbitController, rig: CameraRig, lx: number, ly: number, rx: number, ry: number): void {
    for (let i = 0; i < COMMIT_FRAMES; i++) {
        orbit.update(closed("Left", lx, ly), closed("Right", rx, ry), rig, 16);
    }
}

describe("OrbitController — two-hand grab orbit", () => {
    it("engages only after the debounce window of both hands closed", () => {
        const rig = baseRig();
        const orbit = new OrbitController();
        orbit.update(closed("Left", 0.4, 0.5), closed("Right", 0.6, 0.5), rig, 16);
        expect(orbit.active).toBe(false);                  // 1 frame < COMMIT
        orbit.update(closed("Left", 0.4, 0.5), closed("Right", 0.6, 0.5), rig, 16);
        expect(orbit.active).toBe(false);                  // 2 frames
        orbit.update(closed("Left", 0.4, 0.5), closed("Right", 0.6, 0.5), rig, 16);
        expect(orbit.active).toBe(true);                   // 3rd frame ⇒ engaged
    });

    it("does NOT engage when only one hand is closed", () => {
        const rig = baseRig();
        const orbit = new OrbitController();
        for (let i = 0; i < 6; i++) {
            orbit.update(closed("Left", 0.4, 0.5), open("Right", 0.6, 0.5), rig, 16);
        }
        expect(orbit.active).toBe(false);
    });

    it("the engage frame produces zero camera motion (no teleport snap)", () => {
        const rig = baseRig();
        const theta0 = rig.azimuth, phi0 = rig.polar, r0 = rig.radiusValue;
        const orbit = new OrbitController();
        engage(orbit, rig, 0.4, 0.5, 0.6, 0.5);
        expect(rig.azimuth).toBeCloseTo(theta0, 9);
        expect(rig.polar).toBeCloseTo(phi0, 9);
        expect(rig.radiusValue).toBeCloseTo(r0, 9);
    });

    it("hands moving right turn the azimuth (turntable: drag right ⇒ θ decreases)", () => {
        const rig = baseRig();
        const theta0 = rig.azimuth;
        const orbit = new OrbitController();
        engage(orbit, rig, 0.4, 0.5, 0.6, 0.5);            // mid0x = 0.5
        // Slide both hands +0.1 in x ⇒ midx = 0.6, Δ = +0.1.
        orbit.update(closed("Left", 0.5, 0.5), closed("Right", 0.7, 0.5), rig, 16);
        expect(rig.azimuth).toBeCloseTo(theta0 - Math.PI * 0.1, 6);
    });

    it("hands moving up lift the elevation (image y is top-down)", () => {
        const rig = baseRig();
        const phi0 = rig.polar;
        const orbit = new OrbitController();
        engage(orbit, rig, 0.4, 0.5, 0.6, 0.5);            // mid0y = 0.5
        // Raise both hands by 0.1 ⇒ wristY 0.4, midy = 0.4, (mid0y − midy) = +0.1.
        orbit.update(closed("Left", 0.4, 0.4), closed("Right", 0.6, 0.4), rig, 16);
        expect(rig.polar).toBeCloseTo(phi0 + Math.PI * 0.1, 6);
    });

    it("spreading the hands apart zooms in (r = r0·d0/d)", () => {
        const rig = baseRig();
        const r0 = rig.radiusValue;
        const orbit = new OrbitController();
        engage(orbit, rig, 0.4, 0.5, 0.6, 0.5);            // d0 = 0.2, mid stays 0.5
        // Widen to span 0.3..0.7 ⇒ d = 0.4, midpoint unchanged.
        orbit.update(closed("Left", 0.3, 0.5), closed("Right", 0.7, 0.5), rig, 16);
        expect(rig.radiusValue).toBeCloseTo(r0 * (0.2 / 0.4), 6);
    });

    it("releases on a sustained open palm and locks the camera where it is", () => {
        const rig = baseRig();
        const orbit = new OrbitController();
        engage(orbit, rig, 0.4, 0.5, 0.6, 0.5);
        const lockedAzimuth = rig.azimuth;
        // Open both palms (same wrist positions ⇒ no drive) for the debounce window.
        for (let i = 0; i < COMMIT_FRAMES; i++) {
            orbit.update(open("Left", 0.4, 0.5), open("Right", 0.6, 0.5), rig, 16);
        }
        expect(orbit.active).toBe(false);
        expect(rig.azimuth).toBeCloseTo(lockedAzimuth, 9); // rig holds its committed state
    });

    it("losing a hand ends the orbit immediately", () => {
        const rig = baseRig();
        const orbit = new OrbitController();
        engage(orbit, rig, 0.4, 0.5, 0.6, 0.5);
        expect(orbit.active).toBe(true);
        orbit.update(null, closed("Right", 0.6, 0.5), rig, 16);
        expect(orbit.active).toBe(false);
    });

    it("reset() cancels an in-flight orbit (used when a tool/carousel takes over)", () => {
        const rig = baseRig();
        const orbit = new OrbitController();
        engage(orbit, rig, 0.4, 0.5, 0.6, 0.5);
        expect(orbit.active).toBe(true);
        orbit.reset();
        expect(orbit.active).toBe(false);
    });
});
