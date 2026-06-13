export const meta = {
    name: 'daedalus-v5-build',
    description: 'Greenfield-rebuild Daedalus to SPEC v5: 49 file-agents across 6 dependency levels + verify/repair',
    phases: [
        { title: 'Level A — foundations', detail: '18 leaf modules (no internal deps)' },
        { title: 'Level B — systems', detail: '10 modules depending on Level A' },
        { title: 'Level C — tools', detail: '7 tool/decorate modules' },
        { title: 'Level D — bootstrap', detail: 'main.ts wiring' },
        { title: 'Level E — tests', detail: '11 vitest suites' },
        { title: 'Assets', detail: 'best-effort vendor of model/matcap/sfx' },
        { title: 'Verify & repair', detail: 'tsc + vitest, repair rounds until green' },
    ],
};

// ---- structured-output schemas ----
const FILE_RESULT = {
    type: 'object',
    properties: {
        path: { type: 'string' },
        status: { type: 'string', enum: ['written', 'failed'] },
        exports: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        lines: { type: 'number' },
    },
    required: ['path', 'status', 'notes'],
    additionalProperties: false,
};
const VERIFY_RESULT = {
    type: 'object',
    properties: {
        typecheckPass: { type: 'boolean' },
        testPass: { type: 'boolean' },
        failingFiles: { type: 'array', items: { type: 'string' } },
        errorSummary: { type: 'string' },
    },
    required: ['typecheckPass', 'testPass', 'errorSummary'],
    additionalProperties: false,
};

// ---- shared preamble ----
const NN = [
    'Menu/HUD geometry: renderOrder=1, depthTest=false, depthWrite=false — use asMenuLayer() from src/render/layers.ts. No exceptions.',
    'Smoothing is Taubin only (lambda=0.5, mu=-0.53). Never plain Laplacian.',
    'Dirty-region BVH refit + dirty-region normal recompute only. Never full rebuild per stroke. Use geometry.attributes.*.addUpdateRange.',
    'Zero per-frame allocation in the hot loop — reuse ctx.scratch (Vector3/Matrix4/Quaternion/Ray/Plane).',
    'Plain DOM for all panels. No CSS3DRenderer anywhere.',
    'World starts empty: ctx.mesh may be null — guard every access. Only ADD SHAPES creates the first mesh.',
    'Chat panel and tool panels are fixed to the RIGHT side of the screen.',
    '4-space indent. Constants ALL_CAPS, variables snake_case, functions camelCase.',
    'Must pass `tsc --noEmit` under the existing tsconfig. Import all shared types from src/types.ts; never redefine them.',
];

function buildPrompt(c) {
    const existing = c.x ? `\n- Existing file to PORT/ADAPT (read it; reuse what serves SPEC, delete what does not): ${c.x}` : '';
    const deps = c.d ? `\n\nDEPENDS ON (already written to disk in an earlier level — READ them for real signatures, do not guess):\n${c.d}` : '';
    return [
        'You are building exactly ONE file for Daedalus — a browser real-time 3D sculptor driven by webcam hand tracking (Three.js r160 + MediaPipe + three-mesh-bvh + Vite/TS). Repo root is your cwd.',
        '',
        'READ FIRST (do not skip any):',
        `- SPEC.md — sections ${c.s} (and skim the Table of Contents for context). SPEC.md is the source of truth.`,
        '- src/types.ts, src/render/tokens.ts, src/render/layers.ts — authoritative shared contracts. Import from these; never redefine.',
        '- docs/superpowers/plans/2026-06-13-daedalus-v5-rebuild.md — the plan (find your file card).' + existing,
        '',
        'NON-NEGOTIABLES (any violation = rejected):',
        ...NN.map((n) => '- ' + n),
        '',
        `YOUR FILE: ${c.p}`,
        `RESPONSIBILITY: ${c.r}`,
        `REQUIRED EXPORTS (exact names & signatures — match precisely so callers compile):\n${c.e}`,
        deps,
        '',
        `ACCEPTANCE: ${c.a}`,
        '',
        'Write the COMPLETE, production-quality file with the Write tool (no placeholders, no TODOs, no stubs). Keep it focused and readable.',
        'Do NOT create or modify any other file. Do NOT run the dev server or install packages. Do NOT run git.',
        'When done, return the structured result (path, status, the export names you actually emitted, lines, and any notes for integrators).',
    ].join('\n');
}

const mk = (c, phase) => () => agent(buildPrompt(c), { schema: FILE_RESULT, phase, label: c.p.replace('src/', '').replace('tests/', 't:') });

