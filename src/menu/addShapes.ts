// §5.1 ADD SHAPES — the always-first tool. The world starts EMPTY (ctx.mesh === null),
// and this is the only module that creates the first sculptable mesh.
//
// Paradigm (SPEC §5.1, item 5):
//   - A 3D CAROUSEL (the same wheel component as the tool menu) shows the primitives:
//     Cube · Sphere · Cylinder. The nav (left) hand SQUEEZES to spin the wheel and
//     the exec (right) hand SQUEEZES to spawn the centered shape at the right hand — so every
//     after-the-edit-menu selection reads as the same carousel format.
//   - The spawned shape immediately becomes the active sculpt target AND the sole selection.
//
// The left hand (`nav`) advances the carousel; the right hand (`exec`) spawns at the right hand.
// Zero per-frame allocation in update(): the fingertip unprojection reuses ctx.scratch, the
// prev-frame landmark snapshot is a pre-allocated reused array, and the gesture handed to the
// carousel is a single reused object.
import * as THREE from "three";
import type { GestureState, HandPose, MenuModule, SceneContext, Vec3 } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { Carousel, type CarouselItem } from "./carousel";
import { makeShape } from "../render/geometry";
import { attachMesh } from "../render/scene";
import { selectOnly } from "../core/shapes";
import { fingertipToWorld } from "../math/coords";
import { handScale, pinchAmount } from "../gesture/predicates";
import { classify } from "../gesture/detect";

// Right INDEX_TIP landmark index (MediaPipe Hands), the spawn-origin fingertip (§12).
const INDEX_TIP = 8;

// The three primitives offered, in carousel order (SPEC §5.1).
type ShapeKind = "cube" | "sphere" | "cylinder";
const SHAPES: ReadonlyArray<{ kind: ShapeKind; label: string; glyph: string }> = [
    { kind: "cube", label: "CUBE", glyph: "◼" },
    { kind: "sphere", label: "SPHERE", glyph: "●" },
    { kind: "cylinder", label: "CYLINDER", glyph: "▮" },
];

// Carousel item descriptors for the shape picker (all share the ADD accent so the wheel reads
// as one tool's sub-selection).
const SHAPE_ITEMS: CarouselItem[] = SHAPES.map((s) => ({
    id: s.kind,
    icon: s.glyph,
    label: s.label,
    accent: MENU_META[MenuId.ADD_SHAPES].accent,
}));

// Where the shape sub-carousel sits in camera-local space (top-center, matching the tool wheel
// — only one wheel is ever visible at a time, so they can share the spot).
const CAROUSEL_POS = new THREE.Vector3(0, 0.9, -3.2);

// Pinch closure (0..1) above which a pinch is "closed" — gates the spawn rising edge.
const PINCH_ON = 0.7;

// Spawn scale-in: a freshly spawned shape grows 0→1 so it "arrives" rather than popping in
// (§14.4). Fast (220ms) with a restrained ease-out-back settle.
const SPAWN_MS = 220;
const SPAWN_BACK = 0.7;

function easeOutBack(t: number): number {
    const c1 = SPAWN_BACK;
    const c3 = c1 + 1;
    const u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
}

const PANEL_INSTRUCTIONS =
    "<b>SWIPE</b> pick shape &nbsp;·&nbsp; <b>PINCH</b> spawn at hand";

// One reusable Vec3 (plain object, not THREE.Vector3 — landmarks are bare Vec3).
function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

// Keep a freshly spawned shape fully on screen (§5.1): clamp the spawn point to the camera
// frustum at the spawn depth, leaving a margin for the shape's own radius. Mutates `at`.
function clampSpawnToView(at: THREE.Vector3, camera: THREE.PerspectiveCamera, radius: number): void {
    const dist = Math.max(0.001, Math.abs(camera.position.z - at.z));
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
    const halfW = halfH * camera.aspect;
    const limX = Math.max(0, halfW - radius);
    const limY = Math.max(0, halfH - radius);
    at.x = Math.min(limX, Math.max(-limX, at.x));
    at.y = Math.min(limY, Math.max(-limY, at.y));
}

