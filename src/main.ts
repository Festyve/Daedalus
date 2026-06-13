// DAEDALUS v5 bootstrap (SPEC §2, §10.3, §13). Wires the whole pipeline:
//
//   InputSource (live MediaPipe | mock mouse/keyboard, picked by ?mock=1)
//     -> PoseStore (latest-value, last-write-wins — render never awaits inference)
//     -> nav (Left) hand drives the tool carousel: gun opens, flick navigates,
//        pinch selects -> router.select; fist dismisses
//     -> exec (Right) hand drives the active menu module
//     -> parting-curtains (both open palms sweeping apart) toggles scene <-> AR
//     -> Three.js scene + EffectComposer (NEVER CSS3D) + webcam corner overlay + HUD
//
// Rendering starts IMMEDIATELY so the empty scene is visible in <3s before the
// camera resolves; tracking attaches when ready. The world starts EMPTY: ctx.mesh
// is null until ADD SHAPES spawns the first mesh — every access is guarded here.
//
// The Director is the forward-only flow source of truth; we pull its milestones from
// the observable ctx (mesh added -> SPHERE, morphT -> DONUT, decorated -> DECORATED).
//
// A window.DAEDALUS debug API drives every beat headlessly (used by the mock input,
// headless verification, and the safety-mode operator).
import "./styles.css";
import * as THREE from "three";

import { pickSourceKind } from "./tracking/inputSource";
import { LiveInputSource } from "./tracking/liveInput";
import { MockInputSource } from "./tracking/mockInput";
import { startWebcam } from "./capture/webcam";

import { PoseStore } from "./core/store";
import { startLoop } from "./core/loop";
import { Director } from "./core/director";
import { QualityGuard } from "./core/quality";
import { SnapshotPlayer } from "./core/snapshots";

import { makeContext } from "./render/scene";
import { makeComposer } from "./render/post";
import { drawOverlay } from "./render/overlay";
import { ViewModeController } from "./render/viewMode";
import { AutoRotate } from "./render/autoRotate";

import { Carousel } from "./menu/carousel";
import { MenuRouter } from "./menu/menuRouter";
import { createAddShapesMenu } from "./menu/addShapes";
import { createTranslateMenu } from "./menu/translate";
import { createDilateMenu } from "./menu/dilate";
import { createRotateMenu } from "./menu/rotate";
import { createMorphMenu } from "./menu/morph";
import { createDecorateMenu } from "./decorate/chatPanel";

import { classify, GestureDebouncer } from "./gesture/detect";
import { handScale } from "./gesture/predicates";

import { Chrome } from "./ui/chrome";
import { DevOverlay } from "./ui/devOverlay";
import { InstructionsPopout } from "./ui/instructionsPopout";

import { sfx } from "./audio/sfx";

import { fingertipToWorld } from "./math/coords";
import { MenuId, MENU_ORDER } from "./types";
import type { Handedness, HandPose, InputSource, PoseFrame, SceneContext } from "./types";

// MediaPipe index of the navigation index fingertip (carousel aim, §4.1, §12).
const INDEX_TIP = 8;

// An empty frame held before any pose arrives, so the loop never sees undefined.
const EMPTY_FRAME: PoseFrame = { Left: null, Right: null, count: 0, tMs: 0, source: "mock" };

// ---- dev URL params (§10.3) ------------------------------------------------
const PARAMS = new URLSearchParams(location.search);
const PARAM_TOOL = PARAMS.get("tool");           // ?tool=MORPH — start in a tool
const PARAM_FPS = PARAMS.get("fps") === "1";     // ?fps=1 — show the mock dev overlay
const SINGLE_HAND = PARAMS.get("singlehand") === "1"; // ?singlehand=1 — one hand drives both roles
const IS_MOCK = pickSourceKind() === "mock";     // ?mock=1 — mouse/keyboard input

// ---- core singletons -------------------------------------------------------
const ctx: SceneContext = makeContext();
const store = new PoseStore();
const director = new Director("freeplay");
const router = new MenuRouter();

// Register all six tool modules (§5.1–§5.6). The router is a registry; it never
// imports the modules itself, so the module-boundary rule (talk only through
// SceneContext) is preserved.
router.register(createAddShapesMenu());
router.register(createTranslateMenu());
router.register(createDilateMenu());
router.register(createRotateMenu());
router.register(createMorphMenu());
router.register(createDecorateMenu());

