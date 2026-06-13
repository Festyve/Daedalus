import * as THREE from "three";
const TWO_PI = Math.PI * 2;

// Both shapes share the SAME (u,v) grid → identical count + ordering by construction.
//   sphere(u,v): meridian great-circle at angle u, rotated by v around Y
//     x = Rs·sin u·cos v,  y = Rs·cos u,  z = Rs·sin u·sin v
//   torus(u,v): tube angle u, ring angle v, hole axis = Y
//     x = (R + r·cos u)·cos v,  y = r·sin u,  z = (R + r·cos u)·sin v
export function buildDonutMorphGeometry(tubeSeg = 128, ringSeg = 160, R = 1.0, r = 0.42): THREE.BufferGeometry {
    const Rs = 1.0;
    const cols = tubeSeg + 1, rows = ringSeg + 1;
    const n = cols * rows;
    const sphere = new Float32Array(n * 3);
    const torus = new Float32Array(n * 3);
    let k = 0;
    for (let iv = 0; iv < rows; iv++) {
        const v = (iv / ringSeg) * TWO_PI, cv = Math.cos(v), sv = Math.sin(v);
        for (let iu = 0; iu < cols; iu++) {
            const u = (iu / tubeSeg) * TWO_PI, cu = Math.cos(u), su = Math.sin(u);
            sphere[k * 3]     = Rs * su * cv;
            sphere[k * 3 + 1] = Rs * cu;
            sphere[k * 3 + 2] = Rs * su * sv;
            const ring = R + r * cu;
            torus[k * 3]     = ring * cv;
            torus[k * 3 + 1] = r * su;
            torus[k * 3 + 2] = ring * sv;
            k++;
        }
    }
    const index: number[] = [];
    for (let iv = 0; iv < ringSeg; iv++) {
        for (let iu = 0; iu < tubeSeg; iu++) {
            const a = iv * cols + iu, b = a + 1, c = a + cols, dd = c + 1;
            index.push(a, c, b, b, c, dd);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(sphere, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const baseNormals = (geo.attributes.normal as THREE.BufferAttribute).clone();
    // torus normals: build a temp geometry to get correct target normals
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(torus, 3));
    tg.setIndex(index); tg.computeVertexNormals();
    geo.morphAttributes.position = [new THREE.BufferAttribute(torus, 3)];
    geo.morphAttributes.normal = [(tg.attributes.normal as THREE.BufferAttribute)];
    geo.setAttribute("normal", baseNormals);
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3)); // icing buffer
    return geo;
}
