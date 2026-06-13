// Sprinkles controller (SPEC §9.4, Path B + the AI-chat path).
//
// Scatters authored `SprinkleDesign` instances onto the donut surface using
// THREE's `MeshSurfaceSampler`, weighted toward the iced region, with a greedy
// Poisson-disk relaxation pass so sprinkles never clump. Each sprinkle geometry
// type (capsule | star) is rendered as ONE `InstancedMesh`, capped at ~1500
// instances total. Per-instance color is drawn from the design palette, with a
// random orientation (or surface-normal-aligned) and a size jitter.
//
// The single public surface is `new Sprinkles(ctx)` + `addSprinkles(ctx, design,
// count)`, used by both the chat `add_sprinkles` DecorationAction and the direct
// right-hand pinch-drop. `clear()` / `dispose()` tear the instances down.
//
// Sampling correctness: `MeshSurfaceSampler` reads the geometry's `position`
// attribute directly and does NOT apply morph targets. Because the donut is a
// morph of the base sphere (`mesh.morphTargetInfluences[0]`), we sample against a
// throwaway geometry whose positions are the resolved morph (base + t·(target -
// base)). Instances are parented to `ctx.mesh`, so their mesh-local matrices line
// up with the surface and they ride the donut's spin/tilt groups.
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import type { SceneContext, SprinkleDesign } from "../types";

// Hard cap on live instances across all geometry types (SPEC §9.4, §12.2).
const MAX_TOTAL = 1500;
// Oversample factor for the Poisson-disk pass: we draw this many raw candidates
// per requested sprinkle, then greedily reject any that land too close to an
// already-accepted point. Higher = better spacing, more sampling cost.
const OVERSAMPLE = 4;
// Min spacing between accepted sprinkles, as a multiple of the design length.
// Keeps capsules/stars from visually overlapping without leaving big gaps.
const SPACING_FACTOR = 1.15;
// Extra sampling weight applied to chromatic (iced) vertices. The base sphere's
// icing buffer is white (r=g=b=1, zero chroma); painted icing is colored (high
// chroma), so weighting by chroma biases the scatter toward the iced region
// while still allowing a light scatter on bare steel when nothing is iced yet.
const ICING_BIAS = 8.0;
// Floor weight so faces are still reachable before any icing is applied.
const BASE_WEIGHT = 0.05;
// Star silhouette: outer/inner radius ratio and point count.
const STAR_POINTS = 5;
const STAR_INNER_RATIO = 0.5;

// One InstancedMesh + its backing bookkeeping for a single geometry type.
interface InstanceLayer {
    geometryType: SprinkleDesign["geometry"];
    mesh: THREE.InstancedMesh;
    used: number;     // how many instance slots are live
    capacity: number; // allocated slot count
}

export class Sprinkles {
    // Active instanced layers, at most one per geometry type currently in use.
    private readonly layers: InstanceLayer[] = [];
    // Accepted sprinkle centers (mesh object space) for Poisson spacing across
    // every layer — sprinkles from different drops must not clump either.
    private readonly placed: THREE.Vector3[] = [];
    private readonly root: THREE.Object3D;

    // Reused scratch — zero per-call allocation in the sampling hot path (§12.2).
    private readonly samplePos = new THREE.Vector3();
    private readonly sampleNormal = new THREE.Vector3();
    private readonly tmpColor = new THREE.Color();
    private readonly tmpQuat = new THREE.Quaternion();
    private readonly tmpScale = new THREE.Vector3();
    private readonly tmpMatrix = new THREE.Matrix4();
    private readonly upAxis = new THREE.Vector3(0, 1, 0);

    constructor(ctx: SceneContext) {
        // Parent instances to the mesh so they inherit its spin/tilt and sit on
        // the donut surface in mesh-local coordinates.
        this.root = ctx.mesh;
    }

    // Total live instances across all layers (used to enforce MAX_TOTAL).
    get count(): number {
        let n = 0;
        for (const layer of this.layers) n += layer.used;
        return n;
    }

