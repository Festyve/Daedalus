# Daedalus — Technical Specification (v5)

> Shape matter with your bare hands. No mouse. No tablet. No headset.
> Just a webcam, two hands, and the ghost of a god who built wings from wax.

---

## Table of Contents
0. Document Status
0.5 Governing Principle
0.7 View Mode Toggle
1. The Thesis & Aesthetic North Star
2. System Architecture
3. Hand Tracking Layer
4. Tool Carousel & Spatial Menus
5. Tool Paradigms (per tool)
6. Sculpt Engine
7. Morphology: Sphere → Donut
8. Decorate Phase & Voice Interface
9. Rendering & Shader Pipeline
10. Testing Infrastructure
11. Performance Engineering
12. Gesture Math Reference
13. Director & Flow
14. Aesthetic System & Design Tokens
15. Tooling & MCPs
16. Risk Register
17. Dependencies
18. File Manifest
19. Definition of Done

---

## 0. Document Status

| | |
|---|---|
| **Project** | Daedalus |
| **Event** | JAMHacks 10 |
| **Tracks** | Best Overall · Best Developer Tool · Most Entertaining Pitch · Best Use of ElevenLabs |
| **Team** | 4 |
| **Stack** | Three.js (WebGL2) · MediaPipe Tasks Vision · three-mesh-bvh · Vite + TypeScript · ElevenLabs · Web Speech API |
| **AI decoration** | Decoration is hardcoded (reliable); AI conversation response is real (ElevenLabs) |
| **Aesthetic** | JARVIS / Iron Man — luminous, weightless, spatially aware |
| **Priority order** | Smoothness → UX ease-of-use → visual polish → technical depth |

---

## 0.5 Governing Principle

Daedalus is a **genuinely working real-time sculptor with spatial hand-driven menus.**

**Real (computed at runtime):**
- All mesh deformation (every brush, every gesture)
- Tool carousel navigation and selection
- All spatial interaction paradigms (grab, spread, twist, circular morph)
- Icing and sprinkle placement on the actual mesh surface
- Voice recognition and ElevenLabs AI conversation

**Authored (pre-designed, applied to real geometry):**
- The donut morph target (what the circular gesture pulls toward)
- Sprinkle/icing/glaze visual designs
- Decoration triggered by voice (JAM icing + rainbow sprinkles)
- Tuning curves (smoothing, falloff, easing)
- Color tokens and material presets

**Priority above all else: it must feel smooth.** A laggy menu is worse than a missing feature. A jittery gesture is worse than a missing brush. Every interaction should feel like JARVIS responding — instant, weightless, aware.

---

## 0.7 View Mode Toggle

Two render modes, toggled by a single bilateral gesture.

**AR mode** — live webcam feed as background. The sculpted object floats in the real world. Hands visible in feed + tracked skeleton overlay.

**Scene mode** — pure `#000814` canvas. No camera feed. Object + holographic menus only. Default starting mode.

Both modes: hand tracking, sculpting, and all menus function identically.

### Gesture: Parting Curtains
Both hands open (all fingers extended), positioned near center of frame, simultaneously sweep outward along the horizontal axis. Must complete within 600ms.

```
bothOpen = isOpenPalm(L) && isOpenPalm(R)
movingApart = vx(L) < −threshold && vx(R) > +threshold
toggleFires = bothOpen && movingApart && duration < 600ms
```

Cooldown: 1500ms after trigger (prevents accidental re-toggle).

Visual feedback: a horizontal cyan scan line sweeps across the full canvas on toggle (80ms, fades out) — like a display switching input.

---

## 1. The Thesis & Aesthetic North Star

### 1.1 What it is
Daedalus is a browser-based real-time 3D sculptor controlled entirely by webcam hand tracking. The **left hand navigates the tool carousel**; the **right hand executes** the active paradigm. The UI feels like reaching into a hologram.

### 1.2 The JARVIS aesthetic (north star)
Every design decision should pass this test: *"Does this look like Tony Stark's workshop?"*

