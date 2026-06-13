// §6.2 TRANSLATE — directional arrow drag.
//
// Six world-axis arrows (±X, ±Y, ±Z) appear around the active mesh, color-coded
// X=red / Y=green / Z=blue (standard 3D-app convention). Each arrow is a cone+cylinder
// affordance. The right hand hovers near an arrow to highlight it; pinching near an
// arrow latches that axis and dragging translates the mesh along it
// (§13.3: projected = dot(drag, axisDir)·axisDir, scaled by calibration responsiveness).
// A SpatialPanel beside the mesh shows the live X/Y/Z readout.
//
// Module-boundary rule (§3.2): this talks only to SceneContext.
import * as THREE from "three";
import type { HandPose, MenuModule, SceneContext } from "../types";
import { MenuId } from "../types";
import { TOKENS } from "../render/tokens";
import { SpatialPanel, drawPanelHints } from "./spatialPanel";
import { MENU_HINTS } from "../ui/gestureGuide";
import { fingertipToWorld, projectOntoAxis } from "../math/coords";
import { pinchAmount } from "../gesture/predicates";

// Arrow geometry sizing (metres), tuned to sit around the unit sphere/donut (radius ~1).
const SHAFT_RADIUS = 0.035;
const SHAFT_LENGTH = 0.7;
const TIP_RADIUS = 0.11;
const TIP_LENGTH = 0.28;
// Gap between the mesh centre and the tail of each arrow so they read as separate from the body.
const ARROW_GAP = 1.15;

// Right index fingertip must be within this world-space distance of an arrow's body to hover it.
const HOVER_RADIUS = 0.55;
// Pinch closure (0..1) at/above which a hovered arrow is grabbed and a drag begins.
const PINCH_ON = 0.6;
// Hysteresis: once dragging, only release when the pinch relaxes below this.
const PINCH_OFF = 0.45;

// Highlight feedback (§6.2: "highlights + scales up slightly").
const HOVER_SCALE = 1.18;
const BASE_EMISSIVE = 0.0;
const HOVER_EMISSIVE = 0.55;

// Per-axis color coding.
const AXIS_COLOR = {
    x: 0xff4444,
    y: 0x44ff44,
    z: 0x4488ff,
} as const;

// The six world axes, with the buffer key used to color each arrow.
const AXES: ReadonlyArray<{ dir: readonly [number, number, number]; color: number }> = [
    { dir: [1, 0, 0], color: AXIS_COLOR.x },
    { dir: [-1, 0, 0], color: AXIS_COLOR.x },
    { dir: [0, 1, 0], color: AXIS_COLOR.y },
    { dir: [0, -1, 0], color: AXIS_COLOR.y },
    { dir: [0, 0, 1], color: AXIS_COLOR.z },
    { dir: [0, 0, -1], color: AXIS_COLOR.z },
];

// One axis arrow: a cylinder shaft + cone tip, both built centred on +Y then the whole
// group is oriented to its world axis. Carries its axis direction for proximity + drag math.
interface AxisArrow {
    group: THREE.Group;
    axis: THREE.Vector3;          // unit world-space direction this arrow points
    shaft: THREE.MeshStandardMaterial;
    tip: THREE.MeshStandardMaterial;
    emissive: THREE.Color;        // shared base color, scaled by emissiveIntensity for highlight
}

function buildArrow(dir: readonly [number, number, number], color: number): AxisArrow {
    const group = new THREE.Group();
    const emissive = new THREE.Color(color);

    const shaft = new THREE.MeshStandardMaterial({
        color,
        emissive,
        emissiveIntensity: BASE_EMISSIVE,
        roughness: 0.45,
        metalness: 0.1,
    });
    const tip = new THREE.MeshStandardMaterial({
        color,
        emissive,
        emissiveIntensity: BASE_EMISSIVE,
        roughness: 0.45,
        metalness: 0.1,
    });

    // Shaft: centred on origin along +Y, shifted up so its tail sits at ARROW_GAP.
    const shaft_geo = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LENGTH, 16);
    const shaft_mesh = new THREE.Mesh(shaft_geo, shaft);
    shaft_mesh.position.y = ARROW_GAP + SHAFT_LENGTH / 2;

    // Tip: cone pointing +Y, seated on top of the shaft.
    const tip_geo = new THREE.ConeGeometry(TIP_RADIUS, TIP_LENGTH, 20);
    const tip_mesh = new THREE.Mesh(tip_geo, tip);
    tip_mesh.position.y = ARROW_GAP + SHAFT_LENGTH + TIP_LENGTH / 2;

    group.add(shaft_mesh, tip_mesh);

    // Orient the +Y-built arrow onto its world axis.
    const axis = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);

    return { group, axis, shaft, tip, emissive };
}

