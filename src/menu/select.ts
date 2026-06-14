// SELECT tool (multi-selection). Builds the SELECTION SET that the edit tools act on, using the
// fist controls — the SAME hands as the main tool menu: the RIGHT hand moves through the shapes and
// the LEFT hand commits. The controls:
//   - RIGHT FIST       → step the FOCUS CURSOR to the next shape.
//   - LEFT FIST          → toggle the focused shape in / out of the selection.
//   - LEFT THREE FINGERS → toggle the focused shape NEGATIVE (a red cutter that INTERACT's UNION
//                          carves into a hole). Three fingers is gun-proof (the gun needs the ring
//                          curled) and a fist's release never passes through it, so it never collides.
//   - RIGHT HORNS (🤘)   → deselect EVERYTHING (wipe the selection clear). Pinky extended → gun-proof.
// The focused shape pulses so you can see what the next left-fist will toggle; selected shapes are
// drawn bright, the rest ghosted (see core/shapes.refreshHighlight). The selection persists after you
// leave SELECT, so the next tool edits the shapes you chose, and the counter (ui/chrome) shows how many.
//
// Each pose is debounced (5 frames) and fires on the rising edge, so one pose = one action.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { classify, GestureDebouncer } from "../gesture/detect";
import { isThreeFingers, isHorns } from "../gesture/predicates";
import {
    allShapes,
    shapeCount,
    selectedCount,
    isSelected,
    toggleSelect,
    isNegative,
    toggleNegative,
    clearSelection,
    focusedShape,
    moveFocus,
    refreshHighlight,
} from "../core/shapes";

// The three-finger / horns signs commit after this many steady frames (matches the pose debounce).
const SIGN_FRAMES = 5;

// Focus-cursor pulse colour (the shape the left fist would toggle shimmers toward white).
const WHITE = new THREE.Color(0xffffff);

