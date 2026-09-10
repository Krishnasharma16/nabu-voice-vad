
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { RealtimeVAD } from "@toma.com/vad";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-3.1-flash-live-preview";
const VAD_MODEL = process.env.VAD_MODEL || path.join(__dirname, "models", "silero_vad.onnx");

if (!GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not configured.");
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, {"content-type": "application/json"});
    res.end(JSON.stringify({
      status: "online",
      service: "NABU Render Voice Server",
      vad: "Silero VAD v5",
      gemini: Boolean(GEMINI_API_KEY),
      websocket: "/live"
    }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/live") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

function b64ToBuffer(s) {
  return Buffer.from(s, "base64");
}
function bufferToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

class NabuSession {
  constructor(client) {
    this.client = client;
    this.gemini = null;
    this.geminiReady = false;
    this.responseStarted = false;
    this.waitingForResponse = false;
    this.speaking = false;
    this.turnActive = false;
    this.sessionStarted = false;
    this.transcript = "";
    this.vad = null;
    this.vadSpeaking = false;
    this.lastVadState = false;
    this.endTimer = null;
    this.maxTurnTimer = null;
    this.destroyed = false;
  }

  send(obj) {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(obj));
    }
  }

  async start() {
    try {
      this.vad = new RealtimeVAD({
        modelPath: VAD_MODEL,
        format: "pcm_16000",
        frameDurationMs: 80,
        inputs: [{
          label: "speech",
          positiveSpeechThreshold: 0.55,
          negativeSpeechThreshold: 0.25,
          lookbackFrames: 5,
        }],
      });
      await this.openGemini();
      if (this.destroyed) return;
      this.send({type: "ready"});
    } catch (err) {
      console.error("Session start error:", err);
      this.send({type: "error", message: `Voice server startup failed: ${err.message}`});
    }
  }

  async openGemini() {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      "?key=" + encodeURIComponent(GEMINI_API_KEY);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;

      const fail = (e) => {
        if (!settled) { settled = true; reject(e); }
      };

      ws.on("open", () => {
        this.gemini = ws;
        ws.send(JSON.stringify({
          setup: {
            model: GEMINI_MODEL,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Kore" }
                }
              }
            },
            systemInstruction: {
              parts: [{text: `
You are NABU, a natural personal voice assistant.

Speak naturally and concisely. Understand English, Hindi, and Hinglish and reply in the user's language style.
Do not use markdown, lists, or formatting in spoken replies.
Do not repeat the wake word.

SMART LISTENING:
Treat this as a real spoken conversation. Answer the user's request directly.
If the user asks a follow-up question, leaves a task incomplete, or the conversation naturally expects another turn, keep the conversation flowing.
If the request is complete and no follow-up is needed, finish naturally.
Never force a follow-up question just to keep listening.

VOICE PRIVACY:
Voice turns are transient and are not stored in NABU D1 memory.
`}]
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                prefixPaddingMs: 300,
                silenceDurationMs: 1200
              }
            }
          }
        }));
      });

      ws.on("message", data => this.handleGemini(data));
      ws.on("error", err => {
        console.error("Gemini socket error:", err.message);
        this.send({type: "error", message: "Gemini Live connection error"});
        fail(err);
      });
      ws.on("close", () => {
        this.geminiReady = false;
        if (!this.destroyed) this.send({type: "error", message: "Gemini Live session closed"});
      });

      const originalSend = ws.send.bind(ws);
      ws._nabuResolveSetup = () => {
        if (!settled) { settled = true; resolve(); }
      };
      ws._nabuOriginalSend = originalSend;

      setTimeout(() => {
        if (!settled) fail(new Error("Gemini setup timeout"));
      }, 15000);
    });
  }

  async handleGemini(data) {
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      return;
    }

    if (msg.setupComplete) {
      this.geminiReady = true;
      this.send({type: "ready"});
      return;
    }

    if (msg.error) {
      this.send({type: "error", message: msg.error.message || "Gemini error"});
      return;
    }

    const content = msg.serverContent;
    if (!content) return;

    if (content.inputTranscription?.text) {
      this.transcript += content.inputTranscription.text;
    }
    if (content.outputTranscription?.text) {
      this.transcript += " " + content.outputTranscription.text;
    }

    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        const audio = part?.inlineData?.data;
        if (audio) {
          if (!this.responseStarted) {
            this.responseStarted = true;
            this.speaking = true;
            this.send({type: "assistant_start"});
          }
          this.send({type: "audio", data: audio});
        }
      }
    }

    if (content.turnComplete) {
      this.send({type: "assistant_end"});
      const keepListening = shouldContinue(this.transcript);
      this.responseStarted = false;
      this.waitingForResponse = false;
      this.speaking = false;
      this.turnActive = false;
      this.transcript = "";

      if (keepListening) {
        this.resetForNextTurn();
        this.send({type: "continue_listening"});
        this.send({type: "listening"});
      } else {
        this.send({type: "stop_listening"});
      }
    }
  }

  resetForNextTurn() {
    clearTimeout(this.endTimer);
    clearTimeout(this.maxTurnTimer);
    this.turnActive = false;
    this.vadSpeaking = false;
    this.responseStarted = false;
    this.waitingForResponse = false;
  }

  async beginTurn() {
    if (this.waitingForResponse || this.responseStarted) return;
    if (!this.gemini || this.gemini.readyState !== WebSocket.OPEN || !this.geminiReady) return;
    if (this.turnActive) return;

    this.turnActive = true;
    this.vadSpeaking = true;
    this.send({type: "speech_start"});
    this.send({type: "listening"});

    clearTimeout(this.maxTurnTimer);
    this.maxTurnTimer = setTimeout(() => {
      if (this.turnActive) this.endTurn("max_time");
    }, 30000);
  }

  async endTurn(reason = "silence") {
    if (!this.turnActive || this.waitingForResponse) return;
    this.turnActive = false;
    this.vadSpeaking = false;
    this.waitingForResponse = true;

    clearTimeout(this.endTimer);
    clearTimeout(this.maxTurnTimer);

    if (this.gemini?.readyState === WebSocket.OPEN) {
      this.gemini.send(JSON.stringify({realtimeInput: {audioStreamEnd: true}}));
    }
    this.send({type: "thinking", reason});
  }

  async processAudio(pcm) {
    if (!this.vad || !this.geminiReady) return;
    if (this.responseStarted || this.waitingForResponse) return;

    // Silero gets the exact 16-bit PCM stream from the ESP32.
    const result = await this.vad.onMessage(pcm);
    if (!result) return;

    const state = result.outputs?.find(x => x.label === "speech");
    if (!state) return;

    const nowSpeaking = Boolean(state.isSpeaking);

    if (nowSpeaking && !this.lastVadState) {
      await this.beginTurn();
    }

    if (!nowSpeaking && this.lastVadState && this.turnActive) {
      // Silero already uses a lookback window. Add a small debounce so a
      // single dropped frame never ends a sentence.
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => this.endTurn("vad_silence"), 1200);
    }

    if (nowSpeaking) {
      clearTimeout(this.endTimer);
    }

    this.lastVadState = nowSpeaking;

    // Keep sending the audio while the user is speaking. Gemini's own VAD is
    // enabled as a second safety layer.
    if (this.turnActive && this.gemini?.readyState === WebSocket.OPEN) {
      this.gemini.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: bufferToB64(pcm),
            mimeType: "audio/pcm;rate=16000"
          }
        }
      }));
    }
  }

  async stop() {
    clearTimeout(this.endTimer);
    clearTimeout(this.maxTurnTimer);
    if (this.turnActive) await this.endTurn("client_stop");
    try { this.vad?.destroy(); } catch {}
    try { this.gemini?.close(); } catch {}
    this.destroyed = true;
  }
}

wss.on("connection", async ws => {
  console.log("NABU client connected");
  const session = new NabuSession(ws);
  ws._nabuSession = session;
  session.send({type: "connected"});
  await session.start();

  ws.on("message", async raw => {
    if (typeof raw !== "string") return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "start") {
      session.resetForNextTurn();
      session.send({type: "listening"});
      return;
    }

    if (msg.type === "stop") {
      await session.stop();
      return;
    }

    if (msg.type === "audio" && typeof msg.data === "string") {
      try {
        await session.processAudio(b64ToBuffer(msg.data));
      } catch (err) {
        console.error("VAD processing error:", err);
        session.send({type: "error", message: "VAD processing error"});
      }
    }
  });

  ws.on("close", () => {
    console.log("NABU client disconnected");
    session.stop();
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`NABU Render Voice Server listening on ${PORT}`);
  console.log(`VAD model: ${VAD_MODEL}`);
});
