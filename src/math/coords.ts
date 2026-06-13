// Fingertip → world unprojection (SPEC §12, "Gesture Math Reference").
//
//   Fingertip → world: raycast from camera through NDC → intersect interaction
//                      plane at object depth
//                      ndcX = x*2−1, ndcY = −(y*2−1)
//                      mirror: negate ndcX if displayed video is flipped
//
// Landmarks arrive in mirrored, normalized image space (§3): x,y ∈ [0,1] with the
// origin at top-left, already flipped to match the selfie-view video. Because the
// feed is mirror-flipped at the source, x maps directly to NDC with no further sign
// change — the mirror is already baked in. HOT LOOP: zero per-frame allocation —
// every call reuses the caller-owned ray / plane / out (§6.2, §11).
import * as THREE from "three";
import type { Vec3 } from "../types";

// Interaction plane normal: faces the camera along +Z. Constant — never reallocated.
const PLANE_NORMAL = /*@__PURE__*/ new THREE.Vector3(0, 0, 1);

// image space (mirrored [0,1]) → NDC (§12). Allocates a small result object; use
// only outside the per-frame hot loop (e.g. carousel / DOM projection, not sculpting).
export function toNDC(p: Vec3): { x: number; y: number } {
    return { x: p.x * 2 - 1, y: -(p.y * 2 - 1) };
}

// fingertip → world on the interaction plane at object depth (§12).
// Raycasts camera → NDC and intersects z = planeZ. Writes the hit into `out` and
// returns it. Reuses the passed `ray`, `plane`, and `out` — no allocation.
export function fingertipToWorld(
    lm: Vec3,
    camera: THREE.PerspectiveCamera,
    planeZ: number,
    ray: THREE.Ray,
    plane: THREE.Plane,
    out: THREE.Vector3,
): THREE.Vector3 {
    const ndc_x = lm.x * 2 - 1;
    const ndc_y = -(lm.y * 2 - 1);
    // Ray from the camera position through the NDC point on the far-ish plane.
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(ndc_x, ndc_y, 0.5).unproject(camera).sub(ray.origin).normalize();
    // Plane z = planeZ in world space: n·x = planeZ, n = +Z, so constant = −planeZ.
    plane.setComponents(PLANE_NORMAL.x, PLANE_NORMAL.y, PLANE_NORMAL.z, -planeZ);
    // If the camera looks parallel to the plane there is no hit; leave `out` unchanged.
    ray.intersectPlane(plane, out);
    return out;
}

// project a drag vector onto an axis (§12, TRANSLATE). Reuses `out` — no allocation.
export function projectOntoAxis(
    drag: THREE.Vector3,
    axis: THREE.Vector3,
    out: THREE.Vector3,
): THREE.Vector3 {
    return out.copy(axis).multiplyScalar(drag.dot(axis));
}
