# Daedalus — Persistent TODO

Living checklist across sessions. Update as work lands. SPEC.md is the source of truth (v5).
Decision log at bottom. Check items off; never delete history — strike or move to "Done".

---

## 🔴 Deferred / blocked

- [x] **ElevenLabs Conversational AI** (real LLM reply + TTS) for DECORATE — §8. **LANDED 2026-06-13.**
  - `decorate/voice.ts` now ships a real `ElevenLabsAdapter implements VoiceAdapter`: opens (and
    reuses) one Agents-Platform WebSocket, sends the transcript as a `user_message`, streams the
    agent's reply text token-by-token to the chat typewriter (`agent_chat_response_part` / final
    `agent_response`), and plays the returned PCM-16k audio in real time via Web Audio. Answers
    `ping` with `pong`; flushes audio on `interruption`.
  - **Config (`.env.local`):** `VITE_ELEVENLABS_AGENT_ID` is required. A PUBLIC agent connects
    directly (no key). For a PRIVATE agent, also set `VITE_ELEVENLABS_API_KEY` — the adapter fetches
    a signed URL (`get-signed-url`, header `xi-api-key`) before connecting. NOTE: a key in a Vite
    build ships to the browser — fine for a local demo; mint the signed URL server-side for prod.
  - `makeVoiceAdapter()` returns the live adapter when an agent id is set + `WebSocket` exists,
    else `ScriptedAdapter`. The live adapter ALSO falls back to scripted at runtime if a connection
    ever fails — so the demo never stalls. Hardcoded JAM icing + rainbow sprinkles fire instantly
    regardless (§8.1 step 3), unchanged.
  - Verify (manual, needs mic + the configured agent): DECORATE → speak → real reply streams to
    the typewriter + voice plays. Headless/unit tests use the scripted path (network-free).

---

## 🟡 Assets to source (public/ is currently empty)

- [ ] `public/models/hand_landmarker.task` — vendor locally or load from MediaPipe CDN.
- [ ] `public/matcaps/blue-steel.png` — nidorx/matcaps (blue-steel), CC.
- [ ] `public/sfx/ping.wav` `hum.wav` `ding.wav` — source or synth procedurally via WebAudio.
- [ ] `public/fonts/JetBrainsMono.woff2` — currently via Google Fonts CDN (acceptable); vendor if offline demo needed.

---

## 🟢 Build — SPEC v5 → Definition of Done (§19)

### Phase 0 — Foundation / contracts
- [ ] `types.ts` rewrite: 6 menus, HandPose, FrameInput, InputSource, SceneContext (no css3d), MenuModule
- [ ] `render/tokens.ts` (JARVIS palette T{}), `render/layers.ts` (renderOrder/depthTest constants)
- [ ] `math/coords.ts` (fingertip→world unproject)

### Phase 1 — Tracking + input + gesture
- [ ] `tracking/oneEuro.ts`, `inputSource.ts`, `liveInput.ts`, `mockInput.ts` (?mock=1)
- [ ] `gesture/predicates.ts`, `detect.ts` (5-frame debounce), `stateMachine.ts` (carousel + exec FSM + undo ring)
- [ ] `core/store.ts`, `core/loop.ts`, `core/director.ts` (freeplay/safety + 4 snapshots)

### Phase 2 — Render + sculpt core
- [ ] `render/scene.ts` (matcap), `post.ts` (GTAO+bloom+vignette), `overlay.ts`, `viewMode.ts` (AR/Scene + parting curtains)
- [ ] `render/geometry.ts` (icosphere ~40k + procedural torus morph target, identical vertex order)
- [ ] `sculpt/engine.ts` (BVH dirty-region), `sculpt/brushes.ts` (Taubin λ=0.5 μ=−0.53)
- [ ] `audio/sfx.ts` (ping/hum/ding)

### Phase 3 — Menus
- [ ] `menu/carousel.ts` (horizontal top-center, flick/pinch/fist), `menu/panel.ts` (plain DOM, fixed right)
- [ ] `menu/menuRouter.ts`, `addShapes.ts`, `translate.ts`, `dilate.ts`, `rotate.ts`, `morph.ts`

### Phase 4 — Decorate
- [ ] `decorate/designs.ts`, `icing.ts`, `sprinkles.ts`, `voice.ts` (scripted), `chatPanel.ts` (plain DOM)

