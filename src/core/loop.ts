// §12.2 — master rAF loop. Computes a clamped dt and calls update() each frame.
// Inference and render are decoupled: the loop never blocks on inference; it
// reads the latest pose from the store and the per-frame update does the work.

const MAX_DT = 0.05; // clamp dt (s) so a long pause never causes a giant step

export interface LoopHandle {
    stop(): void;
}

export function startLoop(update: (dt: number) => void): LoopHandle {
    let last = performance.now();
    let running = true;
    let raf_id = 0;

    function frame(now: number): void {
        if (!running) return;
        raf_id = requestAnimationFrame(frame);
        const dt = Math.min(MAX_DT, (now - last) / 1000);
        last = now;
        update(dt);
    }

    raf_id = requestAnimationFrame(frame);

    return {
        stop(): void {
            running = false;
            cancelAnimationFrame(raf_id);
        },
    };
}
