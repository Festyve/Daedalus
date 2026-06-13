// HUD chrome (SPEC §15.3): brutalist, token-driven overlay painted into #chrome.
//   - Top-left:    DAEDALUS // {PHASE}   (uppercase, letter-spaced stage label)
//   - Bottom-left: active-menu label     (accent-tinted, lowercase HUD per §15.2)
//   - Top-right:   FPS via stats.js      (re-anchored, dimmed monochrome)
// Ported from the status-panel pattern in js/ui.js. No gradients, no rounding.
import Stats from "stats.js";
import type { Stage, MenuId } from "../types";
import { TOKENS, MENU_META } from "../render/tokens";

const MONO = '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace';

export interface ChromeState {
    stage: Stage;
    activeMenu: MenuId | null;
}

export class Chrome {
    private readonly root: HTMLElement;
    private readonly stage_el: HTMLDivElement;
    private readonly menu_el: HTMLDivElement;
    private readonly stats: Stats;

    constructor() {
        const root = document.getElementById("chrome");
        if (!root) throw new Error("Chrome: #chrome element not found");
        this.root = root;

        this.stage_el = this.makeLabel({ left: "20px", top: "18px" });
        this.stage_el.style.color = TOKENS.text;
        this.stage_el.style.fontSize = "13px";
        this.stage_el.style.fontWeight = "700";
        this.stage_el.style.letterSpacing = "0.22em";
        this.stage_el.style.textTransform = "uppercase";

        this.menu_el = this.makeLabel({ left: "20px", bottom: "18px" });
        this.menu_el.style.color = TOKENS.textDim;
        this.menu_el.style.fontSize = "12px";
        this.menu_el.style.letterSpacing = "0.14em";

        // stats.js FPS meter, re-anchored top-right and dimmed to read as
        // desaturated chrome rather than its stock neon-green panel.
        this.stats = new Stats();
        this.stats.showPanel(0); // 0 = FPS
        const dom = this.stats.dom;
        dom.style.cssText =
            "position:fixed;top:18px;right:20px;left:auto;" +
            "pointer-events:none;opacity:0.45;filter:grayscale(1);z-index:3";
        this.root.appendChild(dom);

        this.render({ stage: "SPHERE", activeMenu: null });
    }

    // Build a fixed-position HUD text element parented to #chrome.
    private makeLabel(pos: { left?: string; right?: string; top?: string; bottom?: string }): HTMLDivElement {
        const el = document.createElement("div");
        el.style.position = "fixed";
        el.style.fontFamily = MONO;
        el.style.whiteSpace = "nowrap";
        el.style.pointerEvents = "none";
        if (pos.left !== undefined) el.style.left = pos.left;
        if (pos.right !== undefined) el.style.right = pos.right;
        if (pos.top !== undefined) el.style.top = pos.top;
        if (pos.bottom !== undefined) el.style.bottom = pos.bottom;
        this.root.appendChild(el);
        return el;
    }

    // Refresh the text content for a new HUD state.
    private render(state: ChromeState): void {
        this.stage_el.textContent = `DAEDALUS // ${state.stage}`;
        if (state.activeMenu !== null) {
            const meta = MENU_META[state.activeMenu];
            this.menu_el.textContent = meta.label.toLowerCase();
            this.menu_el.style.color = meta.accent;
        } else {
            this.menu_el.textContent = "no menu";
            this.menu_el.style.color = TOKENS.textDim;
        }
    }

    // Public per-frame update of the HUD labels.
    update(state: ChromeState): void {
        this.render(state);
    }

    // stats.js loop hooks: call begin() at the top of the frame, end() at the
    // bottom so the meter samples the full frame interval.
    begin(): void {
        this.stats.begin();
    }

    end(): void {
        this.stats.end();
    }
}
