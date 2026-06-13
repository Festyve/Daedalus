// Calibration ritual overlay (SPEC §0.6). A minimal brutalist DOM layer that
// renders the 5-step ritual prompts (hold open hand / pinch fully / reach
// forward-back / swipe fast / done) driven by the tracking/calibration.ts
// controller, plus a live 0..1 responsiveness slider and a Skip button.
//
// This file is VIEW + INPUT only: the Calibration controller owns ritual state
// (it advances `step` as poses are held; per-frame RitualFrames are fed by the
// main loop in P3). Each frame the host calls update() and this overlay repaints
// the active step. The slider calls controller.setResponsiveness() mid-demo; the
// Skip button calls controller.skip() (which yields DEFAULT_CALIBRATION).
import type { Calibration, CalibrationStep } from "../tracking/calibration";
import type { CalibrationProfile } from "../types";
import { TOKENS } from "../render/tokens";

// §0.6.2 ritual copy, in controller step order. `done` closes the overlay.
const STEP_PROMPTS: Record<Exclude<CalibrationStep, "done">, { title: string; hint: string }> = {
    rest: { title: "HOLD YOUR OPEN HAND STILL", hint: "measuring resting jitter" },
    pinch: { title: "PINCH FULLY", hint: "recording your pinch distance" },
    depth: { title: "REACH FORWARD, THEN BACK", hint: "mapping comfortable depth" },
    swipe: { title: "SWIPE FAST LEFT TO RIGHT", hint: "measuring peak velocity" },
};
const STEP_SEQUENCE: CalibrationStep[] = ["rest", "pinch", "depth", "swipe"];
const ACCENT = TOKENS.rim;

export interface CalibrationUIHandlers {
    onComplete?: (profile: CalibrationProfile) => void; // ritual finished
    onSkip?: (profile: CalibrationProfile) => void;      // Skip pressed -> defaults
}

// Brutalist overlay bound to a Calibration controller. Mount, then call update()
// each frame; it closes itself (and fires onComplete) when the ritual is done.
export class CalibrationUI {
    private root: HTMLDivElement;
    private title_el: HTMLDivElement;
    private hint_el: HTMLDivElement;
    private steps_el: HTMLDivElement;
    private step_dots: HTMLSpanElement[] = [];
    private slider_el: HTMLInputElement;
    private slider_value_el: HTMLSpanElement;
    private last_step: CalibrationStep | null = null;
    private finished = false;

    constructor(
        private calibration: Calibration,
        private handlers: CalibrationUIHandlers = {},
    ) {
        this.injectStyle();
        this.root = document.createElement("div");
        this.root.id = "calibration";

        const card = document.createElement("div");
        card.className = "cal-card";

        const brand = document.createElement("div");
        brand.className = "cal-brand";
        brand.textContent = "DAEDALUS // CALIBRATE";

        this.title_el = document.createElement("div");
        this.title_el.className = "cal-title";

        this.hint_el = document.createElement("div");
        this.hint_el.className = "cal-hint";

        this.steps_el = document.createElement("div");
        this.steps_el.className = "cal-steps";
        STEP_SEQUENCE.forEach((_, i) => {
            const dot = document.createElement("span");
            dot.className = "cal-dot";
            dot.textContent = String(i + 1);
            this.step_dots.push(dot);
            this.steps_el.appendChild(dot);
        });

        const slider_row = document.createElement("div");
        slider_row.className = "cal-slider-row";

        const slider_label = document.createElement("span");
        slider_label.className = "cal-slider-label";
        slider_label.textContent = "sensitivity";

        this.slider_el = document.createElement("input");
        this.slider_el.className = "cal-slider";
        this.slider_el.type = "range";
        this.slider_el.min = "0";
        this.slider_el.max = "1";
        this.slider_el.step = "0.01";
        this.slider_el.value = String(this.calibration.profile.responsiveness);

        this.slider_value_el = document.createElement("span");
        this.slider_value_el.className = "cal-slider-value";
        this.slider_value_el.textContent = this.formatValue(this.calibration.profile.responsiveness);

        this.slider_el.addEventListener("input", () => {
            const v = Number(this.slider_el.value);
            this.calibration.setResponsiveness(v);
            this.slider_value_el.textContent = this.formatValue(v);
        });

        slider_row.append(slider_label, this.slider_el, this.slider_value_el);

        const skip_btn = document.createElement("button");
        skip_btn.className = "cal-skip";
        skip_btn.type = "button";
        skip_btn.textContent = "SKIP →";
        skip_btn.addEventListener("click", () => {
            const profile = this.calibration.skip(); // DEFAULT_CALIBRATION (§0.6.4)
            this.close();
            this.handlers.onSkip?.(profile);
        });

        card.append(brand, this.title_el, this.hint_el, this.steps_el, slider_row, skip_btn);
        this.root.appendChild(card);
        document.body.appendChild(this.root);

        this.renderStep();
    }

