// SELECT tool (multi-selection). Builds the SELECTION SET that the edit tools act on, using the
// fist controls — the SAME hands as the main tool menu: the RIGHT hand moves through the shapes and
// the LEFT hand commits. The controls:
//   - RIGHT FIST       → step the FOCUS CURSOR to the next shape.
//   - LEFT FIST        → toggle the focused shape in / out of the selection.
//   - LEFT V-SIGN (✌)  → toggle the focused shape NEGATIVE (a red cutter that INTERACT's UNION
//                        carves into a hole). The V-sign is distinct from a fist's release (which
//                        opens toward a flat palm, not a V), so the two left-hand actions never collide.
//   - RIGHT THREE FINGERS → deselect EVERYTHING (wipe the selection clear).
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
import { isVSign, isThreeFingers } from "../gesture/predicates";
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

// A V-sign / three-finger sign commits after this many steady frames (matches the pose debounce).
const V_FRAMES = 5;

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
    let execThreeStreak = 0;  // consecutive right three-finger frames (deselect-all at V_FRAMES)
    let execWasThree = false;
    let navWasFist = false;
    let navVStreak = 0;       // consecutive left V-sign frames (commits the cutter toggle at V_FRAMES)
    let navWasV = false;

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
                        ? "Left fist selects this shape · left <b>V-sign ✌</b> makes it a <span style=\"color:#ff6b6b\">hole</span>."
                        : "Right fist moves the cursor · left fist adds / removes · left <b>V-sign ✌</b> marks a <span style=\"color:#ff6b6b\">hole</span>.") +
                    `<br><span style=\"color:rgba(255,255,255,0.4)\">Right <b>three fingers</b> deselects everything.</span>` +
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
            execThreeStreak = 0;
            execWasThree = false;
            navWasFist = false;
            navVStreak = 0;
            navWasV = false;
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

            // Right THREE FINGERS (rising edge) → deselect EVERYTHING. A distinct pose (not reached by
            // a fist's release), debounced with its own streak like the V-sign.
            execThreeStreak = exec && isThreeFingers(exec.landmarks) ? Math.min(V_FRAMES, execThreeStreak + 1) : 0;
            const execThree = execThreeStreak >= V_FRAMES;
            if (execThree && !execWasThree) {
                clearSelection(ctx);
                paint(ctx);
            }
            execWasThree = execThree;

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

            // Left V-SIGN (✌, rising edge) → mark / unmark the focused shape as NEGATIVE (a cutter). A
            // shape becoming a cutter is auto-added to the selection so it takes part in the combine.
            // classify() has no "V" name, so detect it directly and debounce with a short streak.
            navVStreak = nav && isVSign(nav.landmarks) ? Math.min(V_FRAMES, navVStreak + 1) : 0;
            const navV = navVStreak >= V_FRAMES;
            if (navV && !navWasV) {
                const f = focusedShape(ctx);
                if (f) {
                    toggleNegative(f);
                    if (isNegative(f) && !isSelected(ctx, f)) toggleSelect(ctx, f);
                    paint(ctx);
                }
            }
            navWasV = navV;
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
