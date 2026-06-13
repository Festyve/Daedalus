# public/ — vendored runtime assets

Static assets served from the Vite `public/` root (referenced by absolute `/path` URLs).
Vendored best-effort on 2026-06-13. All three primary asset goals landed; none pending.

## Landed

### models/hand_landmarker.task  (7.45 MB)
MediaPipe hand-landmarker model (float16/1). Used by `src/tracking/liveInput.ts`,
which prefers the local `/models/hand_landmarker.task` and falls back to the
MediaPipe CDN (`storage.googleapis.com/mediapipe-models/.../hand_landmarker.task`)
if absent. Local copy = offline / faster cold start.
- Source: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- Format: zip-bundled `.task` (verified `PK` magic).
- License: Apache-2.0 (Google MediaPipe).

### matcaps/blue-steel.png  (256x256 RGB PNG)
Cool blue-steel matcap for the sculptable mesh (§9.2). `src/render/scene.ts`
loads `/matcaps/blue-steel.png` and upgrades the procedural fallback in place;
if this PNG is missing it keeps a procedurally generated blue-steel gradient,
so the build is offline-safe either way.
- Source: nidorx/matcaps — `256/070B0C_B2C7CE_728FA3_5B748B-256px.png`
  (https://github.com/nidorx/matcaps), chosen for its dark base + cool
  blue-gray (B2C7CE) highlight and steel mid-tones.
- License: matcaps in that repo are CC0 / freely usable (see repo README).
- Note: the task's guessed example filename 404'd; this is a real file from the
  repo's `256/` listing picked for the closest blue-steel tone.

## Synthesized at runtime (intentionally empty)

### sfx/
Directory only. SFX (ping / hum / ding) are synthesized procedurally via WebAudio
in `src/audio/sfx.ts`; `.wav` files are optional and not required for the build.
Drop `ping.wav` / `hum.wav` / `ding.wav` here only if pre-rendered audio is wanted.

## Not vendored here (out of scope for this pass)
- `fonts/JetBrainsMono.woff2` — currently loaded via Google Fonts CDN (acceptable;
  vendor only if a fully-offline demo is needed). Tracked in repo-root TODO.md.

## Pending
None — both downloadable assets succeeded and `sfx/` is correctly left empty.
