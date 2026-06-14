// Authored decoration constants (SPEC §8.2).
//
// Verbatim icing + sprinkle presets, typed by the frozen contracts in
// src/types.ts. The chat-driven path (DecorationAction.design) and the
// direct-hand path both resolve designs by key from these records.
//
// Source of truth: SPEC §8.2.
//   ICING.jam       → color #8B0000, gloss 0.8, dripStyle "smooth"
//   SPRINKLES.rainbow → capsule, palette below, length 0.08, radius 0.016
//   (2× the §8.2 baseline of 0.04 / 0.008 so the sprinkles read larger on the donut)
import type { IcingDesign, SprinkleDesign } from "../types";

// Icing / glaze flavour presets (SPEC §8.2, §8.3). The spoken flavour picks the colour:
// "jam"/"strawberry" → pink, "chocolate" → brown, etc. The material self-glows each hue.
export const ICING: Record<string, IcingDesign> = {
    jam: { color: "#FF3E7F", gloss: 0.85, dripStyle: "smooth" },        // strawberry / pink (default)
    chocolate: { color: "#7A3B16", gloss: 0.7, dripStyle: "thick" },   // brown
    blueberry: { color: "#3D6BFF", gloss: 0.85, dripStyle: "smooth" }, // blue
    lemon: { color: "#FFD42E", gloss: 0.85, dripStyle: "smooth" },     // yellow
    matcha: { color: "#5FB83C", gloss: 0.75, dripStyle: "smooth" },    // green
    grape: { color: "#A24BFF", gloss: 0.85, dripStyle: "smooth" },     // purple
};

// Sprinkle geometry presets (SPEC §8.2, §8.4).
export const SPRINKLES: { rainbow: SprinkleDesign } = {
    rainbow: {
        geometry: "capsule",
        palette: ["#FF3E9A", "#FFE642", "#42CFFF", "#8BFF42", "#FF6B42"],
        length: 0.08,
        radius: 0.016,
    },
};
