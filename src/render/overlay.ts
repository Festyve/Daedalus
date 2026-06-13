// Hand-skeleton overlay (SPEC §9.5, §14.3): green hand skeletons (drawConnectors style)
// drawn over the MAIN view, where the full-colour webcam already backs the scene. Fed by
// the tracking layer's filtered HandPose — landmarks are mirrored into SELFIE normalized
// image space (liveInput.ts), matching the mirrored webcam feed (viewMode.ts AR plane), so
// the skeleton maps 1:1 onto the feed with no extra flip here.
import type { HandPose } from "../types";

// Skeleton edges: pairs of MediaPipe hand-landmark indices forming the hand graph.
// Mirrors MediaPipe's HAND_CONNECTIONS so the green overlay reads like drawConnectors.
const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
    // thumb
    [0, 1], [1, 2], [2, 3], [3, 4],
    // index
    [0, 5], [5, 6], [6, 7], [7, 8],
    // middle
    [5, 9], [9, 10], [10, 11], [11, 12],
    // ring
    [9, 13], [13, 14], [14, 15], [15, 16],
    // pinky
    [13, 17], [17, 18], [18, 19], [19, 20],
    // palm base
    [0, 17],
];

// Cold-tinted green skeleton, matching the JARVIS feel without clashing with the
// cyan UI. Connector lines are drawn brighter; joints get a translucent halo.
const SKELETON_COLOR = "#39FF6A";
const JOINT_HALO = "rgba(57,255,106,0.35)";
const CONNECTOR_WIDTH = 2;
const JOINT_RADIUS = 3;
const HALO_RADIUS = 5;

// Draw one hand's green skeleton onto ctx. Landmarks are normalized [0,1] image-space
// coordinates, so they scale by the canvas dimensions. No-op when the pose is null
// (world starts empty / single hand may be missing).
function drawSkeleton(ctx: CanvasRenderingContext2D, pose: HandPose | null): void {
    if (!pose) return;
    const lm = pose.landmarks;
    if (!lm || lm.length < 21) return;

    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // Connectors first, joints on top so the dots sit cleanly over the lines.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = CONNECTOR_WIDTH;
    ctx.strokeStyle = SKELETON_COLOR;
    for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a];
        const pb = lm[b];
        ctx.beginPath();
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
        ctx.stroke();
    }

    for (const p of lm) {
        const x = p.x * w;
        const y = p.y * h;
        ctx.fillStyle = JOINT_HALO;
        ctx.beginPath();
        ctx.arc(x, y, HALO_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = SKELETON_COLOR;
        ctx.beginPath();
        ctx.arc(x, y, JOINT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
    }
}

// Clear the transparent overlay canvas and draw both hands' green skeletons over the
// MAIN view. The webcam backs the scene mirrored (selfie) and the landmarks are mirrored
// to match, so they map directly onto the feed with no flip. Called every frame; no-op
// for missing hands.
export function drawSkeletons(
    ctx2d: CanvasRenderingContext2D,
    left: HandPose | null,
    right: HandPose | null,
): void {
    const w = ctx2d.canvas.width;
    const h = ctx2d.canvas.height;
    if (w === 0 || h === 0) return;

    ctx2d.clearRect(0, 0, w, h);
    drawSkeleton(ctx2d, left);
    drawSkeleton(ctx2d, right);
}
