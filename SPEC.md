# Daedalus — Technical Specification (v3, Deep)

> Sculpt 3D matter with your bare hands. No mouse. No tablet. No headset. Just a webcam, two hands, and the uncertainty of touch.
>
> **The arc:** a cold steel sphere → squish it into a donut → decorate it with AI → eat it.

---

## Table of Contents
0. Document Status
0.5 Governing Principle: Real Functionality, Authored Content
0.6 Cross-Device Sensitivity & Calibration
1. The Thesis
2. The Signature Demo Arc
3. System Architecture
4. Hand Tracking Layer
5. Spatial Edit Menus (deep)
6. Gesture Interaction Paradigms per Menu (deep)
7. Sculpt Engine
8. Morphology: Sphere → Donut (deep)
9. Decorate Phase & AI Chat Interface (deep)
10. The "Eat It" Finale
11. Rendering & Shader Pipeline
12. Performance Engineering
13. Coordinate Spaces & Math Reference
14. Director & Guided Flow
15. Aesthetic System & Design Tokens
16. Tooling, MCPs & Plugins
17. Build Plan (36h, hour-by-hour)
18. Risk Register & Fallbacks
19. Dependencies
20. File-by-File Manifest
21. Definition of Done
22. Pitch & Video Plan

---

## 0. Document Status

| | |
|---|---|
| **Project** | Daedalus |
| **Event** | JAMHacks 10 (36h) |
| **Tracks targeted** | Best Overall · Best Non-GenAI · Best Developer Tool · Most Entertaining Pitch |
| **Team** | 4 |
| **Stack** | Three.js (WebGL2) · MediaPipe Tasks Vision · three-mesh-bvh · three-bvh-csg · Vite + TypeScript |
| **GenAI in product** | **None at runtime.** Chat interface for sprinkles is hardcoded/simulated. Pure CV + geometry processing. |
| **Build philosophy** | Real sculptor with spatial menus. Authored: donut target design, sprinkle designs, icing/glaze styling, AI chat responses. Real: all deformation, all menu interactions, all gesture controls. |
| **Cross-device** | First-class sensitivity + calibration (§0.6) |
| **Structural inspiration** | `collidingScopes/shape-creator-tutorial` (MIT) — elevated to a typed modular engine |

---

## 0.5 Governing Principle: Real Functionality, Authored Content

Daedalus is a **genuinely working real-time sculptor with spatial hand-driven menus.** Every menu interaction, every deformation, every gesture paradigm is real. The only authored content is:

- **The donut target design** — the shape you're sculpting toward (the beautiful donut) is a pre-authored mesh preset the squish/morph system pulls toward. The squishing motion is real; the target it tends toward is designed.
- **Sprinkle / icing / glaze designs** — the visual design of each accessory type is authored. Placement and the AI chat that "generates" them is hardcoded/simulated.
- **AI chat responses** — the chat interface looks and feels like a real LLM is generating the decoration. It is fully hardcoded. The *interface* is real; the *responses* are scripted.
- **Tuning curves** — smoothing, falloff, menu snap distances, transition easing. Authored numbers that make real interactions feel polished.
- **Color tokens & material presets** — authored design system.

**Everything else is real:** menu rendering, menu selection by hand gesture, translation arrows, dilation pinch/spread, rotation hand-twist, morph squish, icing smear, eat dissolve.

**Mental test:** "Is the user's hand genuinely controlling this?" If yes → real. If it's a *design* or a *scripted response* → authored.

---

## 0.6 Cross-Device Sensitivity & Calibration

### 0.6.1 The problem
Different cameras, hand sizes, lighting, and distances all break a fixed-threshold scheme.

### 0.6.2 The solution
1. **Hand-scale normalization (always on).** Every spatial threshold is a fraction of `S = ‖wrist(0) − middleMCP(9)‖` in MediaPipe world landmarks. This removes distance/hand-size variance.
2. **5-second calibration ritual on first load:**
   - "Hold your open hand still" → measure resting jitter → auto-set One Euro `min_cutoff`
   - "Pinch fully" → record user's actual pinch distance as fraction of `S` → set pinch threshold at 60% of that
   - "Reach forward, then back" → record comfortable depth range → map to brush/menu depth
   - "Swipe fast left-to-right" → measure peak velocity → set One Euro `beta`
   - Stores a `CalibrationProfile`; skippable with sane defaults.
3. **Live sensitivity slider** — one 0–1 dial scales brush strength, gesture thresholds, and smoothing together. In the settings panel and usable mid-demo.
4. **Adaptive smoothing** — One Euro params adapt continuously to per-frame jitter.
5. **Auto input-quality detection** — if FPS < 25 or confidence < 0.5 for > 30 frames: drop to single-hand mode, lower webcam to 720p, increase smoothing, show quiet HUD note.

### 0.6.3 CalibrationProfile
```ts
interface CalibrationProfile {
    handScaleMeters: number;
    restingJitter: number;
    peakVelocity: number;
    pinchClosed: number;        // fraction of S at full pinch
    pinchOpen: number;          // fraction of S at rest
    depthNear: number;          // comfortable near reach (world-z)
    depthFar: number;           // comfortable far reach
    responsiveness: number;     // 0..1 master sensitivity
    handedness: "Left" | "Right";
}
```

### 0.6.4 Defaults (skip-calibration path)
`min_cutoff=1.0, beta=0.007, pinch=0.30·S, responsiveness=0.6` — tuned for typical laptop 720p webcam at arm's length.

---

## 1. The Thesis

Daedalus is a browser-based real-time 3D sculptor controlled entirely by webcam hand tracking. Your **left hand navigates spatial edit menus** (floating radial/panel menus that appear in 3D space) to select what you're doing. Your **right hand executes** — using the interaction paradigm for the active menu (arrows, pinch/spread, rotation, squishing, etc).

The name: Daedalus's uncertainty principle says observing a particle perturbs it. Sculpting in mid-air is the same — the instant you hold your hand still to place a precise detail, micro-tremor conspires against you. Our filtering layer is the answer: it turns that uncertainty into clay.

