// INTERACT tool (multi-shape CSG, §5 extended). Combines the SELECTED shapes with a boolean
// operation — union, subtract, or intersect — and shows a LIVE PREVIEW of the result. The
// operation is picked from a 3D CAROUSEL (the same wheel component) that the exec hand PINCHES to
// advance; a nav-hand pinch APPLIES it: the operands are removed and replaced by the single
// resulting shape, which becomes the new selection.
//
// UNION fuses all operands; SUBTRACT does primary-minus-the-rest; INTERSECT keeps the shared
// overlap. Every op folds over the operands primary-first. With exactly two shapes this matches
// the classic two-operand behaviour.
//
// CSG runs through three-bvh-csg (built on the same three-mesh-bvh already vendored). It operates
// on each shape's BASE geometry in world space (morph blend is ignored), folding the operands into
// a single result.
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
    { key: ADDITION, label: "UNION", verb: "fuse the shapes into one", icon: "∪" },
    { key: SUBTRACTION, label: "SUBTRACT", verb: "primary minus the rest", icon: "⊖" },
    { key: INTERSECTION, label: "INTERSECT", verb: "keep the shared overlap", icon: "∩" },
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

function blankVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

// Build a world-space CSG Brush from a mesh (its base geometry + world transform).
function brushOf(mesh: THREE.Mesh): Brush {
    const b = new Brush(mesh.geometry);
    mesh.updateWorldMatrix(true, false);
    mesh.matrixWorld.decompose(b.position, b.quaternion, b.scale);
    b.updateMatrixWorld(true);
    return b;
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

    // The operands captured on enter (a snapshot of the selection), the live preview mesh, and a
    // status message.
    let operands: THREE.Mesh[] = [];
    let preview: THREE.Mesh | null = null;
    let status = "";

    const evaluator = new Evaluator();
    evaluator.useGroups = false;          // single material → single-group result geometry
    evaluator.attributes = ["position", "normal"];

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

    // Dispose the live preview mesh (its geometry is owned by the preview unless we keep it for an
    // apply, in which case keepGeometry=true hands the geometry off to attachMesh).
    function clearPreview(keepGeometry: boolean): THREE.BufferGeometry | null {
        if (!preview) return null;
        const geo = preview.geometry;
        preview.parent?.remove(preview);
        (preview.material as THREE.Material).dispose();
        if (!keepGeometry) geo.dispose();
        preview = null;
        return keepGeometry ? geo : null;
    }

    // Fold the operands into a single CSG result per the current op, then rebuild it as a fresh
    // APP-three geometry (welded + indexed + white colour + bounds), or null on empty / failure.
    function computeResult(): THREE.BufferGeometry | null {
        if (operands.length < 2) return null;
        const op = OPS[opIndex].key;

        // Fold the operands primary-first under the chosen op: UNION fuses, SUBTRACT does
        // primary-minus-the-rest, INTERSECT keeps the shared overlap.
        let acc: Brush = brushOf(operands[0]);
        for (let i = 1; i < operands.length; i++) acc = evaluator.evaluate(acc, brushOf(operands[i]), op);

        const rp = acc.geometry.attributes.position as THREE.BufferAttribute | undefined;
        if (!rp || rp.count === 0) return null;

        // three-bvh-csg builds the result with ITS OWN three instance (Vite may not dedupe), so its
        // geometry lacks the prototype-patched computeBoundsTree the rest of the pipeline relies on.
        // Rebuild it as a fresh APP-three geometry from the raw arrays, then mergeVertices to weld +
        // index it (matching the indexed icosphere/box the sculpt + icing + BVH path expects). Seed
        // a white colour buffer for the solid lit material — the CSG result carries no colour.
        const soup = new THREE.BufferGeometry();
        soup.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(rp.array), 3));
        const rn = acc.geometry.attributes.normal as THREE.BufferAttribute | undefined;
        if (rn) soup.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(rn.array), 3));
        if (acc.geometry.index) soup.setIndex(Array.from(acc.geometry.index.array as ArrayLike<number>));

        const geo = mergeVertices(soup);
        soup.dispose();
        geo.computeVertexNormals();
        const vcount = geo.attributes.position.count;
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vcount * 3).fill(1), 3));
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        return geo;
    }

    // Recompute the preview for the current operation: hide the operands, show the result in the
    // INTERACT accent. Safe to call repeatedly; failures fall back to "couldn't combine".
    function rebuildPreview(ctx: SceneContext): void {
        clearPreview(false);
        if (operands.length < 2) return;
        let geo: THREE.BufferGeometry | null = null;
        try {
            geo = computeResult();
        } catch {
            geo = null;
        }
        if (!geo) {
            status = "couldn't combine these — try a different overlap";
            for (const m of operands) m.visible = true;
            return;
        }
        status = "";
        // Solid lit preview of the boolean result (matching the solid shapes), tinted in the
        // INTERACT accent with a faint emissive so it reads clearly as the pending result.
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(accent),
            vertexColors: true,
            metalness: 0.25,
            roughness: 0.45,
            emissive: new THREE.Color(accent),
            emissiveIntensity: 0.12,
        });
        preview = new THREE.Mesh(geo, mat);
        preview.renderOrder = 0;
        ctx.scene.add(preview);
        for (const m of operands) m.visible = false;
    }

    function paint(ctx: SceneContext): void {
        if (!panel) return;
        if (selectedCount(ctx) < 2) {
            panel.setBody(
                `<div style="font-size:12px;color:rgba(255,255,255,0.7);line-height:1.6">` +
                `INTERACT needs <b>two selected shapes</b>. In SELECT, add a second shape ` +
                `(left fist), then come back to combine them.</div>`,
            );
            return;
        }
        const op = OPS[opIndex];
        const note = status
            ? `<div style="font-size:11px;color:#FF9090;margin-top:6px">${status}</div>`
            : `<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:6px">previewing — pinch (nav) to apply</div>`;
        panel.setBody(
            `<div style="display:flex;flex-direction:column;gap:10px">` +
                `<div style="font-size:22px;font-weight:700;color:${accent};text-shadow:0 0 12px ${accent}">${op.label}</div>` +
                `<div style="font-size:11px;color:rgba(255,255,255,0.55)">${op.verb} (${operands.length} shapes)</div>` +
                `<div style="font-size:10.5px;color:rgba(255,255,255,0.4)">pinch (exec) to change operation</div>` +
                note +
            `</div>`,
        );
    }

    return {
        id: MenuId.INTERACT,

        enter(ctx: SceneContext): void {
            panel = new Panel({ title: label, accent });
            panel.setInstructions("<b>RIGHT PINCH</b> change operation &nbsp;·&nbsp; <b>LEFT PINCH</b> apply");
            opIndex = 0;
            hasNavPrev = false;
            currentExecHand = null;
            status = "";
            operands = [...selectedShapes(ctx)];
            if (operands.length >= 2) {
                rebuildPreview(ctx);
                // Op picker carousel (only meaningful with operands).
                carousel = new Carousel(OP_ITEMS);
                carousel.object.position.copy(CAROUSEL_POS);
                ctx.camera.add(carousel.object);
                carousel.open(FAR_TIP);

                // Wire up selection: nav-hand pinch applies the operation.
                carousel.onSelect = () => {
                    if (!currentExecHand || !preview || operands.length < 2) return;
                    const geo = clearPreview(true);      // keep the result geometry
                    const ops = operands;
                    operands = [];
                    if (geo) {
                        for (const m of ops) removeShape(ctx, m);
                        const result = attachMesh(ctx, geo);  // result becomes ctx.mesh
                        selectOnly(ctx, result);               // and the sole selection (count = 1)
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
            }
            paint(ctx);
            panel.show();
        },

        update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
            if (!panel) return;
            if (operands.length < 2 || !carousel) return; // nothing to combine
            const dtSec = dt / 1000;

            currentExecHand = exec;

            // Right-hand (exec) pinch advances the carousel; when opIndex changes, rebuild preview.
            const execG = exec ? classify(exec.landmarks, exec.world, null) : NONE_GESTURE;

            // Left-hand (nav) gesture for apply is handled via carousel.onSelect.
            const navG = nav ? classify(nav.landmarks, nav.world, hasNavPrev ? prevLandmarks : null) : NONE_GESTURE;
            carousel.update(FAR_TIP, execG, navG, dtSec);

            // An apply (carousel.onSelect) tears the wheel down synchronously inside the update()
            // above — bail before touching the now-null carousel.
            if (!carousel) return;

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
            // Cancel any un-applied preview and restore the operands.
            clearPreview(false);
            for (const m of operands) m.visible = true;
            operands = [];
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
