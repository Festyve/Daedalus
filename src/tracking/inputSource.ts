// InputSource picker + shared re-exports (SPEC §3.4, §10.2, §10.3).
//
// All downstream code consumes the InputSource abstraction — never raw
// MediaPipe output — so it can be driven by either the real camera
// (LiveInputSource) or the mouse/keyboard mock (MockInputSource). This module
// is the single place that decides which kind to build, based on the dev URL
// param `?mock=1`. Pure DOM/URL logic; intentionally no three.js import.
import type { InputSource, PoseFrame } from "../types";

// Re-export the shared contracts so callers can import the InputSource types
// and the picker from one place. These are the authoritative definitions in
// src/types.ts — never redefined here.
export type { InputSource, PoseFrame } from "../types";

/** Discriminator for the two InputSource implementations. */
export type SourceKind = "live" | "mock";

// `?mock=1` selects the MockInputSource (SPEC §10.3). Any other value — absent,
// "0", "false", empty — falls through to the live camera source.
const MOCK_PARAM = "mock";
const MOCK_ENABLED = "1";

/**
 * Decide which InputSource to construct from the current URL.
 * Returns "mock" when `?mock=1` is present, otherwise "live".
 *
 * Reads `location.search` lazily on each call so dev tooling that rewrites the
 * query string (without a full reload) is honored on the next pump cycle.
 */
export function pickSourceKind(): SourceKind {
    // Guard for non-browser contexts (e.g. unit tests, SSR): no location means
    // no mock param, so default to the live source kind.
    if (typeof location === "undefined" || typeof location.search !== "string") {
        return "live";
    }
    const params = new URLSearchParams(location.search);
    return params.get(MOCK_PARAM) === MOCK_ENABLED ? "mock" : "live";
}
