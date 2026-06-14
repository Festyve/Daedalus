// Instructions popout (SPEC §4.4) — Layer 2 DOM (§4.3): plain DOM, no CSS3DRenderer.
//
// A fixed bottom-right ❓ button that is ALWAYS visible (pointer-events: auto on the
// button; the rest of the popout is inert until opened). Clicking it opens a gesture-
// reference modal: dark bg, cyan border, JetBrains Mono. The modal covers all six SPEC
// tools (§5.1–§5.6), the global navigation gestures, the parting-curtains view toggle
// (§0.7), and voice activation for DECORATE (§8).
//
// Seeded from ui/gestureGuide.ts but rewritten to reflect ONLY the six authoritative
// tools in src/types.ts (ADD SHAPES · TRANSLATE · DILATE · ROTATE · MORPH · DECORATE)
// and to own its own copy decks so it cannot drift from the frozen MenuId contract.
//
// All styling reads from the authoritative tokens (src/render/tokens.ts): cyan border,
// near-black panel, JetBrains Mono. Nothing here touches the Three.js scene, so the
// Layer-0/Layer-1 depth rules (asMenuLayer) do not apply — this is Layer 2 DOM only.
import { MenuId, MENU_ORDER, MENU_LABEL } from "../types";
import { T, MENU_META, FONT, GLASS_BG, GLASS_BLUR, panelGlow } from "../render/tokens";

// One row of the reference: a gesture phrase paired with the action it triggers.
interface ReferenceRow {
    gesture: string;
    action: string;
}

// Global, menu-independent navigation gestures (left hand drives the wheel; §4.1).
const NAV_GESTURES: ReferenceRow[] = [
    { gesture: "Left hand “gun” — index out, thumb up", action: "open the menu wheel" },
    { gesture: "Aim the left index at a tile", action: "highlight that menu" },
    { gesture: "Left pinch", action: "select the highlighted menu" },
    { gesture: "Left fist", action: "close the wheel" },
];

// Per-tool operating instructions, one entry per authoritative MenuId (§5.1–§5.6).
// Right hand executes unless a line says otherwise.
const TOOL_HINTS: Record<MenuId, string[]> = {
    [MenuId.ADD_SHAPES]: [
        "flick to cycle cube · sphere · cylinder",
        "pinch to pick · right pinch spawns at your hand",
        "each spawn adds a new shape (the others stay)",
    ],
    [MenuId.SELECT]: [
        "right fist moves the cursor between shapes",
        "left fist adds / removes the cursor's shape",
        "left V-sign (✌) marks it a red hole (cutter for INTERACT)",
        "right three fingers deselects everything",
    ],
    [MenuId.TRANSLATE]: [
        "right open palm — object follows your hand",
        "close to a fist — lock it in place",
    ],
    [MenuId.DILATE]: [
        "pinch with BOTH hands near the object",
        "spread apart to grow · bring together to shrink",
    ],
    [MenuId.ROTATE]: [
        "right pinch near the object to grab it",
        "twist to rotate · release to latch",
    ],
    [MenuId.MORPH]: [
        "both hands curl around the object",
        "orbit them in a circle to morph sphere → torus",
        "unwind the circle to reverse it",
    ],
    [MenuId.DECORATE]: [
        "speak to DAEDALUS to decorate (voice + AI chat)",
        "fires icing + sprinkles, streams a spoken reply",
    ],
    [MenuId.INTERACT]: [
        "combine all the selected shapes (live preview)",
        "right pinch cycles union · subtract · intersect",
        "UNION fuses the shapes and carves red holes out",
        "left pinch to apply — they become one shape",
    ],
    [MenuId.DESTROY]: [
        "pinch to delete the currently selected shape",
        "the next shape (if any) becomes selected",
    ],
};

// The bilateral view-mode toggle (§0.7) and the voice channel (§8). These sit outside
// the per-tool list because they are always available regardless of the active menu.
const SYSTEM_GESTURES: ReferenceRow[] = [
    { gesture: "Both palms open, sweep apart (“parting curtains”)", action: "toggle Scene ↔ AR view" },
    { gesture: "Speak while DECORATE is active", action: "talk to DAEDALUS AI" },
];

const ROW_DIM = "rgba(255,255,255,0.55)";
const HEAD_DIM = "rgba(255,255,255,0.4)";

