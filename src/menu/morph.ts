// §5.5 + §7.2 — MORPH tool: the play-doh gesture (sphere → donut).
//
// Both hands curl into a grab pose around the object and jiggle. Direction does not
// matter — any random motion advances the morph. Each grabbed frame we measure the
// total world-space travel of the two wrists and accumulate it into a progress scalar:
//
//     travel = Σ ( |Δ wristL| + |Δ wristR| )   frame to frame, while both hands grab
//     t      = clamp(travel / FULL_MOTION, 0, 1)
//     morphTargetInfluences[0] = smoothstep(t)
//
// The morph is monotonic: motion only adds, so once jiggled to a donut it stays there
// (releasing the grab just parks progress until the next grab resumes). The object
// never moves: only its blend shape changes.
//
// When t > 0.95 is sustained for > 500 ms, a one-shot ding fires and the panel label
// snaps to `// DONUT`. Dropping back below the threshold re-arms both.
//
// Real brush deformation runs ADDITIVELY on top of the morph: when both hands grab
// (fist pose) the SculptEngine applies an Inflate stroke at the hands' midpoint. Because
// three's morph is non-relative (final = base + t·(target − base)), brush edits to the
// base position attribute compose under any t — so the squish reads as physical
// hand-sculpting, not a slider.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { BrushVerb, MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { classify } from "../gesture/detect";
import { fingertipToWorld } from "../math/coords";
import { SculptEngine } from "../sculpt/engine";
import { Panel } from "./panel";
import { sfx } from "../audio/sfx";

// MediaPipe wrist landmark index (§3). The morph is driven by the two wrists.
const WRIST = 0;

// Donut-complete threshold + the dwell it must be sustained for before the milestone
// fires (SPEC §5.5: t > 0.95 for > 500 ms).
const DONUT_T = 0.95;
const DONUT_DWELL_MS = 500;

// Total wrist travel (world units, summed across both hands) that maps to a full
// sphere→donut morph. The icosphere is ~unit radius, so this is a few hand-scales of
// jiggling — a modest random shake reaches t=1 quickly.
const FULL_MOTION = 3.0;

// Both hands must read as a grab (fist) for the motion / brush to engage. Below this
// pinch-amount floor on either hand we still allow grab via the fist pose, but a loose
// open hand parks the morph so the user can rest without advancing it.
const GRAB_PINCH = 0.4;

// Additive brush sizing in mesh object space (the icosphere is ~unit radius).
const BRUSH_RADIUS = 0.45;
const INFLATE_STRENGTH = 0.012 * BRUSH_RADIUS;

// smoothstep(0..1) — quintic "smootherstep" ease applied to the linear angle ratio
// so the donut emerges gently at the ends and crisply through the middle (SPEC §5.5).
// Quintic (6t⁵−15t⁴+10t³) is C2: both first AND second derivatives vanish at t=0 and
// t=1, so the blend has zero acceleration at the seams — the morph slides in and out
// with no linear kink where motion starts or finishes (SPEC §14.4: eased, nothing
// bouncy). It is monotonic on [0,1] and pins the endpoints (0→0, 1→1) exactly.
function smoothstep(x: number): number {
    const t = Math.min(1, Math.max(0, x));
    return t * t * t * (t * (t * 6 - 15) + 10);
}

class MorphMenu implements MenuModule {
    readonly id = MenuId.MORPH;

    readonly panel: HTMLElement;
    private readonly card: Panel;
    private engine: SculptEngine | null = null;

    // Cumulative wrist travel in world units (summed across both hands; monotonic).
    private travel = 0;
    // Previous frame's wrist world positions on the interaction plane (XZ), kept as
    // scalars for zero per-frame allocation. haveSample is false until the first grabbed
    // frame, or after the grab is released, so we never count the released gap as motion.
    private prevLx = 0;
    private prevLz = 0;
    private prevRx = 0;
    private prevRz = 0;
    private haveSample = false;
    private grabbing = false;

    // Donut milestone dwell tracking + one-shot latch.
    private dwellMs = 0;
    private dingFired = false;