**Why it wins:** every SWE judge will feel the difficulty immediately — real CV, real BVH, real shaders, real gesture menus. It's immediately demonstrable to anyone in the room. And the AI sprinkle chat finisher is the crowd moment: a conversational interface that *talks back* and *decorates the donut* is both technically impressive and funny.

---

## 2. The Signature Demo Arc

```
[ SPHERE ]  →  [ MENU TOUR ]  →  [ SQUISH → DONUT ]  →  [ AI CHAT → SPRINKLES ]  →  [ EAT IT ]
   cold           show off          morph the              "add rainbow              dissolve +
   steel          the menus         sphere into            sprinkles" →              particles
   icosphere      in space          the donut              hardcoded AI              nom nom
```

### Beat 1 — SPHERE (0:00–0:10)
Cold matcap icosphere on pure black. Left hand floats up → the radial menu appears. Stage label `DAEDALUS // SPHERE`.

### Beat 2 — MENU TOUR (0:10–0:30)
Quick pass through the menus to show judges they're real:
- Left hand selects ADD SHAPES → preview of shape primitives
- LEFT hand selects TRANSLATE → directional arrows appear on mesh
- Right hand follows an arrow → mesh shifts
- Switches to ROTATE → hand twist rotates the mesh
- Switches to DILATE → two-hand spread scales it up

### Beat 3 — SQUISH → DONUT (0:30–1:00)
Left hand selects MORPH menu. Right hand squishes/pushes through the sphere — the morph system pulls the geometry toward the authored donut target as the user squishes. The hole punches through, the ring fattens, the donut emerges. Label `// DONUT`. The audience gasps.

### Beat 4 — AI CHAT → SPRINKLES (1:00–1:20)
Left hand opens the DECORATE menu. The AI chat panel slides in from the side. A hardcoded "conversation" plays out:
- User (typed/voice UI): *"Add rainbow sprinkles and pink icing"*
- AI (typewriter effect, hardcoded): *"Sure! Generating rainbow sprinkles... adding pink glaze... done!"*
- Sprinkles materialize on the donut. Icing flows across the top.
Label `// DECORATED`.

### Beat 5 — EAT IT (1:20–1:40)
Left hand → DESTROY menu (or just fist gesture). Right hand brings the donut toward the webcam. Dissolve shader eats it from the bite point. Particles burst. Crunch SFX. Label `// CONSUMED`. Daedalus wordmark.

---

## 3. System Architecture

### 3.1 High-level data flow

```
┌─────────────┐    ┌──────────────────────┐    ┌───────────────────┐
│   Webcam    │───▶│  MediaPipe            │───▶│  One Euro Filter  │
│ getUserMedia│    │  HandLandmarker (GPU) │    │  + Calibration    │
└─────────────┘    │  VIDEO mode, 2 hands  │    └─────────┬─────────┘
                   └──────────────────────┘              │
                                                          ▼
                                            ┌──────────────────────────┐
                                            │   Gesture / State Machine  │
                                            │  L hand → menu nav         │
                                            │  R hand → menu execute     │
                                            └─────────────┬──────────────┘
                                                          ▼
                          ┌──────────────────────────────────────────────────┐
                          │              Menu Router                          │
                          │  active menu → selects execution paradigm:        │
                          │  ADD_SHAPES | TRANSLATE | DILATE | ROTATE |       │
                          │  INTERACT | MORPH | DECORATE | DESTROY            │
                          └──────────────┬───────────────────────────────────┘
                                         ▼
              ┌──────────────────────────────────────────────────────────────┐
              │  Execution Layer (one handler per menu)                       │
              │  translate → arrow affordances + drag                         │
              │  dilate → two-hand scale                                      │
              │  rotate → hand-twist quaternion                               │
              │  morph → squish brush + authored donut target pull           │
              │  decorate → AI chat panel + hardcoded sprinkle placement     │
              │  add → shape picker + instantiation                          │
              │  interact → CSG operations between shapes                   │
              │  destroy → dissolve + particles                              │
              └──────────────┬───────────────────────────────────────────────┘
                             ▼
            ┌────────────────────────────────────────────────────────────────┐
            │  Three.js Scene                                                  │
            │  mesh(es) + menu UI (3D panels) + chat panel + particles        │
            │  → EffectComposer (GTAO + bloom + vignette) → canvas            │
            └────────────────────────────────────────────────────────────────┘
```

### 3.2 Module boundaries
Each menu has its own execution module. The menu router is the only thing that knows which module is active. Modules don't talk to each other; they talk to the shared scene state. This means each beat of the demo can be developed/tested in isolation.

---

## 4. Hand Tracking Layer

See §0.6 for calibration. See §12 for coordinate math.

### 4.1 Library
`@mediapipe/tasks-vision` HandLandmarker or GestureRecognizer. GPU delegate, VIDEO mode, numHands: 2.

### 4.2 Role assignment
- **Left hand** → menu navigator (opens menus, selects items, navigates panels)
- **Right hand** → executor (all spatial manipulation: drags, pinches, twists, squishes)
- Assignment keyed off `handedness`, never screen position. Swappable via calibration.

### 4.3 Landmark reference
```
0  WRIST
1  THUMB_CMC    2  THUMB_MCP   3  THUMB_IP    4  THUMB_TIP
5  INDEX_MCP    6  INDEX_PIP   7  INDEX_DIP   8  INDEX_TIP
9  MIDDLE_MCP  10  MIDDLE_PIP 11  MIDDLE_DIP 12  MIDDLE_TIP
13 RING_MCP    14  RING_PIP   15  RING_DIP   16  RING_TIP
17 PINKY_MCP   18  PINKY_PIP  19  PINKY_DIP  20  PINKY_TIP
```

### 4.4 One Euro Filter
Per landmark, per axis (2 × 21 × 3 = 126 scalar filters). Parameters read through CalibrationProfile. See §0.6.4 for defaults and tuning protocol.

### 4.5 Failure handling
- **No hands:** hold last pose N frames (≈150ms), fade affordances.
- **One hand lost:** suspend that hand's role, continue other.
- **Low confidence:** freeze menu selection and brush engagement.