// ============================ LEVEL A — foundations ============================
const LEVEL_A = [
    { p: 'src/tracking/oneEuro.ts', s: '§3.3', x: 'src/tracking/oneEuro.ts',
      r: 'One Euro Filter for landmark smoothing (min_cutoff=1.0, beta=0.007).',
      e: 'class OneEuroFilter { constructor(minCutoff?:number, beta?:number, dCutoff?:number); filter(x:number, tMs:number):number; reset():void }\nclass HandFilterBank { filter(landmarks:Vec3[], world:Vec3[], tMs:number):{ landmarks:Vec3[]; world:Vec3[] } }  // smooths one hand: 21 image + 21 world landmarks',
      d: '', a: 'Pure & deterministic; no three.js import; less jitter at rest, bounded lag on fast moves; reset() clears history.' },
    { p: 'src/core/store.ts', s: '§2 (threading)', x: 'src/core/store.ts',
      r: 'Latest-pose store, last-write-wins (render reads, inference writes).',
      e: 'class PoseStore { set(f:PoseFrame):void; get():PoseFrame|null }', d: '', a: 'No allocation on get(); holds most recent frame only.' },
    { p: 'src/core/loop.ts', s: '§2 (threading)', x: 'src/core/loop.ts',
      r: 'Master requestAnimationFrame loop, decoupled inference/render.',
      e: 'function startLoop(cb:(dtMs:number)=>void):void\nfunction stopLoop():void', d: '', a: 'Calls cb with dt in ms each frame; starts immediately; render never awaits inference.' },
    { p: 'src/core/director.ts', s: '§13', x: 'src/core/director.ts',
      r: 'Freeplay/safety director. Forward-only stage progression EMPTY->SPHERE->DONUT->DECORATED from observable milestones. Drop guided/assist modes & calibration.',
      e: 'class Director { constructor(mode:DirectorMode); readonly stage:Stage; onShapeAdded():void; onMorph(t:number):void; onDecorated():void; advanceSafety():void }',
      d: '', a: 'Stage is monotonic; onMorph(t>0.95) advances to DONUT; onDecorated()->DECORATED; advanceSafety() steps through snapshots when tracking fails.' },
    { p: 'src/gesture/predicates.ts', s: '§12', x: 'src/gesture/predicates.ts',
      r: 'Gesture predicate math, all thresholds as fractions of hand scale S.',
      e: 'function handScale(world:Vec3[]):number\nfunction pinchAmount(lm:Vec3[], s:number):number  // 0..1\nfunction isPinching(lm:Vec3[], s:number):boolean\nfunction isGun(lm:Vec3[], s:number):boolean\nfunction isFist(lm:Vec3[], s:number):boolean\nfunction isOpenPalm(lm:Vec3[], s:number):boolean\nfunction fingerExtended(lm:Vec3[], tipIdx:number, pipIdx:number):boolean\nfunction spreadAmount(lm:Vec3[], s:number):number',
      d: '', a: 'Exactly SPEC §12: pinch ||tip4-tip8||/S<0.30; fist all curled & ||tip4-tip8||/S>0.6; open all 5 extended & spread>0.4·S; gun = index extended + thumb up + ring&pinky curled. Pure & unit-testable.' },
    { p: 'src/math/coords.ts', s: '§12', x: 'src/math/coords.ts',
      r: 'Fingertip->world unprojection onto the interaction plane; mirror-aware.',
      e: 'function fingertipToWorld(lm:Vec3, camera:THREE.PerspectiveCamera, planeZ:number, ray:THREE.Ray, plane:THREE.Plane, out:THREE.Vector3):THREE.Vector3',
      d: '', a: 'ndcX=x*2-1, ndcY=-(y*2-1); raycast camera->NDC, intersect plane at planeZ; writes into out; zero allocation (reuses passed ray/plane/out).' },
    { p: 'src/sculpt/brushes.ts', s: '§6.2, §6.3', x: 'src/sculpt/brushes.ts',
      r: 'Brush verb kernels + Taubin smooth + falloff. The math sculpt/engine drives.',
      e: 'function falloff(d:number, r:number):number  // (1-(d/r)^2)^2\nfunction taubinSmooth(positions:Float32Array, neighbors:ReadonlyArray<ReadonlyArray<number>>, lambda?:number, mu?:number, iters?:number):void  // lambda=0.5, mu=-0.53\n// + per-verb displacement helpers for Grab/Inflate/Draw/Flatten/Smooth (export named functions or a record keyed by BrushVerb)',
      d: '', a: 'Taubin only; volume drift <5% over 10 iterations on a unit sphere; no per-call allocation beyond one-time setup.' },
    { p: 'src/decorate/designs.ts', s: '§8.2', x: 'src/decorate/designs.ts',
      r: 'Authored ICING / SPRINKLES constants.',
      e: 'const ICING: { jam: IcingDesign }\nconst SPRINKLES: { rainbow: SprinkleDesign }',
      d: '', a: 'Exactly SPEC §8.2: jam color #8B0000 gloss 0.8 dripStyle "smooth"; rainbow capsule palette ["#FF3E9A","#FFE642","#42CFFF","#8BFF42","#FF6B42"] length 0.04 radius 0.008.' },
    { p: 'src/audio/sfx.ts', s: '§1.2', x: 'src/audio/sfx.ts',
      r: 'WebAudio ping/hum/ding. Lazy AudioContext; synth tones procedurally (no wav dependency).',
      e: 'const sfx: { ping():void; hum():void; ding():void; resume():void }',
      d: '', a: 'No autoplay errors; resume() on first user gesture; soft harmonic ping on select, low hum on panel open, crystalline ding on donut.' },
    { p: 'src/menu/panel.ts', s: '§4.2', x: '',
      r: 'Base plain-DOM tool panel fixed to the right side of the screen.',
      e: 'class Panel { constructor(opts:{ title:string; accent?:string }); readonly el:HTMLDivElement; show():void; hide():void; setBody(html:string):void; setInstructions(html:string):void; destroy():void }',
      d: '', a: 'Fixed right; bg rgba(0,8,20,0.85); 0.5px cyan border; inner glow; slide+fade in 150ms / out 80ms; compact instruction strip at bottom; appended to document.body; pointer-events none except interactive controls.' },
    { p: 'src/render/post.ts', s: '§9.4', x: 'src/render/post.ts',
      r: 'EffectComposer: RenderPass -> GTAOPass -> UnrealBloomPass (high threshold) -> OutputPass + subtle vignette.',
      e: 'function makeComposer(renderer:THREE.WebGLRenderer, scene:THREE.Scene, camera:THREE.Camera):{ composer:EffectComposer; resize(w:number,h:number):void; setBloom(strength:number):void }',
      d: '', a: 'Imports from three/examples/jsm/postprocessing/*; only glowing affordances bloom (high threshold); subtle vignette.' },
    { p: 'src/render/overlay.ts', s: '§9.5', x: 'src/render/overlay.ts',
      r: '2D webcam draw (corner in scene mode) + green hand-skeleton overlay.',
      e: 'function drawOverlay(ctx2d:CanvasRenderingContext2D, video:HTMLVideoElement, left:HandPose|null, right:HandPose|null):void',
      d: '', a: 'Desaturated, raised-contrast feed; green skeleton via landmark connections (drawConnectors-style); mirror handled.' },
    { p: 'src/render/geometry.ts', s: '§6.1, §7.1', x: 'src/render/geometry.ts',
      r: 'Sculpt geometry: high-res indexed icosphere + procedural donut morph target (warp the icosphere\'s OWN vertices to a torus, identical vertex count & index order) + primitive shapes.',
      e: 'function makeIcosphere(radius?:number, detail?:number):THREE.BufferGeometry  // indexed via BufferGeometryUtils.mergeVertices; attrs position/normal/color; ~tens of thousands of tris\nfunction buildDonutMorph(geo:THREE.BufferGeometry, R?:number, r?:number):void  // sets geo.morphAttributes.position[0]; R=1.0 r=0.42\nfunction makeShape(kind:"cube"|"sphere"|"tetra"):THREE.BufferGeometry',
      d: '', a: 'Morph target shares vertex count & order with base (per-vertex sphere->torus map). Geometry indexed & ready for computeBoundsTree(). detail ~5-6.' },
    { p: 'src/ui/chrome.ts', s: '§14.3', x: 'src/ui/chrome.ts',
      r: 'HUD chrome (plain DOM + stats.js): DAEDALUS // {PHASE} top-left, active tool + instruction bottom-left, FPS top-right.',
      e: 'class Chrome { begin():void; end():void; update(s:{ stage:Stage; activeMenu:MenuId|null; viewMode:ViewMode }):void }',
      d: '', a: 'JetBrains Mono; stage labels uppercase wide-tracking; HUD lowercase; begin()/end() wrap a frame for stats.js FPS.' },
    { p: 'src/ui/instructionsPopout.ts', s: '§4.4', x: 'src/ui/gestureGuide.ts',
      r: 'Fixed bottom-right ❓ button + gesture-reference modal covering all 6 tools + parting curtains + voice.',
      e: 'class InstructionsPopout { mount():void }',
      d: '', a: 'Always-visible ❓; click opens modal (dark bg, cyan border, JetBrains Mono); pointer-events auto on the button; reflects the 6 SPEC tools.' },
    { p: 'src/decorate/voice.ts', s: '§8.1', x: '',
      r: 'Web Speech API STT + scripted VoiceAdapter (deterministic reply + browser SpeechSynthesis TTS). ElevenLabs adapter is DEFERRED (see TODO.md) — leave a clearly-marked seam.',
      e: 'class ScriptedAdapter implements VoiceAdapter { respond(transcript:string, onToken:(chunk:string)=>void):Promise<VoiceReply>; speak(text:string):void }\nclass SpeechInput { constructor(onTranscript:(t:string)=>void); start():void; stop():void; readonly supported:boolean }\nfunction makeVoiceAdapter():VoiceAdapter',
      d: '', a: 'respond() streams reply tokens (~40 cps) via onToken and resolves with the full text deterministically; speak() uses window.speechSynthesis; everything no-ops gracefully if APIs are absent; read VITE key via (import.meta as any).env?.VITE_ELEVENLABS_AGENT_ID without a hard type dependency.' },
    { p: 'src/tracking/mockInput.ts', s: '§10.2', x: '',
      r: 'Mouse/keyboard mock input (?mock=1) emitting synthetic 21-landmark PoseFrames so the whole app is drivable with no camera.',
      e: 'class MockInputSource implements InputSource',
      d: '', a: 'Mappings per SPEC §10.2: mouse->Right INDEX_TIP; left-click held->Right pinch; scroll->Right depth(z); W/A/S/D->Left position; G finger gun; F flick right; P pinch; X fist; 1-6 activate tool (via window.DAEDALUS if present); [ / ] brush radius. Emits well-formed 21-point hands; PoseFrame.source="mock".' },
    { p: 'src/tracking/inputSource.ts', s: '§3.4', x: '',
      r: 'InputSource picker + shared re-exports.',
      e: 'function pickSourceKind():"live"|"mock"  // "mock" when ?mock=1\nexport type { InputSource, PoseFrame } from "../types"',
      d: '', a: 'No three.js import; reads location.search.' },
];

