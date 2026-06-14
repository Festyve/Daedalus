# Swipe Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the leaky-accumulator SwipeDetector with a simple direct-velocity-threshold approach to reduce complexity while maintaining responsive gesture detection.

**Architecture:** SwipeDetector moves from integrating velocity over 110ms (with armed/settle state machine) to a single-frame threshold check + cooldown. When index-tip velocity exceeds 0.5 S/frame and cooldown is expired, emit a step and set 250ms lockout. No accumulation, no decay math.

**Tech Stack:** TypeScript, Vitest, no external dependencies.

---

## File Structure

**Modify:**
- `src/gesture/swipe.ts` — SwipeDetector class (rewrite logic, remove accumulator)
- `tests/swipe.test.ts` — Update tests to match new behavior (no accumulation, simpler state)

---

## Task 1: Update SwipeDetector Tests

**Files:**
- Modify: `tests/swipe.test.ts`

- [ ] **Step 1: Replace the test file with tests for the new behavior**

The new SwipeDetector behavior:
- Fires on single frame if `|vx| > 0.5` and cooldown is 0
- Cooldown blocks subsequent frames for 250ms
- `reset()` clears cooldown
- No accumulation; no jitter cancellation (we trust MediaPipe filtering)

Replace the entire test file:

```typescript
import { describe, it, expect } from "vitest";
import { SwipeDetector } from "../src/gesture/swipe";

const DT = 16; // ~60 fps

describe("SwipeDetector", () => {
    it("fires one step on a single high-velocity frame, with correct direction", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);  // rightward, > 0.5 threshold
        const d2 = new SwipeDetector();
        expect(d2.update(-0.6, DT)).toBe(-1); // leftward
    });

    it("does not fire below threshold", () => {
        const d = new SwipeDetector();
        expect(d.update(0.3, DT)).toBe(0);  // < 0.5, no step
        expect(d.update(0.3, DT)).toBe(0);  // still < 0.5
    });

    it("cooldown blocks subsequent high-velocity frames", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);   // fires, cooldown = 250ms
        expect(d.update(0.6, DT)).toBe(0);   // blocked by cooldown (still ~234ms left)
        expect(d.update(0.6, DT)).toBe(0);   // still blocked
    });

    it("re-fires after cooldown expires", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);   // fires, cooldown = 250ms
        // Advance ~260ms (16 frames) to exceed cooldown
        for (let i = 0; i < 16; i++) {
            d.update(0, DT);
        }
        expect(d.update(0.6, DT)).toBe(1);   // cooldown expired, fires again
    });

    it("reset() clears cooldown", () => {
        const d = new SwipeDetector();
        expect(d.update(0.6, DT)).toBe(1);   // fires, cooldown = 250ms
        d.reset();
        expect(d.update(0.6, DT)).toBe(1);   // immediately fires after reset
    });

    it("direction sign is preserved and correct", () => {
        const d = new SwipeDetector();
        const r1 = d.update(0.7, DT);
        expect(r1).toBe(1);
        
        const d2 = new SwipeDetector();
        const r2 = d2.update(-0.8, DT);
        expect(r2).toBe(-1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test tests/swipe.test.ts
```

Expected: All tests fail with something like "SwipeDetector is not defined" or old implementation doesn't match new test expectations.

---

## Task 2: Implement Simplified SwipeDetector

**Files:**
- Modify: `src/gesture/swipe.ts`

- [ ] **Step 1: Rewrite the SwipeDetector class**

Replace the entire `src/gesture/swipe.ts` file with:

