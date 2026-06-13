// §6.8 + §10 — DESTROY ("eat it"): the right hand makes a sustained PINCH; holding
// it briefly fills an arming meter and fires the finale at the pinch point — an
// optional CSG bite, a crunch, then the dissolve shader consumes whatever geometry
// the user actually sculpted, bursting sparks from the edge. On completion the
// stage advances to CONSUMED.
//
// Paradigm (revised §6.8): "pinch & hold to eat" — chosen over the original
// "fist + bring-to-camera" because a depth lunge reads poorly on webcam and is easy
// to trigger by accident. The right hand drives everything; the left hand only
// picked DESTROY from the radial menu (handled upstream by main.ts).
//
// This module owns its own Sfx + Dissolve instances: the frozen MenuModule.update
// signature carries no Sfx, and Dissolve.startDissolve / the §10.4 crunch both
// require one. A second AudioContext is harmless (WebAudio permits many; sfx.ts
// always falls back to a synthesized tone), and keeping the dependency local means
// no contract or P1 module has to change.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { pinchAmount } from "../gesture/predicates";
import { fingertipToWorld } from "../math/coords";
import { SpatialPanel } from "./spatialPanel";
import { Dissolve } from "../finale/dissolve";
import { biteAt, resetBites } from "../finale/csg";
import { Sfx } from "../audio/sfx";

// MediaPipe landmark index for the index fingertip (§6.8 INDEX_TIP).
const INDEX_TIP = 8;

// Bite cutter radius as a fraction of the mesh bounding-sphere radius (§10.3 "small
// sphere"). A little under half the body so the chomp reads as a distinct bite.
const BITE_RADIUS_FRAC = 0.42;

// §6.8 (revised): the eat is armed by a sustained right-hand PINCH (not a punch
// toward the camera). Pinch closure at/above this fraction counts as "pinching",
// and holding it HOLD_SECONDS fills the arming meter and fires the finale.
const PINCH_ARM = 0.55;
const HOLD_SECONDS = 0.7;

