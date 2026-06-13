// Deterministic wave dealer for Phase 8. No RNG. Greedy load-balance with no-wrap
// (each file's aspects land in CONSECUTIVE waves in priority order → foundational first).
const NW = 11;

// owner file -> ordered aspect numbers (priority order; index 0 lands earliest)
const FILES = [
    ["src/menu/carousel.ts",        [32, 22, 2, 1, 15, 31, 33, 34, 35, 38, 39]],
    ["src/render/scene.ts",         [19, 20, 29, 24, 84, 85, 88, 90, 97, 14, 56]],
    ["src/decorate/chatPanel.ts",   [27, 64, 63, 65, 51, 99, 68]],
    ["src/audio/sfx.ts",            [69, 55, 70, 72, 71, 73, 74]],
    ["src/ui/chrome.ts",            [78, 28, 77, 80, 57, 13, 100]],
    ["src/render/post.ts",          [16, 17, 18, 58, 86, 30]],
    ["src/menu/morph.ts",           [5, 48, 53, 54, 49, 50]],
    ["src/render/viewMode.ts",      [95, 4, 25, 91, 93, 94]],
    ["src/menu/panel.ts",           [3, 23, 40, 37, 98]],
    ["src/ui/instructionsPopout.ts",[75, 76, 26, 81]],
    ["src/menu/addShapes.ts",       [11, 42, 41, 52]],
    ["src/main.ts",                 [83, 87, 89, 96]],
    ["src/decorate/sprinkles.ts",   [61, 62, 12]],   // 61 = decoration-visibility, force wave 1
    ["src/menu/dilate.ts",          [7, 44, 45]],
    ["src/menu/rotate.ts",          [8, 46, 47]],
    ["src/render/overlay.ts",       [82, 92]],
    ["src/decorate/icing.ts",       [59, 60]],        // 59 = decoration-visibility, force wave 1
    ["src/decorate/voice.ts",       [66, 67]],
    ["src/menu/translate.ts",       [6, 43]],
    ["src/render/tokens.ts",        [21]],
    ["src/menu/menuRouter.ts",      [36]],
    ["src/core/loop.ts",            [9]],
    ["src/tracking/oneEuro.ts",     [10]],
    ["src/ui/devOverlay.ts",        [79]],
];

const FORCE_START_0 = new Set(["src/decorate/icing.ts", "src/decorate/sprinkles.ts"]);

// column load per wave as we place files
const load = new Array(NW).fill(0);
const waves = Array.from({ length: NW }, () => []); // wave -> [{file, n}]

// place biggest files first for better balance
const order = [...FILES].sort((a, b) => b[1].length - a[1].length);

for (const [file, aspects] of order) {
    const k = aspects.length;
    const maxStart = NW - k; // no-wrap
    let bestStart = 0, bestScore = Infinity;
    const candidates = FORCE_START_0.has(file) ? [0] : [...Array(maxStart + 1).keys()];
    for (const s of candidates) {
        // score = resulting max column load over the span (then total) -> minimize peaks
        let peak = 0, sum = 0;
        for (let j = 0; j < k; j++) { const w = s + j; const v = load[w] + 1; peak = Math.max(peak, v); sum += load[w]; }
        const score = peak * 1000 + sum; // prefer lower peak, tie-break lower existing sum
        if (score < bestScore) { bestScore = score; bestStart = s; }
    }
    for (let j = 0; j < k; j++) { const w = bestStart + j; load[w]++; waves[w].push({ file, n: aspects[j] }); }
}

// ---- validate ----
let ok = true;
const seen = new Set();
waves.forEach((w, i) => {
    const files = new Set();
    for (const { file, n } of w) {
        if (files.has(file)) { console.log(`!! DUP FILE in wave ${i + 1}: ${file}`); ok = false; }
        files.add(file);
        if (seen.has(n)) { console.log(`!! DUP ASPECT ${n}`); ok = false; }
        seen.add(n);
    }
});
const total = [...seen].length;
const w1 = new Set(waves[0].map((x) => x.n));
if (!w1.has(59) || !w1.has(61)) { console.log("!! decoration 59/61 not both in wave 1"); ok = false; }
if (total !== 100) { console.log(`!! coverage ${total}/100`); ok = false; }

console.log(`\nWAVES (NW=${NW})  total=${total}  ok=${ok}`);
waves.forEach((w, i) => {
    console.log(`\nWave ${i + 1} (${w.length} agents):`);
    for (const { file, n } of w) console.log(`   #${String(n).padStart(3)}  ${file}`);
});
console.log("\nper-wave counts:", load.join(", "));
