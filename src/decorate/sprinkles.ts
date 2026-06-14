// Sprinkles controller (SPEC §8.4).
//
// Scatters a `SprinkleDesign` onto the torus surface using THREE's
// `MeshSurfaceSampler`, weighted by the icing mask so sprinkles land ONLY on
// iced regions, with a greedy Poisson-disk relaxation pass so they never clump.
// Each geometry type is rendered as ONE `InstancedMesh`, capped at ~1500 live
// instances total. Each `dropBatch` adds ~60 with a scale-in pop animation, and
// per-instance color is drawn from the design palette (rainbow).
//
// Sampling correctness: `MeshSurfaceSampler` reads the geometry's `position`
// attribute directly and does NOT resolve morph targets. Because the torus is a
// morph of the base sphere (`mesh.morphTargetInfluences[0]`), we sample against
// a throwaway geometry whose positions are the resolved morph
// (base + t·(target − base)). The instanced layer is parented to the mesh, so
// instance matrices line up with the surface and ride the torus's spin/tilt.
//
// The icing mask (one weight per vertex, 0 = bare, 1 = fully iced) comes from
// `icingMask(mesh)` and is passed straight into `dropBatch`; we copy it into a
// per-vertex `weight` attribute the sampler multiplies by triangle area.
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import type { SprinkleDesign } from "../types";

// Hard cap on live instances across all geometry types (SPEC §8.4).
const MAX_TOTAL = 1500;
// Default batch size per drop (SPEC §8.4: "a batch of ~60").
const BATCH_DEFAULT = 60;
// Oversample factor for the Poisson-disk pass: we draw this many raw candidates
// per requested sprinkle, then greedily reject any that land too close to an
// already-accepted point. Higher = better spacing, more sampling cost.
const OVERSAMPLE = 4;
// Min spacing between accepted sprinkles, as a multiple of the design length.
// Keeps capsules from visually overlapping without leaving big gaps.
const SPACING_FACTOR = 1.15;
// Below this total iced weight the surface is effectively bare — drop nothing so
// sprinkles never land on unfrosted steel.
const MASK_EPSILON = 1e-4;
// Scale-in pop: instances grow 0 → 1 over this many seconds with a confetti
// burst (overshoot past 1, settle back) so each drop reads as a celebratory pop.
const SCALE_IN_SECONDS = 0.28;
// Confetti overshoot: peak scale the pop reaches before settling to 1. A tiny
// bounce — kept small so sprinkles punch in without looking gummy.
const SCALE_OVERSHOOT = 1.18;
// Emissive boost (multiplies each instance's palette color) + tone-mapping off so
// the rainbow stays saturated and reads at demo distance instead of washing out.
const EMISSIVE_INTENSITY = 0.6;

// One InstancedMesh + its backing bookkeeping for a single geometry type.
interface InstanceLayer {
    geometryType: SprinkleDesign["geometry"];
    mesh: THREE.InstancedMesh;
    used: number;       // how many instance slots are live
    capacity: number;   // allocated slot count
    // Per-slot scale-in animation state (object space). targetScale[i] is the
    // final uniform scale; anim[i] is elapsed seconds (≥ duration ⇒ settled).
    targetScale: Float32Array;
    anim: Float32Array;
    // Per-slot center + orientation, kept so the animation tick can recompose the
    // matrix at each grown scale without re-sampling (zero alloc in the tick).
    center: Float32Array;     // 3 floats per slot
    quat: Float32Array;       // 4 floats per slot
    animating: boolean;       // any slot still growing
}

export class Sprinkles {
    private readonly scene: THREE.Scene;
    // Active instanced layers, at most one per geometry type currently in use.
    private readonly layers: InstanceLayer[] = [];
    // Accepted sprinkle centers (mesh object space) for Poisson spacing across
    // every layer — sprinkles from different drops must not clump either.
    private readonly placed: THREE.Vector3[] = [];

    // Reused scratch — zero per-call allocation in the sampling/animation paths.
    private readonly samplePos = new THREE.Vector3();
    private readonly sampleNormal = new THREE.Vector3();
    private readonly tmpColor = new THREE.Color();
    private readonly tmpQuat = new THREE.Quaternion();
    private readonly tmpScale = new THREE.Vector3();
    private readonly tmpCenter = new THREE.Vector3();
    private readonly tmpMatrix = new THREE.Matrix4();
    private readonly upAxis = new THREE.Vector3(0, 1, 0);

