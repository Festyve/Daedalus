// AI chat panel (SPEC §9.2) — a floating CSS3D chat UI placed to the right of the
// donut. It looks like a minimal chat client (message bubbles, a "✦ DAEDALUS AI"
// avatar with a thinking spinner, a blinking-cursor input) but is ENTIRELY
// hardcoded: a small set of authored `ChatTurn[]` scripts (§9.2.2) play back with a
// typewriter effect (~40 chars/sec, §9.2.4). Each AI turn's `DecorationAction` fires
// when its text is 50% typed, calling into the real decoration backends
// (decorate/icing.applyIcingRegion + decorate/sprinkles.addSprinkles) so the donut
// actually changes while the AI is still "talking".
//
// The DOM tree is wrapped in a CSS3DObject (Context7-confirmed: `new
// CSS3DObject(element)` added to the same scene, rendered by ctx.css3d with the same
// camera) so it composites in 3D beside the mesh. Visual spec is §9.2.5.
import * as THREE from "three";
import { CSS3DObject } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import type { SceneContext, ChatTurn, DecorationAction, MenuModule, HandPose } from "../types";
import { MenuId } from "../types";
import { MENU_META } from "../render/tokens";
import { SpatialPanel } from "../menu/spatialPanel";
import { classify } from "../gesture/predicates";
import { fingertipToWorld } from "../math/coords";
import { Sprinkles } from "./sprinkles";
import { applyIcingRegion, smearAt } from "./icing";
import { SPRINKLE_DESIGNS, ICING_DESIGNS } from "./designs";

// ---- Visual spec (§9.2.5) -------------------------------------------------------
const PANEL_W_PX = 320;            // §9.2.5 width "320px equivalent in scene units"
const PANEL_H_PX = 440;            // tall enough for the avatar + log + input
const BG_HEX = "#0A0A0A";          // near-black, distinct from scene black
const BORDER = "0.5px solid rgba(255,255,255,0.12)";
const FONT = '12px "JetBrains Mono", monospace';
const USER_BG = "rgba(255,255,255,0.08)";
const TEXT = "#FFFFFF";
const TEXT_DIM = "rgba(255,255,255,0.45)";
const ACCENT = "#FFD700";          // DECORATE accent (TOKENS.menuGold)

// World scale for the CSS3D layer: a CSS3DObject renders its element at 1px = 1
// world unit, so a 320px panel must be scaled down to sit (~1.6 world units wide)
// beside the unit-radius donut at the scene.ts camera distance.
const CSS_SCALE = 1.6 / PANEL_W_PX;
// Horizontal gap from the donut centre to the panel, camera-relative right (metres).
const SIDE_OFFSET = 2.4;

// Typewriter speed (§9.2.4): ~40 chars/second.
const CHARS_PER_SEC = 40;
// Fire each AI turn's DecorationAction once its text is this fraction typed (§9.2.4).
const ACTION_AT = 0.5;
// Pause after a fully-typed AI line before auto-advancing to the next turn (ms).
const POST_LINE_HOLD = 450;

