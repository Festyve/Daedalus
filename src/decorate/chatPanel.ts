// DECORATE tool — plain-DOM chat panel + direct-hand decoration (SPEC §8.5, §8.6).
//
// Two independent paths, both writing to the SAME real mesh:
//
//   1. Voice (§8.1, §8.6). A Web Speech API transcript triggers TWO things at once:
//        a. The hardcoded decoration fires IMMEDIATELY — JAM icing flooded across the
//           crown + a batch of rainbow sprinkles on the iced region. This is
//           deterministic and never waits on the AI (the decoration is reliable; the
//           conversation is alive — §8.1).
//        b. The scripted VoiceAdapter streams a reply, which is typewritten into the
//           chat log (~40 chars/sec, blinking cursor) and spoken via TTS.
//
//   2. Direct hand (§8.5), independent of voice. The right (exec) hand:
//        - open-hand smear  → applyIcing at the index-fingertip surface point.
//        - pinch            → drop a sprinkle batch at the surface contact point.
//
// The panel is REAL DOM (no CSS3DRenderer): a fixed 300px column on the right edge,
// layered over the canvas by z-index, pointer-events:none so it never steals hand
// tracking focus. Visual spec is §8.6.
//
// World starts empty (§5.1): ctx.mesh / ctx.bvh may be null. Every mesh access is
// guarded; the Sprinkles controller (which parents to ctx.mesh) is built lazily the
// first time a mesh exists and rebuilt if the mesh identity changes.
import * as THREE from "three";
import type { MenuModule, SceneContext, HandPose } from "../types";
import { MenuId } from "../types";
import { T, FONT } from "../render/tokens";
import { classify } from "../gesture/detect";
import { fingertipToWorld } from "../math/coords";
import { makeVoiceAdapter, SpeechInput } from "./voice";
import { applyIcing, icingMask } from "./icing";
import { Sprinkles } from "./sprinkles";
import { ICING, SPRINKLES } from "./designs";

// ---- Panel visual spec (§8.6) ---------------------------------------------------
const PANEL_W_PX = 300;                       // §8.6 width
const PANEL_BG = T.bgPanel;                    // rgba(0,8,20,0.85)
const PANEL_BORDER = `0.5px solid ${T.cyan}`;  // 0.5px cyan (#00FFD1)
const PANEL_FONT_PX = 12;                       // JetBrains Mono 12px
const USER_BG = "rgba(255,255,255,0.06)";       // user bubble fill (§8.6)
const TEXT = T.text;                            // #FFFFFF
const TEXT_DIM = T.textDim;                     // rgba(255,255,255,0.45)
const ACCENT = T.toolDecorate;                  // #FFD700 DECORATE gold

// Typewriter cadence (§8.6): ~40 chars/sec.
const DEFAULT_CPS = 40;
// Cursor blink half-period (ms): one on/off toggle per this interval.
const CURSOR_BLINK_MS = 530;

// Holographic styling (aspect #27, §1.2 north star: translucent / glowing / weightless).
// One <style> tag, injected once, drives the CSS-only motion so there is ZERO per-frame
// JS work for the panel's float/glow. Motion is eased + slow — JARVIS, never bouncy
// (§14.4). The class name is the panel's existing `.daedalus-chat`.
const HOLO_STYLE_ID = "daedalus-chat-holo";
const HOLO_CSS = `
@keyframes daedalus-chat-in {
    from { opacity: 0; transform: translateY(-50%) translateX(18px); }
    to   { opacity: 1; transform: translateY(-50%) translateX(0); }
}
/* Weightless idle drift: a slow, sub-pixel-scale vertical float layered on top of the
   translateY(-50%) centering. Tiny amplitude so it reads as "floating", not bobbing. */
@keyframes daedalus-chat-float {
    0%   { transform: translateY(calc(-50% - 3px)); }
    50%  { transform: translateY(calc(-50% + 3px)); }
    100% { transform: translateY(calc(-50% - 3px)); }
}
.daedalus-chat {
    animation:
        daedalus-chat-in 150ms cubic-bezier(0.22, 1, 0.36, 1) both,
        daedalus-chat-float 7s ease-in-out 150ms infinite;
}`;

