// §5.5 + §7.2 — MORPH tool: the play-doh gesture (sphere → donut).
//
// Both hands curl into a grab pose around the object. The user orbits their hands
// around the object center in a circular path (viewed from above, on the XZ plane).
// We track the heading of the (wristL → wristR) vector on XZ and accumulate its
// signed, unwrapped angular change frame to frame:
//
//     angle_traveled = Σ Δθ   where θ = atan2(dz, dx) of (wristR − wristL) on XZ
//     t              = clamp(angle_traveled / 2π, 0, 1)
//     morphTargetInfluences[0] = smoothstep(t)
//
// The motion is proportional and REVERSIBLE — unwinding the orbit drives the angle
// (and therefore t) back down. The object never moves: only its blend shape changes.
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

// MediaPipe wrist landmark index (§3). The orbit is driven by the two wrists.
const WRIST = 0;

// Donut-complete threshold + the dwell it must be sustained for before the milestone
// fires (SPEC §5.5: t > 0.95 for > 500 ms).
const DONUT_T = 0.95;
const DONUT_DWELL_MS = 500;

// A full 2π orbit of the hands maps to a full sphere→donut morph (SPEC §5.5).
const FULL_TURN = Math.PI * 2;

// Both hands must read as a grab (fist) for the orbit / brush to engage. Below this
// pinch-amount floor on either hand we still allow grab via the fist pose, but a loose
// open hand parks the morph so the user can rest without unwinding.
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

// Shortest signed angular difference a − b, wrapped to (−π, π]. Lets the cumulative
// orbit integrate small per-frame deltas without jumping at the ±π seam.
function angleDelta(a: number, b: number): number {
    let d = a - b;
    while (d > Math.PI) d -= FULL_TURN;
    while (d < -Math.PI) d += FULL_TURN;
    return d;
}

class MorphMenu implements MenuModule {
    readonly id = MenuId.MORPH;

    readonly panel: HTMLElement;
    private readonly card: Panel;
    private engine: SculptEngine | null = null;

    // Cumulative orbit, in radians (signed; can go negative when unwinding past start).
    private angleTraveled = 0;
    // Previous frame's (wristL → wristR) heading on XZ, or null when we have no orbit
    // sample yet (first grabbed frame, or grab released).
    private prevHeading: number | null = null;
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
        // Re-seed the orbit from the current morph so re-entering the tool does not jump.
        this.angleTraveled = ctx.morphT * FULL_TURN;
        this.prevHeading = null;
        this.grabbing = false;
        this.dwellMs = 0;
        // Don't re-ding if we re-enter already past the gate.
        this.dingFired = ctx.morphT > DONUT_T;

        this.card.show();
        this.paint(ctx);
    }

    update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
        // World starts empty — no mesh means nothing to morph. Park all orbit state so
        // we resume cleanly once a shape exists (SPEC §5.1 / hard rule 7).
        if (!ctx.mesh) {
            this.prevHeading = null;
            this.grabbing = false;
            this.paint(ctx);
            return;
        }

        // Pair the two hands by handedness regardless of which slot the router filled.
        const { left, right } = this.resolveHands(exec, nav);

        if (left && right && this.bothGrab(left, right)) {
            this.driveOrbit(ctx, left, right, dt);
            this.driveBrush(ctx, left, right);
        } else {
            // Lost the grab: drop the orbit anchor so the next grab resumes from the
            // current t rather than snapping by the gap accrued while released.
            this.prevHeading = null;
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
        this.prevHeading = null;
        this.grabbing = false;
    }

    // ---- orbit → t -------------------------------------------------------------

    // Track the heading of the (wristL → wristR) vector on the XZ plane and integrate
    // its signed change into the cumulative orbit, then map orbit → t → morph.
    private driveOrbit(ctx: SceneContext, left: HandPose, right: HandPose, dt: number): void {
        // Both wrists → world on the shared interaction plane (same frame as the object
        // center). Reuse ctx.scratch — zero per-frame allocation (hard rule 4).
        const wl = fingertipToWorld(
            left.landmarks[WRIST], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v1,
        );
        const wlx = wl.x, wlz = wl.z;
        const wr = fingertipToWorld(
            right.landmarks[WRIST], ctx.camera, ctx.interactionPlaneZ,
            ctx.scratch.ray, ctx.scratch.plane, ctx.scratch.v2,
        );

        // Heading of (wristR − wristL) on XZ. atan2(dz, dx) so a CCW orbit (from above)
        // increases the angle monotonically.
        const dx = wr.x - wlx;
        const dz = wr.z - wlz;
        const heading = Math.atan2(dz, dx);

        if (this.prevHeading !== null) {
            this.angleTraveled += angleDelta(heading, this.prevHeading);
        }
        this.prevHeading = heading;
        this.grabbing = true;

        // Map the unwrapped orbit → t. clamp keeps t in [0,1] but the underlying angle
        // is preserved past the ends, so unwinding immediately tracks back down.
        const t = Math.min(1, Math.max(0, this.angleTraveled / FULL_TURN));
        this.applyMorph(ctx, t, dt);
    }

    // Write t into the context and the blend shape, and fire the donut milestone once
    // t > 0.95 has been sustained for > 500 ms. smoothstep shapes the influence; the
    // raw t (and its angle) stay linear so the gesture remains reversible (SPEC §5.5).
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

        // ctx.brushRadius (§10.2 [ ]) scales the additive brush footprint; default 1.
        engine.applyBrush(BrushVerb.Inflate, mid, BRUSH_RADIUS * ctx.brushRadius, INFLATE_STRENGTH, ctx.scratch);
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
        const turns = (this.angleTraveled / FULL_TURN).toFixed(2);
        const labelColor = isDonut ? accent : "rgba(255,255,255,0.45)";
        const stateColor = this.grabbing ? accent : "rgba(255,255,255,0.4)";
        const stateText = this.grabbing ? "ORBITING" : "GRAB BOTH HANDS";

        this.card.setBody(
            `<div style="display:flex;flex-direction:column;gap:14px">` +
                `<div style="font-size:13px;color:${stateColor};letter-spacing:0.08em">${stateText}</div>` +
                `<div style="font-size:26px;font-weight:700;color:${t > DONUT_T ? accent : "#fff"}">t = ${t.toFixed(2)}</div>` +
                `<div style="height:14px;border:0.5px solid rgba(255,255,255,0.35);border-radius:7px;overflow:hidden">` +
                    `<div style="height:100%;width:${pct}%;background:${accent};box-shadow:0 0 10px ${accent}"></div>` +
                `</div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.5)">orbit ${turns} turns</div>` +
                `<div style="font-size:24px;font-weight:700;color:${labelColor};text-shadow:0 0 10px ${labelColor}">${label}</div>` +
            `</div>`,
        );
        this.card.setInstructions(
            "GRAB BOTH HANDS · ORBIT XZ → MORPH · UNWIND TO REVERSE",
        );
    }
}

export function createMorphMenu(): MenuModule {
    return new MorphMenu();
}
