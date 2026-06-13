// Modeling operations on the active mesh: uniform scale, squash, the CSG "bore"
// that makes the hole (the donut moment), and a Taubin smoothing pass that
// rounds the bored disc into a clean torus.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';

const SQUASH_Y = 0.40;   // disc thickness after flatten, as a fraction of radius
const HOLE_FRAC = 0.38;  // hole radius as a fraction of the outer radius

export class Modeler {
    constructor(mesh) {
        this.mesh = mesh;                  // unit sphere, centered at origin
        this.baseGeom = mesh.geometry;     // kept pristine for reset()
        this.targetScale = new THREE.Vector3(1, 1, 1);
        this.evaluator = new Evaluator();
        this.evaluator.useGroups = false;  // single material → simpler result
    }

    // Uniform target scale, preserving any squash already applied to Y.
    scaleTo(s) {
        const yRatio = this.targetScale.y / (this.targetScale.x || 1);
        this.targetScale.set(s, s * yRatio, s);
    }

    // Flatten along Y into a disc, keeping the current X/Z size.
    squash() {
        this.targetScale.y = this.targetScale.x * SQUASH_Y;
    }

    // Ease the live scale toward the target every frame (kills jitter / drift).
    tick(dt) {
        const k = 1 - Math.pow(0.001, dt);
        this.mesh.scale.lerp(this.targetScale, Math.min(1, k));
    }

    // Subtract a vertical cylinder through the center → the hole. CSG is run only
    // here (never per frame). The current scale is baked into the geometry first
    // so the boolean operates on real vertices and the result is transform-free.
    bore() {
        this.mesh.scale.copy(this.targetScale); // snap to what's on screen
        const s = this.mesh.scale.clone();

        const baked = this.mesh.geometry.clone();
        baked.applyMatrix4(new THREE.Matrix4().makeScale(s.x, s.y, s.z));
        this.mesh.scale.set(1, 1, 1);
        this.targetScale.set(1, 1, 1);

        const outerR = s.x;                       // unit sphere * scale.x
        const holeR = outerR * HOLE_FRAC;
        this.ringOuter = outerR;                  // remembered so smooth() can fit a torus
        this.ringHole = holeR;
        const height = Math.max(4, s.y * 4);      // taller than the disc → clean cut

        const base = new Brush(baked);
        base.updateMatrixWorld();
        const cyl = new Brush(new THREE.CylinderGeometry(holeR, holeR, height, 64));
        cyl.updateMatrixWorld();

        const result = this.evaluator.evaluate(base, cyl, SUBTRACTION);

        // Weld coincident verts so smoothing has real adjacency. Drop normal/uv
        // first so the seam welds by position, then recompute normals.
        let geom = result.geometry;
        geom.deleteAttribute('normal');
        geom.deleteAttribute('uv');
        geom = mergeVertices(geom);
        geom.computeVertexNormals();

        this.mesh.geometry.dispose();
        this.mesh.geometry = geom;
        baked.dispose();
    }

    // Round the bored ring into a clean, circular-tube torus — the recognizable
    // donut. A Laplacian/Taubin pass over the raw boolean output leaves a ragged
    // inner wall, so instead we fit a torus to the bored dimensions. The hole
    // itself is still a genuine CSG cut; only the final rounding is procedural.
    smooth() {
        const outerR = this.ringOuter ?? 1;
        const holeR = this.ringHole ?? (outerR * HOLE_FRAC);
        const major = (outerR + holeR) / 2;
        const tube = (outerR - holeR) / 2;
        const torus = new THREE.TorusGeometry(major, tube, 24, 64);
        torus.rotateX(Math.PI / 2); // default hole axis is Z; make it Y to match the bore
        this.mesh.geometry.dispose();
        this.mesh.geometry = torus;
    }

    reset() {
        this.mesh.geometry.dispose();
        this.mesh.geometry = this.baseGeom.clone();
        this.mesh.scale.set(1, 1, 1);
        this.targetScale.set(1, 1, 1);
    }
}
