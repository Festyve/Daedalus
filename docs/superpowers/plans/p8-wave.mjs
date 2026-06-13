export const meta = {
    name: 'daedalus-p8-polish-wave',
    description: 'Phase 8 presentation polish — run ONE wave of disjoint-file polish agents (wave via args.wave)',
    phases: [
        { title: 'Polish wave', detail: 'one focused agent per aspect; each owns exactly one file' },
    ],
};

// ---- non-negotiables, restated in every agent prompt (HARD CONTRACT) ----
const NN = [
    'Menu/HUD geometry stays on Layer 1: renderOrder=1, depthTest=false, depthWrite=false — via asMenuLayer() from src/render/layers.ts. Never break this.',
    'Smoothing is Taubin only (lambda=0.5, mu=-0.53). Never plain Laplacian.',
    'Dirty-region BVH refit + dirty-region normal recompute only. Never full rebuild per stroke.',
    'ZERO per-frame allocation in the hot loop — reuse existing scratch (Vector3/Matrix4/Quaternion/Color). Any new per-frame object is a rejection.',
    'Plain DOM for all panels. No CSS3DRenderer anywhere.',
    'World can start empty: ctx.mesh may be null — guard every access.',
    '4-space indent. Constants ALL_CAPS, variables snake_case, functions camelCase.',
    'Must keep `tsc --noEmit` clean and `vitest run` green. Do not change exported names/signatures other modules or tests rely on. Import shared types from src/types.ts; never redefine them.',
];