// ---- Hardcoded conversation scripts (§9.2.2, VERBATIM) --------------------------
// Designs are looked up by key from the authored records (designs.ts / §9.3). Glaze
// has no geometry backend in this build, so add_glaze carries its design for the
// transcript but is a visual no-op at dispatch (see runAction).
const SCRIPTS: ChatTurn[][] = [
    // Demo script 1 — the hero conversation.
    [
        { role: "user", text: "Add rainbow sprinkles and pink icing", delay: 0 },
        { role: "ai", text: "On it! Applying pink glaze first...", delay: 800, action: { type: "apply_icing", design: ICING_DESIGNS["pink"], region: "top" } },
        { role: "ai", text: "Adding rainbow sprinkles...", delay: 1800, action: { type: "add_sprinkles", design: SPRINKLE_DESIGNS["rainbow"] } },
        { role: "ai", text: "Done! Your donut looks delicious 🍩", delay: 3000 },
    ],
    // Demo script 2 — judge interaction.
    [
        { role: "user", text: "Make it look like a galaxy donut", delay: 0 },
        { role: "ai", text: "Ooh nice. Applying cosmic purple glaze...", delay: 800, action: { type: "apply_icing", design: ICING_DESIGNS["galaxy-purple"], region: "all" } },
        { role: "ai", text: "Scattering star sprinkles...", delay: 1800, action: { type: "add_sprinkles", design: SPRINKLE_DESIGNS["star-silver"] } },
        { role: "ai", text: "Adding a shimmer glaze coat...", delay: 3000, action: { type: "add_glaze", design: { color: "#8B3EFF", shimmer: 0.8 } } },
        { role: "ai", text: "Behold: a galaxy donut.", delay: 4200 },
    ],
    // Script 3 — funny edge case.
    [
        { role: "user", text: "Make it healthy", delay: 0 },
        { role: "ai", text: "I'm a donut decorator, not a miracle worker.", delay: 800 },
        { role: "ai", text: "...adding extra sprinkles.", delay: 2000, action: { type: "add_sprinkles", design: SPRINKLE_DESIGNS["extra-rainbow"] } },
    ],
];

// Number of sprinkles a chat-driven add_sprinkles drop scatters.
const CHAT_SPRINKLE_COUNT = 600;

// Per-turn playback state for the active turn's typewriter.
interface TurnState {
    turn: ChatTurn;
    bubble: HTMLDivElement;   // the message element being filled (AI) or shown (user)
    elapsed: number;          // seconds the typewriter has been running on this turn
    actionFired: boolean;     // whether this turn's DecorationAction has dispatched
    done: boolean;            // text fully typed
}

export class ChatPanel {
    readonly object: CSS3DObject;

    private readonly root: HTMLDivElement;
    private readonly log: HTMLDivElement;
    private readonly avatarRow: HTMLDivElement;
    private readonly spinner: HTMLSpanElement;
    private readonly input: HTMLDivElement;       // fake input field with blinking cursor
    private readonly sprinkles: Sprinkles;

    // Script playback.
    private script: ChatTurn[] = [];
    private turnIndex = -1;
    private active: TurnState | null = null;
    private holdRemaining = 0;     // ms left of POST_LINE_HOLD before auto-advance
    private finished = false;      // whole script has played out

    // Re-place scratch (no per-frame alloc).
    private readonly camRight = new THREE.Vector3();
    private readonly placeTarget = new THREE.Vector3();
    private readonly lookTarget = new THREE.Vector3();