    // Drives the scale-in tick. Held so `clear()` can cancel a pending frame.
    private rafHandle = 0;
    private lastTickMs = 0;

    constructor(scene: THREE.Scene) {
        this.scene = scene;
    }

    // Total live instances across all layers (used to enforce MAX_TOTAL).
    get count(): number {
        let n = 0;
        for (const layer of this.layers) n += layer.used;
        return n;
    }

    // Scatter a batch of sprinkles of `design` onto `mesh`, weighted by `mask`.
    // `mask` is the per-vertex iced weight (0 = bare, 1 = fully iced) — sampling
    // is biased so sprinkles land only on iced regions. Defaults to ~60 per drop
    // and is clamped by MAX_TOTAL and by how many non-clumping candidates the
    // sampler can find. New instances scale in with a pop animation.
    dropBatch(mesh: THREE.Mesh, mask: Float32Array, design: SprinkleDesign, n = BATCH_DEFAULT): void {
        const budget = Math.min(n, MAX_TOTAL - this.count);
        if (budget <= 0) return;

        const sampler = this.buildSampler(mesh, mask);
        if (!sampler) return; // nothing iced yet → nothing to sample

        const layer = this.layerFor(mesh, design, budget);
        const palette = design.palette.length > 0 ? design.palette : ["#FFFFFF"];

        const minDist = design.length * SPACING_FACTOR;
        const minDist2 = minDist * minDist;
        const maxTries = budget * OVERSAMPLE;

        let placed = 0;
        for (let attempt = 0; attempt < maxTries && placed < budget; attempt++) {
            sampler.sample(this.samplePos, this.sampleNormal);
            if (!this.isWellSpaced(this.samplePos, minDist2)) continue;

            // Capsule long axis (+Y) aligned to the surface normal so it lies
            // flat against the torus where it landed.
            this.tmpQuat.setFromUnitVectors(this.upAxis, this.sampleNormal);

            const slot = layer.used;
            // Seed the slot at scale 0; the tick grows it to 1.
            this.tmpScale.set(0, 0, 0);
            this.tmpMatrix.compose(this.samplePos, this.tmpQuat, this.tmpScale);
            layer.mesh.setMatrixAt(slot, this.tmpMatrix);

            // Rainbow: pick a palette entry per instance.
            this.tmpColor.set(palette[(Math.random() * palette.length) | 0]);
            layer.mesh.setColorAt(slot, this.tmpColor);

            // Stash the animation state so the tick can recompose without alloc.
            layer.center[slot * 3] = this.samplePos.x;
            layer.center[slot * 3 + 1] = this.samplePos.y;
            layer.center[slot * 3 + 2] = this.samplePos.z;
            layer.quat[slot * 4] = this.tmpQuat.x;
            layer.quat[slot * 4 + 1] = this.tmpQuat.y;
            layer.quat[slot * 4 + 2] = this.tmpQuat.z;
            layer.quat[slot * 4 + 3] = this.tmpQuat.w;
            layer.targetScale[slot] = 1;
            layer.anim[slot] = 0;

            layer.used++;
            this.placed.push(this.samplePos.clone());
            placed++;
        }

        if (placed === 0) return;

        layer.mesh.count = layer.used;
        layer.mesh.instanceMatrix.needsUpdate = true;
        if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
        layer.animating = true;
        this.ensureTicking();
    }

