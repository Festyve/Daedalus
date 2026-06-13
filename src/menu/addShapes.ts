// §6.1 ADD SHAPES — paradigm: shape-pick + place.
//
// The SHAPES panel shows a 2x3 thumbnail grid of primitive types (sphere, cube,
// cylinder, cone, torus, icosahedron). The right hand does everything here:
//   - point + dwell: INDEX_TIP (landmark 8) aimed at a thumbnail for ~600ms highlights it.
//   - pinch: spawns the highlighted primitive at the right hand's world position into
//     ctx.extraMeshes + ctx.scene (MeshMatcapMaterial reusing the mesh's matcap).
//   - drag: while still pinched, the freshly spawned mesh follows the right INDEX_TIP
//     world position until the pinch releases (placed).
//
// Picking which thumbnail is aimed at: cast a ray from the camera through the
// INDEX_TIP NDC, intersect the panel's billboarded world plane, convert the hit into
// panel-local UV, then map UV → grid cell. The same grid layout drives the canvas
// paint and the hit-test so the highlight always matches what is drawn.
import * as THREE from "three";
import type { MenuModule, SceneContext, HandPose } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { SpatialPanel, drawPanelHints } from "./spatialPanel";
import { MENU_HINTS } from "../ui/gestureGuide";
import { toNDC } from "../math/coords";
import { pinchAmount } from "../gesture/predicates";

// MediaPipe right INDEX_TIP landmark index.
const INDEX_TIP = 8;

// Dwell time (ms) the INDEX_TIP must stay aimed at one thumbnail to select it (§6.1).
const DWELL_MS = 600;

// Pinch closure (0..1) above which a pinch is "closed" — gates spawning (§6.1).
const PINCH_ON = 0.7;

// Panel world-space plane size, mirrored from spatialPanel.ts so local hit coords map
// back to UV. These MUST track the PLANE_W / PLANE_H constants there.
const PANEL_W = 1.6;
const PANEL_H = 1.2;

// Thumbnail grid layout on the card (canvas fractions). Header band on top, then a
// 2-row x 3-col cell area. Fractions are of the full canvas (top-left origin), shared
// by paint() and the hit-test.
const GRID_COLS = 3;
const GRID_ROWS = 2;
const GRID_TOP = 0.26;     // below the title band
const GRID_BOTTOM = 0.96;
const GRID_LEFT = 0.04;
const GRID_RIGHT = 0.96;

// Spawned primitive base size (metres). Tuned to read as a small object beside the
// unit-radius mesh without overlapping the panel.
const SHAPE_SIZE = 0.45;

type ShapeKind = "sphere" | "cube" | "cylinder" | "cone" | "torus" | "icosahedron";
const SHAPES: ShapeKind[] = ["sphere", "cube", "cylinder", "cone", "torus", "icosahedron"];

// Build the geometry for a primitive kind at the shared base size. Constructors and
// argument orders are the three.js r160 signatures (Context7-confirmed).
function makeShapeGeometry(kind: ShapeKind): THREE.BufferGeometry {
    const s = SHAPE_SIZE;
    switch (kind) {
        case "sphere": return new THREE.SphereGeometry(s, 32, 24);
        case "cube": return new THREE.BoxGeometry(s * 1.6, s * 1.6, s * 1.6);
        case "cylinder": return new THREE.CylinderGeometry(s, s, s * 2, 32);
        case "cone": return new THREE.ConeGeometry(s, s * 2, 32);
        case "torus": return new THREE.TorusGeometry(s, s * 0.4, 16, 48);
        case "icosahedron": return new THREE.IcosahedronGeometry(s, 0);
    }
}

