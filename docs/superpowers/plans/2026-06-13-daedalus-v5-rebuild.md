# Daedalus v5 Rebuild — Implementation Plan

> **For agentic workers:** This plan is executed by a parallel **Workflow** (per user directive: dynamic
> workflows + ~45 agents), not sequential subagent-driven-development. Task granularity = **one file = one
> agent card**. All agents code against the hand-authored shared contracts in `src/types.ts`,
> `src/render/tokens.ts`, `src/render/layers.ts` (authored in Phase 0 before fan-out).

**Goal:** Rebuild Daedalus to SPEC.md v5 — a browser real-time 3D sculptor driven by webcam hand tracking,
with a horizontal tool carousel, 6 tools, plain-DOM panels, and scripted DECORATE voice.

**Architecture:** Greenfield to SPEC §18 file manifest. Keep the proven `SceneContext` + `MenuModule`
single-shared-state pattern (minus CSS3D). Port reusable internals (One Euro, sculpt engine + BVH, gesture
math, matcap scene, loop/store/director). Replace radial ring → horizontal carousel; CSS3D/spatialPanel →
plain DOM panels; 8 menus → 6; drop calibration / finale / INTERACT / DESTROY.

**Tech Stack:** Three.js r160 (WebGL2), @mediapipe/tasks-vision 0.10.12, three-mesh-bvh 0.7.0, Vite 5,
TypeScript 5.4, Vitest 1.6. Web Speech API + browser SpeechSynthesis (ElevenLabs deferred → TODO.md).

---

## Non-negotiables (HARD CONTRACT for every agent)
1. All menu/HUD geometry: `renderOrder=1, depthTest=false, depthWrite=false` — use `asMenuLayer()`. No exceptions.
2. Smoothing: **Taubin only** (`λ=0.5, μ=−0.53`). Never plain Laplacian.
3. **Dirty-region** BVH refit + normal recompute only. Never full rebuild per stroke.
4. **Zero per-frame allocation** in hot loop — reuse `ctx.scratch` Vector3/Matrix4/Quaternion.
5. **Plain DOM** for all panels (no CSS3DRenderer).
6. Chat panel fixed **right** side.
7. **World starts empty** — `ctx.mesh` is `null` until ADD SHAPES spawns. Every other module no-ops when `ctx.mesh === null`.
8. 4-space indent. Constants `ALL_CAPS`, vars `snake_case`, functions `camelCase`.
9. Upload only changed attribute ranges (`geometry.attributes.position.addUpdateRange`).

## Shared contracts (authoritative — read these files, do not redefine)
- `src/types.ts` — `HandPose`, `PoseFrame`, `InputSource`, `GestureState`, `MenuId` (6), `MenuModule`,
  `SceneContext`, `ScratchMath`, `VoiceAdapter`, `Stage`, `ViewMode`, design interfaces.
- `src/render/tokens.ts` — JARVIS palette `T` (SPEC §14.1).
- `src/render/layers.ts` — `LAYER`, `asMenuLayer(obj)`.

---

## Build DAG (6 phases; barrier between phases, parallel within)

Later phases import earlier files → phase barriers are correct. Within a phase, all file-agents run in parallel
and write **disjoint** files (no conflict, no worktree needed). `main.ts` is authored last (single agent).

```
P0 contracts (hand-authored): types, tokens, layers, coords-adapt, deletes, package.json
P1 tracking+gesture → P2 render+sculpt → P3 menus → P4 decorate → P5 chrome+bootstrap → P6 tests+assets+verify
```

---

## File cards

Signatures below are the contract. Each agent: read SPEC.md (relevant §), the existing file (if porting),
`src/types.ts`; then write the file; return `{path, status, exports, notes}`.