    // Scatter `count` sprinkles of `design` onto the current donut surface.
    // Shared by the chat `add_sprinkles` action and the direct pinch-drop path.
    // Returns the number actually placed (clamped by MAX_TOTAL and by how many
    // non-clumping candidates the sampler could find).
    addSprinkles(ctx: SceneContext, design: SprinkleDesign, count: number): number {
        const budget = Math.min(count, MAX_TOTAL - this.count);
        if (budget <= 0) return 0;

        const sampler = this.buildSampler(ctx);
        const layer = this.layerFor(design, budget);
        const palette = design.palette.map((hex) => new THREE.Color(hex));
        if (palette.length === 0) palette.push(new THREE.Color("#FFFFFF"));

        const minDist = design.length * SPACING_FACTOR;
        const minDist2 = minDist * minDist;
        const maxTries = budget * OVERSAMPLE;

        let placed = 0;
        for (let attempt = 0; attempt < maxTries && placed < budget; attempt++) {
            sampler.sample(this.samplePos, this.sampleNormal);
            if (!this.isWellSpaced(this.samplePos, minDist2)) continue;

            // size jitter: uniform in [1 - j, 1 + j].
            const j = design.sizeJitter;
            const s = 1 + (Math.random() * 2 - 1) * j;

            // orientation: align to surface normal, or fully random tumble.
            if (design.orientation === "normal") {
                this.tmpQuat.setFromUnitVectors(this.upAxis, this.sampleNormal);
            } else {
                this.randomQuaternion(this.tmpQuat);
            }
            this.tmpScale.set(s, s, s);
            this.tmpMatrix.compose(this.samplePos, this.tmpQuat, this.tmpScale);

            const slot = layer.used;
            layer.mesh.setMatrixAt(slot, this.tmpMatrix);
            this.tmpColor.copy(palette[(Math.random() * palette.length) | 0]);
            layer.mesh.setColorAt(slot, this.tmpColor);

            layer.used++;
            this.placed.push(this.samplePos.clone());
            placed++;
        }

        layer.mesh.count = layer.used;
        layer.mesh.instanceMatrix.needsUpdate = true;
        if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
        layer.mesh.computeBoundingSphere();
        return placed;
    }

    // Remove every sprinkle and free GPU resources for the instanced layers.
    clear(): void {
        for (const layer of this.layers) {
            this.root.remove(layer.mesh);
            layer.mesh.geometry.dispose();
            (layer.mesh.material as THREE.Material).dispose();
            layer.mesh.dispose();
        }
        this.layers.length = 0;
        this.placed.length = 0;
    }

    dispose(): void {
        this.clear();
    }

    // Build a sampler over a throwaway geometry whose positions are the resolved
    // morph (so we sample the actual donut, not the base sphere) and whose weight
    // attribute biases toward chromatic (iced) vertices.
    private buildSampler(ctx: SceneContext): MeshSurfaceSampler {
        const geo = ctx.mesh.geometry as THREE.BufferGeometry;
        const basePos = geo.attributes.position as THREE.BufferAttribute;
        const targetAttr = geo.morphAttributes.position?.[0] as THREE.BufferAttribute | undefined;
        const t = ctx.mesh.morphTargetInfluences?.[0] ?? 0;
        const vertCount = basePos.count;

        // Resolved positions: base + t·(target - base). Falls back to base when no
        // morph target is present.
        const resolved = new Float32Array(vertCount * 3);
        for (let i = 0; i < vertCount * 3; i++) {
            const b = basePos.array[i];
            resolved[i] = targetAttr ? b + t * (targetAttr.array[i] - b) : b;
        }

        // Weight attribute: x channel carries the per-vertex sampling weight (the
        // sampler reads only .x for vector attributes). weight = BASE_WEIGHT +
        // ICING_BIAS·chroma, where chroma = max(r,g,b) - min(r,g,b).
        const weights = new Float32Array(vertCount);
        const colorAttr = geo.attributes.color as THREE.BufferAttribute | undefined;
        for (let v = 0; v < vertCount; v++) {
            let w = BASE_WEIGHT;
            if (colorAttr) {
                const r = colorAttr.getX(v);
                const g = colorAttr.getY(v);
                const bl = colorAttr.getZ(v);
                const chroma = Math.max(r, g, bl) - Math.min(r, g, bl);
                w += ICING_BIAS * chroma;
            }
            weights[v] = w;
        }

        const sampleGeo = new THREE.BufferGeometry();
        sampleGeo.setAttribute("position", new THREE.BufferAttribute(resolved, 3));
        sampleGeo.setAttribute("weight", new THREE.BufferAttribute(weights, 1));
        if (geo.index) sampleGeo.setIndex(geo.index);

        const sampleMesh = new THREE.Mesh(sampleGeo);
        const sampler = new MeshSurfaceSampler(sampleMesh)
            .setWeightAttribute("weight")
            .build();
        // `sample()` reads the stored position/weight attribute references on every
        // call, so the temp geometry must stay alive for the sampling loop. It is a
        // CPU-only object (never uploaded), local to this call, and GC-collected
        // once the sampler is released — no dispose needed.
        return sampler;
    }