// ============================ LEVEL B — systems ============================
const LEVEL_B = [
    { p: 'src/gesture/detect.ts', s: '§12', x: '',
      r: 'Landmarks -> GestureState, with 5-frame debounce for discrete gestures.',
      e: 'function classify(lm:Vec3[], world:Vec3[], prevLm?:Vec3[]|null):GestureState  // name/extended/pinch/spread/vx\nclass GestureDebouncer { push(name:GestureName):GestureName }',
      d: '- src/gesture/predicates.ts (isGun/isFist/isOpenPalm/isPinching/handScale/spreadAmount)\n- src/types.ts (GestureState, GestureName)',
      a: 'Discrete gestures (gun/fist/open) require 5 consecutive frames to commit (§12). vx = index-tip horizontal velocity in units of S per frame (uses prevLm).' },
    { p: 'src/gesture/stateMachine.ts', s: '§4.1', x: '',
      r: 'Pure carousel FSM (closed/open + index) + exec latch + small undo ring. Carries the navigation logic that menu/carousel renders.',
      e: 'class CarouselFSM { readonly state:"closed"|"open"; readonly index:number; readonly centered:MenuId; open():void; close():void; flick(dir:1|-1):MenuId; pinchSelect():MenuId|null; dismiss():void }\nclass UndoRing<T> { constructor(cap?:number); push(s:T):void; undo():T|undefined; get size():number }',
      d: '- src/types.ts (MenuId, MENU_ORDER)',
      a: 'flick wraps 6->1 and 1->6; pinchSelect returns the centered tool; dismiss/close return to closed; fully pure & unit-testable.' },
    { p: 'src/tracking/liveInput.ts', s: '§3.1, §3.5', x: 'src/tracking/handLandmarker.ts',
      r: 'MediaPipe HandLandmarker (GPU delegate, VIDEO mode, numHands:2) -> One Euro -> PoseFrame. Render never awaits it inline.',
      e: 'class LiveInputSource implements InputSource { constructor(video:HTMLVideoElement) }',
      d: '- src/tracking/oneEuro.ts (HandFilterBank)\n- src/gesture/predicates.ts (handScale)\n- src/types.ts (InputSource, PoseFrame, HandPose)',
      a: 'Loads the model from the MediaPipe CDN URL (https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task) with WASM from the CDN, OR /models/hand_landmarker.task if present; pump(dt) detectForVideo and returns the latest filtered PoseFrame (source:"live"); handedness-keyed Left/Right; sets handScale; per-hand HandFilterBank; ready flag flips true after init.' },
    { p: 'src/sculpt/engine.ts', s: '§6', x: 'src/sculpt/engine.ts',
      r: 'Sculpt engine: BVH radius query + dirty tracking + dirty-region normal recompute + addUpdateRange upload.',
      e: 'class SculptEngine { constructor(mesh:THREE.Mesh); applyBrush(verb:BrushVerb, point:THREE.Vector3, radius:number, strength:number, scratch:ScratchMath):void; refit():void; dispose():void }',
      d: '- src/sculpt/brushes.ts (falloff, taubinSmooth, verb kernels)\n- src/types.ts (BrushVerb, ScratchMath)\n- three-mesh-bvh (MeshBVH, shapecast/closest)',
      a: 'Dirty-region only: never full BVH rebuild or full normal recompute per stroke; refit() incremental; zero per-frame allocation (use the passed scratch); uploads only changed attribute ranges.' },
    { p: 'src/render/scene.ts', s: '§9.2, §9.6', x: 'src/render/scene.ts',
      r: 'makeContext (renderer/scene/camera/scratch, mesh=null) + matcap material + attachMesh (build mesh + BVH).',
      e: 'function makeContext():SceneContext\nfunction makeMatcapMaterial():THREE.MeshMatcapMaterial\nfunction attachMesh(ctx:SceneContext, geometry:THREE.BufferGeometry):THREE.Mesh',
      d: '- src/render/tokens.ts (T)\n- src/render/geometry.ts (computeBoundsTree readiness)\n- src/render/layers.ts (LAYER)\n- src/types.ts (SceneContext, ScratchMath)\n- three-mesh-bvh (computeBoundsTree)',
      a: 'renderer powerPreference "high-performance", WebGL2; scene background T.bg; fixed-framing PerspectiveCamera with slight idle parallax; matcap loads /matcaps/blue-steel.png but FALLS BACK to a procedurally-generated blue-steel gradient DataTexture if the PNG is missing (so the build works offline); vertexColors:true; attachMesh sets ctx.mesh/ctx.bvh, computeBoundsTree(), renderOrder=0, depthTest/Write=true, and registers the morph target influence array.' },
    { p: 'src/render/viewMode.ts', s: '§0.7', x: '',
      r: 'AR/Scene toggle via the parting-curtains bilateral gesture; cyan scan-line feedback; AR webcam background plane.',
      e: 'class ViewModeController { constructor(scene:THREE.Scene, getVideo:()=>HTMLVideoElement|null); mode:ViewMode; toggle():void; detectPartingCurtains(left:HandPose|null, right:HandPose|null, dt:number):boolean; update(dt:number):void }',
      d: '- src/gesture/predicates.ts (isOpenPalm)\n- src/types.ts (ViewMode, HandPose)\n- three',
      a: 'Default mode "scene" (#000814, no feed). detect: both palms open near center, vx(L)<-0.3·S/frame & vx(R)>+0.3·S/frame, duration<600ms, 1500ms cooldown. On toggle: horizontal cyan scan line sweeps full canvas 80ms then fades. AR mode renders desaturated webcam plane behind geometry.' },
    { p: 'src/menu/carousel.ts', s: '§4.1', x: '',
      r: 'Horizontal tool carousel at top-center (Three.js geometry, Layer 1). Flick navigates (wraps), pinch selects, fist dismisses; ambient pulse + proximity glow.',
      e: 'class Carousel { readonly object:THREE.Group; isOpen:boolean; onSelect:((id:MenuId)=>void)|null; open(atTip:THREE.Vector3):void; close():void; update(navTip:THREE.Vector3, g:GestureState, dt:number):void }',
      d: '- src/gesture/stateMachine.ts (CarouselFSM)\n- src/render/tokens.ts (MENU_META, T)\n- src/render/layers.ts (asMenuLayer)\n- src/types.ts (MenuId, GestureState)\n- three',
      a: 'Active tool centered full-brightness cyan, adjacent 40% opacity, further hidden; tool name+icon below; flick at ~0.4·S/frame slides next/prev with 100ms ease-out snap; pinch selects (onSelect + close, 80ms fade); fist dismisses; ENTIRE object passes through asMenuLayer (renderOrder=1, depthTest=false). 2s sine ambient pulse on idle items.' },
    { p: 'src/menu/menuRouter.ts', s: '§4.2', x: 'src/menu/menuRouter.ts',
      r: 'Tool registry + active routing. Opening the carousel always closes the active panel first — never two panels at once.',
      e: 'class MenuRouter { register(m:MenuModule):void; select(ctx:SceneContext, id:MenuId|null):void; update(ctx:SceneContext, exec:HandPose|null, nav:HandPose|null, dt:number):void; readonly activeId:MenuId|null }',
      d: '- src/menu/panel.ts (Panel)\n- src/types.ts (MenuModule, SceneContext, MenuId)',
      a: 'select() calls active.exit() before next.enter(); syncs ctx.activeMenu; only the active module updates; guarantees a single visible panel.' },
    { p: 'src/decorate/icing.ts', s: '§8.3', x: 'src/decorate/icing.ts',
      r: 'Vertex-color icing: BVH radius query writes jam color; height mask keeps icing on top with a noisy drip boundary; edge smoothing on the mask boundary.',
      e: 'function applyIcing(mesh:THREE.Mesh, bvh:MeshBVH, point:THREE.Vector3, radius:number, design:IcingDesign):void\nfunction icingMask(mesh:THREE.Mesh):Float32Array  // per-vertex 0..1 iced weight',
      d: '- src/decorate/designs.ts (IcingDesign values)\n- src/types.ts (IcingDesign)\n- three-mesh-bvh (MeshBVH)',
      a: 'Writes geometry color attribute (vertexColors); height mask v.y>yIcingLine; noisy boundary; edge-smoothing pass; dirty-range upload.' },
    { p: 'src/ui/devOverlay.ts', s: '§10.2', x: '',
      r: 'Mock-mode dev overlay: synthetic skeleton, gesture classification, active tool, morph t, FPS.',
      e: 'class DevOverlay { constructor(enabled:boolean); update(s:{ frame:PoseFrame; gesture:string; tool:MenuId|null; morphT:number; fps:number }):void }',
      d: '- src/types.ts (PoseFrame, MenuId)',
      a: 'Renders only when enabled (?mock=1); plain DOM/canvas; cheap; never throws when frame hands are null.' },
];

