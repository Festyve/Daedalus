// Gesture detection: pure geometry over the 21 landmarks (0 = wrist; finger tips
// are 4/8/12/16/20). All thresholds are normalised by hand size so they hold at
// any distance from the camera.

const TIPS = [8, 12, 16, 20]; // index, middle, ring, pinky tips
const PIPS = [6, 10, 14, 18]; // their middle joints

function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// Count extended (non-thumb) fingers and name the pose. A finger is "extended"
// when its tip is meaningfully farther from the wrist than its PIP joint.
export function classify(lm) {
    if (!lm) return { name: 'none', extended: 0 };
    const wrist = lm[0];
    let extended = 0;
    for (let i = 0; i < 4; i++) {
        if (dist(lm[TIPS[i]], wrist) > dist(lm[PIPS[i]], wrist) * 1.10) extended++;
    }
    const handSize = dist(lm[0], lm[9]) || 1e-3;
    const pinch = dist(lm[4], lm[8]) / handSize < 0.45;

    let name = 'other';
    if (extended <= 0) name = 'fist';
    else if (extended >= 3) name = 'open';
    else if (extended === 1 && dist(lm[8], wrist) > dist(lm[6], wrist) * 1.1) name = 'point';
    if (pinch && name !== 'open') name = 'pinch';

    return { name, extended, pinch };
}

// Average of the palm landmarks — a stable hand "center" for two-hand math.
export function palmCenter(lm) {
    const ids = [0, 5, 9, 13, 17];
    let x = 0;
    let y = 0;
    for (const i of ids) {
        x += lm[i].x;
        y += lm[i].y;
    }
    return { x: x / ids.length, y: y / ids.length };
}

// Fires once when a candidate pose has been held for `hold` consecutive frames,
// then re-arms only after the pose is released. This is the discrete-gesture
// debounce that stops booleans/smoothing from firing on a stray twitch.
export class DiscreteTrigger {
    constructor(hold = 9) {
        this.hold = hold;
        this.count = 0;
        this.armed = true;
    }

    update(candidate) {
        if (!candidate) {
            this.count = 0;
            this.armed = true;
            return false;
        }
        if (!this.armed) return false;
        this.count++;
        if (this.count >= this.hold) {
            this.armed = false;
            this.count = 0;
            return true;
        }
        return false;
    }
}