    constructor(ctx: SceneContext) {
        this.sprinkles = new Sprinkles(ctx);

        this.root = document.createElement("div");
        Object.assign(this.root.style, {
            width: `${PANEL_W_PX}px`,
            height: `${PANEL_H_PX}px`,
            boxSizing: "border-box",
            background: BG_HEX,
            border: BORDER,
            borderRadius: "10px",
            font: FONT,
            color: TEXT,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            // The CSS3D layer forwards no pointer events from scene.ts; keep the panel
            // itself non-interactive so it never steals the cursor from the canvas.
            pointerEvents: "none",
            userSelect: "none",
        } as Partial<CSSStyleDeclaration>);

        // Avatar header: "✦ DAEDALUS AI" + a thinking spinner shown while typing.
        this.avatarRow = document.createElement("div");
        Object.assign(this.avatarRow.style, {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "12px 14px",
            borderBottom: BORDER,
            letterSpacing: "0.08em",
        } as Partial<CSSStyleDeclaration>);
        const avatarLabel = document.createElement("span");
        avatarLabel.textContent = "✦ DAEDALUS AI";
        avatarLabel.style.color = ACCENT;
        avatarLabel.style.fontWeight = "700";
        this.spinner = document.createElement("span");
        this.spinner.textContent = "◍";
        Object.assign(this.spinner.style, {
            color: TEXT_DIM,
            marginLeft: "auto",
            visibility: "hidden",
        } as Partial<CSSStyleDeclaration>);
        this.avatarRow.appendChild(avatarLabel);
        this.avatarRow.appendChild(this.spinner);

        // Scrollable-feel message log (clipped; newest at the bottom).
        this.log = document.createElement("div");
        Object.assign(this.log.style, {
            flex: "1 1 auto",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "12px 14px",
            overflow: "hidden",
            justifyContent: "flex-end",
        } as Partial<CSSStyleDeclaration>);

        // Bottom input field with a blinking cursor (purely cosmetic).
        this.input = document.createElement("div");
        Object.assign(this.input.style, {
            display: "flex",
            alignItems: "center",
            gap: "2px",
            margin: "0 14px 12px",
            padding: "8px 10px",
            border: BORDER,
            borderRadius: "6px",
            color: TEXT_DIM,
            minHeight: "16px",
        } as Partial<CSSStyleDeclaration>);
        const placeholder = document.createElement("span");
        placeholder.textContent = "message DAEDALUS AI";
        const cursor = document.createElement("span");
        cursor.textContent = "▋";
        cursor.style.color = ACCENT;
        cursor.style.marginLeft = "2px";
        this.animateCursor(cursor);
        this.input.appendChild(placeholder);
        this.input.appendChild(cursor);

        this.root.appendChild(this.avatarRow);
        this.root.appendChild(this.log);
        this.root.appendChild(this.input);

        this.object = new CSS3DObject(this.root);
        this.object.scale.setScalar(CSS_SCALE);
    }

    // Blink the input cursor on a self-driven timer (independent of the rAF clock so
    // it keeps blinking even between hand frames). setInterval is fine for a 1Hz toggle.
    private animateCursor(cursor: HTMLSpanElement): void {
        let on = true;
        const tick = (): void => {
            on = !on;
            cursor.style.opacity = on ? "1" : "0";
        };
        window.setInterval(tick, 530);
    }

    // Begin the next unplayed script (cycles through SCRIPTS 1→2→3). Called by the
    // menu on enter() and again by the left-hand peace shortcut once a script ends.
    open(): void {
        if (this.turnIndex >= 0 && !this.finished) return; // a script is already running
        this.startScript((this.scriptCursor++) % SCRIPTS.length);
    }
    private scriptCursor = 0;

    private startScript(i: number): void {
        this.script = SCRIPTS[i];
        this.turnIndex = -1;
        this.active = null;
        this.holdRemaining = 0;
        this.finished = false;
        this.clearLog();
        this.beginTurn(0);
    }

    private clearLog(): void {
        while (this.log.firstChild) this.log.removeChild(this.log.firstChild);
    }

    // Advance to the turn at `index`, creating its bubble. User turns render instantly
    // (their text is "what the user typed"); AI turns type out character-by-character.
    private beginTurn(index: number): void {
        if (index >= this.script.length) {
            this.finished = true;
            this.active = null;
            this.spinner.style.visibility = "hidden";
            return;
        }
        this.turnIndex = index;
        const turn = this.script[index];
        const bubble = this.makeBubble(turn.role);
        this.log.appendChild(bubble);

        if (turn.role === "user") {
            bubble.textContent = turn.text;
            this.spinner.style.visibility = "hidden";
            // User lines need no typing; hold briefly, then move on to the AI reply.
            this.active = { turn, bubble, elapsed: 0, actionFired: true, done: true };
            this.holdRemaining = POST_LINE_HOLD;
        } else {
            bubble.textContent = "";
            bubble.style.color = TEXT_DIM;     // dimmer while in-progress (§9.2.5)
            this.spinner.style.visibility = "visible";
            this.active = { turn, bubble, elapsed: 0, actionFired: false, done: false };
            this.holdRemaining = 0;
        }
    }

