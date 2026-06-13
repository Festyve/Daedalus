# Presentation Polish — 100-Aspect Manifest (Phase 8)

**Context:** JAMHacks demo. Only what a judge/audience *sees and feels* in a ~3-minute run matters.
Top SPEC priority is **smoothness** (§0.5). This phase makes Daedalus look and feel like Tony Stark's
workshop — luminous, weightless, instant. Runs AFTER build + E2E are green.

**Focus (do):** smoothness/motion, JARVIS visual identity, the signature *moments* (donut reveal, decorate
spectacle), sound, judge legibility, intro/ambiance, AR wow, ambient awareness.

**Explicitly OUT of scope (skip — does not move the demo):** deep edge-case robustness, accessibility,
cross-browser, CI, memory-leak hardening, exhaustive error handling. (Those live in the testing layers; here
we only avoid *breaking* the demo.)

## Execution model — file-colored waves (true non-interference)
1. Each item below = one focused agent, full attention on ONE aspect of ONE owner file.
2. Scheduler colors items by `owner` file: a **wave** contains at most one item per owner file → every agent
   in a wave writes a disjoint file → zero interference.
3. Between waves: `tsc --noEmit` + `vitest run` + a Chrome-MCP screenshot smoke. Green → commit → next wave.
   A later same-file agent re-reads the now-updated file and layers on top.
4. ~10 waves (bounded by the busiest file) × ~12–15 concurrent agents = 100 runs. Harness runs ≤16 at once + queues.
5. Each agent brief: "Improve ONLY {owner}. Make {aspect} demo-stunning per SPEC §14 motion/aesthetic + JARVIS
   north star (§1.2). Do not touch other files. Keep it smooth, keep the build green, honor the non-negotiables
   (renderOrder=1/depthTest=false menus, plain DOM, zero hot-loop alloc)."

> Owner files are the SPEC §18 paths; finalize exact ownership after build (some aspects may relocate).
> Alternative considered: per-aspect git worktrees + curated merge (max concurrency, heavier + merge cost).
> Chosen wave-model = cheaper, guarantees green build, still 100 distinct focused passes.

---

## A — Smoothness & motion language (SPEC §0.5, §14.4)
1. `menu/carousel.ts` — open 120ms scale+fade, no first-frame pop.
2. `menu/carousel.ts` — flick snap 100ms ease-out cubic, velocity-matched 1:1 on fast flicks.
3. `menu/panel.ts` — slide-in 150ms ease-out + fade; out 80ms; GPU-composited transform only.
4. `render/viewMode.ts` — scan-line sweep easing + 80ms fade ("display switching input").
5. `menu/morph.ts` — smoothstep t so the donut blend has no linear seams.
6. `menu/translate.ts` — critically-damped follow so the object trails the hand without lag or jitter.
7. `menu/dilate.ts` — smoothed scale response so noisy two-hand distance never snaps.
8. `menu/rotate.ts` — slerp the latch so release never pops; arcball fade-in.
9. `core/loop.ts` — dt clamping / frame pacing so a stutter never teleports anything.
10. `tracking/oneEuro.ts` — demo-tuned min_cutoff/beta preset (buttery rest, responsive fast moves).
11. `menu/addShapes.ts` — spawn scale-in 0→1 ease-out-back so shapes "arrive".
12. `decorate/sprinkles.ts` — staggered per-instance scale-in (confetti, not all at once).
13. `ui/chrome.ts` — HUD value changes cross-fade (tool/stage) instead of hard cut.
14. `render/scene.ts` — slow Lissajous idle camera parallax for life without disorientation.
15. `menu/carousel.ts` — continuous adjacent-tile opacity/scale interpolation during flick (no stepping).