// ============================ LEVEL C — tools + decorate ============================
const LEVEL_C = [
    { p: 'src/decorate/sprinkles.ts', s: '§8.4', x: 'src/decorate/sprinkles.ts',
      r: 'Sprinkles: MeshSurfaceSampler weighted by the icing mask -> one InstancedMesh of capsules, Poisson-relaxed, cap ~1500, scale-in batches of ~60.',
      e: 'class Sprinkles { constructor(scene:THREE.Scene); dropBatch(mesh:THREE.Mesh, mask:Float32Array, design:SprinkleDesign, n?:number):void; clear():void }',
      d: '- src/decorate/designs.ts (SprinkleDesign)\n- src/decorate/icing.ts (icingMask)\n- src/types.ts (SprinkleDesign)\n- three/examples/jsm/math/MeshSurfaceSampler',
      a: 'Sprinkles land only on iced regions (sample weight from mask); one InstancedMesh per geometry type; total cap 1500; each batch ~60 with scale-in animation; rainbow palette per-instance color.' },
    { p: 'src/menu/addShapes.ts', s: '§5.1', x: 'src/menu/addShapes.ts',
      r: 'ADD SHAPES tool: mini carousel Cube·Sphere·Tetra; right-hand pinch spawns the chosen shape at the hand world position; it immediately becomes the active sculpt target (world starts empty).',
      e: 'function createAddShapesMenu():MenuModule',
      d: '- src/render/geometry.ts (makeShape)\n- src/render/scene.ts (attachMesh)\n- src/math/coords.ts (fingertipToWorld)\n- src/menu/panel.ts (Panel)\n- src/types.ts (MenuModule)',
      a: 'Flick cycles cube/sphere/tetra, pinch selects shape; R-pinch calls attachMesh(ctx, makeShape(kind)) at the hand position, replacing ctx.mesh; spawned shape becomes the active target; panel shows the mini carousel + instructions.' },
    { p: 'src/menu/translate.ts', s: '§5.2', x: 'src/menu/translate.ts',
      r: 'TRANSLATE tool: right open palm makes the object track the hand; closing to a fist locks position. No axis arrows.',
      e: 'function createTranslateMenu():MenuModule',
      d: '- src/math/coords.ts (fingertipToWorld)\n- src/menu/panel.ts (Panel)\n- src/gesture/predicates.ts (isOpenPalm/isFist)\n- src/types.ts (MenuModule)',
      a: 'Open palm -> object follows hand world pos freely; fist -> latch in place; no-op when ctx.mesh is null.' },
    { p: 'src/menu/dilate.ts', s: '§5.3', x: 'src/menu/dilate.ts',
      r: 'DILATE tool: two-hand spread/together scales the object; scale=curDist/startDist; bounding box renders on Layer 1.',
      e: 'function createDilateMenu():MenuModule',
      d: '- src/menu/panel.ts (Panel)\n- src/render/layers.ts (asMenuLayer)\n- src/types.ts (MenuModule)\n- three (Box3Helper)',
      a: 'scale = ||wristL-wristR|| / startDist on engage; bbox via asMenuLayer (renderOrder=1, depthTest=false); no-op when ctx.mesh null.' },
    { p: 'src/menu/rotate.ts', s: '§5.4', x: 'src/menu/rotate.ts',
      r: 'ROTATE tool: right pinch near object captures Q_start; each frame deltaQ=Q_current·Q_start⁻¹ applied to R_start; release latches; arcball rings on Layer 1. Quaternion only internally.',
      e: 'function createRotateMenu():MenuModule',
      d: '- src/math/coords.ts (fingertipToWorld)\n- src/menu/panel.ts (Panel)\n- src/render/layers.ts (asMenuLayer)\n- src/gesture/predicates.ts (isPinching)\n- src/types.ts (MenuModule)',
      a: 'Never Euler internally (quaternion math, no gimbal lock); pinch capture/latch; arcball rings asMenuLayer; panel shows display-only Euler; no-op when ctx.mesh null.' },
    { p: 'src/menu/morph.ts', s: '§5.5, §7.2', x: 'src/menu/morph.ts',
      r: 'MORPH tool (play-doh): both hands grab; cumulative orbital angle of (wristL->wristR) on the XZ plane around object center drives t; morphTargetInfluences[0]=smoothstep(t); reversible; ding at t>0.95 for >500ms; real brush deformation runs additively on top.',
      e: 'function createMorphMenu():MenuModule',
      d: '- src/sculpt/engine.ts (SculptEngine, additive brush)\n- src/math/coords.ts\n- src/menu/panel.ts (Panel)\n- src/audio/sfx.ts (ding)\n- src/types.ts (MenuModule)',
      a: 't=clamp(angle_traveled/2π,0,1) tracking angle in real time; unwinding decreases t; object stays centered; sets ctx.morphT and mesh.morphTargetInfluences[0]; ding + label // DONUT when t>0.95 sustained >500ms; brush additive on top; no-op when ctx.mesh null.' },
    { p: 'src/decorate/chatPanel.ts', s: '§8.5, §8.6', x: 'src/decorate/chatPanel.ts',
      r: 'DECORATE tool: plain-DOM chat panel (NO CSS3D) fixed right. On voice transcript: fire hardcoded JAM icing + rainbow sprinkles on the real mesh immediately, then stream the scripted AI reply with a typewriter. Direct-hand smear icing + pinch sprinkles work independently of voice.',
      e: 'function createDecorateMenu():MenuModule\nclass ChatPanel { readonly el:HTMLElement; addUser(t:string):void; beginAI():void; typewrite(text:string, cps?:number):void }',
      d: '- src/decorate/voice.ts (makeVoiceAdapter, SpeechInput)\n- src/decorate/icing.ts (applyIcing, icingMask)\n- src/decorate/sprinkles.ts (Sprinkles)\n- src/decorate/designs.ts (ICING, SPRINKLES)\n- src/menu/panel.ts (Panel) or its own DOM\n- src/math/coords.ts\n- src/types.ts (MenuModule)',
      a: 'Plain DOM only; fixed right 300px; JetBrains Mono 12px; user bubble right-aligned rgba(255,255,255,0.06), AI bubble left no-bg, "✦ DAEDALUS AI" + spinner while processing; typewriter ~40 chars/sec with blinking cursor; decoration fires regardless of AI latency; right-hand smear -> applyIcing, right-hand pinch -> sprinkle batch at surface contact.' },
];

