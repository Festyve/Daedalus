// §5.2 TRANSLATE — open-palm grab, fist lock. Pure free movement, no axis arrows.
//
// Paradigm: the right hand *is* the handle. An open palm grabs the active object and it
// tracks the hand's world position freely; closing to a fist locks the object in place.
// There is no affordance geometry — the only UI is a plain-DOM Panel pinned to the right
// edge of the screen (§4.2) showing the live X/Y/Z position and the current grab state.
//
// World tracking math (§12):
//   - The palm anchor (MIDDLE_MCP, landmark 9) is unprojected from mirrored image space
//     onto the interaction plane at object depth → a world point that follows the hand.
//   - On grab we latch a constant offset = (mesh position in parent space) − (hand point
//     in parent space). Each frame the target mesh position = handPoint(parent) + offset,
//     so the object follows the hand's *motion* from wherever it was — no teleport snap.
//   - The mesh lives inside the tilt/spin rig, so its local position is parent-space; we
//     convert the world hand point into that parent space before applying the offset.
//   - A light per-frame lerp smooths residual landmark jitter without lagging the hand.
//
// Discrete grab/lock transitions are debounced (§12: gestures commit after 5 consecutive
// frames) so a single misclassified frame never flips the lock state.
//
// World starts empty (§5.1): ctx.mesh may be null — every access is guarded and the tool
// idles (panel shows a prompt) until ADD SHAPES creates the first mesh.
//
// Module-boundary rule (§3.2): this talks only to SceneContext. HOT LOOP: zero per-frame
// allocation — reuses ctx.scratch plus a handful of module-owned vectors created once.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { T, FONT, TOOL_ACCENT } from "../render/tokens";
import { Panel } from "./panel";
import { fingertipToWorld } from "../math/coords";
import { isOpenPalm, isFist } from "../gesture/predicates";
import { selectedShapes, allShapes } from "../core/shapes";

// MediaPipe palm-center anchor: middle-finger MCP reads as the centre of the hand, so the
// object tracks the palm rather than a wandering fingertip.
const PALM_ANCHOR = 9;

// Discrete gestures commit after this many consecutive frames (§12 debounce) to defeat
// per-frame classifier flicker between open palm / fist / neither.
const COMMIT_FRAMES = 5;

// Per-frame smoothing toward the hand target while grabbed. 1 = rigid (snaps exactly to
// the hand); lower lags slightly to absorb landmark jitter. High enough that the object
// stays glued to the hand even during fast motion, with just enough give to soak jitter.
const TRACK_LERP = 0.85;

