// HUD chrome (SPEC §14.3): plain-DOM, token-driven overlay painted into #chrome.
//   - Top-left:    DAEDALUS // {PHASE}        (uppercase, wide letter-spacing — §14.2)
//   - Bottom-left: active tool + instruction  (lowercase HUD, accent-tinted — §14.2)
//   - Top-right:   FPS via stats.js           (re-anchored, dimmed monochrome)
// Three fixed regions only. The ❓ guide popout lives in ui/instructionsPopout.ts.
// Render layers (§4.3) do not apply here: this is DOM, not scene geometry.
import Stats from "stats.js";
import type { Stage, ViewMode, GestureName } from "../types";
import { MenuId, MENU_LABEL } from "../types";
import { T, TOOL_ACCENT, FONT } from "../render/tokens";

// One-line operating hint per tool, shown after the active-tool label (§14.3).
// Lowercase to match the HUD typography rule (§14.2). Six tools, no more.
const MENU_INSTRUCTION: Record<MenuId, string> = {
    [MenuId.ADD_SHAPES]: "point to aim · pinch to spawn",
    [MenuId.SELECT]: "swipe to move the cursor · pinch to add / remove",
    [MenuId.TRANSLATE]: "pinch an arrow · drag along its axis",
    [MenuId.DILATE]: "pinch both hands · apart / together to scale",
    [MenuId.ROTATE]: "pinch the ball · twist to rotate",
    [MenuId.MORPH]: "both hands closed · jiggle to morph",
    [MenuId.DECORATE]: "open palm for icing · pinch for sprinkles",
    [MenuId.INTERACT]: "swipe to pick union / subtract / intersect · pinch to apply",
    [MenuId.DESTROY]: "pinch to destroy the selected shape",
};

// Instruction shown when no menu is active (world idle / carousel closed).
const IDLE_INSTRUCTION = "left gun opens the menu wheel";

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

export class Chrome {
    private readonly root: HTMLElement;
    private readonly stage_el: HTMLDivElement;
    private readonly count_el: HTMLDivElement;
    private readonly tool_el: HTMLDivElement;
    private readonly hint_el: HTMLDivElement;
    private readonly bottomPill: HTMLDivElement;
    private readonly stats: Stats;

    constructor() {
        const root = document.getElementById("chrome");
        if (!root) throw new Error("Chrome: #chrome element not found");
        this.root = root;

        // Top-left: stage pill — dark backdrop so text reads over any camera content.
        this.stage_el = document.createElement("div");
        Object.assign(this.stage_el.style, {
            position: "fixed", left: "16px", top: "16px",
            fontFamily: FONT, whiteSpace: "nowrap", pointerEvents: "none",
            fontSize: "13px", fontWeight: "700",
            letterSpacing: "0.24em", textTransform: "uppercase",
            color: T.text,
            padding: "7px 13px",
            background: "rgba(0,8,20,0.76)",
            borderRadius: "6px",
            border: "1px solid rgba(255,255,255,0.16)",
        });
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
            padding: "7px 16px",
            background: "rgba(0,8,20,0.76)",
            borderRadius: "6px",
            border: `1px solid ${T.toolSelect}55`,
            display: "none",
        });
        this.root.appendChild(this.count_el);

        // Bottom-left: pill container holding the active-tool label stacked above the hint.
        this.bottomPill = document.createElement("div");
        Object.assign(this.bottomPill.style, {
            position: "fixed", left: "16px", bottom: "16px",
            fontFamily: FONT, whiteSpace: "nowrap", pointerEvents: "none",
            padding: "10px 16px",
            background: "rgba(0,8,20,0.80)",
            borderRadius: "8px",
            border: `1px solid ${T.cyan}44`,
        });
        this.root.appendChild(this.bottomPill);

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

        // Top-right: stats.js FPS meter, re-anchored and dimmed to read as
        // desaturated chrome rather than its stock neon-green panel.
        this.stats = new Stats();
        this.stats.showPanel(0); // 0 = FPS
        const dom = this.stats.dom;
        dom.style.cssText =
            "position:fixed;top:18px;right:20px;left:auto;" +
            "pointer-events:none;opacity:0.45;filter:grayscale(1);z-index:3";
        this.root.appendChild(dom);

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
        this.stage_el.textContent = `DAEDALUS // ${state.stage}`;

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
        } else {
            this.tool_el.textContent = "no tool";
            this.tool_el.style.color = T.textDim;
            this.bottomPill.style.borderColor = T.cyan + "44";
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

    // stats.js loop hooks: call begin() at the top of the frame and end() at the
    // bottom so the meter samples the full frame interval.
    begin(): void {
        this.stats.begin();
    }

    end(): void {
        this.stats.end();
    }
}
