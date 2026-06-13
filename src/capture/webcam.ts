// Webcam acquisition: request a front-facing camera at 720p (SPEC §12.2),
// fall back to 640x480 if the device can't satisfy it, and return a playing
// <video> the landmarker can detect on.

// Request the user camera and resolve once the returned <video> is actually
// playing. Tries `width`x`height` first (default 720p), falls back to 640x480.
export async function startWebcam(width = 1280, height = 720): Promise<HTMLVideoElement> {
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;

    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: width }, height: { ideal: height } },
        });
    } catch {
        // Permission may still be granted but the resolution unsupported — retry at VGA.
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        });
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
