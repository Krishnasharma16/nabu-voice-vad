# NABU Render V3

Realtime Silero VAD server for NABU.

Important V3 fix: Node `ws` text messages arrive as Buffer by default. V2 discarded those packets, so the server never processed ESP32 audio. V3 converts text Buffers to UTF-8 before JSON parsing.

Build: `npm install`
Start: `npm start`
Health: `/health`
WebSocket: `/live`

Environment:
- `GEMINI_API_KEY` required
- `GEMINI_MODEL` optional

VAD uses `@ericedouard/vad-node-realtime` (Silero) locally on the Render instance; no Cloudflare Smart Turn or Deepgram Flux is used.