// ============================ LEVEL D — bootstrap ============================
const LEVEL_D = [
    { p: 'src/main.ts', s: '§2, §13, §10.3', x: 'src/main.ts',
      r: 'Bootstrap wiring the whole pipeline to SPEC v5 (no CSS3D, 6 tools, carousel nav, world empty).',
      e: '(side-effect entry point — no exports required)',
      d: '- src/tracking/inputSource.ts (pickSourceKind), src/tracking/liveInput.ts, src/tracking/mockInput.ts\n- src/core/store.ts (PoseStore), src/core/loop.ts (startLoop), src/core/director.ts (Director)\n- src/render/scene.ts (makeContext, attachMesh), src/render/post.ts (makeComposer), src/render/overlay.ts (drawOverlay), src/render/viewMode.ts (ViewModeController)\n- src/menu/carousel.ts (Carousel), src/menu/menuRouter.ts (MenuRouter)\n- src/menu/{addShapes,translate,dilate,rotate,morph}.ts (createXMenu), src/decorate/chatPanel.ts (createDecorateMenu)\n- src/gesture/detect.ts (classify, GestureDebouncer), src/gesture/predicates.ts (handScale)\n- src/ui/chrome.ts (Chrome), src/ui/devOverlay.ts (DevOverlay), src/ui/instructionsPopout.ts (InstructionsPopout)\n- src/capture/webcam.ts (startWebcam), src/audio/sfx.ts (sfx)\n- src/types.ts',
      a: 'Render starts immediately (empty scene visible <3s) before camera resolves; pickSourceKind() chooses Live vs Mock (?mock=1); nav (Left) hand drives carousel open/flick/select + router.select; exec (Right) hand drives the active menu; parting-curtains toggles viewMode; composer.render() each frame (NEVER css3d); drawOverlay for webcam corner; Chrome HUD; director milestones pulled from observable ctx (mesh added, morphT, decorated); ?tool=/?fps=/?singlehand= honored; window.DAEDALUS debug API drives every beat headlessly; world starts EMPTY (ctx.mesh null) — ADD SHAPES is the first action. Remove all CSS3D usage.' },
];