---

## 5. Spatial Edit Menus (deep)

This is the core UX of Daedalus. Edit menus are **floating spatial panels** that appear in 3D space around the object when the left hand opens them. They are **real interactive elements** — not HUD overlays — and are navigated by hand gesture.

### 5.1 Menu taxonomy
Eight menus, each with its own icon, color accent, and execution paradigm:

| Menu | Icon | Accent | What it does |
|---|---|---|---|
| **ADD SHAPES** | + | teal | Pick from primitive shapes to add to the scene |
| **TRANSLATE** | ↕↔ | blue | Move the selected object via directional arrows |
| **DILATE** | ⊕ | purple | Scale the object up/down |
| **ROTATE** | ↻ | amber | Rotate the object |
| **INTERACT** | ⊗ | red | Boolean/CSG operations between multiple objects |
| **MORPH** | ∿ | pink | Squish/deform the mesh toward authored presets |
| **DECORATE** | ✦ | gold | Open AI chat panel + icing/sprinkle tools |
| **DESTROY** | ✕ | white | Trigger the eat/dissolve finale |

### 5.2 Menu UI — the radial ring
When the left hand forms a **"gun" pose** (index extended, thumb up, others curled), a **radial ring menu** materializes around the left index fingertip in 3D space. The 8 menus are arranged in a circle, each as a glowing icon + label tile.

- Ring appears as a smooth fade-in (120ms).
- Left hand **rotates to aim** the index finger at a menu item (item highlights on dwell).
- Left hand **pinches** to select (closes the ring, activates the menu).
- Left hand **fist** to dismiss without selecting.
- The selected menu stays active (indicated in HUD) until another is picked.

### 5.3 Menu UI — in-menu panels
When a menu is active, a **spatial panel** appears beside the object — a floating card rendered in 3D space (a `Plane` geometry with a canvas texture, or a CSS3DObject). The panel shows the controls/affordances specific to that menu (arrows, sliders, shape picker, chat window). The panel is always legible from the camera (billboard-locked on y-axis, angled toward the user).

### 5.4 Rendering the menus
- All menu geometry rendered as Three.js objects in the scene — not HTML overlays (so they look 3D and can be lit/shadowed). Exception: the AI chat panel uses a CSS3DRenderer layer for the typewriter text effect.
- Menu items have hover states (rim glow), selection states (filled glow), and idle states.
- JetBrains Mono for all labels. Cold brutalist palette with per-menu accent.

### 5.5 Multi-object selection (for INTERACT)
When INTERACT is active, the user can "touch" a second object with the right hand to select it as the target for a boolean operation (union, subtract, intersect — shown as icons in the INTERACT panel).

---

## 6. Gesture Interaction Paradigms per Menu (deep)

Each menu has a dedicated execution paradigm for the right hand. The left hand stays in menu-nav mode; the right hand switches paradigm automatically when the menu changes.

### 6.1 ADD SHAPES
**Paradigm: shape-pick + place**

The SHAPES panel shows a grid of primitive thumbnails: sphere, cube, cylinder, cone, torus, icosahedron. Right-hand **point + dwell** (INDEX_TIP aimed at a thumbnail for ~600ms) highlights it. Right-hand **pinch** selects it. The shape spawns at the right hand's world position. Right hand can then immediately drag it into place.

**Affordances:** thumbnail grid on spatial panel. Currently selected shape ghost follows right INDEX_TIP until placed.

### 6.2 TRANSLATE
**Paradigm: directional arrow drag**

When TRANSLATE is active, **six directional arrows** appear around the selected object (±X, ±Y, ±Z), rendered as Three.js cone+cylinder affordances with per-axis color coding (X=red, Y=green, Z=blue — standard 3D app convention).

Interaction:
- Right hand **hovers near an arrow** → arrow highlights + scales up slightly.
- Right hand **pinches near an arrow and drags** → the object translates along that axis.
- Drag distance = right-hand displacement · sensitivity scalar (from CalibrationProfile).
- **Snap-to-grid:** optional, toggled in panel. Off by default.
- The panel shows live X/Y/Z readout in JetBrains Mono.

**Affordances:** 6 axis arrows + live coordinate display on panel.

### 6.3 DILATE
**Paradigm: two-hand pinch-spread**

Dilation uses **both hands simultaneously.** The right hand is the primary scale handle; the left hand is the secondary (releases menu-nav for this paradigm only — the dilation gesture is too natural to resist).

Interaction:
- User brings both hands near the object, each forming a loose pinch.
- Moving hands **apart** → object scales up uniformly.
- Moving hands **together** → object scales down.
- Scale factor = `currentDist / startDist`.
- Non-uniform scaling: if one hand stays still and only one moves, scale along the axis connecting the two hands.
- The panel shows live scale readout.

**Affordances:** a translucent bounding box around the object while dilation is active, with scale handles at corners (visual only, not interactive).

### 6.4 ROTATE
**Paradigm: hand-twist quaternion**

Right hand controls rotation by its orientation in space.

Interaction:
- On engage (right hand pinch near the object), **capture the starting hand orientation** as a reference quaternion `Q_start` and the object's current rotation `R_start`.
- Every frame: compute `deltaQ = Q_current · Q_start⁻¹` (the rotation the hand has applied since engage).
- Apply `deltaQ` to `R_start` → new object rotation.
- On disengage (pinch release), latch the rotation.
- **Axis lock:** if user points index finger along the panel (a "gun" with the right hand briefly while in ROTATE), lock rotation to the axis closest to the index direction. Shows a lock icon in panel.
- **Free rotate by default.** No gimbal lock (use quaternion throughout, never Euler until final display).

**Affordances:** an arcball ring rendered around the object (3 colored circles for XYZ). The active arc highlights as the hand rotates. Live rotation display in Euler (for human readability) on panel.

### 6.5 INTERACT (CSG operations)
**Paradigm: two-object selection + operation pick**

