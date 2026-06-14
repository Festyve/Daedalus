// HUD chrome (SPEC §14.3): plain-DOM, token-driven overlay painted into #chrome.
//   - Top-left:    DAEDALUS // {PHASE}        (uppercase, wide letter-spacing — §14.2)
//   - Bottom-left: active tool + instruction  (lowercase HUD, accent-tinted — §14.2)
//   - Top-right:   FPS via stats.js           (re-anchored, dimmed monochrome)
// Three fixed regions only. The ❓ guide popout lives in ui/instructionsPopout.ts.
// Render layers (§4.3) do not apply here: this is DOM, not scene geometry.
import type { Stage, ViewMode, GestureName } from "../types";
import { MenuId, MENU_LABEL } from "../types";
import { T, TOOL_ACCENT, FONT, GLASS_BG, GLASS_BLUR, panelGlow } from "../render/tokens";

// One-line operating hint per tool, shown after the active-tool label (§14.3).
// Lowercase to match the HUD typography rule (§14.2). Six tools, no more.
const MENU_INSTRUCTION: Record<MenuId, string> = {
    [MenuId.ADD_SHAPES]: "right pinch to cycle shape · left pinch to spawn",
    [MenuId.SELECT]: "right fist moves cursor · left fist selects · left pinch = hole",
    [MenuId.TRANSLATE]: "right open palm to grab · right fist to lock",
    [MenuId.DILATE]: "both fists to grab · hands apart / together to scale",
    [MenuId.ROTATE]: "right pinch near the object · twist · release to latch",
    [MenuId.MORPH]: "both fists · jiggle to morph sphere → torus",
    [MenuId.DECORATE]: "right palm to ice · right pinch for sprinkles · or speak",
    [MenuId.INTERACT]: "right pinch picks union / subtract / intersect · left pinch applies",
    [MenuId.DESTROY]: "right pinch destroys all selected shapes",
};

// Instruction shown when no menu is active (world idle / carousel closed).
const IDLE_INSTRUCTION = "right-hand gun opens the menu wheel";

// Live-gesture readout (§14.3 "active gestures"): the committed pose, shown as a
// leading badge on the instruction line so the HUD always reflects what DAEDALUS
// currently recognizes. Lowercase to match HUD typography (§14.2). "none"/"point"
// are resting states and carry no badge, keeping the line quiet until a real pose.
const GESTURE_VERB: Record<GestureName, string> = {
    none: "",
    point: "",
    fist: "fist",
    open: "open",
    pinch: "pinch",
    gun: "gun",
    flick: "flick",
};

// Ambient pulse for the live status dots, injected once. Slow opacity sine — deliberate,
// never bouncy (§14.4). GPU-animated so the HUD draw loop stays allocation-free.
const PULSE_ANIM = "daedalus-hud-pulse";
function injectPulseOnce(): void {
    if (document.getElementById(PULSE_ANIM)) return;
    const style = document.createElement("style");
    style.id = PULSE_ANIM;
    style.textContent = `@keyframes ${PULSE_ANIM}{0%,100%{opacity:1}50%{opacity:0.3}}`;
    document.head.appendChild(style);
}

// A small pulsing status dot (the JARVIS "system live" tell). Tinted by `color`.
function makeDot(color: string): HTMLSpanElement {
    const dot = document.createElement("span");
    Object.assign(dot.style, {
        width: "6px", height: "6px", borderRadius: "50%",
        background: color, boxShadow: `0 0 7px ${color}`,
        flex: "0 0 auto", display: "inline-block",
        animation: `${PULSE_ANIM} 2.4s ease-in-out infinite`,
    });
    return dot;
}

export class Chrome {
    private readonly root: HTMLElement;
    private readonly stage_el: HTMLDivElement;
    private readonly stageName_el: HTMLSpanElement;
    private readonly stagePhase_el: HTMLSpanElement;
    private readonly count_el: HTMLDivElement;
    private readonly tool_el: HTMLDivElement;
    private readonly hint_el: HTMLDivElement;
    private readonly bottomPill: HTMLDivElement;
    private readonly accentBar: HTMLDivElement;
    private readonly fps_el: HTMLDivElement;
    private readonly fpsNum_el: HTMLSpanElement;

    // Self-measured, smoothed frame rate (EMA) for the custom FPS readout — replaces the
    // stock stats.js panel so the meter matches the HUD typography instead of a gray box.
    private lastBegin = 0;
    private emaFps = 0;