// Always-visible ❓ button + click-to-open gesture-reference modal (SPEC §4.4).
// Construct once, then call mount() to inject the button + modal into <body>.
export class InstructionsPopout {
    private readonly button: HTMLButtonElement;
    private readonly modal: HTMLDivElement;
    private mounted = false;
    private open = false;
    private readonly onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === "Escape" && this.open) this.setOpen(false);
    };

    constructor() {
        this.injectStyle();
        this.button = this.buildButton();
        this.modal = this.buildModal();
    }

    // Inject the ❓ button (always-on) and the hidden modal into the document, and wire
    // open/close. Idempotent — calling twice is a no-op.
    mount(): void {
        if (this.mounted) return;
        this.mounted = true;
        document.body.append(this.button, this.modal);
        this.button.addEventListener("click", () => this.setOpen(!this.open));
        addEventListener("keydown", this.onKeyDown);
    }

    // Show or hide the modal; keep the ❓ button visible and clickable in both states.
    private setOpen(next: boolean): void {
        this.open = next;
        this.modal.classList.toggle("daedalus-instr-hidden", !next);
        this.button.setAttribute("aria-expanded", next ? "true" : "false");
    }

    private buildButton(): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.id = "daedalus-instr-btn";
        btn.type = "button";
        btn.textContent = "?";
        btn.title = "Gesture guide";
        btn.setAttribute("aria-label", "Open gesture guide");
        btn.setAttribute("aria-haspopup", "dialog");
        btn.setAttribute("aria-expanded", "false");
        return btn;
    }

    private buildModal(): HTMLDivElement {
        const modal = document.createElement("div");
        modal.id = "daedalus-instr-modal";
        modal.className = "daedalus-instr-hidden";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-label", "Gesture guide");
        modal.appendChild(this.buildContent());
        return modal;
    }

    // Assemble the reference body: title, navigation section, the six tools (in
    // MENU_ORDER), and the system gestures (view toggle + voice).
    private buildContent(): DocumentFragment {
        const frag = document.createDocumentFragment();

        const close = document.createElement("button");
        close.type = "button";
        close.className = "daedalus-instr-close";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close gesture guide");
        close.addEventListener("click", () => this.setOpen(false));
        frag.appendChild(close);

        const title = document.createElement("h2");
        title.className = "daedalus-instr-title";
        title.textContent = "✦ GESTURE GUIDE";
        frag.appendChild(title);

        frag.appendChild(this.buildRowSection("Navigation · left hand", NAV_GESTURES));

        const toolsHead = document.createElement("h3");
        toolsHead.className = "daedalus-instr-head";
        toolsHead.textContent = "Tools · right hand executes";
        frag.appendChild(toolsHead);
        for (const id of MENU_ORDER) {
            frag.appendChild(this.buildToolBlock(id));
        }

        frag.appendChild(this.buildRowSection("View & voice", SYSTEM_GESTURES));

        return frag;
    }

    // A labelled section of gesture/action rows.
    private buildRowSection(heading: string, rows: ReferenceRow[]): HTMLElement {
        const wrap = document.createElement("section");

        const head = document.createElement("h3");
        head.className = "daedalus-instr-head";
        head.textContent = heading;
        wrap.appendChild(head);

        for (const r of rows) {
            const row = document.createElement("div");
            row.className = "daedalus-instr-row";
            const g = document.createElement("span");
            g.className = "daedalus-instr-g";
            g.textContent = r.gesture;
            const a = document.createElement("span");
            a.className = "daedalus-instr-a";
            a.textContent = r.action;
            row.append(g, a);
            wrap.appendChild(row);
        }

        return wrap;
    }

    // One tool block: accent-tinted label (from MENU_META) + its hint lines. A left accent
    // bar in the tool's own color turns the dense list into a scannable, color-keyed column.
    private buildToolBlock(id: MenuId): HTMLElement {
        const accent = MENU_META[id].accent;
        const wrap = document.createElement("div");
        wrap.className = "daedalus-instr-tool";
        wrap.style.borderLeft = `2px solid ${accent}`;
        wrap.style.boxShadow = `-6px 0 14px -8px ${accent}`;

        const label = document.createElement("div");
        label.className = "daedalus-instr-tl";
        label.textContent = MENU_LABEL[id];
        label.style.color = accent;
        label.style.textShadow = `0 0 8px ${accent}55`;
        wrap.appendChild(label);

        for (const line of TOOL_HINTS[id]) {
            const hint = document.createElement("div");
            hint.className = "daedalus-instr-th";
            hint.textContent = "› " + line;
            wrap.appendChild(hint);
        }

        return wrap;
    }

    // Inject the scoped stylesheet once. JetBrains Mono, dark bg, cyan border (§4.4).
    private injectStyle(): void {
        if (document.getElementById("daedalus-instr-style")) return;
        const style = document.createElement("style");
        style.id = "daedalus-instr-style";
        style.textContent = this.css();
        document.head.appendChild(style);
    }

    private css(): string {
        return `
@keyframes daedalus-instr-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes daedalus-instr-in {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
}
#daedalus-instr-btn {
    position: fixed; right: 20px; bottom: 20px; z-index: 7;
    width: 44px; height: 44px; padding: 0; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    font-family: ${FONT}; font-size: 20px; font-weight: 700;
    color: ${T.cyan}; background: ${GLASS_BG};
    -webkit-backdrop-filter: ${GLASS_BLUR}; backdrop-filter: ${GLASS_BLUR};
    border: 1px solid ${T.cyan}88; border-radius: 50%; cursor: pointer;
    box-shadow: ${panelGlow(T.cyan)}; pointer-events: auto;
    transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}
#daedalus-instr-btn:hover {
    background: ${T.cyan}; color: ${T.bg}; transform: translateY(-1px);
    box-shadow: 0 0 26px ${T.cyan}88, 0 10px 28px rgba(0,0,0,0.5);
}
#daedalus-instr-btn:focus-visible { outline: 1px solid ${T.cyan}; outline-offset: 3px; }
#daedalus-instr-modal {
    position: fixed; right: 20px; bottom: 74px; z-index: 7;
    width: min(440px, 86vw); max-height: 78vh; overflow-y: auto;
    background: ${GLASS_BG}; border: 1px solid ${T.cyan}66;
    -webkit-backdrop-filter: ${GLASS_BLUR}; backdrop-filter: ${GLASS_BLUR};
    border-radius: 14px;
    padding: 18px 22px 22px; pointer-events: auto;
    font-family: ${FONT}; color: ${T.text};
    box-shadow: ${panelGlow(T.cyan)};
    animation: daedalus-instr-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
    scrollbar-width: thin; scrollbar-color: ${T.cyan}55 transparent;
}
#daedalus-instr-modal::-webkit-scrollbar { width: 8px; }
#daedalus-instr-modal::-webkit-scrollbar-thumb {
    background: ${T.cyan}44; border-radius: 4px;
}
#daedalus-instr-modal.daedalus-instr-hidden { display: none; }
.daedalus-instr-title {
    font-size: 13px; letter-spacing: 0.2em; color: ${T.cyan};
    margin: 0 0 14px; padding-bottom: 12px;
    border-bottom: 1px solid ${T.cyan}33; text-shadow: 0 0 10px ${T.cyan}66;
}
.daedalus-instr-head {
    font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
    color: ${HEAD_DIM}; margin: 18px 0 9px; font-weight: 700;
}
.daedalus-instr-row {
    display: flex; gap: 14px; font-size: 12px; line-height: 1.45; margin-bottom: 6px;
}
.daedalus-instr-g { color: ${T.text}; flex: 1.3; }
.daedalus-instr-a { color: ${ROW_DIM}; flex: 1; text-align: right; }
.daedalus-instr-tool {
    margin-bottom: 12px; padding: 2px 0 2px 12px; border-radius: 0 4px 4px 0;
}
.daedalus-instr-tl {
    font-size: 12px; font-weight: 700; letter-spacing: 0.1em; margin-bottom: 3px;
}
.daedalus-instr-th { font-size: 11px; color: ${ROW_DIM}; line-height: 1.5; }
.daedalus-instr-close {
    position: absolute; top: 14px; right: 16px;
    width: 24px; height: 24px; padding: 0; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; cursor: pointer; font-family: ${FONT};
    font-size: 20px; color: ${ROW_DIM};
    transition: color 120ms ease, transform 120ms ease;
}
.daedalus-instr-close:hover { color: ${T.text}; transform: scale(1.15); }
`;
    }
}
