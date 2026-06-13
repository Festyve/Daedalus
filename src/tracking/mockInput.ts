// Mouse/keyboard mock input (SPEC §10.2). Enabled by `?mock=1`, it replaces
// MediaPipe entirely so the whole app is drivable with no camera: it synthesizes
// well-formed 21-landmark PoseFrames from mouse + keyboard state.
//
// Mapping (SPEC §10.2):
//   mouse position        -> Right INDEX_TIP (landmark 8) — the EXEC hand
//   left-click held       -> Right pinch (thumb tip 4 meets index tip 8) — exec grab
//   scroll wheel          -> Right depth (Z), pushes the hand toward / away
//   W / A / S / D         -> Left (nav) hand position
//   G                     -> Left finger gun  (opens the carousel)
//   F                     -> flick right (both hands): nav-hand flick navigates the
//                            carousel; exec-hand flick cycles the ADD SHAPES shape
//   P                     -> Left pinch       (select the centered tool)
//   X                     -> Left fist        (dismiss the carousel)
//
// Nav gestures ride the LEFT hand and mouse/click ride the RIGHT hand, so the two
// roles (§3.2 Left=carousel, Right=execution) stay independent exactly as with live hands.
//   1 - 6                 -> directly activate tool 1-6 (via window.DAEDALUS)
//   [ / ]                 -> brush radius down / up (via window.DAEDALUS)
//
// Pure DOM event wiring; no three.js, no per-frame allocation beyond the pose it
// must return. Landmarks follow the MediaPipe topology so downstream gesture math
// (SPEC §12) reads them exactly as it reads live hands.
import type {
    Handedness,
    HandPose,
    InputSource,
    PoseFrame,
    Vec3,
} from "../types";

// ---- MediaPipe landmark indices we reference by name (SPEC §12) -------------
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const LANDMARK_COUNT = 21;

// Canonical flat-hand templates in a hand-local frame (palm facing camera, fingers
// pointing up). `x` grows to the hand's right, `y` grows downward (image-space
// convention so the wrist sits below the fingertips), `z` ~ 0. World units are
// metric (~12 cm hand); image units are a small normalized patch we later place at
// the cursor. Index order matches MediaPipe exactly.
//
// Each entry: [x, y] in template units; z is filled per-axis below. The thumb (1-4)
// fans out to the hand's left; index..pinky (5-20) run up in four columns.
const HAND_TEMPLATE: ReadonlyArray<readonly [number, number]> = [
    [0.00, 0.00],   // 0  wrist
    [-0.18, -0.10], // 1  thumb CMC
    [-0.30, -0.22], // 2  thumb MCP
    [-0.40, -0.34], // 3  thumb IP
    [-0.48, -0.44], // 4  thumb TIP
    [-0.12, -0.46], // 5  index MCP
    [-0.14, -0.66], // 6  index PIP
    [-0.15, -0.82], // 7  index DIP
    [-0.16, -0.96], // 8  index TIP
    [0.02, -0.50],  // 9  middle MCP
    [0.02, -0.72],  // 10 middle PIP
    [0.02, -0.90],  // 11 middle DIP
    [0.02, -1.06],  // 12 middle TIP
    [0.14, -0.47],  // 13 ring MCP
    [0.16, -0.67],  // 14 ring PIP
    [0.17, -0.83],  // 15 ring DIP
    [0.18, -0.97],  // 16 ring TIP
    [0.24, -0.40],  // 17 pinky MCP
    [0.27, -0.56],  // 18 pinky PIP
    [0.29, -0.69],  // 19 pinky DIP
    [0.31, -0.80],  // 20 pinky TIP
];

