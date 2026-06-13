// §10.1 — the dissolve finale shader + driver.
//
// The active mesh's MeshMatcapMaterial is patched via onBeforeCompile so the cold
// steel matcap AND the existing Fresnel rim (added in render/scene.ts) are
// preserved: we capture the material's current onBeforeCompile, call it first, and
// then layer the dissolve on the same shader object. The dissolve evaluates 3D
// simplex noise in object space, biased by distance from the bite origin, and
// discards fragments where n < uProgress. The thin band just above the threshold
// is pushed to a hot-amber emissive color (TOKENS.edgeHot) so the edge glows into
// the UnrealBloomPass (§11.4).
//
// startDissolve(ctx, biteWorldOrigin) injects the shader (once) and animates
// uProgress 0 -> 1; update(dt) advances it, emits sparks from the dissolving edge
// each frame, and fires sfx.play('poof') the instant the body is fully consumed.
import * as THREE from "three";
import type { SceneContext } from "../types";
import type { Sfx } from "../audio/sfx";
import { TOKENS } from "../render/tokens";
import { ParticleBurst } from "./particles";

// Seconds for the normalized animation t to travel 0 -> 1.
const DISSOLVE_SECONDS = 2.2;
// The shader threshold uProgress is t * PROGRESS_SPAN. snoise is in [-1,1] and the
// world-distance bias adds up to ~+0.9 near the far side, so n can reach ~1.7;
// sweeping the threshold across that full span guarantees the body is visually
// gone by t=1 (no leftover specks before the mesh is hidden), while the animation
// itself is still authored as the §10.1 "uProgress 0 -> 1" sweep.
const PROGRESS_SPAN = 1.7;
// Edge band width in noise units: how thick the glowing rim is (§10.1 uEdge).
const EDGE_WIDTH = 0.06;
// Noise frequency on object-space position (matches the GLSL `vObjPos * 4.0`).
const NOISE_FREQ = 4.0;
// How strongly distance from the bite origin biases the threshold, so the
// dissolve eats outward from where the user "bit" (matches GLSL `dist * 0.3`).
const BITE_BIAS = 0.3;

// Edge-emission sampling: per frame we test this many random surface vertices and
// spawn a spark from each one currently inside the active edge band. Kept small so
// the CPU edge probe stays well under the frame budget (§12.1).
const EDGE_SAMPLES_PER_FRAME = 220;

// GLSL 3D simplex noise (Ashima / Stefan Gustavson, MIT). Used by the fragment
// shader to decide discard + edge band. A separate JS simplex below drives the
// CPU edge probe for particle emission; the two need only agree in character, not
// bit-for-bit, since the probe just picks plausible edge points to emit from.
const GLSL_SIMPLEX = /* glsl */ `
    vec4 permute( vec4 x ) { return mod( ( ( x * 34.0 ) + 1.0 ) * x, 289.0 ); }
    vec4 taylorInvSqrt( vec4 r ) { return 1.79284291400159 - 0.85373472095314 * r; }
    float snoise( vec3 v ) {
        const vec2 C = vec2( 1.0 / 6.0, 1.0 / 3.0 );
        const vec4 D = vec4( 0.0, 0.5, 1.0, 2.0 );
        vec3 i  = floor( v + dot( v, C.yyy ) );
        vec3 x0 = v - i + dot( i, C.xxx );
        vec3 g = step( x0.yzx, x0.xyz );
        vec3 l = 1.0 - g;
        vec3 i1 = min( g.xyz, l.zxy );
        vec3 i2 = max( g.xyz, l.zxy );
        vec3 x1 = x0 - i1 + 1.0 * C.xxx;
        vec3 x2 = x0 - i2 + 2.0 * C.xxx;
        vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
        i = mod( i, 289.0 );
        vec4 p = permute( permute( permute(
            i.z + vec4( 0.0, i1.z, i2.z, 1.0 ) )
            + i.y + vec4( 0.0, i1.y, i2.y, 1.0 ) )
            + i.x + vec4( 0.0, i1.x, i2.x, 1.0 ) );
        float n_ = 1.0 / 7.0;
        vec3 ns = n_ * D.wyz - D.xzx;
        vec4 j = p - 49.0 * floor( p * ns.z * ns.z );
        vec4 x_ = floor( j * ns.z );
        vec4 y_ = floor( j - 7.0 * x_ );
        vec4 x = x_ * ns.x + ns.yyyy;
        vec4 y = y_ * ns.x + ns.yyyy;
        vec4 h = 1.0 - abs( x ) - abs( y );
        vec4 b0 = vec4( x.xy, y.xy );
        vec4 b1 = vec4( x.zw, y.zw );
        vec4 s0 = floor( b0 ) * 2.0 + 1.0;
        vec4 s1 = floor( b1 ) * 2.0 + 1.0;
        vec4 sh = -step( h, vec4( 0.0 ) );
        vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
        vec3 p0 = vec3( a0.xy, h.x );
        vec3 p1 = vec3( a0.zw, h.y );
        vec3 p2 = vec3( a1.xy, h.z );
        vec3 p3 = vec3( a1.zw, h.w );
        vec4 norm = taylorInvSqrt( vec4( dot( p0, p0 ), dot( p1, p1 ), dot( p2, p2 ), dot( p3, p3 ) ) );
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        vec4 m = max( 0.6 - vec4( dot( x0, x0 ), dot( x1, x1 ), dot( x2, x2 ), dot( x3, x3 ) ), 0.0 );
        m = m * m;
        return 42.0 * dot( m * m, vec4( dot( p0, x0 ), dot( p1, x1 ), dot( p2, x2 ), dot( p3, x3 ) ) );
    }
`;

