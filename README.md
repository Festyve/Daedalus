# Daedalus

An interactive 3D art experience combining hand gesture tracking, voice interaction, and real-time AI responses. Decorate a dynamic 3D mesh with voice-triggered icing and hand-painted sprinkles.

## Features

- **Voice-Driven Decoration**: Speak to trigger AI-matched icing designs and instant mesh decoration
- **Hand Gesture Tracking**: MediaPipe-powered hand tracking with pinch and smear gestures
- **Real-Time 3D Rendering**: Three.js-based 3D visualization with dynamic mesh manipulation
- **Live Chat Panel**: Typewritten AI responses with TTS (text-to-speech) support
- **Gesture Commands**: 
  - Open-hand smear → paint icing under your fingertip
  - Pinch gesture → drop sprinkles on the iced surface
- **Flavor Detection**: Voice transcripts automatically map to icing colors (chocolate, blueberry, lemon, matcha, grape, etc.)

## Getting Started

### Prerequisites
- Modern browser with WebGL and Web Speech API support
- Webcam for hand gesture tracking
- Microphone for voice input

### Install & Run

```bash
npm install
npm run dev
```

Build for production:
```bash
npm run build
```

## Architecture

- **3D Rendering**: Three.js with BVH acceleration for efficient mesh decoration
- **Hand Tracking**: MediaPipe Pose/Hands for gesture classification
- **Chat UI**: Plain DOM chat panel with real-time typewriter animation
- **Voice Pipeline**: Web Speech API transcript → AI response streaming → TTS playback
- **Mesh State**: Persistent icing color attributes and instanced sprinkle meshes

## Tech Stack

- TypeScript
- Three.js (3D graphics)
- Vite (build tool)
- MediaPipe (hand tracking)
- Web Speech API (voice input)
- Web Audio API (TTS)
