// Authored accessory designs (SPEC §9.3).
//
// Verbatim sprinkle + icing presets, typed by the frozen contracts in
// src/types.ts. The chat-driven path (DecorationAction.design) and the
// direct-hand path both look designs up by key from these records.
import type { SprinkleDesign, IcingDesign } from "../types";

// Sprinkle geometry presets.
export const SPRINKLE_DESIGNS: Record<string, SprinkleDesign> = {
    "rainbow":      { geometry: "capsule", palette: ["#FF3E9A", "#FFE642", "#42CFFF", "#8BFF42"], length: 0.04, radius: 0.008, sizeJitter: 0.3, orientation: "random" },
    "star-silver":  { geometry: "star", palette: ["#C0C8D4", "#E8EEF4"], length: 0.035, radius: 0.01, sizeJitter: 0.2, orientation: "normal" },
    "extra-rainbow": { geometry: "capsule", palette: ["#FF3E9A", "#FFE642", "#42CFFF", "#8BFF42", "#FF6B42"], length: 0.04, radius: 0.008, sizeJitter: 0.5, orientation: "random" },
};

// Icing / glaze material presets.
export const ICING_DESIGNS: Record<string, IcingDesign> = {
    "pink":          { color: "#FF3E9A", gloss: 0.7, dripStyle: "smooth", edgeNoise: 0.15, sugarDusting: false },
    "galaxy-purple": { color: "#8B3EFF", gloss: 0.9, dripStyle: "thick", edgeNoise: 0.2, sugarDusting: true },
};