// Compact JS 3D simplex noise (same algorithm family as the GLSL above) for the
// CPU edge probe. Self-contained: builds its own permutation + gradient tables.
class Simplex3 {
    private perm = new Uint8Array(512);
    private permMod12 = new Uint8Array(512);
    private static GRAD = new Int8Array([
        1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
        1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
        0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
    ]);

    constructor() {
        // Fixed source permutation (Perlin's reference table) → deterministic noise.
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        // Deterministic shuffle so the field is stable across runs.
        let seed = 1337;
        for (let i = 255; i > 0; i--) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const j = seed % (i + 1);
            const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
        }
        for (let i = 0; i < 512; i++) {
            this.perm[i] = p[i & 255];
            this.permMod12[i] = this.perm[i] % 12;
        }
    }

    private static dot(gi: number, x: number, y: number, z: number): number {
        const g = gi * 3;
        return Simplex3.GRAD[g] * x + Simplex3.GRAD[g + 1] * y + Simplex3.GRAD[g + 2] * z;
    }

    noise(xin: number, yin: number, zin: number): number {
        const F3 = 1.0 / 3.0, G3 = 1.0 / 6.0;
        const s = (xin + yin + zin) * F3;
        const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
        const t = (i + j + k) * G3;
        const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
        let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
        if (x0 >= y0) {
            if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
            else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
            else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
        } else {
            if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
            else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
            else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        }
        const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
        const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
        const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
        const ii = i & 255, jj = j & 255, kk = k & 255;
        let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
        let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * Simplex3.dot(this.permMod12[ii + this.perm[jj + this.perm[kk]]], x0, y0, z0); }
        let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * Simplex3.dot(this.permMod12[ii + i1 + this.perm[jj + j1 + this.perm[kk + k1]]], x1, y1, z1); }
        let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * Simplex3.dot(this.permMod12[ii + i2 + this.perm[jj + j2 + this.perm[kk + k2]]], x2, y2, z2); }
        let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        if (t3 > 0) { t3 *= t3; n3 = t3 * t3 * Simplex3.dot(this.permMod12[ii + 1 + this.perm[jj + 1 + this.perm[kk + 1]]], x3, y3, z3); }
        return 32.0 * (n0 + n1 + n2 + n3);
    }
}

interface DissolveUniforms {
    uProgress: { value: number };
    uEdge: { value: number };
    uBiteOrigin: { value: THREE.Vector3 }; // bite origin in WORLD space (§10.1)
    uEdgeColor: { value: THREE.Color };
}

export class Dissolve {
    private uniforms: DissolveUniforms | null = null;
    private material: THREE.MeshMatcapMaterial | null = null;
    private injected = false;
    private active = false;
    private done = false;
    private elapsed = 0;

    private burst: ParticleBurst;
    private noise = new Simplex3();
    private sfx: Sfx | null = null;

    // Bite origin in WORLD space (§10.1): feeds the shader distance bias and seeds
    // the particle spread direction.
    private biteWorld = new THREE.Vector3();

