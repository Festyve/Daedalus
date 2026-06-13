// §4.2 — Base plain-DOM tool panel, fixed to the RIGHT side of the screen. NOT Three.js
// geometry, NOT CSS3DRenderer: a real DOM node appended to document.body, layered above
// the canvas by z-index. Background rgba(0,8,20,0.85), 0.5px cyan border, subtle inner
// glow. Slides + fades in over 150ms, fades out over 80ms. A compact instruction strip
// pinned to the bottom shows the active gestures. The panel itself is pointer-events:none
// so it never steals hand-tracking pointer focus from the canvas; only nested interactive
// controls (.daedalus-panel-interactive) re-enable pointer-events.
//
// Tool modules expose this through MenuModule.panel (typed HTMLElement in src/types.ts) by
// handing back the instance's `el`. The router opens/closes via show()/hide(); the module
// fills content via setBody() and the gesture strip via setInstructions().
import { T, FONT } from "../render/tokens";

const SLIDE_OFFSET_PX = 24; // start position offset (px) for the slide-in
const IN_MS = 150;          // slide + fade in (§4.2)
const OUT_MS = 80;          // fade out (§4.2)

export class Panel {
    readonly el: HTMLDivElement;
    private readonly body_el: HTMLDivElement;
    private readonly strip_el: HTMLDivElement;
    private readonly accent: string;
    private hide_timer: number | null = null;
    private destroyed = false;

    constructor(opts: { title: string; accent?: string }) {
        this.accent = opts.accent ?? T.cyan;

        const root = document.createElement("div");
        root.className = "daedalus-panel";
        // Fixed to the right edge, vertically centered. Hidden + offset until show().
        root.style.cssText = [
            "position:fixed",
            "top:50%",
            "right:24px",
            "transform:translate(" + SLIDE_OFFSET_PX + "px,-50%)",
            "z-index:30",
            "width:300px",
            "max-height:78vh",
            "box-sizing:border-box",
            "display:flex",
            "flex-direction:column",
            "padding:16px 18px 0 18px",
            // Slightly more opaque than T.bgPanel so menus read clearly over the
            // colour camera feed (same near-black blue tint, just less see-through).
            "background:rgba(0,8,20,0.92)",
            // 1px cyan border + subtle inner glow (§4.2) — a touch stronger so the
            // panel edge stays legible against the busy background.
            "border:1px solid " + this.accent,
            "border-radius:10px",
            "box-shadow:inset 0 0 24px " + T.cyanDim + ",0 0 18px rgba(0,0,0,0.55)",
            "color:" + T.text,
            "font-family:" + FONT,
            "font-size:12px",
            "line-height:1.5",
            "letter-spacing:0.02em",
            "opacity:0",
            "pointer-events:none",
            "backdrop-filter:blur(2px)",
            "transition:opacity " + IN_MS + "ms ease-out,transform " + IN_MS + "ms ease-out",
            // Keep the panel on its own GPU compositor layer so the slide animates only the
            // composited transform/opacity — never a paint/layout on the main thread (§14.4).
            "will-change:transform,opacity",
            "overflow:hidden",
        ].join(";");

        // Title bar: accent-tinted tool label + a small status dot.
        const header = document.createElement("div");
        header.className = "daedalus-panel-title";
        header.style.cssText = [
            "display:flex",
            "align-items:center",
            "gap:8px",
            "flex:0 0 auto",
            "padding-bottom:12px",
            "border-bottom:0.5px solid " + T.cyanDim,
            "color:" + this.accent,
            "font-size:13px",
            "font-weight:600",
            "text-transform:uppercase",
            "letter-spacing:0.14em",
            "text-shadow:0 0 8px " + this.accent,
        ].join(";");

        const dot = document.createElement("span");
        dot.style.cssText = [
            "width:7px",
            "height:7px",
            "flex:0 0 auto",
            "border-radius:50%",
            "background:" + this.accent,
            "box-shadow:0 0 8px " + this.accent,
        ].join(";");

        const label = document.createElement("span");
        label.textContent = opts.title;

        header.appendChild(dot);
        header.appendChild(label);

        // Body: scrollable content region the tool module fills via setBody().
        const body = document.createElement("div");
        body.className = "daedalus-panel-body";
        body.style.cssText = [
            "flex:1 1 auto",
            "min-height:0",
            "padding:14px 0",
            "overflow-y:auto",
            "color:" + T.text,
        ].join(";");

        // Instruction strip: compact gesture hints pinned to the bottom (§4.2).
        const strip = document.createElement("div");
        strip.className = "daedalus-panel-strip";
        strip.style.cssText = [
            "flex:0 0 auto",
            "margin:0 -18px",
            "padding:9px 18px",
            "border-top:0.5px solid " + T.cyanDim,
            "background:rgba(0,255,209,0.05)",
            "color:" + T.textDim,
            "font-size:10.5px",
            "line-height:1.45",
            "letter-spacing:0.04em",
            "text-transform:uppercase",
        ].join(";");

        root.appendChild(header);
        root.appendChild(body);
        root.appendChild(strip);
        document.body.appendChild(root);

        this.el = root;
        this.body_el = body;
        this.strip_el = strip;
    }

    // Slide + fade in (150ms). Cancels any pending hide-driven detach.
    show(): void {
        if (this.destroyed) return;
        if (this.hide_timer !== null) {
            clearTimeout(this.hide_timer);
            this.hide_timer = null;
        }
        this.el.style.transition =
            "opacity " + IN_MS + "ms ease-out,transform " + IN_MS + "ms ease-out";
        this.el.style.display = "flex";
        // Force a reflow so the from-state (offset + opacity 0) is committed before we
        // flip to the to-state; otherwise the browser collapses both into one frame and
        // the transition never runs.
        void this.el.offsetWidth;
        this.el.style.opacity = "1";
        this.el.style.transform = "translate(0,-50%)";
    }

    // Fade out (80ms), then drop back to display:none so it is not laid out while hidden.
    hide(): void {
        if (this.destroyed) return;
        this.el.style.transition =
            "opacity " + OUT_MS + "ms ease-in,transform " + OUT_MS + "ms ease-in";
        this.el.style.opacity = "0";
        this.el.style.transform = "translate(" + SLIDE_OFFSET_PX + "px,-50%)";
        if (this.hide_timer !== null) clearTimeout(this.hide_timer);
        this.hide_timer = window.setTimeout(() => {
            this.hide_timer = null;
            if (!this.destroyed) this.el.style.display = "none";
        }, OUT_MS);
    }

    // Replace the scrollable body content. Caller owns the HTML; interactive controls
    // must carry class "daedalus-panel-interactive" to re-enable pointer events.
    setBody(html: string): void {
        if (this.destroyed) return;
        this.body_el.innerHTML = html;
    }

    // Replace the bottom gesture strip content.
    setInstructions(html: string): void {
        if (this.destroyed) return;
        this.strip_el.innerHTML = html;
    }

    // Remove from the DOM and neutralize further calls.
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.hide_timer !== null) {
            clearTimeout(this.hide_timer);
            this.hide_timer = null;
        }
        this.el.remove();
    }
}
