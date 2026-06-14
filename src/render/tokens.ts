// JARVIS palette & design tokens (SPEC §14.1). Cyan neutral, amber active, white selected.
import { MenuId, MENU_ORDER } from "../types";

export const T = {
    bg:            "#000814",            // near-black, slight blue tint
    bgPanel:       "rgba(0,8,20,0.85)",
    cyan:          "#00FFD1",            // primary: neutral state, borders, rim
    cyanDim:       "rgba(0,255,209,0.3)",
    amber:         "#FFB830",            // active / rotate accent
    white:         "#FFFFFF",            // selected state
    text:          "#FFFFFF",
    textDim:       "rgba(255,255,255,0.45)",
    rimColor:      "#00FFD1",
    matcap:        "/matcaps/blue-steel.png",
    // per-tool accents (§14.1)
    toolAdd:       "#00FFD1",            // ADD SHAPES
    toolSelect:    "#9EE6FF",            // SELECT (light cyan)
    toolTranslate: "#4488FF",            // TRANSLATE
    toolDilate:    "#AA44FF",            // DILATE
    toolRotate:    "#FFB830",            // ROTATE
    toolMorph:     "#FF3E9A",            // MORPH
    toolDecorate:  "#FFD700",            // DECORATE
    toolInteract:  "#7CFFB2",            // INTERACT (boolean ops, mint green)
    toolDestroy:   "#FF4D4D",            // DESTROY (red)
} as const;

/** Accent color for a tool (carousel highlight, panel border tint). */
export const TOOL_ACCENT: Record<MenuId, string> = {
    [MenuId.ADD_SHAPES]: T.toolAdd,
    [MenuId.SELECT]: T.toolSelect,
    [MenuId.TRANSLATE]: T.toolTranslate,
    [MenuId.DILATE]: T.toolDilate,
    [MenuId.ROTATE]: T.toolRotate,
    [MenuId.MORPH]: T.toolMorph,
    [MenuId.DECORATE]: T.toolDecorate,
    [MenuId.INTERACT]: T.toolInteract,
    [MenuId.DESTROY]: T.toolDestroy,
};

/** Per-tool icon + accent + label for the carousel (§4.1). */
export const MENU_META: Record<MenuId, { icon: string; accent: string; label: string }> = {
    [MenuId.ADD_SHAPES]: { icon: "+",  accent: T.toolAdd,       label: "ADD SHAPES" },
    [MenuId.SELECT]:     { icon: "◉",  accent: T.toolSelect,    label: "SELECT" },
    [MenuId.TRANSLATE]:  { icon: "✥",  accent: T.toolTranslate, label: "TRANSLATE" },
    [MenuId.DILATE]:     { icon: "⊕",  accent: T.toolDilate,    label: "DILATE" },
    [MenuId.ROTATE]:     { icon: "↻",  accent: T.toolRotate,    label: "ROTATE" },
    [MenuId.MORPH]:      { icon: "∿",  accent: T.toolMorph,     label: "MORPH" },
    [MenuId.DECORATE]:   { icon: "✦",  accent: T.toolDecorate,  label: "DECORATE" },
    [MenuId.INTERACT]:   { icon: "⧉",  accent: T.toolInteract,  label: "INTERACT" },
    [MenuId.DESTROY]:    { icon: "✕",  accent: T.toolDestroy,   label: "DESTROY" },
};

export const FONT = "'JetBrains Mono', monospace";

// How many shapes must be SELECTED for each tool to make sense (§5, items 6). The tool
// carousel shows only the tools whose [min,max] bracket the current selection count, so it
// presents three natural variants:
//   - 0 selected  → ADD SHAPES, SELECT
//   - exactly 1   → the above + MORPH, DECORATE (one-shape) + TRANSLATE/DILATE/ROTATE/DESTROY
//   - 2 or more   → drops the one-shape tools, adds INTERACT (boolean on the two selected)
export const TOOL_SELECTION_REQ: Record<MenuId, { min: number; max: number }> = {
    [MenuId.ADD_SHAPES]: { min: 0, max: Infinity },
    [MenuId.SELECT]:     { min: 0, max: Infinity },
    [MenuId.MORPH]:      { min: 1, max: 1 },        // one-shape: sphere↔torus on the primary
    [MenuId.DECORATE]:   { min: 1, max: 1 },        // one-shape: icing/sprinkles on the primary
    [MenuId.TRANSLATE]:  { min: 1, max: Infinity }, // one-or-more (acts on the group)
    [MenuId.DILATE]:     { min: 1, max: Infinity },
    [MenuId.ROTATE]:     { min: 1, max: Infinity },
    [MenuId.DESTROY]:    { min: 1, max: Infinity },
    [MenuId.INTERACT]:   { min: 2, max: Infinity }, // multi-shape: boolean on two selected
};

/** The tools eligible for the current selection count, in MENU_ORDER order (≥1 always). */
export function eligibleTools(selectedCount: number): MenuId[] {
    const eligible = MENU_ORDER.filter((id) => {
        const r = TOOL_SELECTION_REQ[id];
        return selectedCount >= r.min && selectedCount <= r.max;
    });
    // Defensive: never hand the carousel an empty wheel (ADD_SHAPES/SELECT are always min 0).
    return eligible.length ? eligible : [MenuId.ADD_SHAPES, MenuId.SELECT];
}