    constructor() {
        const root = document.getElementById("chrome");
        if (!root) throw new Error("Chrome: #chrome element not found");
        this.root = root;
        injectPulseOnce();

        // Top-left: branded stage chip. A live status dot + "DAEDALUS" wordmark (bright) and
        // the phase (dimmed) so the brand and the state read as a hierarchy, not one flat run.
        this.stage_el = document.createElement("div");
        Object.assign(this.stage_el.style, {
            position: "fixed", left: "16px", top: "16px",
            display: "flex", alignItems: "center", gap: "9px",
            fontFamily: FONT, whiteSpace: "nowrap", pointerEvents: "none",
            fontSize: "13px", fontWeight: "700",
            letterSpacing: "0.24em", textTransform: "uppercase",
            color: T.text,
            padding: "8px 14px",
            background: GLASS_BG,
            backdropFilter: GLASS_BLUR, WebkitBackdropFilter: GLASS_BLUR,
            borderRadius: "8px",
            border: `1px solid ${T.cyan}40`,
            boxShadow: panelGlow(T.cyan),
        });
        this.stage_el.appendChild(makeDot(T.cyan));
        this.stageName_el = document.createElement("span");
        this.stageName_el.textContent = "DAEDALUS";
        this.stageName_el.style.color = T.cyan;
        this.stageName_el.style.textShadow = `0 0 8px ${T.cyan}66`;
        const sep = document.createElement("span");
        sep.textContent = "//";
        sep.style.color = T.textDim;
        this.stagePhase_el = document.createElement("span");
        this.stagePhase_el.style.color = "rgba(255,255,255,0.82)";
        this.stage_el.append(this.stageName_el, sep, this.stagePhase_el);
        this.root.appendChild(this.stage_el);

        // Top-center: selection counter pill. Hidden (display:none) when nothing is selected
        // so the HUD stays quiet — no empty pill visible (§14.3, item 7).
        this.count_el = document.createElement("div");
        Object.assign(this.count_el.style, {
            position: "fixed", top: "16px", left: "50%",
            transform: "translateX(-50%)",
            fontFamily: FONT, whiteSpace: "nowrap", pointerEvents: "none",
            fontSize: "13px", fontWeight: "600",
            letterSpacing: "0.18em", textTransform: "uppercase",
            color: T.toolSelect,
            padding: "8px 18px",
            background: GLASS_BG,
            backdropFilter: GLASS_BLUR, WebkitBackdropFilter: GLASS_BLUR,
            borderRadius: "8px",
            border: `1px solid ${T.toolSelect}55`,
            boxShadow: panelGlow(T.toolSelect),
            display: "none",
        });
        this.root.appendChild(this.count_el);

        // Bottom-left: pill container holding the active-tool label stacked above the hint.
        // A left accent bar carries the tool color so the active tool reads at a glance even
        // before the eye reaches the label text. `overflow:hidden` clips the bar to the radius.
        this.bottomPill = document.createElement("div");
        Object.assign(this.bottomPill.style, {
            position: "fixed", left: "16px", bottom: "16px",
            fontFamily: FONT, whiteSpace: "nowrap", pointerEvents: "none",
            padding: "11px 18px 11px 20px",
            background: GLASS_BG,
            backdropFilter: GLASS_BLUR, WebkitBackdropFilter: GLASS_BLUR,
            borderRadius: "10px",
            border: `1px solid ${T.cyan}44`,
            boxShadow: panelGlow(T.cyan),
            overflow: "hidden",
        });
        this.root.appendChild(this.bottomPill);
        this.accentBar = document.createElement("div");
        Object.assign(this.accentBar.style, {
            position: "absolute", left: "0", top: "0", bottom: "0",
            width: "4px", background: T.cyan,
            boxShadow: `0 0 10px ${T.cyan}`,
        });
        this.bottomPill.appendChild(this.accentBar);

        // Active tool name (accent-tinted, updated per-tool in render()).
        this.tool_el = document.createElement("div");
        Object.assign(this.tool_el.style, {
            fontSize: "14px", fontWeight: "600",
            letterSpacing: "0.18em",
            color: T.cyan,
            marginBottom: "5px",
        });
        this.bottomPill.appendChild(this.tool_el);

        // One-line operating hint (bright white, static contrast from pill bg).
        this.hint_el = document.createElement("div");
        Object.assign(this.hint_el.style, {
            fontSize: "12px", letterSpacing: "0.10em",
            color: "rgba(255,255,255,0.92)",
        });
        this.bottomPill.appendChild(this.hint_el);

        // Top-right: themed FPS readout — a pulsing dot + smoothed number, replacing the stock
        // stats.js panel so the meter reads as chrome (mono, cyan) rather than a gray widget.
        this.fps_el = document.createElement("div");
        Object.assign(this.fps_el.style, {
            position: "fixed", top: "16px", right: "16px",
            display: "flex", alignItems: "center", gap: "8px",
            fontFamily: FONT, whiteSpace: "nowrap", pointerEvents: "none",
            fontSize: "12px", fontWeight: "600", letterSpacing: "0.16em",
            color: T.textDim,
            padding: "8px 13px",
            background: GLASS_BG,
            backdropFilter: GLASS_BLUR, WebkitBackdropFilter: GLASS_BLUR,
            borderRadius: "8px",
            border: `1px solid ${T.cyan}2e`,
            boxShadow: panelGlow(T.cyan),
        });
        this.fps_el.appendChild(makeDot(T.cyan));
        this.fpsNum_el = document.createElement("span");
        this.fpsNum_el.style.color = "rgba(255,255,255,0.88)";
        this.fpsNum_el.textContent = "--";
        const fpsUnit = document.createElement("span");
        fpsUnit.textContent = "FPS";
        this.fps_el.append(this.fpsNum_el, fpsUnit);
        this.root.appendChild(this.fps_el);

        // Paint an initial empty-world state so the HUD is legible before the
        // first frame (world starts EMPTY, no active menu — §5.1).
        this.render({ stage: "EMPTY", activeMenu: null });
    }

