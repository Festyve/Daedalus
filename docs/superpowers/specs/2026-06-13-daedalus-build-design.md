# DAEDALUS — Build / Migration Design

> Status: **approved (build design)** · Date: 2026-06-13 · Owner: Jerry Li
> Companion to **SPEC.md** (v3). SPEC.md is the authoritative **WHAT**; this document is the **HOW**:
> how the existing brownfield repo migrates to the SPEC §20 architecture, in what order, and how the
> work is fanned out across a parallel agent fleet without anyone stepping on anyone.

---

## 1. Purpose & relationship to SPEC.md

SPEC.md fully specifies the product (the eight spatial menus, the sphere→donut→decorate→eat arc, the
sculpt engine, the rendering pipeline, the performance budget). It does **not** specify how to get there
from the code that already exists in this repo. That gap is what this document closes.

Read SPEC.md first. This doc never re-states SPEC requirements; it only adds the migration plan, the
parallelization strategy, and a small number of explicit technical decisions where the SPEC left a real
choice open.

---

## 2. Locked decisions (resolved with the user before any code)

| # | Fork | Decision |
|---|---|---|
| 1 | Build system / language | **Vite + TypeScript per §20.** Port the working MediaPipe / CSG / gesture logic into typed modules — preserve algorithms, do not reinvent. Adds `vitest`. |
| 2 | Scope | **Full SPEC** — all 8 menus + calibration + sculpt engine + blend-shape morph + AI-chat decorate + sprinkles/icing + dissolve finale + matcap/rim/GTAO/bloom/vignette + director modes + audio + tests. The complete §21 Definition of Done. |
| 3 | Donut morph | **§8 blend-shape** (authored torus target, identical topology, squish-driven `t`). The existing CSG-bore code is **retained** for INTERACT (§6.5) and the optional finale bites (§10.3), not for the donut. |

The user approved this build design and requested the design doc be written and reviewed before scaffolding.

---

## 3. Reconciliation — existing repo inventory

Merged PR #1 ("HandSculpt"). Vanilla JS, CDN import map, no build step. Demonstrably works today:
`sphere → squash to disc → CSG-bore the hole → fit a torus`. Pinned, mutually-compatible CDN versions
(three 0.160, three-mesh-bvh 0.7.0, three-bvh-csg 0.0.16, @mediapipe/tasks-vision 0.10.12).

| File | Responsibility | Verdict |
|---|---|---|
| `js/handTracking.js` | MediaPipe HandLandmarker (GPU, VIDEO, 2 hands), **EMA** smoothing, mirrored preview + skeleton overlay | **Reuse** (port; swap EMA → One Euro) |
| `js/gestures.js` | `classify` (fist/open/point/pinch), `palmCenter`, `DiscreteTrigger` | **Reuse** (port + extend: spread, squish, hand-scale `S`) |
| `js/scene.js` | three scene, lights, contact shadow, tilt/spin groups, OrbitControls | **Partial** (port; StandardMaterial → matcap + rim; add post) |
| `js/modeling.js` | scale, squash, **CSG bore**, fit-torus | **Repurpose** (CSG → INTERACT + finale bites; donut rebuilt as blend-shape) |
| `main.js` | rAF loop, stage machine, keyboard fallbacks, `window.HS` debug API | **Reuse pattern** → `main.ts` + `core/loop.ts` + `core/director.ts` |
| `js/ui.js` | status panel, instructions, banner | **Reuse** → `ui/chrome.ts` |
| `index.html` / `styles.css` | shell, import map | **Replace** with Vite `index.html` + token-driven CSS |

**Gap ≈ 90 % of SPEC, all net-new:** One Euro filter + calibration ritual (§0.6) · radial ring menu +
8 menu modules + router (§5–6) · BVH sculpt engine + Taubin (§7) · blend-shape donut morph (§8) ·
AI chat panel CSS3D + typewriter (§9) · icing / sprinkles (`MeshSurfaceSampler` + `InstancedMesh` +
Poisson) (§9) · dissolve shader + GPU particles (§10) · matcap / rim / GTAO / bloom / vignette (§11) ·
director modes (§14) · audio (§10.4) · vitest suite (§20).

---

## 4. Migration map (old → new)