### Phase 5 — UI chrome + bootstrap
- [ ] `ui/chrome.ts`, `ui/devOverlay.ts`, `ui/instructionsPopout.ts` (❓ modal)
- [ ] `main.ts` rewrite (wire pipeline; world starts empty)

### Phase 6 — Tests + verify
- [ ] tests: predicates, stateMachine, oneEuro, brushes, taubin, carousel, translate, rotate, morph, sprinkles, voice
- [ ] `pnpm typecheck` clean, `pnpm test` green, dev server smoke (empty scene <3s), mock mode drives all tools

### Phase 7 — Full E2E verification (Chrome DevTools MCP, mock-driven, iterative)
Runs AFTER Phase 6 is green. Drive the real app in a real browser; screenshot every beat; chase regressions
until it runs ultra-smooth. Fix → reload → re-test loop. Goal = SPEC §19 DoD, observed not asserted.

**Setup**
- [ ] `pnpm dev` (background) → capture URL.
- [ ] Chrome MCP: open `…/?mock=1&fps=1`; baseline screenshot; `list_console_messages` == 0 errors; empty scene visible <3s.

**Per-beat (mock §10.2 + `window.DAEDALUS` debug API) — screenshot + console-check each**
- [ ] Carousel: gun opens at top-center; flick wraps 6↔1; pinch selects; fist dismisses.
- [ ] Layer rule: `evaluate_script` asserts every menu object `renderOrder===1 && material.depthTest===false`; menu visibly over mesh.
- [ ] ADD SHAPES: cycle cube/sphere/tetra; pinch-spawn → `ctx.mesh` non-null, becomes active target.
- [ ] TRANSLATE: open-palm moves object; fist locks.
- [ ] DILATE: two-hand spread/together scales; bbox renders (Layer 1).
- [ ] ROTATE: pinch-twist rotates; arcball renders; assert quaternion normalized, no gimbal.
- [ ] MORPH: `setMorphT` sweep 0→.25→.5→.75→1 screenshots; smooth + reversible; ding + `// DONUT` at t>0.95.
- [ ] DECORATE: inject transcript → JAM icing + rainbow sprinkles fire immediately on real mesh; chat typewriter streams scripted reply; direct-hand smear/pinch work independently.
- [ ] Parting curtains: toggles AR↔Scene with cyan scan line; webcam bg in AR.

**Smoothness / perf**
- [ ] `performance_start_trace`/`stop_trace` across a sculpt+morph session → ~60fps, no long tasks/jank.
- [ ] (opt) `take_heapsnapshot` before/after a stroke session → no runaway growth (zero-alloc hot loop sanity).
- [ ] No uncaught errors in console across the whole run.

**Regression loop**
- [ ] Beat-to-beat screenshot diffing; any visual break or console error → fix file → reload → re-run that beat. Loop until clean.
- [ ] (opt) fan out screenshot+log judge agents to score each beat against §19 DoD; collate misses into a fix round.

---

## 🧪 Extensive testing strategy (layered — depth over checkbox theater)

Goal: every SPEC non-negotiable and every Risk Register (§16) row has a test that *fails loudly* when broken.
Layers run cheap→expensive (L0 fastest, gates every commit; L7+ heavier, gates merges/nightly).
Windows note: real WebGL only in real Chrome (headless-gl is unreliable on Win) — keep GL-dependent checks in E2E/visual layers, keep math/DOM headless.

### Tooling to add (devDeps)
- [ ] `@vitest/coverage-v8` — coverage + thresholds.
- [ ] `fast-check` — property-based / fuzz.
- [ ] `@playwright/test` — scripted, deterministic E2E + built-in screenshot diffing (complements Chrome MCP exploratory runs).
- [ ] `@stryker-mutator/core` + vitest runner — mutation testing (measures suite *strength*, not just coverage).
- [ ] `jsdom` vitest env for DOM-panel suites; keep math suites in node env (per-file `// @vitest-environment`).
- [ ] (opt) `knip` — dead-export/dependency detection; `eslint` + `@typescript-eslint` — static analysis.

### L0 — Static & contract
- [ ] `tsc --noEmit` strict passes (already gated). Add `eslint` (no-floating-promises, no-unused, no-explicit-any in hot paths).
- [ ] Contract tests: every registered `MenuModule` exposes `enter/update/exit`; calling `update` with `ctx.mesh=null` never throws (world-empty guard, all 6 tools).
- [ ] `InputSource` contract: both `LiveInputSource` & `MockInputSource` satisfy `init/pump/ready/dispose` and `pump` returns a well-formed `PoseFrame` (21 landmarks, both hands slots present).
- [ ] `knip` shows no orphaned exports after the greenfield rebuild.