    // Build a message bubble styled per role (§9.2.5): user right-aligned with a faint
    // background; AI left-aligned, no background.
    private makeBubble(role: ChatTurn["role"]): HTMLDivElement {
        const b = document.createElement("div");
        Object.assign(b.style, {
            maxWidth: "82%",
            padding: role === "user" ? "6px 9px" : "2px 0",
            borderRadius: "8px",
            lineHeight: "1.45",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: TEXT,
        } as Partial<CSSStyleDeclaration>);
        if (role === "user") {
            b.style.alignSelf = "flex-end";
            b.style.background = USER_BG;
            b.style.textAlign = "left";
        } else {
            b.style.alignSelf = "flex-start";
            b.style.background = "transparent";
        }
        return b;
    }

    // Per-frame driver. `dt` is seconds. Runs the active turn's typewriter, fires its
    // DecorationAction at 50% typed, and auto-advances to the next turn after a hold.
    // Returns true on the frame the whole script finishes (menu maps this → DECORATED).
    update(ctx: SceneContext, dt: number): boolean {
        if (this.finished || !this.active) return false;
        const st = this.active;

        if (!st.done) {
            st.elapsed += dt;
            const total = st.turn.text.length;
            const shown = Math.min(total, Math.floor(st.elapsed * CHARS_PER_SEC));
            st.bubble.textContent = st.turn.text.slice(0, shown);

            // Fire the decoration once the text is ACTION_AT (50%) typed (§9.2.4).
            if (!st.actionFired && total > 0 && shown / total >= ACTION_AT) {
                st.actionFired = true;
                if (st.turn.action) this.runAction(ctx, st.turn.action);
            }

            if (shown >= total) {
                st.done = true;
                st.bubble.textContent = st.turn.text;
                st.bubble.style.color = TEXT;          // settle to full brightness
                this.spinner.style.visibility = "hidden";
                this.holdRemaining = POST_LINE_HOLD;
            }
            return false;
        }

        // Fully typed: hold briefly, then advance. If the action somehow never fired
        // (e.g. a zero-length line), fire it now so no decoration is skipped.
        if (!st.actionFired && st.turn.action) {
            st.actionFired = true;
            this.runAction(ctx, st.turn.action);
        }
        this.holdRemaining -= dt * 1000;
        if (this.holdRemaining <= 0) {
            const wasLast = this.turnIndex >= this.script.length - 1;
            this.beginTurn(this.turnIndex + 1);
            if (wasLast && this.finished) return true;
        }
        return false;
    }

    // Dispatch a scripted DecorationAction to the real decoration backends. Only
    // apply_icing and add_sprinkles have geometry backends in this build; add_glaze is
    // carried in the transcript for narration but is a visual no-op; clear wipes the
    // sprinkle instances.
    private runAction(ctx: SceneContext, action: DecorationAction): void {
        switch (action.type) {
            case "apply_icing":
                applyIcingRegion(ctx, action.design, action.region ?? "top");
                break;
            case "add_sprinkles":
                this.sprinkles.addSprinkles(ctx, action.design, CHAT_SPRINKLE_COUNT);
                break;
            case "clear":
                this.sprinkles.clear();
                break;
            case "add_glaze":
                // No glaze geometry backend in this build (designs.ts ships none); the
                // line still narrates in the transcript. Intentional no-op.
                break;
        }
    }

    // Left-hand peace shortcut (§9.2.3): skip the rest of the current turn / advance.
    // If the active AI line is still typing, snap it to complete (firing its action if
    // pending) and jump to the next turn. If the script already finished, start the
    // next authored script — "looks like the user typed it" pitch safety mechanism.
    advance(ctx: SceneContext): void {
        if (this.finished) {
            this.startScript((this.scriptCursor++) % SCRIPTS.length);
            return;
        }
        const st = this.active;
        if (!st) return;
        if (!st.done) {
            // Complete the current line immediately.
            if (!st.actionFired && st.turn.action) {
                st.actionFired = true;
                this.runAction(ctx, st.turn.action);
            }
            st.bubble.textContent = st.turn.text;
            st.bubble.style.color = TEXT;
            st.done = true;
            this.spinner.style.visibility = "hidden";
            this.holdRemaining = 0;
        }
        this.beginTurn(this.turnIndex + 1);
    }

