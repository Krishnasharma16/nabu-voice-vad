# NABU Render Voice Server — Local Silero VAD

This is a Render-ready Node.js WebSocket server for NABU.

Architecture:
ESP32 -> WSS -> Render Node.js -> local Silero VAD -> Gemini Live -> WSS -> ESP32

No Cloudflare Smart Turn and no Deepgram Flux are used.

## Render settings
Runtime: Node
Build Command: npm ci && npm run download-model
Start Command: npm start
Health Check Path: /health

Environment variables:
GEMINI_API_KEY = your Gemini API key
GEMINI_MODEL = models/gemini-3.1-flash-live-preview

The server downloads the Silero VAD ONNX model during the Render build and runs inference locally on the Render instance.

## WebSocket
ESP32 connects to:
wss://YOUR-SERVICE.onrender.com/live

The existing NABU JSON protocol is retained:
start
audio {data: base64 PCM16 16kHz}
stop

Server messages include:
connected
ready
listening
speech_start
thinking
assistant_start
audio {data: base64}
assistant_end
continue_listening
stop_listening
error

## Notes
Voice audio is not stored by this application.
The server does not write voice audio to D1.