When INTERACT is active:
1. The currently selected object is "source" (highlighted blue).
2. Right hand "taps" another object (INDEX_TIP proximity) → it becomes "target" (highlighted red).
3. Panel shows three operation icons: UNION (A∪B), SUBTRACT (A−B), INTERSECT (A∩B).
4. Right hand point+dwell on an operation icon → preview shows the resulting mesh ghosted.
5. Right hand pinch to confirm → `three-bvh-csg` `Evaluator.evaluate(source, target, op)` runs.
6. Result replaces source; target removed.

**Gotcha:** three-bvh-csg is experimental; non-manifold results possible. Add a "Repair mesh" button (runs a cleanup pass) and a "Undo" fallback.

### 6.6 MORPH (sphere → donut)
**Paradigm: squish gesture + authored target pull**

This is the hero beat. MORPH menu has two sub-modes shown as panel tabs:

**Free morph (real sculpt brushes):**
- Right hand uses all real brushes (grab/inflate/smooth/flatten/pinch) to freely deform the geometry, just like the sculpt engine (§7). No target pulling.

**Squish-to-preset (the donut demo):**
- Panel shows authored shape presets: DONUT, PRETZEL, PILLOW, BLOB, SPIKE.
- User selects DONUT (pre-authored mesh target).
- A morph influence `t` (0→1) is driven by the **squish gesture**: right-hand fingers closing together like crushing/squishing. `t` increases as the squish tightens, decreases as it opens. The mesh interpolates toward the authored donut target proportionally.
- The morph is **blend-shape driven** (same-topology authored target, `morphTargetInfluences[0] = t`), so it's clean even when the user squishes imprecisely.
- The **real geometry underneath** also responds to grab/push brushes on top of the morph — so the squish feels physically real, not like a slider animation.
- Once `t > 0.95`, label updates to `// DONUT` and a subtle ding SFX fires.

**Squish gesture detection:**
- Measure the spread of fingertips: `spread = average(‖tipI − tipM‖, ‖tipM − tipR‖, ‖tipR − tipP‖)`.
- Normalize by `S`. `spread` maps to `t` via a smooth curve (high spread = `t=0`, tight squeeze = `t=1`).
- Smooth `t` with a low-pass filter so squish feels continuous and satisfying.

### 6.7 DECORATE (AI chat + icing)
**Paradigm: AI chat panel (hardcoded) + smear/drop**

See §9 for the full AI chat spec. Summary:

- Panel opens with a chat interface (CSS3DRenderer layer or canvas texture).
- Hardcoded conversation: user types/speaks a decoration request; AI "responds" with typewriter effect; sprinkles/icing materialize per §9.
- Direct hand tools also available: right-hand smear for icing, pinch to drop sprinkles (real surface picking, authored designs).

### 6.8 DESTROY (eat it)
**Paradigm: fist + bring-to-mouth**

- Left hand selects DESTROY from the menu.
- Right hand forms a fist, moves toward the camera (as if bringing the donut to the mouth).
- When INDEX_TIP z-depth crosses a threshold (close to camera), the dissolve triggers on the mesh under the right hand.
- See §10 for the full dissolve spec.

---

## 7. Sculpt Engine

> Exists to power MORPH free-mode brushes and any direct sculpting. Real BVH-localized deformation on arbitrary geometry.

### 7.1 Geometry baseline
- Icosphere, ~40k triangles. Indexed `BufferGeometry`. Attributes: `position`, `normal`, `color` (icing), `morphTarget[0]` (authored donut target).
- `geometry.computeBoundsTree()` once at load; refit incrementally.

### 7.2 Per-stroke loop
```
1. fingertip(filtered) → world point P (see §13 unprojection)
2. bvh.shapecast → candidate triangles within radius r of P
3. collect unique vertices V where ‖v − P‖ ≤ r
4. for v in V:
     w = falloff(d / r)          // (1-(d/r)^2)^2
     applyBrush(verb, v, w, ctx)
     mark v and incident faces dirty
5. bvh.refit(dirtyNodeSet)
6. recomputeNormals(dirtyVertexSet)
7. upload changed attribute ranges only
```

### 7.3 Brush verbs
| Brush | Operation |
|---|---|
| **Grab/Move** | `v += w · drag` (fingertip delta) |
| **Inflate** | `v += w · strength · n_v` |
| **Draw** | `v += w · strength · n_brushAvg` |
| **Flatten** | project toward area-average plane by `w` |
| **Pinch** | toward brush axis in tangent plane |
| **Crease** | pinch + negative draw |
| **Smooth** | Taubin (λ≈0.5, μ≈−0.53, 1–2 iterations, dirty region only) |

### 7.4 Why Taubin not Laplacian
Plain Laplacian moves vertices toward neighbors' centroid — shrinks volume (~28% measured). Taubin applies a positive step (λ) then a negative un-shrink step (μ) → band-pass filter that preserves volume. For a donut tube that must not deflate: Taubin is mandatory.

---

## 8. Morphology: Sphere → Donut (deep)

### 8.1 The authored donut target
A pre-authored `TorusGeometry` with **identical vertex count and ordering** as the starting icosphere, stored as `morphTarget[0]`. This guarantees clean blend-shape interpolation. Parameters: `R=1.0, r=0.42` (reads as a plump donut).

### 8.2 Squish-driven morph
From §6.6: squish spread → `t` → `morphTargetInfluences[0] = t`. Real brush deformation (§7) runs additively on top so it feels physical and hand-driven, not like watching a slider.

### 8.3 Morph target authoring
```
Torus parameterization:
  x = (R + r·cos(u))·cos(v)
  y = (R + r·cos(u))·sin(v)
  z = r·sin(u)

Map each icosphere vertex (spherical coords θ, φ) → torus (u=θ, v=φ).
Export from Blender or generate procedurally at load time.
```

### 8.4 Other shape presets (MORPH menu)
PRETZEL, PILLOW, BLOB, SPIKE — each an authored morph target. Only DONUT is the hero; others are fun extras if time allows.

---

## 9. Decorate Phase & AI Chat Interface (deep)

### 9.1 The two-layer design
Decoration has two parallel input paths that work simultaneously:

**Path A — AI Chat (hardcoded simulation):**
A conversational interface that *simulates* what an LLM-powered decoration system would look like in a real product. Judges immediately understand the product vision without any real AI being involved.

