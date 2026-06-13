// DESTROY tool (multi-shape, §5 extended). Deletes ALL currently SELECTED shapes on a pinch
// (rising edge); the selection becomes empty (or, if other shapes remain, nothing selected).
// A pinch is required — entering the tool never destroys anything on its own — so it can't fire
// by accident just by landing on the tile.
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { classify } from "../gesture/detect";
import { shapeCount, selectedShapes, selectedCount, removeShape } from "../core/shapes";
import { sfx } from "../audio/sfx";

// Pinch closure above which a pinch counts as "closed" — gates the destroy rising edge.
const PINCH_ON = 0.7;

export function createDestroyMenu(): MenuModule {
    const accent = MENU_META[MenuId.DESTROY].accent;
    const label = MENU_META[MenuId.DESTROY].label;

    let panel: Panel | null = null;
    let wasPinched = false; // rising-edge tracking so one pinch destroys one shape

    function paint(ctx: SceneContext): void {
        if (!panel) return;
        const total = shapeCount(ctx);
        const sel = selectedCount(ctx);
        const body = total === 0
            ? `Nothing to destroy — the world is empty.`
            : sel === 0
                ? `No shapes selected. Use <b>SELECT</b> to pick the shapes you want to remove.`
                : `<b style="color:${accent}">Pinch</b> your exec (right) hand to destroy the ` +
                  `<b>${sel}</b> selected shape${sel === 1 ? "" : "s"}.` +
                  `<br><span style="color:rgba(255,255,255,0.5)">${total} shape${total === 1 ? "" : "s"} in the scene.</span>`;
        panel.setBody(
            `<div style="font-size:12px;color:rgba(255,255,255,0.8);line-height:1.6">${body}</div>`,
        );
    }

    return {
        id: MenuId.DESTROY,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            wasPinched = false;
            paint(ctx);
            panel.show();
        },

        update(ctx: SceneContext, exec: HandPose | null, _nav: HandPose | null, _dt: number): void {
            if (!panel) return;
            if (!exec) {
                wasPinched = false;
                return;
            }
            const g = classify(exec.landmarks, exec.world);
            const pinchedNow = g.pinch > PINCH_ON;
            if (pinchedNow && !wasPinched && selectedCount(ctx) > 0) {
                // Copy first — removeShape mutates ctx.selected as it deletes each shape.
                for (const m of [...selectedShapes(ctx)]) removeShape(ctx, m);
                sfx.ping();
                paint(ctx);
            }
            wasPinched = pinchedNow;
        },

        exit(_ctx: SceneContext): void {
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            wasPinched = false;
        },
    };
}
