// Voice interface for the DECORATE phase (SPEC §8.1). Two independent pieces:
//
//   1. SpeechInput — a thin wrapper over the browser Web Speech API (STT). It listens
//      to the microphone and emits finalized transcripts. No key needed (§8.6/§14).
//   2. ScriptedAdapter — a deterministic VoiceAdapter: it produces a canned reply for a
//      transcript, streams that reply token-by-token (~40 cps, matching the chat-panel
//      typewriter, §8.6) via onToken, and speaks it through the browser SpeechSynthesis
//      TTS. The reply is a pure function of the transcript, so unit tests are stable.
//
// The real ElevenLabs Conversational AI adapter (real LLM reply + TTS over a websocket)
// is DEFERRED (TODO.md, decision 2026-06-13). makeVoiceAdapter() is the single seam:
// when VITE_ELEVENLABS_AGENT_ID is configured it should construct the live adapter; until
// then it always returns the scripted one. See the ELEVENLABS SEAM block below.
//
// Everything no-ops gracefully when the underlying browser APIs are absent (e.g. SSR,
// Firefox without SpeechRecognition, a headless test run): respond() still resolves,
// speak() silently returns, and SpeechInput.supported reports false.
import type { VoiceAdapter, VoiceReply } from "../types";

// Typewriter cadence (§8.6): the chat panel reveals ~40 chars/sec. We stream tokens at
// the same rate so the audio (TTS) and the on-screen text stay roughly in lockstep.
const CHARS_PER_SEC = 40;
// One streamed chunk per this many ms. A handful of chars per tick reads smoothly while
// keeping the timer count low. STREAM_CHUNK / CHARS_PER_SEC sets the inter-tick delay.
const STREAM_CHUNK = 2;                                   // chars emitted per onToken call
const STREAM_INTERVAL_MS = (STREAM_CHUNK / CHARS_PER_SEC) * 1000;

// Browser TTS voice shaping (§8.1): a calm, slightly bright JARVIS cadence.
const TTS_RATE = 1.05;
const TTS_PITCH = 1.0;
const TTS_VOLUME = 1.0;