**Path B — Direct hand tools:**
Real surface picking + real placement of authored-design accessories. A judge can smear icing and drop sprinkles directly with their hands, independent of the chat.

### 9.2 AI Chat Interface (deep spec)

#### 9.2.1 What it is
A floating spatial chat panel (CSS3DRenderer, positioned to the right of the donut). It looks exactly like a minimal chat UI — message bubbles, an input field, a "Decorating AI" avatar. It is **entirely hardcoded.** The product vision is: in v1 of the real product, you'd say "add pastel sprinkles and mint icing" and a real LLM would call a decoration API. For the hackathon, that API call is replaced by scripted responses that produce the exact same output.

#### 9.2.2 Hardcoded conversation scripts
Each script is an array of `ChatTurn` objects. A small set of pre-authored scripts covers the demo flow:

```ts
interface ChatTurn {
    role: "user" | "ai";
    text: string;
    action?: DecorationAction;   // fires when the AI turn completes
    delay: number;               // ms after previous turn
}

interface DecorationAction {
    type: "apply_icing" | "add_sprinkles" | "add_glaze" | "clear";
    design: IcingDesign | SprinkleDesign | GlazeDesign;
    region?: "top" | "all" | "drip";
}
```

**Demo script 1 — the hero conversation:**
```
[user]  "Add rainbow sprinkles and pink icing"          // 0ms
[ai]    "On it! Applying pink glaze first..."            // 800ms → fires: apply_icing(pink, top)
[ai]    "Adding rainbow sprinkles..."                    // 1800ms → fires: add_sprinkles(rainbow)
[ai]    "Done! Your donut looks delicious 🍩"           // 3000ms
```

**Demo script 2 — judge interaction:**
```
[user]  "Make it look like a galaxy donut"
[ai]    "Ooh nice. Applying cosmic purple glaze..."      // → apply_icing(galaxy-purple, all)
[ai]    "Scattering star sprinkles..."                   // → add_sprinkles(star-silver)
[ai]    "Adding a shimmer glaze coat..."                 // → add_glaze(shimmer)
[ai]    "Behold: a galaxy donut."
```

**Script 3 — funny edge case (shown if judges try weird inputs):**
```
[user]  "Make it healthy"
[ai]    "I'm a donut decorator, not a miracle worker."
[ai]    "...adding extra sprinkles."                     // → add_sprinkles(extra-rainbow)
```

#### 9.2.3 Input mechanism
- **Primary:** a virtual keyboard (simple 2D panel) the left hand can "type" on (index-finger tap on key, collision detection on key bounds). Slow but visually impressive.
- **Secondary (fallback):** a physical keyboard input field hidden in the DOM. For the demo, the presenter types.
- **Scripted-demo shortcut:** left hand peace sign while chat is open → immediately fires the next scripted `ChatTurn` sequence. This is the pitch safety mechanism — looks like the user typed it.

#### 9.2.4 Typewriter effect
AI responses appear character-by-character at ~40 chars/second with a blinking cursor. The `DecorationAction` fires when the turn's text is **50% typed** (not at the end) so the decoration starts appearing while the AI is still "talking" — more cinematic.

#### 9.2.5 Chat panel visual spec
```
Background:   #0A0A0A (near-black, distinct from scene black)
Border:       0.5px, rgba(255,255,255,0.12)
Width:        320px equivalent in scene units
Font:         JetBrains Mono 12px
User bubble:  right-aligned, rgba(255,255,255,0.08) bg
AI bubble:    left-aligned, no bg, dimmer text for in-progress
AI avatar:    "✦ DAEDALUS AI" label, animated spinner while "thinking"
Input field:  bottom, monospace, blinking cursor
```

### 9.3 Authored accessory designs

```ts
// Sprinkle geometry presets
const SPRINKLE_DESIGNS: Record<string, SprinkleDesign> = {
    "rainbow":      { geometry: "capsule", palette: ["#FF3E9A","#FFE642","#42CFFF","#8BFF42"], length: 0.04, radius: 0.008, sizeJitter: 0.3, orientation: "random" },
    "star-silver":  { geometry: "star", palette: ["#C0C8D4","#E8EEF4"], length: 0.035, radius: 0.01, sizeJitter: 0.2, orientation: "normal" },
    "extra-rainbow":{ geometry: "capsule", palette: ["#FF3E9A","#FFE642","#42CFFF","#8BFF42","#FF6B42"], length: 0.04, radius: 0.008, sizeJitter: 0.5, orientation: "random" },
};

// Icing / glaze material presets
const ICING_DESIGNS: Record<string, IcingDesign> = {
    "pink":         { color: "#FF3E9A", gloss: 0.7, dripStyle: "smooth", edgeNoise: 0.15, sugarDusting: false },
    "galaxy-purple":{ color: "#8B3EFF", gloss: 0.9, dripStyle: "thick", edgeNoise: 0.2, sugarDusting: true },
};
```

### 9.4 Direct hand decoration (Path B)
- Right-hand smear → vertex-color painting using active `IcingDesign` color+gloss.
- Smear brush: same BVH radius query as sculpt, but writes color attribute instead of displacing position.
- Edge smoothing pass (authored tuning curve) on the painted mask boundary → icing boundary always looks like icing, not a freehand blob.
- Pinch → drop a batch of `SprinkleDesign` instances at the surface under the right hand, via `MeshSurfaceSampler` weighted by icing mask.
- Scatter smoothing: Poisson-disk relaxation on sampled positions so sprinkles never clump.
- One `InstancedMesh` per sprinkle geometry type; cap ~1500 total.

---

## 10. The "Eat It" Finale

> Triggered by DESTROY menu or fist gesture. Real dissolve consumes whatever geometry the user actually sculpted/decorated.