// Curled-finger template (fist, and the curled fingers of the gun). Each distal joint
// folds back toward its OWN MCP so the fingertip ends up radially CLOSER to the wrist
// than its PIP — which is exactly what fingerExtended() tests (§12:
// dist(tip,wrist) > dist(pip,wrist)). A weaker fold leaves the tip farther out and the
// finger still reads as "extended", which is the bug this replaces.
// Retain factor per joint within a finger: MCP 1.0 (unchanged), PIP 0.5, DIP 0.2,
// TIP 0.0 (collapses onto the MCP). Finger groups are contiguous: index 5-8, middle
// 9-12, ring 13-16, pinky 17-20, so (i-5)%4 indexes MCP/PIP/DIP/TIP.
const CURL_RETAIN: readonly number[] = [1.0, 0.5, 0.2, 0.0];
const CURL_TEMPLATE: ReadonlyArray<readonly [number, number]> = HAND_TEMPLATE.map(
    (p, i): [number, number] => {
        if (i < 5) return [p[0], p[1]]; // wrist + thumb stay extended
        const within = (i - 5) % 4;     // 0 MCP, 1 PIP, 2 DIP, 3 TIP
        const mcp = HAND_TEMPLATE[i - within];
        const k = CURL_RETAIN[within];
        return [mcp[0] + (p[0] - mcp[0]) * k, mcp[1] + (p[1] - mcp[1]) * k];
    },
);

// Template scale: image-space hand spans ~0.18 of the normalized frame; world-space
// hand spans ~0.12 m. `S = ||wrist - middleMCP||` (SPEC §3.5) then lands near these.
const IMAGE_SPAN = 0.18;
const WORLD_SPAN = 0.12;
const WORLD_DEPTH_SPREAD = 0.02; // small z thickness so world landmarks aren't planar

// Flick: a one-frame index-tip horizontal velocity burst. SPEC §12 flick predicate
// is vx(indexTip) > 0.4·S/frame; we offset the index tip by this fraction of the
// image span so the consumer's per-frame velocity clears the threshold.
const FLICK_DX = 0.5 * IMAGE_SPAN;
// The flick is modeled as an instantaneous index-tip displacement that DECAYS back to
// rest over a few frames. The rise (one frame) clears the SPEC §12 flick threshold
// (vx > 0.4·S/frame) in one direction; the gradual fall keeps the return velocity below
// threshold so it never registers as an equal-and-opposite reverse flick that would
// cancel the navigation step. Keep FLICK_DECAY below 0.4·(image hand scale ≈ 0.5·SPAN).
const FLICK_DECAY = 0.15 * IMAGE_SPAN;

// Pinch closes the thumb tip (4) onto the index tip (8): SPEC §12 pinch is
// ||tip4 - tip8|| / S < 0.30. We collapse them to ~0.
// Depth (Z) from scroll: clamped normalized offset applied to the whole right hand.
const DEPTH_MIN = -0.4;
const DEPTH_MAX = 0.4;
const SCROLL_GAIN = 0.0008;

// Left-hand WASD motion: normalized units per second, integrated each pump.
const WASD_SPEED = 0.6;

// Minimal shape of the global debug API we drive (defined in main.ts). Optional —
// every access is guarded, so the mock degrades gracefully if it's absent.
interface DaedalusGlobal {
    selectMenu?(id: string | null): void;
    nudgeBrushRadius?(delta: number): void;
    setBrushRadius?(r: number): void;
}

// Tool order for number keys 1-6 (matches MENU_ORDER in types.ts; kept as plain
// strings so this file never depends on menu internals).
const TOOL_KEYS: readonly string[] = [
    "ADD_SHAPES",
    "SELECT",
    "TRANSLATE",
    "DILATE",
    "ROTATE",
    "MORPH",
    "DECORATE",
    "INTERACT",
    "DESTROY",
];

/**
 * Mock InputSource: turns mouse + keyboard into synthetic two-hand PoseFrames.
 * Last-write-wins, non-blocking — `pump(dt)` is the only place a frame is built.
 */
export class MockInputSource implements InputSource {
    ready = false;

