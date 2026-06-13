// Mock-mode dev overlay (SPEC §10.2). Active only under `?mock=1` — `main.ts`
// passes the resolved flag to the constructor. Draws a synthetic 21-point hand
// skeleton from the latest PoseFrame plus a small telemetry readout (gesture,
// active tool, morph t, FPS) so the mock input can be driven without a webcam.
//
// Self-contained: plain DOM + a single 2D canvas, fixed to the LEFT edge so it
// never collides with the HUD chrome (top-left/bottom-left text, top-right FPS)
// or the right-anchored tool/chat panels. Cheap per-frame: clears one canvas and
// strokes ≤42 landmarks; no allocation in the draw path; guards every null hand
// so it can never throw when a frame reports zero or one hand.
import type { PoseFrame, HandPose, Handedness } from "../types";
import { MenuId, MENU_LABEL } from "../types";
import { T, FONT } from "../render/tokens";

// MediaPipe hand topology: index pairs into the 21-landmark array (§3). Drawn as
// connecting bones between filtered, image-space landmarks. Module-level constant
// so it is allocated exactly once, never per frame.
const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
    // palm
    [0, 1], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17],
    // thumb
    [1, 2], [2, 3], [3, 4],
    // index
    [5, 6], [6, 7], [7, 8],
    // middle
    [9, 10], [10, 11], [11, 12],
    // ring
    [13, 14], [14, 15], [15, 16],
    // pinky
    [17, 18], [18, 19], [19, 20],
];

// Per-hand skeleton tint. Left/right read distinctly against the dark scene.
const HAND_COLOR: Record<Handedness, string> = {
    Left: T.toolTranslate, // soft blue
    Right: T.cyan,         // primary cyan
};

const CANVAS_W = 220;
const CANVAS_H = 165;

// Ambient pulse for the live-status dot. Injected once, GPU-animated.
const PULSE_ANIM = "daedalus-mock-pulse";

export class DevOverlay {
    private readonly enabled: boolean;
    // All of the following are non-null only while enabled. Guarded behind
    // `this.enabled` so the disabled overlay holds no DOM and costs nothing.
    private root: HTMLDivElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private ctx2d: CanvasRenderingContext2D | null = null;
    private readout: HTMLDivElement | null = null;

    constructor(enabled: boolean) {
        this.enabled = enabled;
        if (!this.enabled) return;
        this.build();
    }

    // Per-frame refresh. No-op when disabled. Never throws on null hands.
    update(s: { frame: PoseFrame; gesture: string; tool: MenuId | null; morphT: number; fps: number }): void {
        if (!this.enabled || !this.ctx2d || !this.canvas || !this.readout) return;

        const ctx = this.ctx2d;
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

        // Faint frame so the skeleton region reads as a distinct viewport.
        ctx.strokeStyle = T.cyanDim;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);

        // Mock landmarks live in mirrored, normalized image space (§3): x,y in
        // 0..1. Both hands are drawn into the same mini viewport.
        this.drawHand(ctx, s.frame.Left, HAND_COLOR.Left);
        this.drawHand(ctx, s.frame.Right, HAND_COLOR.Right);