export function createDestroyMenu(): MenuModule {
    // Per-instance state captured in the closure so enter/update/exit share it
    // without a class.
    let panel: SpatialPanel | null = null;
    const dissolve = new Dissolve();
    const sfx = new Sfx();
    // Stable WORLD bite origin, captured at trigger and handed to dissolve (which
    // retains a reference). Owned here so it survives the frame `ctx.scratch` is
    // reused, without a per-frame allocation. Fires at most once per entry.
    const bite_origin = new THREE.Vector3();
    let triggered = false;
    let consumed = false;
    // Seconds the pinch has been held this attempt; fills the arming meter.
    let hold = 0;

    // Repaint the panel to reflect the current phase: idle prompt + arming meter,
    // consuming, or the terminal CONSUMED label. `armed` is 0..1 (how close the fist
    // is to the near threshold) and fills the meter.
    function paintPanel(armed: number): void {
        if (!panel) return;
        const accent = MENU_META[MenuId.DESTROY].accent;
        panel.draw((g, w, h) => {
            g.fillStyle = accent;
            g.font = 'bold 30px "JetBrains Mono", monospace';
            g.textBaseline = "top";
            g.fillText("DESTROY", 28, 26);

            g.font = '18px "JetBrains Mono", monospace';
            g.fillStyle = "#FFFFFF";
            if (consumed) {
                g.fillText("// CONSUMED", 28, 86);
            } else if (triggered) {
                g.fillText("EATING...", 28, 86);
            } else {
                g.fillText("PINCH & HOLD", 28, 86);
                g.fillText("TO EAT IT", 28, 116);
            }

            // Arming meter: how close the fist is to the near threshold (0..1).
            const bar_x = 28;
            const bar_y = h - 56;
            const bar_w = w - 56;
            const bar_h = 18;
            g.strokeStyle = accent;
            g.lineWidth = 2;
            g.strokeRect(bar_x, bar_y, bar_w, bar_h);
            g.fillStyle = accent;
            const fill = triggered ? 1 : Math.max(0, Math.min(1, armed));
            g.fillRect(bar_x + 2, bar_y + 2, (bar_w - 4) * fill, bar_h - 4);
        });
    }

    // Re-place the panel beside the (possibly spinning) mesh.
    function placePanel(ctx: SceneContext): void {
        if (!panel) return;
        ctx.mesh.updateWorldMatrix(true, false);
        ctx.mesh.getWorldPosition(ctx.scratch.v1);
        panel.placeBeside(ctx.scratch.v1, ctx.camera);
    }

    // Fire the §10 finale at the right-hand world position: optional CSG bite, the
    // crunch SFX, then the dissolve. Runs exactly once per DESTROY entry.
    function triggerFinale(ctx: SceneContext, right: HandPose): void {
        // Bite origin = the right index fingertip projected to the object's
        // interaction plane, in WORLD space (what dissolve + csg both expect).
        // Snapshot it into bite_origin *before* biteAt, which mutates ctx.scratch.v1
        // (the projection's output) into the mesh's local space.
        fingertipToWorld(
            right.landmarks[INDEX_TIP],
            ctx.camera,
            ctx.interactionPlaneZ,
            ctx.scratch.ray,
            ctx.scratch.plane,
            ctx.scratch.v1,
        );
        bite_origin.copy(ctx.scratch.v1);

        // §10.4: the eat always crunches. An optional tactile CSG bite (§10.3) takes
        // a chunk first; it no-ops gracefully when disabled, capped, or missed.
        sfx.play("crunch");
        biteAt(ctx, bite_origin, biteRadius(ctx));

        // startDissolve retains a reference to the world bite origin.
        dissolve.startDissolve(ctx, bite_origin, sfx);
        triggered = true;
        paintPanel(1);
    }

    // Bite cutter radius from the mesh's bounding sphere (§10.3).
    function biteRadius(ctx: SceneContext): number {
        const geo = ctx.mesh.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        const r = geo.boundingSphere ? geo.boundingSphere.radius : 1;
        return r * BITE_RADIUS_FRAC;
    }

    return {
        id: MenuId.DESTROY,

        enter(ctx: SceneContext): void {
            triggered = false;
            consumed = false;
            hold = 0;
            // A fresh DESTROY pass may bite again after a director restart (§10.3).
            resetBites();

            panel = new SpatialPanel(MENU_META[MenuId.DESTROY].accent);
            ctx.scene.add(panel.object);
            placePanel(ctx);
            paintPanel(0);
        },

        update(ctx: SceneContext, right: HandPose | null, _left: HandPose | null, dt: number): void {
            placePanel(ctx);

            // Once the finale is running it animates autonomously (~2.2s) regardless
            // of the hand — drive it to completion even if the hand leaves frame.
            if (triggered) {
                dissolve.update(dt);
                if (!consumed && dissolve.isComplete) {
                    consumed = true;
                    ctx.stage = "CONSUMED";
                    paintPanel(1);
                }
                return;
            }

            if (!right) {
                paintPanel(0);
                return;
            }

            // §6.8 (revised) arm condition: a sustained right-hand pinch. While the
            // pinch is held the meter fills over HOLD_SECONDS; releasing resets it.
            // When the meter is full the finale fires at the pinch point.
            const pinch = pinchAmount(right.landmarks);
            if (pinch >= PINCH_ARM) {
                hold += dt;
            } else {
                hold = 0;
            }
            const armed = Math.min(1, hold / HOLD_SECONDS);

            if (armed >= 1) {
                triggerFinale(ctx, right);
            } else {
                paintPanel(armed);
            }
        },

        exit(ctx: SceneContext): void {
            if (panel) {
                ctx.scene.remove(panel.object);
                panel.dispose();
                panel = null;
            }
            // Tear down the dissolve hook + particle system. Safe even if DESTROY was
            // exited before the finale ever triggered (dispose no-ops un-injected).
            dissolve.dispose();
        },
    };
}