    // Per-frame tick: reflect controller step; fire onComplete + close once done.
    update(): void {
        if (this.finished) return;
        if (this.calibration.step !== this.last_step) this.renderStep();
        if (this.calibration.done) {
            this.finished = true;
            const profile = this.calibration.profile;
            this.close();
            this.handlers.onComplete?.(profile);
        }
    }

    // Remove the overlay + its injected style from the DOM.
    close(): void {
        this.root.remove();
        document.getElementById("calibration-style")?.remove();
    }

    private renderStep(): void {
        const step = this.calibration.step;
        this.last_step = step;
        if (step === "done") return;
        const prompt = STEP_PROMPTS[step];
        this.title_el.textContent = prompt.title;
        this.hint_el.textContent = prompt.hint;
        const active_index = STEP_SEQUENCE.indexOf(step);
        this.step_dots.forEach((dot, i) => {
            dot.classList.toggle("is-active", i === active_index);
            dot.classList.toggle("is-done", i < active_index);
        });
    }

    private formatValue(v: number): string {
        return v.toFixed(2);
    }

    private injectStyle(): void {
        if (document.getElementById("calibration-style")) return;
        const style = document.createElement("style");
        style.id = "calibration-style";
        style.textContent = CALIBRATION_CSS;
        document.head.appendChild(style);
    }
}

// Brutalist, token-driven (§15): pure black, hairline border, JetBrains Mono,
// uppercase letter-spaced title, accent = TOKENS.rim. No gradients/rounding.
const CALIBRATION_CSS = `
#calibration {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg, #000);
    font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
#calibration .cal-card {
    width: min(440px, 86vw);
    padding: 28px 28px 22px;
    border: 1px solid ${ACCENT};
    background: var(--bg, #000);
}
#calibration .cal-brand {
    font-size: 11px;
    letter-spacing: 0.22em;
    color: ${ACCENT};
    margin-bottom: 22px;
}
#calibration .cal-title {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--text, #fff);
    line-height: 1.25;
    min-height: 48px;
}
#calibration .cal-hint {
    font-size: 12px;
    letter-spacing: 0.02em;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
    margin-top: 8px;
}
#calibration .cal-steps {
    display: flex;
    gap: 10px;
    margin: 24px 0;
}
#calibration .cal-dot {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
    border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
}
#calibration .cal-dot.is-active {
    color: var(--bg, #000);
    background: ${ACCENT};
    border-color: ${ACCENT};
}
#calibration .cal-dot.is-done {
    color: ${ACCENT};
    border-color: ${ACCENT};
}
#calibration .cal-slider-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 18px;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.12));
}
#calibration .cal-slider-label {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
    text-transform: uppercase;
}
#calibration .cal-slider {
    flex: 1;
    height: 2px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--line, rgba(255, 255, 255, 0.12));
    outline: none;
    cursor: pointer;
}
#calibration .cal-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    background: ${ACCENT};
    cursor: pointer;
}
#calibration .cal-slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: none;
    background: ${ACCENT};
    cursor: pointer;
}
#calibration .cal-slider-value {
    font-size: 12px;
    color: var(--text, #fff);
    min-width: 34px;
    text-align: right;
}
#calibration .cal-skip {
    margin-top: 22px;
    width: 100%;
    padding: 10px 0;
    font-family: inherit;
    font-size: 12px;
    letter-spacing: 0.12em;
    color: var(--text-dim, rgba(255, 255, 255, 0.45));
    background: transparent;
    border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
    cursor: pointer;
}
#calibration .cal-skip:hover {
    color: var(--text, #fff);
    border-color: var(--text, #fff);
}
`;