**JARVIS characteristics to embody:**
- **Holographic panels** — translucent, glowing, floating in space. Not opaque cards.
- **Instant response** — UI reacts before the user finishes their gesture. No perceived lag.
- **Ambient awareness** — subtle glow/pulse on elements the hand is near, even before selection.
- **Clean geometry** — thin lines, sharp angles, minimal surface. No gradients, no shadows except glow.
- **Sound design** — soft harmonic tones on selection, low hum on panel open, crystalline ping on confirmation.
- **Weightlessness** — menus float and drift slightly. Nothing feels anchored to a 2D plane.
- **Color language** — primary blue-cyan for neutral state, amber for active/warning, white for selection.

**What this is NOT:** brutalist, game UI, Material Design, or a dashboard.

### 1.3 Why it wins
Real hand tracking + spatial holographic menus + a voice AI that generates real decoration = nothing else at JAMHacks looks like this. Every SWE judge will feel the engineering. Every non-technical judge will feel the magic. Imagine what happens when the AI is fully unconstrained.

---

## 2. System Architecture

```
┌─────────────┐    ┌──────────────────────┐    ┌──────────────────────────┐
│   Webcam    │───▶│  MediaPipe            │───▶│  One Euro Filter         │
│ getUserMedia│    │  HandLandmarker (GPU) │    │  min_cutoff=1.0 β=0.007  │
└─────────────┘    │  VIDEO, 2 hands       │    └────────────┬─────────────┘
   ↑ also feeds    └──────────────────────┘                 │
   MockInput (dev)                                           ▼
                                               ┌─────────────────────────────┐
                                               │   Gesture / State Machine    │
                                               │   L: carousel nav            │
                                               │   R: paradigm execution      │
                                               └─────────────┬───────────────┘
                                                             │
                         ┌───────────────────────────────────▼──────────────────────┐
                         │  Tool Router                                               │
                         │  ADD SHAPES | TRANSLATE | DILATE | ROTATE | MORPH | DECORATE │
                         └───────────────────────────────────┬──────────────────────┘
                                                             │
              ┌──────────────────────────────────────────────▼────────────────────────┐
              │  Three.js Scene                                                         │
              │  Layer 0: meshes (depthTest=true, renderOrder=0)                        │
              │  Layer 1: menus/affordances (depthTest=false, renderOrder=1)             │
              │  Layer 2: DOM (chat panel, HUD, ❓ popout) CSS z-index above canvas      │
              │  → EffectComposer → canvas                                              │
              └────────────────────────────────────────────────────────────────────────┘

Testing (dev only):
  MockInput → injects synthetic landmark streams via mouse/keyboard
  Unit tests → pure landmark math, no camera
```

### Threading model
- **Main thread:** Three.js render loop (rAF), sculpt engine, UI.
- **Inference:** MediaPipe runs in VIDEO mode pumped from rAF; result treated as state — renderer never awaits it inline.
- **Decoupling:** latest-value store holds most recent filtered pose. Render reads; inference writes. No locks, last-write-wins.

---

## 3. Hand Tracking Layer

### 3.1 Library
`@mediapipe/tasks-vision` HandLandmarker. GPU delegate, VIDEO mode, numHands: 2.

### 3.2 Role assignment
- **Left hand** → tool carousel navigation
- **Right hand** → paradigm execution
- Keyed off `handedness`. Swappable in settings.

### 3.3 One Euro Filter
126 scalar filters (2 hands × 21 landmarks × 3 axes).
`min_cutoff=1.0, beta=0.007` — lower min_cutoff if jitter at rest, raise beta if lag during fast moves.

### 3.4 Input abstraction (critical for testing)
All downstream code consumes `HandPose` — never raw MediaPipe output.

```ts
interface HandPose {
    landmarks: Vec3[21];        // filtered, normalized image space
    worldLandmarks: Vec3[21];   // filtered, world space (meters)
    handedness: "Left" | "Right";
    confidence: number;
    timestamp: number;
}

interface FrameInput {
    hands: HandPose[];
    source: "live" | "mock";
}
```

`InputSource` implementations:
- `LiveInputSource` — real MediaPipe
- `MockInputSource` — mouse/keyboard dev mode (`?mock=1`)

