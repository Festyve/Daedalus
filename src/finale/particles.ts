// §10.2 — GPU points burst emitted from the dissolving edge.
//
// A fixed-capacity THREE.Points pool (no per-frame geometry allocation): each
// emit() seeds dead slots with an outward + slight-gravity velocity; update(dt)
// integrates motion, decays size and fades alpha, and recycles expired slots.
// The custom ShaderMaterial draws additive, depth-write-off round sprites in the
// hot-amber edge color so the burst feeds the UnrealBloomPass (§11.4) like the
// dissolve edge band does.
import * as THREE from "three";

// Pool capacity — generous headroom for a ~2s dissolve at a few-hundred/sec emit
// rate. Slots beyond the live set sit at alpha 0 and cost nothing visually.
const MAX_PARTICLES = 4000;

// Motion + look tuning. GRAVITY pulls emitted sparks gently down (world -Y);
// OUTWARD_SPEED is the base radial launch speed, jittered per particle.
const GRAVITY = -1.6;          // world units / s^2
const OUTWARD_SPEED = 1.1;     // base radial launch speed (units / s)
const SPEED_JITTER = 0.7;      // +/- random added to the base speed
const LIFE_MIN = 0.45;         // s
const LIFE_MAX = 1.0;          // s
const SIZE_MIN = 0.018;        // world-space point size at birth
const SIZE_MAX = 0.05;
const DRAG = 1.8;              // velocity damping per second (exponential)

// gl_PointSize = size * SIZE_PIXEL_SCALE / viewDepth, so size is roughly world
// units; the constant maps that to device pixels at the scene's scale.
const SIZE_PIXEL_SCALE = 620.0;

const VERTEX_SHADER = /* glsl */ `
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aColor;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        // Perspective attenuation: closer points are larger. Clamp the depth so a
        // particle crossing the near side never explodes to a giant quad.
        float viewDepth = max( -mvPosition.z, 0.1 );
        gl_PointSize = aSize * ${SIZE_PIXEL_SCALE.toFixed(1)} / viewDepth;
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const FRAGMENT_SHADER = /* glsl */ `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
        // Round, soft-edged sprite from the point coord; discard the corners so
        // additive blending reads as a glowing dot, not a square.
        vec2 uv = gl_PointCoord - vec2( 0.5 );
        float d = dot( uv, uv );
        if ( d > 0.25 ) discard;
        float falloff = smoothstep( 0.25, 0.0, d );
        gl_FragColor = vec4( vColor, vAlpha * falloff );
    }