    // ---- live input state (mutated by DOM listeners) ----
    private mouse_x = 0.5;          // normalized [0,1], selfie (mirrored) image space
    private mouse_y = 0.5;
    private depth_z = 0;            // accumulated scroll depth, clamped
    private left_x = 0.35;         // left-hand normalized center, moved by WASD
    private left_y = 0.55;
    private keys = new Set<string>(); // currently-held lowercase keys (for WASD)

    private click_held = false;    // left mouse button => right pinch
    private p_pinch = false;       // 'P' => right pinch (select)
    private gun = false;           // 'G' => left finger gun (open carousel)
    private fist = false;          // 'X' => left fist (dismiss carousel)
    private flick_offset = 0;      // current nav index-tip flick displacement (decays to 0)

    // ---- bound listeners, retained so dispose() can remove them ----
    private readonly onMouseMove = (e: MouseEvent): void => {
        // The live feed + landmarks are MIRRORED (selfie space), so mirror X to match the
        // selfie-flipped feed. innerWidth/Height guard against 0.
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        this.mouse_x = 1 - clamp01(e.clientX / w);
        this.mouse_y = clamp01(e.clientY / h);
    };

    private readonly onMouseDown = (e: MouseEvent): void => {
        if (e.button === 0) this.click_held = true;
    };

    private readonly onMouseUp = (e: MouseEvent): void => {
        if (e.button === 0) this.click_held = false;
    };

    private readonly onWheel = (e: WheelEvent): void => {
        // Scroll up (deltaY<0) pulls the hand toward the camera (toward viewer).
        this.depth_z = clamp(this.depth_z + e.deltaY * SCROLL_GAIN, DEPTH_MIN, DEPTH_MAX);
        e.preventDefault();
    };