// Tool carousel (§4.1). Parented to the camera so it stays pinned at top-center; the
// nav fingertip is transformed world -> camera-local before being handed to update().
const carousel = new Carousel();
// Top-center, in front of the camera. At local z=-3.2 the visible half-height is
// 3.2·tan(fov/2) ≈ 1.33, so y must stay below that (with margin for the ring/label
// above the center) or the tiles sit off the top edge (§4.1). y≈0.9 keeps the whole
// wheel — ring, tiles, and the label that drops below — fully on screen.
carousel.object.position.set(0, 0.9, -3.2);
ctx.camera.add(carousel.object);
ctx.scene.add(ctx.camera);
carousel.onSelect = (id) => {
    sfx.ping();
    router.select(ctx, id);
};

// Post-processing composer (§9.4). composer.render() runs every frame — NEVER css3d.
const { composer } = makeComposer(ctx.renderer, ctx.scene, ctx.camera);

// Idle auto-spin driver (§9.6): slowly rotates the object only while the user is not
// focused on it, easing to a stop the moment they engage a tool or raise a hand.
const autoRotate = new AutoRotate();

// HUD chrome (§14.3) + the always-on ❓ gesture guide (§4.4) + the mock dev overlay.
const chrome = new Chrome();
const instructions = new InstructionsPopout();
instructions.mount();
const devOverlay = new DevOverlay(IS_MOCK || PARAM_FPS);

// ---- preview canvas / corner mirror / banner -------------------------------
// #preview is now the fullscreen webcam + skeleton (the main view); #corner is a
// small clean model-on-black mirror of the WebGL canvas (the old big-screen look).
const previewCanvas = document.getElementById("preview") as HTMLCanvasElement | null;
const previewCtx = previewCanvas ? previewCanvas.getContext("2d") : null;
const cornerCanvas = document.getElementById("corner") as HTMLCanvasElement | null;
const cornerCtx = cornerCanvas ? cornerCanvas.getContext("2d") : null;
const banner = document.getElementById("banner");

// Size the 2D canvases' drawing buffers: #preview fills the viewport (sharp webcam),
// #corner keeps the screen aspect so the mirrored model isn't distorted (CSS pins its
// on-screen width to 260px). Re-run on resize.
const CORNER_WIDTH_CSS = 260;
function sizePreviewCanvases(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (previewCanvas) {
        previewCanvas.width = Math.round(window.innerWidth * dpr);
        previewCanvas.height = Math.round(window.innerHeight * dpr);
    }
    if (cornerCanvas) {
        const cw = Math.round(CORNER_WIDTH_CSS * dpr);
        cornerCanvas.width = cw;
        cornerCanvas.height = Math.round((cw * window.innerHeight) / window.innerWidth);
    }
}
sizePreviewCanvases();
window.addEventListener("resize", sizePreviewCanvases);

function showBanner(msg: string): void {
    if (!banner) return;
    banner.textContent = msg;
    banner.classList.remove("hidden");
}
function hideBanner(): void {
    banner?.classList.add("hidden");
}

// ---- view-mode controller (§0.7): scene <-> AR via parting curtains ---------
const viewMode = new ViewModeController(ctx.scene, () => video);

// ---- input source (best-effort; NEVER blocks rendering) --------------------
// The render loop starts immediately on the empty scene. The input source — live
// camera or mock — initializes asynchronously; until ready, the store holds the
// last (empty) frame and the loop renders the empty world.
let source: InputSource | null = null;
let video: HTMLVideoElement | null = null;

// ---- auto quality fallback (§11.2) + tracking failure handling (§3.6) -------
let degradedSingleHand = false;     // §11.2 fallback latched on (drop to single hand)
let liveConfidenceGating = false;   // §3.6 low-confidence brush freeze (live source only)
const snapshots = new SnapshotPlayer(); // §13.2 safety-mode scene restore

// Fire once when FPS/confidence stay low: single-hand, heavier smoothing, quiet HUD note
// (webcam is already 720p per §11.1, so no resolution change). Latched in QualityGuard.
function onQualityDrop(): void {
    degradedSingleHand = true;
    if (source instanceof LiveInputSource) source.applyQualityFallback();
    chrome.setNote("performance mode · single hand · extra smoothing");
}
const quality = new QualityGuard(onQualityDrop);

