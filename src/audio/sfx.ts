// §1.2 — JARVIS sound design. WebAudio SFX synthesized procedurally (no wav files):
//   ping  — soft harmonic tone on carousel select
//   hum   — low hum on panel open
//   ding  — crystalline bell on torus complete (morph t > 0.95)
//
// The AudioContext is created lazily on first use and stays suspended until a user
// gesture calls resume() — so there are never autoplay errors. Every node is short-
// lived and self-disconnects on end; nothing is retained between plays.

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

let AUDIO_CTX: AudioContext | null = null;

// Master gain keeps the whole bus comfortably below clipping regardless of overlap.
const MASTER_GAIN = 0.5;
let master: GainNode | null = null;

/** Lazily build (or return) the shared AudioContext + master bus. */
function ensureContext(): AudioContext | null {
    if (AUDIO_CTX) return AUDIO_CTX;
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!Ctor) return null;
    try {
        AUDIO_CTX = new Ctor();
        master = AUDIO_CTX.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(AUDIO_CTX.destination);
    } catch {
        // Some environments forbid construction outside a gesture; fail silent.
        AUDIO_CTX = null;
        master = null;
        return null;
    }
    return AUDIO_CTX;
}

/** One enveloped sine partial. Self-disconnects when it finishes ringing. */
function tone(
    ctx: AudioContext,
    bus: GainNode,
    freq: number,
    start: number,
    attack: number,
    duration: number,
    peak: number,
    type: OscillatorType = "sine",
): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);

    // Exponential ramps need a strictly-positive floor.
    const FLOOR = 0.0001;
    gain.gain.setValueAtTime(FLOOR, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, FLOOR), start + attack);
    gain.gain.exponentialRampToValueAtTime(FLOOR, start + attack + duration);

    osc.connect(gain);
    gain.connect(bus);

    const stop = start + attack + duration + 0.02;
    osc.start(start);
    osc.stop(stop);
    osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
    };
}

/** Resume a suspended context (always safe to call); no-op until a gesture lands. */
function resumeContext(ctx: AudioContext): void {
    if (ctx.state === "suspended") void ctx.resume();
}

export const sfx = {
    /** Soft harmonic ping — carousel selection. Fundamental + fifth + octave, brief. */
    ping(): void {
        const ctx = ensureContext();
        if (!ctx || !master) return;
        resumeContext(ctx);
        const now = ctx.currentTime;
        tone(ctx, master, 880, now, 0.004, 0.18, 0.30);
        tone(ctx, master, 1320, now, 0.004, 0.14, 0.14);
        tone(ctx, master, 1760, now, 0.006, 0.10, 0.07);
    },

    /** Low hum — panel open. Detuned pair, slow swell, gentle low presence. */
    hum(): void {
        const ctx = ensureContext();
        if (!ctx || !master) return;
        resumeContext(ctx);
        const now = ctx.currentTime;
        tone(ctx, master, 110, now, 0.08, 0.42, 0.22, "sine");
        tone(ctx, master, 110.6, now, 0.08, 0.42, 0.18, "sine"); // beat-detune for warmth
        tone(ctx, master, 220, now, 0.10, 0.36, 0.06, "sine");   // faint octave body
    },

    /** Crystalline ding — torus complete. Bell-like inharmonic partials, long ring. */
    ding(): void {
        const ctx = ensureContext();
        if (!ctx || !master) return;
        resumeContext(ctx);
        const now = ctx.currentTime;
        // Inharmonic partials (≈ a small struck bell) give the "crystal" timbre.
        tone(ctx, master, 1568, now, 0.003, 0.90, 0.28);
        tone(ctx, master, 2349, now, 0.003, 0.70, 0.12);
        tone(ctx, master, 3136, now, 0.004, 0.55, 0.07);
        tone(ctx, master, 4080, now, 0.004, 0.40, 0.04);
    },

    /** Call from the first user gesture (click / pinch) to unlock audio playback. */
    resume(): void {
        const ctx = ensureContext();
        if (!ctx) return;
        resumeContext(ctx);
    },
};