    private readonly onKeyDown = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        this.keys.add(k);
        switch (k) {
            case "g": this.gun = true; break;
            case "x": this.fist = true; break;
            case "p": this.p_pinch = true; break;
            case "f": this.flick_offset = FLICK_DX; break;
            case "[": daedalus()?.nudgeBrushRadius?.(-1); break;
            case "]": daedalus()?.nudgeBrushRadius?.(+1); break;
            default: {
                // 1-6 directly activate a tool via the global debug API.
                const n = Number(k);
                if (Number.isInteger(n) && n >= 1 && n <= TOOL_KEYS.length) {
                    daedalus()?.selectMenu?.(TOOL_KEYS[n - 1]);
                }
            }
        }
    };

    private readonly onKeyUp = (e: KeyboardEvent): void => {
        const k = e.key.toLowerCase();
        this.keys.delete(k);
        switch (k) {
            case "g": this.gun = false; break;
            case "x": this.fist = false; break;
            case "p": this.p_pinch = false; break;
        }
    };

    private readonly onBlur = (): void => {
        // Drop all held state if the window loses focus so nothing sticks.
        this.keys.clear();
        this.click_held = false;
        this.p_pinch = false;
        this.gun = false;
        this.fist = false;
    };

    async init(): Promise<void> {
        window.addEventListener("mousemove", this.onMouseMove);
        window.addEventListener("mousedown", this.onMouseDown);
        window.addEventListener("mouseup", this.onMouseUp);
        window.addEventListener("wheel", this.onWheel, { passive: false });
        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("blur", this.onBlur);
        this.ready = true;
    }

    /** Build the latest synthetic frame. Non-blocking; pure function of state. */
    pump(dtMs: number): PoseFrame {
        const t_ms = performance.now();
        if (!this.ready) {
            return { Left: null, Right: null, count: 0, tMs: t_ms, source: "mock" };
        }

        this.integrateWasd(dtMs);

        // Sample the current flick displacement, then decay it for next frame. The rise
        // happened on the F keypress; the gradual fall avoids a spurious reverse flick.
        const flick_offset = this.flick_offset;
        if (this.flick_offset > 0) this.flick_offset = Math.max(0, this.flick_offset - FLICK_DECAY);

        // Right (exec) hand: mouse-positioned; pinch from the left mouse button. The flick
        // also rides the exec hand so ADD SHAPES (which cycles shapes on the exec flick)
        // is drivable; in the global carousel the exec flick is harmless (no active menu).
        const right = this.buildRightHand(t_ms, this.click_held, flick_offset);
        // Left (nav) hand: WASD-positioned; carousel gestures come from the keyboard
        // (G gun / F flick / P pinch-select / X fist) so the nav role is fully drivable.
        const left = this.buildLeftHand(t_ms, this.gun, this.fist, this.p_pinch, flick_offset);

        return {
            Left: left,
            Right: right,
            count: 2,
            tMs: t_ms,
            source: "mock",
        };
    }

    dispose(): void {
        window.removeEventListener("mousemove", this.onMouseMove);
        window.removeEventListener("mousedown", this.onMouseDown);
        window.removeEventListener("mouseup", this.onMouseUp);
        window.removeEventListener("wheel", this.onWheel);
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.onBlur);
        this.keys.clear();
        this.ready = false;
    }

    // ---- internals ----------------------------------------------------------

    /** Integrate held W/A/S/D into the left-hand center, clamped to the frame. */
    private integrateWasd(dtMs: number): void {
        const step = WASD_SPEED * (dtMs / 1000);
        let dx = 0;
        let dy = 0;
        if (this.keys.has("a")) dx -= step;
        if (this.keys.has("d")) dx += step;
        if (this.keys.has("w")) dy -= step;
        if (this.keys.has("s")) dy += step;
        if (dx !== 0 || dy !== 0) {
            this.left_x = clamp01(this.left_x + dx);
            this.left_y = clamp01(this.left_y + dy);
        }
    }

    /**
     * Right hand = the EXEC hand (§3.2). Its INDEX_TIP tracks the mouse; the left
     * mouse button closes a pinch; scroll shifts world-z (interaction-plane depth).
     * Carousel/nav gestures live on the LEFT hand, so the two roles stay independent
     * exactly as they do with live hands.
     */
    private buildRightHand(tMs: number, pinch: boolean, flickOffset: number): HandPose {
        const { landmarks, world } = composeHand(
            HAND_TEMPLATE,
            this.mouse_x,
            this.mouse_y,
            this.depth_z,
            pinch,
        );
        applyFlick(landmarks, world, flickOffset);
        return makePose("Right", landmarks, world, tMs);
    }

    /**
     * Left hand = the NAV hand (§3.2): it drives the tool carousel. Positioned by
     * WASD; the keyboard shapes its pose — G finger gun (open), X fist (dismiss),
     * P pinch (select), F flick (navigate). This is why pressing G opens the wheel.
     */
    private buildLeftHand(
        tMs: number,
        gun: boolean,
        fist: boolean,
        pinch: boolean,
        flickOffset: number,
    ): HandPose {
        const base = gun ? gunTemplate() : fist ? CURL_TEMPLATE : HAND_TEMPLATE;
        const { landmarks, world } = composeHand(base, this.left_x, this.left_y, 0, pinch);
        applyFlick(landmarks, world, flickOffset);
        return makePose("Left", landmarks, world, tMs);
    }
}

// ---- pure helpers -----------------------------------------------------------

/** Resolve the optional global debug API without throwing if it's absent. */
function daedalus(): DaedalusGlobal | undefined {
    return (window as unknown as { DAEDALUS?: DaedalusGlobal }).DAEDALUS;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
    return clamp(v, 0, 1);
}

/**
 * Gun pose template: index extended (5-8 from the flat hand), thumb up (1-4 flat),
 * ring + pinky curled (13-20 from the curl template), middle curled too (9-12).
 * SPEC §12 gun predicate: index extended + thumb up + ring/pinky curled.
 */