        const tool_label = s.tool !== null ? MENU_LABEL[s.tool] : "—";
        const morph_pct = `${Math.round(clamp01(s.morphT) * 100)}%`;
        this.readout.innerHTML =
            row("hands", String(s.frame.count)) +
            row("gesture", s.gesture || "none") +
            row("tool", tool_label) +
            row("morph t", `${s.morphT.toFixed(2)} · ${morph_pct}`) +
            row("fps", String(Math.round(s.fps)));
    }

    // Stroke one hand's bones and joints. Silently skips a null/short hand so a
    // single-hand or no-hand frame is safe.
    private drawHand(ctx: CanvasRenderingContext2D, hand: HandPose | null, color: string): void {
        if (!hand || hand.landmarks.length < 21) return;
        const lm = hand.landmarks;

        // Bones.
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
            const a = lm[HAND_CONNECTIONS[i][0]];
            const b = lm[HAND_CONNECTIONS[i][1]];
            if (!a || !b) continue;
            ctx.moveTo(a.x * CANVAS_W, a.y * CANVAS_H);
            ctx.lineTo(b.x * CANVAS_W, b.y * CANVAS_H);
        }
        ctx.stroke();

        // Joints. Index tip (8) drawn larger — it is the mock cursor (§10.2).
        ctx.fillStyle = color;
        for (let i = 0; i < 21; i++) {
            const p = lm[i];
            if (!p) continue;
            const r = i === 8 ? 3 : 1.6;
            ctx.beginPath();
            ctx.arc(p.x * CANVAS_W, p.y * CANVAS_H, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Construct the fixed-left panel: title, skeleton canvas, telemetry block.
    private build(): void {
        const root = document.createElement("div");
        root.style.position = "fixed";
        root.style.left = "20px";
        root.style.top = "50%";
        root.style.transform = "translateY(-50%)";
        root.style.width = `${CANVAS_W}px`;
        root.style.padding = "10px";
        root.style.boxSizing = "content-box";
        root.style.background = T.bgPanel;
        root.style.border = `0.5px solid ${T.cyanDim}`;
        root.style.borderRadius = "6px";
        root.style.fontFamily = FONT;
        root.style.color = T.text;
        root.style.pointerEvents = "none";
        root.style.zIndex = "5";
        root.style.userSelect = "none";

        // Header reads as the engineering story: a slow-pulsing live dot beside
        // the mode label. CSS-driven ambient pulse (§14.4: ~2s sine, eased,
        // nothing bouncy) — animates on the GPU, costs nothing in the draw loop.
        injectPulseStyleOnce();
        const title = document.createElement("div");
        title.style.display = "flex";
        title.style.alignItems = "center";
        title.style.gap = "7px";
        title.style.marginBottom = "8px";

        const dot = document.createElement("span");
        dot.style.width = "6px";
        dot.style.height = "6px";
        dot.style.borderRadius = "50%";
        dot.style.background = T.cyan;
        dot.style.boxShadow = `0 0 6px ${T.cyan}`;
        dot.style.flex = "0 0 auto";
        dot.style.animation = `${PULSE_ANIM} 2s ease-in-out infinite`;
        title.appendChild(dot);

        const label = document.createElement("span");
        label.textContent = "MOCK // DEV";
        label.style.color = T.cyan;
        label.style.fontSize = "10px";
        label.style.fontWeight = "700";
        label.style.letterSpacing = "0.22em";
        title.appendChild(label);
        root.appendChild(title);

        const canvas = document.createElement("canvas");
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        canvas.style.width = `${CANVAS_W}px`;
        canvas.style.height = `${CANVAS_H}px`;
        canvas.style.display = "block";
        canvas.style.background = T.bg;
        canvas.style.borderRadius = "3px";
        root.appendChild(canvas);

        const readout = document.createElement("div");
        readout.style.marginTop = "8px";
        readout.style.fontSize = "11px";
        readout.style.lineHeight = "1.5";
        readout.style.letterSpacing = "0.04em";
        root.appendChild(readout);

        document.body.appendChild(root);

        this.root = root;
        this.canvas = canvas;
        this.ctx2d = canvas.getContext("2d");
        this.readout = readout;
    }
}

// One telemetry line: dimmed label, primary value. Returns markup, not a node —
// the readout is a single innerHTML assignment per frame.
function row(label: string, value: string): string {
    return (
        `<div style="display:flex;justify-content:space-between;gap:8px">` +
        `<span style="color:${T.textDim}">${label}</span>` +
        `<span style="color:${T.text}">${escapeHtml(value)}</span>` +
        `</div>`
    );
}

// Inject the ambient-pulse keyframes a single time, the first time an overlay is
// built. Slow opacity sine on the status dot — deliberate, never bouncy (§14.4).
function injectPulseStyleOnce(): void {
    if (document.getElementById(PULSE_ANIM)) return;
    const style = document.createElement("style");
    style.id = PULSE_ANIM;
    style.textContent =
        `@keyframes ${PULSE_ANIM}{` +
        `0%,100%{opacity:1}` +
        `50%{opacity:0.35}` +
        `}`;
    document.head.appendChild(style);
}

function clamp01(x: number): number {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Telemetry values are developer-controlled (gesture/tool labels), but escape
// anyway so an unexpected string can never inject markup into the readout.
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
