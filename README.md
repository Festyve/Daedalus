# Daedalus

> Shape matter with your bare hands. No mouse. No tablet. No headset.
> Just a webcam, two hands, and the ghost of a god who built wings from wax.

Daedalus is a browser-based, real-time 3D sculptor controlled entirely by webcam
hand tracking. The **left hand** navigates a holographic tool carousel; the
**right hand** executes the active tool. The whole interface is designed to feel
like reaching into one of Tony Stark's holograms — translucent panels, instant
response, weightless geometry.

Built for **JAMHacks 10**.

## How it works

A webcam feed is fed through [MediaPipe Tasks Vision](https://developers.google.com/mediapipe)
for hand landmark detection. Gestures are smoothed (One-Euro filter), classified
by a gesture state machine, and routed to a sculpt engine that deforms a live
[Three.js](https://threejs.org) mesh (accelerated by
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)). Everything you see
is computed at runtime — every brush stroke, every menu, every morph.

**Two view modes**, toggled by a single bilateral "parting curtains" gesture:

- **Scene mode** (default) — pure dark canvas, object + holographic menus only.
- **AR mode** — live webcam feed as the background; the object floats in the real world.

## Requirements

- A modern WebGL2 browser with **webcam access**
- [Node.js](https://nodejs.org) (developed on v20+; works on current releases)
- npm (or pnpm — a `pnpm-lock.yaml` is also committed)

## Getting started

```bash
npm install
npm run dev
```

Then open the printed URL (default <http://localhost:5173>) and grant camera
access when prompted. Start in Scene mode, raise your hands into frame, and the
tool carousel appears.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server with hot reload |
| `npm run build` | Type-check (`tsc --noEmit`) then build for production |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the test suite ([Vitest](https://vitest.dev)) |
| `npm run typecheck` | Type-check only |

## Configuration

Voice-driven decoration uses a scripted fallback by default. To enable the live
[ElevenLabs](https://elevenlabs.io) Conversational AI path, provide:

```bash
# .env
VITE_ELEVENLABS_AGENT_ID=your_agent_id
```

If unset, decoration falls back to a deterministic reply with browser
`SpeechSynthesis` TTS — no other changes needed.

## Project layout

```
src/
  capture/    webcam input
  tracking/   MediaPipe landmarks, One-Euro smoothing, live/mock input sources
  gesture/    gesture detection, predicates, and state machine
  menu/       tool carousel and spatial menus (rotate, dilate, morph, translate…)
  sculpt/     deformation engine and brushes
  render/     Three.js scene, geometry, shaders/post, view-mode toggle
  decorate/   icing, sprinkles, voice interface, chat panel
  core/       director, main loop, store
  math/       coordinate transforms
  ui/         dev overlay and chrome
  audio/      sound effects
```

## Documentation

- [`SPEC.md`](SPEC.md) — full technical specification (the source of truth)
- [`TODO.md`](TODO.md) — living, cross-session checklist
- [`CLAUDE.md`](CLAUDE.md) — coding guidelines for contributors

## Stack

Three.js (WebGL2) · MediaPipe Tasks Vision · three-mesh-bvh · Vite · TypeScript ·
Vitest · ElevenLabs · Web Speech API
