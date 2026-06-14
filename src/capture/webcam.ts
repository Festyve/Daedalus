// Webcam acquisition: request a front-facing camera at 720p (SPEC §12.2),
// fall back to 640x480 if the device can't satisfy it, and return a playing
// <video> the landmarker can detect on.
//
// The same <video> is ALSO the on-screen camera background: it is appended to the DOM
// as #camera, a full-screen layer BEHIND the transparent WebGL canvas (styles.css), so
// the live feed renders untouched by the three.js post-processing (bloom / tone map) —
// it stays a normal, crisp colour image. It is mirrored (CSS scaleX(-1)) to the selfie
// orientation the landmarks use, so the green hand skeletons land on the real hands.

// Request the user camera and resolve once the returned <video> is actually
// playing. Tries `width`x`height` first (default 720p), falls back to 640x480.
// Timeout after 10s if the device doesn't respond (protects against hung camera drivers).
const GET_USER_MEDIA_TIMEOUT_MS = 10000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}

export async function startWebcam(width = 1280, height = 720): Promise<HTMLVideoElement> {
    const existing = document.getElementById("camera");
    if (existing) existing.remove();
    const video = document.createElement("video");
    video.id = "camera";
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    // Hidden until the view-mode controller decides AR vs scene; shown in AR mode.
    video.style.display = "none";
    document.body.appendChild(video);

    let stream: MediaStream;
    try {
        stream = await withTimeout(
            navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user", width: { ideal: width }, height: { ideal: height } },
            }),
            GET_USER_MEDIA_TIMEOUT_MS
        );
    } catch {
        // Permission may still be granted but the resolution unsupported — retry at VGA.
        stream = await withTimeout(
            navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
            }),
            GET_USER_MEDIA_TIMEOUT_MS
        );
    }

    video.srcObject = stream;
    await video.play();
    // On some browsers play() resolves before dimensions are known; wait for them.
    if (!video.videoWidth || !video.videoHeight) {
        await new Promise<void>((resolve) => {
            video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        });
    }
    return video;
}
