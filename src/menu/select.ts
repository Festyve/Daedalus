// SELECT tool (multi-selection, §5 extended). Builds the SELECTION SET that the edit tools act
// on. A horizontal SWIPE of the navigation (left) index finger moves a FOCUS CURSOR through the
// shapes; a PINCH toggles the focused shape in/out of the selection. The focused shape pulses so
// you can see what a pinch will toggle; selected shapes are drawn bright, the rest ghosted (see
// core/shapes.refreshHighlight). The selection persists after you leave SELECT, so the next tool
// edits the shapes you chose, and the on-screen counter (ui/chrome) shows how many are selected.
//
// One swipe = one cursor step via the shared SwipeDetector (gesture/swipe.ts); one pinch = one
// toggle via rising-edge latching.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext, Vec3 } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { classify } from "../gesture/detect";
import { SwipeDetector } from "../gesture/swipe";
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

// Rising-edge pinch closure that toggles the focused shape. Lowered (vs the old 0.7) so the
// non-dominant nav hand commits a toggle as easily as the exec hand applies an edit.
const PINCH_TOGGLE = 0.6;

// Focus-cursor pulse colour (the shape a pinch would toggle shimmers toward white).
const WHITE = new THREE.Color(0xffffff);

// One reusable Vec3 (plain object — landmarks are bare Vec3, not THREE.Vector3).
function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

export function createSelectMenu(): MenuModule {
    const accent = MENU_META[MenuId.SELECT].accent;
    const label = MENU_META[MenuId.SELECT].label;

    let panel: Panel | null = null;
    let hasPrev = false;          // whether prevLandmarks holds a valid previous frame
    let wasPinched = false;       // pinch rising-edge latch
    let pulseMs = 0;              // focus-cursor pulse phase
    const swipe = new SwipeDetector();

    // Reused previous-frame nav landmarks for the swipe velocity (no per-frame alloc).
    const prevLandmarks: Vec3[] = Array.from({ length: 21 }, blankVec);

    function snapshot(lm: Vec3[]): void {
        const n = Math.min(lm.length, prevLandmarks.length);
        for (let i = 0; i < n; i++) {
            prevLandmarks[i].x = lm[i].x;
            prevLandmarks[i].y = lm[i].y;
            prevLandmarks[i].z = lm[i].z;
        }
        hasPrev = true;
    }

    // Make the focused shape shimmer toward white so the user can see what a pinch will toggle —
    // even when it is currently unselected (then we also lift its opacity above the ghost floor).
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
                    `${sel} <span style="color:rgba(255,255,255,0.45);font-size:16px">selected</span></div>` +
                // focus cursor readout
                `<div style="font-size:13px;color:rgba(255,255,255,0.8)">` +
                    `cursor on shape <b>${fIdx + 1}</b> / ${total} — ` +
                    (onSel
                        ? `<span style="color:${accent}">in selection</span>`
                        : `<span style="color:rgba(255,255,255,0.55)">not selected</span>`) +
                `</div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.55);line-height:1.5">` +
                    (total === 1
                        ? "Pinch to select / deselect this shape. Spawn more shapes to build a multi-selection."
                        : "Swipe your nav (left) index finger to move the cursor · pinch to add / remove the cursor's shape.") +
                `</div>` +
            `</div>`,
        );
    }

    return {
        id: MenuId.SELECT,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            hasPrev = false;
            wasPinched = false;
            pulseMs = 0;
            swipe.reset();
            // Park the focus cursor on the primary selection if there is one.
            if (ctx.mesh) ctx.focusIndex = Math.max(0, allShapes(ctx).indexOf(ctx.mesh));
            refreshHighlight(ctx);
            paint(ctx);
            panel.show();
        },

        // The nav (left) hand drives selection here; the exec hand is unused.
        update(ctx: SceneContext, _exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel) return;
            pulseMs += dt;

            // Re-assert the tier highlight each frame, then shimmer the focused shape on top.
            refreshHighlight(ctx);
            applyFocusPulse(ctx);

            if (!nav) {
                hasPrev = false;
                wasPinched = false;
                swipe.reset();
                return;
            }

            const g = classify(nav.landmarks, nav.world, hasPrev ? prevLandmarks : null);

            // Swipe → move the focus cursor one shape (g.vx > 0 = rightward → next).
            const dir = swipe.update(g.vx, dt);
            if (dir !== 0) {
                moveFocus(ctx, dir > 0 ? 1 : -1);
                paint(ctx);
            }

            // Pinch (rising edge) → toggle the focused shape in/out of the selection.
            const pinchedNow = g.pinch > PINCH_TOGGLE;
            if (pinchedNow && !wasPinched) {
                const f = focusedShape(ctx);
                if (f) {
                    toggleSelect(ctx, f);
                    paint(ctx);
                }
            }
            wasPinched = pinchedNow;

            snapshot(nav.landmarks);
        },

        exit(ctx: SceneContext): void {
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            hasPrev = false;
            // Restore the plain tier highlight (drop the focus shimmer) for the next tool.
            refreshHighlight(ctx);
        },
    };
}