// ---- the 100 aspects: number -> { f: owner file, b: brief } ----
const ASPECTS = {
    1:  { f: 'src/menu/carousel.ts',         b: 'Open animation: 120ms scale+fade in, no first-frame pop.' },
    2:  { f: 'src/menu/carousel.ts',         b: 'Flick snap 100ms ease-out cubic, velocity-matched 1:1 on fast flicks.' },
    3:  { f: 'src/menu/panel.ts',            b: 'Slide-in 150ms ease-out + fade; out 80ms; GPU-composited transform only.' },
    4:  { f: 'src/render/viewMode.ts',       b: 'Scan-line sweep easing + 80ms fade ("display switching input").' },
    5:  { f: 'src/menu/morph.ts',            b: 'Smoothstep the morph t so the sphere->donut blend has no linear seams.' },
    6:  { f: 'src/menu/translate.ts',        b: 'Critically-damped follow so the object trails the hand without lag or jitter.' },
    7:  { f: 'src/menu/dilate.ts',           b: 'Smoothed scale response so noisy two-hand distance never snaps.' },
    8:  { f: 'src/menu/rotate.ts',           b: 'Slerp the latch so release never pops; arcball fade-in.' },
    9:  { f: 'src/core/loop.ts',             b: 'dt clamping / frame pacing so a stutter never teleports anything.' },
    10: { f: 'src/tracking/oneEuro.ts',      b: 'Demo-tuned min_cutoff/beta preset (buttery at rest, responsive on fast moves). Keep existing tests passing.' },
    11: { f: 'src/menu/addShapes.ts',        b: 'Spawn scale-in 0->1 ease-out-back so shapes "arrive".' },
    12: { f: 'src/decorate/sprinkles.ts',    b: 'Staggered per-instance scale-in (confetti, not all at once). Keep the 1500 hard cap + mask-only placement (tests).' },
    13: { f: 'src/ui/chrome.ts',             b: 'HUD value changes cross-fade (tool/stage) instead of a hard cut.' },
    14: { f: 'src/render/scene.ts',          b: 'Slow Lissajous idle camera parallax for life without disorientation.' },
    15: { f: 'src/menu/carousel.ts',         b: 'Continuous adjacent-tile opacity/scale interpolation during flick (no stepping).' },
    16: { f: 'src/render/post.ts',           b: 'Bloom threshold/strength so only affordances glow, mesh stays clean.' },
    17: { f: 'src/render/post.ts',           b: 'Vignette radius/softness for cinematic framing.' },
    18: { f: 'src/render/post.ts',           b: 'GTAO subtlety: contact shadow present, not muddy.' },
    19: { f: 'src/render/scene.ts',          b: 'Fresnel rim power/color #00FFD1 luminous edge on the matcap mesh.' },
    20: { f: 'src/render/scene.ts',          b: 'Matcap warmth: blue-steel that reads as holographic metal (procedural fallback must still work offline).' },
    21: { f: 'src/render/tokens.ts',         b: 'Final color-language pass (cyan neutral / amber active / white selected). Keep token names stable.' },
    22: { f: 'src/menu/carousel.ts',         b: 'Holographic translucency on tiles (thin lines, no opaque cards).' },
    23: { f: 'src/menu/panel.ts',            b: 'Inner-glow + 0.5px cyan border refinement; backdrop blur if cheap.' },
    24: { f: 'src/render/scene.ts',          b: 'Faint emissive horizon glow so the object floats, not in a void.' },
    25: { f: 'src/render/viewMode.ts',       b: 'Scan-line color/thickness/glow matches the JARVIS language.' },
    26: { f: 'src/ui/instructionsPopout.ts', b: 'Modal chrome: thin angular frame, corner ticks.' },
    27: { f: 'src/decorate/chatPanel.ts',    b: 'Chat panel holographic styling (translucent, glow, weightless). Plain DOM only, fixed right.' },
    28: { f: 'src/ui/chrome.ts',             b: 'Stage label glow + wide tracking ("DAEDALUS // PHASE" as a system readout).' },
    29: { f: 'src/render/scene.ts',          b: '#000814 bg with very subtle star/grid noise for depth.' },
    30: { f: 'src/render/post.ts',           b: 'Micro chromatic-aberration at the edges (very subtle lens realism).' },
    31: { f: 'src/menu/carousel.ts',         b: 'Ambient 2s sine emission pulse on idle tiles.' },
    32: { f: 'src/menu/carousel.ts',         b: 'Centered-tool emphasis: scale + brightness + glow ring so the strip reads as a strip (E2E finding).' },
    33: { f: 'src/menu/carousel.ts',         b: 'Icon legibility + per-tool accent tint on focus.' },
    34: { f: 'src/menu/carousel.ts',         b: 'Lock open position to top-center regardless of hand; gentle anchor.' },
    35: { f: 'src/menu/carousel.ts',         b: 'Proximity glow as the fingertip nears a tile pre-selection.' },
    36: { f: 'src/menu/menuRouter.ts',       b: 'Panel cross-transition: outgoing fades before incoming slides (no flash). Keep the single-visible-panel invariant.' },
    37: { f: 'src/menu/panel.ts',            b: 'Instruction-strip micro-typography + active-gesture highlight.' },
    38: { f: 'src/menu/carousel.ts',         b: 'Selection confirm: crystalline ping + tile flash + close.' },
    39: { f: 'src/menu/carousel.ts',         b: 'Fist-dismiss feedback: quick collapse, not an abrupt vanish.' },
    40: { f: 'src/menu/panel.ts',            b: 'Panel header accent bar in the tool color.' },
    41: { f: 'src/menu/addShapes.ts',        b: 'Mini-carousel shows the actual rotating shape thumbnail.' },
    42: { f: 'src/menu/addShapes.ts',        b: 'Spawn flash + sfx at the spawn point.' },
    43: { f: 'src/menu/translate.ts',        b: 'Motion ghost/trail while moving; "lock" feedback on fist.' },
    44: { f: 'src/menu/dilate.ts',           b: 'Bbox style: animated corner ticks + dimension readout (Layer 1).' },
    45: { f: 'src/menu/dilate.ts',           b: 'Smooth-counting scale number HUD.' },
    46: { f: 'src/menu/rotate.ts',           b: 'Arcball: glowing great-circles, active-axis highlight (Layer 1).' },
    47: { f: 'src/menu/rotate.ts',           b: 'Rotation inertia shimmer on latch.' },
    48: { f: 'src/menu/morph.ts',            b: 'Orbital-progress ring around the object (0->2pi fills) showing t. Layer 1.' },
    49: { f: 'src/menu/morph.ts',            b: 'Hand-ghost indicators at the grab points.' },
    50: { f: 'src/menu/morph.ts',            b: 'Reversibility hint (ring un-fills on unwind).' },
    51: { f: 'src/decorate/chatPanel.ts',    b: 'DECORATE enter: panel + mic indicator reveal.' },
    52: { f: 'src/menu/addShapes.ts',        b: 'First-action emphasis (world starts empty -> guide the eye here).' },
    53: { f: 'src/menu/morph.ts',            b: 't>0.95: ding + label snaps to "// DONUT" with a flash.' },
    54: { f: 'src/menu/morph.ts',            b: 'Completion bloom pulse on the mesh.' },
    55: { f: 'src/audio/sfx.ts',             b: 'Donut ding: layered crystalline chord, satisfying. Keep the {ping,hum,ding,resume} API.' },
    56: { f: 'src/render/scene.ts',          b: 'Brief rim-color shift toward gold on donut completion.' },
    57: { f: 'src/ui/chrome.ts',             b: 'Celebrate SPHERE->DONUT in the HUD.' },
    58: { f: 'src/render/post.ts',           b: 'One-shot bloom flare on the completion frame.' },
    59: { f: 'src/decorate/icing.ts',        b: 'DECORATION VISIBILITY (high priority): jam #8B0000 x MeshMatcapMaterial multiply reads near-black on dark steel. Brighten/saturate via emissive or screen-overlay (NOT pure multiply) so the icing POPS at demo distance. Also drip-boundary noise + glossy specular. Keep the height-mask + icingMask() contract and tests.' },
    60: { f: 'src/decorate/icing.ts',        b: 'Icing "flow" animation as it applies (spreads, not instant).' },
    61: { f: 'src/decorate/sprinkles.ts',    b: 'DECORATION VISIBILITY (high priority): 240 sprinkles @ r=0.02 are too small to read at demo distance. Bump sprinkle size + emissive/toneMapped:false so the rainbow reads. Plus confetti-burst scale-in + tiny bounce. Keep the 1500 cap + mask-only placement (tests).' },
    62: { f: 'src/decorate/sprinkles.ts',    b: 'Rainbow palette distribution + per-sprinkle rotation variety. Keep cap + mask tests green.' },
    63: { f: 'src/decorate/chatPanel.ts',    b: 'Typewriter cursor blink + ~40cps per-char cadence. Keep determinism the voice test relies on.' },
    64: { f: 'src/decorate/chatPanel.ts',    b: '"✦ DAEDALUS AI" spinner + thinking shimmer while processing.' },
    65: { f: 'src/decorate/chatPanel.ts',    b: 'User vs AI bubble styling polish.' },
    66: { f: 'src/decorate/voice.ts',        b: 'Scripted reply persona: witty, on-brand Daedalus voice (demo script). Keep ScriptedAdapter determinism (tests).' },
    67: { f: 'src/decorate/voice.ts',        b: 'TTS voice/rate selection for character. No-op gracefully when speechSynthesis is absent.' },
    68: { f: 'src/decorate/chatPanel.ts',    b: 'Decoration-fires-immediately synced visually with the first AI token.' },
    69: { f: 'src/audio/sfx.ts',             b: 'Selection ping: soft harmonic, not harsh.' },
    70: { f: 'src/audio/sfx.ts',             b: 'Panel-open hum: low ambient swell on open, fade on close.' },
    71: { f: 'src/audio/sfx.ts',             b: 'Carousel flick tick (subtle). Add without breaking the existing sfx API.' },
    72: { f: 'src/audio/sfx.ts',             b: 'Master mix levels + gentle limiter (no clipping).' },
    73: { f: 'src/audio/sfx.ts',             b: 'Optional ambient "powered-on" bed (very low).' },
    74: { f: 'src/audio/sfx.ts',             b: 'Optional spatial pan tied to interaction position.' },
    75: { f: 'src/ui/instructionsPopout.ts', b: 'Crisp gesture reference: one icon per gesture, all 6 tools.' },
    76: { f: 'src/ui/instructionsPopout.ts', b: 'Auto-open briefly on first load, then minimize.' },
    77: { f: 'src/ui/chrome.ts',             b: 'First-run hint near the carousel zone: "finger gun to open tools".' },
    78: { f: 'src/ui/chrome.ts',             b: 'Active-tool instruction line always shows the current gesture.' },
    79: { f: 'src/ui/devOverlay.ts',         b: 'Clean mock dev overlay for presenting the engineering story (?mock=1 only).' },
    80: { f: 'src/ui/chrome.ts',             b: 'HUD contrast/size legible on a projector across a room.' },
    81: { f: 'src/ui/instructionsPopout.ts', b: '"voice: just talk to decorate" prompt in the modal.' },
    82: { f: 'src/render/overlay.ts',        b: 'Skeleton overlay legibility so the audience sees tracking working.' },
    83: { f: 'src/main.ts',                  b: 'Boot sequence: "DAEDALUS" title flash -> fade to empty scene (<3s, never blank). Do not block the render loop.' },
    84: { f: 'src/render/scene.ts',          b: 'Empty-scene ambiance (faint grid/particles) so it isn\'t a void pre-ADD.' },
    85: { f: 'src/render/scene.ts',          b: 'Subtle floating dust motes for depth.' },
    86: { f: 'src/render/post.ts',           b: 'Intro bloom-up on the first frame.' },
    87: { f: 'src/main.ts',                  b: 'Graceful camera-loading state (no error-y banner during normal init).' },
    88: { f: 'src/render/scene.ts',          b: 'Gentle object auto-spin when idle so the matcap shimmers.' },
    89: { f: 'src/main.ts',                  b: '"ready" cue (sfx + HUD) when tracking locks on.' },
    90: { f: 'src/render/scene.ts',          b: 'Horizon/floor reflection hint for grounding.' },
    91: { f: 'src/render/viewMode.ts',       b: 'AR webcam treatment: desaturate + contrast + subtle tint for cohesion.' },
    92: { f: 'src/render/overlay.ts',        b: 'AR skeleton aesthetic: glowing joints, tapered bones.' },
    93: { f: 'src/render/viewMode.ts',       b: 'Parting-curtains transition choreography (the reveal). Keep the detect gesture contract.' },
    94: { f: 'src/render/viewMode.ts',       b: 'AR object compositing (slight shadow/glow so it sits in the feed).' },
    95: { f: 'src/render/viewMode.ts',       b: 'Mode-indicator HUD chip (SCENE / AR).' },
    96: { f: 'src/main.ts',                  b: 'World-space fingertip cursor (small glowing dot) that renders whenever a hand is tracked (relocated here from carousel.ts so it shows even when the carousel is closed). Reuse existing scratch; zero per-frame alloc.' },
    97: { f: 'src/render/scene.ts',          b: 'Proximity emission: elements brighten as the hand approaches.' },
    98: { f: 'src/menu/panel.ts',            b: 'Hover-state 80ms glow increase on interactive controls.' },
    99: { f: 'src/decorate/chatPanel.ts',    b: 'Mic "listening" pulse while capturing voice.' },
    100:{ f: 'src/ui/chrome.ts',             b: 'FPS readout styled as a dim system-telemetry line.' },
};