```
js/handTracking.js  ──►  tracking/webcam.ts        (getUserMedia, video element)
                    ──►  tracking/handLandmarker.ts (MediaPipe init + pump + overlay feed)
js/handTracking.js (EMA) ──►  tracking/oneEuro.ts   (replace EMA with adaptive One Euro, §4.4)
js/gestures.js      ──►  gesture/predicates.ts      (classify, palmCenter, spread, squish, hand-scale S)
                    ──►  gesture/detect.ts          (landmarks → discrete gestures)
                    ──►  gesture/stateMachine.ts    (menu-nav + execution FSM + undo ring; DiscreteTrigger)
js/scene.js         ──►  render/scene.ts            (camera, matcap, rim, CSS3DRenderer, composer wiring)
                    ──►  render/post.ts             (GTAO + bloom + vignette)
                    ──►  render/overlay.ts          (webcam corner + green skeleton)
js/modeling.js(CSG) ──►  menu/interact.ts           (Evaluator union/subtract/intersect, §6.5)
                    ──►  finale/csg.ts              (optional subtract bites, §10.3)
main.js             ──►  main.ts                    (bootstrap)
                    ──►  core/loop.ts               (decoupled inference/render rAF)
                    ──►  core/director.ts           (guided/assist/safety/freeplay, §14)
                    ──►  core/store.ts              (latest-pose ring buffer, §3.1)
js/ui.js            ──►  ui/chrome.ts               (stage label, active-menu HUD, FPS)
index.html/styles   ──►  index.html (Vite) + token-driven styling
```

Everything else in SPEC §20 is created fresh.

---

## 5. Target architecture

SPEC §20 file-by-file manifest, verbatim, as TypeScript. No structural deviation. Module boundary rule
(SPEC §3.2) is load-bearing for the parallel build: **each menu / feature module talks only to shared
scene state via the router, never to a sibling module.** This is what lets independent agents own
independent modules.

---

## 6. Shared contracts first — the parallelization unlock

Before any feature work, **P0 freezes every cross-module interface in `src/types.ts`** (and the design
tokens in `render/tokens.ts`). With the contracts frozen, P1/P2 agents compile against stable types and
never need to coordinate. Contracts to freeze:

- `CalibrationProfile` (SPEC §0.6.3) · `PoseFrame` / `HandPose` (filtered landmarks + world-z + handedness)
- `MenuId` enum (ADD_SHAPES | TRANSLATE | DILATE | ROTATE | INTERACT | MORPH | DECORATE | DESTROY)
- `BrushVerb` enum (Grab | Inflate | Draw | Flatten | Pinch | Crease | Smooth)
- `Gesture` discriminated union · `ChatTurn` / `DecorationAction` (SPEC §9.2.2)
- `SprinkleDesign` / `IcingDesign` / `GlazeDesign` (SPEC §9.3)
- `MenuModule` interface: `{ enter(ctx), update(ctx, dt), exit(ctx), panel(): PanelSpec }` — the contract
  every menu honors so the router can drive them uniformly.
- `SceneContext`: the shared state handle (active mesh, BVH, camera, scratch math objects, calibration,
  tokens) passed to every module — the single channel modules communicate through.

---

## 7. Key technical decisions & explicit assumptions

1. **Morph topology — co-generated grid (resolves §7.1 vs §8.3).** SPEC §7.1 says "icosphere"; §8.1/§8.3
   require the donut morph target to share *identical vertex count and ordering*. A geodesic icosphere
   has no clean (θ,φ) grid, so the literal mapping is messy. **Decision:** one generator emits, from a
   single shared (u,v) parametric grid (~201×101 ≈ 40k tris), both the sphere `position` attribute and
   the torus `morphAttributes.position[0]`, plus one shared index buffer. Identical topology *by
   construction* → the blend shape is exact and seam-free. Torus params `R=1.0, r=0.42` (§8.1).
   *Trade-off accepted:* a UV-grid sphere has pole pinching the geodesic wouldn't; irrelevant because the
   sphere is the start state and the donut (no poles) is the hero.
2. **Sculpt ⊕ morph interaction (§6.6, §8.2).** Brushes write the `position` attribute; the morph blends
   `final = position·(1−t) + torusTarget·t`. Hand sculpting therefore persists and blends through the
   morph ("real geometry underneath responds on top"). BVH raycasts against `position`; refit is
   dirty-region only (§7.2). The morph `t` is a uniform-cheap blend, so it never invalidates the BVH.
3. **One Euro replaces EMA (§4.4).** 2 × 21 × 3 = 126 scalar filters, params from `CalibrationProfile`,
   adaptive `min_cutoff`/`beta`. Defaults §0.6.4.
4. **Matcap not StandardMaterial (§11.2).** `MeshMatcapMaterial`, cold steel matcap, `vertexColors:true`
   so icing paints; rim via `onBeforeCompile` Fresnel (§11.3).
5. **Coordinate math is a shared util (§13).** Fingertip → NDC → world unprojection + arrow-axis
   projection + rotation-quaternion helpers live in one module everyone imports (zero per-frame alloc:
   reused scratch `Vector3`/`Matrix4`/`Plane`, SPEC §12.2).
6. **Version matrix — Context7-verified at P0.** Baseline is the existing CDN-verified set; before
   `package.json` is locked, Context7 confirms three ↔ three-mesh-bvh ↔ three-bvh-csg ↔ tasks-vision
   compatibility (the classic "two copies of three breaks CSG" footgun, SPEC index.html note).

---

## 8. Build phase DAG

```
P0 Foundation (serial) ──► P1 Pillars (parallel) ──► P2 Features (parallel) ──► P3 Integration (serial) ──► P4 Polish + Verify
```

