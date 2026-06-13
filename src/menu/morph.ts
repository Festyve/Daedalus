// §6.6 + §8 — MORPH menu: the hero beat (sphere → donut).
//
// The panel shows two tabs:
//   'Squish-to-preset' (default): the right hand squishes its fingers together and
//       the mesh blends toward the authored DONUT target (morphTargetInfluences[0]).
//       fingerSpread → target t via a smooth curve (open hand = 0, tight squeeze = 1),
//       low-passed so the morph feels continuous. Crossing t > 0.95 advances the
//       Director to DONUT (ctx.stage) and fires a one-shot ding.
//   'Free': a real SculptEngine is bound to the mesh and the right hand drives
//       grab / inflate / smooth brushes ON TOP of the morph — so the squish reads as
//       physical hand-sculpting, not a slider. Because three's morph is non-relative
//       (final = base + t·(target − base)), brush edits to the base position attribute
//       compose additively under any t.
//
// Right-hand control map:
//   Squish tab: open hand (3+ fingers) → spread drives t.
//   Free tab:   pinch → Grab (drag), fist → Inflate, open hand → Smooth.
//   A right "peace" sign toggles between the two tabs (edge-triggered, debounced) —
//   distinct from every control pose above so it never fires by accident.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { BrushVerb, MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { classify, fingerSpread } from "../gesture/predicates";
import { fingertipToWorld } from "../math/coords";
import { SculptEngine } from "../sculpt/engine";
import { SpatialPanel } from "./spatialPanel";
import { Sfx } from "../audio/sfx";

type MorphTab = "squish" | "free";

// Squish → t curve. fingerSpread is ~0.55 (tight squeeze) .. ~1.6 (splayed open),
// normalized by hand scale. We map a high spread to t=0 and a tight one to t=1 with a
// smoothstep so the donut emerges gently at the ends and crisply through the middle.
const SPREAD_OPEN = 1.35;   // spread at/above this → t = 0 (hand splayed)
const SPREAD_TIGHT = 0.60;  // spread at/below this → t = 1 (fingers crushed together)

// Low-pass factor for t (per-frame lerp toward the raw target). Higher = snappier.
// Tuned so the squish tracks the hand without jitter at ~60fps.
const T_SMOOTH = 0.18;

// Donut-complete threshold (mirrors Director.MORPH_DONE) for the one-shot ding + stage.
const DONUT_T = 0.95;

// Free-mode brush sizing, in mesh object space (the mesh is ~unit radius).
const BRUSH_RADIUS = 0.45;
const INFLATE_STRENGTH = 0.05 * BRUSH_RADIUS;

// Right-hand pose gates (from predicates.classify):
const PINCH_ON = 0.7;   // pinch closure above this engages Grab
const TAB_DEBOUNCE_MS = 600; // min gap between peace-toggle tab switches

// smoothstep(0..1) — C1 ease used to shape the spread→t response.
function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

// Map a normalized fingertip spread to a morph target t in [0,1]: open hand → 0,
// crushed → 1. SPREAD_OPEN > SPREAD_TIGHT, so we invert the smoothstep.
function spreadToTarget(spread: number): number {
    return 1 - smoothstep(SPREAD_TIGHT, SPREAD_OPEN, spread);
}

class MorphMenu implements MenuModule {
    readonly id = MenuId.MORPH;

    private panel: SpatialPanel | null = null;
    private engine: SculptEngine | null = null;
    // Created on first enter() (i.e. after the user-gesture that opened this menu) so
    // we never construct an AudioContext before the page has had a user interaction.
    private sfx: Sfx | null = null;

    private tab: MorphTab = "squish";
    private dingFired = false;
    private peaceLatched = false;
    private lastTabSwitchMs = 0;

    // Free-mode drag tracking: previous fingertip in mesh OBJECT space (for Grab),
    // and whether we currently hold a valid previous sample.
    private readonly prevObjPoint = new THREE.Vector3();
    private hasPrevObjPoint = false;

    // Local scratch (object-space fingertip + drag) so we never touch ctx.scratch's
    // semantics across the world→object conversion.
    private readonly objPoint = new THREE.Vector3();
    private readonly dragVec = new THREE.Vector3();