// Draw a small wireframe-style glyph for each primitive into a grid cell so the user
// can tell the thumbnails apart. Origin is the cell centre; r is half the cell's
// smaller dimension. Pure 2D canvas — cheap, only repainted when the highlight changes.
function drawThumb(g: CanvasRenderingContext2D, kind: ShapeKind, cx: number, cy: number, r: number): void {
    g.beginPath();
    switch (kind) {
        case "sphere": {
            g.arc(cx, cy, r, 0, Math.PI * 2);
            g.moveTo(cx + r, cy);
            g.ellipse(cx, cy, r, r * 0.42, 0, 0, Math.PI * 2);
            break;
        }
        case "cube": {
            const o = r * 0.42;
            g.rect(cx - r, cy - r * 0.6, r * 1.4, r * 1.4);
            g.moveTo(cx - r + o, cy - r * 0.6 - o);
            g.lineTo(cx + r * 0.4 + o, cy - r * 0.6 - o);
            g.lineTo(cx + r * 0.4 + o, cy + r * 0.8 - o);
            g.moveTo(cx + r * 0.4, cy - r * 0.6);
            g.lineTo(cx + r * 0.4 + o, cy - r * 0.6 - o);
            g.moveTo(cx + r * 0.4, cy + r * 0.8);
            g.lineTo(cx + r * 0.4 + o, cy + r * 0.8 - o);
            break;
        }
        case "cylinder": {
            g.ellipse(cx, cy - r * 0.7, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
            g.moveTo(cx - r * 0.8, cy - r * 0.7);
            g.lineTo(cx - r * 0.8, cy + r * 0.7);
            g.moveTo(cx + r * 0.8, cy - r * 0.7);
            g.lineTo(cx + r * 0.8, cy + r * 0.7);
            g.moveTo(cx + r * 0.8, cy + r * 0.7);
            g.ellipse(cx, cy + r * 0.7, r * 0.8, r * 0.3, 0, 0, Math.PI);
            break;
        }
        case "cone": {
            g.moveTo(cx, cy - r);
            g.lineTo(cx - r * 0.8, cy + r * 0.7);
            g.lineTo(cx + r * 0.8, cy + r * 0.7);
            g.closePath();
            g.moveTo(cx + r * 0.8, cy + r * 0.7);
            g.ellipse(cx, cy + r * 0.7, r * 0.8, r * 0.28, 0, 0, Math.PI * 2);
            break;
        }
        case "torus": {
            g.ellipse(cx, cy, r, r * 0.55, 0, 0, Math.PI * 2);
            g.moveTo(cx + r * 0.5, cy);
            g.ellipse(cx, cy, r * 0.5, r * 0.26, 0, 0, Math.PI * 2);
            break;
        }
        case "icosahedron": {
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
                const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
                if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.closePath();
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
                g.moveTo(cx, cy);
                g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
            }
            break;
        }
    }
    g.stroke();
}

