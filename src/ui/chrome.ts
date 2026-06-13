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
    [MenuId.TRANSLATE]: "pinch an arrow · drag along its axis",
    [MenuId.DILATE]: "pinch both hands · apart / together to scale",
    [MenuId.ROTATE]: "pinch the ball · twist to rotate",
    [MenuId.MORPH]: "squeeze to morph · open to relax",
    [MenuId.DECORATE]: "open palm for icing · pinch for sprinkles",
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
    private readonly tool_el: HTMLDivElement;
    private readonly hint_el: HTMLDivElement;
    private readonly stats: Stats;

    constructor() {
        const root = document.getElementById("chrome");
        if (!root) throw new Error("Chrome: #chrome element not found");
        this.root = root;

        // Top-left: stage label. Uppercase, wide tracking, primary text color.
        this.stage_el = this.makeLabel({ left: "20px", top: "18px" });
        this.stage_el.style.color = T.text;
        this.stage_el.style.fontSize = "13px";
        this.stage_el.style.fontWeight = "700";
        this.stage_el.style.letterSpacing = "0.24em";
        this.stage_el.style.textTransform = "uppercase";

        // Bottom-left: active tool label (accent-tinted) stacked above its
        // instruction line (dimmed). Lowercase HUD per §14.2.
        this.tool_el = this.makeLabel({ left: "20px", bottom: "34px" });
        this.tool_el.style.color = T.cyan;
        this.tool_el.style.fontSize = "13px";
        this.tool_el.style.fontWeight = "500";
        this.tool_el.style.letterSpacing = "0.14em";

        this.hint_el = this.makeLabel({ left: "20px", bottom: "16px" });
        this.hint_el.style.color = T.textDim;
        this.hint_el.style.fontSize = "11px";
        this.hint_el.style.letterSpacing = "0.08em";

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
        if (pos.left !== undefined) el.style.left = pos.left;
        if (pos.right !== undefined) el.style.right = pos.right;
        if (pos.top !== undefined) el.style.top = pos.top;
        if (pos.bottom !== undefined) el.style.bottom = pos.bottom;
        this.root.appendChild(el);
        return el;
    }

    // Refresh the text content for a new HUD state. Cheap string assignment only;
    // safe to call every frame (no allocation, no layout thrash beyond text set).
    private render(state: { stage: Stage; activeMenu: MenuId | null; gesture?: GestureName }): void {
        this.stage_el.textContent = `DAEDALUS // ${state.stage}`;

        const base = state.activeMenu !== null ? MENU_INSTRUCTION[state.activeMenu] : IDLE_INSTRUCTION;
        if (state.activeMenu !== null) {
            this.tool_el.textContent = MENU_LABEL[state.activeMenu].toLowerCase();
            this.tool_el.style.color = TOOL_ACCENT[state.activeMenu];
        } else {
            this.tool_el.textContent = "no tool";
            this.tool_el.style.color = T.textDim;
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
    update(s: { stage: Stage; activeMenu: MenuId | null; viewMode?: ViewMode; gesture?: GestureName }): void {
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