    enter(ctx: SceneContext): void {
        const accent = MENU_META[MenuId.MORPH].accent;
        this.panel = new SpatialPanel(accent);
        ctx.scene.add(this.panel.object);
        if (!this.sfx) this.sfx = new Sfx();

        this.tab = "squish";
        this.dingFired = ctx.morphT > DONUT_T; // don't re-ding if we re-enter past the gate
        this.peaceLatched = false;
        this.hasPrevObjPoint = false;

        this.placePanel(ctx);
        this.paint(ctx, null);
    }

    update(ctx: SceneContext, right: HandPose | null, _left: HandPose | null, _dt: number): void {
        // Tab toggle: a right "peace" sign, edge-triggered + time-debounced.
        if (right) this.handleTabToggle(right);
        else this.peaceLatched = false;

        if (this.tab === "squish") {
            this.updateSquish(ctx, right);
        } else {
            this.updateFree(ctx, right);
        }

        this.placePanel(ctx);
        this.paint(ctx, right);
    }

    exit(ctx: SceneContext): void {
        if (this.panel) {
            ctx.scene.remove(this.panel.object);
            this.panel.dispose();
            this.panel = null;
        }
        if (this.engine) {
            this.engine.dispose();
            this.engine = null;
            ctx.bvh = null;
        }
        this.hasPrevObjPoint = false;
    }

    // ---- Squish-to-preset (the donut demo) -------------------------------------

    private updateSquish(ctx: SceneContext, right: HandPose | null): void {
        // Only an open-ish hand drives the squish; a fist/pinch leaves t parked so the
        // user can rest without the donut sliding back.
        let target = ctx.morphT;
        if (right) {
            const g = classify(right.landmarks);
            if (g.extended >= 3 || g.name === "open") {
                target = spreadToTarget(fingerSpread(right.landmarks));
            }
        }

        // Low-pass t toward the target, then drive the blend shape.
        const t = ctx.morphT + (target - ctx.morphT) * T_SMOOTH;
        this.applyMorph(ctx, t);
    }

    // ---- Free morph (real sculpt brushes on top of the blend) ------------------

    private updateFree(ctx: SceneContext, right: HandPose | null): void {
        const engine = this.ensureEngine(ctx);

        if (!right) {
            this.hasPrevObjPoint = false;
            return;
        }

        const g = classify(right.landmarks);

        // World fingertip (index tip = landmark 8) → mesh object space.
        fingertipToWorld(
            right.landmarks[8],
            ctx.camera,
            ctx.interactionPlaneZ,
            ctx.scratch.ray,
            ctx.scratch.plane,
            ctx.scratch.v1,
        );
        ctx.mesh.updateWorldMatrix(true, false);
        this.objPoint.copy(ctx.scratch.v1);
        ctx.mesh.worldToLocal(this.objPoint);

        // Choose the brush from the right-hand pose.
        let verb: BrushVerb | null = null;
        if (g.pinch > PINCH_ON) verb = BrushVerb.Grab;
        else if (g.name === "fist") verb = BrushVerb.Inflate;
        else if (g.extended >= 3 || g.name === "open") verb = BrushVerb.Smooth;

        if (verb === null) {
            this.hasPrevObjPoint = false;
            return;
        }

        if (verb === BrushVerb.Grab) {
            // Grab drags vertices by the fingertip delta since last frame.
            if (this.hasPrevObjPoint) {
                this.dragVec.subVectors(this.objPoint, this.prevObjPoint);
                engine.stroke(this.objPoint, BRUSH_RADIUS, BrushVerb.Grab, { drag: this.dragVec });
            }
        } else if (verb === BrushVerb.Inflate) {
            engine.stroke(this.objPoint, BRUSH_RADIUS, BrushVerb.Inflate, { strength: INFLATE_STRENGTH });
        } else {
            engine.stroke(this.objPoint, BRUSH_RADIUS, BrushVerb.Smooth);
        }

        this.prevObjPoint.copy(this.objPoint);
        this.hasPrevObjPoint = true;
    }

    // Lazily build the sculpt engine and publish its BVH on the context.
    private ensureEngine(ctx: SceneContext): SculptEngine {
        if (!this.engine) {
            this.engine = new SculptEngine(ctx.mesh);
            ctx.bvh = this.engine.bvh;
        }
        return this.engine;
    }

    // ---- shared morph drive ----------------------------------------------------