    // Build a fixed-position HUD text element parented to #chrome.
    private makeLabel(pos: { left?: string; right?: string; top?: string; bottom?: string }): HTMLDivElement {
        const el = document.createElement("div");
        el.style.position = "fixed";
        el.style.fontFamily = FONT;
        el.style.whiteSpace = "nowrap";
        el.style.pointerEvents = "none";
        // Dark halo so HUD text stays legible over the live camera feed (§14.3).
        el.style.textShadow = "0 0 6px rgba(0,0,0,0.92), 0 0 2px rgba(0,0,0,0.92)";
        if (pos.left !== undefined) el.style.left = pos.left;
        if (pos.right !== undefined) el.style.right = pos.right;
        if (pos.top !== undefined) el.style.top = pos.top;
        if (pos.bottom !== undefined) el.style.bottom = pos.bottom;
        this.root.appendChild(el);
        return el;
    }

    // Refresh the text content for a new HUD state. Cheap string assignment only;
    // safe to call every frame (no allocation, no layout thrash beyond text set).
    private render(state: { stage: Stage; activeMenu: MenuId | null; gesture?: GestureName; selectedCount?: number }): void {
        this.stagePhase_el.textContent = state.stage;

        // Selection counter: show pill only when at least one shape is selected.
        const n = state.selectedCount ?? 0;
        if (n > 0) {
            this.count_el.textContent = `${n} shape${n === 1 ? "" : "s"} selected`;
            this.count_el.style.display = "";
        } else {
            this.count_el.textContent = "";
            this.count_el.style.display = "none";
        }

        const base = state.activeMenu !== null ? MENU_INSTRUCTION[state.activeMenu] : IDLE_INSTRUCTION;
        if (state.activeMenu !== null) {
            const accent = TOOL_ACCENT[state.activeMenu];
            this.tool_el.textContent = MENU_LABEL[state.activeMenu].toLowerCase();
            this.tool_el.style.color = accent;
            this.bottomPill.style.borderColor = accent + "55";
            this.bottomPill.style.boxShadow = panelGlow(accent);
            this.accentBar.style.background = accent;
            this.accentBar.style.boxShadow = `0 0 10px ${accent}`;
        } else {
            this.tool_el.textContent = "no tool";
            this.tool_el.style.color = T.textDim;
            this.bottomPill.style.borderColor = T.cyan + "44";
            this.bottomPill.style.boxShadow = panelGlow(T.cyan);
            this.accentBar.style.background = T.textDim;
            this.accentBar.style.boxShadow = "none";
        }

        // Always surface the current gesture: when a real pose is recognized, lead the
        // instruction line with a live badge ("▸ pinch · …"); resting states (none/point)
        // leave the static per-tool hint untouched. Cheap string set, no allocation.
        const verb = state.gesture !== undefined ? GESTURE_VERB[state.gesture] : "";
        this.hint_el.textContent = verb !== "" ? `▸ ${verb} · ${base}` : base;
    }

    // Public per-frame update of the HUD labels. `viewMode` is part of the §14.3
    // chrome contract; it is accepted here (optional) so this compiles against both
    // the current and rewritten main.ts. The FPS meter and the three text regions
    // read identically in scene and AR mode, so it currently drives no branch.
    update(s: { stage: Stage; activeMenu: MenuId | null; viewMode?: ViewMode; gesture?: GestureName; selectedCount?: number }): void {
        void s.viewMode;
        this.render(s);
    }

    // Loop hooks: begin() at the top of the frame samples the inter-frame interval and
    // feeds the smoothed FPS readout; end() is kept for symmetry with the old stats.js
    // contract (main.ts calls both). EMA smoothing avoids a number that flickers per frame.
    begin(): void {
        const now = performance.now();
        if (this.lastBegin > 0) {
            const dt = now - this.lastBegin;
            if (dt > 0) {
                const inst = 1000 / dt;
                this.emaFps = this.emaFps === 0 ? inst : this.emaFps * 0.9 + inst * 0.1;
                this.fpsNum_el.textContent = String(Math.round(this.emaFps));
            }
        }
        this.lastBegin = now;
    }

    end(): void {}
}