    constructor() {
        const accent = MENU_META[MenuId.MORPH].accent;
        this.card = new Panel({ title: "MORPH", accent });
        this.panel = this.card.el;
    }

    enter(ctx: SceneContext): void {
        // Re-seed travel from the current morph so re-entering the tool does not jump.
        this.travel = ctx.morphT * FULL_MOTION;
        this.haveSample = false;
        this.grabbing = false;
        this.dwellMs = 0;
        // Don't re-ding if we re-enter already past the gate.
        this.dingFired = ctx.morphT > DONUT_T;

        this.card.show();
        this.paint(ctx);
    }

    update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
        // World starts empty — no mesh means nothing to morph. Park all motion state so
        // we resume cleanly once a shape exists (SPEC §5.1 / hard rule 7).
        if (!ctx.mesh) {
            this.haveSample = false;
            this.grabbing = false;
            this.paint(ctx);
            return;
        }

        // Pair the two hands by handedness regardless of which slot the router filled.
        const { left, right } = this.resolveHands(exec, nav);

        if (left && right && this.bothGrab(left, right)) {
            this.driveMotion(ctx, left, right, dt);
            this.driveBrush(ctx, left, right);
        } else {
            // Lost the grab: drop the motion anchor so the next grab resumes from the
            // current t rather than counting the gap accrued while released as travel.
            this.haveSample = false;
            this.grabbing = false;
            this.dwellMs = 0;
        }

