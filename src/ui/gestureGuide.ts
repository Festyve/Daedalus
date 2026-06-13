// Single source of truth for the gesture instructions, shared by every menu's
// spatial panel (#4 — small per-menu "how to operate" block) and the clickable
// instructions popout (#5 — full gesture list). Keep the lines short: they render
// on a 512x384 canvas panel and in a compact DOM popout.
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";

export interface GestureRow {
    gesture: string;
    action: string;
}

// Global navigation gestures — always active, independent of the menu.
export const GLOBAL_GESTURES: GestureRow[] = [
    { gesture: "Left hand: “gun” — index out, thumb up", action: "open the menu wheel" },
    { gesture: "Aim the left index at a tile", action: "highlight that menu" },
    { gesture: "Left pinch", action: "select the highlighted menu" },
    { gesture: "Left fist", action: "close the wheel" },
];

// Per-menu operating instructions (right hand drives execution unless noted).
export const MENU_HINTS: Record<MenuId, string[]> = {
    [MenuId.ADD_SHAPES]: ["point + dwell to aim a shape", "pinch to spawn, drag to place"],
    [MenuId.TRANSLATE]: ["pinch near an arrow", "drag along its axis"],
    [MenuId.DILATE]: ["pinch with BOTH hands", "apart / together = scale"],
    [MenuId.ROTATE]: ["pinch to grab the ball", "twist to rotate · left gun = lock axis"],
    [MenuId.INTERACT]: ["tap another shape to target it", "dwell an op, pinch to apply"],
    [MenuId.MORPH]: ["squeeze your hand to morph", "open your hand to relax it"],
    [MenuId.DECORATE]: ["left peace = next AI line", "right open = icing · pinch = sprinkles"],
    [MenuId.DESTROY]: ["pinch & hold to eat it"],
};

// Convenience for the popout: every menu's hints with its label + accent.
export function menuGuideRows(): { label: string; accent: string; lines: string[] }[] {
    return (Object.keys(MENU_HINTS) as MenuId[]).map((id) => ({
        label: MENU_META[id].label,
        accent: MENU_META[id].accent,
        lines: MENU_HINTS[id],
    }));
}
