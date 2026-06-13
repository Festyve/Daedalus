// SPEC §2 — master requestAnimationFrame loop. Computes a clamped per-frame delta
// (in milliseconds) and invokes the supplied callback once per frame.
//
// Threading model (§2 "Threading model"):
//   - Single rAF loop on the main thread drives render + sculpt + UI.
//   - Inference (MediaPipe) is pumped from inside the callback and treated as
//     state via a latest-value store — the loop NEVER awaits inference inline.
//   - The callback is synchronous from the loop's perspective: even if it kicks
//     off async work, scheduling of the next frame happens immediately, so the
//     render cadence is fully decoupled from inference latency (last-write-wins).
//
// Zero per-frame allocation: no closures, arrays, or objects are created inside
// the frame function — only module-scope scalars are mutated (§11).

// Clamp dt (ms) so a long pause (tab backgrounded, breakpoint) never produces a
// giant step that would explode sculpt/physics math on resume.
const MAX_DT_MS = 50;

let running = false;
let raf_id = 0;
let last = 0;
let callback: ((dtMs: number) => void) | null = null;

function frame(now: number): void {
    if (!running) return;
    // Schedule the next frame first so a throw inside the callback (or async
    // work it spawns) can never stall the render cadence.
    raf_id = requestAnimationFrame(frame);
    const dt_ms = Math.min(MAX_DT_MS, now - last);
    last = now;
    callback!(dt_ms);
}

/** Start the master loop. Invokes `cb` with the per-frame delta in milliseconds
 *  every frame. Starts immediately; calling again restarts cleanly. */
export function startLoop(cb: (dtMs: number) => void): void {
    if (running) stopLoop();
    callback = cb;
    running = true;
    last = performance.now();
    raf_id = requestAnimationFrame(frame);
}

/** Stop the master loop and release the callback. Idempotent. */
export function stopLoop(): void {
    running = false;
    if (raf_id !== 0) {
        cancelAnimationFrame(raf_id);
        raf_id = 0;
    }
    callback = null;
}