// §3.6 no-hands hold: keep the last pose for ~150ms, then fade the skeleton — never snap.
const HOLD_MS = 150;
const FREEZE_CONF = 0.5;
let heldFrame: PoseFrame | null = null;
let msSinceHands = 0;

// Best tracking confidence among present hands, or null when no hand is in frame (an
// empty frame is §3.6 territory, not a §11.2 low-confidence quality drop).
function confidenceOf(left: HandPose | null, right: HandPose | null): number | null {
    if (!left && !right) return null;
    return Math.max(left ? left.confidence : 0, right ? right.confidence : 0);
}

async function initInput(): Promise<void> {
    try {
        if (IS_MOCK) {
            source = new MockInputSource();
            await source.init();
            hideBanner();
            return;
        }
        video = await startWebcam();
        source = new LiveInputSource(video);
        await source.init();
        liveConfidenceGating = true; // §3.6 freeze applies only to real (noisy) tracking
        hideBanner();
    } catch (err) {
        const e = err as Error;
        showBanner(
            `camera unavailable: ${e?.message ?? err} — append ?mock=1 for mouse/keyboard, or use the window.DAEDALUS API`,
        );
    }
}

// ---- carousel navigation (nav / Left hand) ---------------------------------
// Reused scratch — zero per-frame allocation in the carousel-drive path.
const navTipWorld = new THREE.Vector3();
const navTipLocal = new THREE.Vector3();
const navGate = new GestureDebouncer();   // debounce nav-hand discrete poses (§12)
let navPrevLm: HandPose["landmarks"] | null = null; // prev nav landmarks for flick vx
let navGestureName = "none";              // last committed nav gesture (for the dev overlay)

function driveCarousel(nav: HandPose | null, dtSeconds: number): void {
    if (!nav) {
        navPrevLm = null;
        navGestureName = "none";
        // Still advance the carousel's own animation (fade/close) with a null gesture.
        carousel.update(navTipLocal, { name: "none", extended: 0, pinch: 0, spread: 0, vx: 0 }, dtSeconds);
        return;
    }

    const g = classify(nav.landmarks, nav.world, navPrevLm);
    navPrevLm = nav.landmarks;
    const committed = navGate.push(g.name);
    navGestureName = committed;

    // Finger gun opens the wheel. Opening tears down the active menu/panel (§4.2) so a
    // panel and the wheel are never on screen together.
    if (committed === "gun" && !carousel.isOpen) {
        carousel.open(navTipLocal);
        router.select(ctx, null);
        sfx.hum();
    }
    // Fist dismisses the wheel with no selection.
    if (committed === "fist" && carousel.isOpen) {
        carousel.close();
    }

    // Aim: nav index fingertip -> world -> camera-local (carousel is camera-parented).
    fingertipToWorld(
        nav.landmarks[INDEX_TIP],
        ctx.camera,
        ctx.interactionPlaneZ,
        ctx.scratch.ray,
        ctx.scratch.plane,
        navTipWorld,
    );
    ctx.camera.worldToLocal(navTipLocal.copy(navTipWorld));

    carousel.update(navTipLocal, g, dtSeconds);
}

// ---- role assignment (§3.2; ?singlehand collapses both roles onto one hand) -
const NAV_LABEL: Handedness = "Left";
const EXEC_LABEL: Handedness = "Right";

// Single-hand when forced by ?singlehand=1 OR latched by the §11.2 quality fallback.
function singleHand(): boolean {
    return SINGLE_HAND || degradedSingleHand;
}
function navHand(frame: PoseFrame): HandPose | null {
    if (singleHand()) return frame.Right ?? frame.Left;
    return frame[NAV_LABEL];
}
function execHand(frame: PoseFrame): HandPose | null {
    const h = singleHand() ? (frame.Right ?? frame.Left) : frame[EXEC_LABEL];
    // §3.6: a low-confidence live hand freezes brush engagement (never sculpt on noise).
    if (liveConfidenceGating && h && h.confidence < FREEZE_CONF) return null;
    return h;
}

// ---- director milestones pulled from observable ctx (§13) -------------------
// The Director never moves backward; we feed it the observable signals each frame.
let meshSeen = false;
let decoratedFired = false;