    // Surface sample pool size (vertex count) for the CPU edge probe.
    private sampleVertexCount = 0;

    // Shared context captured at startDissolve so update(dt) matches the §10
    // contract signature while the probe still reaches the mesh + scratch.
    private ctx: SceneContext | null = null;
    private scene: THREE.Scene | null = null;

    constructor() {
        this.burst = new ParticleBurst(TOKENS.edgeHot);
    }

    get isActive(): boolean {
        return this.active;
    }

    get isComplete(): boolean {
        return this.done;
    }

    // Patch the mesh material (preserving matcap + rim) and start the animation.
    // biteWorldOrigin is the right-hand "bite" point in WORLD space (§10.1).
    // `sfx` is the shared Sfx instance; play('poof') fires on completion (§10.4).
    startDissolve(ctx: SceneContext, biteWorldOrigin: THREE.Vector3, sfx: Sfx): void {
        if (this.active || this.done) return;
        this.sfx = sfx;
        this.ctx = ctx;
        this.scene = ctx.scene;
        if (!this.burst.object.parent) ctx.scene.add(this.burst.object);

        // §10.1 works entirely from the WORLD bite origin: the shader distance bias
        // is world-space and the particle spread blooms outward from it. The noise
        // term is object-space but is sampled in-shader from vObjPos, so no
        // object-space bite point is needed.
        ctx.mesh.updateWorldMatrix(true, false);
        this.biteWorld.copy(biteWorldOrigin);

        this.injectShader(ctx.mesh);
        this.sampleVertexCount = ctx.mesh.geometry.getAttribute("position").count;

        this.active = true;
        this.done = false;
        this.elapsed = 0;
    }