    // Remove every sprinkle and free GPU resources for the instanced layers.
    clear(): void {
        if (this.rafHandle !== 0) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = 0;
        }
        for (const layer of this.layers) {
            layer.mesh.removeFromParent();
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
    // morph (so we sample the actual torus, not the base sphere) and whose weight
    // attribute is the icing mask (sprinkles land on iced regions only). Returns
    // null when nothing is iced yet (total mask weight ≈ 0).
    private buildSampler(mesh: THREE.Mesh, mask: Float32Array): MeshSurfaceSampler | null {
        const geo = mesh.geometry as THREE.BufferGeometry;
        const basePos = geo.attributes.position as THREE.BufferAttribute;
        const targetAttr = geo.morphAttributes.position?.[0] as THREE.BufferAttribute | undefined;
        const t = mesh.morphTargetInfluences?.[0] ?? 0;
        const vertCount = basePos.count;

        // Reject an all-bare mask: no iced surface ⇒ no sprinkles.
        let maskSum = 0;
        for (let v = 0; v < vertCount && v < mask.length; v++) maskSum += mask[v];
        if (maskSum <= MASK_EPSILON) return null;

        // Resolved positions: base + t·(target − base). Falls back to base when no
        // morph target is present.
        const baseArr = basePos.array as ArrayLike<number>;
        const targetArr = targetAttr ? (targetAttr.array as ArrayLike<number>) : null;
        const resolved = new Float32Array(vertCount * 3);
        for (let i = 0; i < vertCount * 3; i++) {
            const b = baseArr[i];
            resolved[i] = targetArr ? b + t * (targetArr[i] - b) : b;
        }

        // Weight attribute: the sampler reads only `.x` per vertex, so a 1-item
        // attribute carries the iced weight directly. Copy (don't alias) the mask
        // so later icing edits can't desync the built distribution.
        const weights = new Float32Array(vertCount);
        for (let v = 0; v < vertCount; v++) weights[v] = v < mask.length ? mask[v] : 0;

        const sampleGeo = new THREE.BufferGeometry();
        sampleGeo.setAttribute("position", new THREE.BufferAttribute(resolved, 3));
        sampleGeo.setAttribute("weight", new THREE.BufferAttribute(weights, 1));
        if (geo.index) sampleGeo.setIndex(geo.index);

        const sampleMesh = new THREE.Mesh(sampleGeo);
        // The temp geometry is CPU-only (never uploaded) and kept alive by the
        // sampler's attribute references for the duration of the drop loop; it is
        // GC-collected once the sampler is released — no dispose needed.
        return new MeshSurfaceSampler(sampleMesh).setWeightAttribute("weight").build();
    }

    // Find (or grow) the InstancedMesh layer for a geometry type under `mesh`,
    // ensuring room for `additional` more instances. A new layer is created
    // lazily; an existing layer is grown by re-allocating a larger InstancedMesh
    // and copying live instances over (rare — only when a later drop overflows).
    private layerFor(mesh: THREE.Mesh, design: SprinkleDesign, additional: number): InstanceLayer {
        const existing = this.layers.find((l) => l.geometryType === design.geometry);
        if (existing && existing.used + additional <= existing.capacity) {
            // Re-parent in case the active mesh was swapped since the last drop.
            if (existing.mesh.parent !== mesh) mesh.add(existing.mesh);
            return existing;
        }

        const needed = (existing ? existing.used : 0) + additional;
        const capacity = Math.min(MAX_TOTAL, needed);
        const geometry = this.makeGeometry(design);
        // toneMapped:false keeps the palette vivid through ACES tonemapping. Stock
        // MeshStandardMaterial only modulates DIFFUSE by instanceColor, so a uniform
        // emissive would wash every hue toward white. Instead we patch the shader to
        // drive emissive from each instance's own color (vColor) — every sprinkle
        // self-glows in ITS hue, so the rainbow reads at demo distance even on
        // shadowed torus faces.
        const material = new THREE.MeshStandardMaterial({
            roughness: 0.3,
            metalness: 0.0,
            toneMapped: false,
        });
        material.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
                "vec3 totalEmissiveRadiance = emissive;",
                `vec3 totalEmissiveRadiance = emissive;
                #ifdef USE_COLOR
                    totalEmissiveRadiance += vColor * ${EMISSIVE_INTENSITY.toFixed(3)};
                #endif`,
            );
        };
        const instMesh = new THREE.InstancedMesh(geometry, material, capacity);
        instMesh.count = 0;
        instMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Force allocation of the instanceColor buffer so setColorAt works.
        instMesh.setColorAt(0, this.tmpColor.set("#FFFFFF"));
        instMesh.frustumCulled = false;

