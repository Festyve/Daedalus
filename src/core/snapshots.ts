// Safety-mode snapshot player (SPEC §13.1, §13.2).
//
// In safety mode (tracking failed on stage) the operator steps through the authored
// arc by keypress. Each step rebuilds the REAL scene to a known-good state from one of
// the four authored snapshots (§13.2) — empty → clean sphere → clean donut → decorated
// donut — using the same primitives the live tools use (attachMesh, applyIcing,
// Sprinkles). So safety mode is not a slideshow: it leaves a genuine, sculptable mesh.
//
// The authored snapshot data lives in /snapshots/*.json (§18 manifest) and is imported
// here, so the JSON files are the single source of truth — editing them changes the
// recovery states with no code change.
import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import type { SceneContext, Stage } from "../types";
import { attachMesh } from "../render/scene";
import { makeShape } from "../render/geometry";
import { applyIcing, icingMask } from "../decorate/icing";
import { Sprinkles } from "../decorate/sprinkles";
import { ICING, SPRINKLES } from "../decorate/designs";

import EMPTY from "../../snapshots/snapshot_empty.json";
import SPHERE from "../../snapshots/snapshot_sphere.json";
import DONUT from "../../snapshots/snapshot_donut.json";
import DECORATED from "../../snapshots/snapshot_decorated.json";

interface Snapshot {
    stage: string;
    shape: "sphere" | null;
    morphT: number;
    decorated: boolean;
}

const SNAPSHOTS: Record<Stage, Snapshot> = {
    EMPTY: EMPTY as Snapshot,
    SPHERE: SPHERE as Snapshot,
    DONUT: DONUT as Snapshot,
    DECORATED: DECORATED as Snapshot,
};

// Crown-flood icing radius + sprinkle count for the DECORATED snapshot (mirrors the
// voice-triggered decoration in decorate/chatPanel.ts).
const FLOOD_RADIUS = 4.0;
const FLOOD_SPRINKLES = 240;

export class SnapshotPlayer {
    private sprinkles: Sprinkles | null = null;

    /** Rebuild the scene to the authored snapshot for `stage` (§13.2). */
    apply(ctx: SceneContext, stage: Stage): void {
        const snap = SNAPSHOTS[stage];
        if (!snap) return;

        if (snap.shape === null) {
            this.clearMesh(ctx);
            return;
        }

        // Rebuild a clean shape as the active sculpt target (attachMesh authors the donut
        // morph target, so the morphT below blends sphere→donut on the real geometry).
        this.clearMesh(ctx);
        attachMesh(ctx, makeShape(snap.shape));

        ctx.morphT = clamp01(snap.morphT);
        const influences = ctx.mesh?.morphTargetInfluences;
        if (influences && influences.length > 0) influences[0] = ctx.morphT;

        if (snap.decorated && ctx.mesh && ctx.bvh) {
            this.decorate(ctx, ctx.mesh, ctx.bvh);
        }
    }

    dispose(): void {
        if (this.sprinkles) {
            this.sprinkles.dispose();
            this.sprinkles = null;
        }
    }

    // Flood JAM icing across the crown + scatter rainbow sprinkles on the iced region —
    // the authored DECORATED state (§8.1–§8.4).
    private decorate(ctx: SceneContext, mesh: THREE.Mesh, bvh: MeshBVH): void {
        if (!this.sprinkles) this.sprinkles = new Sprinkles(ctx.scene);
        mesh.updateWorldMatrix(true, false);
        mesh.getWorldPosition(ctx.scratch.v1);
        applyIcing(mesh, bvh, ctx.scratch.v1, FLOOD_RADIUS, ICING.jam);
        this.sprinkles.dropBatch(mesh, icingMask(mesh), SPRINKLES.rainbow, FLOOD_SPRINKLES);
    }

    // Remove + fully dispose the active mesh (geometry, BVH, materials, wire child) and
    // reset the context back to the empty world.
    private clearMesh(ctx: SceneContext): void {
        if (this.sprinkles) {
            this.sprinkles.dispose();
            this.sprinkles = null;
        }
        const mesh = ctx.mesh;
        if (mesh) {
            ctx.scene.remove(mesh);
            disposeMesh(mesh);
        }
        ctx.mesh = null;
        ctx.bvh = null;
        ctx.morphT = 0;
    }
}

function disposeMesh(mesh: THREE.Mesh): void {
    const geo = mesh.geometry as THREE.BufferGeometry & { disposeBoundsTree?: () => void };
    geo.disposeBoundsTree?.();
    geo.dispose();
    disposeMaterial(mesh.material);
    for (const child of mesh.children) {
        if ((child as THREE.Mesh).isMesh) disposeMaterial((child as THREE.Mesh).material);
    }
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
}

function clamp01(x: number): number {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}