    // Write t into both the context and the blend shape, and fire the donut milestone
    // exactly once as t crosses the completion threshold.
    private applyMorph(ctx: SceneContext, t: number): void {
        const clamped = Math.min(1, Math.max(0, t));
        ctx.morphT = clamped;

        const influences = ctx.mesh.morphTargetInfluences;
        if (influences && influences.length > 0) influences[0] = clamped;

        if (!this.dingFired && clamped > DONUT_T) {
            this.dingFired = true;
            ctx.stage = "DONUT"; // Director milestone (also picked up via ctx.morphT in P3)
            this.sfx?.play("ding");
        } else if (this.dingFired && clamped < DONUT_T) {
            // Re-arm the ding if the user opens back up below the threshold.
            this.dingFired = false;
        }
    }

    // ---- tab toggle ------------------------------------------------------------

    private handleTabToggle(right: HandPose): void {
        const g = classify(right.landmarks);
        const isPeace = g.name === "peace";
        if (isPeace && !this.peaceLatched) {
            const now = performance.now();
            if (now - this.lastTabSwitchMs >= TAB_DEBOUNCE_MS) {
                this.tab = this.tab === "squish" ? "free" : "squish";
                this.lastTabSwitchMs = now;
                this.hasPrevObjPoint = false; // reset drag continuity on mode change
            }
            this.peaceLatched = true;
        } else if (!isPeace) {
            this.peaceLatched = false;
        }
    }

    // ---- panel ----------------------------------------------------------------

    private placePanel(ctx: SceneContext): void {
        if (!this.panel) return;
        ctx.mesh.updateWorldMatrix(true, false);
        ctx.mesh.getWorldPosition(ctx.scratch.v2);
        this.panel.placeBeside(ctx.scratch.v2, ctx.camera);
    }

    // Repaint the card: tab headers, the active paradigm's readout, and a t meter.
    private paint(ctx: SceneContext, right: HandPose | null): void {
        if (!this.panel) return;
        const accent = MENU_META[MenuId.MORPH].accent;
        const t = ctx.morphT;
        const tab = this.tab;
        const isDonut = t > DONUT_T;

        this.panel.draw((g, w) => {
            // Title.
            g.fillStyle = accent;
            g.font = 'bold 30px "JetBrains Mono", monospace';
            g.fillText("MORPH", 24, 22);

            // Tab headers (active = accent, inactive = dim).
            g.font = '18px "JetBrains Mono", monospace';
            const squishActive = tab === "squish";
            g.fillStyle = squishActive ? accent : "rgba(255,255,255,0.4)";
            g.fillText("[SQUISH]", 24, 70);
            g.fillStyle = !squishActive ? accent : "rgba(255,255,255,0.4)";
            g.fillText("[FREE]", 210, 70);

            // Preset / mode line.
            g.fillStyle = "rgba(255,255,255,0.7)";
            g.font = '16px "JetBrains Mono", monospace';
            if (squishActive) {
                g.fillText("preset: DONUT", 24, 112);
                g.fillText("squish fingers → morph", 24, 138);
            } else {
                g.fillText("pinch grab · fist inflate", 24, 112);
                g.fillText("open smooth", 24, 138);
            }

            // t readout + bar.
            g.fillStyle = isDonut ? accent : "#FFFFFF";
            g.font = 'bold 22px "JetBrains Mono", monospace';
            g.fillText(`t = ${t.toFixed(2)}`, 24, 190);

            const barX = 24;
            const barY = 226;
            const barW = w - 48;
            const barH = 22;
            g.strokeStyle = "rgba(255,255,255,0.35)";
            g.lineWidth = 2;
            g.strokeRect(barX, barY, barW, barH);
            g.fillStyle = accent;
            g.fillRect(barX + 2, barY + 2, Math.max(0, (barW - 4) * t), barH - 4);

            // Live label: // DONUT once complete, mirroring the storyboard beat.
            g.font = 'bold 26px "JetBrains Mono", monospace';
            g.fillStyle = isDonut ? accent : "rgba(255,255,255,0.45)";
            g.fillText(isDonut ? "// DONUT" : "// SPHERE", 24, 274);

            // Current spread (squish tab only) so the user can see their hand reading.
            if (squishActive && right) {
                const spread = fingerSpread(right.landmarks);
                g.font = '14px "JetBrains Mono", monospace';
                g.fillStyle = "rgba(255,255,255,0.5)";
                g.fillText(`spread ${spread.toFixed(2)}`, 24, 316);
            }
        });
    }
}

export function createMorphMenu(): MenuModule {
    return new MorphMenu();
}