// ---- the 11 waves (computed by the deterministic dealer; disjoint files within each wave) ----
const WAVES = [
    [32, 19, 27, 78, 5, 3, 11, 61, 59, 79],   // wave 1 (decoration 59 + 61 ride here)
    [22, 20, 64, 28, 48, 23, 42, 62, 60],      // wave 2
    [2, 29, 63, 77, 53, 40, 41, 12, 8],        // wave 3
    [1, 24, 65, 80, 54, 37, 52, 46, 66],       // wave 4
    [15, 84, 51, 69, 57, 49, 98, 47, 67],      // wave 5
    [31, 85, 99, 55, 13, 16, 50, 95, 6],       // wave 6
    [33, 88, 68, 70, 100, 17, 4, 7, 43],       // wave 7
    [34, 90, 72, 18, 25, 75, 83, 44, 21],      // wave 8
    [35, 97, 71, 58, 91, 76, 87, 45, 36],      // wave 9
    [38, 14, 73, 86, 93, 26, 89, 82, 9],       // wave 10
    [39, 56, 74, 30, 94, 81, 96, 92, 10],      // wave 11
];

const RESULT_SCHEMA = {
    type: 'object',
    properties: {
        aspect: { type: 'number' },
        file: { type: 'string' },
        status: { type: 'string', enum: ['done', 'skipped', 'failed'] },
        summary: { type: 'string' },        // what changed, 1-2 sentences
        verifiedTscClean: { type: 'boolean' }, // did the agent run `npx tsc --noEmit` and see it clean
    },
    required: ['aspect', 'file', 'status', 'summary'],
    additionalProperties: false,
};