    // Find (or grow) the InstancedMesh layer for a geometry type, ensuring it has
    // room for `additional` more instances. A new layer is created lazily; an
    // existing layer is grown by re-allocating a larger InstancedMesh and copying
    // the live instances over (rare — only when a second drop overflows).
    private layerFor(design: SprinkleDesign, additional: number): InstanceLayer {
        const existing = this.layers.find((l) => l.geometryType === design.geometry);
        if (existing && existing.used + additional <= existing.capacity) return existing;

        const needed = (existing ? existing.used : 0) + additional;
        const capacity = Math.min(MAX_TOTAL, needed);
        const geometry = this.makeGeometry(design);
        const material = new THREE.MeshStandardMaterial({
            vertexColors: false,
            roughness: 0.35,
            metalness: 0.0,
        });
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Force allocation of the instanceColor buffer so setColorAt works.
        mesh.setColorAt(0, this.tmpColor.set("#FFFFFF"));
        mesh.frustumCulled = false;

        if (existing) {
            // Migrate live instances from the smaller layer into the new one.
            const m = new THREE.Matrix4();
            const c = new THREE.Color();
            for (let i = 0; i < existing.used; i++) {
                existing.mesh.getMatrixAt(i, m);
                mesh.setMatrixAt(i, m);
                if (existing.mesh.instanceColor) {
                    existing.mesh.getColorAt(i, c);
                    mesh.setColorAt(i, c);
                }
            }
            mesh.count = existing.used;
            this.root.remove(existing.mesh);
            existing.mesh.geometry.dispose();
            (existing.mesh.material as THREE.Material).dispose();
            existing.mesh.dispose();
            existing.mesh = mesh;
            existing.capacity = capacity;
            this.root.add(mesh);
            return existing;
        }

        const layer: InstanceLayer = {
            geometryType: design.geometry,
            mesh,
            used: 0,
            capacity,
        };
        this.layers.push(layer);
        this.root.add(mesh);
        return layer;
    }

    // Build the per-type sprinkle geometry, sized by the design.
    //   capsule: a rounded rod of total length `length`, radius `radius`.
    //   star:    a flat extruded 5-point star, scaled by `radius`.
    // Geometry long axis is +Y so normal-orientation aligns the length to the
    // surface normal.
    private makeGeometry(design: SprinkleDesign): THREE.BufferGeometry {
        if (design.geometry === "star") return this.makeStarGeometry(design.radius);
        // CapsuleGeometry(radius, middleHeight, capSegs, radialSegs). Its total
        // length is middleHeight + 2·radius, so subtract the caps to hit `length`.
        const middle = Math.max(0.0001, design.length - 2 * design.radius);
        return new THREE.CapsuleGeometry(design.radius, middle, 3, 6);
    }

    // A small flat star, extruded to give the sprinkle a little thickness. The
    // star lies in the XY plane and is rotated so its face thickness runs along Y
    // (matching the capsule's long-axis convention closely enough for scatter).
    private makeStarGeometry(radius: number): THREE.BufferGeometry {
        const shape = new THREE.Shape();
        const inner = radius * STAR_INNER_RATIO;
        for (let i = 0; i < STAR_POINTS * 2; i++) {
            const rad = i % 2 === 0 ? radius : inner;
            const ang = (i / (STAR_POINTS * 2)) * Math.PI * 2 - Math.PI / 2;
            const x = Math.cos(ang) * rad;
            const y = Math.sin(ang) * rad;
            if (i === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
        }
        shape.closePath();
        const geo = new THREE.ExtrudeGeometry(shape, {
            depth: radius * 0.4,
            bevelEnabled: false,
        });
        geo.center();
        return geo;
    }

    // Greedy Poisson-disk test: reject the candidate if any already-placed center
    // is within `minDist` (squared) of it. O(n) per candidate; n is capped at
    // MAX_TOTAL so the worst case stays bounded.
    private isWellSpaced(p: THREE.Vector3, minDist2: number): boolean {
        const placed = this.placed;
        for (let i = 0; i < placed.length; i++) {
            if (placed[i].distanceToSquared(p) < minDist2) return false;
        }
        return true;
    }

    // Uniformly-random unit quaternion (Shoemake's method) for a natural tumble.
    private randomQuaternion(out: THREE.Quaternion): THREE.Quaternion {
        const u1 = Math.random();
        const u2 = Math.random();
        const u3 = Math.random();
        const sq1 = Math.sqrt(1 - u1);
        const sq2 = Math.sqrt(u1);
        const t1 = 2 * Math.PI * u2;
        const t2 = 2 * Math.PI * u3;
        return out.set(
            sq1 * Math.sin(t1),
            sq1 * Math.cos(t1),
            sq2 * Math.sin(t2),
            sq2 * Math.cos(t2),
        );
    }
}
