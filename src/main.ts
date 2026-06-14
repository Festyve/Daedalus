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
// the observable ctx (mesh added -> SPHERE, morphT -> TORUS, decorated -> DECORATED).
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

import { makeContext } from "./render/scene";
import { makeComposer, SCENE_BLOOM_STRENGTH } from "./render/post";
import { drawSkeletons } from "./render/overlay";
import { ViewModeController } from "./render/viewMode";

import { Carousel } from "./menu/carousel";
import { MenuRouter } from "./menu/menuRouter";
import { createAddShapesMenu } from "./menu/addShapes";
import { createSelectMenu } from "./menu/select";
import { createTranslateMenu } from "./menu/translate";
import { createDilateMenu } from "./menu/dilate";
import { createRotateMenu } from "./menu/rotate";
import { createMorphMenu } from "./menu/morph";
import { createDecorateMenu } from "./decorate/chatPanel";
import { createInteractMenu } from "./menu/interaction";
import { createDestroyMenu } from "./menu/destroy";

import { classify, GestureDebouncer } from "./gesture/detect";
import { handScale } from "./gesture/predicates";
import { selectedCount } from "./core/shapes";
import { eligibleTools } from "./render/tokens";

import { Chrome } from "./ui/chrome";
import { DevOverlay } from "./ui/devOverlay";
import { InstructionsPopout } from "./ui/instructionsPopout";

import { sfx } from "./audio/sfx";

import { fingertipToWorld } from "./math/coords";
import { MenuId, MENU_ORDER } from "./types";
import type { Handedness, HandPose, InputSource, PoseFrame, SceneContext, GestureState } from "./types";

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
router.register(createSelectMenu());
router.register(createTranslateMenu());
router.register(createDilateMenu());
router.register(createRotateMenu());
router.register(createMorphMenu());
router.register(createDecorateMenu());
router.register(createInteractMenu());
router.register(createDestroyMenu());

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
    router.select(ctx, id as MenuId);
};

// Post-processing composer (§9.4). composer.render() runs every frame — NEVER css3d.
const { composer, setBloom } = makeComposer(ctx.renderer, ctx.scene, ctx.camera);

// HUD chrome (§14.3) + the always-on ❓ gesture guide (§4.4) + the mock dev overlay.
const chrome = new Chrome();
const instructions = new InstructionsPopout();
instructions.mount();
const devOverlay = new DevOverlay(IS_MOCK || PARAM_FPS);

// ---- skeleton overlay canvas / banner --------------------------------------
// Full-screen transparent 2D canvas above the webgl canvas. The webcam now backs the
// MAIN scene (un-mirrored), so the green skeletons drawn here land directly on the user's
// real hands in the feed. Sized in CSS pixels (landmarks are normalized) and kept in
// sync with the window.
const overlayCanvas = document.getElementById("overlay") as HTMLCanvasElement | null;
const overlayCtx = overlayCanvas ? overlayCanvas.getContext("2d") : null;
function sizeOverlay(): void {
    if (!overlayCanvas) return;
    overlayCanvas.width = window.innerWidth;
    overlayCanvas.height = window.innerHeight;
}
sizeOverlay();
window.addEventListener("resize", sizeOverlay);

const banner = document.getElementById("banner");

function showBanner(msg: string): void {
    if (!banner) return;
    banner.textContent = msg;
    banner.classList.remove("hidden");
}
function hideBanner(): void {
    banner?.classList.add("hidden");
}

// ---- input source handles (declared before the view-mode controller, whose constructor's
//      getVideo() closure reads `video` immediately — keep them out of the TDZ). ----------
// The render loop starts immediately on the empty scene. The input source — live camera or
// mock — initializes asynchronously; until ready, the store holds the last (empty) frame.
let source: InputSource | null = null;
let video: HTMLVideoElement | null = null;

// ---- view-mode controller (§0.7): scene <-> AR via parting curtains ---------
// The webcam feed is a DOM <video> (#camera) BEHIND a transparent canvas; the controller
// flips the canvas clear between transparent (AR, feed shows through) and opaque #000814
// (scene) and shows/hides the video.
const viewMode = new ViewModeController(ctx.scene, ctx.camera, ctx.renderer, () => video);

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
        hideBanner();
    } catch (err) {
        const e = err as Error;
        showBanner(
            `camera unavailable: ${e?.message ?? err} — append ?mock=1 for mouse/keyboard, or use the window.DAEDALUS API`,
        );
    }
}

// ---- carousel navigation (both hands) ---------------------------------
// Reused scratch — zero per-frame allocation in the carousel-drive path.
const navTipWorld = new THREE.Vector3();
const navTipLocal = new THREE.Vector3();
const execGate = new GestureDebouncer();  // debounce exec-hand discrete poses
let execPrevLm: HandPose["landmarks"] | null = null; // prev exec landmarks for gesture classify
let execGestureName = "none";              // last committed exec gesture (for the dev overlay)
let gunWasActive = false;                  // rising-edge tracker for gun toggle

