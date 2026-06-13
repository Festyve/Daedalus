// §10.4 — WebAudio SFX. Preloads /sfx/{crunch,poof,ding}.wav when present; if a
// file is missing it synthesizes a short tone so play(name) always produces sound.

export type SfxName = "crunch" | "poof" | "ding";

const SFX_NAMES: SfxName[] = ["crunch", "poof", "ding"];
const SFX_URL: Record<SfxName, string> = {
    crunch: "/sfx/crunch.wav",
    poof: "/sfx/poof.wav",
    ding: "/sfx/ding.wav",
};

export class Sfx {
    private ctx: AudioContext;
    private buffers: Partial<Record<SfxName, AudioBuffer>> = {};

    constructor() {
        const Ctor: typeof AudioContext =
            window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
    }

    // Best-effort preload. A missing/failed file is fine — play() falls back to a tone.
    async preload(): Promise<void> {
        await Promise.all(
            SFX_NAMES.map(async (name) => {
                try {
                    const res = await fetch(SFX_URL[name]);
                    if (!res.ok) return;
                    const data = await res.arrayBuffer();
                    this.buffers[name] = await this.ctx.decodeAudioData(data);
                } catch {
                    // leave unloaded; synthesized fallback covers it
                }
            }),
        );
    }

    play(name: SfxName): void {
        // A user gesture is required before audio can start; resume if suspended.
        if (this.ctx.state === "suspended") void this.ctx.resume();
        const buffer = this.buffers[name];
        if (buffer) {
            this.playBuffer(buffer);
        } else {
            this.playTone(name);
        }
    }

    private playBuffer(buffer: AudioBuffer): void {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.ctx.destination);
        src.start();
    }

    // Distinct synthesized fallbacks: crunch = noise burst, poof = downward sweep,
    // ding = clean bell.
    private playTone(name: SfxName): void {
        if (name === "crunch") {
            this.playNoise(0.18);
            return;
        }
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        if (name === "poof") {
            osc.type = "sine";
            osc.frequency.setValueAtTime(420, now);
            osc.frequency.exponentialRampToValueAtTime(80, now + 0.3);
            gain.gain.setValueAtTime(0.25, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.32);
        } else {
            // ding
            osc.type = "sine";
            osc.frequency.setValueAtTime(1320, now);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
            osc.start(now);
            osc.stop(now + 0.52);
        }
    }

    private playNoise(duration: number): void {
        const now = this.ctx.currentTime;
        const frames = Math.floor(this.ctx.sampleRate * duration);
        const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        const gain = this.ctx.createGain();
        src.connect(gain);
        gain.connect(this.ctx.destination);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        src.start(now);
    }
}
