import type { Landmark, GestureState } from "../types";
const TIPS = [8, 12, 16, 20], PIPS = [6, 10, 14, 18];
const d = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);

export function handScale(lm: Landmark[]): number { return d(lm[0], lm[9]) || 1e-3; }
export function palmCenter(lm: Landmark[]) {
    const ids = [0, 5, 9, 13, 17]; let x = 0, y = 0;
    for (const i of ids) { x += lm[i].x; y += lm[i].y; }
    return { x: x / ids.length, y: y / ids.length };
}
export function pinchAmount(lm: Landmark[]): number {
    const s = handScale(lm); const raw = d(lm[4], lm[8]) / s; // ~0.1 closed .. ~0.9 open
    return Math.min(1, Math.max(0, 1 - (raw - 0.1) / 0.5));
}
export function fingerSpread(lm: Landmark[]): number {
    const s = handScale(lm);
    const a = d(lm[8], lm[12]) + d(lm[12], lm[16]) + d(lm[16], lm[20]);
    return (a / 3) / s; // normalized; high=open, low=squished
}
function extendedCount(lm: Landmark[]): number {
    const w = lm[0]; let n = 0;
    for (let i = 0; i < 4; i++) if (d(lm[TIPS[i]], w) > d(lm[PIPS[i]], w) * 1.10) n++;
    return n;
}
export function classify(lm: Landmark[] | null): GestureState {
    if (!lm) return { name: "none", extended: 0, pinch: 0, spread: 0 };
    const w = lm[0]; const extended = extendedCount(lm);
    const pinch = pinchAmount(lm); const spread = fingerSpread(lm);
    const idxOut = d(lm[8], w) > d(lm[6], w) * 1.1;
    const midOut = d(lm[12], w) > d(lm[10], w) * 1.1;
    const thumbOut = d(lm[4], w) > d(lm[2], w) * 1.05;
    let name: GestureState["name"] = "other" as any;
    if (extended <= 0) name = "fist";
    else if (extended >= 3) name = "open";
    else if (extended === 1 && idxOut) name = "point";
    if (extended === 2 && idxOut && midOut) name = "peace";
    if (extended === 1 && idxOut && thumbOut) name = "gun";
    if (pinch > 0.7 && name !== "open") name = "pinch";
    return { name: name as GestureState["name"], extended, pinch, spread };
}