### 3.5 Hand scale normalization
`S = ‖wrist(0) − middleMCP(9)‖` in world landmarks. All gesture thresholds expressed as fractions of S — distance and hand-size invariant.

### 3.6 Failure handling
- No hands: hold last pose ~150ms then fade brush; never snap.
- One hand lost: keep present hand active, suspend missing role.
- Low confidence: freeze brush engagement.

---

## 4. Tool Carousel & Spatial Menus

### 4.1 The carousel
**Left hand finger gun pose** (index extended, thumb up, others curled) → horizontal carousel materializes at top-center of screen.

- 6 tools in a horizontal strip. Active tool centered, full brightness cyan. Adjacent tools 40% opacity. Further tools not rendered.
- Tool name + icon centered below strip.
- **Flick left/right** (fast horizontal velocity on index tip, ~0.4·S/frame) → slides to next/prev tool. Wraps (6→1 and 1→6). Snap animation 100ms ease-out.
- **Pinch** → selects centered tool, carousel closes (80ms fade), tool panel opens on right side.
- **Fist** → dismiss, no selection.

### 4.2 Tool panels
When a tool is selected, a floating holographic panel appears **fixed to the right side of the screen** (plain DOM, not Three.js geometry).

- Background: `rgba(0,8,20,0.85)`, thin cyan border (0.5px), subtle inner glow.
- Animate in: slide + fade 150ms. Animate out: fade 80ms.
- **Opening carousel always closes active panel first** (80ms fade-out). Never two panels simultaneously.
- Compact instruction strip at bottom of each panel showing active gestures.

### 4.3 Render layer order (HARD RULE — no exceptions)
```
Layer 0 — Scene geometry
  depthTest=true, depthWrite=true, renderOrder=0

Layer 1 — All menu geometry (carousel, affordances, arcball, bbox)
  depthTest=false, depthWrite=false, renderOrder=1
  // Always renders above mesh regardless of depth

Layer 2 — DOM (chat panel, HUD, ❓ popout)
  CSS z-index above canvas
  pointer-events: none except ❓ button and voice input
```

### 4.4 Instructions popout (❓)
Fixed bottom-right DOM button, always visible. Opens gesture reference modal on click. JetBrains Mono, dark bg, cyan border. Updated to reflect all 6 tools + parting curtains toggle + voice activation.

---

## 5. Tool Paradigms

### 5.1 ADD SHAPES
**World starts empty.** This is always the first tool used.

Panel shows a mini horizontal carousel: **Cube · Sphere · Tetrahedron**.
- Flick to cycle, pinch to select shape.
- Right hand pinch → spawns shape at right-hand world position.
- Spawned shape **immediately becomes the active sculpt target**, replacing whatever was there.

### 5.2 TRANSLATE
Right hand **open palm** → object tracks hand position freely in world space.
Right hand **closes to fist** → locks position in place.
No axis arrows. Pure free movement.

### 5.3 DILATE
Both hands near object. **Spread apart** → scale up. **Bring together** → scale down.
`scale = currentDist / startDist`. Bounding box renders around object (Layer 1).

### 5.4 ROTATE
Right hand **pinch near object** → capture `Q_start`, `R_start`.
Every frame: `deltaQ = Q_current · Q_start⁻¹`; apply to `R_start`.
Pinch release → latch. Arcball rings render (Layer 1).
**Never Euler internally** — quaternion only. Display-only Euler on panel.

### 5.5 MORPH
**The play-doh gesture.** Both hands curl into grab pose around the object. User orbits their hands around the object center in a circular path (viewed from above, XZ plane). The circular motion transforms the shape.

```
angle_traveled = cumulative rotation of (wristL→wristR vector) around object center
t = clamp(angle_traveled / 2π, 0, 1)
morphTargetInfluences[0] = smoothstep(t)
```

- Smooth and proportional — t tracks angle in real time.
- **Reversible** — unwinding decreases t.
- Object stays centered throughout.
- Real brush deformation runs additively on top of morph.
- When t > 0.95 for >500ms: ding SFX + label snaps to `// DONUT`.
- Morph target is authored (clean topology guarantee) — the play-doh feel is the gesture, the authored target is invisible scaffolding.

