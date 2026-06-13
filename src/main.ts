// DAEDALUS bootstrap (P3). Wires the whole pipeline:
//   webcam -> HandLandmarker (One Euro) -> PoseStore -> gesture/menu state machine
//   (nav hand drives the radial ring + router.select; exec hand drives the active
//   menu) -> scene + post composer + CSS3D chat layer + webcam overlay -> HUD.
//
// Rendering starts immediately so the sphere is visible in <3s even before the
// camera resolves; tracking attaches when ready. A window.DAEDALUS debug API drives
// every demo beat without a camera (used for headless verification + the safety mode).
import "./styles.css";
import * as THREE from "three";

import { startWebcam } from "./capture/webcam";
import { HandLandmarkerEngine } from "./tracking/handLandmarker";
import { Calibration, profileToOneEuroParams, type RitualFrame } from "./tracking/calibration";
import { classify, pinchAmount, handScale } from "./gesture/predicates";
import { PoseStore } from "./core/store";
import { startLoop } from "./core/loop";
import { Director } from "./core/director";
import { makeContext } from "./render/scene";
import { makeComposer } from "./render/post";
import { drawOverlay } from "./render/overlay";
import { Chrome } from "./ui/chrome";
import { CalibrationUI } from "./ui/calibrationUI";
import { MenuRouter } from "./menu/menuRouter";
import { RadialRing } from "./menu/radialRing";
import { fingertipToWorld } from "./math/coords";
import { MenuId, MENU_ORDER, type Handedness, type HandPose, type PoseFrame } from "./types";

import { createTranslateMenu } from "./menu/translate";
import { createDilateMenu } from "./menu/dilate";
import { createRotateMenu } from "./menu/rotate";
import { createMorphMenu } from "./menu/morph";
import { createAddShapesMenu } from "./menu/addShapes";
import { createInteractMenu } from "./menu/interact";
import { createDestroyMenu } from "./menu/destroy";
import { createDecorateMenu } from "./decorate/chatPanel";

const EMPTY_FRAME: PoseFrame = { Left: null, Right: null, count: 0, tMs: 0 };

// ---- core singletons -------------------------------------------------------
const ctx = makeContext();
const director = new Director("guided");
const store = new PoseStore();
const router = new MenuRouter();
const ring = new RadialRing();
ctx.scene.add(ring.object);
const { composer } = makeComposer(ctx.renderer, ctx.scene, ctx.camera);
const chrome = new Chrome();

// register all 8 menus (router is a registry; it never imports them itself)
router.register(createAddShapesMenu());
router.register(createTranslateMenu());
router.register(createDilateMenu());
router.register(createRotateMenu());
router.register(createInteractMenu());
router.register(createMorphMenu());
router.register(createDecorateMenu());
router.register(createDestroyMenu());

// ---- preview canvas / overlay ----------------------------------------------
const previewCanvas = document.getElementById("preview") as HTMLCanvasElement | null;
const previewCtx = previewCanvas ? previewCanvas.getContext("2d") : null;
const banner = document.getElementById("banner");

function showBanner(msg: string): void {
    if (!banner) return;
    banner.textContent = msg;
    banner.classList.remove("hidden");
}
function hideBanner(): void {
    banner?.classList.add("hidden");
}

// ---- tracking (best-effort; never blocks rendering) ------------------------
let landmarker: HandLandmarkerEngine | null = null;
let video: HTMLVideoElement | null = null;

async function initTracking(): Promise<void> {
    if (!previewCanvas) return;
    try {
        video = await startWebcam();
        landmarker = new HandLandmarkerEngine(previewCanvas, video);
        await landmarker.init();
        hideBanner();
    } catch (err) {
        const e = err as Error;
        showBanner(`camera unavailable: ${e?.message ?? err} — keyboard + DAEDALUS debug still work`);
    }
}

// ---- calibration ritual (skippable; non-blocking render behind it) ---------
const calibration = new Calibration();
let calibrationActive = true;
const calUI = new CalibrationUI(calibration, {
    onComplete: applyProfile,
    onSkip: applyProfile,
});

function applyProfile(): void {
    ctx.calibration = calibration.profile;
    calibrationActive = false;
    if (landmarker) {
        const { minCutoff, beta } = profileToOneEuroParams(calibration.profile);
        landmarker.setFilterParams(minCutoff, beta);
    }
}

// dev/demo affordance: "?nocal" skips the calibration ritual straight to the scene.
if (new URLSearchParams(location.search).has("nocal")) {
    calibration.skip();
    applyProfile();
    calUI.close();
}

