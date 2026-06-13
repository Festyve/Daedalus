// Authored decoration constants (SPEC §8.2).
//
// Verbatim icing + sprinkle presets, typed by the frozen contracts in
// src/types.ts. The chat-driven path (DecorationAction.design) and the
// direct-hand path both resolve designs by key from these records.
//
// Source of truth: SPEC §8.2.
//   ICING.jam       → color #8B0000, gloss 0.8, dripStyle "smooth"
//   SPRINKLES.rainbow → capsule, palette below, length 0.04, radius 0.008
import type { IcingDesign, SprinkleDesign } from "../types";

// Icing / glaze material presets (SPEC §8.2, §8.3).
export const ICING: { jam: IcingDesign } = {
    jam: { color: "#8B0000", gloss: 0.8, dripStyle: "smooth" },
};

// Sprinkle geometry presets (SPEC §8.2, §8.4).
export const SPRINKLES: { rainbow: SprinkleDesign } = {
    rainbow: {
        geometry: "capsule",
        palette: ["#FF3E9A", "#FFE642", "#42CFFF", "#8BFF42", "#FF6B42"],
        length: 0.04,
        radius: 0.008,
    },
};
