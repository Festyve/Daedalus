// §5.1 ADD SHAPES — the always-first tool. The world starts EMPTY (ctx.mesh === null),
// and this is the only module that creates the first sculptable mesh.
//
// Paradigm (SPEC §5.1, item 5):
//   - A 3D CAROUSEL (the same wheel component as the tool menu) shows the primitives:
//     Cube · Sphere · Cylinder. Your right hand SQUEEZES to spin the wheel and
//     your left hand SQUEEZES to spawn the centered shape at your left hand — so every
//     after-the-edit-menu selection reads as the same carousel format.
//   - The spawned shape immediately becomes the active sculpt target AND the sole selection.
//
// Your right hand (exec code-side, which is Right label) advances the carousel; your left hand
// (nav code-side, which is Left label) spawns at your left hand.
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

// Pinch closure below which the spawn (left) hand reads as OPEN. On entry the hand is still
// fisted from the tool-select gesture; the spawn stays disarmed until it drops below this once,
// so that carried-over fist can't immediately spawn a shape.
const PINCH_OPEN = 0.4;

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
    let spawn_armed = false;      // false until the spawn (left) hand has opened once since enter()

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

    // Cache the spawning (left) hand so the spawn lands at the correct position.
    let spawnHand: HandPose | null = null;
    // Rising-edge latch for the left-squeeze spawn. Spawning is handled in update() (not via
    // carousel.onSelect), so it never closes the wheel — you can add several shapes in a row.
    let wasSpawn = false;

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
    // selection + active sculpt target via selectOnly(). Spawn pre-rotated by ~20° on Y and ~15°
    // on X so the shape reads as 3D immediately (cube won't look like a flat square, etc.).
    function spawnShape(kind: ShapeKind, ctx: SceneContext, at: THREE.Vector3): void {
        const old = ctx.mesh;
        const mesh = attachMesh(ctx, makeShape(kind));
        if (old) ctx.extraMeshes.push(old);
        selectOnly(ctx, mesh);
        clampSpawnToView(at, ctx.camera, mesh.geometry.boundingSphere?.radius ?? 1.5);
        mesh.position.copy(at);
        mesh.rotateY((20 * Math.PI) / 180);
        mesh.rotateX((15 * Math.PI) / 180);

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
            panel.setInstructions("<b>YOUR RIGHT SQUEEZE</b> advance shape &nbsp;·&nbsp; <b>YOUR LEFT SQUEEZE</b> spawn");
            panel.setBody(
                `<div style="font-size:12px;color:rgba(255,255,255,0.6);line-height:1.6">` +
                `Squeeze your right hand to advance shapes, then squeeze your left hand to ` +
                `spawn the centered shape at your left hand.</div>`,
            );
            panel.show();

            carousel = new Carousel(SHAPE_ITEMS);
            carousel.object.position.copy(CAROUSEL_POS);
            ctx.camera.add(carousel.object);
            carousel.open(FAR_TIP);

            // No carousel.onSelect: selecting must NOT close the wheel. Spawning is handled directly
            // in update() (left squeeze), so the shape wheel stays open and you can add several
            // shapes in a row — it only closes when you leave ADD SHAPES.
            spawnHand = null;
            has_prev = false;
            spawn_armed = false;
            wasSpawn = false;
            spawn_mesh = null;
            spawn_t = 0;
        },

        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel || !carousel) return;
            const dtSec = dt / 1000;

            // Advance any in-flight spawn scale-in first (keeps growing even if the hand drops).
            advanceSpawn(dt);

            spawnHand = nav;

            // Arm the spawn once the left hand has opened, so the fist held from entering the tool
            // (the tool-select gesture) can't immediately spawn a shape.
            const navG = nav ? classify(nav.landmarks, nav.world, null) : NONE_GESTURE;
            if (!spawn_armed && navG.pinch < PINCH_OPEN) spawn_armed = true;

            // Left squeeze (armed, rising edge) → spawn the centered shape at the left fingertip,
            // handled HERE rather than via the carousel's select channel, so the wheel stays open.
            const spawning = spawn_armed && navG.pinch > PINCH_ON;
            if (spawning && !wasSpawn && spawnHand) {
                fingertipToWorld(
                    spawnHand.landmarks[INDEX_TIP], ctx.camera, ctx.interactionPlaneZ,
                    ctx.scratch.ray, ctx.scratch.plane, spawn_world,
                );
                spawnShape(carousel.current as ShapeKind, ctx, spawn_world);
            }
            wasSpawn = spawning;

            if (!exec) {
                has_prev = false;
                // The wheel keeps drawing but never selects/closes (NONE select channel).
                carousel.update(FAR_TIP, NONE_GESTURE, NONE_GESTURE, dtSec);
                return;
            }

            const lm = exec.landmarks;
            const g = classify(lm, exec.world, has_prev ? prev_landmarks : null);

            // Aim the carousel glow at the exec fingertip (camera-local).
            fingertipToWorld(
                lm[INDEX_TIP], ctx.camera, ctx.interactionPlaneZ,
                ctx.scratch.ray, ctx.scratch.plane, tip_world,
            );
            ctx.camera.worldToLocal(tip_local.copy(tip_world));

            // Right-hand (exec) gesture advances the wheel; NONE for the select channel so a spawn
            // never closes it.
            carousel.update(tip_local, g, NONE_GESTURE, dtSec);

            snapshotLandmarks(exec.landmarks);
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
            wasSpawn = false;
            // Spawned mesh is intentionally retained as the selection — the user's creation.
        },
    };
}