### 5.6 DECORATE
Voice-activated decoration + real AI conversation.

See §8 for full spec.

---

## 6. Sculpt Engine

### 6.1 Geometry baseline
Icosphere, ~40k triangles, indexed BufferGeometry. Attributes: `position`, `normal`, `color` (icing), `morphTarget[0]` (authored donut). `geometry.computeBoundsTree()` once at load; refit incrementally.

### 6.2 Core rules (architectural — wrong = rebuild)
- **Always Taubin, never plain Laplacian.** Laplacian shrinks volume; Taubin preserves it. `λ=0.5, μ=−0.53`.
- **Dirty-region updates only.** Never full BVH rebuild or full normal recompute per stroke.
- **Zero per-frame allocation** in hot loop. Reuse scratch Vector3/Matrix4 objects.
- Upload only changed attribute ranges (`addUpdateRange`).

### 6.3 Brush verbs
Grab · Inflate · Draw · Flatten · Smooth (Taubin)

Falloff kernel (default smooth): `w = (1 − (d/r)²)²`

---

## 7. Morphology: Sphere → Donut

### 7.1 Authored morph target
Pre-authored `TorusGeometry` (R=1.0, r=0.42) with identical vertex count/ordering as the start icosphere, stored as `morphTarget[0]`. Generated procedurally at load or authored in Blender.

### 7.2 Play-doh gesture driver
See §5.5 for gesture detection. `morphTargetInfluences[0] = smoothstep(t)` where t is derived from cumulative orbital angle of both grabbed hands around object center.

Brush deformation (grab/inflate) runs additively on top — so the hands feel like they're physically shaping it, not just triggering an animation.

---

## 8. Decorate Phase & Voice Interface

### 8.1 Voice activation flow
1. User speaks naturally into microphone.
2. **Web Speech API** captures transcript.
3. **Decoration fires immediately** (hardcoded: JAM icing + multicolor sprinkles applied to real mesh).
4. Transcript sent to **ElevenLabs Conversational AI** → real LLM response generated + spoken back via TTS in real time.
5. **Typewriter** shows AI response text simultaneously with TTS playback.

The decoration is deterministic and reliable. The conversation is genuinely alive.

### 8.2 Decoration spec (authored constants)
```ts
const ICING = {
    jam: { color: "#8B0000", gloss: 0.8, dripStyle: "smooth" },
};
const SPRINKLES = {
    rainbow: {
        geometry: "capsule",
        palette: ["#FF3E9A", "#FFE642", "#42CFFF", "#8BFF42", "#FF6B42"],
        length: 0.04,
        radius: 0.008,
    },
};
```

### 8.3 Icing application
- BVH radius query → write jam color to vertex color attribute.
- Height mask (`v.y > yIcingLine`) keeps icing on top with noisy drip boundary.
- Edge smoothing pass on painted mask boundary.
- `vertexColors: true` on material.

### 8.4 Sprinkle application
- `MeshSurfaceSampler` weighted by icing color mask → sprinkles land on iced regions only.
- Poisson-disk relaxed placement. One `InstancedMesh` per geometry type. Cap ~1500 total.
- Each pinch drops a batch of ~60 with scale-in animation.

### 8.5 Direct hand decoration (independent of voice)
- Right-hand smear → BVH radius query → write icing color to vertex color.
- Right-hand pinch → drop sprinkle batch at surface contact point.

### 8.6 Chat panel UI (plain DOM)
```
Position:     fixed right side, DOM layer above canvas
Background:   rgba(0, 8, 20, 0.85)
Border:       0.5px cyan (#00FFD1)
Width:        300px
Font:         JetBrains Mono 12px
User bubble:  right-aligned, rgba(255,255,255,0.06)
AI bubble:    left-aligned, no bg
AI avatar:    "✦ DAEDALUS AI" + animated spinner while processing
Typewriter:   ~40 chars/sec, blinking cursor
```

---

