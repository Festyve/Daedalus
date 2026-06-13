// §5.1 ADD SHAPES — the always-first tool. The world starts EMPTY (ctx.mesh === null),
// and this is the only module that creates the first sculptable mesh.
//
// Paradigm (SPEC §5.1):
//   - Right-side DOM panel shows a mini horizontal carousel: Cube · Sphere · Tetrahedron.
//   - FLICK (fast horizontal index-tip velocity) cycles the highlighted shape, wrapping.
//   - PINCH (right hand) spawns the highlighted shape at the right-hand world position;
//     the spawned shape immediately becomes the active sculpt target, replacing whatever
//     was there (the previous ctx.mesh is removed + disposed first).
//
// The right hand is the executor (`exec`); the left hand (`nav`) drives the global
// carousel elsewhere and is unused here. Zero per-frame allocation in update(): the
// fingertip unprojection reuses ctx.scratch, and the prev-frame landmark snapshot is a
// pre-allocated, reused array of plain Vec3 objects.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext, Vec3 } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { makeShape } from "../render/geometry";
import { attachMesh } from "../render/scene";
import { fingertipToWorld } from "../math/coords";
import { handScale, pinchAmount } from "../gesture/predicates";
import { classify } from "../gesture/detect";

// Right INDEX_TIP landmark index (MediaPipe Hands), the spawn-origin fingertip (§12).
const INDEX_TIP = 8;

// The three primitives offered, in carousel order (SPEC §5.1).
type ShapeKind = "cube" | "sphere" | "tetra";
const SHAPES: ReadonlyArray<{ kind: ShapeKind; label: string; glyph: string }> = [
    { kind: "cube", label: "CUBE", glyph: "◼" },
    { kind: "sphere", label: "SPHERE", glyph: "●" },
    { kind: "tetra", label: "TETRA", glyph: "▲" },
];

// Pinch closure (0..1) above which a pinch is "closed" — gates the spawn rising edge.
const PINCH_ON = 0.7;

// Min frames between flick-driven cycles so one physical swipe steps exactly one slot
// (the flick channel stays hot for several frames while the hand decelerates).
const FLICK_COOLDOWN_FRAMES = 8;

// |g.vx| (units of S/frame) that commits a flick — matches §12 and the global carousel.
// Gating on vx (not g.name) so an OPEN hand swiped sideways still cycles: classify()
// returns name="open" for a spread hand, which would otherwise mask the flick entirely.
const FLICK_VX = 0.4;

// Spawn scale-in: a freshly spawned shape grows 0→1 so it "arrives" rather than popping
// in (§14.4 motion language — precise, immediate). Fast (220ms) and deliberate, with a
// restrained ease-out-back settle: just enough overshoot to read as "snapping into place"
// without being bouncy. SPAWN_BACK is the overshoot constant (standard back-ease uses
// ~1.70158, which reads springy; ~0.7 gives a tasteful ~3% settle that honours "arrive").
const SPAWN_MS = 220;
const SPAWN_BACK = 0.7;

// Ease-out-back: starts fast, overshoots 1 slightly, settles back. Overshoot magnitude is
// governed by SPAWN_BACK; the curve always passes through (0,0) and (1,1).
function easeOutBack(t: number): number {
    const c1 = SPAWN_BACK;
    const c3 = c1 + 1;
    const u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
}

// Compact gesture strip shown at the bottom of the panel (SPEC §4.2).
const PANEL_INSTRUCTIONS =
    "<b>FLICK</b> cycle shape &nbsp;·&nbsp; <b>PINCH</b> spawn at hand";