### 10.1 Dissolve shader
```glsl
uniform float uProgress;      // 0 → 1 (animated)
uniform float uEdge;          // edge band, e.g. 0.05
uniform vec3  uBiteOrigin;    // world pos of right hand
uniform vec3  uEdgeColor;     // #FFE6B0 (hot amber)

float dist = length(vWorldPos - uBiteOrigin);
float n = simplexNoise(vObjPos * 4.0) + dist * 0.3;  // bias from bite origin
if (n < uProgress) discard;
float edgeFactor = smoothstep(uProgress, uProgress + uEdge, n);
fragColor.rgb = mix(uEdgeColor, baseColor, edgeFactor);
// edge band gets emissive boost → drives bloom
```

### 10.2 GPU particles
Emit from dissolving edge each frame; velocity = outward + slight gravity; size decay + alpha fade; additive blend + bloom.

### 10.3 Optional CSG bites
2–3 `three-bvh-csg` SUBTRACTION bites at the bite origin before the dissolve, for tactile credibility. If artifacts appear in rehearsal: skip and dissolve-only.

### 10.4 Audio
Crunch SFX on each bite; soft "poof" on dissolve complete. WebAudio, preloaded buffers.

---

## 11. Rendering & Shader Pipeline

### 11.1 Engine
Three.js r17x, `WebGLRenderer` (WebGL2). Optional stretch: `WebGPURenderer` for compute particles.

### 11.2 Material
`MeshMatcapMaterial`, cold brushed-steel matcap. `vertexColors: true` so icing paints. Normals recomputed on dirty region every frame.