**P0 — Foundation** *(serial, single agent — everything depends on it)*
Vite + TS scaffold · Context7-verified `package.json` · `tsconfig.json` · `vite.config.ts` (COOP/COEP
headers, §16.4) · `index.html` · **`src/types.ts` (all §6 contracts)** · `render/tokens.ts` (§15.1) ·
public asset slots (model, matcap, font, sfx). Gate: `vite build` + `tsc --noEmit` clean.

**P1 — Pillars** *(parallel fleet; depend only on P0)*
- tracking: `webcam.ts`, `handLandmarker.ts`, `oneEuro.ts`, `calibration.ts` (+ oneEuro/calibration tests)
- gesture: `predicates.ts`, `detect.ts`, `stateMachine.ts` (+ predicates test)
- render: `scene.ts`, `post.ts`, `overlay.ts`
- sculpt: `engine.ts`, `brushes.ts` (+ brushes test)
- math: coordinate/unprojection util (§13)
- core: `store.ts`, `loop.ts`, `director.ts`
- audio: `sfx.ts`
Gate: `tsc --noEmit` clean; module tests green.

**P2 — Features** *(heaviest parallel fleet; depend on P1)*
- menu infra: `radialRing.ts`, `spatialPanel.ts`, `menuRouter.ts`
- 8 menus: `addShapes.ts`, `translate.ts`, `dilate.ts`, `rotate.ts`, `interact.ts`, `morph.ts`
  (+ co-gen geometry + morph test), `destroy.ts`
- decorate: `designs.ts`, `chatPanel.ts`, `icing.ts`, `sprinkles.ts`
- finale: `dissolve.ts`, `particles.ts`, `csg.ts`
- ui: `chrome.ts`, `calibrationUI.ts`
Gate: `tsc --noEmit` clean; morph test green; each module self-renders in isolation.

**P3 — Integration** *(serial)*
`main.ts` wires capture → tracking → gesture → router → execution → scene. Director guided flow (§14).
Resolve cross-module integration bugs. Gate: app boots, webcam → sphere < 3 s, all 8 menus selectable.

**P4 — Polish + Verify**
Matcap rim + GTAO + bloom + vignette tuning; beat transitions; **Chrome DevTools MCP perf trace →
60 fps / < 80 ms**; full vitest green; §21 Definition-of-Done walk-through; static deploy.

---

## 9. Agent-fleet orchestration

- **`Workflow` (significant + dynamic) per phase.** P1 and P2 fan out one agent per module; the
  shared-contracts-first design (§6) means no inter-agent coordination is required within a phase.
  Worktree isolation only where agents would write the same files (they won't, by module ownership).
- **MCPs, used aggressively (per user mandate):**
  - **Context7** — every time an agent touches a three.js / MediaPipe / three-mesh-bvh / three-bvh-csg
    API, it pulls version-correct docs first (no guessing).
  - **Chrome DevTools MCP** — P3/P4 perf traces, console-error sweeps, CSS3D DOM inspection; the
    60 fps / < 80 ms numbers come from a real trace, not a claim.
  - **GitHub / git** — commit at every milestone (end of P0, each P1/P2 module batch, P3, P4); keep the
    build deployable at all times.
- **Verification before completion** — no module is "done" until its gate passes; no phase advances until
  its gate passes; nothing is claimed working without command output / a trace as evidence.

---

## 10. Verification & Definition of Done (maps to SPEC §21)

- [ ] `tsc --noEmit` and `vite build` clean
- [ ] vitest: predicates, oneEuro, calibration, brushes, morph — all green
- [ ] webcam grant → sphere < 3 s; calibration ritual runs and is skippable
- [ ] both hands tracked + green skeleton; < 80 ms perceived latency (Chrome DevTools trace)
- [ ] radial ring opens on gun pose; all 8 menus selectable; active menu in HUD
- [ ] TRANSLATE / DILATE / ROTATE behave per §6.2–6.4
- [ ] MORPH: squish drives `t` toward the donut; brushes apply on top; donut emerges cleanly
- [ ] DECORATE: chat panel + typewriter + hardcoded scripts; sprinkles/icing appear; direct-hand tools work
- [ ] DESTROY: dissolve + particles + crunch SFX
- [ ] freeplay is a real sculptor; director safety mode advances via keypress
- [ ] 60 fps on demo machine in Chrome (trace)
- [ ] known-good build deployed to a live static URL

---

## 11. Risks & fallbacks (from SPEC §18)

Carried verbatim from SPEC §18 — MediaPipe FPS, menu flicker, CSG artifacts, ambiguous squish, CSS3D lag,
device mismatch, sculpt jitter, on-stage tracking loss, unprojection depth. Each has a fallback already
specified there; the director `safety` mode (§14.2) is the global stage-failure backstop. The de-risked
minimum-viable path (SPEC §18) is the cut order if time runs short: keep TRANSLATE/DILATE/ROTATE +
MORPH + AI chat + dissolve; drop ADD SHAPES and INTERACT.