    get isFinished(): boolean {
        return this.finished;
    }

    // Re-place the panel beside the donut each frame: offset to the object's right
    // (camera-relative, flattened horizontal) and Y-billboarded to face the camera, so
    // the chat stays legible and never tips. Mirrors SpatialPanel.placeBeside.
    placeBeside(objectWorldPos: THREE.Vector3, camera: THREE.Camera): void {
        this.camRight.setFromMatrixColumn(camera.matrixWorld, 0);
        this.camRight.y = 0;
        if (this.camRight.lengthSq() < 1e-8) this.camRight.set(1, 0, 0);
        this.camRight.normalize();

        this.placeTarget.copy(objectWorldPos).addScaledVector(this.camRight, SIDE_OFFSET);
        this.object.position.copy(this.placeTarget);

        this.lookTarget.set(camera.position.x, this.placeTarget.y, camera.position.z);
        this.object.up.set(0, 1, 0);
        this.object.lookAt(this.lookTarget);
    }

    // Tear down: the owning menu removes object from the scene first. We free the
    // sprinkle instances we own (the icing controller is cached on the mesh geometry
    // and shared with the direct-hand path, so we do not dispose it here).
    dispose(): void {
        this.sprinkles.dispose();
        if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
    }
}

// ---- DECORATE menu module (SPEC §6.7) -------------------------------------------
// The AI-chat decoration paradigm + direct hand tools. enter() opens the hardcoded
// chat panel beside the donut plus a gold SpatialPanel legend; update() runs the chat
// typewriter, lets a left-hand peace advance the script (§9.2.3), and drives the
// direct-hand path (§9.4): a right-hand smear paints icing (icing.smearAt) and a
// right-hand pinch drops a batch of sprinkles (sprinkles.addSprinkles). Once the chat
// script has played out, ctx.stage flips to "DECORATED".

// Active design for the direct-hand path (the chat path uses its own per-turn
// designs). Pink icing + rainbow sprinkles is the default §9.3 pairing.
const SMEAR_ICING = ICING_DESIGNS["pink"];
const DROP_SPRINKLES = SPRINKLE_DESIGNS["rainbow"];
// Icing smear radius in mesh object space (the donut tube radius is ~0.42).
const SMEAR_RADIUS = 0.28;
// Sprinkles per pinch-drop (a small handful, well under the §9.4 ~1500 cap).
const DROP_COUNT = 120;
// Right-hand pinch closure (0..1) above which a sprinkle drop edge-triggers (§6.7).
const PINCH_ON = 0.7;