### L1 — Unit (pure math) — beyond the Phase 6 baseline
- [ ] predicates: table-driven fixtures for every gesture (gun/fist/open/pinch/point/flick) incl. near-threshold boundary cases (pinch at 0.29/0.31·S).
- [ ] oneEuro: step-response (settling within N frames), rest-jitter attenuation ratio, fast-ramp lag bound; `beta`/`min_cutoff` monotonicity (raising beta reduces lag).
- [ ] brushes: falloff boundary (d=0→1, d=r→0, d>r→0), each verb's displacement direction; smooth reduces neighbor variance.
- [ ] taubin: volume drift <5% / 10 iters AND shape doesn't collapse (bbox stays within 2%); Laplacian-shrink guard — assert Taubin preserves volume *more* than a pure-Laplacian reference.
- [ ] morph driver: angle accumulation across the ±2π wrap (no jump), sign on reverse orbit, exact t=1 at full turn, clamp at >1 turn.
- [ ] coords: `fingertipToWorld` round-trip (project a known world point to NDC, back, within ε); mirror flip correctness.
- [ ] stateMachine: exhaustive transition table (every state×event); flick wrap both directions; UndoRing capacity/eviction.
- [ ] quaternion (rotate): result always normalized; `deltaQ·Q_start == Q_current`; two composed twists == quaternion product (no Euler drift).

### L2 — Property-based / fuzz (`fast-check`)
- [ ] ∀ random 21-landmark hand: `handScale>0`, `pinchAmount∈[0,1]`, `spreadAmount∈[0,1]`, `classify` never throws & returns a valid `GestureName`.
- [ ] ∀ random morph orbit sequence: `morphT∈[0,1]` always; monotonic with net signed angle.
- [ ] ∀ random brush stroke sequence: vertex count & index order invariant (sculpt never re-topologizes); no `NaN` in positions.
- [ ] ∀ random dropBatch sequence: instanced sprinkle count ≤ 1500 (hard cap), all instances on masked verts.
- [ ] ∀ random carousel flick stream: index always in `[0,5]`; selected id always a real `MenuId`.

### L3 — Trace-replay (recorded landmark streams) — the hand-tracking-specific layer
- [ ] Capture/author golden landmark traces as JSON fixtures (`tests/fixtures/traces/*.json`): clean pinch, gun-open-carousel, two-hand dilate, full morph orbit, decorate smear. (Record real frames via a `?record=1` hook, or hand-synthesize.)
- [ ] Replay each trace through `oneEuro → classify → debounce → CarouselFSM/tool` headless and assert the expected discrete-gesture timeline (e.g., gun commits at frame ≥5, pinch fires once not N times).
- [ ] Regression-lock the *filtered* output of a trace (hash) so One Euro tuning changes are caught.

### L4 — Integration (headless pipeline, no WebGL)
- [ ] Full input→action chain: synthetic frame stream drives `MockInputSource → PoseStore → detect → MenuRouter → tool.update`, asserting `ctx` mutations (mesh spawned, position moved, scale changed, morphT raised) — three.js math runs fine without a renderer (pass `renderer` as a stub).
- [ ] Director progression: EMPTY→SPHERE (on add) →DONUT (morphT>0.95) →DECORATED (on decorate) is monotonic & matches observable milestones.
- [ ] "Never two panels" invariant: opening carousel while a panel is open closes it first (assert single panel element in DOM via jsdom).

### L5 — Determinism & golden snapshots
- [ ] Seed all RNG (sprinkle Poisson, sprinkle palette pick) — same seed ⇒ identical placement; assert reproducibility.
- [ ] Geometry golden: `makeIcosphere` vertex count & `buildDonutMorph` target share identical count + index order (the morph contract) — snapshot the counts + a position hash.
- [ ] Scripted-voice golden: a transcript maps to a fixed reply (snapshot) — protects the demo script.

