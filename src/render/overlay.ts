// Webcam corner overlay (§11): a small desaturated mirror of the camera feed with
// a green hand skeleton drawn on top. Ported from _drawOverlay in js/handTracking.js
// into standalone functions fed by the tracking layer's HandPose.
import type { HandPose } from "../types";

// Skeleton edges: pairs of landmark indices forming the hand graph (from
// js/handTracking.js CONNECTIONS).
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
];

const SKELETON_COLOR = "#39FF6A"; // cold-tinted green skeleton

// Draw one hand's green skeleton onto ctx. Landmarks are in normalized [0,1] image
// space, so they scale by the canvas dimensions. No-op when pose is null.
export function drawSkeleton(ctx: CanvasRenderingContext2D, pose: HandPose | null): void {
    if (!pose) return;
    const lm = pose.landmarks;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.strokeStyle = SKELETON_COLOR;
    ctx.fillStyle = SKELETON_COLOR;
    ctx.lineWidth = 2;
    for (const [a, b] of HAND_CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(lm[a].x * w, lm[a].y * h);
        ctx.lineTo(lm[b].x * w, lm[b].y * h);
        ctx.stroke();
    }
    for (const p of lm) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
        ctx.fill();
    }
}

// Render the full overlay for a frame: the desaturated mirrored video frame plus
// both hands' skeletons. The source video is mirrored (selfie) to match detection,
// and `grayscale` desaturates it so the green skeleton reads clearly on top.
export function drawOverlay(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    left: HandPose | null,
    right: HandPose | null,
): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    ctx.save();
    ctx.filter = "grayscale(1) brightness(0.7) contrast(1.1)";
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();

    drawSkeleton(ctx, left);
    drawSkeleton(ctx, right);
}
