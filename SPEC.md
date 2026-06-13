# Heisenberg — Technical Specification (v2, Deep)

> Sculpt 3D matter with your bare hands. No mouse. No tablet. No headset. Just a webcam, two hands, and the uncertainty of touch.
>
> **The arc:** a cold steel sphere → a torus → a decorated donut → eaten into nothing.

---

## Table of Contents
0. Document Status
1. The Thesis
2. The Signature Demo Arc
3. System Architecture
4. Hand Tracking Layer (deep)
5. Gesture Recognition & State Machine (deep)
6. Sculpt Engine (deep)
7. Morphology: Sphere → Torus (deep)
8. Decorate Phase (deep)
9. The "Eat It" Finale (deep)
10. Rendering & Shader Pipeline (deep)
11. Performance Engineering (deep)
12. Coordinate Spaces & Math Reference
13. Hardcoding / Director System
14. Aesthetic System & Design Tokens
15. Tooling, MCPs & Plugins
16. Build Plan (36h, hour-by-hour)
17. Risk Register & Fallbacks
18. Dependencies
19. File-by-File Manifest
20. Definition of Done
21. Pitch & Video Plan

---

## 0. Document Status

| | |
|---|---|
| **Project** | Heisenberg |
| **Event** | JAMHacks 10 (36h) |
| **Tracks targeted** | Best Overall · Best Non-GenAI · Best Developer Tool · Most Entertaining Pitch |
| **Team** | 4 |
| **Stack** | Three.js (WebGL2/WebGPU) · MediaPipe Tasks Vision · three-mesh-bvh · three-bvh-csg · Vite + TypeScript |
| **GenAI in product** | **None at runtime.** Pure computer vision + geometry processing. (GenAI may assist authoring/pitch only.) |
| **Structural inspiration** | `collidingScopes/shape-creator-tutorial` (MIT) — elevated to a typed modular engine |

---

## 1. The Thesis

### 1.1 What it is
Heisenberg is a browser-based real-time digital sculpting tool driven entirely by webcam hand tracking. The **left hand selects the active tool** (a mode/verb); the **right hand manipulates the mesh** (position, pressure, scale). Starting from a primitive sphere, the user sculpts, decorates, and ultimately destroys a 3D object — with their hands, in the air, in front of a camera.

### 1.2 Why the name
Heisenberg's uncertainty principle: you cannot simultaneously know a particle's exact position and momentum — observing perturbs the observed. Sculpting in mid-air is the same fight: the instant you hold your hand still to place a precise detail, micro-tremor and sensor noise conspire against you. Our entire **filtering layer (One Euro Filter)** is the conceptual answer to that uncertainty — turning chaos into clay. The name is a thesis statement, not decoration.

### 1.3 The pain it addresses
3D sculpting has a brutal learning curve. Blender takes months; ZBrush costs money and muscle memory. Mapping a 2D mouse to deform a 3D form is fundamentally unintuitive. Heisenberg collapses that gap: hands are already 3D input devices. Anyone walks up and sculpts in ten seconds. Immediate, physical, visceral.

### 1.4 Why it wins the room
- **Demo-first:** a human sculpts a donut from thin air and mimes eating it. No slide beats that.
- **Non-GenAI:** while everyone ships GPT wrappers, Heisenberg is real engineering — CV, BVH spatial queries, mesh deformation math, GPU shaders. SWE judges feel the difficulty.
- **Try-it-yourself:** judges raise their own hands. Participation → memory → votes.

---

## 2. The Signature Demo Arc

The product is choreographed around one ~90-second narrative. Each beat is a real capability tuned to look cinematic.

```
[ SPHERE ]  →  [ TORUS ]  →  [ DECORATE ]  →  [ EAT IT ]
   cold         hands         icing +          dissolve +
   steel        pull a        sprinkles        particles +
   icosphere    hole          scattered        "nom nom"
```

### Beat 1 — SPHERE (0:00–0:15)
Cold matcap icosphere on pure black. Webcam corner: desaturated feed + green hand skeleton. User raises both hands; skeleton tracks. Stage label `HEISENBERG // SPHERE`.

### Beat 2 — TORUS (0:15–0:40)
Left hand → **grab** pose (Grab tool). Right hand reaches "into" the sphere center and pulls; poles push through, a hole opens. A morph-target spine guarantees clean topology; real brush deformation rides on top so it feels hand-driven. Label `// TORUS`.

### Beat 3 — DECORATE (0:40–1:05)
Left hand → **open palm** (Decorate). Right-hand smear paints pink icing across the top (vertex-color painting). Pinch drops sprinkles — hundreds of instanced capsules along surface normals. Now unmistakably a donut. Label `// DECORATE`.

### Beat 4 — EAT IT (1:05–1:30)
Left hand → **fist** (the forbidden tool). User brings the donut toward their mouth (right hand pulls it toward the webcam). A noise-threshold **dissolve shader** eats geometry from the bite point outward; a hot emissive edge glows; **GPU particles** disintegrate into black. Optional: 2–3 real CSG bites first. Label `// CONSUMED` → Heisenberg wordmark.

---

## 3. System Architecture

### 3.1 High-level data flow

