import { MenuId } from "../types";

// SPEC §15.1 — authored design tokens.
export const TOKENS = {
    bg: "#000000",
    steel: "/matcaps/steel-obsidian.png",
    rim: "#AEE8FF",
    icingPink: "#FF3E9A",
    edgeHot: "#FFE6B0",
    text: "#FFFFFF",
    textDim: "rgba(255,255,255,0.45)",
    menuTeal: "#00FFD1",    // ADD
    menuBlue: "#4488FF",    // TRANSLATE
    menuPurple: "#AA44FF",  // DILATE
    menuAmber: "#FFB830",   // ROTATE
    menuRed: "#FF4444",     // INTERACT
    menuPink: "#FF3E9A",    // MORPH
    menuGold: "#FFD700",    // DECORATE
    menuWhite: "#FFFFFF",   // DESTROY
} as const;

// Per-menu icon, accent, label (SPEC §5.1).
export const MENU_META: Record<MenuId, { icon: string; accent: string; label: string }> = {
    [MenuId.ADD_SHAPES]: { icon: "+", accent: TOKENS.menuTeal, label: "ADD SHAPES" },
    [MenuId.TRANSLATE]: { icon: "↕↔", accent: TOKENS.menuBlue, label: "TRANSLATE" },
    [MenuId.DILATE]: { icon: "⊕", accent: TOKENS.menuPurple, label: "DILATE" },
    [MenuId.ROTATE]: { icon: "↻", accent: TOKENS.menuAmber, label: "ROTATE" },
    [MenuId.INTERACT]: { icon: "⊗", accent: TOKENS.menuRed, label: "INTERACT" },
    [MenuId.MORPH]: { icon: "∿", accent: TOKENS.menuPink, label: "MORPH" },
    [MenuId.DECORATE]: { icon: "✦", accent: TOKENS.menuGold, label: "DECORATE" },
    [MenuId.DESTROY]: { icon: "✕", accent: TOKENS.menuWhite, label: "DESTROY" },
};