// Build a coarse RitualFrame from the nav hand so the ritual can advance when a
// hand is held up. Per-step pose discrimination is intentionally light — the Skip
// button (DEFAULT_CALIBRATION) is the primary path; this is the "real hand" path.
function ritualFrameFrom(nav: HandPose | null): RitualFrame {
    if (!nav) {
        return { poseHeld: false, restValue: 0, pinchFraction: 0.9, depthZ: 0, velocity: 0, handScaleMeters: 0.09 };
    }
    const s = handScale(nav.landmarks);
    const pinch_frac = Math.hypot(nav.landmarks[4].x - nav.landmarks[8].x, nav.landmarks[4].y - nav.landmarks[8].y) / s;
    return {
        poseHeld: true,
        restValue: nav.landmarks[8].x,
        pinchFraction: pinch_frac,
        depthZ: nav.world[8]?.z ?? 0,
        velocity: 0,
        handScaleMeters: nav.handScale,
    };
}

// ---- radial-ring navigation (nav hand) -------------------------------------
const navTip = new THREE.Vector3();
const navMcp = new THREE.Vector3();
const navAim = new THREE.Vector3();
const navRay = new THREE.Ray();
const navPlane = new THREE.Plane();

function driveNav(nav: HandPose | null): void {
    if (!nav) return;
    const g = classify(nav.landmarks);
    fingertipToWorld(nav.landmarks[8], ctx.camera, ctx.interactionPlaneZ, navRay, navPlane, navTip);
    fingertipToWorld(nav.landmarks[5], ctx.camera, ctx.interactionPlaneZ, navRay, navPlane, navMcp);
    navAim.subVectors(navTip, navMcp).normalize();

    if (g.name === "gun" && !ring.isOpen) ring.open(navTip);
    if (g.name === "fist" && ring.isOpen) ring.close();

    if (ring.isOpen) {
        ring.update(navTip, navAim, ctx.camera);
        const picked = ring.pickOnPinch(g.pinch);
        if (picked) {
            router.select(ctx, picked);
            ring.close();
        }
    }
}

// ---- per-frame update ------------------------------------------------------
let injected: PoseFrame | null = null;

function navLabel(): Handedness {
    return ctx.calibration.handedness;
}
function execLabel(): Handedness {
    return navLabel() === "Left" ? "Right" : "Left";
}

startLoop((dt) => {
    chrome.begin();

    // 1) latest pose: injected (debug) wins, else live inference, else last stored
    let frame: PoseFrame;
    if (injected) {
        frame = injected;
    } else if (landmarker && landmarker.ready) {
        frame = landmarker.pump(dt);
        store.set(frame);
    } else {
        frame = store.get() ?? EMPTY_FRAME;
    }

    const nav = frame[navLabel()];
    const exec = frame[execLabel()];

    // 2) calibration first; the scene renders behind the overlay
    if (calibrationActive && !calibration.done) {
        calibration.update(ritualFrameFrom(nav));
        calUI.update();
    } else {
        // 3) nav hand drives the ring + selection; exec hand drives the active menu
        driveNav(nav);
        router.update(ctx, exec, nav, dt);
    }

    // 4) director milestones + stage label
    director.onMorph(ctx.morphT);
    ctx.stage = director.stage;

    // 5) render: composited scene + CSS3D chat layer + webcam overlay + HUD
    composer.render();
    ctx.css3d.render(ctx.scene, ctx.camera);
    if (previewCtx && video) drawOverlay(previewCtx, video, frame.Left, frame.Right);
    chrome.update({ stage: director.stage, activeMenu: router.activeId });

    chrome.end();
});

// ---- keyboard fallbacks (stage safety + quick menu select) -----------------
addEventListener("keydown", (e) => {
    if (e.key === " ") { director.advanceManual(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= 8) router.select(ctx, MENU_ORDER[n - 1]);
    if (e.key === "Escape") router.select(ctx, null);
});

// ---- window.DAEDALUS debug API (drives every beat without a camera) ---------
function setMorphT(t: number): void {
    const v = Math.min(1, Math.max(0, t));
    ctx.morphT = v;
    if (ctx.mesh.morphTargetInfluences) ctx.mesh.morphTargetInfluences[0] = v;
    director.onMorph(v);
}

interface DaedalusDebug {
    ctx: typeof ctx;
    director: Director;
    router: MenuRouter;
    ring: RadialRing;
    selectMenu(id: keyof typeof MenuId | null): void;
    setMorphT(t: number): void;
    injectPose(frame: PoseFrame | null): void;
    clearPose(): void;
    skipCalibration(): void;
    advance(): void;
    MenuId: typeof MenuId;
}

const debug: DaedalusDebug = {
    ctx,
    director,
    router,
    ring,
    selectMenu(id) {
        router.select(ctx, id === null ? null : MenuId[id]);
    },
    setMorphT,
    injectPose(frame) { injected = frame; },
    clearPose() { injected = null; },
    skipCalibration() { calibration.skip(); applyProfile(); calUI.close(); },
    advance() { director.advanceManual(); },
    MenuId,
};
(window as unknown as { DAEDALUS: DaedalusDebug }).DAEDALUS = debug;

// kick off tracking without blocking the already-running render loop
void initTracking();

// surface unexpected runtime errors on the banner instead of failing silently
addEventListener("error", (e) => showBanner(`error: ${e.message}`));