// ============================ LEVEL E — tests ============================
const LEVEL_E = [
    { p: 'tests/predicates.test.ts', s: '§10.1, §12', x: 'tests/predicates.test.ts',
      r: 'Unit tests for gesture predicates.', e: 'vitest describe/it blocks',
      d: '- src/gesture/predicates.ts\n- src/types.ts',
      a: 'pinch true when ||tip4-tip8||/S<0.30 else false; fist/open/gun classification on hand-crafted 21-landmark fixtures; pure (no camera/browser).' },
    { p: 'tests/oneEuro.test.ts', s: '§10.1, §3.3', x: 'tests/oneEuro.test.ts',
      r: 'Unit tests for One Euro Filter.', e: 'vitest describe/it blocks',
      d: '- src/tracking/oneEuro.ts',
      a: 'Filtered output has lower variance than a noisy constant-plus-jitter signal at rest; tracks a ramp with bounded lag; reset() restores initial behavior.' },
    { p: 'tests/brushes.test.ts', s: '§10.1, §6', x: 'tests/brushes.test.ts',
      r: 'Unit tests for falloff + brush kernels.', e: 'vitest describe/it blocks',
      d: '- src/sculpt/brushes.ts',
      a: 'falloff(0,r)=1 and falloff(r,r)=0 and monotonic decreasing; a smooth pass reduces neighbor variance.' },
    { p: 'tests/taubin.test.ts', s: '§10.1, §6.2', x: '',
      r: 'Taubin volume-preservation test.', e: 'vitest describe/it blocks',
      d: '- src/sculpt/brushes.ts (taubinSmooth)\n- src/render/geometry.ts (makeIcosphere for a closed mesh) or a hand-built unit sphere',
      a: 'Volume changes <5% after 10 Taubin iterations on a unit sphere (compute signed volume via divergence theorem over triangles).' },
    { p: 'tests/stateMachine.test.ts', s: '§10.1, §4.1', x: '',
      r: 'Carousel FSM navigation tests.', e: 'vitest describe/it blocks',
      d: '- src/gesture/stateMachine.ts (CarouselFSM, UndoRing)\n- src/types.ts (MENU_ORDER)',
      a: 'flick wraps 6->1 and 1->6; pinchSelect returns the centered tool; open/close/dismiss transitions; UndoRing push/undo respects capacity.' },
    { p: 'tests/carousel.test.ts', s: '§10.1, §4.1', x: '',
      r: 'Carousel navigation + selection (logic level; avoid requiring a WebGL context).', e: 'vitest describe/it blocks',
      d: '- src/menu/carousel.ts (Carousel)\n- src/gesture/stateMachine.ts',
      a: 'Drives index via flicks and asserts wrapping + that pinch fires onSelect with the centered MenuId. If Carousel construction needs WebGL, assert the CarouselFSM-backed nav logic and that isOpen toggles via open()/close().' },
    { p: 'tests/translate.test.ts', s: '§10.1, §5.2', x: '',
      r: 'TRANSLATE behavior test on a minimal headless SceneContext.', e: 'vitest describe/it blocks',
      d: '- src/menu/translate.ts (createTranslateMenu)\n- src/types.ts (SceneContext)',
      a: 'With a stub ctx (a real THREE.Mesh, renderer cast as any since update must not call the renderer): open-palm hand moves mesh.position toward the hand; fist latches (position stops changing). no-op when ctx.mesh null.' },
    { p: 'tests/rotate.test.ts', s: '§10.1, §5.4', x: '',
      r: 'ROTATE quaternion math test.', e: 'vitest describe/it blocks',
      d: '- src/menu/rotate.ts (createRotateMenu)\n- src/types.ts',
      a: 'Applying a known pinch-drag produces the expected quaternion (deltaQ=Q_cur·Q_start⁻¹) with no gimbal lock; composing two rotations matches quaternion multiplication. If internal quaternion math is not exported, test via a small ctx-driven update asserting mesh.quaternion changes consistently and is normalized.' },
    { p: 'tests/morph.test.ts', s: '§10.1, §5.5', x: 'tests/morph.test.ts',
      r: 'MORPH driver test: cumulative angle -> t.', e: 'vitest describe/it blocks',
      d: '- src/menu/morph.ts (createMorphMenu)\n- src/types.ts',
      a: 'Feeding a sequence of two-hand poses that orbit the center increases t toward 1; unwinding decreases t; t clamps to [0,1]. If the angle->t math is internal, drive it through a minimal ctx and assert ctx.morphT monotonic with orbit direction.' },
    { p: 'tests/sprinkles.test.ts', s: '§10.1, §8.4', x: '',
      r: 'Sprinkle placement/cap test.', e: 'vitest describe/it blocks',
      d: '- src/decorate/sprinkles.ts (Sprinkles)\n- src/decorate/icing.ts (icingMask)\n- src/render/geometry.ts (makeIcosphere)',
      a: 'Total instanced sprinkles never exceed 1500 across many dropBatch calls; sprinkles are placed only where the mask weight is > 0. (No WebGL needed — InstancedMesh + sampler work headless.)' },
    { p: 'tests/voice.test.ts', s: '§10.1, §8.1', x: '',
      r: 'Scripted voice adapter determinism test.', e: 'vitest describe/it blocks',
      d: '- src/decorate/voice.ts (ScriptedAdapter, makeVoiceAdapter)',
      a: 'ScriptedAdapter.respond streams tokens via onToken and resolves with the concatenation of those tokens; identical transcript -> identical reply; speak() is callable without throwing when speechSynthesis is undefined (stub it).' },
];