`;

export class ParticleBurst {
    readonly object: THREE.Points;

    private geometry: THREE.BufferGeometry;
    private material: THREE.ShaderMaterial;

    // GPU-visible attribute arrays (uploaded each frame while alive).
    private positions: Float32Array;
    private colors: Float32Array;
    private sizes: Float32Array;
    private alphas: Float32Array;

    // CPU-only per-particle simulation state, parallel by index.
    private velocities: Float32Array; // xyz per particle
    private life: Float32Array;       // remaining seconds (<= 0 => dead)
    private maxLife: Float32Array;    // total lifespan, for fade curves
    private birthSize: Float32Array;  // size at spawn, for decay curve

    private edgeColor: THREE.Color;
    private cursor = 0;     // round-robin write head for recycling slots
    private liveCount = 0;  // currently alive, for an early-out in update()

    constructor(edgeHex: string) {
        this.edgeColor = new THREE.Color(edgeHex);

        this.positions = new Float32Array(MAX_PARTICLES * 3);
        this.colors = new Float32Array(MAX_PARTICLES * 3);
        this.sizes = new Float32Array(MAX_PARTICLES);
        this.alphas = new Float32Array(MAX_PARTICLES);
        this.velocities = new Float32Array(MAX_PARTICLES * 3);
        this.life = new Float32Array(MAX_PARTICLES);
        this.maxLife = new Float32Array(MAX_PARTICLES);
        this.birthSize = new Float32Array(MAX_PARTICLES);

        this.geometry = new THREE.BufferGeometry();
        const pos_attr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
        const col_attr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
        const size_attr = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
        const alpha_attr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute("position", pos_attr);
        this.geometry.setAttribute("aColor", col_attr);
        this.geometry.setAttribute("aSize", size_attr);
        this.geometry.setAttribute("aAlpha", alpha_attr);
        // All slots start dead (alpha 0); draw the whole pool — invisible slots
        // are free. Bounding sphere would otherwise cull the moving cloud.
        this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

        this.material = new THREE.ShaderMaterial({
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthTest: true,
            depthWrite: false,
        });

        this.object = new THREE.Points(this.geometry, this.material);
        this.object.frustumCulled = false;
        this.object.renderOrder = 2; // draw over the mesh so sparks read on top
    }

    // Spawn `count` particles at a world-space origin, launched radially outward
    // from `spreadCenter` (the bite origin) so the burst blooms away from the
    // dissolving body rather than in a uniform random ball.
    emit(originWorld: THREE.Vector3, spreadCenter: THREE.Vector3, count: number): void {
        for (let n = 0; n < count; n++) {
            const i = this.cursor;
            this.cursor = (this.cursor + 1) % MAX_PARTICLES;
            if (this.life[i] <= 0) this.liveCount++;

            const i3 = i * 3;
            this.positions[i3] = originWorld.x;
            this.positions[i3 + 1] = originWorld.y;
            this.positions[i3 + 2] = originWorld.z;

            // Outward direction = from the bite center toward the emit point, with
            // a random jitter so the spray has volume. Fall back to a random
            // direction when the emit point coincides with the center.
            let dx = originWorld.x - spreadCenter.x;
            let dy = originWorld.y - spreadCenter.y;
            let dz = originWorld.z - spreadCenter.z;
            let len = Math.hypot(dx, dy, dz);
            if (len < 1e-4) {
                dx = Math.random() * 2 - 1;
                dy = Math.random() * 2 - 1;
                dz = Math.random() * 2 - 1;
                len = Math.hypot(dx, dy, dz) || 1;
            }
            dx /= len; dy /= len; dz /= len;
            // Add isotropic jitter to the unit direction.
            dx += (Math.random() * 2 - 1) * 0.5;
            dy += (Math.random() * 2 - 1) * 0.5;
            dz += (Math.random() * 2 - 1) * 0.5;
            const speed = OUTWARD_SPEED + Math.random() * SPEED_JITTER;
            this.velocities[i3] = dx * speed;
            this.velocities[i3 + 1] = dy * speed + Math.random() * 0.4; // slight upward bias
            this.velocities[i3 + 2] = dz * speed;

            const max_life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
            this.life[i] = max_life;
            this.maxLife[i] = max_life;

            const size = SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN);
            this.birthSize[i] = size;
            this.sizes[i] = size;
            this.alphas[i] = 1.0;

            this.colors[i3] = this.edgeColor.r;
            this.colors[i3 + 1] = this.edgeColor.g;
            this.colors[i3 + 2] = this.edgeColor.b;
        }
        if (count > 0) {
            // Newly written slots must reach the GPU. position/aSize/aAlpha are also
            // re-flagged by update() each frame, but aColor is written only here.
            this.geometry.attributes.position.needsUpdate = true;
            this.geometry.attributes.aColor.needsUpdate = true;
            this.geometry.attributes.aSize.needsUpdate = true;
            this.geometry.attributes.aAlpha.needsUpdate = true;
        }
    }

    // Integrate motion + decay. Cheap early-out when nothing is alive so the
    // burst costs ~0 before the dissolve starts and after it settles.
    update(dt: number): void {
        if (this.liveCount === 0) return;
        const damp = Math.max(0, 1 - DRAG * dt);
        for (let i = 0; i < MAX_PARTICLES; i++) {
            if (this.life[i] <= 0) continue;
            this.life[i] -= dt;
            const i3 = i * 3;
            if (this.life[i] <= 0) {
                // Retire: park off the alpha so the dead slot draws nothing.
                this.alphas[i] = 0;
                this.sizes[i] = 0;
                this.liveCount--;
                continue;
            }
            // Velocity: gravity + exponential drag, then advance position.
            this.velocities[i3] *= damp;
            this.velocities[i3 + 1] = this.velocities[i3 + 1] * damp + GRAVITY * dt;
            this.velocities[i3 + 2] *= damp;
            this.positions[i3] += this.velocities[i3] * dt;
            this.positions[i3 + 1] += this.velocities[i3 + 1] * dt;
            this.positions[i3 + 2] += this.velocities[i3 + 2] * dt;

            // Normalized remaining life 1->0 drives size decay + alpha fade.
            const t = this.life[i] / this.maxLife[i];
            this.sizes[i] = this.birthSize[i] * t;
            this.alphas[i] = t * t; // ease-out fade
        }
        this.geometry.attributes.position.needsUpdate = true;
        this.geometry.attributes.aSize.needsUpdate = true;
        this.geometry.attributes.aAlpha.needsUpdate = true;
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
    }
}