// Inject the holographic stylesheet once (idempotent across panel re-creations).
function ensureHoloStyle(): void {
    if (document.getElementById(HOLO_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HOLO_STYLE_ID;
    style.textContent = HOLO_CSS;
    document.head.appendChild(style);
}

// ---- Direct-hand tuning (§8.5) --------------------------------------------------
// Icing smear radius in mesh object space (the torus tube radius is ~0.42).
const SMEAR_RADIUS = 0.28;
// Sprinkles dropped per pinch (a small handful; well under the §8.4 ~1500 cap).
const DROP_COUNT = 60;
// Sprinkles flooded on the immediate voice-triggered decoration.
const VOICE_SPRINKLE_COUNT = 240;
// Pinch closure (0..1) above which a sprinkle drop edge-triggers; with hysteresis so
// one pinch yields exactly one drop.
const PINCH_ON = 0.7;
const PINCH_OFF = 0.5;
// MediaPipe index-fingertip landmark.
const INDEX_TIP = 8;

// Hardcoded decoration designs (§8.1, §8.2): PINK icing + rainbow sprinkles.
const VOICE_ICING = ICING.pink;
const VOICE_SPRINKLES = SPRINKLES.rainbow;
const SMEAR_ICING = ICING.pink;
const DROP_SPRINKLES = SPRINKLES.rainbow;

/**
 * Plain-DOM chat panel (§8.6). Fixed to the right edge, JetBrains Mono 12px, a
 * "✦ DAEDALUS AI" header with a spinner shown while the AI is processing, and a
 * blinking-cursor input strip. Messages are appended as bubbles: user turns are
 * right-aligned with a faint fill, AI turns are left-aligned with no background and
 * typewritten in. NO CSS3DRenderer — this is a real DOM node appended to the body.
 */
export class ChatPanel {
    readonly el: HTMLElement;

    private readonly log: HTMLDivElement;
    private readonly spinner: HTMLSpanElement;
    private readonly cursor: HTMLSpanElement;

    // The AI bubble currently being filled (by appendAI / typewrite), if any.
    private aiBubble: HTMLDivElement | null = null;
    // Self-driven typewriter timer for typewrite(); cleared on dispose / re-arm.
    private typeTimer: number | null = null;
    private cursorTimer: number | null = null;

    constructor() {
        ensureHoloStyle();
        const root = document.createElement("div");
        root.className = "daedalus-chat";
        root.style.cssText = [
            "position:fixed",
            "top:50%",
            "right:24px",
            "transform:translateY(-50%)",
            "z-index:31",
            `width:${PANEL_W_PX}px`,
            "max-height:78vh",
            "box-sizing:border-box",
            "display:flex",
            "flex-direction:column",
            "overflow:hidden",
            `background:${PANEL_BG}`,
            `border:${PANEL_BORDER}`,
            "border-radius:10px",
            // Holographic edge (aspect #27): inner cyan wash + an outer luminous cyan halo
            // so the panel glows as if projected, plus a soft drop for depth off the canvas.
            `box-shadow:inset 0 0 24px ${T.cyanDim},0 0 28px ${T.cyanDim},0 0 18px rgba(0,0,0,0.55)`,
            `font-family:${FONT}`,
            `font-size:${PANEL_FONT_PX}px`,
            "line-height:1.5",
            `color:${TEXT}`,
            // Translucent depth: blur + slight desaturation reads as a glass hologram.
            "backdrop-filter:blur(4px) saturate(1.1)",
            "-webkit-backdrop-filter:blur(4px) saturate(1.1)",
            // Never steal hand-tracking pointer focus from the canvas (§4.2).
            "pointer-events:none",
            "user-select:none",
        ].join(";");

        // Header: "✦ DAEDALUS AI" + a spinner that animates while the AI is replying.
        const header = document.createElement("div");
        header.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:8px",
            "flex:0 0 auto",
            "padding:12px 14px",
            `border-bottom:0.5px solid ${T.cyanDim}`,
            "letter-spacing:0.08em",
        ].join(";");
        const title = document.createElement("span");
        title.textContent = "✦ DAEDALUS AI";   // ✦
        title.style.cssText = [
            `color:${ACCENT}`,
            "font-weight:700",
            `text-shadow:0 0 8px ${ACCENT}`,
        ].join(";");
        const spinner = document.createElement("span");
        spinner.textContent = "◍";              // ◍
        spinner.style.cssText = [
            `color:${TEXT_DIM}`,
            "margin-left:auto",
            "visibility:hidden",
            "display:inline-block",
        ].join(";");
        header.appendChild(title);
        header.appendChild(spinner);

        // Message log: newest at the bottom, clipped (no scrollbar UI in the demo).
        const log = document.createElement("div");
        log.style.cssText = [
            "flex:1 1 auto",
            "min-height:0",
            "display:flex",
            "flex-direction:column",
            "gap:8px",
            "padding:14px",
            "overflow:hidden",
            "justify-content:flex-end",
        ].join(";");

        // Bottom input strip with a blinking cursor (purely cosmetic — §8.6).
        const input = document.createElement("div");
        input.style.cssText = [
            "display:flex",
            "align-items:center",
            "flex:0 0 auto",
            "gap:2px",
            "margin:0 14px 12px",
            "padding:8px 10px",
            `border:0.5px solid ${T.cyanDim}`,
            "border-radius:6px",
            `color:${TEXT_DIM}`,
            "min-height:16px",
        ].join(";");
        const placeholder = document.createElement("span");
        placeholder.textContent = "speak to decorate";
        const cursor = document.createElement("span");
        cursor.textContent = "▋";               // ▋
        cursor.style.cssText = [`color:${ACCENT}`, "margin-left:2px"].join(";");
        input.appendChild(placeholder);
        input.appendChild(cursor);

        root.appendChild(header);
        root.appendChild(log);
        root.appendChild(input);

        this.el = root;
        this.log = log;
        this.spinner = spinner;
        this.cursor = cursor;

        this.startCursorBlink();
    }

    // Blink the input cursor on a self-driven timer so it keeps pulsing between hand
    // frames (independent of the rAF clock).
    private startCursorBlink(): void {
        let on = true;
        this.cursorTimer = window.setInterval(() => {
            on = !on;
            this.cursor.style.opacity = on ? "1" : "0";
        }, CURSOR_BLINK_MS);
    }

    // Build a role-styled message bubble (§8.6): user right-aligned with a faint fill,
    // AI left-aligned with no background.
    private makeBubble(role: "user" | "ai"): HTMLDivElement {
        const b = document.createElement("div");
        b.style.cssText = [
            "max-width:82%",
            role === "user" ? "padding:6px 9px" : "padding:2px 0",
            "border-radius:8px",
            "line-height:1.45",
            "white-space:pre-wrap",
            "word-break:break-word",
            `color:${TEXT}`,
            role === "user" ? "align-self:flex-end" : "align-self:flex-start",
            role === "user" ? `background:${USER_BG}` : "background:transparent",
        ].join(";");
        return b;
    }

    // Append a finished user message (right-aligned bubble). Hides the AI spinner.
    addUser(t: string): void {
        const b = this.makeBubble("user");
        b.textContent = t;
        this.log.appendChild(b);
        this.spinner.style.visibility = "hidden";
    }

    // Open a fresh AI turn: a new left-aligned bubble + the processing spinner. The
    // bubble is then filled either live (appendAI) or by typewrite().
    beginAI(): void {
        this.cancelTypewriter();
        const b = this.makeBubble("ai");
        b.style.color = TEXT_DIM;            // dim while in-progress; settles on finalize
        this.log.appendChild(b);
        this.aiBubble = b;
        this.spinner.style.visibility = "visible";
    }

    // Append a streamed chunk to the active AI bubble (live token streaming from the
    // VoiceAdapter). Opens a bubble if none is active.
    appendAI(chunk: string): void {
        if (!this.aiBubble) this.beginAI();
        this.aiBubble!.textContent += chunk;
    }

    // Settle the active AI turn: full brightness, spinner off. Called when a streamed
    // reply completes.
    finalizeAI(): void {
        if (this.aiBubble) this.aiBubble.style.color = TEXT;
        this.aiBubble = null;
        this.spinner.style.visibility = "hidden";
    }

    // Typewrite `text` into a fresh AI bubble at `cps` chars/sec on a self-driven
    // timer (§8.6, ~40 cps default). The spinner runs while typing and clears when the
    // last character lands. Re-arming cancels any prior typewriter.
    typewrite(text: string, cps: number = DEFAULT_CPS): void {
        this.beginAI();
        const bubble = this.aiBubble!;
        const rate = cps > 0 ? cps : DEFAULT_CPS;
        const intervalMs = 1000 / rate;
        let i = 0;
        const tick = (): void => {
            i = Math.min(text.length, i + 1);
            bubble.textContent = text.slice(0, i);
            if (i >= text.length) {
                this.typeTimer = null;
                this.finalizeAI();
                return;
            }
            this.typeTimer = window.setTimeout(tick, intervalMs);
        };
        tick();
    }

    private cancelTypewriter(): void {
        if (this.typeTimer !== null) {
            clearTimeout(this.typeTimer);
            this.typeTimer = null;
        }
    }

    // Remove from the DOM and stop all timers.
    dispose(): void {
        this.cancelTypewriter();
        if (this.cursorTimer !== null) {
            clearInterval(this.cursorTimer);
            this.cursorTimer = null;
        }
        this.el.remove();
    }
}

/**
 * DECORATE menu module (§8.5, §8.6). enter() mounts the chat panel and starts voice
 * capture; a transcript fires the hardcoded decoration immediately and streams the
 * scripted reply. update() runs the direct-hand path (smear icing / pinch sprinkles)
 * on the right hand, independent of voice. The plain-DOM panel is exposed via .panel.
 */
export function createDecorateMenu(): MenuModule {
    let chat: ChatPanel | null = null;
    let speech: SpeechInput | null = null;
    const voice = makeVoiceAdapter();

    // Sprinkles controller. It parents its InstancedMesh under the target mesh on each
    // drop, so a single instance (built in enter) serves any mesh that exists.
    let sprinkles: Sprinkles | null = null;

    // Direct-hand pinch latch (hysteresis): one pinch → one sprinkle drop.
    let pinchLatched = false;
    // Previous-frame landmarks for classify()'s flick/velocity channel.
    let prevExecLm: HandPose["landmarks"] | null = null;

    // Fire the hardcoded decoration on the real mesh (§8.1 step 3): flood JAM icing
    // across the crown, then scatter rainbow sprinkles on the iced region. Deterministic
    // and reliable; never blocked on the AI reply. No-op while the world is empty.
    function fireDecoration(ctx: SceneContext): void {
        if (!ctx.mesh || !ctx.bvh) return;
        // The vertex-color icing MULTIPLIES the mesh's base albedo, and shapes ship a CYAN base — so
        // pink would read muddy. Flag the mesh decorated and switch its base to white so the pink
        // icing renders true; core/shapes.refreshHighlight keeps decorated meshes on a white base.
        ctx.mesh.userData.decorated = true;
        const mat = ctx.mesh.material as THREE.MeshStandardMaterial;
        mat.color.setRGB(1, 1, 1);
        // Frosting + dough are matte, not metallic — drop the metalness and the cyan emissive so the
        // body reads a clean neutral grey (otherwise the lit white reflects a teal sheen).
        mat.metalness = 0.0;
        mat.roughness = 0.7;
        mat.emissive.setRGB(0.04, 0.04, 0.05);
        ctx.mesh.updateWorldMatrix(true, false);
        ctx.mesh.getWorldPosition(ctx.scratch.v1);
        // Flood the crown: paint at the mesh center so the height-mask gate (§8.3) lets
        // icing stick across the whole top with a noisy drip boundary below the line.
        applyIcing(ctx.mesh, ctx.bvh, ctx.scratch.v1, 4.0, VOICE_ICING);
        // Drop sprinkles on the freshly-iced region (mask weights the surface sampler).
        if (sprinkles) sprinkles.dropBatch(ctx.mesh, icingMask(ctx.mesh), VOICE_SPRINKLES, VOICE_SPRINKLE_COUNT);
    }

    // Handle a finalized voice transcript (§8.1): show it, fire the decoration NOW,
    // then stream + speak the scripted reply with the typewriter.
    function onTranscript(ctx: SceneContext, transcript: string): void {
        if (!chat) return;
        chat.addUser(transcript);
        fireDecoration(ctx);

        chat.beginAI();
        voice.speak(transcriptReply(transcript));
        void voice.respond(transcript, (chunk) => {
            chat?.appendAI(chunk);
        }).then(() => {
            chat?.finalizeAI();
        });
    }

    function enter(ctx: SceneContext): void {
        pinchLatched = false;
        prevExecLm = null;

        chat = new ChatPanel();
        document.body.appendChild(chat.el);

        // One sprinkle controller for both the voice flood and direct pinch-drops; it
        // re-parents under whichever mesh is active on each drop (§8.4).
        sprinkles = new Sprinkles(ctx.scene);

        // Hard-coded decoration: ice the shape pink + scatter sprinkles the moment DECORATE opens,
        // so it always works (never blocked on speech recognition / a spoken prompt).
        fireDecoration(ctx);

        // Start listening too; a spoken prompt re-fires + streams a scripted reply. The adapter
        // degrades to no-ops when the browser lacks SpeechRecognition (§8.1).
        speech = new SpeechInput((t) => onTranscript(ctx, t));
        speech.start();
    }

    function update(
        ctx: SceneContext,
        exec: HandPose | null,
        _nav: HandPose | null,
        _dt: number,
    ): void {
        // Direct-hand decoration (§8.5) from the right (exec) hand. Guard the empty
        // world: nothing to decorate until ADD SHAPES creates a mesh.
        if (!exec || !ctx.mesh || !ctx.bvh) {
            pinchLatched = false;
            prevExecLm = exec ? exec.landmarks : null;
            return;
        }

        const lm = exec.landmarks;
        const g = classify(lm, exec.world, prevExecLm);
        prevExecLm = lm;

        // Index fingertip → world on the interaction plane (zero-alloc; reuses scratch).
        const world = fingertipToWorld(
            lm[INDEX_TIP],
            ctx.camera,
            ctx.interactionPlaneZ,
            ctx.scratch.ray,
            ctx.scratch.plane,
            ctx.scratch.v2,
        );

        // Pinch → drop a sprinkle batch at the surface contact (edge-triggered with
        // hysteresis so a held pinch fires exactly once). Sprinkles land on the iced
        // region only (mask-weighted), so a pinch over bare steel is a quiet no-op.
        if (g.pinch >= PINCH_ON && !pinchLatched) {
            if (sprinkles) sprinkles.dropBatch(ctx.mesh, icingMask(ctx.mesh), DROP_SPRINKLES, DROP_COUNT);
            pinchLatched = true;
        } else if (g.pinch <= PINCH_OFF) {
            pinchLatched = false;
        }

        // Open-hand smear (not pinching) → paint icing under the index fingertip.
        if (g.pinch < PINCH_ON && (g.name === "open" || g.name === "point")) {
            applyIcing(ctx.mesh, ctx.bvh, world, SMEAR_RADIUS, SMEAR_ICING);
        }
    }

    function exit(_ctx: SceneContext): void {
        if (speech) {
            speech.stop();
            speech = null;
        }
        if (sprinkles) {
            sprinkles.dispose();
            sprinkles = null;
        }
        if (chat) {
            chat.dispose();
            chat = null;
        }
        pinchLatched = false;
        prevExecLm = null;
    }

    return {
        id: MenuId.DECORATE,
        enter,
        update,
        exit,
        get panel(): HTMLElement | undefined {
            return chat?.el;
        },
    };
}

// Local mirror of the scripted-reply selection so TTS speaks the SAME line the chat
// streams. The VoiceAdapter.respond() stream is the source of the on-screen text; this
// keeps speak() in lockstep without exposing the adapter's internal reply table.
function transcriptReply(transcript: string): string {
    const hay = transcript.toLowerCase();
    for (const rule of REPLY_RULES) {
        if (rule.keywords.some((k) => hay.includes(k))) return rule.reply;
    }
    return DEFAULT_REPLY;
}

interface ReplyRule {
    keywords: string[];
    reply: string;
}
const REPLY_RULES: ReplyRule[] = [
    { keywords: ["rainbow", "sprinkle"], reply: "On it — rainbow sprinkles and a glossy jam glaze, coming right up." },
    { keywords: ["jam", "icing", "glaze", "frost"], reply: "Applying a rich jam icing across the top. Looking delicious already." },
    { keywords: ["galaxy", "cosmic", "space", "star"], reply: "Cosmic mode: deep glaze and a scatter of star-bright sprinkles." },
    { keywords: ["healthy", "diet", "sugar-free", "calorie"], reply: "I'm a torus decorator, not a miracle worker — adding extra sprinkles instead." },
    { keywords: ["clear", "reset", "remove", "plain"], reply: "Wiping it back to a clean canvas. Ready when you are." },
    { keywords: ["thank", "thanks", "nice", "love", "great"], reply: "My pleasure. This torus turned out beautifully." },
];
const DEFAULT_REPLY = "Decorating now — jam icing and a burst of rainbow sprinkles.";
