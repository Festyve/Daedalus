// CameraRig spherical-orbit math (Camera Orbit Mode, Part 1).
//
// The rig owns the camera as committed (θ, φ, r) about a target and writes the transform in
// update(). We pin: the seed from a base-framed camera, the spherical→cartesian placement,
// the always-look-at-target invariant, the clamp ranges, and the on-sphere invariant (drift
// only rotates, never changes radius). vitest runs under the "node" env; no DOM/WebGL needed.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { CameraRig } from "../src/render/cameraRig";

// The v5 base camera: origin object, camera read from a slight 3/4 elevation on +Z.
function baseCamera(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.set(0, 0.35, 5);
    cam.lookAt(0, 0, 0);
    return cam;
}

const EPS = 1e-6;

describe("CameraRig — spherical orbit state", () => {
    it("seeds (θ, φ, r) from the base-framed camera", () => {
        const rig = new CameraRig(baseCamera());
        const r = Math.hypot(0.35, 5);
        expect(rig.azimuth).toBeCloseTo(0, 9);                       // on +Z ⇒ atan2(0,5)=0
        expect(rig.radiusValue).toBeCloseTo(r, 6);                   // ‖(0,0.35,5)‖
        expect(rig.polar).toBeCloseTo(Math.asin(0.35 / r), 6);       // slight elevation
    });

    it("places the camera at r·(cosφ·sinθ, sinφ, cosφ·cosθ) and looks at the target", () => {
        const cam = baseCamera();
        const rig = new CameraRig(cam);
        rig.setOrbit(0.7, 0.3, 4);
        rig.update(0); // dt=0 ⇒ drift term is sin(0)=0, so this is the exact committed pose

        const cp = Math.cos(0.3);
        expect(cam.position.x).toBeCloseTo(4 * cp * Math.sin(0.7), 9);
        expect(cam.position.y).toBeCloseTo(4 * Math.sin(0.3), 9);
        expect(cam.position.z).toBeCloseTo(4 * cp * Math.cos(0.7), 9);

        // Always re-aims at the origin: world-forward points from the camera toward (0,0,0).
        const fwd = new THREE.Vector3();
        cam.getWorldDirection(fwd);
        const want = cam.position.clone().multiplyScalar(-1).normalize();
        expect(fwd.dot(want)).toBeGreaterThan(1 - 1e-9);
    });

    it("azimuth π/2 swings the camera onto +X", () => {
        const cam = baseCamera();
        const rig = new CameraRig(cam);
        rig.setOrbit(Math.PI / 2, 0, 5);
        rig.update(0);
        expect(cam.position.x).toBeCloseTo(5, 6);
        expect(cam.position.y).toBeCloseTo(0, 9);
        expect(cam.position.z).toBeCloseTo(0, 6);
    });

    it("clamps elevation to ±85° and radius to [2, 14]", () => {
        const rig = new CameraRig(baseCamera());
        rig.setOrbit(0, 10, 999);   // absurd elevation + radius
        expect(rig.polar).toBeCloseTo(THREE.MathUtils.degToRad(85), 6);
        expect(rig.radiusValue).toBeCloseTo(14, 6);
        rig.setOrbit(0, -10, 0.01);
        expect(rig.polar).toBeCloseTo(-THREE.MathUtils.degToRad(85), 6);
        expect(rig.radiusValue).toBeCloseTo(2, 6);
    });

    it("keeps the camera on the radius sphere under idle drift (drift rotates, never zooms)", () => {
        const cam = baseCamera();
        const rig = new CameraRig(cam);
        rig.setOrbit(0.2, 0.1, 6);
        const target = new THREE.Vector3(0, 0, 0);
        for (let i = 0; i < 50; i++) {
            rig.update(16);
            // Distance to target is exactly the committed radius regardless of the drift phase.
            expect(cam.position.distanceTo(target)).toBeCloseTo(6, 6);
            // And it never stops looking at the target.
            const fwd = new THREE.Vector3();
            cam.getWorldDirection(fwd);
            const want = cam.position.clone().multiplyScalar(-1).normalize();
            expect(fwd.dot(want)).toBeGreaterThan(1 - 1e-6);
        }
    });
});
