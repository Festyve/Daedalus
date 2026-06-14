// INTERACT tool (multi-shape CSG, §5 extended). Combines the two SELECTED shapes (A, B) using a
// boolean operation — subtract, union, or intersect — and shows a LIVE PREVIEW of the result.
//
// No pinch anywhere (consistent with SELECT): a horizontal SWIPE of the nav (left) index finger
// cycles the operation (the preview rebuilds live), and a GRAB (close the nav hand into a fist)
// APPLIES it: A and B are removed and replaced by the single resulting shape, which becomes the
// new selection. SUBTRACT is the default — it carves the second shape out of the first, drilling
// a HOLE — so "negate two shapes" is the first thing you see.
//
// CSG runs through three-bvh-csg (built on the same three-mesh-bvh already vendored). It
// operates on each shape's BASE geometry in world space (morph blend is ignored), which is
// the right call for the hard-coded primitive booleans we expose here.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import type { HandPose, MenuModule, SceneContext, Vec3 } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { classify } from "../gesture/detect";
import { SwipeDetector } from "../gesture/swipe";
import { attachMesh } from "../render/scene";
import { selectedShapes, selectedCount, removeShape, selectOnly } from "../core/shapes";
import { sfx } from "../audio/sfx";

// Boolean operations offered, in swipe order. SUBTRACT leads: it is the hole-maker the tool is
// built around (carve B out of A). verb is shown under the big op label in the panel.
const OPS: ReadonlyArray<{ key: number; label: string; verb: string; icon: string }> = [
    { key: SUBTRACTION, label: "SUBTRACT", verb: "carve the 2nd shape out of the 1st — drills a hole", icon: "⊖" },
    { key: ADDITION, label: "UNION", verb: "fuse both shapes into one solid", icon: "∪" },
    { key: INTERSECTION, label: "INTERSECT", verb: "keep only the volume they share", icon: "∩" },
];

// A grab (fist) applies only after this many steady fist frames, so the curl that starts a fist
// never fires twice and a swipe's brief finger motion never reads as a grab (§12 debounce).
const GRAB_FRAMES = 5;

function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

