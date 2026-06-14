// SELECT tool (multi-selection). Builds the SELECTION SET that the edit tools act on, using the
// fist controls — the SAME hands as the main tool menu: the RIGHT hand moves through the shapes and
// the LEFT hand commits. A RIGHT-hand FIST steps a FOCUS CURSOR to the next shape; a LEFT-hand FIST
// toggles the focused shape in/out of the selection. Close the left fist again to keep adding shapes;
// open the main menu (right-hand gun) when the selection is done. The focused shape pulses
// so you can see what the next left-fist will toggle; selected shapes are drawn bright, the rest
// ghosted (see core/shapes.refreshHighlight). The selection persists after you leave SELECT, so the
// next tool edits the shapes you chose, and the on-screen counter (ui/chrome) shows how many.
//
// Each hand's fist is debounced (gesture/detect.GestureDebouncer, 5 frames) and fires on the rising
// edge, so one fist-close = one cursor step / one toggle.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext, Vec3 } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { GestureDebouncer } from "../gesture/detect";
import { fingerExtended } from "../gesture/predicates";
import {
    allShapes,
    shapeCount,
    selectedCount,
    isSelected,
    toggleSelect,
    focusedShape,
    moveFocus,
    refreshHighlight,
} from "../core/shapes";

// Focus-cursor pulse colour (the shape the left fist would toggle shimmers toward white).
const WHITE = new THREE.Color(0xffffff);

// Frames a fist must be held before it fires an action. Reduces accidental triggers.
const FIST_CONFIRM_FRAMES = 12;

// Finger tip/PIP pairs (index→pinky) for the closed-hand test. A hand counts as a "fist"
// when all four of these fingers are curled (tip nearer the wrist than its PIP). We
// deliberately IGNORE the thumb — same as DILATE: predicates.isFist() (and so
// classify().name === "fist") also requires the thumb to stick out (gap > 0.6·S), but a
// natural clench tucks the thumb over the fingers, so isFist never fires for the fist the
// user actually makes — and a tucked thumb often reads as a PINCH (thumb–index < 0.45·S),
// which classify() resolves before fist ever. Curled-fingers-only is robust to thumb pose,
// which is why SELECT's fist felt dead while the other fist tools (DILATE) felt crisp.
const FIST_TIPS = [8, 12, 16, 20];
const FIST_PIPS = [6, 10, 14, 18];

// True when all four fingers are curled — i.e. the hand is squeezed shut (thumb-agnostic).
function handClosed(lm: Vec3[]): boolean {
    for (let i = 0; i < FIST_TIPS.length; i++) {
        if (fingerExtended(lm, FIST_TIPS[i], FIST_PIPS[i])) return false;
    }
    return true;
}

export function createSelectMenu(): MenuModule {
    const accent = MENU_META[MenuId.SELECT].accent;
    const label = MENU_META[MenuId.SELECT].label;

    let panel: Panel | null = null;
    let pulseMs = 0;              // focus-cursor pulse phase
    // Per-hand discrete-pose debouncers + rising-edge latches (one action per pose-close).
    let execGate = new GestureDebouncer();   // right hand → cycle
    let navGate = new GestureDebouncer();     // left hand → toggle select (fist)
    let execWasFist = false;
    let navWasFist = false;
    let execFistFrames = 0;        // frames right fist has been held
    let navFistFrames = 0;         // frames left fist has been held

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
        const sel = selectedCount(ctx);
        panel.setBody(
            `<div style="display:flex;flex-direction:column;gap:14px">` +
                // big selection counter
                `<div style="font-size:30px;font-weight:700;color:${accent};text-shadow:0 0 12px ${accent}">` +
                    `${sel} <span style="color:rgba(255,255,255,0.45);font-size:16px">selected</span>` +
                `</div>` +
                // focus cursor readout
                `<div style="font-size:13px;color:rgba(255,255,255,0.8)">` +
                    `cursor on shape <b>${fIdx + 1}</b> / ${total} — ` +
                    (onSel
                        ? `<span style="color:${accent}">in selection</span>`
                        : `<span style="color:rgba(255,255,255,0.55)">not selected</span>`) +
                `</div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.55);line-height:1.5">` +
                    (total === 1
                        ? "Close your left fist to select this shape."
                        : "Right fist moves the cursor · left fist adds / removes it.") +
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
            navWasFist = false;
            execFistFrames = 0;
            navFistFrames = 0;
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

            // Right (exec) fist → move the focus cursor to the next shape. Fist must be held for
            // FIST_CONFIRM_FRAMES before the action fires to prevent accidental triggers.
            const execFist = execGate.push(exec && handClosed(exec.world) ? "fist" : "none") === "fist";
            if (execFist) {
                execFistFrames++;
                if (execFistFrames === FIST_CONFIRM_FRAMES) {
                    moveFocus(ctx, 1);
                    paint(ctx);
                }
            } else {
                execFistFrames = 0;
            }

            // Left (nav) hand FIST → toggle the focused shape in/out of the selection. Fist must be
            // held for FIST_CONFIRM_FRAMES before the action fires.
            const navFist = navGate.push(nav && handClosed(nav.world) ? "fist" : "none") === "fist";
            if (navFist) {
                navFistFrames++;
                if (navFistFrames === FIST_CONFIRM_FRAMES) {
                    const f = focusedShape(ctx);
                    if (f) {
                        toggleSelect(ctx, f);
                        paint(ctx);
                    }
                }
            } else {
                navFistFrames = 0;
            }
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