function gunTemplate(): ReadonlyArray<readonly [number, number]> {
    return HAND_TEMPLATE.map((p, i): [number, number] => {
        const extended = i <= 8;          // wrist, thumb, index stay extended
        return extended ? [p[0], p[1]] : [CURL_TEMPLATE[i][0], CURL_TEMPLATE[i][1]];
    });
}

/**
 * Place a hand-local template at a normalized image-space center, producing both
 * the 21 image landmarks and the 21 metric world landmarks. `depth_z` shifts the
 * world z; `pinch` collapses the thumb tip onto the index tip in both spaces.
 */
function composeHand(
    template: ReadonlyArray<readonly [number, number]>,
    centerX: number,
    centerY: number,
    depthZ: number,
    pinch: boolean,
): { landmarks: Vec3[]; world: Vec3[] } {
    const landmarks: Vec3[] = new Array(LANDMARK_COUNT);
    const world: Vec3[] = new Array(LANDMARK_COUNT);

    for (let i = 0; i < LANDMARK_COUNT; i++) {
        const tx = template[i][0];
        const ty = template[i][1];
        // Pseudo-random but stable per-joint z thickness so world landmarks form a
        // shallow 3D shell rather than a flat plane (helps any z-dependent math).
        const tz = (((i * 37) % 7) / 6 - 0.5) * 2;

        // Image space: small patch centered on the cursor; the template's INDEX_TIP
        // sits above the wrist, so we offset so INDEX_TIP lands exactly at center.
        landmarks[i] = {
            x: clamp01(centerX + (tx - HAND_TEMPLATE[INDEX_TIP][0]) * IMAGE_SPAN),
            y: clamp01(centerY + (ty - HAND_TEMPLATE[INDEX_TIP][1]) * IMAGE_SPAN),
            z: tz * 0.01,
        };

        // World space: wrist-origin metric frame; sign of x flipped so right-hand
        // geometry stays right-handed after the image mirror, z carries scroll depth.
        world[i] = {
            x: tx * WORLD_SPAN,
            y: ty * WORLD_SPAN,
            z: depthZ + tz * WORLD_DEPTH_SPREAD,
        };
    }

    if (pinch) {
        // Collapse thumb tip onto index tip in both spaces: ||tip4 - tip8|| -> ~0,
        // so pinch closure (SPEC §12) reads as fully pinched.
        landmarks[THUMB_TIP] = { ...landmarks[INDEX_TIP] };
        world[THUMB_TIP] = { ...world[INDEX_TIP] };
    }

    return { landmarks, world };
}

/**
 * Apply a one-axis flick displacement to a hand's index tip (image + world). Its
 * frame-to-frame change is the velocity the §12 flick predicate reads (vx > 0.4·S/frame
 * on the rise). Shared by both hands so the nav flick drives the carousel and the exec
 * flick cycles ADD SHAPES. No-op when offset is 0.
 */
function applyFlick(landmarks: Vec3[], world: Vec3[], offset: number): void {
    if (offset <= 0) return;
    landmarks[INDEX_TIP] = {
        x: clamp01(landmarks[INDEX_TIP].x + offset),
        y: landmarks[INDEX_TIP].y,
        z: landmarks[INDEX_TIP].z,
    };
    world[INDEX_TIP] = {
        x: world[INDEX_TIP].x + offset * WORLD_SPAN / IMAGE_SPAN,
        y: world[INDEX_TIP].y,
        z: world[INDEX_TIP].z,
    };
}

/** Assemble a HandPose with confidence + handScale derived from world landmarks. */
function makePose(
    handedness: Handedness,
    landmarks: Vec3[],
    world: Vec3[],
    tMs: number,
): HandPose {
    // S = ||wrist(0) - middleMCP(9)|| in world landmarks (SPEC §3.5).
    const handScale = dist3(world[WRIST], world[MIDDLE_MCP]);
    return {
        handedness,
        landmarks,
        world,
        confidence: 1,
        handScale,
        timestamp: tMs,
    };
}

function dist3(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.hypot(dx, dy, dz) || 1e-3;
}