function polishPrompt(n, file, brief) {
    return [
        'You are a presentation-polish agent for DAEDALUS — a browser real-time 3D sculptor (Three.js r160 + MediaPipe + three-mesh-bvh + Vite/TS). Repo root is your cwd. This is a JAMHacks demo: only what a judge SEES and FEELS in a ~3-minute run matters. North star = Tony Stark / JARVIS workshop: luminous, weightless, instant, smooth.',
        '',
        'Improve EXACTLY ONE aspect of EXACTLY ONE file. This is a surgical ENHANCEMENT of an already-working, already-green build — not a rewrite.',
        '',
        `YOUR FILE (edit ONLY this file): ${file}`,
        `ASPECT #${n}: ${brief}`,
        '',
        'READ FIRST (do not skip):',
        `- ${file} in full — understand what exists; preserve all current behavior, exports, and signatures.`,
        '- SPEC.md §1.2 (JARVIS north star), §14 (visual identity + motion language §14.4: "nothing bouncy", eased, fast, deliberate), and the section governing this file.',
        '- src/types.ts and src/render/tokens.ts / src/render/layers.ts for shared contracts. Import from them; never redefine.',
        '',
        'NON-NEGOTIABLES (any violation = rejected):',
        ...NN.map((x) => '- ' + x),
        '',
        'SCOPE DISCIPLINE: wow / smooth / legible ONLY. Do NOT add robustness, accessibility, error handling, CI, or memory hardening — those are out of scope for this phase. Do not "fix" unrelated things. Every changed line must trace to aspect #' + n + '.',
        '',
        'Use the Edit tool for surgical changes (Write only if a full rewrite of THIS file is truly warranted). Do NOT create or modify any other file. Do NOT run the dev server, install packages, or run git.',
        'Before returning, run `npx tsc --noEmit` with the Bash tool and confirm it is clean (set verifiedTscClean accordingly). If your change touches anything a test asserts, keep it green.',
        'Return the structured result (aspect, file, status, a 1-2 sentence summary of exactly what you changed, verifiedTscClean).',
    ].join('\n');
}

// ---- execute ONE wave ----
const wave = (args && typeof args.wave === 'number') ? args.wave : 1;
if (wave < 1 || wave > WAVES.length) throw new Error(`wave must be 1..${WAVES.length}, got ${wave}`);

const nums = WAVES[wave - 1];
log(`Phase 8 — Wave ${wave}/${WAVES.length}: ${nums.length} disjoint-file polish agents → aspects ${nums.join(', ')}`);
phase('Polish wave');

const items = nums.map((n) => ({ n, ...ASPECTS[n] }));
const results = await parallel(items.map((it) => () =>
    agent(polishPrompt(it.n, it.f, it.b), {
        schema: RESULT_SCHEMA,
        phase: 'Polish wave',
        label: `#${it.n} ${it.f.replace('src/', '')}`,
    })
));

const landed = results.filter(Boolean);
const done = landed.filter((r) => r.status === 'done');
log(`Wave ${wave} agents returned: ${done.length}/${nums.length} done`);

return {
    wave,
    total: nums.length,
    aspects: nums,
    results: landed,
    doneCount: done.length,
    failed: landed.filter((r) => r.status !== 'done'),
};