function syncDirector(): void {
    // ADD SHAPES created the first mesh: EMPTY -> SPHERE.
    if (!meshSeen && ctx.mesh !== null) {
        meshSeen = true;
        director.onShapeAdded();
    } else if (meshSeen && ctx.mesh === null) {
        // World was cleared back to empty (e.g. a fresh spawn replaced nothing yet).
        meshSeen = false;
    }
    // MORPH progress: SPHERE -> DONUT once the donut blend completes (t > 0.95).
    director.onMorph(ctx.morphT);
    // DECORATE applied icing/sprinkles: -> DECORATED. Modules write ctx.stage when the
    // decoration fires; the active DECORATE tool also counts.
    if (!decoratedFired && (ctx.stage === "DECORATED" || router.activeId === MenuId.DECORATE)) {
        decoratedFired = true;
        director.onDecorated();
    }
    // The Director is the authority on the displayed stage; sync it back into ctx so the
    // HUD and any observer read a single consistent value.
    ctx.stage = director.stage;
    ctx.viewMode = viewMode.mode;
}

// ---- master loop -----------------------------------------------------------
let injected: PoseFrame | null = null; // window.DAEDALUS pose injection (headless)

startLoop((dtMs) => {
    chrome.begin();
    const dtSeconds = dtMs / 1000;

    // 1) Latest pose: injected (debug) wins, else live pump, else last stored frame.
    let frame: PoseFrame;
    if (injected) {
        frame = injected;
    } else if (source && source.ready) {
        frame = source.pump(dtMs);
        store.set(frame);
    } else {
        frame = store.get() ?? EMPTY_FRAME;
    }

    // §11.2 quality sample reads the LIVE detection (before the §3.6 hold) so a genuine
    // no-hands gap counts as "no tracking", not "low confidence".
    const liveConf = confidenceOf(frame.Left, frame.Right);

    // §3.6 no-hands hold: hold the last good pose ~150ms (fading the skeleton), then drop
    // to empty — so a brief tracking dropout never snaps the pose/brush off.
    let skeletonAlpha = 1;
    if (frame.Left !== null || frame.Right !== null) {
        heldFrame = frame;
        msSinceHands = 0;
    } else {
        msSinceHands += dtMs;
        if (heldFrame && msSinceHands <= HOLD_MS) {
            frame = heldFrame;
            skeletonAlpha = 1 - msSinceHands / HOLD_MS;
        } else {
            heldFrame = null;
        }
    }

    const nav = navHand(frame);
    const exec = execHand(frame);

    // 2) View-mode toggle (§0.7): parting curtains. Uses the true Left/Right hands
    //    (bilateral gesture) regardless of single-hand role collapsing.
    viewMode.detectPartingCurtains(frame.Left, frame.Right, dtMs);
    viewMode.update(dtMs);

    // 3) Nav hand drives the carousel + selection; exec hand drives the active menu.
    driveCarousel(nav, dtSeconds);
    router.update(ctx, exec, nav, dtMs);

    // 4) Director milestones from observable ctx, then sync the displayed stage.
    syncDirector();

    // 4b) Idle auto-spin (§9.6): rotate the object only when the user is NOT focused on it
    //     — no tool active, the carousel closed, and no hand in frame — and ease it to a
    //     stop the instant any of those engages. Rotates the mesh, never the camera (§9.6).
    const objectFocused = router.activeId !== null || carousel.isOpen || frame.Left !== null || frame.Right !== null;
    autoRotate.update(ctx.mesh, !objectFocused, dtMs);

    // 5) Render: fullscreen webcam + skeleton behind the transparent model (AR),
    //    a clean model-on-black mirror in the corner, then the HUD (NEVER css3d).
    composer.render();
    // Corner mirror: black backdrop, then copy the (transparent) model canvas over it
    // so the corner reads as the old big-screen model-on-black view.
    if (cornerCtx && cornerCanvas) {
        cornerCtx.fillStyle = "#000";
        cornerCtx.fillRect(0, 0, cornerCanvas.width, cornerCanvas.height);
        cornerCtx.drawImage(ctx.renderer.domElement, 0, 0, cornerCanvas.width, cornerCanvas.height);
    }
    // §0.7: AR mode shows the live webcam + (held/faded) skeleton; scene mode is pure
    // #000814 with no camera feed — the model floats on the dark studio backdrop.
    if (previewCtx && previewCanvas) {
        if (viewMode.mode === "ar" && video) {
            drawOverlay(previewCtx, video, frame.Left, frame.Right, skeletonAlpha);
        } else {
            previewCtx.fillStyle = "#000814"; // §14.1 bg
            previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
        }
    }

    // §11.2 auto quality fallback: watch FPS + tracking confidence; degrade once if low.
    const fps = dtMs > 0 ? 1000 / dtMs : 0;
    quality.sample(fps, liveConf);

    chrome.update({ stage: director.stage, activeMenu: router.activeId, viewMode: viewMode.mode });
    devOverlay.update({
        frame,
        gesture: navGestureName,
        tool: router.activeId,
        morphT: ctx.morphT,
        brush: ctx.brushRadius,
        fps,
    });

    chrome.end();
});

