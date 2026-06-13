import { describe, it, expect, afterEach } from "vitest";
import { ScriptedAdapter, makeVoiceAdapter } from "../src/decorate/voice";
import type { VoiceAdapter } from "../src/types";

// Drive respond() and collect every streamed chunk plus the resolved reply. The adapter
// streams via setTimeout under the node test env (real timers available), so this awaits
// the promise rather than advancing fake timers — keeping the test free of timer mocks.
async function drive(
    adapter: VoiceAdapter,
    transcript: string,
): Promise<{ streamed: string; reply: string }> {
    const chunks: string[] = [];
    const result = await adapter.respond(transcript, (chunk) => chunks.push(chunk));
    return { streamed: chunks.join(""), reply: result.text };
}

describe("ScriptedAdapter.respond", () => {
    it("resolves with the concatenation of streamed tokens", async () => {
        const adapter = new ScriptedAdapter();
        const { streamed, reply } = await drive(adapter, "give it rainbow sprinkles");
        // Acceptance: the resolved reply equals everything pushed through onToken.
        expect(streamed).toBe(reply);
        expect(reply.length).toBeGreaterThan(0);
    });

    it("never drops or duplicates characters across chunks", async () => {
        const adapter = new ScriptedAdapter();
        let length_sum = 0;
        const result = await adapter.respond("add some jam icing", (chunk) => {
            length_sum += chunk.length;
        });
        // The sum of chunk lengths must exactly reconstruct the reply (no overlap, no gap).
        expect(length_sum).toBe(result.text.length);
    });

    it("is deterministic: identical transcript → identical reply", async () => {
        const adapter = new ScriptedAdapter();
        const first = await drive(adapter, "make it a galaxy donut");
        const second = await drive(adapter, "make it a galaxy donut");
        expect(second.reply).toBe(first.reply);
        expect(second.streamed).toBe(first.streamed);
    });

    it("is determined purely by the transcript (case-insensitive, instance-independent)", async () => {
        const a = new ScriptedAdapter();
        const b = new ScriptedAdapter();
        const lower = await drive(a, "please clear the canvas");
        const upper = await drive(b, "PLEASE CLEAR THE CANVAS");
        // Same transcript content (ignoring case) → same reply, regardless of adapter instance.
        expect(upper.reply).toBe(lower.reply);
    });

    it("distinct intents yield distinct replies", async () => {
        const adapter = new ScriptedAdapter();
        const jam = await drive(adapter, "spread jam on top");
        const galaxy = await drive(adapter, "give it a cosmic star look");
        expect(jam.reply).not.toBe(galaxy.reply);
    });

    it("is total: even an empty transcript resolves to non-empty text", async () => {
        const adapter = new ScriptedAdapter();
        const { streamed, reply } = await drive(adapter, "");
        expect(reply.length).toBeGreaterThan(0);
        expect(streamed).toBe(reply);
    });
});

describe("ScriptedAdapter.speak", () => {
    // speak() touches the global `window` / `SpeechSynthesisUtterance`. Restore the global
    // after every case so stubbing one test never leaks into the timer-based respond tests.
    const original_window = (globalThis as { window?: unknown }).window;

    afterEach(() => {
        if (original_window === undefined) {
            delete (globalThis as { window?: unknown }).window;
        } else {
            (globalThis as { window?: unknown }).window = original_window;
        }
    });

    it("does not throw when window is undefined (headless / node env)", () => {
        // Default node env: no `window` at all — the first guard returns early.
        delete (globalThis as { window?: unknown }).window;
        const adapter = new ScriptedAdapter();
        expect(() => adapter.speak("hello there")).not.toThrow();
    });

    it("does not throw when speechSynthesis is undefined (stubbed)", () => {
        // Acceptance: a window exists but exposes no speechSynthesis — the second guard
        // must keep speak() a safe no-op rather than dereferencing undefined.
        (globalThis as { window?: unknown }).window = { speechSynthesis: undefined };
        const adapter = new ScriptedAdapter();
        expect(() => adapter.speak("decorating now")).not.toThrow();
    });

    it("does not throw for empty text", () => {
        (globalThis as { window?: unknown }).window = { speechSynthesis: undefined };
        const adapter = new ScriptedAdapter();
        expect(() => adapter.speak("")).not.toThrow();
    });
});

describe("makeVoiceAdapter", () => {
    it("returns a ScriptedAdapter satisfying the VoiceAdapter contract", () => {
        const adapter = makeVoiceAdapter();
        expect(adapter).toBeInstanceOf(ScriptedAdapter);
        expect(typeof adapter.respond).toBe("function");
        expect(typeof adapter.speak).toBe("function");
    });

    it("produces an adapter whose respond stays deterministic", async () => {
        const adapter = makeVoiceAdapter();
        const first = await drive(adapter, "thanks, that looks great");
        const second = await drive(adapter, "thanks, that looks great");
        expect(second.reply).toBe(first.reply);
        expect(first.streamed).toBe(first.reply);
    });
});