// ============================ EXECUTION ============================
log('Level A — 18 foundation modules');
phase('Level A — foundations');
const ra = await parallel(LEVEL_A.map((c) => mk(c, 'Level A — foundations')));
log(`Level A done: ${ra.filter(Boolean).filter((r) => r.status === 'written').length}/${LEVEL_A.length} written`);

log('Level B — 10 system modules');
phase('Level B — systems');
const rb = await parallel(LEVEL_B.map((c) => mk(c, 'Level B — systems')));
log(`Level B done: ${rb.filter(Boolean).filter((r) => r.status === 'written').length}/${LEVEL_B.length} written`);

log('Level C — 7 tool/decorate modules');
phase('Level C — tools');
const rc = await parallel(LEVEL_C.map((c) => mk(c, 'Level C — tools')));
log(`Level C done: ${rc.filter(Boolean).filter((r) => r.status === 'written').length}/${LEVEL_C.length} written`);

log('Level D — bootstrap main.ts');
phase('Level D — bootstrap');
const rd = await parallel(LEVEL_D.map((c) => mk(c, 'Level D — bootstrap')));

log('Level E — 11 test suites + assets (parallel)');
phase('Level E — tests');
const assetsThunk = () => agent([
    'Best-effort: vendor Daedalus runtime assets into public/. This is NOT required for the build to typecheck or test — if a download fails (e.g. no network), just create the directories and a short public/ASSETS.md noting what is still needed, then return success. Do not fail the workflow over network errors.',
    'Try, using the Bash tool (curl is fine):',
    '1. public/models/hand_landmarker.task  <- https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    '2. public/matcaps/blue-steel.png  <- a small (256px) blue/steel matcap PNG from the nidorx/matcaps repo raw content; if you cannot find one, skip (scene.ts generates a procedural fallback).',
    '3. public/sfx/  <- create the directory; sfx is synthesized at runtime so wav files are optional.',
    'Return a short note of what landed and what is still pending (mirror pending items into TODO.md under "Assets to source" if any remain).',
].join('\n'), { schema: FILE_RESULT, phase: 'Assets', label: 'assets:vendor' });

