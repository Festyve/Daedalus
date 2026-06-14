// Daedalus v5 shared contracts (SPEC §3.4, §5, §6, §8). Authoritative — all modules
// code against these types. World starts empty: ctx.mesh is null until ADD SHAPES.
import type * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";

// ---------- Tracking (§3) ----------
export interface Vec3 { x: number; y: number; z: number; }
export type Landmark = Vec3;       // normalized, mirrored image space
export type WorldLandmark = Vec3;  // MediaPipe metric (meters), wrist origin
export type Handedness = "Left" | "Right";

export interface HandPose {
    handedness: Handedness;
    landmarks: Vec3[];   // 21, One-Euro-filtered, image space
    world: Vec3[];       // 21, filtered, metric
    confidence: number;
    handScale: number;   // S = ||wrist(0) - middleMCP(9)|| in world landmarks (§3.5)
    timestamp: number;
}

export interface PoseFrame {
    Left: HandPose | null;
    Right: HandPose | null;
    count: number;
    tMs: number;
    source: "live" | "mock";
}

// ---------- Input abstraction (§3.4) ----------
export interface InputSource {
    init(): Promise<void>;
    /** Pump the latest frame given dt (ms). Non-blocking; last-write-wins. */
    pump(dtMs: number): PoseFrame;
    readonly ready: boolean;
    dispose(): void;
}

// ---------- Gesture (§12) ----------
export type GestureName = "none" | "fist" | "open" | "point" | "pinch" | "gun" | "flick";
export interface GestureState {
    name: GestureName;
    extended: number;   // count of extended non-thumb fingers
    pinch: number;      // 0..1 closure (1 = fully pinched)
    spread: number;     // 0..1 normalized fingertip spread
    vx: number;         // index-tip horizontal velocity, units of S per frame
}

// ---------- Menus (§5) — tools ----------
export enum MenuId {
    ADD_SHAPES = "ADD_SHAPES",
    SELECT = "SELECT",
    TRANSLATE = "TRANSLATE",
    DILATE = "DILATE",
    ROTATE = "ROTATE",
    MORPH = "MORPH",
    DECORATE = "DECORATE",
    INTERACT = "INTERACT",
    DESTROY = "DESTROY",
}
export const MENU_ORDER: MenuId[] = [
    MenuId.ADD_SHAPES, MenuId.SELECT, MenuId.TRANSLATE, MenuId.DILATE,
    MenuId.ROTATE, MenuId.MORPH, MenuId.DECORATE, MenuId.INTERACT, MenuId.DESTROY,
];
export const MENU_LABEL: Record<MenuId, string> = {
    [MenuId.ADD_SHAPES]: "ADD SHAPES",
    [MenuId.SELECT]: "SELECT",
    [MenuId.TRANSLATE]: "TRANSLATE",
    [MenuId.DILATE]: "DILATE",
    [MenuId.ROTATE]: "ROTATE",
    [MenuId.MORPH]: "MORPH",
    [MenuId.DECORATE]: "DECORATE",
    [MenuId.INTERACT]: "INTERACT",
    [MenuId.DESTROY]: "DESTROY",
};

// ---------- Sculpt (§6.3) ----------
export enum BrushVerb { Grab, Inflate, Draw, Flatten, Smooth }

// ---------- Decorate (§8.2) ----------
export interface IcingDesign {
    color: string;
    gloss: number;
    dripStyle: "smooth" | "thick";
}
export interface SprinkleDesign {
    geometry: "capsule";
    palette: string[];
    length: number;
    radius: number;
}

// ---------- Voice adapter (§8.1; ElevenLabs deferred — see TODO.md) ----------
export interface VoiceReply { text: string; }
export interface VoiceAdapter {
    /** Produce a reply to a transcript, streaming tokens for the typewriter. */
    respond(transcript: string, onToken: (chunk: string) => void): Promise<VoiceReply>;
    /** Speak text via TTS (browser SpeechSynthesis for the scripted adapter). */
    speak(text: string): void;
}

// ---------- View mode (§0.7) ----------
export type ViewMode = "scene" | "ar";

// ---------- Director (§13) ----------
export type DirectorMode = "freeplay" | "safety";
export type Stage = "EMPTY" | "SPHERE" | "TORUS" | "DECORATED";

// ---------- Scratch math: reused objects, zero per-frame alloc (§6.2, §11) ----------
export interface ScratchMath {
    v1: THREE.Vector3; v2: THREE.Vector3; v3: THREE.Vector3; v4: THREE.Vector3;
    m1: THREE.Matrix4; q1: THREE.Quaternion; q2: THREE.Quaternion;
    plane: THREE.Plane; ray: THREE.Ray;
}

// ---------- SceneContext: the single shared-state channel ----------
export interface SceneContext {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    mesh: THREE.Mesh | null;        // PRIMARY selected shape (= selected[0]); null when nothing selected
    bvh: MeshBVH | null;            // built on mesh.geometry position
    extraMeshes: THREE.Mesh[];      // every other shape in the scene (selected-or-not, non-primary)
    selected: THREE.Mesh[];         // the selection SET (primary first); subset of allShapes (§5.1+)
    focusIndex: number;             // SELECT tool focus cursor into allShapes (what a pinch toggles)
    morphT: number;                 // current torus blend 0..1
    stage: Stage;
    viewMode: ViewMode;
    wireframe: boolean;             // false = solid/shaded, true = wireframe mesh (both-hands gun toggle)
    activeMenu: MenuId | null;
    scratch: ScratchMath;           // reused objects (§6.2)
    interactionPlaneZ: number;      // object depth for unprojection (§12)
}

// ---------- MenuModule contract: every menu honors this ----------
export interface MenuModule {
    id: MenuId;
    enter(ctx: SceneContext): void;
    update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void;
    exit(ctx: SceneContext): void;
    /** Optional plain-DOM panel, fixed right side (§4.2). */
    panel?: HTMLElement;
}