export function createAddShapesMenu(): MenuModule {
    const accent = MENU_META[MenuId.ADD_SHAPES].accent;
    const label = MENU_META[MenuId.ADD_SHAPES].label;

    // Live state, all module-local. No per-frame allocation: scratch comes from ctx
    // plus a few fixed vectors created once here.
    let panel: SpatialPanel | null = null;
    let hovered = -1;          // grid index currently aimed at, -1 = none
    let dwellMs = 0;           // accumulated dwell on `hovered`
    let armed = -1;            // index whose dwell completed → ready to spawn on pinch
    let lastPainted = -2;      // last (hovered|armed) state painted, avoids redundant repaints
    let wasPinched = false;    // pinch edge tracking
    let dragging: THREE.Mesh | null = null; // mesh following the hand until pinch releases

    // Fixed scratch owned by this module (created once).
    const ray = new THREE.Ray();
    const plane = new THREE.Plane();
    const planeNormal = new THREE.Vector3();
    const panelPos = new THREE.Vector3();
    const hit = new THREE.Vector3();
    const local = new THREE.Vector3();

    // Repaint the card: title band + 2x3 thumbnail grid; the armed/hovered cell gets a
    // filled accent background, others a thin accent outline.
    function repaint(): void {
        if (!panel) return;
        const highlight = armed >= 0 ? armed : hovered;
        panel.draw((g, w, h) => {
            // Title band.
            g.fillStyle = accent;
            g.font = 'bold 30px "JetBrains Mono", monospace';
            g.textBaseline = "top";
            g.fillText(label, 20, 16);
            // Operating instructions in the title band (the grid fills the lower
            // panel). bottomPad = h-98 anchors the two lines at y≈58/82, under the
            // title and above the grid (GRID_TOP).
            drawPanelHints(g, w, h, MENU_HINTS[MenuId.ADD_SHAPES], accent, h - 98);

            const gx0 = GRID_LEFT * w, gx1 = GRID_RIGHT * w;
            const gy0 = GRID_TOP * h, gy1 = GRID_BOTTOM * h;
            const cw = (gx1 - gx0) / GRID_COLS, ch = (gy1 - gy0) / GRID_ROWS;
            for (let i = 0; i < SHAPES.length; i++) {
                const col = i % GRID_COLS, row = (i / GRID_COLS) | 0;
                const x = gx0 + col * cw, y = gy0 + row * ch;
                const pad = 6;
                if (i === highlight) {
                    g.fillStyle = accent;
                    g.globalAlpha = 0.22;
                    g.fillRect(x + pad, y + pad, cw - pad * 2, ch - pad * 2);
                    g.globalAlpha = 1;
                    g.lineWidth = 3;
                } else {
                    g.lineWidth = 1.5;
                }
                g.strokeStyle = accent;
                g.strokeRect(x + pad, y + pad, cw - pad * 2, ch - pad * 2);

                const cx = x + cw / 2, cy = y + ch / 2 - 6;
                const rr = Math.min(cw, ch) * 0.26;
                drawThumb(g, SHAPES[i], cx, cy, rr);

                g.fillStyle = i === highlight ? accent : "rgba(255,255,255,0.55)";
                g.font = '13px "JetBrains Mono", monospace';
                g.textAlign = "center";
                g.fillText(SHAPES[i].toUpperCase(), cx, y + ch - 22);
                g.textAlign = "left";
            }
        });
        lastPainted = highlight;
    }

    // Which grid cell (or -1) the right INDEX_TIP is aiming at. Ray from camera through
    // the tip NDC → panel world plane → panel-local → UV → cell. Returns -1 on a miss
    // (ray parallel to / behind the plane, or hit outside the grid).
    function pickCell(right: HandPose, ctx: SceneContext): number {
        if (!panel) return -1;
        const tip = right.landmarks[INDEX_TIP];
        const ndc = toNDC(tip);

        // World ray from the camera through the fingertip NDC.
        ray.origin.setFromMatrixPosition(ctx.camera.matrixWorld);
        ray.direction.set(ndc.x, ndc.y, 0.5).unproject(ctx.camera).sub(ray.origin).normalize();

        // Panel world plane: local +Z transformed to world, anchored at panel position.
        panel.object.updateWorldMatrix(true, false);
        panel.object.getWorldPosition(panelPos);
        planeNormal.set(0, 0, 1).transformDirection(panel.object.matrixWorld).normalize();
        plane.setFromNormalAndCoplanarPoint(planeNormal, panelPos);

        if (!ray.intersectPlane(plane, hit)) return -1;

        // World hit → panel-local. Local plane spans [-W/2,W/2] x [-H/2,H/2] on x,y.
        local.copy(hit);
        panel.object.worldToLocal(local);
        const u = local.x / PANEL_W + 0.5;       // 0 left .. 1 right
        const v = 0.5 - local.y / PANEL_H;       // 0 top .. 1 bottom (canvas convention)
        if (u < GRID_LEFT || u > GRID_RIGHT || v < GRID_TOP || v > GRID_BOTTOM) return -1;

        const col = Math.floor(((u - GRID_LEFT) / (GRID_RIGHT - GRID_LEFT)) * GRID_COLS);
        const row = Math.floor(((v - GRID_TOP) / (GRID_BOTTOM - GRID_TOP)) * GRID_ROWS);
        const idx = row * GRID_COLS + col;
        return idx >= 0 && idx < SHAPES.length ? idx : -1;
    }

    // Spawn the primitive of `kind` at the right hand's world position, parented to the
    // scene (NOT the spinning rig — extra meshes live in world space), registered in
    // ctx.extraMeshes, and returned so it can be dragged until the pinch releases.
    function spawnShape(kind: ShapeKind, ctx: SceneContext, worldPos: THREE.Vector3): THREE.Mesh {
        const base = ctx.mesh.material as THREE.MeshMatcapMaterial;
        const material = new THREE.MeshMatcapMaterial({ matcap: base.matcap });
        const mesh = new THREE.Mesh(makeShapeGeometry(kind), material);
        mesh.position.copy(worldPos);
        ctx.scene.add(mesh);
        ctx.extraMeshes.push(mesh);
        return mesh;
    }

    return {
        id: MenuId.ADD_SHAPES,

        enter(ctx) {
            panel = new SpatialPanel(accent);
            ctx.scene.add(panel.object);
            hovered = -1; dwellMs = 0; armed = -1; lastPainted = -2;
            wasPinched = false; dragging = null;

            // Place the card beside the mesh immediately so it reads on the first frame.
            ctx.mesh.updateWorldMatrix(true, false);
            ctx.mesh.getWorldPosition(panelPos);
            panel.placeBeside(panelPos, ctx.camera);
            repaint();
        },

        update(ctx, right, _left, dt) {
            if (!panel) return;

            // Keep the card pinned beside the mesh every frame (mesh may move/morph).
            ctx.mesh.updateWorldMatrix(true, false);
            ctx.mesh.getWorldPosition(panelPos);
            panel.placeBeside(panelPos, ctx.camera);

            // Right INDEX_TIP world position, reused for both spawn origin and drag.
            // (Computed only when a right hand is present.)
            if (right) {
                ctx.scratch.ray.origin.setFromMatrixPosition(ctx.camera.matrixWorld);
                const ndc = toNDC(right.landmarks[INDEX_TIP]);
                ctx.scratch.plane.set(new THREE.Vector3(0, 0, 1), -ctx.interactionPlaneZ);
                ctx.scratch.ray.direction
                    .set(ndc.x, ndc.y, 0.5).unproject(ctx.camera)
                    .sub(ctx.scratch.ray.origin).normalize();
                ctx.scratch.ray.intersectPlane(ctx.scratch.plane, ctx.scratch.v1);
            }

            const pinch = right ? pinchAmount(right.landmarks) : 0;
            const pinchedNow = pinch > PINCH_ON;

            // While dragging a freshly spawned mesh, glue it to the fingertip world
            // position until the pinch releases.
            if (dragging) {
                if (right && pinchedNow) {
                    dragging.position.copy(ctx.scratch.v1);
                } else {
                    dragging = null; // placed
                }
                wasPinched = pinchedNow;
                return;
            }

            // No drag in progress: run dwell-aim on the panel.
            const cell = right ? pickCell(right, ctx) : -1;

            if (cell !== hovered) {
                hovered = cell;
                dwellMs = 0;
                if (armed !== -1 && armed !== cell) armed = -1; // moved away → disarm
            } else if (hovered >= 0 && armed !== hovered) {
                dwellMs += dt * 1000;
                if (dwellMs >= DWELL_MS) armed = hovered; // dwell complete → armed
            }

            // Pinch rising edge while armed on a cell → spawn + begin drag.
            if (pinchedNow && !wasPinched && right && armed >= 0) {
                dragging = spawnShape(SHAPES[armed], ctx, ctx.scratch.v1);
                armed = -1;
                hovered = -1;
                dwellMs = 0;
            }
            wasPinched = pinchedNow;

            // Repaint only when the highlighted cell changed (avoids per-frame texture
            // re-upload). `armed` and `hovered` both drive the highlight.
            const highlight = armed >= 0 ? armed : hovered;
            if (highlight !== lastPainted) repaint();
        },

        exit(ctx) {
            if (panel) {
                ctx.scene.remove(panel.object);
                panel.dispose();
                panel = null;
            }
            // Spawned meshes are intentionally left in ctx.extraMeshes + scene: they are
            // user creations owned by the scene, not this menu's affordances. Only an
            // in-progress drag handle is dropped.
            dragging = null;
            hovered = -1; armed = -1; dwellMs = 0; wasPinched = false;
        },
    };
}
