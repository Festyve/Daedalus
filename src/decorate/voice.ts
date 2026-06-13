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
        reply: "I'm a donut decorator, not a miracle worker — adding extra sprinkles instead.",
    },
    {
        keywords: ["clear", "reset", "remove", "plain"],
        reply: "Wiping it back to a clean canvas. Ready when you are.",
    },
    {
        keywords: ["thank", "thanks", "nice", "love", "great"],
        reply: "My pleasure. This donut turned out beautifully.",
    },
];
const DEFAULT_REPLY = "Decorating now — jam icing and a burst of rainbow sprinkles.";

// Pick the canned reply for a transcript. Pure and case-insensitive; deterministic for
// a given input (the property the voice unit test asserts).
export function scriptReply(transcript: string): string {
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

// ---- ElevenLabs Conversational AI adapter (§8.1 step 4, §15) --------------------------
// Real LLM reply + TTS over the ElevenLabs Agents Platform WebSocket. respond() opens
// (and reuses) one conversation socket, sends the transcript as a `user_message`, streams
// the agent's reply text token-by-token to onToken (driving the chat typewriter), and
// plays the returned PCM audio in real time via Web Audio — so text and voice land
// together (§8.1 step 5). speak() is a no-op here: the agent already speaks its own reply
// through respond(); we never double up with browser TTS.
//
// Connection model (verified June 2026 docs):
//   - PUBLIC agent  → connect directly: wss://api.elevenlabs.io/v1/convai/conversation?agent_id=ID
//   - PRIVATE agent → fetch a signed URL (GET …/get-signed-url, header xi-api-key) then connect.
// The API key, when supplied, is read from VITE_ELEVENLABS_API_KEY. NOTE: a key in a Vite
// build is bundled client-side — fine for a local hackathon demo, but for production the
// signed URL should be minted by a tiny server endpoint so the key never ships to browsers.
//
// Default agent audio format is pcm_16000 (raw 16-bit LE mono @16kHz); the real sample
// rate is read from the init metadata. If anything fails (no WebSocket, connect rejects,
// socket drops mid-turn) we fall back to the deterministic ScriptedAdapter so the demo
// never stalls — the hardcoded decoration (§8.1 step 3) is unaffected regardless.

const EL_BASE_WSS = "wss://api.elevenlabs.io/v1/convai/conversation";
const EL_SIGNED_URL = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";
// Resolve a turn after this long even if no `agent_response` arrives, so the chat panel
// never hangs on the "processing" spinner.
const EL_TURN_TIMEOUT_MS = 20000;
const EL_DEFAULT_SAMPLE_RATE = 16000;

// A reply turn in flight: streams tokens to the typewriter and resolves when the agent's
// final text arrives (audio may keep playing after).
interface ElTurn {
    onToken: (chunk: string) => void;
    resolve: (reply: VoiceReply) => void;
    text: string;        // accumulated agent text
    streamed: boolean;   // whether any delta was emitted via onToken
    timer: ReturnType<typeof setTimeout> | null;
}

export class ElevenLabsAdapter implements VoiceAdapter {
    private readonly agentId: string;
    private readonly apiKey: string | undefined;
    // Deterministic safety net used whenever the live path is unavailable.
    private readonly fallback = new ScriptedAdapter();

    private socket: WebSocket | null = null;
    private connecting: Promise<WebSocket> | null = null;
    private turn: ElTurn | null = null;

    // Streamed PCM playback (Web Audio), built lazily on the first audio chunk.
    private audioCtx: AudioContext | null = null;
    private sampleRate = EL_DEFAULT_SAMPLE_RATE;
    private nextPlayTime = 0;
    private readonly sources = new Set<AudioBufferSourceNode>();

    constructor(agentId: string, apiKey?: string) {
        this.agentId = agentId;
        this.apiKey = apiKey;
    }

    respond(transcript: string, onToken: (chunk: string) => void): Promise<VoiceReply> {
        return this.ensureSocket()
            .then((sock) => {
                // Close any prior in-flight turn before starting a new one.
                this.finishTurn();
                return new Promise<VoiceReply>((resolve) => {
                    const turn: ElTurn = { onToken, resolve, text: "", streamed: false, timer: null };
                    turn.timer = setTimeout(() => this.finishTurn(), EL_TURN_TIMEOUT_MS);
                    this.turn = turn;
                    sock.send(JSON.stringify({ type: "user_message", text: transcript }));
                });
            })
            .catch((err) => {
                // Live path unavailable — speak + stream the scripted reply so the demo
                // stays alive (the decoration already fired independently, §8.1).
                if (typeof console !== "undefined") {
                    console.warn("[voice] ElevenLabs unavailable; using scripted fallback:", err);
                }
                this.fallback.speak(scriptReply(transcript));
                return this.fallback.respond(transcript, onToken);
            });
    }

    // The agent speaks its own reply through respond()'s audio stream, so there is nothing
    // extra to say here. Kept as a no-op to satisfy the VoiceAdapter contract.
    speak(_text: string): void {
        // intentionally empty — see class doc.
    }

    dispose(): void {
        this.finishTurn();
        if (this.socket) {
            try { this.socket.close(); } catch { /* already closing */ }
            this.socket = null;
        }
        this.connecting = null;
        this.stopAudio();
        if (this.audioCtx) {
            void this.audioCtx.close().catch(() => undefined);
            this.audioCtx = null;
        }
    }

    // ---- connection ---------------------------------------------------------

    // Open (once) and cache the conversation socket. Reused across turns so the agent
    // keeps conversational context. Rejects when WebSocket is absent or the connect fails.
    private ensureSocket(): Promise<WebSocket> {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return Promise.resolve(this.socket);
        }
        if (this.connecting) return this.connecting;

        this.connecting = this.resolveUrl()
            .then((url) => this.openSocket(url))
            .then((sock) => {
                this.socket = sock;
                this.connecting = null;
                return sock;
            })
            .catch((err) => {
                this.connecting = null;
                throw err;
            });
        return this.connecting;
    }

    // Direct wss for a public agent; a signed URL when an API key is configured (private).
    private resolveUrl(): Promise<string> {
        if (typeof WebSocket === "undefined") {
            return Promise.reject(new Error("WebSocket unavailable"));
        }
        if (!this.apiKey) {
            return Promise.resolve(`${EL_BASE_WSS}?agent_id=${encodeURIComponent(this.agentId)}`);
        }
        return fetch(`${EL_SIGNED_URL}?agent_id=${encodeURIComponent(this.agentId)}`, {
            headers: { "xi-api-key": this.apiKey },
        })
            .then((res) => {
                if (!res.ok) throw new Error(`get-signed-url ${res.status}`);
                return res.json() as Promise<{ signed_url?: string }>;
            })
            .then((body) => {
                if (!body.signed_url) throw new Error("signed_url missing");
                return body.signed_url;
            });
    }

    private openSocket(url: string): Promise<WebSocket> {
        return new Promise<WebSocket>((resolve, reject) => {
            const sock = new WebSocket(url);
            sock.onopen = (): void => {
                // Begin the session; empty overrides are valid.
                sock.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
                resolve(sock);
            };
            sock.onmessage = (ev): void => this.onMessage(ev);
            sock.onerror = (): void => {
                // If the open never completed, surface the failure to ensureSocket().
                reject(new Error("ElevenLabs socket error"));
            };
            sock.onclose = (): void => {
                if (this.socket === sock) this.socket = null;
                // A drop mid-turn must still settle the chat panel.
                this.finishTurn();
            };
        });
    }

    // ---- server events ------------------------------------------------------

    private onMessage(ev: MessageEvent): void {
        if (typeof ev.data !== "string") return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }

        switch (msg.type) {
            case "conversation_initiation_metadata": {
                const fmt = msg.conversation_initiation_metadata_event?.agent_output_audio_format;
                this.sampleRate = parseSampleRate(fmt);
                break;
            }
            case "ping": {
                const id = msg.ping_event?.event_id;
                this.socket?.send(JSON.stringify({ type: "pong", event_id: id }));
                break;
            }
            case "audio": {
                const b64 = msg.audio_event?.audio_base_64;
                if (typeof b64 === "string") this.playPcmChunk(b64);
                break;
            }
            case "agent_chat_response_part": {
                // Streaming text delta (lightly documented; handled defensively).
                const part = msg.text_response_part;
                if (this.turn && part?.type === "delta" && typeof part.text === "string") {
                    this.turn.text += part.text;
                    this.turn.streamed = true;
                    this.turn.onToken(part.text);
                }
                break;
            }
            case "agent_response": {
                // Authoritative final text — resolve the turn.
                const full = msg.agent_response_event?.agent_response;
                if (this.turn && typeof full === "string") this.turn.text = full;
                this.finishTurn();
                break;
            }
            case "interruption": {
                this.stopAudio();
                break;
            }
            default:
                break;
        }
    }

    // Resolve the active turn (if any): emit the full text once if nothing streamed, then
    // clear it. Idempotent and safe to call from timeout / close / final-text paths.
    private finishTurn(): void {
        const turn = this.turn;
        if (!turn) return;
        this.turn = null;
        if (turn.timer) clearTimeout(turn.timer);
        if (!turn.streamed && turn.text) turn.onToken(turn.text);
        turn.resolve({ text: turn.text });
    }

    // ---- streamed PCM playback ---------------------------------------------

    private playPcmChunk(base64: string): void {
        const ctx = this.ensureAudio();
        if (!ctx) return;
        const bytes = base64ToBytes(base64);
        if (bytes.length < 2) return;
        const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
        const buffer = ctx.createBuffer(1, pcm16.length, this.sampleRate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm16.length; i++) channel[i] = pcm16[i] / 32768;

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        const now = ctx.currentTime;
        if (this.nextPlayTime < now) this.nextPlayTime = now;
        src.start(this.nextPlayTime);
        this.nextPlayTime += buffer.duration;
        this.sources.add(src);
        src.onended = (): void => { this.sources.delete(src); };
    }

    private ensureAudio(): AudioContext | null {
        if (this.audioCtx) return this.audioCtx;
        if (typeof window === "undefined") return null;
        const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
        if (!Ctor) return null;
        try {
            this.audioCtx = new Ctor({ sampleRate: this.sampleRate });
            this.nextPlayTime = 0;
            return this.audioCtx;
        } catch {
            return null;
        }
    }

    private stopAudio(): void {
        for (const src of this.sources) {
            try { src.stop(); } catch { /* already stopped */ }
        }
        this.sources.clear();
        this.nextPlayTime = 0;
    }
}

