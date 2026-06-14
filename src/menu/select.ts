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
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { classify, GestureDebouncer } from "../gesture/detect";
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

            // Right (exec) fist (rising edge) → move the focus cursor to the next shape. Each hand's
            // pose feeds the shared 5-frame debouncer — "none" when the hand is gone, so a stale fist
            // never lingers across a tracking gap — and one fist-close = one step.
            const execFist = execGate.push(exec ? classify(exec.landmarks, exec.world, null).name : "none") === "fist";
            if (execFist && !execWasFist) {
                moveFocus(ctx, 1);
                paint(ctx);
            }
            execWasFist = execFist;

            // Left (nav) hand FIST (rising edge) → toggle the focused shape in/out of the selection.
            const navFist = navGate.push(nav ? classify(nav.landmarks, nav.world, null).name : "none") === "fist";
            if (navFist && !navWasFist) {
                const f = focusedShape(ctx);
                if (f) {
                    toggleSelect(ctx, f);
                    paint(ctx);
                }
            }
            navWasFist = navFist;
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