// Build the right-side carousel markup. The highlighted slot is full-accent and scaled;
// neighbours dim to 40% (matching the global carousel's adjacent-opacity feel, §4.1).
function carouselHtml(selected: number, accent: string): string {
    const slots = SHAPES.map((s, i) => {
        const on = i === selected;
        const opacity = on ? "1" : "0.4";
        const color = on ? accent : "rgba(255,255,255,0.85)";
        const border = on ? accent : "rgba(255,255,255,0.18)";
        const glow = on ? "box-shadow:0 0 14px " + accent + ";" : "";
        const scale = on ? "scale(1.08)" : "scale(0.92)";
        return (
            '<div style="' +
            "flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:6px;" +
            "padding:14px 4px;border:0.5px solid " + border + ";border-radius:8px;" +
            "opacity:" + opacity + ";transform:" + scale + ";transition:all 100ms ease-out;" +
            glow +
            '">' +
            '<div style="font-size:30px;line-height:1;color:' + color + '">' + s.glyph + "</div>" +
            '<div style="font-size:10.5px;letter-spacing:0.08em;color:' + color + '">' + s.label + "</div>" +
            "</div>"
        );
    }).join("");

    return (
        '<div style="display:flex;gap:8px;align-items:stretch;margin-bottom:14px">' +
        slots +
        "</div>" +
        '<div style="font-size:11px;color:rgba(255,255,255,0.55);line-height:1.5">' +
        "Right-hand <b>pinch</b> spawns the selected shape at your hand and makes it the " +
        "active sculpt target." +
        "</div>"
    );
}

// One reusable Vec3 (plain object, not THREE.Vector3 — landmarks are bare Vec3).
function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