### L6 — Robustness / failure injection / chaos
- [ ] No-hands → hold last pose ~150ms then fade, never snap/throw (§3.6).
- [ ] One hand lost mid-gesture → active hand keeps working, missing role suspended.
- [ ] Low confidence → brush engagement frozen.
- [ ] Degenerate input: `NaN`/`Infinity` landmarks, zero-distance pinch (no div-by-zero), startDist=0 in dilate, tiny `handScale`, identical wristL==wristR in morph.
- [ ] Camera unavailable / `getUserMedia` reject → app still renders, banner shows, keyboard + `window.DAEDALUS` still drive everything.
- [ ] Model load failure → graceful message, mock/debug path unaffected.
- [ ] Rapid tool thrash (switch 1–6 every frame) → no leaked panels/listeners, no error spam.
- [ ] Reentrancy: spawning a new shape mid-stroke disposes old BVH/geometry cleanly.

### L7 — Performance & frame budget (Chrome DevTools MCP / Playwright trace)
- [ ] Sustained ~60fps during sculpt+morph; p95 frame time < 16.7ms; flag long tasks.
- [ ] Inference never blocks render (latest-value store) — render keeps ticking when `pump` is stalled (inject a slow mock).
- [ ] Zero per-frame allocation sanity: instrument the hot loop in a dev build (count allocations over 600 frames ≈ 0 growth in steady state).
- [ ] Draw-call / triangle budget snapshot; bloom/GTAO on/off perf delta documented.
- [ ] Auto quality fallback (§11.2) actually triggers under forced low FPS (numHands→1, smoothing↑, HUD note).

### L8 — Memory & leak detection (Chrome DevTools memory skill)
- [ ] Heap snapshot before/after 200 strokes + 50 shape spawns + 1000 sprinkles → no retained detached geometries/materials/InstancedMeshes; listeners removed on menu `exit`.
- [ ] Long-session heap trend flat (no monotonic growth) over a 5-min mock soak.

### L9 — Visual regression (pixel diff)
- [ ] Baseline screenshot set checked into `tests/visual/baseline/` for: empty scene, carousel open, each tool panel, sphere, donut at t=.5 and t=1, decorated donut, AR mode.
- [ ] Per-beat diff (Playwright `toHaveScreenshot` or `pixelmatch`) with small tolerance; fail on layout/glow/order regressions.
- [ ] Explicit Layer-order visual proof: a frame where a menu element overlaps the mesh — assert the menu pixels win (renderOrder=1/depthTest=false honored on-screen, not just in code).

### L10 — E2E scenarios → see Phase 7 (Chrome MCP exploratory) + a scripted Playwright mirror for CI determinism.
- [ ] Playwright spec replicating the Phase 7 beat list headlessly-in-Chromium for repeatable gating.

### L11 — Accessibility (DOM panels) — chrome-devtools a11y skill
- [ ] Chat panel, tool panels, ❓ modal: contrast ratio AA on cyan-on-dark text, focus-visible on ❓ button & voice input, tap-target ≥ 44px, semantic roles.

### L12 — Soak / endurance
- [ ] 5–10 min continuous mock loop cycling all tools → FPS stays ≥ target, console stays clean, heap flat, no state corruption (carousel index, director stage, undo ring bounded).

### L13 — Coverage + mutation
- [ ] Coverage gates: ≥90% lines on `gesture/`, `sculpt/brushes`, `tracking/oneEuro`, `gesture/stateMachine`, math; ≥75% overall.
- [ ] Stryker mutation run on the pure-math modules — mutation score ≥80% (proves tests actually catch logic flips, not just execute lines).

### L14 — CI wiring (GitHub Actions)
- [ ] PR pipeline: `typecheck → eslint → vitest (unit+integration+property) → coverage gate`.
- [ ] Nightly/merge pipeline: Playwright E2E + visual-diff + mutation + soak; upload screenshot diffs & traces as artifacts.
- [ ] Keep a deployable build green at all times (§15 GitHub MCP milestone commits).

---

## ✨ Phase 8 — 100-aspect presentation polish (file-colored waves)
Runs AFTER build + E2E (Phase 7) are green. Hackathon focus: only what a judge sees/feels. Manifest of all 100
focused aspects + owner-file map → [presentation-polish-100.md](docs/superpowers/plans/presentation-polish-100.md).