const re = await parallel([
    ...LEVEL_E.map((c) => mk(c, 'Level E — tests')),
    assetsThunk,
]);
log(`Level E done: ${re.filter(Boolean).filter((r) => r.status === 'written').length} artifacts written`);

// ---- verify + repair loop ----
function runVerify(round) {
    return agent([
        `You are the verification gate for the Daedalus build (round ${round}). Run the project checks and report precisely.`,
        'Steps (Bash tool). Prefer pnpm; if pnpm is missing use npx:',
        '1. `pnpm typecheck`  (== tsc --noEmit). If pnpm missing: `npx tsc --noEmit`.',
        '2. `pnpm test`  (== vitest run). If pnpm missing: `npx vitest run`.',
        'Do NOT edit any files. Capture both outputs.',
        'Return: typecheckPass (tsc exited 0), testPass (vitest exited 0), failingFiles (every distinct source/test file path that appears in an error — relative paths like src/menu/rotate.ts), and errorSummary (a compact digest of the actual tsc errors and failing vitest assertions, file:line: message — keep the real messages, trimmed).',
    ].join('\n'), { schema: VERIFY_RESULT, phase: 'Verify & repair', label: `verify:round${round}` });
}

function repairThunk(file, errorSummary, round) {
    return () => agent([
        `Repair ONE file in the Daedalus build so the project typechecks and tests pass. Round ${round}.`,
        `YOUR FILE: ${file}`,
        '',
        'The full verification error digest (covers the whole project) is below. Find every error attributed to YOUR file and fix it. The root cause may be a wrong call into another module — if so, READ that module on disk and conform to its real, current signature (do not change the other file). Re-read src/types.ts and the shared contracts.',
        'Honor every non-negotiable:',
        ...NN.map((n) => '- ' + n),
        '',
        'Do NOT modify any file other than YOUR file. Do NOT run the dev server or git. You MAY run `npx tsc --noEmit` to check your work.',
        '',
        '=== VERIFICATION ERROR DIGEST ===',
        errorSummary,
    ].join('\n'), { schema: FILE_RESULT, phase: 'Verify & repair', label: `repair:${file.replace('src/', '').replace('tests/', 't:')}` });
}

const ALL_FILES = [...LEVEL_A, ...LEVEL_B, ...LEVEL_C, ...LEVEL_D, ...LEVEL_E].map((c) => c.p);

phase('Verify & repair');
let round = 0;
let verify = await runVerify(round);
log(`verify round 0: typecheck=${verify.typecheckPass} test=${verify.testPass}`);
while ((!verify.typecheckPass || !verify.testPass) && round < 3) {
    round++;
    let files = (verify.failingFiles || []).filter((f) => ALL_FILES.includes(f));
    if (files.length === 0) files = ALL_FILES; // couldn't attribute — repair broadly
    // cap breadth per round to keep repairs focused
    if (files.length > 20) files = files.slice(0, 20);
    log(`repair round ${round}: ${files.length} files`);
    await parallel(files.map((f) => repairThunk(f, verify.errorSummary, round)));
    verify = await runVerify(round);
    log(`verify round ${round}: typecheck=${verify.typecheckPass} test=${verify.testPass}`);
}

return {
    levels: { A: ra.length, B: rb.length, C: rc.length, D: rd.length, E: LEVEL_E.length },
    verify: { typecheckPass: verify.typecheckPass, testPass: verify.testPass, rounds: round },
    errorSummary: (verify.typecheckPass && verify.testPass) ? 'green' : verify.errorSummary,
};