## 9. Rendering & Shader Pipeline

### 9.1 Engine
Three.js r160, WebGLRenderer (WebGL2).

### 9.2 Material
`MeshMatcapMaterial`, blue-steel luminous matcap (suits JARVIS palette). `vertexColors: true` for icing overlay. Normals recomputed dirty-region-only per frame.

### 9.3 Rim + ambient glow
Fresnel rim: `pow(1−dot(n, viewDir), uRimPower) · uRimColor`. Rim color: `#00FFD1` cyan (not white).

Proximity glow: when right-hand fingertip is within `r_glow` of a menu element, pulse its emission uniform — the "ambient awareness" that makes it feel like JARVIS.

### 9.4 Post-processing
EffectComposer: `RenderPass` → `GTAOPass` (subtle contact shadows) → `UnrealBloomPass` (threshold high — only glowing affordances bloom) → `OutputPass` + subtle vignette.

### 9.5 AR mode webcam overlay
When AR mode active (§0.7): webcam feed rendered as background plane behind scene geometry. Desaturated + raised contrast. Hand skeleton drawn via MediaPipe `drawConnectors` in green on a 2D canvas layered above feed.

### 9.6 Camera
Fixed framing, slight idle parallax for life. Object rotates (slow auto-spin or hand-twist). Camera mostly static so matcap reads consistently.

---

## 10. Testing Infrastructure

### 10.1 Unit tests (vitest, no browser)
Pure math — gesture predicates, One Euro Filter, brush math, morph driver, coordinate transforms.

```ts
// gesture predicate example
describe("pinchDetect", () => {
    it("returns true when tip4−tip8 < 0.3·S", () => { ... });
    it("returns false when tips are far apart", () => { ... });
});

// Taubin volume preservation
describe("taubinSmooth", () => {
    it("volume changes < 5% after 10 iterations", () => { ... });
});
```

Test files: `tests/gesture/predicates`, `stateMachine`, `tests/tracking/oneEuro`, `tests/sculpt/brushes`, `taubin`, `tests/menu/carousel`, `translate`, `rotate`, `morph`, `tests/decorate/sprinkles`, `chatScripts`.

### 10.2 Mock input (`?mock=1`)
`MockInputSource` replaces MediaPipe entirely. Enabled by `?mock=1` URL param.

```
Mouse position        → right-hand INDEX_TIP
Mouse left-click held → right-hand pinch
Mouse scroll          → right-hand depth (Z)
W/A/S/D               → left-hand position
G                     → finger gun (open carousel)
F                     → flick right
P                     → pinch (select)
X                     → fist
1–6                   → directly activate tool 1–6
[/]                   → brush radius
```

Dev overlay (mock mode only): synthetic skeleton, gesture classification, active tool, morph t value, FPS.

### 10.3 Dev URL params
| Param | Effect |
|---|---|
| `?mock=1` | MockInputSource |
| `?tool=MORPH` | Start in specific tool |
| `?fps=1` | Frame budget breakdown |
| `?singlehand=1` | Force single-hand mode |

---

## 11. Performance Engineering

### 11.1 Hard rules
- **GPU delegate mandatory** (CPU WASM ≈ 10–15fps).
- **Render never blocks on inference** (latest-value store).
- **Dirty-region only** — never full BVH rebuild or full normal recompute per stroke.
- **Zero per-frame allocation** in hot loop (reuse scratch Vector3/Matrix4).
- **One InstancedMesh** per sprinkle geometry type.
- **720p webcam** (MediaPipe downscales internally; higher res burns CPU with no accuracy gain).
- **`addUpdateRange`** to upload only changed attribute ranges.
- `powerPreference: "high-performance"` on renderer.

### 11.2 Auto quality fallback
If FPS < 25 or tracking confidence < 0.5 for >30 frames: drop to single-hand, lower webcam to 720p, increase smoothing, show quiet HUD note.

---

## 12. Gesture Math Reference

Our specific thresholds and formulas — not standard algorithms.

