/// <reference types="vitest" />
import { defineConfig } from "vite";

// NOTE: COOP/COEP headers are intentionally NOT set. They would put the page in
// a cross-origin-isolated context (require-corp), which breaks the CDN-loaded
// MediaPipe model + WASM the tracking layer relies on. The existing prototype
// runs fine without isolation; we only need SharedArrayBuffer if we later move
// to self-hosted, CORP-tagged MediaPipe assets (SPEC §16.4 "if using SAB").
export default defineConfig({
    base: "./",
    server: { host: true },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
    },
});