// ---- ?tool=MORPH — start in a specific tool (§10.3) ------------------------
function selectByName(name: string | null): void {
    if (name === null) {
        router.select(ctx, null);
        return;
    }
    const key = name.toUpperCase() as keyof typeof MenuId;
    const id = MenuId[key];
    if (id) router.select(ctx, id);
}
if (PARAM_TOOL) selectByName(PARAM_TOOL);

// ---- keyboard fallbacks (stage safety + quick tool select) -----------------
addEventListener("keydown", (e) => {
    // §13: safety mode — advance one authored stage and rebuild the real scene to it.
    if (e.key === " ") { director.advanceSafety(); snapshots.apply(ctx, director.stage); return; }
    if (e.key === "Escape") { router.select(ctx, null); return; }
    // §10.2 brush radius (keyboard parity with the mock [ ] keys).
    if (e.key === "[") { nudgeBrushRadius(-1); return; }
    if (e.key === "]") { nudgeBrushRadius(1); return; }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= MENU_ORDER.length) {
        router.select(ctx, MENU_ORDER[n - 1]);
    }
});

// Unlock the WebAudio context on the first user gesture (no autoplay errors).
addEventListener("pointerdown", () => sfx.resume(), { once: true });

// ---- window.DAEDALUS debug API (drives every beat headlessly) --------------
function setMorphT(t: number): void {
    const v = Math.min(1, Math.max(0, t));
    ctx.morphT = v;
    if (ctx.mesh && ctx.mesh.morphTargetInfluences && ctx.mesh.morphTargetInfluences.length > 0) {
        ctx.mesh.morphTargetInfluences[0] = v;
    }
    director.onMorph(v);
}

// §10.2 [ / ] brush radius. ctx.brushRadius is a multiplier (1 = default) read by the
// MORPH additive brush and the DECORATE smear. Stepped + clamped; driven by the mock
// input and the keyboard.
const BRUSH_MIN = 0.3;
const BRUSH_MAX = 3.0;
const BRUSH_STEP = 0.15;
function nudgeBrushRadius(dir: number): void {
    const next = ctx.brushRadius + Math.sign(dir) * BRUSH_STEP;
    ctx.brushRadius = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, next));
}

interface DaedalusDebug {
    ctx: SceneContext;
    director: Director;
    router: MenuRouter;
    carousel: Carousel;
    viewMode: ViewModeController;
    selectMenu(id: keyof typeof MenuId | string | null): void;
    setMorphT(t: number): void;
    nudgeBrushRadius(dir: number): void;
    injectPose(frame: PoseFrame | null): void;
    clearPose(): void;
    toggleView(): void;
    advance(): void;
    handScaleOf(pose: HandPose): number;
    MenuId: typeof MenuId;
}

const debug: DaedalusDebug = {
    ctx,
    director,
    router,
    carousel,
    viewMode,
    selectMenu(id) {
        selectByName(id === null ? null : String(id));
    },
    setMorphT,
    nudgeBrushRadius,
    injectPose(frame) { injected = frame; },
    clearPose() { injected = null; },
    toggleView() { viewMode.toggle(); },
    advance() { director.advanceSafety(); snapshots.apply(ctx, director.stage); },
    handScaleOf(pose) { return handScale(pose.world); },
    MenuId,
};
(window as unknown as { DAEDALUS: DaedalusDebug }).DAEDALUS = debug;

// Kick off input acquisition without blocking the already-running render loop.
void initInput();

// Surface unexpected runtime errors on the banner instead of failing silently.
addEventListener("error", (e) => showBanner(`error: ${e.message}`));