function driveCarousel(exec: HandPose | null, nav: HandPose | null, dtSeconds: number): void {
    const NONE_GESTURE = { name: "none" as const, extended: 0, pinch: 0, spread: 0, vx: 0 };

    // Classify right-hand (exec) gesture for toggle.
    let execG: GestureState = NONE_GESTURE;
    if (exec) {
        execG = classify(exec.landmarks, exec.world, execPrevLm);
        execPrevLm = exec.landmarks;
        const committed = execGate.push(execG.name);
        execGestureName = committed;

        // Right-hand gun toggles on rising edge only (new gun pose, not held).
        const gunNow = committed === "gun";
        if (gunNow && !gunWasActive) {
            if (router.activeId !== null) {
                // In a sub-menu: gun returns to main menu
                router.select(ctx, null);
                carousel.open(navTipLocal, eligibleTools(selectedCount(ctx)));
                sfx.hum();
            } else if (carousel.isOpen) {
                // Main carousel is open: gun closes it
                carousel.close();
            } else {
                // No menu showing: gun opens main carousel
                carousel.open(navTipLocal, eligibleTools(selectedCount(ctx)));
                sfx.hum();
            }
        }
        gunWasActive = gunNow;
    } else {
        execGestureName = "none";
        execPrevLm = null;
        gunWasActive = false;
    }

    // Left-hand (nav) gesture is used for aiming the carousel glow.
    // (Selection/advance are now driven by right hand through carousel.update())
    if (nav) {
        const navG = classify(nav.landmarks, nav.world, null);
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
    }

    // Drive carousel with right-hand (advance) and left-hand (select) gestures.
    carousel.update(navTipLocal, execG, nav ? classify(nav.landmarks, nav.world, null) : NONE_GESTURE, dtSeconds);
}

// ---- role assignment (§3.2; ?singlehand collapses both roles onto one hand) -
const NAV_LABEL: Handedness = "Left";
const EXEC_LABEL: Handedness = "Right";

function navHand(frame: PoseFrame): HandPose | null {
    if (SINGLE_HAND) return frame.Right ?? frame.Left;
    return frame[NAV_LABEL];
}
function execHand(frame: PoseFrame): HandPose | null {
    if (SINGLE_HAND) return frame.Right ?? frame.Left;
    return frame[EXEC_LABEL];
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
    // MORPH progress: SPHERE -> TORUS once the torus blend completes (t > 0.95).
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

    const nav = navHand(frame);
    const exec = execHand(frame);

    // 2) View-mode toggle (§0.7): parting curtains. Uses the true Left/Right hands
    //    (bilateral gesture) regardless of single-hand role collapsing.
    viewMode.detectPartingCurtains(frame.Left, frame.Right, dtMs);
    viewMode.update(dtMs);

    // 3) Exec hand drives carousel toggle/advance; nav hand aims glow; active menu driven by router.
    driveCarousel(exec, nav, dtSeconds);
    router.update(ctx, exec, nav, dtMs);

    // 4) Director milestones from observable ctx, then sync the displayed stage.
    syncDirector();

    // 5) Render: the MAIN view (camera feed + composited objects, NEVER css3d), then a
    //    bottom-right black-scene preview (the same objects on #000814, camera bg hidden),
    //    then the green hand skeletons over the feed + HUD.
    //    Bloom only in SCENE mode: its blur forces alpha=1, which would veil the transparent
    //    camera-feed areas in AR mode (so AR keeps a clean alpha composite).
    setBloom(viewMode.mode === "scene" ? SCENE_BLOOM_STRENGTH : 0);
    composer.render();

    // Corner black-scene preview: re-render the objects on opaque #000814 into a scissored
    // bottom-right box of the MAIN webgl canvas (the camera feed is a DOM layer untouched by
    // this pass). setViewport/setScissor take CSS (logical) pixels — three.js applies the
    // renderer pixelRatio internally, so we must NOT pre-multiply by dpr. GL viewport origin
    // is BOTTOM-left, so vy = margin puts the box in the bottom-right corner (matching the
    // #preview-frame border).
    const W = window.innerWidth, H = window.innerHeight;
    const cw = Math.round(W * 0.22), ch = Math.round(cw * H / W);
    const margin = 16;
    const vx = W - cw - margin;
    const vy = margin;
    const r = ctx.renderer;
    r.setRenderTarget(null);
    r.setScissorTest(true);
    r.setViewport(vx, vy, cw, ch);
    r.setScissor(vx, vy, cw, ch);
    r.setClearColor(0x000814, 1);
    r.clear();
    r.render(ctx.scene, ctx.camera);
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    // Restore the MAIN-view clear for the next frame's composer.render(): transparent in AR
    // (so the #camera video shows through), opaque #000814 in scene mode. The preview pass
    // above left an opaque clear colour set, so this MUST run every frame.
    viewMode.syncClear();

    // Green hand skeletons over the MAIN feed (landmarks are un-mirrored, so they align).
    if (overlayCtx) drawSkeletons(overlayCtx, frame.Left, frame.Right);

    chrome.update({
        stage: director.stage,
        activeMenu: router.activeId,
        viewMode: viewMode.mode,
        selectedCount: selectedCount(ctx),
    });
    devOverlay.update({
        frame,
        gesture: execGestureName,
        tool: router.activeId,
        morphT: ctx.morphT,
        fps: dtMs > 0 ? 1000 / dtMs : 0,
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
    if (e.key === " ") { director.advanceSafety(); return; }
    if (e.key === "Escape") { router.select(ctx, null); return; }
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

interface DaedalusDebug {
    ctx: SceneContext;
    director: Director;
    router: MenuRouter;
    carousel: Carousel;
    viewMode: ViewModeController;
    selectMenu(id: keyof typeof MenuId | string | null): void;
    setMorphT(t: number): void;
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
    injectPose(frame) { injected = frame; },
    clearPose() { injected = null; },
    toggleView() { viewMode.toggle(); },
    advance() { director.advanceSafety(); },
    handScaleOf(pose) { return handScale(pose.world); },
    MenuId,
};
(window as unknown as { DAEDALUS: DaedalusDebug }).DAEDALUS = debug;

// Kick off input acquisition without blocking the already-running render loop.
void initInput();

// Surface unexpected runtime errors on the banner instead of failing silently.
addEventListener("error", (e) => showBanner(`error: ${e.message}`));