// ---- Web Speech API typing shims -----------------------------------------------------
// SpeechRecognition is not in the standard DOM lib (it lives behind the unprefixed and
// webkit-prefixed globals). We declare the minimal surface we use rather than depending
// on @types/dom-speech-recognition, so the file compiles under the repo tsconfig as-is.
interface SpeechRecognitionResultLike {
    readonly transcript: string;
    readonly confidence: number;
}
interface SpeechRecognitionAlternativeList {
    readonly length: number;
    readonly isFinal: boolean;
    [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionResultListLike {
    readonly length: number;
    [index: number]: SpeechRecognitionAlternativeList;
}
interface SpeechRecognitionEventLike {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
    onend: (() => void) | null;
    onerror: ((ev: unknown) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

// Resolve the constructor across vendor prefixes; undefined when unsupported.
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined {
    if (typeof window === "undefined") return undefined;
    const w = window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Web Speech API speech-to-text wrapper (§8.1 step 2). Construct with a callback that
 * receives finalized transcripts; call start() to begin listening and stop() to end.
 * `supported` is false when the browser lacks SpeechRecognition — start()/stop() then
 * no-op so callers never need to branch.
 */
export class SpeechInput {
    readonly supported: boolean;

    private readonly on_transcript: (t: string) => void;
    private recognition: SpeechRecognitionLike | null = null;
    private listening = false;
    // The Chrome implementation fires `onend` on its own (after a pause, after an error).
    // While the caller wants us listening we transparently restart, so a single start()
    // yields a continuous stream of utterances.
    private want_listening = false;

    constructor(onTranscript: (t: string) => void) {
        this.on_transcript = onTranscript;
        const Ctor = getSpeechRecognitionCtor();
        this.supported = Ctor !== undefined;
        if (Ctor) this.recognition = this.build(Ctor);
    }

    private build(Ctor: SpeechRecognitionCtor): SpeechRecognitionLike {
        const rec = new Ctor();
        rec.lang = "en-US";
        rec.continuous = true;
        rec.interimResults = false;     // we only surface finalized utterances
        rec.maxAlternatives = 1;

        rec.onresult = (ev: SpeechRecognitionEventLike): void => {
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const result = ev.results[i];
                if (!result.isFinal) continue;
                const text = result[0]?.transcript?.trim();
                if (text) this.on_transcript(text);
            }
        };
        // Auto-restart while the caller still wants us listening. Without this the engine
        // stops after each pause and the mic goes dead mid-demo.
        rec.onend = (): void => {
            this.listening = false;
            if (this.want_listening) this.startEngine();
        };
        // Swallow transient errors (no-speech, aborted, network); onend handles restart.
        rec.onerror = (): void => {
            this.listening = false;
        };
        return rec;
    }

    start(): void {
        if (!this.recognition) return;
        this.want_listening = true;
        this.startEngine();
    }

    stop(): void {
        this.want_listening = false;
        if (!this.recognition || !this.listening) return;
        try {
            this.recognition.stop();
        } catch {
            // stop() throws if not started; safe to ignore.
        }
        this.listening = false;
    }

    private startEngine(): void {
        if (!this.recognition || this.listening) return;
        try {
            this.recognition.start();
            this.listening = true;
        } catch {
            // Chrome throws "already started" if start() races onend; the engine is then
            // already running, so treat it as listening.
            this.listening = true;
        }
    }
}

// ---- Scripted reply authoring --------------------------------------------------------
// Deterministic replies keyed by intent keywords found in the transcript. The order
// matters: the first rule whose keyword set matches wins. DEFAULT_REPLY is the fallback
// so respond() is total (always yields text) for any input, including "".
interface ReplyRule {
    keywords: string[];
    reply: string;
}
const REPLY_RULES: ReplyRule[] = [
    {
        keywords: ["rainbow", "sprinkle"],
        reply: "On it — rainbow sprinkles and a glossy jam glaze, coming right up.",
    },
    {
        keywords: ["jam", "icing", "glaze", "frost"],
        reply: "Applying a rich jam icing across the top. Looking delicious already.",
    },
    {
        keywords: ["galaxy", "cosmic", "space", "star"],
        reply: "Cosmic mode: deep glaze and a scatter of star-bright sprinkles.",
    },
    {
        keywords: ["healthy", "diet", "sugar-free", "calorie"],
        reply: "I'm a torus decorator, not a miracle worker — adding extra sprinkles instead.",
    },
    {
        keywords: ["clear", "reset", "remove", "plain"],
        reply: "Wiping it back to a clean canvas. Ready when you are.",
    },
    {
        keywords: ["thank", "thanks", "nice", "love", "great"],
        reply: "My pleasure. This torus turned out beautifully.",
    },
];
const DEFAULT_REPLY = "Decorating now — jam icing and a burst of rainbow sprinkles.";

// Pick the canned reply for a transcript. Pure and case-insensitive; deterministic for
// a given input (the property the voice unit test asserts).
function scriptReply(transcript: string): string {
    const hay = transcript.toLowerCase();
    for (const rule of REPLY_RULES) {
        if (rule.keywords.some((k) => hay.includes(k))) return rule.reply;
    }
    return DEFAULT_REPLY;
}

/**
 * Deterministic scripted VoiceAdapter (§8.1). respond() resolves to a canned reply
 * chosen purely from the transcript, streaming it to onToken at ~40 cps so the chat
 * typewriter and TTS stay in sync. speak() reads text aloud via window.speechSynthesis.
 * Both degrade to safe no-ops when the relevant browser API is missing.
 */
export class ScriptedAdapter implements VoiceAdapter {
    respond(transcript: string, onToken: (chunk: string) => void): Promise<VoiceReply> {
        const text = scriptReply(transcript);

        // No timers available (SSR / test env): resolve immediately with the full text in
        // one chunk so callers still receive it and the promise contract holds.
        if (typeof setTimeout === "undefined") {
            onToken(text);
            return Promise.resolve({ text });
        }

        return new Promise<VoiceReply>((resolve) => {
            let i = 0;
            const tick = (): void => {
                const next = Math.min(text.length, i + STREAM_CHUNK);
                if (next > i) onToken(text.slice(i, next));
                i = next;
                if (i >= text.length) {
                    resolve({ text });
                    return;
                }
                setTimeout(tick, STREAM_INTERVAL_MS);
            };
            tick();
        });
    }

    speak(text: string): void {
        if (typeof window === "undefined") return;
        const synth = window.speechSynthesis;
        if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
        if (!text) return;
        try {
            // Cancel any in-flight utterance so replies never queue up and overlap.
            synth.cancel();
            const utter = new SpeechSynthesisUtterance(text);
            utter.rate = TTS_RATE;
            utter.pitch = TTS_PITCH;
            utter.volume = TTS_VOLUME;
            synth.speak(utter);
        } catch {
            // Some browsers throw on speak() before a user gesture; failing quietly keeps
            // the deterministic text path (respond) unaffected.
        }
    }
}

// ---- ELEVENLABS SEAM (deferred — TODO.md, decision 2026-06-13) ------------------------
// When ElevenLabs Conversational AI is wired, add `class ElevenLabsAdapter implements
// VoiceAdapter` in this file (signed-url websocket handshake → stream real LLM tokens to
// onToken, play the returned audio). makeVoiceAdapter() then constructs it whenever
// VITE_ELEVENLABS_AGENT_ID is present, falling back to ScriptedAdapter otherwise. No
// other module changes: callers only ever see the VoiceAdapter interface.

// Read the VITE agent-id without a hard dependency on a generated env type. import.meta
// is cast to any so the file compiles whether or not vite/client's ImportMetaEnv is in
// scope (it is, per tsconfig, but the cast keeps this seam self-contained and portable).
function elevenLabsAgentId(): string | undefined {
    const env = (import.meta as any).env;
    const id = env?.VITE_ELEVENLABS_AGENT_ID;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Factory for the active VoiceAdapter (§8.1). Returns the deterministic ScriptedAdapter.
 * Once the ElevenLabs adapter lands, construct it here when an agent id is configured.
 */
export function makeVoiceAdapter(): VoiceAdapter {
    const agentId = elevenLabsAgentId();
    if (agentId) {
        // ELEVENLABS SEAM: real Conversational AI adapter goes here once implemented.
        // Until then we log the configured id and fall through to the scripted reply so
        // the demo never breaks if a stray env var is set without the adapter shipped.
        if (typeof console !== "undefined") {
            console.info(
                "[voice] VITE_ELEVENLABS_AGENT_ID set but ElevenLabsAdapter is not yet " +
                    "implemented (deferred); using ScriptedAdapter.",
            );
        }
    }
    return new ScriptedAdapter();
}