export function createSelectMenu(): MenuModule {
    const accent = MENU_META[MenuId.SELECT].accent;
    const label = MENU_META[MenuId.SELECT].label;

    let panel: Panel | null = null;
    let pulseMs = 0;              // focus-cursor pulse phase
    // Per-hand discrete-pose debouncers + rising-edge latches (one action per pose-close).
    let execGate = new GestureDebouncer();   // right hand → cycle (fist)
    let navGate = new GestureDebouncer();     // left hand → toggle select (fist)
    let execWasFist = false;
    let execHornsStreak = 0;  // consecutive right horns frames (deselect-all at SIGN_FRAMES)
    let execWasHorns = false;
    let navWasFist = false;
    let navThreeStreak = 0;   // consecutive left three-finger frames (cutter toggle at SIGN_FRAMES)
    let navWasThree = false;

    // Make the focused shape shimmer toward white so the user can see what the left fist will
    // toggle — even when it is currently unselected (then we also lift its opacity above the
    // ghost floor).
    function applyFocusPulse(ctx: SceneContext): void {
        const f = focusedShape(ctx);
        if (!f) return;
        const mat = f.material as THREE.MeshBasicMaterial;
        const pulse = 0.5 + 0.5 * Math.sin(pulseMs / 180);
        mat.opacity = Math.max(mat.opacity, 0.5 + 0.4 * pulse);
        mat.color.lerp(WHITE, 0.22 + 0.32 * pulse);
    }

    function paint(ctx: SceneContext): void {
        if (!panel) return;
        const total = shapeCount(ctx);
        if (total === 0) {
            panel.setBody(
                `<div style="font-size:13px;color:rgba(255,255,255,0.6);line-height:1.6">` +
                `No shapes yet — open <b>ADD SHAPES</b> and pinch to spawn one.</div>`,
            );
            return;
        }
        const fIdx = Math.min(Math.max(ctx.focusIndex, 0), total - 1);
        const focused = focusedShape(ctx);
        const onSel = focused ? isSelected(ctx, focused) : false;
        const onNeg = focused ? isNegative(focused) : false;
        const sel = selectedCount(ctx);
        const negCount = allShapes(ctx).filter(isNegative).length;
        panel.setBody(
            `<div style="display:flex;flex-direction:column;gap:14px">` +
                // big selection counter (+ a red "holes" tally when any cutter is marked)
                `<div style="font-size:30px;font-weight:700;color:${accent};text-shadow:0 0 12px ${accent}">` +
                    `${sel} <span style="color:rgba(255,255,255,0.45);font-size:16px">selected</span>` +
                    (negCount > 0
                        ? ` <span style="color:#ff6b6b;font-size:16px">· ${negCount} hole${negCount > 1 ? "s" : ""}</span>`
                        : "") +
                `</div>` +
                // focus cursor readout
                `<div style="font-size:13px;color:rgba(255,255,255,0.8)">` +
                    `cursor on shape <b>${fIdx + 1}</b> / ${total} — ` +
                    (onSel
                        ? `<span style="color:${accent}">in selection</span>`
                        : `<span style="color:rgba(255,255,255,0.55)">not selected</span>`) +
                    (onNeg ? ` <span style="color:#ff6b6b">· hole</span>` : "") +
                `</div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.55);line-height:1.5">` +
                    (total === 1
                        ? "Left fist selects this shape · left <b>three fingers</b> makes it a <span style=\"color:#ff6b6b\">hole</span>."
                        : "Right fist moves the cursor · left fist adds / removes · left <b>three fingers</b> marks a <span style=\"color:#ff6b6b\">hole</span>.") +
                    `<br><span style=\"color:rgba(255,255,255,0.4)\">Right <b>horns 🤘</b> deselects everything.</span>` +
                `</div>` +
            `</div>`,
        );
    }

    return {
        id: MenuId.SELECT,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            pulseMs = 0;
            execGate = new GestureDebouncer();
            navGate = new GestureDebouncer();
            execWasFist = false;
            execHornsStreak = 0;
            execWasHorns = false;
            navWasFist = false;
            navThreeStreak = 0;
            navWasThree = false;
            // Park the focus cursor on the primary selection if there is one.
            if (ctx.mesh) ctx.focusIndex = Math.max(0, allShapes(ctx).indexOf(ctx.mesh));
            refreshHighlight(ctx);
            paint(ctx);
            panel.show();
        },

        // Right fist steps the focus cursor; left fist toggles the focused shape — the same hands as
        // the main menu (right moves through, left commits). Both hands are handled independently.
        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel) return;
            pulseMs += dt;

            // Re-assert the tier highlight each frame, then shimmer the focused shape on top.
            refreshHighlight(ctx);
            applyFocusPulse(ctx);

            // Right (exec) FIST (rising edge) → step the focus cursor. "none" when the hand is gone, so
            // a stale fist never lingers across a tracking gap; one fist-close = one step.
            const execFist = execGate.push(exec ? classify(exec.landmarks, exec.world, null).name : "none") === "fist";
            if (execFist && !execWasFist) {
                moveFocus(ctx, 1);
                paint(ctx);
            }
            execWasFist = execFist;

            // Right HORNS 🤘 (rising edge) → deselect EVERYTHING. Gun-proof (pinky extended) and not
            // reached by a fist's release, debounced with its own streak.
            execHornsStreak = exec && isHorns(exec.landmarks) ? Math.min(SIGN_FRAMES, execHornsStreak + 1) : 0;
            const execHorns = execHornsStreak >= SIGN_FRAMES;
            if (execHorns && !execWasHorns) {
                // Wipe everything clear: drop the selection AND every cutter tag, so no shape is left
                // red / showing a HOLE badge while unselected.
                clearSelection(ctx);
                for (const m of allShapes(ctx)) if (isNegative(m)) toggleNegative(m);
                refreshHighlight(ctx);
                paint(ctx);
            }
            execWasHorns = execHorns;

            // Left (nav) FIST (rising edge) → toggle the focused shape in/out of the selection.
            const navFist = navGate.push(nav ? classify(nav.landmarks, nav.world, null).name : "none") === "fist";
            if (navFist && !navWasFist) {
                const f = focusedShape(ctx);
                if (f) {
                    toggleSelect(ctx, f);
                    paint(ctx);
                }
            }
            navWasFist = navFist;

            // Left THREE FINGERS (rising edge) → mark / unmark the focused shape as NEGATIVE (a cutter).
            // A shape becoming a cutter is auto-added to the selection so it takes part in the combine.
            // classify() has no name for this, so detect it directly and debounce with a short streak.
            navThreeStreak = nav && isThreeFingers(nav.landmarks) ? Math.min(SIGN_FRAMES, navThreeStreak + 1) : 0;
            const navThree = navThreeStreak >= SIGN_FRAMES;
            if (navThree && !navWasThree) {
                const f = focusedShape(ctx);
                if (f) {
                    toggleNegative(f);
                    if (isNegative(f) && !isSelected(ctx, f)) toggleSelect(ctx, f);
                    paint(ctx);
                }
            }
            navWasThree = navThree;
        },

        exit(ctx: SceneContext): void {
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            // Restore the plain tier highlight (drop the focus shimmer) for the next tool.
            refreshHighlight(ctx);
        },
    };
}