export function createDecorateMenu(): MenuModule {
    let chat: ChatPanel | null = null;
    let panel: SpatialPanel | null = null;
    let sprinkles: Sprinkles | null = null;

    // Edge-trigger latches so a held pose fires its action once, not every frame.
    let peace_latched = false;   // left-hand peace (chat advance, §9.2.3)
    let pinch_latched = false;   // right-hand pinch (sprinkle drop)
    let decorated = false;       // stage already flipped to DECORATED

    function enter(ctx: SceneContext): void {
        const accent = MENU_META[MenuId.DECORATE].accent;

        panel = new SpatialPanel(accent);
        ctx.scene.add(panel.object);
        drawLegend(panel);

        chat = new ChatPanel(ctx);
        ctx.scene.add(chat.object);
        chat.open();

        // Direct-hand sprinkle batches use their own controller (separate from the
        // chat panel's); each honours the global MAX_TOTAL via the sprinkles cap.
        sprinkles = new Sprinkles(ctx);

        peace_latched = false;
        pinch_latched = false;
        decorated = false;

        // Place both cards beside the donut immediately so nothing pops in at origin.
        ctx.mesh.updateWorldMatrix(true, false);
        ctx.mesh.getWorldPosition(ctx.scratch.v1);
        panel.placeBeside(ctx.scratch.v1, ctx.camera);
        chat.placeBeside(ctx.scratch.v1, ctx.camera);
    }

    function update(
        ctx: SceneContext,
        right: HandPose | null,
        left: HandPose | null,
        dt: number,
    ): void {
        if (!chat || !panel || !sprinkles) return;

        // Keep both cards pinned beside the (possibly spinning) donut.
        ctx.mesh.updateWorldMatrix(true, false);
        ctx.mesh.getWorldPosition(ctx.scratch.v1);
        panel.placeBeside(ctx.scratch.v1, ctx.camera);
        chat.placeBeside(ctx.scratch.v1, ctx.camera);

        // Left-hand peace = scripted-demo shortcut: advance the chat (§9.2.3), edge-
        // triggered so one peace fires exactly one advance.
        if (left) {
            const peace = classify(left.landmarks).name === "peace";
            if (peace && !peace_latched) chat.advance(ctx);
            peace_latched = peace;
        } else {
            peace_latched = false;
        }

        // Drive the chat typewriter; flip the stage the first time a script finishes.
        const just_finished = chat.update(ctx, dt);
        if ((just_finished || chat.isFinished) && !decorated) {
            ctx.stage = "DECORATED";
            decorated = true;
        }

        // Direct-hand decoration (§9.4) from the right hand.
        if (right) {
            const g = classify(right.landmarks);
            const world = fingertipToWorld(
                right.landmarks[8],
                ctx.camera,
                ctx.interactionPlaneZ,
                ctx.scratch.ray,
                ctx.scratch.plane,
                ctx.scratch.v2,
            );

            // Pinch → drop a batch of sprinkles at the surface (edge-triggered).
            const pinching = g.pinch >= PINCH_ON;
            if (pinching && !pinch_latched) {
                sprinkles.addSprinkles(ctx, DROP_SPRINKLES, DROP_COUNT);
            }
            pinch_latched = pinching;

            // Open-hand smear (not pinching) → paint icing under the index fingertip.
            // smearAt converts the world point into mesh object space itself.
            if (!pinching && (g.name === "open" || g.name === "point")) {
                smearAt(ctx, world, SMEAR_RADIUS, SMEAR_ICING);
            }
        } else {
            pinch_latched = false;
        }
    }

    function exit(ctx: SceneContext): void {
        if (chat) {
            ctx.scene.remove(chat.object);
            chat.dispose();
            chat = null;
        }
        if (panel) {
            ctx.scene.remove(panel.object);
            panel.dispose();
            panel = null;
        }
        if (sprinkles) {
            sprinkles.dispose();
            sprinkles = null;
        }
    }

    return { id: MenuId.DECORATE, enter, update, exit };
}

// Paint the gold affordance legend onto the SpatialPanel: what the chat does and the
// two direct-hand gestures (smear icing, pinch to drop sprinkles).
function drawLegend(panel: SpatialPanel): void {
    panel.draw((g, w) => {
        g.fillStyle = MENU_META[MenuId.DECORATE].accent;
        g.font = 'bold 30px "JetBrains Mono", monospace';
        g.fillText(`${MENU_META[MenuId.DECORATE].icon} DECORATE`, 26, 26);

        g.font = '20px "JetBrains Mono", monospace';
        const lines = [
            "AI chat decorates the donut.",
            "",
            "LEFT peace -> next AI line",
            "RIGHT open -> smear icing",
            "RIGHT pinch -> drop sprinkles",
        ];
        let y = 92;
        for (const line of lines) {
            g.fillStyle = line.startsWith("RIGHT") || line.startsWith("LEFT")
                ? "rgba(255,255,255,0.85)"
                : "rgba(255,255,255,0.55)";
            g.fillText(line, 26, y, w - 52);
            y += 34;
        }
    });
}