export function createTranslateMenu(): MenuModule {
    const accent = TOOL_ACCENT[MenuId.TRANSLATE];

    let panel: Panel | null = null;

    // Grab state. `grabbed` true ⇒ the object is currently following the hand.
    let grabbed = false;
    // Debounce counters: open palm to engage, fist to lock. Locking on an explicit fist
    // (rather than merely "not an open palm") means an open palm that momentarily flickers
    // during fast motion — landmarks blur — does NOT drop the grab.
    let open_frames = 0;
    let fist_frames = 0;

    // Per-selected-mesh offset (parent space) captured at grab: meshLocalPos − handPointParent.
    // Applying each keeps every selected shape's position relative to the hand fixed, so the whole
    // selection translates together by the hand's motion (relative spacing preserved). With one
    // shape this is the original single-object grab.
    const engagedMeshes: THREE.Mesh[] = [];
    const grabOffsets: THREE.Vector3[] = [];

    // Module-owned scratch, created once (ctx.scratch is shared; these are private to the
    // hot loop and never reallocated).
    const hand_world = new THREE.Vector3();   // palm anchor unprojected to world
    const hand_parent = new THREE.Vector3();  // same point in the mesh's parent space
    const target_local = new THREE.Vector3(); // desired mesh local position this frame

    // Update the panel body (live X/Y/Z + state). Pure DOM text — cheap; called per frame.
    function paint(ctx: SceneContext): void {
        if (!panel) return;
        const mesh = ctx.mesh;
        if (!mesh) {
            panel.setBody(
                `<div style="color:${T.textDim};font-size:12px;line-height:1.6">` +
                "No object yet.<br>Use <b>ADD SHAPES</b> to create one," +
                "<br>then open your hand to grab it." +
                "</div>",
            );
            return;
        }
        const p = mesh.position;
        const fmt = (n: number): string => (n >= 0 ? "+" : "") + n.toFixed(2);
        const row = (axis: string, v: number): string =>
            `<div style="display:flex;justify-content:space-between;` +
            `font-variant-numeric:tabular-nums">` +
            `<span style="color:${accent}">${axis}</span>` +
            `<span>${fmt(v)}</span></div>`;
        const state = grabbed
            ? `<span style="color:${accent}">TRACKING</span>`
            : `<span style="color:${T.textDim}">LOCKED</span>`;
        panel.setBody(
            `<div style="display:flex;flex-direction:column;gap:6px;` +
            `font-size:15px;letter-spacing:0.04em">` +
            row("X", p.x) + row("Y", p.y) + row("Z", p.z) +
            `</div>` +
            `<div style="margin-top:14px;font-size:11px;` +
            `text-transform:uppercase;letter-spacing:0.12em">${state}</div>`,
        );
    }

    return {
        id: MenuId.TRANSLATE,
        get panel(): HTMLElement | undefined {
            return panel ? panel.el : undefined;
        },

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: "TRANSLATE", accent });
            panel.setInstructions("OPEN HAND&nbsp;&nbsp;GRAB&nbsp;&nbsp;·&nbsp;&nbsp;FIST&nbsp;&nbsp;LOCK");
            panel.show();

            grabbed = false;
            open_frames = 0;
            fist_frames = 0;

            paint(ctx);
        },

        update(ctx: SceneContext, exec: HandPose | null, _nav: HandPose | null, _dt: number): void {
            if (!panel) return;

            const mesh = ctx.mesh;

            // Driven by the EXEC (right) hand. No mesh (empty world) or no hand → drop any
            // grab and idle.
            if (!mesh || !exec) {
                if (grabbed) {
                    grabbed = false;
                    open_frames = 0;
                    fist_frames = 0;
                }
                paint(ctx);
                return;
            }

            // Debounce open-palm-to-grab and fist-to-lock separately so a single stray frame
            // cannot flip the state. Open palm and fist are mutually exclusive, so anything in
            // between (a half-curl mid-motion) advances neither counter and simply holds the
            // current grab state.
            const open_now = isOpenPalm(exec.world, exec.handScale);
            const fist_now = isFist(exec.world, exec.handScale);
            open_frames = open_now ? open_frames + 1 : 0;
            fist_frames = fist_now ? fist_frames + 1 : 0;

            if (!grabbed && open_frames >= COMMIT_FRAMES) {
                // Grab: latch a per-mesh offset for every SELECTED shape so the whole
                // selection stays where it is and follows the hand from there (no teleport).
                // Convert the palm world point into each mesh's parent space, then
                // offset = meshLocal − handParent.
                // Grab the selection; if nothing is explicitly selected, fall back to every
                // shape so a grab always has a target.
                fingertipToWorld(
                    exec.landmarks[PALM_ANCHOR], ctx.camera, ctx.interactionPlaneZ,
                    ctx.scratch.ray, ctx.scratch.plane, hand_world,
                );
                const targets = ctx.selected.length ? selectedShapes(ctx) : allShapes(ctx);
                engagedMeshes.length = 0;
                grabOffsets.length = 0;
                for (const m of targets) {
                    const parent = m.parent;
                    if (parent) {
                        parent.updateWorldMatrix(true, false);
                        hand_parent.copy(hand_world);
                        parent.worldToLocal(hand_parent);
                    } else {
                        hand_parent.copy(hand_world);
                    }
                    engagedMeshes.push(m);
                    grabOffsets.push(m.position.clone().sub(hand_parent));
                }
                grabbed = true;
            } else if (grabbed && fist_frames >= COMMIT_FRAMES) {
                // Fist → lock. The meshes keep their current positions untouched.
                grabbed = false;
            }

            // While grabbed, every selected shape tracks the hand: target = handPoint(parent) +
            // offset, smoothed to soak up landmark jitter without lagging the motion.
            if (grabbed) {
                fingertipToWorld(
                    exec.landmarks[PALM_ANCHOR], ctx.camera, ctx.interactionPlaneZ,
                    ctx.scratch.ray, ctx.scratch.plane, hand_world,
                );
                for (let i = 0; i < engagedMeshes.length; i++) {
                    const m = engagedMeshes[i];
                    const parent = m.parent;
                    if (parent) {
                        parent.updateWorldMatrix(true, false);
                        hand_parent.copy(hand_world);
                        parent.worldToLocal(hand_parent);
                    } else {
                        hand_parent.copy(hand_world);
                    }
                    target_local.copy(hand_parent).add(grabOffsets[i]);
                    m.position.lerp(target_local, TRACK_LERP);
                }
            }

            // Keep the panel readout live (mesh.position may also have changed elsewhere).
            paint(ctx);
        },

        exit(_ctx: SceneContext): void {
            if (panel) {
                panel.destroy();
                panel = null;
            }
            grabbed = false;
            open_frames = 0;
            fist_frames = 0;
        },
    };
}