export function createTranslateMenu(): MenuModule {
    let root: THREE.Group | null = null;
    let arrows: AxisArrow[] = [];
    let panel: SpatialPanel | null = null;

    // Drag state.
    let hovered: AxisArrow | null = null;
    let dragging: AxisArrow | null = null;
    let pinching = false;
    let has_prev_tip = false;
    const prev_tip_world = new THREE.Vector3(); // last frame's right fingertip world position

    // Persistent scratch owned by this module (zero per-frame alloc beyond ctx.scratch).
    const tip_world = new THREE.Vector3();      // current right fingertip world position
    const drag_world = new THREE.Vector3();     // frame-to-frame fingertip delta (world)
    const projected = new THREE.Vector3();      // delta projected onto the active axis (world)
    const mesh_world_pos = new THREE.Vector3(); // mesh centre in world space (mesh is nested in groups)

    function setHighlight(arrow: AxisArrow | null): void {
        for (const a of arrows) {
            const on = a === arrow;
            const intensity = on ? HOVER_EMISSIVE : BASE_EMISSIVE;
            a.shaft.emissiveIntensity = intensity;
            a.tip.emissiveIntensity = intensity;
            a.group.scale.setScalar(on ? HOVER_SCALE : 1);
        }
    }

    // Nearest arrow whose body is within HOVER_RADIUS of the fingertip (world space).
    // Distance is measured to the arrow's midpoint along its axis from the mesh centre.
    function pickArrow(ctx: SceneContext, tip: THREE.Vector3): AxisArrow | null {
        const mid = ARROW_GAP + SHAFT_LENGTH / 2;
        let best: AxisArrow | null = null;
        let best_d = HOVER_RADIUS;
        for (const a of arrows) {
            // Arrow body midpoint in world = mesh centre + axis * mid (root tracks mesh centre).
            ctx.scratch.v2.copy(mesh_world_pos).addScaledVector(a.axis, mid);
            const dist = ctx.scratch.v2.distanceTo(tip);
            if (dist < best_d) {
                best_d = dist;
                best = a;
            }
        }
        return best;
    }

    function drawPanel(ctx: SceneContext): void {
        if (!panel) return;
        const p = ctx.mesh.position;
        panel.draw((g, w, h) => {
            g.fillStyle = TOKENS.menuBlue;
            g.font = 'bold 34px "JetBrains Mono", monospace';
            g.fillText("TRANSLATE", 28, 26);

            g.fillStyle = TOKENS.text;
            g.font = '28px "JetBrains Mono", monospace';
            const fmt = (n: number) => (n >= 0 ? " " : "") + n.toFixed(2);
            g.fillText(`X ${fmt(p.x)}`, 28, 96);
            g.fillText(`Y ${fmt(p.y)}`, 28, 142);
            g.fillText(`Z ${fmt(p.z)}`, 28, 188);

            g.fillStyle = TOKENS.textDim;
            g.font = '20px "JetBrains Mono", monospace';
            const hint = dragging
                ? "DRAGGING"
                : hovered
                    ? "PINCH TO GRAB"
                    : "HOVER AN ARROW";
            g.fillText(hint, 28, 300);

            drawPanelHints(g, w, h, MENU_HINTS[MenuId.TRANSLATE], TOKENS.menuBlue, 0);
        });
    }

    return {
        id: MenuId.TRANSLATE,

        enter(ctx: SceneContext): void {
            root = new THREE.Group();
            arrows = AXES.map(({ dir, color }) => buildArrow(dir, color));
            for (const a of arrows) root.add(a.group);
            ctx.scene.add(root);

            // Seat the arrow rig on the mesh's world position immediately.
            ctx.mesh.updateWorldMatrix(true, false);
            ctx.mesh.getWorldPosition(mesh_world_pos);
            root.position.copy(mesh_world_pos);

            panel = new SpatialPanel(TOKENS.menuBlue);
            ctx.scene.add(panel.object);
            panel.placeBeside(mesh_world_pos, ctx.camera);
            drawPanel(ctx);

            hovered = null;
            dragging = null;
            pinching = false;
            has_prev_tip = false;
        },

        update(ctx: SceneContext, right: HandPose | null, _left: HandPose | null, _dt: number): void {
            if (!root || !panel) return;

            // Keep the rig + panel anchored to the (possibly moved) mesh centre.
            ctx.mesh.updateWorldMatrix(true, false);
            ctx.mesh.getWorldPosition(mesh_world_pos);
            root.position.copy(mesh_world_pos);
            panel.placeBeside(mesh_world_pos, ctx.camera);

            // No right hand → drop any hover/drag and idle.
            if (!right) {
                hovered = null;
                dragging = null;
                pinching = false;
                has_prev_tip = false;
                setHighlight(null);
                drawPanel(ctx);
                return;
            }

            // Right index fingertip (landmark 8) → world on the interaction plane.
            fingertipToWorld(
                right.landmarks[8], ctx.camera, ctx.interactionPlaneZ,
                ctx.scratch.ray, ctx.scratch.plane, tip_world,
            );

            const pinch = pinchAmount(right.landmarks);

            // Pinch edge detection with hysteresis.
            if (!pinching && pinch >= PINCH_ON) pinching = true;
            else if (pinching && pinch <= PINCH_OFF) pinching = false;

            if (dragging) {
                if (!pinching) {
                    // Release: latch position, stop dragging.
                    dragging = null;
                } else if (has_prev_tip) {
                    // Frame-to-frame fingertip displacement in world space.
                    drag_world.copy(tip_world).sub(prev_tip_world);
                    // Project onto the grabbed world axis (§13.3).
                    projectOntoAxis(drag_world, dragging.axis, projected);
                    // Sensitivity scalar from calibration.
                    projected.multiplyScalar(ctx.calibration.responsiveness);
                    // The projected delta is world-space; the mesh's position lives in its
                    // parent (spin group) space. Convert the world delta into that parent
                    // space so the motion stays locked to the grabbed world axis regardless
                    // of the display tilt/spin. Delta-only: rotate by the inverse of the
                    // parent's world rotation (no translation component).
                    const parent = ctx.mesh.parent;
                    if (parent) {
                        parent.updateWorldMatrix(true, false);
                        ctx.scratch.q1.setFromRotationMatrix(parent.matrixWorld).invert();
                        projected.applyQuaternion(ctx.scratch.q1);
                    }
                    ctx.mesh.position.add(projected);
                }
            } else {
                // Not dragging: update hover, and grab if the user pinches on a hovered arrow.
                hovered = pickArrow(ctx, tip_world);
                if (hovered && pinching) {
                    dragging = hovered;
                }
            }

            // Highlight the arrow under attention (the dragged one wins).
            setHighlight(dragging ?? hovered);

            prev_tip_world.copy(tip_world);
            has_prev_tip = true;

            drawPanel(ctx);
        },

        exit(ctx: SceneContext): void {
            if (root) {
                ctx.scene.remove(root);
                for (const a of arrows) {
                    a.group.traverse((obj) => {
                        if ((obj as THREE.Mesh).isMesh) {
                            (obj as THREE.Mesh).geometry.dispose();
                        }
                    });
                    a.shaft.dispose();
                    a.tip.dispose();
                }
            }
            if (panel) {
                ctx.scene.remove(panel.object);
                panel.dispose();
            }
            root = null;
            arrows = [];
            panel = null;
            hovered = null;
            dragging = null;
            pinching = false;
            has_prev_tip = false;
        },
    };
}