### 11.3 Rim light
Fresnel via `onBeforeCompile`: `pow(1 − dot(n, viewDir), uRimPower) · uRimColor` (cold #AEE8FF edge).

### 11.4 Post
`EffectComposer`: RenderPass → GTAOPass (subtle) → UnrealBloomPass (high threshold: only rim + dissolve edge) → OutputPass + vignette.

### 11.5 Menu rendering
- Radial ring and spatial panels: Three.js objects in-scene.
- AI chat panel: `CSS3DRenderer` layer on top for typewriter text.
- Translation arrows: `CylinderGeometry` (shaft) + `ConeGeometry` (tip), per-axis color.
- Dilation bounding box: `BoxHelper` or custom line geometry.
- Rotation arcball: three `TorusGeometry` rings.

### 11.6 Webcam overlay
Corner panel, desaturated. Green skeleton via `drawConnectors`/`drawLandmarks` (HAND_CONNECTIONS) on a 2D canvas layered above.

---

## 12. Performance Engineering

### 12.1 Frame budget (60fps = 16.6ms)
| Stage | Budget |
|---|---|
| MediaPipe inference | 8–12ms (GPU delegate, overlapped) |
| Filtering + calibration | <1ms |
| Gesture + menu router | <1ms |
| BVH query + deform/morph | 2–5ms |
| Normal recompute | 1–3ms |
| Render + menus + post | 4–6ms |

### 12.2 Hard rules
- GPU delegate mandatory.
- Renderer reads latest filtered pose; never blocks on inference.
- Dirty-region updates only.
- Zero per-frame allocation in hot loop (reuse scratch Vector3/Matrix4/Plane).
- One InstancedMesh per sprinkle geometry type.
- Webcam at 720p.
- Upload only changed attribute ranges.
- Menu geometry is static per-frame except affordance highlight state (cheap uniform update).
- CSS3D chat panel is cheap (browser DOM); don't let it block the WebGL frame.

---

## 13. Coordinate Spaces & Math Reference

### 13.1 The spaces
1. **Image space** — MediaPipe `x,y ∈ [0,1]`, origin top-left, mirrored.
2. **NDC** — `ndcX = x*2−1`, `ndcY = −(y*2−1)` (flip y; handle mirror).
3. **World space** — Three.js scene.

### 13.2 Fingertip → world (unprojection)
- Raycast from camera through NDC, intersect interaction plane at object depth.
- Use MediaPipe world-landmark `z` to adjust depth for 3D feel.
- All menu affordance proximity tests happen in world space.

### 13.3 Arrow drag (TRANSLATE)
- Project drag vector onto the arrow's axis direction: `projected = dot(drag3D, axisDir) · axisDir`.
- Apply to object position. Clean axis-locked translation.

### 13.4 Rotation quaternion (ROTATE)
- Capture `Q_start` on engage; `deltaQ = Q_current · Q_start⁻¹`; apply to `R_start`.
- Never convert to Euler until display. No gimbal lock.

### 13.5 Scale (DILATE)
- `scale = currentHandDist / startHandDist · R_start_scale`.
- Non-uniform: if one hand moves more, scale axis = normalized vector between hands.

---

## 14. Director & Guided Flow

The director is a **guided-flow + safety layer** over the real sculptor. It does not fake anything; it guides and provides a keypress fallback.

### 14.1 Modes
- **`guided`** (default for pitch): surfaces prompts/highlights for the SPHERE→DONUT→DECORATE→EAT story. Tracks progress (did they hit t>0.95 on the morph? did they open the chat?). Advances label when real milestones are hit.
- **`assist`**: optional accelerators (snap-to-clean-donut, auto-tidy smoothing pass, "apply icing preset" button visible in panel).
- **`safety`**: keypress advances to next beat using authored mesh snapshots (the ONLY place pre-authored geometry substitutes for real input — strictly a fallback for stage failure).
- **`freeplay`**: no guidance. Real sculptor for judge experimentation.

### 14.2 What's authored only as safety
- Geometry snapshots of each beat (sphere, clean donut, decorated donut) — used only if tracking fails.
- Scripted chat turns — fire on peace-sign shortcut when needed.

---

## 15. Aesthetic System & Design Tokens

### 15.1 Palette (authored constants in `render/tokens.ts`)
```ts
export const TOKENS = {
    bg:         "#000000",
    steel:      "matcap/steel-obsidian.png",
    rim:        "#AEE8FF",    // cold blue-white
    icingPink:  "#FF3E9A",    // hot candy pink
    edgeHot:    "#FFE6B0",    // dissolve edge
    text:       "#FFFFFF",
    textDim:    "rgba(255,255,255,0.45)",
    // menu accents
    menuTeal:   "#00FFD1",    // ADD
    menuBlue:   "#4488FF",    // TRANSLATE
    menuPurple: "#AA44FF",    // DILATE
    menuAmber:  "#FFB830",    // ROTATE
    menuRed:    "#FF4444",    // INTERACT
    menuPink:   "#FF3E9A",    // MORPH
    menuGold:   "#FFD700",    // DECORATE
    menuWhite:  "#FFFFFF",    // DESTROY
};
```

### 15.2 Type
JetBrains Mono everywhere. Stage labels uppercase letter-spaced. HUD lowercase.

### 15.3 Chrome layout
- Top-left: `DAEDALUS // {PHASE}` stage label
- Bottom-left: active menu label
- Bottom-right: desaturated webcam + green skeleton
- Top-right: FPS (dimmed)
- Right: spatial chat panel (when DECORATE active)
- No gradients, no rounded panels outside menus. Editorial brutalist.

---

## 16. Tooling, MCPs & Plugins

### 16.1 Dev MCPs (install these, max 5)
| MCP | Why | Install |
|---|---|---|
| **Context7** | Version-correct docs for Three.js / MediaPipe / three-mesh-bvh / three-bvh-csg. Append "use context7" proactively. | `claude mcp add context7 -- npx -y @upstash/context7-mcp` |
| **Chrome DevTools MCP** | Pull live perf traces; verify 60fps / <80ms; inspect DOM for CSS3D chat panel. | `claude mcp add chrome-devtools -s user -- npx chrome-devtools-mcp@latest` |
| **GitHub MCP** | Commit at every milestone; manage the 30-commit history; keep deployable build. | `claude mcp add github -- npx -y @modelcontextprotocol/server-github` |
| **Playwright MCP** (optional) | Cross-browser smoke test if needed. | `claude mcp add playwright -s user -- npx @playwright/mcp@latest` |

### 16.2 Pitch-video tooling (NOT in-product)
- **Higgsfield AI** (Cinema Studio virtual camera rig) — cinematic title card + "vaporize" finale sting for the pitch video only. Multi-model aggregator with Crash Zoom, Dolly, 360 Orbit presets. Free tier has daily credits.
- **OBS Studio** — 60fps screen capture of live demo.
- **CapCut / DaVinci Resolve** — edit the 90s cut.

### 16.3 Asset tooling
- **Blender** — author the donut morph target; bake/select matcaps.
- **nidorx/matcaps** — cold steel/obsidian matcap PNGs (free).
- **JetBrains Mono** — OFL, self-host.

### 16.4 Deploy
- Vite static build → GitHub Pages or Vercel (free).
- COOP/COEP headers if using SharedArrayBuffer (`vercel.json` or `_headers`).

---

## 17. Build Plan (36h, hour-by-hour)

| Window | Goal |
|---|---|
| **0–2h** | Repo, Vite+TS scaffold, `CLAUDE.md`, MCPs, deploy hello-triangle to live URL. |
| **2–5h** | Webcam + HandLandmarker (GPU, VIDEO, 2 hands) + One Euro + calibration ritual (§0.6). Matcap sphere renders. Green skeleton overlay. Verify <80ms. |
| **5–10h** | Radial ring menu (§5.2): render, open/close gestures, item highlight/select, active-menu state. HUD updates. |
| **10–14h** | TRANSLATE (arrows + axis drag) + DILATE (two-hand scale) + ROTATE (quaternion twist). Verify all three feel good via Chrome DevTools MCP perf trace. |
| **14–18h** | MORPH menu (§6.6): authored donut target, squish gesture → morph influence, real brushes on top. Donut emerges cleanly. |
| **18–20h** | ADD SHAPES (shape picker + spawn) + INTERACT (CSG select + op) — simpler menus. |
| **20–26h** | DECORATE: AI chat panel (CSS3D, hardcoded scripts, typewriter), icing smear, sprinkles (MeshSurfaceSampler + InstancedMesh, Poisson relaxation). |
| **26–30h** | DESTROY / eat finale: dissolve shader + GPU particles + optional CSG bites + crunch SFX. |
| **30–33h** | Polish: matcap rim, GTAO + bloom + vignette, director guided mode, smooth beat transitions. |
| **33–35h** | Cross-device test on a second machine; tune calibration defaults; full run-through rehearsals. |
| **35–36h** | Record pitch video (OBS + Higgsfield stings + CapCut cut). Final known-good commit + deploy. |

---

## 18. Risk Register & Fallbacks

| Risk | Trigger | Fallback |
|---|---|---|
| MediaPipe FPS poor | <30fps | numHands→1, webcam→720p, drop post |
| Menu selection flickers | debounce too short | increase dwell time, require pinch confirmation |
| three-bvh-csg artifacts | non-manifold tris in rehearsal | cut booleans; dissolve-only finale |
| Squish gesture ambiguous | poor squish detection | map left-hand thumbs-up to a morph slider in panel |
| CSS3D chat panel lags | DOM paint overhead | move to canvas texture if needed |
| Feels wrong on demo device | different webcam | run calibration ritual; live sensitivity slider |
| Live sculpt jitters | shaky cursor | re-run calibration; raise `min_cutoff` via slider |
| Tracking fails on stage | lost hands | director `safety` mode → keypress-advance |
| Unprojection depth off | brush floats | lock to fixed interaction plane |

### De-risked minimum-viable build
TRANSLATE + DILATE + ROTATE working → MORPH squish-to-donut → AI chat with hardcoded script → dissolve finale. Skip ADD SHAPES and INTERACT if time is short. Still delivers the full arc with 3 of 8 menus fully polished.

---

## 19. Dependencies

| Package | Purpose | License |
|---|---|---|
| `three` | rendering, geometry, math | MIT |
| `@mediapipe/tasks-vision` | hand tracking | Apache-2.0 |
| `three-mesh-bvh` | sculpt + menu spatial queries | MIT |
| `three-bvh-csg` | INTERACT CSG + optional bites | MIT |
| `vite` + `typescript` | build/dev | MIT / Apache-2.0 |
| `vitest` | tests | MIT |
| `stats.js` | FPS overlay | MIT |
| One Euro Filter (vendored) | landmark smoothing | BSD/MIT |
| `nidorx/matcaps` | matcap textures | CC |
| JetBrains Mono | UI typeface | OFL |

Zero paid services. Zero runtime GenAI. Everything free/open-source.

---

## 20. File-by-File Manifest

```
daedalus/
├── CLAUDE.md
├── SPEC.md
├── index.html
├── vite.config.ts
├── tsconfig.json
├── public/
│   ├── models/hand_landmarker.task
│   ├── matcaps/steel-obsidian.png
│   ├── fonts/JetBrainsMono.woff2
│   └── sfx/crunch.wav, poof.wav, ding.wav
├── src/
│   ├── core/
│   │   ├── loop.ts               # master rAF, decoupled inference/render
│   │   ├── director.ts           # guided/assist/safety/freeplay modes
│   │   └── store.ts              # latest-pose value store (ring buffer)
│   ├── capture/
│   │   └── webcam.ts             # getUserMedia, video element
│   ├── tracking/
│   │   ├── handLandmarker.ts     # MediaPipe init + pump
│   │   ├── oneEuro.ts            # One Euro Filter (adaptive)
│   │   └── calibration.ts        # §0.6 ritual, CalibrationProfile, live slider
│   ├── gesture/
│   │   ├── predicates.ts         # finger-extended, pinch, spread, squish, hand scale
│   │   ├── detect.ts             # landmarks → discrete gestures
│   │   └── stateMachine.ts       # menu-nav + execution brush FSM + undo ring
│   ├── menu/
│   │   ├── radialRing.ts         # §5.2 ring render + open/close + selection
│   │   ├── spatialPanel.ts       # §5.3 floating panel base component
│   │   ├── menuRouter.ts         # active menu → execution paradigm routing
│   │   ├── addShapes.ts          # §6.1 shape picker + spawn
│   │   ├── translate.ts          # §6.2 arrow affordances + axis drag
│   │   ├── dilate.ts             # §6.3 two-hand scale + bbox
│   │   ├── rotate.ts             # §6.4 arcball + quaternion twist
│   │   ├── interact.ts           # §6.5 two-object CSG operations
│   │   ├── morph.ts              # §6.6 squish gesture + authored target blend
│   │   └── destroy.ts            # §6.8 fist + bring-to-mouth trigger
│   ├── decorate/
│   │   ├── designs.ts            # §9.3 authored SprinkleDesign/IcingDesign/GlazeDesign
│   │   ├── chatPanel.ts          # §9.2 AI chat UI + hardcoded scripts + typewriter
│   │   ├── icing.ts              # vertex-color painting + edge smoothing
│   │   └── sprinkles.ts          # MeshSurfaceSampler + InstancedMesh + Poisson relax
│   ├── sculpt/
│   │   ├── engine.ts             # BVH query, dirty tracking, normal recompute
│   │   └── brushes.ts            # all brush verbs + Taubin smooth
│   ├── finale/
│   │   ├── dissolve.ts           # dissolve shader + uniforms + progress driver
│   │   ├── particles.ts          # GPU particle burst
│   │   └── csg.ts                # optional three-bvh-csg bites
│   ├── render/
│   │   ├── scene.ts              # camera, matcap, composer, rim, CSS3DRenderer
│   │   ├── tokens.ts             # §15.1 authored design tokens
│   │   ├── post.ts               # GTAO + bloom + vignette
│   │   └── overlay.ts            # webcam corner + skeleton draw
│   ├── ui/
│   │   ├── chrome.ts             # stage label, active-menu HUD, FPS
│   │   └── calibrationUI.ts      # calibration ritual + sensitivity slider
│   ├── audio/
│   │   └── sfx.ts                # crunch/poof/ding WebAudio
│   └── main.ts                   # bootstrap
└── tests/
    ├── predicates.test.ts
    ├── oneEuro.test.ts
    ├── calibration.test.ts
    ├── brushes.test.ts
    └── morph.test.ts
```

---

## 21. Definition of Done

- [ ] Open URL → webcam grants → sphere appears in <3s
- [ ] Calibration ritual runs (skippable); live sensitivity slider works; feels right on a second device
- [ ] Both hands tracked with green skeleton; <80ms perceived latency
- [ ] Radial ring menu opens on "gun" pose; all 8 menus selectable; active menu shown in HUD
- [ ] TRANSLATE: arrows appear, axis drag works, object moves correctly
- [ ] DILATE: two-hand spread scales object; bounding box shows
- [ ] ROTATE: hand twist rotates; arcball renders; quaternion (no gimbal lock)
- [ ] MORPH: squish gesture drives t toward donut; real brushes apply on top; donut emerges cleanly
- [ ] DECORATE: AI chat panel opens; hardcoded conversation plays with typewriter; sprinkles/icing appear
- [ ] Direct hand decoration: icing smear + sprinkle drop works independently of chat
- [ ] DESTROY/eat: dissolve shader + particles + crunch SFX, cinematic
- [ ] Freeplay is a real working sculptor
- [ ] 60fps on demo machine in Chrome
- [ ] Director safety mode advances via keypress if tracking fails
- [ ] Known-good build deployed to live static URL
- [ ] 90-second pitch video recorded and edited

---

## 22. Pitch & Video Plan

### 22.1 Live demo
Run director in `guided` mode. Use peace-sign shortcut to fire the AI chat script on cue. If tracking flakes, teammate switches to `safety` keypress mode.

### 22.2 Pitch video (90s)
- **Core:** OBS 60fps screen capture (sphere → menu tour → donut → AI chat → sprinkles → eat).
- **Stings:** Higgsfield Cinema Studio for title card + dramatic "vaporize" finale (pitch video only — never in-product).
- **Audio:** crunch/poof SFX synced; cold synth bed.
- **Edit:** CapCut or DaVinci Resolve.
- **Last frame:** `DAEDALUS` wordmark on black + live URL.

### 22.3 One-liners
> "Blender takes months to learn. Daedalus takes ten seconds and two hands. Watch me make a donut — and eat it."

> "We simulated what an AI decoration API would look like. Now imagine GPT-4o calling this. That's the product."

---

*Daedalus — you can know where your hand is, or what it's shaping. Never both. That's the fun.*