- [ ] Finalize owner-file map against the real built files (some aspects may relocate).
- [ ] Build the wave scheduler: color 100 aspects by owner file; each wave = ≤1 aspect/file (disjoint writers).
- [ ] Run waves (~10), each ≤12–15 concurrent agents; **gate `tsc`+`vitest`+screenshot green between waves**; commit per wave.
- [ ] Each agent: full focus on ONE aspect of ONE file; JARVIS north star (§1.2) + motion language (§14.4); non-negotiables held.
- [ ] Scope discipline: wow/smooth/legible only — NOT robustness/a11y/CI (those are the testing layers above).
- [ ] **HIGH PRIORITY (found in Phase 7 E2E): decoration barely visible.** Jam icing (#8B0000) ×
      `MeshMatcapMaterial` multiply → near-black on dark steel; 240 sprinkles at radius 0.02 are too small to
      read at demo distance. The data is correct (13.3k iced verts, 240 rainbow instances) — it just doesn't
      pop. Fix in items 59–62: brighten/saturate icing (emissive or screen-overlay, not pure multiply), bump
      sprinkle size + `toneMapped:false`/emissive so the rainbow reads. This is THE decorate-beat money shot.
- [ ] (also found in E2E) carousel shows only the centered tool prominently — surface the 40% adjacent tiles
      more (item 22/32) so the strip reads as a strip. And spawn shapes at the hand position, not origin.
- [ ] Final pass: full demo run-through screenshot reel (empty→add→sculpt→morph→donut→decorate→AR) as the "pitch proof".

---

## 🗑 Delete (does not serve SPEC v5)
- [ ] `menu/radialRing.ts`, `menu/spatialPanel.ts`, `menu/interact.ts`, `menu/destroy.ts`
- [ ] `finale/` (csg.ts, dissolve.ts, particles.ts) + `three-bvh-csg` dependency
- [ ] `tracking/calibration.ts`, `ui/calibrationUI.ts`, `tests/calibration.test.ts`
- [ ] CSS3DRenderer everywhere (SceneContext.css3d, main.ts) — spec forbids CSS3D
- [ ] MenuId.INTERACT, MenuId.DESTROY

---

## ✅ Done
- **2026-06-13** Phase 0 contracts hand-authored (types/tokens/layers) + greenfield deletes.
- **2026-06-13** Phases 1–6 built via workflow `wf_dbb9e429-8b7` (112 agents, ~47 files). Deleted 2 leftover
  orphans (`tracking/handLandmarker.ts`, `ui/gestureGuide.ts`) the rebuild superseded.
- **2026-06-13** Build GREEN: `tsc --noEmit` clean; **142/142 vitest** across 11 files.
  - Note: `tests/voice.test.ts` runs ~17s (real typewriter timing) — switch to fake timers in the L1 hardening pass.
- **2026-06-13** Phase 7 E2E (Chrome DevTools MCP, mock-driven, `.e2e/*.png` reel). Verified end-to-end:
  empty scene → carousel open/flick/select → tool panels → ADD SHAPES spawn (cube+sphere) → morph sphere→DONUT
  → DECORATE (voice→13.3k iced verts + 240 sprinkles + scripted typewriter reply) → AR toggle. 60–99 FPS,
  zero runtime console errors, layer-order §4.3 holds (0 violations). **6 bugs found + fixed:**
  1. `mockInput` nav gestures wired to the Right hand — carousel undrivable via mock (Left=nav). *(mock)*
  2. `mockInput` CURL_TEMPLATE left curled tips radially outside their PIPs → `isGun`/`isFist` never fired. *(mock)*
  3. `mockInput` flick was a square pulse → snap-back produced a reverse flick → net-zero carousel nav. *(mock)*
  4. **`scene.attachMesh` never built the donut morph target** → MORPH (signature beat) was fully dead. *(PRODUCT)*
  5. `mockInput` flick rode only the nav hand → ADD SHAPES shape-cycle (exec flick) undrivable. *(mock)*
  6. **`addShapes` gated flick on `g.name==='flick'`** but an open hand classifies as "open", masking it →
     shape-cycle broken for live hands too; fixed to read the `vx` channel like the carousel. *(PRODUCT)*
  Touched only `src/tracking/mockInput.ts`, `src/render/scene.ts`, `src/menu/addShapes.ts`. Typecheck stayed green.

---

## Decision log
- **2026-06-13** Rebuild strategy = **greenfield to SPEC §18 manifest**, port reusable internals
  (One Euro, sculpt engine + BVH, gesture math, matcap scene, loop/store/director).
- **2026-06-13** Voice AI = **scripted only now**; ElevenLabs deferred (see top).