### Phase 1 — tracking + gesture
- `tracking/oneEuro.ts` — PORT. `class OneEuroFilter { constructor(minCutoff=1.0, beta=0.007); filter(x:number, tMs:number):number; reset() }`; `class HandFilterBank { filter(lm:Vec3[], world:Vec3[], tMs:number):{landmarks:Vec3[];world:Vec3[]} }` (126 scalar filters). §3.3.
- `tracking/inputSource.ts` — NEW. Re-exports `InputSource`,`PoseFrame` from types; `function pickSource(): "live"|"mock"` (reads `?mock=1`).
- `tracking/liveInput.ts` — ADAPT from `handLandmarker.ts`. `class LiveInputSource implements InputSource` — MediaPipe HandLandmarker GPU/VIDEO/numHands:2 + HandFilterBank; `pump(dt)` returns latest `PoseFrame` (source:"live"); never awaits inline. §3.1,§3.5,§11.
- `tracking/mockInput.ts` — NEW. `class MockInputSource implements InputSource` — mouse/keyboard per SPEC §10.2 mapping (mouse→R index tip, click→R pinch, scroll→R z, WASD→L pos, G gun, F flick, P pinch, X fist, 1–6 tool, [/] radius). Emits synthetic 21-landmark hands.
- `gesture/predicates.ts` — ADAPT. `handScale(world)`, `pinchAmount(lm,s)`, `isPinching`, `isGun`, `isFist`, `isOpenPalm`, `fingerExtended(lm,tip,pip)`, `spreadAmount(lm,s)`. Thresholds = SPEC §12.
- `gesture/detect.ts` — NEW. `classify(lm:Vec3[], world:Vec3[]):GestureState` (name/extended/pinch/spread/vx); `class GestureDebouncer { push(name):GestureName }` (5-frame commit, §12).
- `gesture/stateMachine.ts` — NEW. `class CarouselFSM` (closed→open→navigating→selected; gun opens, flick navigates+wraps, pinch selects, fist dismisses) + exec-side latch + small undo ring. Pure, unit-testable.
- `core/store.ts` — PORT. `class PoseStore { set(f:PoseFrame); get():PoseFrame|null }` last-write-wins.
- `core/loop.ts` — PORT. `function startLoop(cb:(dtMs:number)=>void)` rAF, decoupled.
- `core/director.ts` — ADAPT. `class Director { constructor(mode:DirectorMode); stage:Stage; onShapeAdded(); onMorph(t); onDecorated(); advanceSafety() }`. Stages EMPTY→SPHERE→DONUT→DECORATED. Drop guided/assist.

### Phase 2 — render + sculpt
- `render/scene.ts` — ADAPT. `function makeContext():SceneContext` (renderer powerPreference high-performance, PerspectiveCamera fixed framing, scene bg `T.bg`, scratch alloc, `mesh:null`); `function makeMatcapMaterial():MeshMatcapMaterial` (vertexColors:true, blue-steel matcap from `public/matcaps/blue-steel.png`); `function attachMesh(ctx, geo)` builds mesh+BVH, sets `ctx.mesh/ctx.bvh`. §9.2,§9.6.
- `render/geometry.ts` — ADAPT. `function makeIcosphere(detail=64):BufferGeometry` (~40k tris, indexed, attrs position/normal/color); `function buildDonutMorph(geo, R=1.0, r=0.42)` warps the icosphere's OWN vertices into a torus and stores as `morphAttributes.position[0]` (identical count/order, §7.1). `function makeShape(kind:"cube"|"sphere"|"tetra")`.
- `render/post.ts` — ADAPT. `function makeComposer(renderer,scene,camera):{composer,resize(),setBloom(on)}` — RenderPass→GTAOPass→UnrealBloomPass(high threshold)→OutputPass+vignette. §9.4.
- `render/overlay.ts` — ADAPT. `function drawOverlay(ctx2d, video, left, right)` desaturated feed + green skeleton (drawConnectors). §9.5.
- `render/viewMode.ts` — NEW. `class ViewModeController { mode:ViewMode; toggle(); detectPartingCurtains(left,right,dt):boolean (both open, vx split, <600ms, 1500ms cooldown); scanLine() }` + AR webcam bg plane. §0.7.
- `sculpt/engine.ts` — PORT. `class SculptEngine { constructor(mesh); applyBrush(verb:BrushVerb, point:Vector3, radius:number, strength:number); refit() }` BVH radius query, dirty set, dirty-region normal recompute, `addUpdateRange`. §6.
- `sculpt/brushes.ts` — PORT. Brush kernels (`grab/inflate/draw/flatten/smooth`), falloff `w=(1−(d/r)²)²`, `taubinSmooth(positions, neighbors, λ=0.5, μ=−0.53, iters)`. §6.2,§6.3.
- `audio/sfx.ts` — PORT. `const sfx = { ping(), hum(), ding() }` WebAudio; synth if wav missing. §1.2.

