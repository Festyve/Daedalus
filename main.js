// Orchestration: wire tracking → gestures → modeling → render, drive the
// sphere → disc → bored → torus flow, and provide keyboard / window fallbacks
// so the modeling pipeline is usable (and verifiable) without a camera.
import { SceneManager } from './js/scene.js';
import { HandTracking } from './js/handTracking.js';
import { classify, palmCenter, DiscreteTrigger } from './js/gestures.js';
import { Modeler } from './js/modeling.js';
import { UI } from './js/ui.js';

const scene = new SceneManager();
const modeler = new Modeler(scene.mesh);
const ui = new UI();
const tracker = new HandTracking(document.getElementById('preview'));

// stage gates each destructive op so it can only happen at the right moment
let stage = 'SPHERE'; // SPHERE → DISC → BORED → TORUS
const squashTrig = new DiscreteTrigger(9);
const boreTrig = new DiscreteTrigger(9);
const smoothTrig = new DiscreteTrigger(9);

const SCALE_MIN = 0.6;
const SCALE_MAX = 1.9;
const SCALE_DEAD = 0.01; // deadzone: ignore sub-threshold scale changes
let curScale = 1;

function doSquash() { if (stage === 'SPHERE') { modeler.squash(); stage = 'DISC'; } }
function doBore() { if (stage === 'DISC') { modeler.bore(); stage = 'BORED'; } }
function doSmooth() { if (stage === 'BORED') { modeler.smooth(); stage = 'TORUS'; } }
function doReset() { modeler.reset(); stage = 'SPHERE'; curScale = 1; }
function setScale(s) { curScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, s)); modeler.scaleTo(curScale); }

// keyboard fallbacks (also handy on stage during a live demo)
addEventListener('keydown', (e) => {
    switch (e.key) {
        case 's': doSquash(); break;
        case 'b': doBore(); break;
        case 'm': doSmooth(); break;
        case 'r': doReset(); break;
        case 'o': scene.controls.enabled = !scene.controls.enabled; break;
        case 'h': ui.toggleInstructions(); break;
        case '[': setScale(curScale - 0.15); break;
        case ']': setScale(curScale + 0.15); break;
    }
});

// tiny debug API so the pipeline can be driven programmatically (no camera)
window.HS = {
    squash: doSquash,
    bore: doBore,
    smooth: doSmooth,
    reset: doReset,
    scaleTo: setScale,
    stats: () => {
        const g = scene.mesh.geometry;
        g.computeBoundingBox();
        return {
            stage,
            verts: g.attributes.position.count,
            scale: scene.mesh.scale.toArray().map((v) => +v.toFixed(3)),
            min: g.boundingBox.min.toArray().map((v) => +v.toFixed(3)),
            max: g.boundingBox.max.toArray().map((v) => +v.toFixed(3)),
        };
    },
};

let last = performance.now();
let noHandsSince = 0;

function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const hands = tracker.update();
    const L = hands.Left ? hands.Left.landmarks : null;
    const R = hands.Right ? hands.Right.landmarks : null;
    const gL = classify(L);
    const gR = classify(R);

    // clutch = left fist; gates the continuous scale edit
    const clutch = gL.name === 'fist';
    if (clutch && R) {
        const c = palmCenter(R);
        const t = Math.min(1, Math.max(0, (1 - c.y - 0.1) / 0.8)); // hand up → 1
        const target = SCALE_MIN + t * (SCALE_MAX - SCALE_MIN);
        if (Math.abs(target - curScale) > SCALE_DEAD) setScale(target);
    }

    // discrete ops: both hands open, distinguished by spread, gated by stage
    const bothOpen = gL.name === 'open' && gR.name === 'open';
    let dx = 0;
    let dy = 0;
    if (L && R) {
        const cl = palmCenter(L);
        const cr = palmCenter(R);
        dx = Math.abs(cr.x - cl.x);
        dy = Math.abs(cr.y - cl.y);
    }
    const wideApart = dx > dy * 1.4 && dx > 0.30;          // bore: pull apart
    const together = Math.hypot(dx, dy) < 0.18;            // smooth: bring together

    if (squashTrig.update(stage === 'SPHERE' && bothOpen)) doSquash();
    if (boreTrig.update(stage === 'DISC' && bothOpen && wideApart)) doBore();
    if (smoothTrig.update(stage === 'BORED' && bothOpen && together)) doSmooth();

    modeler.tick(dt);
    scene.render(dt, stage === 'TORUS'); // spin to show off once it's a donut

    ui.update({
        left: L ? gL.name : '—',
        right: R ? gR.name : '—',
        clutch,
        stage,
    });

    // "no hands" hint, but only once tracking is actually running
    if (tracker.ready) {
        if (hands.count === 0) {
            if (!noHandsSince) noHandsSince = now;
            if (now - noHandsSince > 1200) ui.showBanner('No hands detected — show your hands to the camera');
        } else {
            noHandsSince = 0;
            ui.hideBanner();
        }
    }
}

(async function start() {
    try {
        await tracker.init();
        ui.hideBanner();
    } catch (err) {
        const msg = err && err.name === 'NotAllowedError'
            ? 'Camera permission denied — allow it and reload. (Keyboard: [ ] S B M R still work.)'
            : 'Camera unavailable: ' + (err?.message || err) + ' (Keyboard: [ ] S B M R still work.)';
        ui.showBanner(msg);
    }
    loop();
})();