```
Hand scale:       S = ‖wrist − middleMCP‖ (world landmarks)

Pinch:            ‖tip4 − tip8‖ / S < 0.30

Gun pose:         index extended + thumb up + ring+pinky curled

Fist:             all fingers curled, ‖tip4−tip8‖/S > 0.6

Open palm:        all 5 extended, spread > 0.4·S

Flick:            vx(indexTip) > 0.4·S/frame, sustained < 200ms

Parting curtains: bothOpen && vx(L) < −0.3·S/frame && vx(R) > +0.3·S/frame, duration < 600ms

Morph angle:      cumulative rotation of (wristL→wristR) projected onto XZ plane around object center
                  t = clamp(angle_traveled / 2π, 0, 1)

Two-hand scale:   scale = ‖wristL − wristR‖ / startDist

Rotate delta:     deltaQ = Q_current · Q_start⁻¹  (never Euler internally)

Fingertip → world: raycast from camera through NDC → intersect interaction plane at object depth
                   ndcX = x*2−1, ndcY = −(y*2−1)
                   mirror: negate ndcX if displayed video is flipped
```

Debounce: discrete gestures (gun, fist, open palm) require 5 consecutive frames to commit. Prevents flicker.

---

## 13. Director & Flow

### 13.1 Modes
- **`freeplay`** — default. No guidance. Real sculptor.
- **`safety`** — keypress advances to next authored state snapshot. Only used if tracking fails on stage.

### 13.2 Safety snapshots (authored)
- `snapshot_empty.json` — empty scene
- `snapshot_sphere.json` — clean icosphere
- `snapshot_donut.json` — clean donut
- `snapshot_decorated.json` — donut with JAM icing + rainbow sprinkles

---

## 14. Aesthetic System & Design Tokens

### 14.1 JARVIS palette (`render/tokens.ts`)
```ts
export const T = {
    bg:           "#000814",            // near-black, slight blue tint
    bgPanel:      "rgba(0,8,20,0.85)",
    cyan:         "#00FFD1",            // primary: neutral state, borders, rim
    cyanDim:      "rgba(0,255,209,0.3)",
    amber:        "#FFB830",            // active / rotate accent
    white:        "#FFFFFF",            // selected state
    text:         "#FFFFFF",
    textDim:      "rgba(255,255,255,0.45)",
    rimColor:     "#00FFD1",
    // per-tool accents
    toolAdd:      "#00FFD1",            // ADD SHAPES
    toolTranslate:"#4488FF",            // TRANSLATE
    toolDilate:   "#AA44FF",            // DILATE
    toolRotate:   "#FFB830",            // ROTATE
    toolMorph:    "#FF3E9A",            // MORPH
    toolDecorate: "#FFD700",            // DECORATE
};
```

### 14.2 Typography
JetBrains Mono everywhere. Stage labels: uppercase, wide letter-spacing. HUD: lowercase. Panel instructions: dimmed, small.

### 14.3 Chrome layout
```
Top-left:      DAEDALUS // {PHASE}
Top-center:    Tool carousel (when open)
Bottom-left:   Active tool label + instruction line
Bottom-right:  ❓ button (always visible)
Top-right:     FPS (dimmed)
Webcam:        small corner (scene mode) or full bg (AR mode)
Chat panel:    right side DOM when DECORATE active
```

### 14.4 Motion language
- Panel transitions: 120–150ms ease-out.
- Carousel snap: 100ms ease-out.
- Carousel open/close: 120ms scale + fade.
- Affordance hover: 80ms glow increase.
- Ambient pulse on idle menu items: slow 2s sine wave on emission intensity.
- Nothing bouncy. Precise and immediate — like JARVIS.

---

## 15. Tooling & MCPs

| MCP | Why |
|---|---|
| **Context7** | Version-correct docs for Three.js r160, MediaPipe 0.10.12, three-mesh-bvh. Append "use context7" to prompts. |
| **Chrome DevTools MCP** | Live Chrome perf traces; verify 60fps; inspect DOM layers. |
| **GitHub MCP** | Commit at every milestone; keep deployable build at all times. |

**External services:**
- **ElevenLabs Conversational AI** — LLM response + TTS in one API call for DECORATE voice interaction.
- **Web Speech API** — browser-native STT, no key needed.