        this.paint(ctx);
    }

    exit(ctx: SceneContext): void {
        this.card.hide();
        if (this.engine) {
            this.engine.dispose();
            this.engine = null;
            ctx.bvh = null;
        }
        this.haveSample = false;
        this.grabbing = false;
    }

    // ---- motion → t ------------------------------------------------------------

    // Measure how far the two wrists travelled since last frame (any direction) and add
    // that distance to the cumulative travel, then map travel → t → morph.
    private driveMotion(ctx: SceneContext, left: HandPose, right: HandPose, dt: number): void {
        // Both wrists → world on the shared interaction plane (same frame as the object
        // center). Reuse ctx.scratch — zero per-frame allocation (hard rule 4).
        const wl = fingertipToWorld(
            left.landmarks[WRIST], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v1,
        );
        const lx = wl.x, lz = wl.z;
        const wr = fingertipToWorld(
            right.landmarks[WRIST], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v2,
        );
        const rx = wr.x, rz = wr.z;

        if (this.haveSample) {
            // |Δ wristL| + |Δ wristR| on XZ — magnitude only, so direction never matters
            // and any random jiggle advances the morph.
            const ldx = lx - this.prevLx, ldz = lz - this.prevLz;
            const rdx = rx - this.prevRx, rdz = rz - this.prevRz;
            this.travel += Math.hypot(ldx, ldz) + Math.hypot(rdx, rdz);
        }
        this.prevLx = lx; this.prevLz = lz;
        this.prevRx = rx; this.prevRz = rz;
        this.haveSample = true;
        this.grabbing = true;

        // Map cumulative travel → t. Monotonic: travel only grows, so the donut is
        // reached fast and stays put.
        const t = Math.min(1, Math.max(0, this.travel / FULL_MOTION));
        this.applyMorph(ctx, t, dt);
    }

    // Write t into the context and the blend shape, and fire the donut milestone once
    // t > 0.95 has been sustained for > 500 ms. smoothstep shapes the influence; the raw
    // t (and its travel) stay linear (SPEC §5.5).
    private applyMorph(ctx: SceneContext, t: number, dt: number): void {
        ctx.morphT = t;

        const influences = ctx.mesh!.morphTargetInfluences;
        if (influences && influences.length > 0) influences[0] = smoothstep(t);

        if (t > DONUT_T) {
            this.dwellMs += dt;
            if (!this.dingFired && this.dwellMs >= DONUT_DWELL_MS) {
                this.dingFired = true;
                ctx.stage = "DONUT"; // Director milestone (also derivable from ctx.morphT).
                sfx.ding();
            }
        } else {
            // Re-arm the ding the moment we drop back below the gate.
            this.dwellMs = 0;
            this.dingFired = false;
        }
    }

    // ---- additive brush --------------------------------------------------------

    // Run a real Inflate stroke at the hands' midpoint, additively on top of the morph
    // (SPEC §5.5 / §7.2). The brush edits the base position attribute, which composes
    // under any morph influence.
    private driveBrush(ctx: SceneContext, left: HandPose, right: HandPose): void {
        const engine = this.ensureEngine(ctx);
        const mesh = ctx.mesh!;

        // Midpoint of the two wrists in world → mesh object space.
        const wl = fingertipToWorld(
            left.landmarks[WRIST], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v1,
        );
        const wr = fingertipToWorld(
            right.landmarks[WRIST], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v2,
        );
        const mid = ctx.scratch.v3.copy(wl).add(wr).multiplyScalar(0.5);

        mesh.updateWorldMatrix(true, false);
        mesh.worldToLocal(mid);

        engine.applyBrush(BrushVerb.Inflate, mid, BRUSH_RADIUS, INFLATE_STRENGTH, ctx.scratch);
    }

    // Lazily build the sculpt engine over the active mesh and publish its BVH.
    private ensureEngine(ctx: SceneContext): SculptEngine {
        if (!this.engine || this.engine.mesh !== ctx.mesh) {
            if (this.engine) this.engine.dispose();
            this.engine = new SculptEngine(ctx.mesh!);
            ctx.bvh = this.engine.bvh;
        }
        return this.engine;
    }

    // ---- hand resolution -------------------------------------------------------

    // Sort the router's two hands into { left, right } by handedness, tolerant of which
    // slot (exec/nav) each arrived in.
    private resolveHands(
        a: HandPose | null,
        b: HandPose | null,
    ): { left: HandPose | null; right: HandPose | null } {
        let left: HandPose | null = null;
        let right: HandPose | null = null;
        if (a) (a.handedness === "Left" ? (left = a) : (right = a));
        if (b) (b.handedness === "Left" ? (left = b) : (right = b));
        return { left, right };
    }

    // Both hands must read as a grab: a fist, or a near-pinched curl. An open palm on
    // either hand parks the morph (the user can rest without unwinding).
    private bothGrab(left: HandPose, right: HandPose): boolean {
        return this.isGrab(left) && this.isGrab(right);
    }

    private isGrab(hand: HandPose): boolean {
        const g = classify(hand.landmarks, hand.world);
        return g.name === "fist" || g.pinch > GRAB_PINCH;
    }

    // ---- panel -----------------------------------------------------------------

    private paint(ctx: SceneContext): void {
        const accent = MENU_META[MenuId.MORPH].accent;
        const t = ctx.morphT;
        const isDonut = this.dingFired;
        const pct = Math.round(t * 100);
        const label = isDonut ? "// DONUT" : "// SPHERE";
        const labelColor = isDonut ? accent : "rgba(255,255,255,0.45)";
        const stateColor = this.grabbing ? accent : "rgba(255,255,255,0.4)";
        const stateText = this.grabbing ? "MORPHING" : "IDLE";

        this.card.setBody(
            `<div style="display:flex;flex-direction:column;gap:14px">` +
                `<div style="font-size:13px;color:${stateColor};letter-spacing:0.08em">${stateText}</div>` +
                `<div style="font-size:26px;font-weight:700;color:${t > DONUT_T ? accent : "#fff"}">t = ${t.toFixed(2)}</div>` +
                `<div style="height:14px;border:0.5px solid rgba(255,255,255,0.35);border-radius:7px;overflow:hidden">` +
                    `<div style="height:100%;width:${pct}%;background:${accent};box-shadow:0 0 10px ${accent}"></div>` +
                `</div>` +
                `<div style="font-size:24px;font-weight:700;color:${labelColor};text-shadow:0 0 10px ${labelColor}">${label}</div>` +
            `</div>`,
        );
        this.card.setInstructions("");
    }
}

export function createMorphMenu(): MenuModule {
    return new MorphMenu();
}
