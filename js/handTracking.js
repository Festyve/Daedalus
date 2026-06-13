// Hand tracking: webcam → MediaPipe HandLandmarker → EMA-smoothed landmarks,
// plus the mirrored preview with a skeleton overlay.
//
// The camera frame is mirrored (selfie) for BOTH detection and display, so the
// handedness labels read intuitively (your left hand == "Left") and the overlay
// landmarks line up with the preview without any extra flipping.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.12/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const EMA = 0.5; // smoothing factor: blend this much of the previous frame

// pairs of landmark indices that form the hand skeleton, for the overlay
const CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
];

export class HandTracking {
    constructor(previewCanvas) {
        this.canvas = previewCanvas;
        this.ctx = previewCanvas.getContext('2d');
        this.video = document.createElement('video');
        this.video.playsInline = true;
        this.video.muted = true;
        this.landmarker = null;
        this.lastTs = -1;
        this.smoothed = { Left: null, Right: null };
        this.ready = false;
    }

    async init() {
        // request the camera first so permission failures surface distinctly
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: 640, height: 480 },
        });
        this.video.srcObject = stream;
        await this.video.play();
        const w = this.video.videoWidth || 640;
        const h = this.video.videoHeight || 480;
        this.canvas.width = w;
        this.canvas.height = h;

        const fileset = await FilesetResolver.forVisionTasks(WASM);
        this.landmarker = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numHands: 2,
        });
        this.ready = true;
    }

    // Run one detection. Returns { Left, Right, count }, where each hand is
    // { landmarks } in mirrored-normalized [0..1] coords (or null if absent).
    update() {
        if (!this.ready) return { Left: null, Right: null, count: 0 };
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;

        // draw the mirrored frame; this canvas is both what we detect on and what
        // we show in the corner
        ctx.save();
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(this.video, 0, 0, w, h);
        ctx.restore();

        let ts = performance.now();
        if (ts <= this.lastTs) ts = this.lastTs + 1; // timestamps must increase
        this.lastTs = ts;
        const res = this.landmarker.detectForVideo(this.canvas, ts);

        const out = { Left: null, Right: null, count: 0 };
        if (res && res.landmarks) {
            out.count = res.landmarks.length;
            for (let i = 0; i < res.landmarks.length; i++) {
                const label = res.handedness?.[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
                out[label] = { landmarks: this._smooth(label, res.landmarks[i]) };
            }
        }
        // drop hands that disappeared so the EMA restarts cleanly next time
        for (const k of ['Left', 'Right']) if (!out[k]) this.smoothed[k] = null;

        this._drawOverlay(out, w, h);
        return out;
    }

    _smooth(label, lm) {
        const prev = this.smoothed[label];
        if (!prev) {
            const copy = lm.map((p) => ({ x: p.x, y: p.y, z: p.z }));
            this.smoothed[label] = copy;
            return copy;
        }
        for (let i = 0; i < lm.length; i++) {
            prev[i].x = EMA * prev[i].x + (1 - EMA) * lm[i].x;
            prev[i].y = EMA * prev[i].y + (1 - EMA) * lm[i].y;
            prev[i].z = EMA * prev[i].z + (1 - EMA) * lm[i].z;
        }
        return prev;
    }

    _drawOverlay(hands, w, h) {
        const ctx = this.ctx;
        for (const k of ['Left', 'Right']) {
            const hand = hands[k];
            if (!hand) continue;
            const lm = hand.landmarks;
            const col = k === 'Left' ? '#5fd0ff' : '#ffd35f';
            ctx.strokeStyle = col;
            ctx.lineWidth = 2;
            for (const [a, b] of CONNECTIONS) {
                ctx.beginPath();
                ctx.moveTo(lm[a].x * w, lm[a].y * h);
                ctx.lineTo(lm[b].x * w, lm[b].y * h);
                ctx.stroke();
            }
            ctx.fillStyle = col;
            for (const p of lm) {
                ctx.beginPath();
                ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}