## B — JARVIS visual identity (SPEC §1.2, §9)
16. `render/post.ts` — bloom threshold/strength so only affordances glow, mesh stays clean.
17. `render/post.ts` — vignette radius/softness for cinematic framing.
18. `render/post.ts` — GTAO subtlety: contact shadow present, not muddy.
19. `render/scene.ts` — fresnel rim power/color #00FFD1 luminous edge.
20. `render/scene.ts` — matcap warmth: blue-steel that reads as holographic metal.
21. `render/tokens.ts` — final color-language pass (cyan neutral / amber active / white selected).
22. `menu/carousel.ts` — holographic translucency on tiles (thin lines, no opaque cards).
23. `menu/panel.ts` — inner-glow + 0.5px cyan border refinement; backdrop blur if cheap.
24. `render/scene.ts` — faint emissive horizon glow so the object floats, not in a void.
25. `render/viewMode.ts` — scan-line color/thickness/glow matches JARVIS language.
26. `ui/instructionsPopout.ts` — modal chrome: thin angular frame, corner ticks.
27. `decorate/chatPanel.ts` — chat panel holographic styling (translucent, glow, weightless).
28. `ui/chrome.ts` — stage label glow + wide tracking ("DAEDALUS // PHASE" as a system readout).
29. `render/scene.ts` — #000814 bg with very subtle star/grid noise for depth.
30. `render/post.ts` — micro chromatic-aberration at edges (very subtle lens realism).

## C — Carousel & menu feel (SPEC §4)
31. `menu/carousel.ts` — ambient 2s sine emission pulse on idle tiles.
32. `menu/carousel.ts` — centered-tool emphasis: scale + brightness + glow ring.
33. `menu/carousel.ts` — icon legibility + per-tool accent tint on focus.
34. `menu/carousel.ts` — lock open position to top-center regardless of hand; gentle anchor.
35. `menu/carousel.ts` — proximity glow as the fingertip nears a tile pre-selection.
36. `menu/menuRouter.ts` — panel cross-transition: outgoing fades before incoming slides (no flash).
37. `menu/panel.ts` — instruction-strip micro-typography + active-gesture highlight.
38. `menu/carousel.ts` — selection confirm: crystalline ping + tile flash + close.
39. `menu/carousel.ts` — fist-dismiss feedback: quick collapse, not abrupt vanish.
40. `menu/panel.ts` — panel header accent bar in the tool color.

## D — Per-tool affordances & moments (SPEC §5)
41. `menu/addShapes.ts` — mini-carousel shows the actual rotating shape thumbnail.
42. `menu/addShapes.ts` — spawn flash + sfx at the spawn point.
43. `menu/translate.ts` — motion ghost/trail while moving; "lock" feedback on fist.
44. `menu/dilate.ts` — bbox style: animated corner ticks + dimension readout.
45. `menu/dilate.ts` — smooth-counting scale number HUD.
46. `menu/rotate.ts` — arcball: glowing great-circles, active-axis highlight.
47. `menu/rotate.ts` — rotation inertia shimmer on latch.
48. `menu/morph.ts` — orbital-progress ring around the object (0→2π fills) showing t.
49. `menu/morph.ts` — hand-ghost indicators at the grab points.
50. `menu/morph.ts` — reversibility hint (ring un-fills on unwind).
51. `decorate/chatPanel.ts` — DECORATE enter: panel + mic indicator reveal.
52. `menu/addShapes.ts` — first-action emphasis (world starts empty → guide the eye here).

## E — The donut reveal (signature beat, SPEC §5.5)
53. `menu/morph.ts` — t>0.95: ding + label snaps to "// DONUT" with a flash.
54. `menu/morph.ts` — completion bloom pulse on the mesh.
55. `audio/sfx.ts` — donut ding: layered crystalline chord, satisfying.
56. `render/scene.ts` — brief rim-color shift toward gold on completion.
57. `ui/chrome.ts` — celebrate SPHERE→DONUT in the HUD.
58. `render/post.ts` — one-shot bloom flare on the completion frame.

## F — Decorate spectacle (SPEC §8)
59. `decorate/icing.ts` — drip-boundary noise + glossy specular on jam.
60. `decorate/icing.ts` — icing "flow" animation as it applies (spreads, not instant).
61. `decorate/sprinkles.ts` — confetti-burst scale-in + tiny bounce.
62. `decorate/sprinkles.ts` — rainbow palette distribution + per-sprinkle rotation variety.
63. `decorate/chatPanel.ts` — typewriter cursor blink + ~40cps per-char cadence.
64. `decorate/chatPanel.ts` — "✦ DAEDALUS AI" spinner + thinking shimmer.
65. `decorate/chatPanel.ts` — user vs AI bubble styling polish.
66. `decorate/voice.ts` — scripted reply persona: witty, on-brand Daedalus voice (demo script).
67. `decorate/voice.ts` — TTS voice/rate selection for character.
68. `decorate/chatPanel.ts` — decoration-fires-immediately synced visually with first AI token.

