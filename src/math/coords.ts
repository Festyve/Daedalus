import * as THREE from "three";
import type { Landmark } from "../types";

// image space (mirrored [0,1]) → NDC (§13.1)
export function toNDC(p: Landmark): { x: number; y: number } {
    return { x: p.x * 2 - 1, y: -(p.y * 2 - 1) };
}
// fingertip → world on an interaction plane at object depth (§13.2)
export function fingertipToWorld(
    p: Landmark, camera: THREE.Camera, planeZ: number,
    ray: THREE.Ray, plane: THREE.Plane, out: THREE.Vector3,
): THREE.Vector3 {
    const ndc = toNDC(p);
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(ray.origin).normalize();
    plane.set(new THREE.Vector3(0, 0, 1), -planeZ);
    ray.intersectPlane(plane, out);
    return out;
}
// project a drag vector onto an axis (§13.3, TRANSLATE)
export function projectOntoAxis(drag: THREE.Vector3, axis: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(axis).multiplyScalar(drag.dot(axis));
}
