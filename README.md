# NABU Smart VAD V4

Render WebSocket voice server using Silero VAD and Gemini Live.

V4 changes:
- Decouples WebSocket ingestion from Silero inference.
- Feeds Silero 512-sample / 32 ms frames at 16 kHz.
- Uses a bounded realtime queue for Render Free CPU limits.
- Adds a 1.4 second low-energy safety end-of-turn fallback after speech starts.
- Gemini automatic VAD remains disabled; Silero controls turn boundaries.