export function createAddShapesMenu(): MenuModule {
    const accent = MENU_META[MenuId.ADD_SHAPES].accent;
    const label = MENU_META[MenuId.ADD_SHAPES].label;

    // Module-local live state.
    let panel: Panel | null = null;
    let carousel: Carousel | null = null;
    let has_prev = false;         // whether prev_landmarks holds a valid previous frame

    // Spawn scale-in animation state.
    let spawn_mesh: THREE.Mesh | null = null;
    let spawn_t = 0;

    // Pre-allocated previous-frame landmark snapshot (21 Vec3) for gesture classify.
    const prev_landmarks: Vec3[] = Array.from({ length: 21 }, blankVec);

    // Reused scratch (no per-frame allocation).
    const spawn_world = new THREE.Vector3();
    const tip_world = new THREE.Vector3();
    const tip_local = new THREE.Vector3();
    const NONE_GESTURE: GestureState = { name: "none", extended: 0, pinch: 0, spread: 0, vx: 0 };
    const FAR_TIP = new THREE.Vector3(10, 10, 0);

    // Cache the spawning hand so onSelect can spawn at the correct position.
    let spawnHand: HandPose | null = null;

    function snapshotLandmarks(lm: Vec3[]): void {
        const n = Math.min(lm.length, prev_landmarks.length);
        for (let i = 0; i < n; i++) {
            prev_landmarks[i].x = lm[i].x;
            prev_landmarks[i].y = lm[i].y;
            prev_landmarks[i].z = lm[i].z;
        }
        has_prev = true;
    }

    // Spawn a fresh primitive and ADD it to the scene (§5.1, multi-shape): the previous shape is
    // demoted to a background shape (kept, not disposed) and the new mesh becomes the SOLE
    // selection + active sculpt target via selectOnly().
    function spawnShape(kind: ShapeKind, ctx: SceneContext, at: THREE.Vector3): void {
        const old = ctx.mesh;
        const mesh = attachMesh(ctx, makeShape(kind));
        if (old) ctx.extraMeshes.push(old);
        selectOnly(ctx, mesh);
        clampSpawnToView(at, ctx.camera, mesh.geometry.boundingSphere?.radius ?? 1.5);
        mesh.position.copy(at);

        spawn_mesh = mesh;
        spawn_t = 0;
        mesh.scale.setScalar(0.0001);
    }

    function advanceSpawn(dt: number): void {
        if (!spawn_mesh) return;
        spawn_t += dt;
        const t = spawn_t / SPAWN_MS;
        if (t >= 1) {
            spawn_mesh.scale.setScalar(1);
            spawn_mesh = null;
            return;
        }
        spawn_mesh.scale.setScalar(easeOutBack(t));
    }

    return {
        id: MenuId.ADD_SHAPES,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            panel.setInstructions("<b>LEFT SQUEEZE</b> advance shape &nbsp;·&nbsp; <b>RIGHT SQUEEZE</b> spawn");
            panel.setBody(
                `<div style="font-size:12px;color:rgba(255,255,255,0.6);line-height:1.6">` +
                `Squeeze your left hand to advance shapes, then squeeze your right hand to ` +
                `spawn the centered shape at your right hand.</div>`,
            );
            panel.show();

            carousel = new Carousel(SHAPE_ITEMS);
            carousel.object.position.copy(CAROUSEL_POS);
            ctx.camera.add(carousel.object);
            carousel.open(FAR_TIP);

            // Wire up selection: right-hand pinch triggers onSelect when the carousel closes.
            carousel.onSelect = (id) => {
                if (spawnHand) {
                    fingertipToWorld(
                        spawnHand.landmarks[INDEX_TIP], ctx.camera, ctx.interactionPlaneZ,
                        ctx.scratch.ray, ctx.scratch.plane, spawn_world,
                    );
                    spawnShape(id as ShapeKind, ctx, spawn_world);
                }
            };

            spawnHand = null;
            has_prev = false;
            spawn_mesh = null;
            spawn_t = 0;
        },

        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel || !carousel) return;
            const dtSec = dt / 1000;

            // Advance any in-flight spawn scale-in first (keeps growing even if the hand drops).
            advanceSpawn(dt);

            spawnHand = exec;

            if (!nav) {
                has_prev = false;
                carousel.update(FAR_TIP, exec ? classify(exec.landmarks, exec.world, null) : NONE_GESTURE, NONE_GESTURE, dtSec);
                return;
            }

            const lm = nav.landmarks;
            const g = classify(lm, nav.world, has_prev ? prev_landmarks : null);

            // Aim the carousel glow at the nav fingertip (camera-local).
            fingertipToWorld(
                lm[INDEX_TIP], ctx.camera, ctx.interactionPlaneZ,
                ctx.scratch.ray, ctx.scratch.plane, tip_world,
            );
            ctx.camera.worldToLocal(tip_local.copy(tip_world));

            // Pass left-hand (nav) gesture for advancing and right-hand (exec) gesture for spawning.
            const execG = exec ? classify(exec.landmarks, exec.world, null) : NONE_GESTURE;
            carousel.update(tip_local, execG, g, dtSec);

            snapshotLandmarks(nav.landmarks);
        },

        exit(ctx: SceneContext): void {
            if (carousel) {
                ctx.camera.remove(carousel.object);
                carousel.dispose();
                carousel = null;
            }
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            has_prev = false;
            // Snap any still-arriving shape to full scale so it is never left mid-scale-in.
            if (spawn_mesh) {
                spawn_mesh.scale.setScalar(1);
                spawn_mesh = null;
            }
            spawn_t = 0;
            spawnHand = null;
            // Spawned mesh is intentionally retained as the selection — the user's creation.
        },
    };
}