    // Inject the dissolve into the mesh's MeshMatcapMaterial via onBeforeCompile,
    // chaining the existing hook (the rim) so the matcap + rim survive.
    private injectShader(mesh: THREE.Mesh): void {
        if (this.injected) return;
        const material = mesh.material as THREE.MeshMatcapMaterial;
        this.material = material;

        // Per §10.1 the distance bias is measured in WORLD space against a world
        // bite origin (`length(vWorldPos - uBiteOrigin)`), while the noise is
        // sampled in object space (`vObjPos * 4.0`). The uniform carries the world
        // bite point.
        const uniforms: DissolveUniforms = {
            uProgress: { value: 0 },
            uEdge: { value: EDGE_WIDTH },
            uBiteOrigin: { value: this.biteWorld.clone() },
            uEdgeColor: { value: new THREE.Color(TOKENS.edgeHot) },
        };
        this.uniforms = uniforms;

        const prev_hook = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            // Preserve whatever was already injected (the Fresnel rim).
            if (prev_hook) prev_hook.call(material, shader, renderer);

            shader.uniforms.uProgress = uniforms.uProgress;
            shader.uniforms.uEdge = uniforms.uEdge;
            shader.uniforms.uBiteOrigin = uniforms.uBiteOrigin;
            shader.uniforms.uEdgeColor = uniforms.uEdgeColor;

            // --- Vertex: carry object-space + world-space position to the frag. ---
            shader.vertexShader = shader.vertexShader.replace(
                "#include <common>",
                `#include <common>
                varying vec3 vDissolveObjPos;
                varying vec3 vDissolveWorldPos;`,
            );
            // Inject just before <project_vertex>: by then `transformed` has been
            // through <morphtarget_vertex> + <skinning_vertex>, so it is the FINAL
            // (donut-morphed) object-space position. Capturing it here makes the
            // dissolve noise follow whatever shape the user actually sculpted.
            shader.vertexShader = shader.vertexShader.replace(
                "#include <project_vertex>",
                `vDissolveObjPos = transformed;
                vDissolveWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
                #include <project_vertex>`,
            );

            // --- Fragment: uniforms + noise + varyings. ---
            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <common>",
                `#include <common>
                uniform float uProgress;
                uniform float uEdge;
                uniform vec3 uBiteOrigin;
                uniform vec3 uEdgeColor;
                varying vec3 vDissolveObjPos;
                varying vec3 vDissolveWorldPos;
                ${GLSL_SIMPLEX}`,
            );
            // Discard consumed fragments as early as possible (right after clipping)
            // so dead pixels skip all lighting work. Per §10.1: distance bias in
            // WORLD space, noise in OBJECT space.
            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <clipping_planes_fragment>",
                `#include <clipping_planes_fragment>
                float dDist = length( vDissolveWorldPos - uBiteOrigin );
                float dNoise = snoise( vDissolveObjPos * ${NOISE_FREQ.toFixed(1)} ) + dDist * ${BITE_BIAS.toFixed(2)};
                if ( dNoise < uProgress ) discard;`,
            );
            // Tint the thin band just above the threshold toward hot amber and add
            // an emissive overshoot so the rim blooms. Done on the final fragment
            // color (after dithering) to stay independent of the rim's edit.
            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <dithering_fragment>",
                `#include <dithering_fragment>
                float dEdge = 1.0 - smoothstep( uProgress, uProgress + uEdge, dNoise );
                gl_FragColor.rgb = mix( gl_FragColor.rgb, uEdgeColor, dEdge );
                gl_FragColor.rgb += uEdgeColor * dEdge * 1.5;`,
            );
        };
        // Force a recompile so the new hook runs even if the material was already
        // compiled by a prior frame.
        material.needsUpdate = true;
        this.injected = true;
    }

    // Advance the animation, emit sparks from the live edge, fire 'poof' on finish.
    // Sweeps the §10.1 dissolve threshold over DISSOLVE_SECONDS (normalized t 0->1,
    // scaled to the noise span so the body fully clears).
    update(dt: number): void {
        const ctx = this.ctx;
        if (this.active && this.uniforms && ctx) {
            this.elapsed += dt;
            const t = Math.min(1, this.elapsed / DISSOLVE_SECONDS); // normalized 0..1
            const threshold = t * PROGRESS_SPAN; // actual shader discard threshold
            this.uniforms.uProgress.value = threshold;

            this.emitFromEdge(threshold);

            if (t >= 1) {
                this.active = false;
                this.done = true;
                ctx.mesh.visible = false; // body fully consumed
                this.sfx?.play("poof");
            }
        }
        // Keep simulating sparks until they settle, even after the body is gone.
        this.burst.update(dt);
    }

    // CPU edge probe (approximation of the GPU discard, for spark emission): sample
    // random base-surface vertices, evaluate the same biased noise — distance in
    // WORLD space, noise in OBJECT space, mirroring §10.1 — and emit one spark from
    // each vertex currently inside the [p, p+edge] band. The GPU shader remains the
    // exact visual edge; this probe only needs to pick plausible body-surface points.
    private emitFromEdge(progress: number): void {
        const ctx = this.ctx;
        if (!ctx || this.sampleVertexCount === 0 || progress >= PROGRESS_SPAN) return;
        const geo = ctx.mesh.geometry;
        const pos = geo.getAttribute("position");
        ctx.mesh.updateWorldMatrix(true, false);
        const world = ctx.scratch.v2;
        const bwx = this.biteWorld.x, bwy = this.biteWorld.y, bwz = this.biteWorld.z;

        for (let s = 0; s < EDGE_SAMPLES_PER_FRAME; s++) {
            const vi = (Math.random() * this.sampleVertexCount) | 0;
            const ox = pos.getX(vi), oy = pos.getY(vi), oz = pos.getZ(vi);
            // Object-space noise.
            const n_noise = this.noise.noise(ox * NOISE_FREQ, oy * NOISE_FREQ, oz * NOISE_FREQ);
            // World-space distance bias: take this vertex to world first.
            world.set(ox, oy, oz);
            ctx.mesh.localToWorld(world);
            const dist = Math.hypot(world.x - bwx, world.y - bwy, world.z - bwz);
            const n = n_noise + dist * BITE_BIAS;
            // Edge band: this point is being consumed this frame → spark here.
            if (n >= progress && n < progress + EDGE_WIDTH) {
                this.burst.emit(world, this.biteWorld, 1);
            }
        }
    }

    // Teardown for when the whole finale is dismantled. Drops the dissolve hook
    // (this also clears the rim, which is fine — CONSUMED is the terminal stage)
    // and removes + frees the particle system.
    dispose(): void {
        if (this.material && this.injected) {
            this.material.onBeforeCompile = () => {};
            this.material.needsUpdate = true;
        }
        if (this.scene && this.burst.object.parent) this.scene.remove(this.burst.object);
        this.burst.dispose();
        this.uniforms = null;
        this.material = null;
        this.ctx = null;
        this.injected = false;
    }
}