### Phase 3 — menus
- `menu/panel.ts` — NEW. `class Panel { constructor(title:string); readonly el:HTMLElement; show(); hide(); setInstructions(html:string) }` — plain DOM fixed right (`rgba(0,8,20,0.85)`, 0.5px cyan border, slide+fade 150ms in / 80ms out). §4.2.
- `menu/carousel.ts` — NEW. `class Carousel { readonly object:THREE.Group; isOpen:boolean; open(at:Vector3); close(); update(navTip:Vector3, g:GestureState, dt); onSelect:(id:MenuId)=>void }` — horizontal strip top-center, 6 tools, active centered cyan / adjacent 40%, flick navigates (wraps), pinch selects, fist dismisses, snap 100ms. `asMenuLayer(object)`. §4.1.
- `menu/menuRouter.ts` — ADAPT. `class MenuRouter { register(m:MenuModule); select(ctx, id:MenuId|null); update(ctx, exec, nav, dt); activeId:MenuId|null }`. Opening carousel closes active panel first (never two panels).
- `menu/addShapes.ts` — ADAPT. `createAddShapesMenu():MenuModule` — mini carousel Cube·Sphere·Tetra; R-pinch spawns at hand world pos via `attachMesh`, becomes active target, director.onShapeAdded(). §5.1.
- `menu/translate.ts` — ADAPT. open palm tracks pos, fist locks. Guard `ctx.mesh`. §5.2.
- `menu/dilate.ts` — ADAPT. two-hand `scale=curDist/startDist`; bbox on Layer 1. §5.3.
- `menu/rotate.ts` — ADAPT. R-pinch capture Q_start; `deltaQ=Q_cur·Q_start⁻¹`; arcball rings Layer 1; quaternion only. §5.4.
- `menu/morph.ts` — ADAPT. cumulative orbital angle of (wristL→wristR) on XZ → `t=clamp(angle/2π,0,1)`; `morphTargetInfluences[0]=smoothstep(t)`; reversible; ding at t>0.95 for 500ms; additive brush on top. §5.5.

### Phase 4 — decorate
- `decorate/designs.ts` — ADAPT. `ICING.jam`, `SPRINKLES.rainbow` constants (SPEC §8.2).
- `decorate/icing.ts` — PORT. `applyIcing(mesh, bvh, point, radius, design)` — BVH query → write vertex color, height mask `v.y>yLine`, edge smoothing. §8.3.
- `decorate/sprinkles.ts` — ADAPT. `class Sprinkles { dropBatch(n=60, atRegion) }` — MeshSurfaceSampler weighted by icing mask, Poisson relax, one InstancedMesh, cap 1500, scale-in. §8.4.
- `decorate/voice.ts` — NEW. `interface VoiceAdapter` impl `class ScriptedAdapter implements VoiceAdapter { respond(transcript,onToken), speak(text) }` (deterministic reply + `speechSynthesis`); Web Speech API STT wrapper `class SpeechInput { onTranscript:(t)=>void; start() }`. ElevenLabs hook noted in TODO.md. §8.1.
- `decorate/chatPanel.ts` — REWRITE plain DOM (no CSS3D). `createDecorateMenu():MenuModule` + `class ChatPanel { addUser(t); beginAI(); typewrite(t, cps=40); }` fixed right, JetBrains Mono, ✦ DAEDALUS AI spinner. Fires hardcoded icing+sprinkles immediately on transcript; streams scripted reply. §8.6.

### Phase 5 — chrome + bootstrap
- `ui/chrome.ts` — ADAPT. `class Chrome { begin(); end(); update({stage,activeMenu,viewMode}) }` — DAEDALUS//PHASE top-left, active tool + instruction bottom-left, FPS top-right. §14.3.
- `ui/devOverlay.ts` — NEW. mock-mode only: synthetic skeleton, gesture/tool/morph-t/FPS. §10.2.
- `ui/instructionsPopout.ts` — NEW (seed from `gestureGuide.ts`). ❓ fixed bottom-right + modal w/ all 6 tools + parting curtains + voice. §4.4.
- `main.ts` — REWRITE. Wire: pickSource→Input→PoseStore→loop; nav hand drives carousel+router.select; exec drives active menu; viewMode toggle; composer.render() (no css3d); overlay; chrome; `?tool=` `?fps=` `?singlehand=` params; window.DAEDALUS debug API; world empty at start.

### Phase 6 — tests + assets + verify
- Tests (vitest, no browser): `tests/predicates.test.ts`, `stateMachine.test.ts`, `oneEuro.test.ts`, `brushes.test.ts`, `taubin.test.ts` (volume <5% drift / 10 iters), `carousel.test.ts` (wrap + select), `translate.test.ts`, `rotate.test.ts` (no gimbal), `morph.test.ts` (t reversible), `sprinkles.test.ts`, `voice.test.ts` (scripted determinism).
- Assets: fetch `public/models/hand_landmarker.task` (MediaPipe CDN) + `public/matcaps/blue-steel.png`; synth sfx fallback.
- Verify: `pnpm typecheck` clean → `pnpm test` green → dev smoke (empty scene <3s, `?mock=1` drives all tools).

---

## Workflow execution model
- One phased `Workflow`. Phase = `parallel()` barrier of file-agents (P5 main.ts depends on P5 siblings → main.ts runs after).
- Each file-agent writes its file + returns structured `{path,status,exports,notes}`.
- After P6, a verify agent runs `tsc --noEmit` + `vitest`; failures feed a **repair round** (agents fix only their flagged files). Loop until green or 3 rounds.
- `asMenuLayer`/Taubin/dirty-region/zero-alloc/plain-DOM/world-empty restated in every agent prompt.

## Acceptance = SPEC §19 Definition of Done.
