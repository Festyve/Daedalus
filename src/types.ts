import type * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import type { CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";

// ---------- Tracking ----------
export interface Landmark { x: number; y: number; z: number; } // normalized mirrored image space
export interface WorldLandmark { x: number; y: number; z: number; } // MediaPipe metric, wrist origin
export type Handedness = "Left" | "Right";

export interface HandPose {
    handedness: Handedness;
    landmarks: Landmark[];   // 21, One-Euro-filtered, image space
    world: WorldLandmark[];  // 21, filtered, metric
    confidence: number;
    handScale: number;       // S = ||wrist(0) - middleMCP(9)|| in world landmarks (§0.6.2)
}

export interface PoseFrame {
    Left: HandPose | null;
    Right: HandPose | null;
    count: number;
    tMs: number;
}

// ---------- Calibration (§0.6.3) ----------
export interface CalibrationProfile {
    handScaleMeters: number;
    restingJitter: number;
    peakVelocity: number;
    pinchClosed: number;   // fraction of S at full pinch
    pinchOpen: number;     // fraction of S at rest
    depthNear: number;
    depthFar: number;
    responsiveness: number; // 0..1 master sensitivity
    handedness: Handedness; // which hand navigates menus
}

// §0.6.4 skip-calibration defaults
export const DEFAULT_CALIBRATION: CalibrationProfile = {
    handScaleMeters: 0.09,
    restingJitter: 0.0025,
    peakVelocity: 2.0,
    pinchClosed: 0.30,
    pinchOpen: 0.9,
    depthNear: -0.1,
    depthFar: 0.2,
    responsiveness: 0.6,
    handedness: "Left",
};

// ---------- Gesture ----------
export type GestureName =
    | "none" | "fist" | "open" | "point" | "pinch" | "gun" | "peace" | "other";
export interface GestureState {
    name: GestureName;
    extended: number;   // count of extended non-thumb fingers
    pinch: number;      // 0..1 closure (1 = fully pinched)
    spread: number;     // 0..1 normalized fingertip spread (drives squish -> t)
}

// ---------- Menus ----------
export enum MenuId {
    ADD_SHAPES = "ADD_SHAPES",
    TRANSLATE = "TRANSLATE",
    DILATE = "DILATE",
    ROTATE = "ROTATE",
    INTERACT = "INTERACT",
    MORPH = "MORPH",
    DECORATE = "DECORATE",
    DESTROY = "DESTROY",
}
export const MENU_ORDER: MenuId[] = [
    MenuId.ADD_SHAPES, MenuId.TRANSLATE, MenuId.DILATE, MenuId.ROTATE,
    MenuId.INTERACT, MenuId.MORPH, MenuId.DECORATE, MenuId.DESTROY,
];

// ---------- Sculpt ----------
export enum BrushVerb { Grab, Inflate, Draw, Flatten, Pinch, Crease, Smooth }

// ---------- Decorate (§9.2.2, §9.3) ----------
export interface SprinkleDesign {
    geometry: "capsule" | "star";
    palette: string[];
    length: number; radius: number; sizeJitter: number;
    orientation: "random" | "normal";
}
export interface IcingDesign {
    color: string; gloss: number;
    dripStyle: "smooth" | "thick"; edgeNoise: number; sugarDusting: boolean;
}
export interface GlazeDesign { color: string; shimmer: number; }

export type DecorationAction =
    | { type: "apply_icing"; design: IcingDesign; region?: "top" | "all" | "drip" }
    | { type: "add_sprinkles"; design: SprinkleDesign }
    | { type: "add_glaze"; design: GlazeDesign }
    | { type: "clear" };

export interface ChatTurn {
    role: "user" | "ai";
    text: string;
    action?: DecorationAction;
    delay: number; // ms after previous turn
}

// ---------- Director (§14) ----------
export type DirectorMode = "guided" | "assist" | "safety" | "freeplay";
export type Stage = "SPHERE" | "DONUT" | "DECORATED" | "CONSUMED";

// ---------- Shared scratch math: reused objects, zero per-frame alloc (§12.2) ----------
export interface ScratchMath {
    v1: THREE.Vector3; v2: THREE.Vector3; v3: THREE.Vector3;
    m1: THREE.Matrix4; q1: THREE.Quaternion; plane: THREE.Plane;
    ray: THREE.Ray;
}

// ---------- SceneContext: the single shared-state channel (§3.2, §6) ----------
export interface SceneContext {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    css3d: CSS3DRenderer;      // DOM layer for the AI chat panel (§9, §11.5)
    mesh: THREE.Mesh;          // the active sculptable object
    bvh: MeshBVH | null;       // built on mesh.geometry position
    extraMeshes: THREE.Mesh[]; // spawned shapes (ADD/INTERACT)
    calibration: CalibrationProfile;
    morphT: number;            // current donut blend 0..1
    stage: Stage;
    activeMenu: MenuId | null;
    scratch: ScratchMath;      // reused objects (§12.2)
    interactionPlaneZ: number; // object depth for unprojection (§13.2)
}

// ---------- MenuModule contract: every menu honors this ----------
export interface MenuModule {
    id: MenuId;
    enter(ctx: SceneContext): void;
    update(ctx: SceneContext, right: HandPose | null, left: HandPose | null, dt: number): void;
    exit(ctx: SceneContext): void;
}