```
┌─────────────┐    ┌──────────────────────┐    ┌───────────────────┐
│   Webcam    │───▶│  MediaPipe            │───▶│  One Euro Filter  │
│ getUserMedia│    │  HandLandmarker (GPU) │    │  (per-landmark)   │
└─────────────┘    │  VIDEO mode, 2 hands  │    └─────────┬─────────┘
                   └──────────────────────┘              │
                                                          ▼
                                            ┌──────────────────────────┐
                                            │  Gesture / State Machine  │
                                            │  L hand → tool/mode        │
                                            │  R hand → brush pose+verb   │
                                            └─────────────┬──────────────┘
                                                          ▼
                          ┌──────────────────────────────────────────────┐
                          │              Sculpt Engine                    │
                          │  BVH query (three-mesh-bvh) → verts in r       │
                          │  → falloff displacement / Taubin smooth        │
                          │  → mark dirty → refit BVH nodes                 │
                          │  → recompute normals (dirty region only)        │
                          └─────────────┬────────────────────────────────┘
                                        ▼
                ┌────────────────────────────────────────────────────┐
                │                  Three.js Scene                      │
                │  matcap mesh + sprinkle InstancedMesh + particles    │
                │  → EffectComposer (GTAO + bloom + vignette)          │
                │  → canvas                                            │
                └────────────────────────────────────────────────────┘

  Parallel: renderer reads LATEST filtered pose every rAF.
  Rendering NEVER blocks on inference. Inference lag → render interpolates last pose.
```

### 3.2 Threading model
- **Main thread:** Three.js render loop (rAF), sculpt engine, UI.
- **Inference:** MediaPipe runs in `VIDEO` mode pumped from the same rAF, but its result is treated as *state* — the renderer never `await`s it inline.
- **Optional worker:** `OffscreenCanvas` + Web Worker for rendering if main-thread jank appears; MediaPipe can also be moved to a worker. Treated as an optimization, not a v1 dependency.
- **Decoupling rule:** a ring buffer / latest-value store holds the most recent filtered pose. Render reads; inference writes. No locks, last-write-wins.

### 3.3 Module boundaries
The engine is deliberately split so any beat can be developed, tested, and demoed in isolation (see §19 for the file manifest). The `core/director.ts` sits above everything and can drive phases deterministically for a bulletproof pitch.

---

## 4. Hand Tracking Layer (deep)

### 4.1 Library & loading
`@mediapipe/tasks-vision`, `HandLandmarker`. WASM fileset from `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm`; model `hand_landmarker.task` (float16). For canned left-hand gestures, `GestureRecognizer` is a drop-in superset (returns landmarks + handedness + 8 gesture classes).

### 4.2 Initialization
```ts
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
);
const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
        modelAssetPath: "/models/hand_landmarker.task",
        delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
});
```