```typescript
// Simplified horizontal-swipe detector (SPEC §12).
//
// Direct frame-by-frame velocity threshold: if index-tip horizontal velocity
// exceeds 0.5 S/frame and cooldown is expired, emit a step. Cooldown blocks
// re-firing for 250ms, preventing one swipe from generating multiple steps.
// No accumulation, no decay math, no state machine.

// Threshold velocity (units of S per frame) to trigger a step.
const DEFAULT_SWIPE_VX = 0.5;
// Hard lockout after a step to prevent double-firing from velocity tail.
const DEFAULT_COOLDOWN_MS = 250;

export interface SwipeConfig {
    vxThreshold?: number;
    cooldownMs?: number;
}

// Exposed so tests / callers can reason about tuning.
export const SWIPE_DEFAULTS = {
    vxThreshold: DEFAULT_SWIPE_VX,
    cooldownMs: DEFAULT_COOLDOWN_MS,
} as const;

export class SwipeDetector {
    private readonly vxThreshold: number;
    private readonly cooldownMs: number;
    private cooldown = 0;

    constructor(cfg: SwipeConfig = {}) {
        this.vxThreshold = cfg.vxThreshold ?? DEFAULT_SWIPE_VX;
        this.cooldownMs = cfg.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    }

    /**
     * Advance one frame with the current per-frame horizontal velocity `vx`
     * (units of S per frame, e.g. from classify().vx) and the frame delta `dtMs`.
     * Returns +1 for a committed rightward swipe, -1 for leftward, 0 for no step.
     */
    update(vx: number, dtMs: number): -1 | 0 | 1 {
        if (this.cooldown > 0) {
            this.cooldown = Math.max(0, this.cooldown - dtMs);
        }

        if (Math.abs(vx) > this.vxThreshold && this.cooldown === 0) {
            this.cooldown = this.cooldownMs;
            return vx > 0 ? 1 : -1;
        }

        return 0;
    }

    /** Clear all state when the driving hand is lost. */
    reset(): void {
        this.cooldown = 0;
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm test tests/swipe.test.ts
```

Expected: All 6 tests pass.

- [ ] **Step 3: Run the full test suite to ensure no regressions**

```bash
pnpm test
```

Expected: No new failures (other tests should be unaffected since the SwipeDetector interface is unchanged).

- [ ] **Step 4: Verify TypeScript compiles**

```bash
pnpm typecheck
```

Expected: No errors.

---

## Task 3: Verify Integration with Carousel

**Files:**
- Reference (no changes): `src/menu/carousel.ts`
- Reference (no changes): `src/gesture/detect.ts`

- [ ] **Step 1: Verify carousel still compiles and runs**

The carousel's usage of `SwipeDetector` is unchanged:
```typescript
const dir = this.swipe.update(g.vx, dtMs);
if (dir !== 0) this.step(dir > 0 ? -1 : 1);
```

This still works because:
- `update(vx, dtMs)` signature is identical
- Return type `-1 | 0 | 1` is identical
- Carousel logic (invert the sign for visual direction) is unchanged

Run a quick smoke test:

```bash
pnpm build
```

Expected: No errors related to swipe or carousel.

---

## Task 4: Commit

**Files:**
- Modify: `src/gesture/swipe.ts`
- Modify: `tests/swipe.test.ts`

- [ ] **Step 1: Stage and commit changes**

```bash
git add src/gesture/swipe.ts tests/swipe.test.ts
git commit -m "Simplify SwipeDetector: direct velocity threshold + cooldown

- Replace leaky accumulator (tau=110ms, settle threshold) with single-frame
  velocity check
- Keep simple state: cooldown only (250ms lockout after each step)
- If |vx| > 0.5 S/frame and cooldown expired, emit step
- Remove constants: TAU_MS, DEFAULT_DISTANCE, DEFAULT_SETTLE
- Update tests to reflect no-accumulation behavior
- Carousel integration unchanged (same interface)"
```

Expected: Commit succeeds.

---

## Self-Review Checklist

✓ **Spec coverage:**
- Spec §Implementation Details: ✓ Rewrite SwipeDetector with direct threshold check
- Spec §Carousel Integration: ✓ Task 3 verifies no carousel changes needed
- Spec §Testing: ✓ Task 1 & 2 update tests for new behavior
- Spec §Tuning Knobs: ✓ SWIPE_DEFAULTS exposed for future adjustment

✓ **Placeholder scan:** No "TBD", "TODO", "implement later". All code is complete.

✓ **Type consistency:** 
- `update()` signature unchanged: `(vx: number, dtMs: number) → -1 | 0 | 1`
- `vxThreshold` in constructor and used in `update()` logic ✓
- `cooldownMs` defined and used consistently ✓

✓ **Scope fit:** Single focused change to SwipeDetector, one test file update. No unrelated refactoring.
