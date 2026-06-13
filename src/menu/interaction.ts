// INTERACT tool (multi-shape CSG, §5 extended). Combines the SELECTED shape (A) with the
// next shape (B) using a boolean operation — union, subtract, or intersect — and shows a
// LIVE PREVIEW of the result. A nav-hand swipe cycles the operation (recomputing the
// preview); an exec-hand pinch APPLIES it: A and B are removed and replaced by the single
// resulting shape, which becomes the new selection.
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
import { attachMesh } from "../render/scene";
import { allShapes, shapeCount, removeShape, refreshHighlight } from "../core/shapes";
import { sfx } from "../audio/sfx";

// Boolean operations offered, in swipe order.
const OPS: ReadonlyArray<{ key: number; label: string; verb: string }> = [
    { key: ADDITION, label: "UNION", verb: "merge" },
    { key: SUBTRACTION, label: "SUBTRACT", verb: "carve B out of A" },
    { key: INTERSECTION, label: "INTERSECT", verb: "keep the overlap" },
];

// Swipe thresholds (units of S/frame) — mirror SELECT / the carousel for a consistent feel.
const SWIPE_VX = 0.3;
const REARM_VX = 0.12;
const SWIPE_COOLDOWN_MS = 220;
const PINCH_ON = 0.7;

function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

export function createInteractMenu(): MenuModule {
    const accent = MENU_META[MenuId.INTERACT].accent;
    const label = MENU_META[MenuId.INTERACT].label;

    let panel: Panel | null = null;
    let opIndex = 0;
    let armed = true;
    let cooldownMs = 0;
    let hasPrev = false;
    let wasPinched = false;

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
        hasPrev = true;
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

    function paint(ctx: SceneContext): void {
        if (!panel) return;
        if (shapeCount(ctx) < 2) {
            panel.setBody(
                `<div style="font-size:12px;color:rgba(255,255,255,0.7);line-height:1.6">` +
                `INTERACT needs <b>two shapes</b>. Add another shape, then come back to ` +
                `combine it with the selected one.</div>`,
            );
            return;
        }
        const op = OPS[opIndex];
        const note = status
            ? `<div style="font-size:11px;color:#FF9090;margin-top:6px">${status}</div>`
            : `<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:6px">previewing — pinch (exec) to apply</div>`;
        panel.setBody(
            `<div style="display:flex;flex-direction:column;gap:10px">` +
                `<div style="font-size:22px;font-weight:700;color:${accent};text-shadow:0 0 12px ${accent}">${op.label}</div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.55)">${op.verb} (selected ⊕ next)</div>` +
                `<div style="font-size:10.5px;color:rgba(255,255,255,0.4)">swipe nav to change operation</div>` +
                note +
            `</div>`,
        );
    }

    return {
        id: MenuId.INTERACT,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            opIndex = 0;
            armed = true;
            cooldownMs = 0;
            hasPrev = false;
            wasPinched = false;
            status = "";
            const shapes = allShapes(ctx);
            if (shapes.length >= 2) {
                opA = shapes[0]; // the selected shape
                opB = shapes[1]; // the next shape
                rebuildPreview(ctx);
            } else {
                opA = null;
                opB = null;
            }
            paint(ctx);
            panel.show();
        },

        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel) return;
            if (cooldownMs > 0) cooldownMs = Math.max(0, cooldownMs - dt);
            if (!opA || !opB) return; // nothing to combine

            // Nav swipe cycles the operation (rebuilding the preview).
            if (nav) {
                const g = classify(nav.landmarks, nav.world, hasPrev ? prevLandmarks : null);
                const speed = Math.abs(g.vx);
                if (armed && cooldownMs <= 0 && speed >= SWIPE_VX) {
                    opIndex = (opIndex + (g.vx > 0 ? 1 : -1) + OPS.length) % OPS.length;
                    armed = false;
                    cooldownMs = SWIPE_COOLDOWN_MS;
                    rebuildPreview(ctx);
                    paint(ctx);
                } else if (speed < REARM_VX) {
                    armed = true;
                }
                snapshot(nav.landmarks);
            } else {
                hasPrev = false;
            }

            // Exec pinch applies the operation: A and B become the single result shape.
            if (exec) {
                const pinch = classify(exec.landmarks, exec.world).pinch;
                const pinchedNow = pinch > PINCH_ON;
                if (pinchedNow && !wasPinched && preview) {
                    const geo = clearPreview(true);      // keep the result geometry
                    const a = opA, b = opB;
                    opA = null;
                    opB = null;
                    if (geo && a && b) {
                        removeShape(ctx, a);
                        removeShape(ctx, b);
                        attachMesh(ctx, geo); // result becomes ctx.mesh (standard wireframe material)
                        refreshHighlight(ctx);
                        sfx.ding();
                    }
                    paint(ctx);
                }
                wasPinched = pinchedNow;
            } else {
                wasPinched = false;
            }
        },

        exit(_ctx: SceneContext): void {
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
            hasPrev = false;
        },
    };
}
