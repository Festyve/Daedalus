// HUD chrome (SPEC §15.3): brutalist, token-driven overlay painted into #chrome.
//   - Top-left:    DAEDALUS // {PHASE}   (uppercase, letter-spaced stage label)
//   - Bottom-left: active-menu label     (accent-tinted, lowercase HUD per §15.2)
//   - Top-right:   FPS via stats.js      (re-anchored, dimmed monochrome)
// Ported from the status-panel pattern in js/ui.js. No gradients, no rounding.
import Stats from "stats.js";
import type { Stage, MenuId } from "../types";
import { TOKENS, MENU_META } from "../render/tokens";
import { GLOBAL_GESTURES, menuGuideRows } from "./gestureGuide";

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
        this.buildGuide();
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

    // #5 — a clickable "?" icon (top-right, under the FPS meter) that toggles a
    // gesture-guide popout: the navigation gestures + every menu's instructions.
    private buildGuide(): void {
        injectGuideStyle();

        const btn = document.createElement("button");
        btn.id = "guide-btn";
        btn.type = "button";
        btn.textContent = "?";
        btn.title = "Gesture guide";

        const pop = document.createElement("div");
        pop.id = "guide-pop";
        pop.className = "hidden";
        pop.appendChild(buildGuideContent());

        btn.addEventListener("click", () => pop.classList.toggle("hidden"));
        addEventListener("keydown", (e) => {
            if (e.key === "Escape") pop.classList.add("hidden");
        });

        this.root.append(btn, pop);
    }
}

// Build the popout body: a Navigation section (global left-hand gestures) + a Menus
// section (each menu's label in its accent + its operating-instruction lines).
function buildGuideContent(): DocumentFragment {
    const frag = document.createDocumentFragment();

    const close = document.createElement("span");
    close.className = "guide-close";
    close.textContent = "×";
    close.addEventListener("click", () => document.getElementById("guide-pop")?.classList.add("hidden"));
    frag.appendChild(close);

    const title = document.createElement("h2");
    title.textContent = "✦ GESTURE GUIDE";
    frag.appendChild(title);

    const navHead = document.createElement("h3");
    navHead.textContent = "Navigation · left hand";
    frag.appendChild(navHead);
    for (const r of GLOBAL_GESTURES) {
        const row = document.createElement("div");
        row.className = "guide-row";
        const g = document.createElement("span");
        g.className = "guide-g";
        g.textContent = r.gesture;
        const a = document.createElement("span");
        a.className = "guide-a";
        a.textContent = r.action;
        row.append(g, a);
        frag.appendChild(row);
    }

    const menuHead = document.createElement("h3");
    menuHead.textContent = "Menus · right hand executes";
    frag.appendChild(menuHead);
    for (const m of menuGuideRows()) {
        const wrap = document.createElement("div");
        wrap.className = "guide-menu";
        const label = document.createElement("div");
        label.className = "guide-ml";
        label.textContent = m.label;
        label.style.color = m.accent;
        wrap.appendChild(label);
        for (const line of m.lines) {
            const hint = document.createElement("div");
            hint.className = "guide-mh";
            hint.textContent = "› " + line;
            wrap.appendChild(hint);
        }
        frag.appendChild(wrap);
    }

    return frag;
}

function injectGuideStyle(): void {
    if (document.getElementById("guide-style")) return;
    const style = document.createElement("style");
    style.id = "guide-style";
    style.textContent = GUIDE_CSS;
    document.head.appendChild(style);
}

const GUIDE_CSS = `
#guide-btn {
    position: fixed; top: 72px; right: 20px; z-index: 6;
    width: 30px; height: 30px; padding: 0; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    font-family: ${MONO}; font-size: 15px; font-weight: 700;
    color: ${TOKENS.rim}; background: rgba(0,0,0,0.55);
    border: 1px solid ${TOKENS.rim}; cursor: pointer; pointer-events: auto;
}
#guide-btn:hover { background: ${TOKENS.rim}; color: #000; }
#guide-pop {
    position: fixed; top: 72px; right: 60px; z-index: 6;
    width: min(460px, 82vw); max-height: 80vh; overflow-y: auto;
    background: #0A0A0A; border: 1px solid ${TOKENS.rim};
    padding: 16px 20px 20px; pointer-events: auto;
    font-family: ${MONO}; color: #fff;
}
#guide-pop.hidden { display: none; }
#guide-pop h2 { font-size: 13px; letter-spacing: 0.18em; color: ${TOKENS.rim}; margin: 0 0 6px; }
#guide-pop h3 {
    font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
    color: rgba(255,255,255,0.4); margin: 16px 0 8px; font-weight: 700;
}
#guide-pop .guide-row { display: flex; gap: 14px; font-size: 12px; line-height: 1.45; margin-bottom: 5px; }
#guide-pop .guide-g { color: #fff; flex: 1.3; }
#guide-pop .guide-a { color: rgba(255,255,255,0.55); flex: 1; text-align: right; }
#guide-pop .guide-menu { margin-bottom: 11px; }
#guide-pop .guide-ml { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; margin-bottom: 2px; }
#guide-pop .guide-mh { font-size: 11px; color: rgba(255,255,255,0.55); line-height: 1.4; }
#guide-pop .guide-close {
    float: right; cursor: pointer; font-size: 20px; line-height: 1;
    color: rgba(255,255,255,0.5); margin: -2px -4px 0 0;
}
#guide-pop .guide-close:hover { color: #fff; }
`;
