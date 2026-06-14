// INTERACT tool (multi-shape CSG, §5 extended). Combines the two SELECTED shapes (A, B) using a
// boolean operation — union, subtract, or intersect — and shows a LIVE PREVIEW of the result.
// The operation is picked from a 3D CAROUSEL (item 5: the same wheel component) that the nav
// hand SWIPES; an exec-hand pinch APPLIES it: A and B are removed and replaced by the single
// resulting shape, which becomes the new selection.
//
// CSG runs through three-bvh-csg (built on the same three-mesh-bvh already vendored). It
// operates on each shape's BASE geometry in world space (morph blend is ignored), which is
// the right call for the hard-coded primitive booleans we expose here.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import type { GestureState, HandPose, MenuModule, SceneContext, Vec3 } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { Panel } from "./panel";
import { Carousel, type CarouselItem } from "./carousel";
import { classify } from "../gesture/detect";
import { attachMesh } from "../render/scene";
import { selectedShapes, selectedCount, removeShape, selectOnly } from "../core/shapes";
import { sfx } from "../audio/sfx";

// Boolean operations offered, in carousel order.
const OPS: ReadonlyArray<{ key: number; label: string; verb: string; icon: string }> = [
    { key: ADDITION, label: "UNION", verb: "merge", icon: "∪" },
    { key: SUBTRACTION, label: "SUBTRACT", verb: "carve B out of A", icon: "⊖" },
    { key: INTERSECTION, label: "INTERSECT", verb: "keep the overlap", icon: "∩" },
];

// Carousel item per op (id = OPS index as a string). All share the INTERACT accent.
const OP_ITEMS: CarouselItem[] = OPS.map((op, i) => ({
    id: String(i),
    icon: op.icon,
    label: op.label,
    accent: MENU_META[MenuId.INTERACT].accent,
}));

// Where the op sub-carousel sits in camera-local space (top-center, like the tool wheel).
const CAROUSEL_POS = new THREE.Vector3(0, 0.9, -3.2);

const PINCH_ON = 0.7;

function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

export function createInteractMenu(): MenuModule {
    const accent = MENU_META[MenuId.INTERACT].accent;
    const label = MENU_META[MenuId.INTERACT].label;

    let panel: Panel | null = null;
    let carousel: Carousel | null = null;
    let opIndex = 0;
    let hasNavPrev = false;
    let currentExecHand: HandPose | null = null;

    const NONE_GESTURE: GestureState = { name: "none", extended: 0, pinch: 0, spread: 0, vx: 0 };
    const FAR_TIP = new THREE.Vector3(10, 10, 0);

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

    function paint(ctx: SceneContext): void {
        if (!panel) return;
        if (selectedCount(ctx) < 2) {
            panel.setBody(
                `<div style="font-size:12px;color:rgba(255,255,255,0.7);line-height:1.6">` +
                `INTERACT needs <b>two selected shapes</b>. Use SELECT to pinch a second shape ` +
                `into the selection, then come back to combine them.</div>`,
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
            panel.setInstructions("<b>RIGHT PINCH</b> change operation &nbsp;·&nbsp; <b>LEFT SQUEEZE</b> apply");
            opIndex = 0;
            hasNavPrev = false;
            currentExecHand = null;
            status = "";
            const sel = selectedShapes(ctx);
            if (sel.length >= 2) {
                opA = sel[0]; // primary selected
                opB = sel[1]; // second selected
                rebuildPreview(ctx);
                // Op picker carousel (only meaningful with two operands).
                carousel = new Carousel(OP_ITEMS);
                carousel.object.position.copy(CAROUSEL_POS);
                ctx.camera.add(carousel.object);
                carousel.open(FAR_TIP);

                // Wire up selection: left-hand pinch applies the operation.
                carousel.onSelect = () => {
                    if (!currentExecHand || !preview || !opA || !opB) return;
                    const geo = clearPreview(true);      // keep the result geometry
                    const a = opA, b = opB;
                    opA = null;
                    opB = null;
                    if (geo && a && b) {
                        removeShape(ctx, a);
                        removeShape(ctx, b);
                        const result = attachMesh(ctx, geo); // result becomes ctx.mesh
                        selectOnly(ctx, result);             // and the sole selection (count = 1)
                        sfx.ding();
                    }
                    // The operands are gone — tear down the op wheel until the user re-enters.
                    if (carousel) {
                        ctx.camera.remove(carousel.object);
                        carousel.dispose();
                        carousel = null;
                    }
                    paint(ctx);
                };
            } else {
                opA = null;
                opB = null;
            }
            paint(ctx);
            panel.show();
        },

        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel) return;
            if (!opA || !opB || !carousel) return; // nothing to combine
            const dtSec = dt / 1000;

            currentExecHand = exec;

            // Right-hand (exec) pinch advances the carousel; when opIndex changes, rebuild preview.
            const execG = exec ? classify(exec.landmarks, exec.world, null) : NONE_GESTURE;

            // Left-hand (nav) gesture for selection is handled via carousel.onSelect.
            const navG = nav ? classify(nav.landmarks, nav.world, hasNavPrev ? prevLandmarks : null) : NONE_GESTURE;
            carousel.update(FAR_TIP, execG, navG, dtSec);

            // Track operation changes when the carousel advances.
            const centered = Number(carousel.current);
            if (centered !== opIndex) {
                opIndex = centered;
                rebuildPreview(ctx);
                paint(ctx);
            }

            if (nav) {
                snapshot(nav.landmarks);
            } else {
                hasNavPrev = false;
            }
        },

        exit(ctx: SceneContext): void {
            // Cancel any un-applied preview and restore the two operands.
            clearPreview(false);
            if (opA) opA.visible = true;
            if (opB) opB.visible = true;
            opA = null;
            opB = null;
            if (carousel) {
                ctx.camera.remove(carousel.object);
                carousel.dispose();
                carousel = null;
            }
            currentExecHand = null;
            if (panel) {
                panel.hide();
                panel.destroy();
                panel = null;
            }
            hasNavPrev = false;
        },
    };
}