**Deploy:** Vite static → GitHub Pages or Vercel. COOP/COEP headers if SharedArrayBuffer needed.

---

## 16. Risk Register

| Risk | Trigger | Fallback |
|---|---|---|
| MediaPipe FPS poor | <30fps | numHands→1, drop post-processing, auto quality fallback |
| Menu covered by mesh | renderOrder wrong | verify all menu objects: renderOrder=1, depthTest=false |
| Morph gesture ambiguous | poor circular motion detection | map dilate gesture to morph slider as backup |
| ElevenLabs latency | slow response | decoration fires immediately; AI response delay is acceptable |
| Voice recognition miss | ambient noise, accent | direct hand decoration works independently as fallback |
| Jitter | sensor noise | raise One Euro min_cutoff; reduce mesh density |
| Tracking fails on stage | lost hands | director safety mode + keypress advance |

---

## 17. Dependencies

| Package | Version | Purpose | License |
|---|---|---|---|
| `three` | 0.160.0 | rendering | MIT |
| `@mediapipe/tasks-vision` | 0.10.12 | hand tracking | Apache-2.0 |
| `three-mesh-bvh` | 0.7.0 | sculpt BVH | MIT |
| `vite` | 5.2.11 | build/dev | MIT |
| `typescript` | 5.4.5 | types | Apache-2.0 |
| `vitest` | 1.6.0 | tests | MIT |
| `stats.js` | 0.17.0 | FPS overlay | MIT |
| One Euro Filter | vendored | landmark smoothing | BSD |
| ElevenLabs SDK | latest | conversational AI + TTS | commercial |
| Web Speech API | browser | speech-to-text | native |
| nidorx/matcaps | asset | blue-steel matcap PNG | CC |
| JetBrains Mono | asset | typeface | OFL |

Zero paid services except ElevenLabs (free tier sufficient for demo).

---

## 18. File Manifest

```
daedalus/
├── CLAUDE.md
├── SPEC.md
├── index.html
├── vite.config.ts
├── tsconfig.json
├── public/
│   ├── models/hand_landmarker.task
│   ├── matcaps/blue-steel.png
│   ├── fonts/JetBrainsMono.woff2
│   └── sfx/ ping.wav  hum.wav  ding.wav
├── src/
│   ├── core/
│   │   ├── loop.ts               # master rAF; decoupled inference/render
│   │   ├── director.ts           # freeplay/safety modes + snapshots
│   │   └── store.ts              # latest-pose ring buffer
│   ├── capture/
│   │   └── webcam.ts             # getUserMedia + AR mode background
│   ├── tracking/
│   │   ├── inputSource.ts        # InputSource interface + FrameInput types
│   │   ├── liveInput.ts          # MediaPipe HandLandmarker
│   │   ├── mockInput.ts          # mouse/keyboard mock (?mock=1)
│   │   └── oneEuro.ts            # One Euro Filter
│   ├── gesture/
│   │   ├── predicates.ts         # isPinching, isGun, isFist, isOpenPalm, isFlick, etc.
│   │   ├── detect.ts             # landmarks → discrete gestures
│   │   └── stateMachine.ts       # carousel FSM + execution FSM + undo ring
│   ├── menu/
│   │   ├── carousel.ts           # carousel render + open/close + flick + select
│   │   ├── panel.ts              # base panel (DOM, fixed right side)
│   │   ├── menuRouter.ts         # active tool → module routing
│   │   ├── addShapes.ts          # mini shape carousel + spawn
│   │   ├── translate.ts          # open hand track + fist lock
│   │   ├── dilate.ts             # two-hand scale
│   │   ├── rotate.ts             # quaternion rotation + arcball
│   │   └── morph.ts              # circular gesture → t driver
│   ├── decorate/
│   │   ├── designs.ts            # SPRINKLES / ICING authored constants
│   │   ├── voice.ts              # Web Speech API + ElevenLabs integration
│   │   ├── chatPanel.ts          # DOM chat UI + typewriter
│   │   ├── icing.ts              # vertex-color smear + edge smoothing
│   │   └── sprinkles.ts          # MeshSurfaceSampler + InstancedMesh + Poisson
│   ├── sculpt/
│   │   ├── engine.ts             # BVH query + dirty tracking + normal recompute
│   │   └── brushes.ts            # brush verbs + Taubin
│   ├── render/
│   │   ├── scene.ts              # camera + matcap + composer
│   │   ├── tokens.ts             # design tokens
│   │   ├── layers.ts             # renderOrder/depthTest constants
│   │   ├── post.ts               # GTAO + bloom + vignette
│   │   ├── viewMode.ts           # AR/Scene toggle + parting curtains
│   │   └── overlay.ts            # webcam corner + skeleton draw
│   ├── ui/
│   │   ├── chrome.ts             # stage label + active tool HUD
│   │   ├── devOverlay.ts         # dev overlay (mock mode only)
│   │   └── instructionsPopout.ts # ❓ button + gesture reference modal
│   ├── audio/
│   │   └── sfx.ts                # ping/hum/ding WebAudio
│   └── main.ts                   # bootstrap
├── tests/
│   ├── gesture/
│   │   ├── predicates.test.ts
│   │   └── stateMachine.test.ts
│   ├── tracking/
│   │   └── oneEuro.test.ts
│   ├── sculpt/
│   │   ├── brushes.test.ts
│   │   └── taubin.test.ts
│   ├── menu/
│   │   ├── carousel.test.ts
│   │   ├── translate.test.ts
│   │   ├── rotate.test.ts
│   │   └── morph.test.ts
│   └── decorate/
│       ├── sprinkles.test.ts
│       └── voice.test.ts
└── snapshots/
    ├── snapshot_empty.json
    ├── snapshot_sphere.json
    ├── snapshot_donut.json
    └── snapshot_decorated.json
```