export function createInteractMenu(): MenuModule {
    const accent = MENU_META[MenuId.INTERACT].accent;
    const label = MENU_META[MenuId.INTERACT].label;

    let panel: Panel | null = null;
    let opIndex = 0;              // 0 = SUBTRACT (default)
    let hasNavPrev = false;
    let grabStreak = 0;          // consecutive nav-fist frames (applies at GRAB_FRAMES)
    let wasGrabbing = false;     // committed-grab rising-edge latch (one apply per fist)
    let applied = false;         // true once the boolean committed — operands are gone
    const swipe = new SwipeDetector();

    // The two operands captured on enter, the live preview mesh, and a status message.
    let opA: THREE.Mesh | null = null;
    let opB: THREE.Mesh | null = null;
    let preview: THREE.Mesh | null = null;
    let status = "";

    const evaluator = new Evaluator();
    evaluator.useGroups = false;          // single material → single-group result geometry
    evaluator.attributes = ["position", "normal"];
    const brushA = new Brush(new THREE.BufferGeometry());
    const brushB = new Brush(new THREE.BufferGeometry());

    const prevLandmarks: Vec3[] = Array.from({ length: 21 }, blankVec);
    function snapshot(lm: Vec3[]): void {
        const n = Math.min(lm.length, prevLandmarks.length);
        for (let i = 0; i < n; i++) {
            prevLandmarks[i].x = lm[i].x;
            prevLandmarks[i].y = lm[i].y;
            prevLandmarks[i].z = lm[i].z;
        }
        hasNavPrev = true;
    }

    // Dispose the live preview mesh (its geometry is owned by the preview unless we keep it
    // for an apply, in which case keepGeometry=true hands the geometry off to attachMesh).
    function clearPreview(keepGeometry: boolean): THREE.BufferGeometry | null {
        if (!preview) return null;
        const geo = preview.geometry;
        preview.parent?.remove(preview);
        (preview.material as THREE.Material).dispose();
        if (!keepGeometry) geo.dispose();
        preview = null;
        return keepGeometry ? geo : null;
    }

    // Run the CSG op A⊕B on their BASE geometries in world space, returning a fresh
    // world-space result geometry (white vertex colours added for the wireframe material),
    // or null if the operation fails / produces nothing.
    function computeResult(): THREE.BufferGeometry | null {
        if (!opA || !opB) return null;
        opA.updateWorldMatrix(true, false);
        opB.updateWorldMatrix(true, false);

        brushA.geometry = opA.geometry;
        opA.matrixWorld.decompose(brushA.position, brushA.quaternion, brushA.scale);
        brushA.updateMatrixWorld(true);

        brushB.geometry = opB.geometry;
        opB.matrixWorld.decompose(brushB.position, brushB.quaternion, brushB.scale);
        brushB.updateMatrixWorld(true);

        const result = evaluator.evaluate(brushA, brushB, OPS[opIndex].key);
        const rp = result.geometry.attributes.position as THREE.BufferAttribute | undefined;
        if (!rp || rp.count === 0) return null;

        // three-bvh-csg builds the result with ITS OWN three instance (Vite may not dedupe),
        // so its geometry lacks the prototype-patched computeBoundsTree the rest of the
        // pipeline relies on. Rebuild it as a fresh APP-three geometry from the raw arrays,
        // then mergeVertices to weld + index it (matching the indexed icosphere/box the
        // sculpt + icing + BVH path expects). Seed a white colour buffer for the wireframe
        // material (vertexColors:true) — the CSG result carries no colour attribute.
        const soup = new THREE.BufferGeometry();
        soup.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(rp.array), 3));
        const rn = result.geometry.attributes.normal as THREE.BufferAttribute | undefined;
        if (rn) soup.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(rn.array), 3));
        if (result.geometry.index) soup.setIndex(Array.from(result.geometry.index.array as ArrayLike<number>));

        const geo = mergeVertices(soup);
        soup.dispose();
        geo.computeVertexNormals();
        const vcount = geo.attributes.position.count;
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vcount * 3).fill(1), 3));
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        return geo;
    }

    // Recompute the preview for the current operation: hide A & B, show the result in the
    // INTERACT accent. Safe to call repeatedly; failures fall back to "couldn't combine".
    function rebuildPreview(ctx: SceneContext): void {
        clearPreview(false);
        if (!opA || !opB) return;
        let geo: THREE.BufferGeometry | null = null;
        try {
            geo = computeResult();
        } catch {
            geo = null;
        }
        if (!geo) {
            status = "couldn't combine these two — try a different overlap";
            opA.visible = true;
            opB.visible = true;
            return;
        }
        status = "";
        const mat = new THREE.MeshBasicMaterial({
            wireframe: true,
            color: new THREE.Color(accent),
            transparent: true,
            opacity: 1,
            toneMapped: false,
        });
        preview = new THREE.Mesh(geo, mat);
        preview.renderOrder = 0;
        ctx.scene.add(preview);
        opA.visible = false;
        opB.visible = false;
    }

    // Commit the previewed boolean: keep the result geometry, delete the two operands, and make
    // the result the sole selection. After this the tool has no operands left (applied = true).
    function applyResult(ctx: SceneContext): void {
        if (!preview || !opA || !opB) return;
        const geo = clearPreview(true);      // keep the result geometry
        const a = opA, b = opB;
        opA = null;
        opB = null;
        if (geo) {
            removeShape(ctx, a);
            removeShape(ctx, b);
            const result = attachMesh(ctx, geo); // result becomes ctx.mesh
            selectOnly(ctx, result);             // and the sole selection (count = 1)
            sfx.ding();
        }
        applied = true;
        paint(ctx);
    }

    // The three ops as a compact pill row, the active one lit in the accent. Pure string build.
    function opRow(): string {
        return (
            `<div style="display:flex;gap:6px">` +
            OPS.map((o, i) => {
                const on = i === opIndex;
                const bg = on ? accent : "rgba(255,255,255,0.06)";
                const fg = on ? "#001018" : "rgba(255,255,255,0.6)";
                const glow = on ? `box-shadow:0 0 10px ${accent}` : "";
                return (
                    `<span style="flex:1;text-align:center;padding:5px 4px;border-radius:7px;` +
                    `font-size:11px;font-weight:700;background:${bg};color:${fg};${glow}">` +
                    `${o.icon} ${o.label}</span>`
                );
            }).join("") +
            `</div>`
        );
    }

    function paint(ctx: SceneContext): void {
        if (!panel) return;
        if (applied) {
            panel.setBody(
                `<div style="font-size:13px;color:${accent};line-height:1.6">` +
                `<b>Combined.</b> The result is now your single selected shape.<br>` +
                `<span style="color:rgba(255,255,255,0.5)">Select two shapes again to make another.</span></div>`,
            );
            return;
        }
        if (selectedCount(ctx) < 2) {
            panel.setBody(
                `<div style="font-size:12px;color:rgba(255,255,255,0.7);line-height:1.6">` +
                `INTERACT needs <b>two selected shapes</b>. Use SELECT to grab a second shape ` +
                `into the selection, then come back to combine them.</div>`,
            );
            return;
        }
        const op = OPS[opIndex];
        const note = status
            ? `<div style="font-size:11px;color:#FF9090;margin-top:2px">${status}</div>`
            : `<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:2px">live preview — grab to apply</div>`;
        panel.setBody(
            `<div style="display:flex;flex-direction:column;gap:10px">` +
                opRow() +
                `<div style="font-size:22px;font-weight:700;color:${accent};text-shadow:0 0 12px ${accent}">${op.label}</div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.55)">${op.verb}</div>` +
                `<div style="font-size:10.5px;color:rgba(255,255,255,0.4)">swipe nav to change · grab (fist) to apply</div>` +
                note +
            `</div>`,
        );
    }

    return {
        id: MenuId.INTERACT,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            panel.setInstructions("<b>SWIPE</b> change operation &nbsp;·&nbsp; <b>GRAB (fist)</b> apply");
            opIndex = 0;
            hasNavPrev = false;
            grabStreak = 0;
            wasGrabbing = false;
            applied = false;
            status = "";
            swipe.reset();
            const sel = selectedShapes(ctx);
            if (sel.length >= 2) {
                opA = sel[0]; // primary selected
                opB = sel[1]; // second selected
                rebuildPreview(ctx);
            } else {
                opA = null;
                opB = null;
            }
            paint(ctx);
            panel.show();
        },

        // The nav (left) hand drives INTERACT: swipe cycles the op, a fist applies. The exec hand
        // is unused here (it stays free for the global gun = return to the tool wheel).
        update(ctx: SceneContext, _exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel) return;
            if (applied || !opA || !opB) {        // nothing to combine (waiting / already done)
                if (!nav) hasNavPrev = false;
                return;
            }

            if (!nav) {
                hasNavPrev = false;
                grabStreak = 0;
                wasGrabbing = false;
                swipe.reset();
                return;
            }

            const g = classify(nav.landmarks, nav.world, hasNavPrev ? prevLandmarks : null);

            // Swipe → cycle the operation (wraps), rebuild the live preview, repaint.
            const dir = swipe.update(g.vx, dt);
            if (dir !== 0) {
                opIndex = (opIndex + (dir > 0 ? 1 : -1) + OPS.length) % OPS.length;
                rebuildPreview(ctx);
                paint(ctx);
            }

            // Grab (fist) → apply, committed after GRAB_FRAMES steady fist frames and latched on
            // the rising edge so one closed fist applies exactly once.
            grabStreak = g.name === "fist" ? Math.min(GRAB_FRAMES, grabStreak + 1) : 0;
            const grabbing = grabStreak >= GRAB_FRAMES;
            if (grabbing && !wasGrabbing) {
                applyResult(ctx);
            }
            wasGrabbing = grabbing;

            snapshot(nav.landmarks);
        },

        exit(ctx: SceneContext): void {
            // Cancel any un-applied preview and restore the two operands.
            clearPreview(false);
            if (opA) opA.visible = true;
            if (opB) opB.visible = true;
            opA = null;
            opB = null;
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            hasNavPrev = false;
            grabStreak = 0;
            wasGrabbing = false;
        },
    };
}