// Parse the sample rate out of an ElevenLabs audio-format tag like "pcm_16000".
function parseSampleRate(fmt: unknown): number {
    if (typeof fmt !== "string") return EL_DEFAULT_SAMPLE_RATE;
    const m = fmt.match(/(\d{4,6})/);
    return m ? Number(m[1]) : EL_DEFAULT_SAMPLE_RATE;
}

// Decode base64 → bytes without Node Buffer (browser path).
function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// ---- adapter factory (§8.1) ----------------------------------------------------------
// Read VITE config without a hard dependency on a generated env type. import.meta is cast
// to any so the file stays self-contained and portable across build setups.
function elevenLabsAgentId(): string | undefined {
    const env = (import.meta as any).env;
    const id = env?.VITE_ELEVENLABS_AGENT_ID;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}
function elevenLabsApiKey(): string | undefined {
    const env = (import.meta as any).env;
    const key = env?.VITE_ELEVENLABS_API_KEY;
    return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * Factory for the active VoiceAdapter (§8.1). When VITE_ELEVENLABS_AGENT_ID is configured
 * AND the runtime has WebSocket, returns the live ElevenLabsAdapter (real LLM reply + TTS);
 * otherwise the deterministic ScriptedAdapter. The ElevenLabs adapter itself also falls
 * back to scripted at runtime if a connection ever fails, so the demo never stalls.
 */
export function makeVoiceAdapter(): VoiceAdapter {
    const agentId = elevenLabsAgentId();
    if (agentId && typeof WebSocket !== "undefined") {
        if (typeof console !== "undefined") {
            console.info("[voice] ElevenLabs Conversational AI enabled (agent " + agentId + ").");
        }
        return new ElevenLabsAdapter(agentId, elevenLabsApiKey());
    }
    return new ScriptedAdapter();
}
