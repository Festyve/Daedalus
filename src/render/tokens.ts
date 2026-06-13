// JARVIS palette & design tokens (SPEC §14.1). Cyan neutral, amber active, white selected.
import { MenuId } from "../types";

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
    // §9.2 minimal wireframe object (replaces the blue-steel matcap):
    wireLine:      "#7CEFFF",            // bright wireframe edges — visible on dark + AR feed
    wireFill:      "#0B1A2E",            // faint solid fill behind the wire (hides back edges)
    // per-tool accents (§14.1)
    toolAdd:       "#00FFD1",            // ADD SHAPES
    toolTranslate: "#4488FF",            // TRANSLATE
    toolDilate:    "#AA44FF",            // DILATE
    toolRotate:    "#FFB830",            // ROTATE
    toolMorph:     "#FF3E9A",            // MORPH
    toolDecorate:  "#FFD700",            // DECORATE
} as const;

/** Accent color for a tool (carousel highlight, panel border tint). */
export const TOOL_ACCENT: Record<MenuId, string> = {
    [MenuId.ADD_SHAPES]: T.toolAdd,
    [MenuId.TRANSLATE]: T.toolTranslate,
    [MenuId.DILATE]: T.toolDilate,
    [MenuId.ROTATE]: T.toolRotate,
    [MenuId.MORPH]: T.toolMorph,
    [MenuId.DECORATE]: T.toolDecorate,
};

/** Per-tool icon + accent + label for the carousel (§4.1). */
export const MENU_META: Record<MenuId, { icon: string; accent: string; label: string }> = {
    [MenuId.ADD_SHAPES]: { icon: "+",  accent: T.toolAdd,       label: "ADD SHAPES" },
    [MenuId.TRANSLATE]:  { icon: "✥",  accent: T.toolTranslate, label: "TRANSLATE" },
    [MenuId.DILATE]:     { icon: "⊕",  accent: T.toolDilate,    label: "DILATE" },
    [MenuId.ROTATE]:     { icon: "↻",  accent: T.toolRotate,    label: "ROTATE" },
    [MenuId.MORPH]:      { icon: "∿",  accent: T.toolMorph,     label: "MORPH" },
    [MenuId.DECORATE]:   { icon: "✦",  accent: T.toolDecorate,  label: "DECORATE" },
};

export const FONT = "'JetBrains Mono', monospace";
