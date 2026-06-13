// SELECT tool (multi-shape, §5 extended). When several shapes share the scene, this is
// how you choose which one the edit tools act on: a horizontal SWIPE of the navigation
// (left) index finger cycles the selection through the shape set. The selected shape is
// drawn bright; the others are ghosted (see core/shapes.refreshHighlight). The selection
// persists after you leave SELECT, so the next tool you pick edits the shape you chose.
//
// One swipe = one step: a committed swipe arms a short cooldown + the usual re-arm gate,
// so a single physical sweep never double-cycles (same discipline as the tool carousel).
import type { HandPose, MenuModule, SceneContext, Vec3 } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { classify } from "../gesture/detect";
import { allShapes, shapeCount, cycleSelection, refreshHighlight } from "../core/shapes";

// |g.vx| (units of S/frame) that commits a selection swipe — matches the carousel feel.
const SWIPE_VX = 0.3;
// |g.vx| must drop below this before another swipe can arm (one sweep = one step).
const REARM_VX = 0.12;
// Lockout after a committed swipe (ms) so velocity wobble can't double-cycle.
const SWIPE_COOLDOWN_MS = 220;

// One reusable Vec3 (plain object — landmarks are bare Vec3, not THREE.Vector3).
function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

export function createSelectMenu(): MenuModule {
    const accent = MENU_META[MenuId.SELECT].accent;
    const label = MENU_META[MenuId.SELECT].label;

    let panel: Panel | null = null;
    let armed = true;            // re-arm gate so one sweep steps once
    let cooldownMs = 0;          // post-step lockout
    let hasPrev = false;         // whether prevLandmarks holds a valid previous frame

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
        const idx = ctx.mesh ? allShapes(ctx).indexOf(ctx.mesh) : -1;
        const single = total === 1;
        panel.setBody(
            `<div style="display:flex;flex-direction:column;gap:12px">` +
                `<div style="font-size:30px;font-weight:700;color:${accent};text-shadow:0 0 12px ${accent}">` +
                    `${idx + 1} <span style="color:rgba(255,255,255,0.4);font-size:18px">/ ${total}</span></div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.55);line-height:1.5">` +
                    (single
                        ? "Spawn more shapes to switch between them."
                        : "Swipe your nav (left) index finger left / right to switch the selected shape.") +
                `</div>` +
            `</div>`,
        );
    }

    return {
        id: MenuId.SELECT,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            armed = true;
            cooldownMs = 0;
            hasPrev = false;
            refreshHighlight(ctx); // make sure the current selection reads clearly
            paint(ctx);
            panel.show();
        },

        // The nav (left) hand drives selection here; the exec hand is unused.
        update(ctx: SceneContext, _exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel) return;
            if (cooldownMs > 0) cooldownMs = Math.max(0, cooldownMs - dt);

            if (!nav) {
                hasPrev = false;
                return;
            }

            const g = classify(nav.landmarks, nav.world, hasPrev ? prevLandmarks : null);
            const speed = Math.abs(g.vx);
            if (armed && cooldownMs <= 0 && speed >= SWIPE_VX) {
                cycleSelection(ctx, g.vx > 0 ? 1 : -1); // swipe right → next, left → previous
                armed = false;
                cooldownMs = SWIPE_COOLDOWN_MS;
                paint(ctx);
            } else if (speed < REARM_VX) {
                armed = true;
            }

            snapshot(nav.landmarks);
        },

        exit(_ctx: SceneContext): void {
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            hasPrev = false;
            // Highlight is intentionally left applied so the selected shape stays legible
            // while the next (edit) tool operates on it.
        },
    };
}