export function createAddShapesMenu(): MenuModule {
    const accent = MENU_META[MenuId.ADD_SHAPES].accent;
    const label = MENU_META[MenuId.ADD_SHAPES].label;

    // Module-local live state.
    let panel: Panel | null = null;
    let selected = 0;             // index into SHAPES of the highlighted primitive
    let was_pinched = false;      // pinch edge tracking (rising edge spawns)
    let flick_cooldown = 0;       // frames remaining before another flick may cycle
    let has_prev = false;         // whether prev_landmarks holds a valid previous frame

    // Spawn scale-in animation state. spawn_mesh is the mesh currently growing 0→1;
    // spawn_t is elapsed ms into the scale-in. spawn_mesh is null when no shape is
    // arriving (steady state). No per-frame allocation — both are scalars/refs.
    let spawn_mesh: THREE.Mesh | null = null;
    let spawn_t = 0;

    // Pre-allocated previous-frame landmark snapshot (21 Vec3). classify() needs the
    // prior frame's image-space landmarks to compute index-tip horizontal velocity (vx)
    // for the flick. Reused every frame — no per-frame allocation.
    const prev_landmarks: Vec3[] = Array.from({ length: 21 }, blankVec);

    // Spawn origin reused across frames (no per-frame alloc).
    const spawn_world = new THREE.Vector3();

    function paint(): void {
        if (!panel) return;
        panel.setBody(carouselHtml(selected, accent));
    }

    // Copy this frame's 21 landmarks into the reused prev buffer for next frame's vx.
    function snapshotLandmarks(lm: Vec3[]): void {
        const n = Math.min(lm.length, prev_landmarks.length);
        for (let i = 0; i < n; i++) {
            prev_landmarks[i].x = lm[i].x;
            prev_landmarks[i].y = lm[i].y;
            prev_landmarks[i].z = lm[i].z;
        }
        has_prev = true;
    }

    // Replace the active sculpt target with a freshly spawned primitive (§5.1). The old
    // mesh (if any) is removed from the scene and disposed first so it does not linger;
    // attachMesh then builds the new mesh + BVH and points ctx.mesh / ctx.bvh at it.
    function spawnShape(kind: ShapeKind, ctx: SceneContext, at: THREE.Vector3): void {
        const old = ctx.mesh;
        if (old) {
            ctx.scene.remove(old);
            old.geometry.dispose();
            // Dispose every material under the old mesh — the fill plus its wireframe-overlay
            // child (which shares this now-disposed geometry). Geometry is shared, so it is
            // disposed exactly once above; traversal only frees the per-mesh materials.
            old.traverse((o) => {
                const m = (o as THREE.Mesh).material;
                if (!m) return;
                if (Array.isArray(m)) m.forEach((x) => x.dispose());
                else m.dispose();
            });
            ctx.bvh = null;
        }

        const mesh = attachMesh(ctx, makeShape(kind));
        mesh.position.copy(at);

        // Begin the scale-in: the shape starts near-zero and grows to 1 so it "arrives"
        // at the hand rather than popping in. Seed a tiny non-zero scale so the first
        // rendered frame already shows a sliver (a true 0 reads as a one-frame gap).
        spawn_mesh = mesh;
        spawn_t = 0;
        mesh.scale.setScalar(0.0001);
    }

    // Advance the spawn scale-in by dt (ms), driving the active shape's scale 0→1 along
    // an ease-out-back curve. Runs every frame regardless of hand state so the animation
    // never stalls when the executor hand drops mid-arrival. No-op once settled.
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
            panel.setInstructions(PANEL_INSTRUCTIONS);
            selected = 0;
            was_pinched = false;
            flick_cooldown = 0;
            has_prev = false;
            spawn_mesh = null;
            spawn_t = 0;
            paint();
            panel.show();
            // Silence unused-parameter lint without changing the contract signature.
            void ctx;
        },

        update(ctx: SceneContext, exec: HandPose | null, _nav: HandPose | null, _dt: number): void {
            if (!panel) return;

            // Advance any in-flight spawn scale-in first, before the no-hand early return,
            // so an arriving shape keeps growing even if the hand momentarily drops.
            advanceSpawn(_dt);

            if (flick_cooldown > 0) flick_cooldown--;

            // No executor hand → idle; drop the previous-frame velocity reference so a
            // re-acquired hand does not register a phantom flick across the gap.
            if (!exec) {
                was_pinched = false;
                has_prev = false;
                return;
            }

            const lm = exec.landmarks;
            const s = handScale(exec.world);

            // FLICK → cycle the highlighted shape (wrapping), one step per swipe. Gate on the
            // vx channel, not g.name: a flick can ride any pose, and a spread hand classifies
            // as "open", which would otherwise mask it (same pattern as the global carousel).
            const g = classify(lm, exec.world, has_prev ? prev_landmarks : null);
            if (Math.abs(g.vx) > FLICK_VX && flick_cooldown === 0) {
                const dir = g.vx > 0 ? 1 : -1; // mirrored image space: +vx = rightward
                selected = (selected + dir + SHAPES.length) % SHAPES.length;
                flick_cooldown = FLICK_COOLDOWN_FRAMES;
                paint();
            }

            // PINCH rising edge → spawn the selected shape at the fingertip world position
            // and make it the active sculpt target (§5.1).
            const pinch = pinchAmount(lm, s);
            const pinched_now = pinch > PINCH_ON;
            if (pinched_now && !was_pinched) {
                fingertipToWorld(
                    lm[INDEX_TIP], ctx.camera, ctx.interactionPlaneZ,
                    ctx.scratch.ray, ctx.scratch.plane, spawn_world,
                );
                spawnShape(SHAPES[selected].kind, ctx, spawn_world);
            }
            was_pinched = pinched_now;

            snapshotLandmarks(lm);
        },

        exit(ctx: SceneContext): void {
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            was_pinched = false;
            flick_cooldown = 0;
            has_prev = false;
            // If a shape was still arriving when the tool switched away, snap it to full
            // scale so the retained mesh is never left mid-scale-in for the next tool.
            if (spawn_mesh) {
                spawn_mesh.scale.setScalar(1);
                spawn_mesh = null;
            }
            spawn_t = 0;
            // Spawned mesh is intentionally retained as ctx.mesh — it is the user's
            // creation and the active target for every later tool.
            void ctx;
        },
    };
}