### 4.3 The 21-landmark model (index reference)
```
0  WRIST
1  THUMB_CMC      2  THUMB_MCP     3  THUMB_IP      4  THUMB_TIP
5  INDEX_MCP      6  INDEX_PIP     7  INDEX_DIP     8  INDEX_TIP
9  MIDDLE_MCP    10  MIDDLE_PIP   11  MIDDLE_DIP   12  MIDDLE_TIP
13 RING_MCP      14  RING_PIP     15  RING_DIP     16  RING_TIP
17 PINKY_MCP     18  PINKY_PIP    19  PINKY_DIP    20  PINKY_TIP
```
- `landmarks` → normalized image space (`x,y` ∈ [0,1], `z` depth relative to wrist).
- `worldLandmarks` → meters, origin at hand geometric center (scale-invariant; preferred for gesture thresholds).
- `handedness` → `Left` / `Right` (mirror-aware; remember the webcam is mirrored — handedness already accounts for the model's convention, but the displayed video is flipped, so map deliberately).

### 4.4 Per-frame pump
```ts
function pump(video, tNowMs) {
    const res = handLandmarker.detectForVideo(video, tNowMs);
    // res.landmarks: Array<Array<{x,y,z}>>   (one per hand)
    // res.worldLandmarks, res.handedness, res.handednesses
    for each hand:
        role = handedness === "Left" ? TOOL_HAND : SCULPT_HAND  // assign by config
        filtered = oneEuro.apply(hand.landmarks, tNowMs)
        store.write(role, filtered)
}
```
In `VIDEO` mode, MediaPipe reuses the previous bounding box and skips palm detection most frames, cutting latency. Timestamps must be monotonically increasing (use `performance.now()`).

### 4.5 One Euro Filter (the uncertainty answer)
Adaptive low-pass: heavy smoothing at low velocity (kills jitter), light at high velocity (kills lag). One filter instance per (hand, landmark, axis) = 2 × 21 × 3 = 126 scalar filters. Cheap.

```
Parameters:
  min_cutoff = 1.0    # lower → smoother at rest (more lag)
  beta       = 0.007  # higher → snappier when moving (more jitter)
  d_cutoff   = 1.0    # cutoff for the derivative

Algorithm (per scalar x at time t):
  dx   = (x - x_prev) * rate
  edx  = lowpass(dx, alpha(d_cutoff))
  cutoff = min_cutoff + beta * |edx|
  x_hat = lowpass(x, alpha(cutoff))
  where alpha(c) = 1 / (1 + (rate / (2*pi*c)))
```
**Tuning protocol (live):** start `min_cutoff=1.0, beta=0.007`. If the cursor shivers at rest → halve `min_cutoff`. If it lags during fast strokes → double `beta`. Keep `d_cutoff=1.0`. Bind both to dev-only sliders.

### 4.6 Failure handling
- **No hands:** hold last pose for N frames (≈150ms) then fade brush out; never snap.
- **One hand lost:** keep the present hand's role active; suspend the missing role's actions.
- **Role ambiguity (both Left or both Right):** fall back to screen-x ordering for that frame only and log.
- **Confidence dips:** below threshold, freeze brush engagement (don't deform on noise).

---

## 5. Gesture Recognition & State Machine (deep)

### 5.1 Normalization
All thresholds are normalized by **hand scale** `S = ||wrist(0) − middleMCP(9)||` (in world landmarks), making gestures distance-invariant. Distances below are expressed as fractions of `S`.

### 5.2 Finger-extended predicate
A finger `f` is "extended" if its TIP is farther from the wrist than its PIP along the palm-normal-projected axis, AND the TIP–PIP–MCP angle exceeds ~160°. Curl is the inverse. Compute palm normal from `(indexMCP−wrist) × (pinkyMCP−wrist)`.

### 5.3 Left hand — discrete tool selector (debounced over 5 frames)

| Gesture | Predicate | Tool |
|---|---|---|
| Open palm | all 5 extended + spread > 0.4·S | Decorate / Smooth |
| Fist | all 4 fingers curled + thumb tucked | **Eat** |
| Grab/claw | fingers half-curled (~90°), thumb opposed | Grab/Move |
| Pinch | ‖tip4 − tip8‖ < 0.25·S | Carve |
| Thumbs up | thumb extended +y, others curled | Inflate |
| Peace | index+middle extended, ring+pinky curled | Undo |

**Debounce:** a gesture must hold ≥5 consecutive frames to commit a tool switch (prevents flicker). The committed tool latches until a different gesture holds 5 frames. Show the active tool in the HUD with a 120ms crossfade.

### 5.4 Right hand — continuous deformer

| Signal | Source | Drives |
|---|---|---|
| Brush position | INDEX_TIP(8), unprojected to mesh plane | brush center |
| Engage | pinch(4↔8) closed | stroke on/off |
| Pressure | pinch tightness OR palm openness ∈ [0,1] | brush strength |
| Two-hand scale | ‖wristL − wristR‖ delta | global object scale |
| Twist | hand roll (vector 5→17 angle) | optional rotate |

### 5.5 Brush state machine
```
IDLE ──(engage)──▶ ENGAGED ──(move)──▶ STROKING
  ▲                   │                    │
  └──(release)────────┴────(release)───────┘

On ENGAGED→STROKING: capture stroke origin, begin accumulating dirty set.
On *→IDLE: flush dirty set, finalize normals, push undo snapshot.
```
Undo = ring buffer of position-attribute snapshots (cap ~12; copy only dirty ranges to save memory).

### 5.6 Gesture conflict resolution
- Pinch vs Grab disambiguation: pinch requires thumb–index proximity AND other fingers *not* uniformly curled; grab requires uniform partial curl.
- Tool hand never deforms; sculpt hand never switches tools. Hard separation by handedness prevents cross-talk.

---

## 6. Sculpt Engine (deep)

### 6.1 Geometry baseline
- Icosphere, subdivided to **~40k triangles** (sweet spot: enough resolution for a clean torus + sprinkle adhesion, light enough for 60fps).
- Indexed `BufferGeometry`; attributes: `position`, `normal`, `color` (for icing), `morphTarget[0]` (torus).
- `geometry.computeBoundsTree()` (three-mesh-bvh) once at load; refit incrementally thereafter.

### 6.2 The per-stroke loop (authoritative)
```
1. fingertip(filtered) → world point P (see §12 unprojection)
2. bvh.shapecast / closestPointToPoint → candidate triangles within radius r of P
3. collect unique vertices V of those triangles where ‖v − P‖ ≤ r
4. for v in V:
     d = ‖v − P‖
     w = falloff(d / r)                  # see 6.3
     applyBrush(verb, v, w, ctx)         # see 6.4
     mark v, and its incident faces, dirty
5. bvh.refit(dirtyNodeSet)               # only touched nodes
6. recomputeNormals(dirtyVertexSet)      # see 6.5
7. geometry.attributes.position.addUpdateRange(start,count); needsUpdate=true
   (upload only changed ranges, not whole buffer)
```
**Never** rebuild the full BVH or recompute all normals per stroke. Dirty-region updates are the core perf trick.

### 6.3 Falloff kernels
```
smooth (default):  w = (1 - (d/r)^2)^2        # ZBrush/Blender feel
linear:            w = 1 - d/r
constant:          w = 1
sharp (crease):    w = (1 - d/r)^4
```
`r` (brush radius) and the kernel are the two dials that most affect "feel." Expose both to dev sliders; ship tuned constants.

### 6.4 Brush verbs
| Brush | Operation |
|---|---|
| **Grab/Move** | `v += w · drag` where `drag` = filtered fingertip delta this frame (primary torus tool) |
| **Inflate** | `v += w · strength · n_v` along vertex normal |
| **Draw** | `v += w · strength · n_brushAvg` (averaged area normal — smoother bulges) |
| **Flatten** | project `v` onto area-average plane: `v -= w·((v−c̄)·n̄)·n̄` |
| **Pinch** | move `v` toward brush axis in tangent plane by `w` |
| **Crease** | pinch + negative draw → sharp valley |
| **Smooth** | **Taubin** (see 6.6) |

### 6.5 Incremental normal recompute
For each dirty vertex, accumulate face normals of incident faces (precompute vertex→face adjacency once at load). Cheaper than `computeVertexNormals()` over the whole mesh. Normalize at the end. Update `normal` attribute's dirty range only.

### 6.6 Smoothing: Taubin, not Laplacian
Plain Laplacian moves each vertex toward its neighbors' centroid and **shrinks volume** (reported ~28% shrinkage for HC-Laplacian in topology studies). **Taubin** applies a positive step λ then a negative un-shrink step μ, behaving as a band-pass that **preserves volume** (reported ~15% volume *increase* in the same study — i.e. it resists collapse). For a donut whose thin tube would otherwise deflate, Taubin is mandatory.
```
λ ≈ 0.5,  μ ≈ -0.53           # |μ| slightly > λ
for k iterations:
    step(λ)   # v += λ · L(v)
    step(μ)   # v += μ · L(v)
where L(v) = (mean of neighbors) - v   (umbrella / uniform Laplacian)
```
Run 1–2 iterations per smooth stroke on the dirty set only.

### 6.7 Topology safety
Start tessellation high enough that the torus never needs live retopology. If detail is lacking for a beat, a one-shot uniform subdivide is available — but avoid live dyntopo on stage (risk). SculptGL-style dyntopo is a stretch goal, not a dependency.

---

## 7. Morphology: Sphere → Torus (deep)

Three layered strategies, in order of demo safety:

### 7.1 (A) Morph target — the reliable spine
- Pre-author a **torus with identical vertex count and ordering** to the start icosphere. (Generate by mapping each icosphere vertex to a torus parameterization, or author in Blender and export with matching index order.)
- Add as `morphTarget[0]`; drive `mesh.morphTargetInfluences[0]` 0→1 from a gesture scalar (two-hand "pull apart" or a sustained grab at center).
- GPU-interpolated per-vertex. Guaranteed clean, fast, repeatable. **This is the demo backbone.**

### 7.2 (B) Real brush deformation on top — the "my hands did that" flavor
- After/under the morph, let Grab/Inflate brushes push the center in and widen the ring so the transformation feels earned. The hole forms via inflate-negative at the poles or grab-through.

### 7.3 (C) Pure procedural blend — fallback
- `v = lerp(spherePos[i], torusPos[i], s)` driven by gesture scalar `s`. No brushes, no morph attribute — just math. Bulletproof but less tactile.

**Recommended:** morph spine (A) + brush flavor (B). Never rely solely on live topology change.

### 7.4 Torus parameterization (for authoring the target)
```
R = major radius (center of tube to center of torus)
r = minor radius (tube)
for sphere vertex with spherical coords (θ, φ):
    u = θ            # around the tube
    v = φ            # around the torus
    x = (R + r·cos(u))·cos(v)
    y = (R + r·cos(u))·sin(v)
    z = r·sin(u)
```
Choose `R, r` so the torus volume reads as a donut (e.g. R=1.0, r=0.42).

---

## 8. Decorate Phase (deep)

### 8.1 Icing — real-time vertex painting
- Right-hand smear writes color into a per-vertex `color` BufferAttribute.
- Affected vertices = same BVH radius query as sculpting; blend toward icing color by `w`.
- A height/threshold mask (`v.y > yIcingLine`) keeps icing on top, with a noisy boundary for a drip edge.
- Material uses `vertexColors: true`; the cold matcap shows through on the un-iced ring.

### 8.2 Sprinkles — instanced surface scatter
- `MeshSurfaceSampler(donut).setWeightAttribute('color').build()` once. Weighting by the icing color means sprinkles **only land on iced regions**.
- `sampler.sample(posTarget, normalTarget, colorTarget)` per sprinkle:
  - position = sampled surface point + `ε · normal` (sit on top, not embedded)
  - orientation = align sprinkle's long axis to a random tangent (or to normal for "standing" sprinkles)
  - color = random from a candy palette
- Render all as **one `InstancedMesh`** of tiny capsules/cylinders (cap ~800–1500 → one draw call). Each pinch "drops" a batch of N (e.g. 60) with a tiny scale-in animation.

### 8.3 Decals (optional)
`DecalGeometry` for a stamped detail (e.g. a glaze highlight) if time allows. Not required.

---

## 9. The "Eat It" Finale (deep)

### 9.1 Primary — Dissolve + GPU particles (reliable, cinematic)
**Dissolve shader** (patch the matcap material via `onBeforeCompile`, or a custom ShaderMaterial):
```glsl
// fragment
uniform float uProgress;     // 0 → 1 over the eat animation
uniform float uEdge;         // edge band width, e.g. 0.05
uniform vec3  uEdgeColor;    // hot emissive, e.g. amber-white
varying vec3  vObjPos;

float n = simplexNoise(vObjPos * uNoiseScale);   // object-space noise
if (n < uProgress) discard;                       // eaten away
float edge = smoothstep(uProgress, uProgress + uEdge, n);
vec3 col = mix(uEdgeColor, baseMatcapColor, edge);
// emissive boost in the edge band drives bloom
```
- Drive `uProgress` 0→1 from the bite contact point outward (bias the noise field by distance from the mouth-ward bite origin so it eats directionally, not uniformly).
- **GPU particles:** emit from the dissolving edge each frame; per-particle lifespan, velocity (outward + slight gravity), size decay, alpha fade. Implement as a points system with a custom shader updating positions on GPU (or CPU for ≤2k particles). Additive blend + bloom = "vaporizing."

### 9.2 Secondary — Real CSG bites (optional flex)
`three-bvh-csg`:
```ts
const evaluator = new Evaluator();
const result = evaluator.evaluate(donutBrush, biteSphereBrush, SUBTRACTION);
// or HOLLOW_SUBTRACTION to avoid requiring perfect manifoldness
```
>100× faster than BSP-based three.js CSG libs. **Risk:** experimental; numerical precision can yield non-manifold/missing tris. Use 2–3 bites for tactile credibility, then hand to the dissolve. **If it glitches in rehearsal, cut entirely.**

### 9.3 Best-of-both choreography
`2–3 CSG bites (real holes) → trigger dissolve → particle burst → fade to black → wordmark`.

### 9.4 Audio (cheap, huge ROI)
A subtle crunch SFX on each bite and a soft "poof" on dissolve. WebAudio, preloaded buffers. Sound sells the eat more than any shader.

---

## 10. Rendering & Shader Pipeline (deep)

### 10.1 Engine
Three.js r17x, `WebGLRenderer` (v1). Optional stretch: `WebGPURenderer` (~one-line swap, auto WebGL2 fallback) to unlock compute-shader particles.

### 10.2 Material — cold matcap
- `MeshMatcapMaterial` with a brushed-steel / obsidian matcap PNG (free: `nidorx/matcaps`).
- Matcap bakes lighting into a sphere texture sampled by view-space normal → **no scene lights**, dirt cheap, identical every frame from a fixed camera. The professional sculpting-app choice.
- `vertexColors: true` so icing paints over the steel.

### 10.3 Rim light
Fresnel via `onBeforeCompile`:
```glsl
float rim = pow(1.0 - max(dot(normalize(vNormal), vViewDir), 0.0), uRimPower);
gl_FragColor.rgb += rim * uRimColor;     // cold blue-white edge
```
Or a second additive cold matcap (double-matcap) for an even crisper editorial edge.

### 10.4 Post-processing
`EffectComposer`:
1. `RenderPass`
2. `GTAOPass` (or SSAO) — subtle contact shadows in crevices
3. `UnrealBloomPass` — rim + dissolve-edge glow (threshold high so only emissive blooms)
4. `OutputPass` + vignette (custom shader pass)

Keep post minimal — it competes with the sculpt loop for frame budget. Bloom threshold tuned so only the hot dissolve edge and rim bloom, not the whole mesh.

### 10.5 Camera
Fixed framing, slight idle dolly/parallax for life. Object rotates (slow auto-spin or hand-twist), camera mostly static so the matcap reads consistently.

### 10.6 Webcam overlay shader
Corner panel; desaturate + raise contrast (CSS `filter: grayscale() contrast()` or a tiny shader). Hand skeleton drawn via MediaPipe `drawConnectors`/`drawLandmarks` (HAND_CONNECTIONS) in green on a separate 2D canvas layered above the feed.

---

## 11. Performance Engineering (deep)

### 11.1 Frame budget (60fps = 16.6ms)
| Stage | Budget | Lever if over |
|---|---|---|
| MediaPipe inference | 8–12ms | GPU delegate, 720p input, VIDEO mode |
| One Euro filtering | <1ms | — |
| Gesture + state | <1ms | — |
| BVH query + deform | 2–5ms | smaller radius, fewer verts, coarser mesh |
| Normal recompute | 1–3ms | dirty-only, adjacency precomputed |
| Render + post | 4–6ms | cut GTAO, lower bloom res |

### 11.2 Hard rules
- **GPU delegate mandatory** (CPU WASM ≈ 10–15fps).
- **Decouple** inference from render (latest-value store; never block).
- **Dirty-region only** — never full BVH rebuild or full normal recompute per stroke.
- **Reuse temporaries** — module-level `Vector3`/`Matrix4`/`Plane` scratch objects; zero per-frame allocation in the hot loop (avoid GC pauses).
- **One InstancedMesh** for sprinkles; cap particle count.
- **Webcam at 720p** — MediaPipe internally downscales to ~192–256px, so higher res only burns CPU with no accuracy gain.
- **`addUpdateRange`** to upload only changed attribute ranges, not the whole buffer.
- **`powerPreference: "high-performance"`** on the renderer; `antialias: true` only if budget allows (MSAA cost), else FXAA pass.

### 11.3 Profiling protocol
- `stats.js` (FPS/ms/MB) always on in dev.
- Chrome DevTools Performance panel for flame charts; watch for long tasks > 16ms and GC sawtooth.
- Use the **Chrome DevTools MCP** (see §15) to let the agent pull live perf traces and propose fixes.

### 11.4 Worker offload (stretch)
`OffscreenCanvas.transferControlToOffscreen()` → render in a worker; post landmarks via `postMessage` (or `SharedArrayBuffer` with COOP/COEP headers for zero-copy). Only if main-thread jank is observed.

---

## 12. Coordinate Spaces & Math Reference

### 12.1 The spaces
1. **Image space** — MediaPipe `x,y ∈ [0,1]`, origin top-left, `y` down. Mirrored vs the user (selfie view).
2. **NDC** — `x,y ∈ [-1,1]`. `ndcX = x*2-1`, `ndcY = -(y*2-1)` (flip y). Mirror handling: if the displayed video is flipped, negate `ndcX` for on-screen correspondence.
3. **World space** — Three.js scene. Unproject NDC onto an interaction plane.

### 12.2 Fingertip → world point (the unprojection)
The sculpt brush needs a 3D point. Two options:
- **Plane unprojection (v1):** define an interaction plane facing the camera at the object's depth. Raycast from camera through NDC; intersect the plane → brush point. Use MediaPipe `z` (or world-landmark depth) to push the plane nearer/farther for a sense of depth.
- **Direct world-landmark mapping (stretch):** scale MediaPipe world landmarks (meters) into scene units and place the brush at the actual 3D fingertip; gives true z-depth sculpting but needs careful calibration.

### 12.3 Hand scale & invariance
`S = ‖wrist − middleMCP‖` (world landmarks). All gesture distance thresholds use fractions of `S`. Object scale gesture uses `‖wristL − wristR‖ / S_avg` so it's invariant to how close the user stands.

### 12.4 Smoothing math
See §4.5 (One Euro). Apply in image space *before* unprojection so depth jitter is also tamed.

---

## 13. Hardcoding / Director System

Per the guiding principle: **optimize for a flawless 90-second demo, not general robustness.**

- **Tuned constants:** brush radius, falloff, smooth iterations, morph rate, sprinkle batch size, dissolve speed are pre-tuned constants so the result is always satisfying regardless of hand-distance variance.
- **Authored morph spine:** sphere→torus is authored, not solved → guaranteed clean topology.
- **`core/director.ts`** is a phase sequencer:
  - `auto` mode advances SPHERE→TORUS→DECORATE→EAT on gesture cues.
  - `scripted` mode advances on keypress (or timed), so a tracking hiccup never derails the pitch. The hands still appear to drive it; the director just guarantees the beats land.
  - `freeplay` mode for judges to mess around after the pitch.
- **Known-good commit** before every risky feature merge; deploy target is a static host (GitHub Pages / Vercel) so the live URL always works.

This is the difference between a lab demo and a stage win — not cheating, choreography.

---

## 14. Aesthetic System & Design Tokens

### 14.1 Palette
```
--bg:        #000000   /* pure black */
--steel:     matcap (brushed steel / obsidian)
--rim:       #AEE8FF   /* cold blue-white edge */
--icing:     #FF3E9A   /* hot candy pink (the only warm accent) */
--edge-hot:  #FFE6B0   /* dissolve edge */
--text:      #FFFFFF
--text-dim:  rgba(255,255,255,0.45)
```

### 14.2 Type
JetBrains Mono (OFL), everywhere. Uppercase, letter-spaced for stage labels (`HEISENBERG // TORUS`). Lowercase mono for HUD/FPS.

### 14.3 Chrome layout
- Top-left: stage label.
- Bottom-left: active tool (left-hand) label.
- Bottom-right: desaturated webcam + green skeleton.
- Top-right: FPS (dimmed).
- No gradients, no rounded panels, no decoration. Brutalist editorial — black, white, one pink.

### 14.4 Motion
Smooth camera, subtle bloom on rim + dissolve, vignette. Crossfades ≤120ms. Nothing bouncy; everything precise.

---

## 15. Tooling, MCPs & Plugins

> Goal: maximize build velocity in 36h. Keep the MCP set **small** (3–5 servers; each adds 500–1,000 tokens/tool to context — five servers ≈ 50–75k tokens before you ask anything). Use only servers that solve a *this-weekend* problem. Prefer vendor-maintained servers (security: a large share of public MCP servers have findings).

### 15.1 Core dev MCPs (install these)
| MCP | Why for Heisenberg | Install (Claude Code) |
|---|---|---|
| **Context7** | Three.js / MediaPipe / three-mesh-bvh move fast; Context7 injects **version-correct** docs & API examples so the agent doesn't hallucinate dead APIs. Append `use context7` to prompts. Highest-value pick. | `claude mcp add context7 -- npx -y @upstash/context7-mcp` |
| **Chrome DevTools MCP** | Official Google server. Lets the agent drive a live Chrome, pull **performance traces**, read console/network, inspect the DOM. Critical for hitting 60fps — the agent can profile the sculpt loop and propose fixes. Add `--slim` for token-lean. | `claude mcp add chrome-devtools -s user -- npx chrome-devtools-mcp@latest` |
| **GitHub MCP** | Issue/PR/commit context inline; manage the repo, the 30-commit history, releases. Reduces context-switching. | `claude mcp add github -- npx -y @modelcontextprotocol/server-github` |
| **Playwright MCP** (optional) | Only if you want cross-browser smoke tests (Firefox/WebKit) of the demo build. Accessibility-tree driving, deterministic. Skip if Chrome-only. | `claude mcp add playwright -s user -- npx @playwright/mcp@latest` |
| **Serena** (optional) | Semantic code index for the monorepo — symbol search, dependency tracing across many files. Useful once the engine grows. | per Serena README (local binary) |

**Recommended minimal set:** Context7 + Chrome DevTools + GitHub. Add Playwright only for cross-browser verification near the end.

### 15.2 Claude Code skills/plugins (project-local)
- A **`frontend-design` skill** / `CLAUDE.md` conventions doc enforcing: 4-space indent, the matcap aesthetic, no runtime GenAI, module boundaries from §3.
- **MCP Tool Search** enabled so Context7's tools load on-demand instead of eating context at session start.
- Hooks: a pre-commit hook running `tsc --noEmit` + `vitest` so the agent can't push a broken build.

### 15.3 Pitch-video tooling (NOT build tools)
> These touch GenAI and must **not** power the product (Non-GenAI track). They're for the *pitch video* only.
- **Higgsfield AI** — cinematic AI video tool: multi-model aggregator (Sora/Kling/Veo) with a **Cinema Studio** virtual camera rig (crash zooms, dolly, 360 orbits, Boltcam angles; stackable camera moves; genre pacing). Excellent for a dramatic intro/outro sting or B-roll cutaways in the pitch video. Credit-based; the free Diffuse app tier gives daily credits. Use for: title card, "vaporize" transition flourish, cinematic establishing shots around the live screen-capture.
- **CapCut / DaVinci Resolve (free)** — actual edit/timeline for the 90s cut.
- **OBS Studio (free)** — capture the live browser demo at 60fps for the screen-recording core of the video.
- **WebAudio SFX packs (CC0)** — crunch/poof sounds (these *are* shippable in-product; they're not GenAI).

### 15.4 Asset tooling
- **Blender (free)** — author the same-topology torus morph target; bake/select matcaps; preview materials.
- **nidorx/matcaps (free)** — matcap PNG library (steel/obsidian).
- **JetBrains Mono (OFL)** — UI typeface.

### 15.5 Deploy
- **Vite build** → static output.
- **GitHub Pages or Vercel (free)** — the live demo URL. Ensure COOP/COEP headers if using SharedArrayBuffer (Vercel: `vercel.json` headers; Pages: a `_headers`-equivalent or meta workaround).

---

## 16. Build Plan (36h, hour-by-hour)

| Window | Goal | Owner hint |
|---|---|---|
| **0–2h** | Repo, Vite+TS scaffold, `CLAUDE.md`, MCPs (Context7 + Chrome DevTools + GitHub), deploy a hello-triangle to the live URL. | all |
| **2–6h** | Webcam + HandLandmarker (GPU, VIDEO, 2 hands) + One Euro. Matcap sphere renders. Green skeleton overlay. Verify <80ms feel on the demo machine. | CV + render |
| **6–12h** | three-mesh-bvh sculpt loop (port from `sculpt.html`). Right-hand pinch/grab → grab/inflate/Taubin-smooth. Dirty-region updates + incremental normals. | engine |
| **12–18h** | Left-hand gesture detection + debounced tool state machine + HUD. Brush feel tuning (radius/falloff). | gesture + UI |
| **18–24h** | Sphere→torus morph target + real brush blend. Director phase sequencing (auto + scripted). | engine + director |
| **24–29h** | Decorate: vertex-color icing + MeshSurfaceSampler sprinkles (InstancedMesh). | decorate |
| **29–33h** | Eat finale: dissolve shader + GPU particles + bloom + crunch SFX. Optional 2–3 CSG bites. | finale + shaders |
| **33–35h** | Polish: JetBrains Mono chrome, vignette/GTAO, webcam overlay styling, full demo run-throughs. | all |
| **35–36h** | Record pitch video (OBS capture + Higgsfield stings + CapCut/Resolve cut). Final known-good commit + deploy. | all |

**Invariant:** a deployable known-good build exists at every window boundary.

---

## 17. Risk Register & Fallbacks

| Risk | Trigger | Fallback |
|---|---|---|
| MediaPipe FPS poor on demo machine | <30fps | numHands→1, webcam→720p, drop post-processing |
| three-bvh-csg artifacts | non-manifold/missing tris in rehearsal | cut booleans, dissolve-only finale |
| Live sculpt jitters | shaky cursor | raise One Euro `min_cutoff`, reduce mesh density |
| Frame budget blown | jank | render→OffscreenCanvas worker; cut GTAO/bloom |
| Torus topology breaks | hole won't form cleanly | rely purely on morph target for that beat |
| Tracking fails on stage | lost hands | `director.ts` scripted keypress-advance mode |
| Unprojection depth feels off | brush floats | lock to fixed interaction plane (drop z-depth) |
| Deploy headers (COOP/COEP) missing | SharedArrayBuffer fails | drop worker path; main-thread render |

### De-risked minimum-viable build
Single hand · GestureRecognizer canned gestures for mode · sphere→torus morph-only · sprinkles-only decorate · dissolve-only eat · plain matcap, no post. Still delivers the full **sphere→torus→decorate→eat** narrative; buildable well under 36h. Layer ambition back in as time allows.

---

## 18. Dependencies

| Package | Purpose | License |
|---|---|---|
| `three` | rendering, geometry, math | MIT |
| `@mediapipe/tasks-vision` | hand tracking | Apache-2.0 |
| `three-mesh-bvh` | sculpt spatial queries | MIT |
| `three-bvh-csg` | optional real bites | MIT |
| `vite` + `typescript` | build/dev | MIT / Apache-2.0 |
| `vitest` | tests | MIT |
| `stats.js` | FPS overlay | MIT |
| One Euro Filter (vendored) | landmark smoothing | BSD/MIT-style |
| `nidorx/matcaps` | matcap textures | CC |
| JetBrains Mono | UI typeface | OFL |

**Zero paid services. Zero runtime GenAI. Everything free and open-source.**

---

## 19. File-by-File Manifest

```
heisenberg/
├── CLAUDE.md                      # conventions: 4-space, aesthetic, no runtime GenAI
├── index.html
├── vite.config.ts
├── tsconfig.json
├── public/
│   ├── models/hand_landmarker.task
│   ├── matcaps/steel.png
│   └── fonts/JetBrainsMono.woff2
├── src/
│   ├── core/
│   │   ├── loop.ts                # master rAF, decoupled inference/render
│   │   ├── director.ts            # phase sequencer (auto/scripted/freeplay)
│   │   └── store.ts               # latest-pose value store
│   ├── capture/
│   │   └── webcam.ts              # getUserMedia, video element
│   ├── tracking/
│   │   ├── handLandmarker.ts      # MediaPipe init + pump
│   │   └── oneEuro.ts             # One Euro Filter
│   ├── gesture/
│   │   ├── predicates.ts          # finger-extended, pinch, spread, hand scale
│   │   ├── detect.ts              # landmarks → discrete gestures
│   │   └── stateMachine.ts        # tool latch + brush FSM + undo ring
│   ├── sculpt/
│   │   ├── engine.ts              # BVH query, dirty tracking, normal recompute
│   │   ├── brushes.ts             # grab/inflate/draw/flatten/pinch/crease
│   │   ├── smooth.ts              # Taubin
│   │   └── morph.ts               # sphere↔torus morph driver
│   ├── decorate/
│   │   ├── icing.ts               # vertex-color painting
│   │   └── sprinkles.ts           # MeshSurfaceSampler + InstancedMesh
│   ├── finale/
│   │   ├── dissolve.ts            # dissolve shader + uniforms
│   │   ├── particles.ts           # GPU particle burst
│   │   └── csg.ts                 # optional three-bvh-csg bites
│   ├── render/
│   │   ├── scene.ts               # camera, matcap, composer, rim
│   │   ├── post.ts                # GTAO + bloom + vignette
│   │   └── overlay.ts             # webcam corner + skeleton draw
│   ├── ui/
│   │   └── chrome.ts              # stage label, tool HUD, FPS
│   ├── audio/
│   │   └── sfx.ts                 # crunch/poof WebAudio
│   └── main.ts                    # bootstrap
└── tests/
    ├── predicates.test.ts
    ├── oneEuro.test.ts
    ├── brushes.test.ts
    └── morph.test.ts
```

---

## 20. Definition of Done

- [ ] Open URL → webcam grants → sphere appears in <3s
- [ ] Both hands tracked with green skeleton; <80ms perceived latency
- [ ] Left hand reliably switches tools (debounced, visible in HUD)
- [ ] Right hand sculpts with satisfying clay-like feel (Taubin smooth, tuned falloff)
- [ ] Sphere → torus reads as hand-driven and resolves cleanly (morph spine + brush flavor)
- [ ] Icing paints + sprinkles scatter only on iced regions
- [ ] "Eat it" dissolve + particles + crunch SFX fire and look cinematic
- [ ] Holds 60fps on the demo machine in Chrome
- [ ] `director.ts` scripted-demo fallback works without live tracking
- [ ] Known-good build committed and deployed to a live static URL
- [ ] 90-second pitch video recorded (OBS core + Higgsfield stings + edited cut)

---

## 21. Pitch & Video Plan

### 21.1 Live demo (on stage)
Run `director` in `auto` mode; if tracking flakes, a teammate quietly switches to `scripted`. Narrate the four beats. End by inviting a judge to try `freeplay`.

### 21.2 Pitch video (90s)
- **Core:** OBS 60fps screen capture of a clean run (sphere→torus→decorate→eat).
- **Stings:** Higgsfield Cinema Studio for a title card and a dramatic "vaporize" transition; cold, brutalist, matches the app aesthetic. (Pitch only — never in-product.)
- **Audio:** crunch/poof SFX synced; minimal cold synth bed.
- **Edit:** CapCut or DaVinci Resolve (free). Cut to the beat; hard cuts, no fluff.
- **Last frame:** the Heisenberg wordmark on black + the live URL.

### 21.3 The one-liner
> "Blender takes months to learn. Heisenberg takes ten seconds and two hands. Watch me make a donut — and eat it."

---

*Heisenberg — you can know where your hand is, or what it's shaping. Never both. That's the fun.*
