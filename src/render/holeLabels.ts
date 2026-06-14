// Floating "HOLE" tags over cutter shapes (Layer 2 DOM, like the panels/HUD). Any shape tagged
// NEGATIVE (a cutter) gets a small red badge pinned just above it so the cutter role is
// unmistakable — beyond the red tint. DOM (not a 3D sprite) so it always draws cleanly above the
// post-processed canvas; sprites get eaten by the bloom/AO composer.
//
// syncHoleLabels(ctx) runs once per frame from the main loop: it projects each negative, VISIBLE
// shape to screen, positions its badge just above the shape, and hides badges for shapes that are
// no longer cutters / are hidden (INTERACT hides operands during preview) / are off-screen / behind
// the camera. Badges are pooled and reused — no per-frame DOM churn.
import * as THREE from "three";
import type { SceneContext } from "../types";
import { allShapes, isNegative } from "../core/shapes";
import { FONT } from "./tokens";

// One badge per cutter, keyed by the shape it labels. Pooled DOM nodes (reused; hidden when idle).
const badges = new Map<THREE.Mesh, HTMLDivElement>();
let container: HTMLDivElement | null = null;
const TMP = new THREE.Vector3();

function ensureContainer(): HTMLDivElement {
    if (container) return container;
    const el = document.createElement("div");
    el.id = "hole-labels";
    Object.assign(el.style, {
        position: "fixed", left: "0", top: "0", width: "0", height: "0",
        pointerEvents: "none", zIndex: "40",
    });
    document.body.appendChild(el);
    container = el;
    return el;
}

function makeBadge(): HTMLDivElement {
    const el = document.createElement("div");
    el.textContent = "⊘ HOLE";
    Object.assign(el.style, {
        position: "absolute",
        transform: "translate(-50%, -120%)",   // centred above the anchor point
        fontFamily: FONT,
        fontSize: "12px", fontWeight: "700", letterSpacing: "0.12em",
        color: "#ff7a7a",
        background: "rgba(30,0,0,0.55)",
        border: "1px solid #ff5a5a",
        borderRadius: "6px",
        padding: "3px 8px",
        whiteSpace: "nowrap",
        textShadow: "0 0 8px rgba(255,77,77,0.9)",
        boxShadow: "0 0 10px rgba(255,77,77,0.45)",
        pointerEvents: "none",
    });
    ensureContainer().appendChild(el);
    return el;
}

function dropBadge(mesh: THREE.Mesh): void {
    const el = badges.get(mesh);
    if (!el) return;
    el.remove();
    badges.delete(mesh);
}

/** Per-frame: place a "HOLE" badge above every negative, visible, on-screen cutter shape. */
export function syncHoleLabels(ctx: SceneContext): void {
    const shapes = allShapes(ctx);
    const W = window.innerWidth;
    const H = window.innerHeight;

    // Retire badges whose shape is gone or no longer a visible cutter.
    for (const mesh of [...badges.keys()]) {
        if (!shapes.includes(mesh) || !isNegative(mesh) || !mesh.visible) dropBadge(mesh);
    }

    for (const mesh of shapes) {
        if (!isNegative(mesh) || !mesh.visible) continue;

        // Anchor a touch above the shape's top, then project to screen (NDC → CSS pixels).
        mesh.updateWorldMatrix(true, false);
        TMP.setFromMatrixPosition(mesh.matrixWorld);
        const radius = (mesh.geometry.boundingSphere?.radius ?? 1) * mesh.scale.y;
        TMP.y += radius;
        TMP.project(ctx.camera);

        let el = badges.get(mesh);
        // Hide when the anchor is behind the camera or off-screen (rather than pinning it to an edge).
        const onScreen = TMP.z < 1 && TMP.x >= -1 && TMP.x <= 1 && TMP.y >= -1 && TMP.y <= 1;
        if (!onScreen) {
            if (el) el.style.display = "none";
            continue;
        }
        if (!el) {
            el = makeBadge();
            badges.set(mesh, el);
        }
        el.style.display = "block";
        el.style.left = `${(TMP.x * 0.5 + 0.5) * W}px`;
        el.style.top = `${(-TMP.y * 0.5 + 0.5) * H}px`;
    }
}