---

## 19. Definition of Done

**Testing infrastructure:**
- [ ] `?mock=1` opens with mouse/keyboard controls + dev overlay showing gesture log
- [ ] All unit tests pass (`pnpm test`)

**Core:**
- [ ] Open URL → empty scene in <3s
- [ ] Both hands tracked; green skeleton; <80ms perceived latency
- [ ] Parting curtains gesture toggles AR/Scene mode with scan line feedback
- [ ] One Euro filtering feels smooth — no jitter at rest, no lag during fast moves

**Carousel:**
- [ ] Finger gun opens carousel at top-center
- [ ] Flick left/right navigates tools, wraps correctly
- [ ] Pinch selects centered tool, carousel closes, panel opens on right
- [ ] Fist dismisses carousel
- [ ] Opening carousel always closes active panel first — never two panels simultaneously
- [ ] All menu geometry renders above mesh (renderOrder=1, depthTest=false)

**Tools:**
- [ ] ADD SHAPES: mini carousel shows cube/sphere/cylinder; pinch spawns as active target
- [ ] TRANSLATE: open hand moves object freely; fist locks position
- [ ] DILATE: two-hand spread/pinch scales object; bounding box renders
- [ ] ROTATE: pinch + twist rotates via quaternion; arcball renders; no gimbal lock
- [ ] MORPH: both-hand circular orbit drives t→donut smoothly and reversibly; ding at t>0.95
- [ ] DECORATE: voice input recognized; JAM icing + rainbow sprinkles apply to real mesh; ElevenLabs responds in voice + typewriter simultaneously
- [ ] Direct hand icing + sprinkles work independently of voice

**Polish:**
- [ ] JARVIS ambient pulse on idle carousel items
- [ ] Proximity glow on affordances when hand approaches
- [ ] Panel slide-in/out animations (150ms)
- [ ] Sound: ping on select, hum on panel open, ding on donut complete
- [ ] ❓ popout shows correct gesture reference for all 6 tools
- [ ] 60fps on demo machine in Chrome
- [ ] Safety mode: keypress advances through snapshots if tracking fails
- [ ] Known-good build deployed to live static URL

---

*Daedalus built wings from wax and feathers and flew too close to the sun. We built menus from light and flew just close enough.*