        if (existing) {
            // Migrate live instances + their animation state into the larger layer.
            for (let i = 0; i < existing.used; i++) {
                existing.mesh.getMatrixAt(i, this.tmpMatrix);
                instMesh.setMatrixAt(i, this.tmpMatrix);
                if (existing.mesh.instanceColor) {
                    existing.mesh.getColorAt(i, this.tmpColor);
                    instMesh.setColorAt(i, this.tmpColor);
                }
            }
            instMesh.count = existing.used;
            const targetScale = new Float32Array(capacity);
            const anim = new Float32Array(capacity);
            const center = new Float32Array(capacity * 3);
            const quat = new Float32Array(capacity * 4);
            targetScale.set(existing.targetScale.subarray(0, existing.used));
            anim.set(existing.anim.subarray(0, existing.used));
            center.set(existing.center.subarray(0, existing.used * 3));
            quat.set(existing.quat.subarray(0, existing.used * 4));

            existing.mesh.removeFromParent();
            existing.mesh.geometry.dispose();
            (existing.mesh.material as THREE.Material).dispose();
            existing.mesh.dispose();

            existing.mesh = instMesh;
            existing.capacity = capacity;
            existing.targetScale = targetScale;
            existing.anim = anim;
            existing.center = center;
            existing.quat = quat;
            mesh.add(instMesh);
            return existing;
        }

        const layer: InstanceLayer = {
            geometryType: design.geometry,
            mesh: instMesh,
            used: 0,
            capacity,
            targetScale: new Float32Array(capacity),
            anim: new Float32Array(capacity),
            center: new Float32Array(capacity * 3),
            quat: new Float32Array(capacity * 4),
            animating: false,
        };
        this.layers.push(layer);
        mesh.add(instMesh);
        return layer;
    }

    // Build the capsule sprinkle geometry, sized by the design. Total capsule
    // length is middleHeight + 2·radius, so subtract the caps to hit `length`.
    // The long axis is +Y so normal-orientation lays the rod flat on the surface.
    private makeGeometry(design: SprinkleDesign): THREE.BufferGeometry {
        const middle = Math.max(0.0001, design.length - 2 * design.radius);
        return new THREE.CapsuleGeometry(design.radius, middle, 3, 6);
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

    // Schedule the scale-in tick if it isn't already running.
    private ensureTicking(): void {
        if (this.rafHandle !== 0) return;
        this.lastTickMs = 0;
        this.rafHandle = requestAnimationFrame(this.tick);
    }

    // Per-frame scale-in: grow every animating slot from 0 → its target scale with
    // an ease-out, recomposing only the matrices that changed. Zero allocation in
    // the loop (reuses scratch + the per-slot typed arrays). Self-cancels once all
    // slots have settled.
    private tick = (nowMs: number): void => {
        const dt = this.lastTickMs === 0 ? 1 / 60 : (nowMs - this.lastTickMs) / 1000;
        this.lastTickMs = nowMs;

        let anyAnimating = false;
        for (const layer of this.layers) {
            if (!layer.animating) continue;
            let layerAnimating = false;
            for (let i = 0; i < layer.used; i++) {
                if (layer.anim[i] >= SCALE_IN_SECONDS) continue;
                layer.anim[i] += dt;
                const tNorm = Math.min(1, layer.anim[i] / SCALE_IN_SECONDS);
                // Confetti pop: back-ease-out overshoots past 1 then settles to 1
                // at tNorm=1, giving each sprinkle a tiny bounce as it lands. The
                // overshoot magnitude is tuned so the peak ≈ SCALE_OVERSHOOT.
                const k = SCALE_OVERSHOOT - 1;
                const inv = tNorm - 1;
                const eased = 1 + (k + 1) * inv * inv * inv + k * inv * inv;
                const s = layer.targetScale[i] * eased;

                this.tmpCenter.set(layer.center[i * 3], layer.center[i * 3 + 1], layer.center[i * 3 + 2]);
                this.tmpQuat.set(layer.quat[i * 4], layer.quat[i * 4 + 1], layer.quat[i * 4 + 2], layer.quat[i * 4 + 3]);
                this.tmpScale.set(s, s, s);
                this.tmpMatrix.compose(this.tmpCenter, this.tmpQuat, this.tmpScale);
                layer.mesh.setMatrixAt(i, this.tmpMatrix);

                if (tNorm < 1) layerAnimating = true;
            }
            layer.mesh.instanceMatrix.needsUpdate = true;
            layer.animating = layerAnimating;
            anyAnimating = anyAnimating || layerAnimating;
        }

        if (anyAnimating) {
            this.rafHandle = requestAnimationFrame(this.tick);
        } else {
            this.rafHandle = 0;
        }
    };
}