## G — Sound design (SPEC §1.2, §14)
69. `audio/sfx.ts` — selection ping: soft harmonic, not harsh.
70. `audio/sfx.ts` — panel-open hum: low ambient swell on open, fade on close.
71. `audio/sfx.ts` — carousel flick tick (subtle).
72. `audio/sfx.ts` — master mix levels + gentle limiter (no clipping).
73. `audio/sfx.ts` — optional ambient "powered-on" bed (very low).
74. `audio/sfx.ts` — optional spatial pan tied to interaction position.

## H — Onboarding & legibility for judges (SPEC §4.4, §14.3)
75. `ui/instructionsPopout.ts` — crisp gesture reference: one icon per gesture, all 6 tools.
76. `ui/instructionsPopout.ts` — auto-open briefly on first load, then minimize.
77. `ui/chrome.ts` — first-run hint near the carousel zone: "finger gun to open tools".
78. `ui/chrome.ts` — active-tool instruction line always shows the current gesture.
79. `ui/devOverlay.ts` — clean mock dev overlay for presenting the engineering story.
80. `ui/chrome.ts` — HUD contrast/size legible on a projector across a room.
81. `ui/instructionsPopout.ts` — "voice: just talk to decorate" prompt.
82. `render/overlay.ts` — skeleton overlay legibility so the audience sees tracking working.

## I — Intro / ambiance / scene life (SPEC §13, §9.6)
83. `main.ts` — boot sequence: "DAEDALUS" title flash → fade to empty scene (<3s, never blank).
84. `render/scene.ts` — empty-scene ambiance (faint grid/particles) so it isn't a void pre-ADD.
85. `render/scene.ts` — subtle floating dust motes for depth.
86. `render/post.ts` — intro bloom-up on the first frame.
87. `main.ts` — graceful camera-loading state (no error-y banner during normal init).
88. `render/scene.ts` — gentle object auto-spin when idle so the matcap shimmers.
89. `main.ts` — "ready" cue (sfx + HUD) when tracking locks on.
90. `render/scene.ts` — horizon/floor reflection hint for grounding.

## J — AR mode wow (SPEC §0.7, §9.5)
91. `render/viewMode.ts` — AR webcam treatment: desaturate + contrast + subtle tint for cohesion.
92. `render/overlay.ts` — AR skeleton aesthetic: glowing joints, tapered bones.
93. `render/viewMode.ts` — parting-curtains transition choreography (the reveal).
94. `render/viewMode.ts` — AR object compositing (slight shadow/glow so it sits in the feed).
95. `render/viewMode.ts` — mode-indicator HUD chip (SCENE / AR).

## K — Micro-interactions & ambient awareness (SPEC §1.2, §9.3)
96. `menu/carousel.ts` — world-space fingertip cursor (small glowing dot).
97. `render/scene.ts` — proximity emission: elements brighten as the hand approaches.
98. `menu/panel.ts` — hover-state 80ms glow increase on interactive controls.
99. `decorate/chatPanel.ts` — mic "listening" pulse while capturing voice.
100. `ui/chrome.ts` — FPS readout styled as a dim system-telemetry line.

---

### Owner-file load (informs wave count)
`menu/carousel.ts` 1,2,15,22,31–35,38,39,96 (≈12 → busiest, ~12 waves) ·
`render/scene.ts` 14,19,20,24,29,56,84,85,88,90,97 ·
`render/post.ts` 16,17,18,30,58,86 ·
`menu/morph.ts` 5,48,49,50,53,54 ·
`decorate/chatPanel.ts` 27,51,63,64,65,68,99 ·
`audio/sfx.ts` 55,69–74 ·
`ui/chrome.ts` 13,28,57,77,78,80,100 ·
`menu/panel.ts` 3,23,37,40,98 ·
`render/viewMode.ts` 4,25,91,93,94,95 ·
`menu/addShapes.ts` 11,41,42,52 · `menu/dilate.ts` 7,44,45 · `menu/rotate.ts` 8,46,47 ·
`decorate/icing.ts` 59,60 · `decorate/sprinkles.ts` 12,61,62 · `decorate/voice.ts` 66,67 ·
`ui/instructionsPopout.ts` 26,75,76,81 · `render/overlay.ts` 82,92 · `main.ts` 83,87,89 ·
`menu/translate.ts` 6,43 · `menu/menuRouter.ts` 36 · `render/tokens.ts` 21 · `core/loop.ts` 9 ·
`tracking/oneEuro.ts` 10 · `ui/devOverlay.ts` 79
