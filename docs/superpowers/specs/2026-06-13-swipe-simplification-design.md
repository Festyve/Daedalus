# Simplified Swipe Detection Design

**Date:** 2026-06-13  
**Status:** Approved  
**Goal:** Replace the leaky-integrator SwipeDetector with a simpler direct-velocity-threshold approach for easier maintenance and understanding.

## Current State

The `SwipeDetector` class uses a leaky accumulator (τ=110ms) with three tuning parameters:
- `distance`: 0.42 S (magnitude to trigger a step)
- `cooldown`: 260ms (hard lockout after commit)
- `settle`: 0.12 S (re-arm threshold)

This requires understanding exponential decay, state machines (armed/cooldown), and cross-parameter interactions. Works well, but complex.

## Index Finger Velocity Baseline

The `classify()` function in `gesture/detect.ts` already computes clean index-tip horizontal velocity:

```typescript
vx = (lm[INDEX_TIP].x - prevLm[INDEX_TIP].x) / imageScale(lm);
```

Frame-to-frame delta, normalized by hand scale. Already fed to `SwipeDetector` as-is.

## Simplified Approach

**Direct velocity threshold + cooldown (no accumulation):**

Each frame:
1. If `|vx| > SWIPE_VX` (velocity exceeds threshold) AND cooldown is expired:
   - Emit step in the direction of `vx`: `return sign(vx)`
   - Set cooldown to `COOLDOWN_MS`
2. Otherwise:
   - Return 0 (no step this frame)
3. Decrement cooldown each frame by `dtMs`
4. `reset()` clears state when hand is lost

**Rationale:**
- `vx` is already per-frame velocity; single frame of high velocity = intentional swipe
- MediaPipe hand tracking has built-in filtering, so jitter is minimal
- Cooldown prevents one swipe from generating multiple steps
- No accumulation math, no decay constant, no settle threshold

## Implementation Details

**SwipeDetector class:**
- Remove fields: `net`, `armed`, `decay` calculation
- Keep fields: `cooldown`
- Remove constants: `TAU_MS`, `DEFAULT_SETTLE`
- Keep/rename constants:
  - `DEFAULT_DISTANCE` → `DEFAULT_SWIPE_VX = 0.5` (units of S/frame)
  - `DEFAULT_COOLDOWN_MS = 250` (reduced from 260)

**Update signature:** unchanged
```typescript
update(vx: number, dtMs: number): -1 | 0 | 1
```

**Logic:**
```typescript
update(vx: number, dtMs: number): -1 | 0 | 1 {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dtMs);
    
    if (Math.abs(vx) > this.SWIPE_VX && this.cooldown === 0) {
        this.cooldown = this.COOLDOWN_MS;
        return vx > 0 ? 1 : -1;
    }
    return 0;
}
```

## Carousel Integration

No changes needed:
- Carousel calls `swipe.update(g.vx, dtMs)` and gets back `-1 | 0 | 1`
- Same semantics, same result type
- Carousel's 100ms snap animation still drives the visual feedback

## Testing

**Unit tests for SwipeDetector:**
1. Frame with vx=0.6 → should return sign(0.6) = 1, cooldown set
2. Next frame with same vx → should return 0 (cooldown active)
3. After 250ms, vx=0.6 again → should return 1 (cooldown expired)
4. `reset()` → clears cooldown
5. Low velocity (0.3) → always returns 0

**Integration:**
- Carousel responds to hand flicks with one step per swipe
- No phantom double-steps from velocity tail
- Rapid flicks (>250ms apart) register as separate steps

## Tuning Knobs

If real-world testing shows issues:
- `SWIPE_VX = 0.5` — increase if too sensitive to accidental motion, decrease if too hard to trigger
- `COOLDOWN_MS = 250` — adjust based on desired swipe frequency (faster user = lower cooldown)

Single layer of tuning, not multi-parameter interactions.
