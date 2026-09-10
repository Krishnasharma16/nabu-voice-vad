import http from "node:http";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";

const require = createRequire(import.meta.url);
const { RealTimeVAD } = require("@ericedouard/vad-node-realtime");

const PORT = Number(process.env.PORT || 10000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "models/gemini-3.1-flash-live-preview";

const httpServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, {"content-type":"application/json"});
    res.end(JSON.stringify({status:"online",service:"NABU Render Voice Server",vad:"Silero VAD realtime",websocket:"/live",geminiConfigured:Boolean(GEMINI_API_KEY)}));
    return;
  }
  res.writeHead(404); res.end("Not found");
});

const wss = new WebSocketServer({noServer:true});
httpServer.on("upgrade",(req,socket,head)=>{
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/live") return socket.destroy();
  wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req));
});

const b64ToBuffer = s => Buffer.from(s,"base64");
const bufferToB64 = b => Buffer.from(b).toString("base64");
function pcm16ToFloat32(buf) {
  const n = Math.floor(buf.length/2), out = new Float32Array(n);
  for (let i=0;i<n;i++) out[i] = buf.readInt16LE(i*2)/32768;
  return out;
}

class NabuSession {
  constructor(client) {
    this.client=client; this.gemini=null; this.geminiReady=false;
    this.responseStarted=false; this.waitingForResponse=false; this.turnActive=false;
    this.transcript=""; this.vad=null; this.endTimer=null; this.maxTurnTimer=null;
    this.destroyed=false; this.prebuffer=[]; this.prebufferSamples=0;
    this.maxPrebufferSamples=9600; this.geminiAudioStarted=false;
  }
  send(o){ if(this.client.readyState===WebSocket.OPEN)this.client.send(JSON.stringify(o)); }
  clearTimers(){clearTimeout(this.endTimer);clearTimeout(this.maxTurnTimer);this.endTimer=null;this.maxTurnTimer=null;}

  async start(){
    if(!GEMINI_API_KEY){this.send({type:"error",message:"GEMINI_API_KEY is not configured on Render"});return;}
    try{
      this.vad=await RealTimeVAD.new({
        sampleRate:16000, positiveSpeechThreshold:0.60, negativeSpeechThreshold:0.35, minSpeechFrames:4,
        onSpeechStart:()=>this.onSpeechStart(), onSpeechEnd:()=>this.onSpeechEnd(), onVADMisfire:()=>{}
      });
      this.vad.start();
      await this.openGemini();
      if(!this.destroyed)this.send({type:"ready"});
    }catch(e){console.error("Session start error:",e);this.send({type:"error",message:`Voice server startup failed: ${e.message}`});}
  }

  async openGemini(){
    const url="wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key="+encodeURIComponent(GEMINI_API_KEY);
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(url); let settled=false;
      const fail=e=>{if(!settled){settled=true;reject(e)}};
      ws.on("open",()=>{
        this.gemini=ws;
        ws.send(JSON.stringify({setup:{
          model:GEMINI_MODEL,
          generationConfig:{responseModalities:["AUDIO"],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:"Kore"}}}},
          systemInstruction:{parts:[{text:"You are NABU, a natural personal voice assistant. Speak naturally and concisely. Understand English, Hindi, and Hinglish. Do not use markdown or lists in spoken replies. Do not repeat the wake word. Answer directly. Voice audio is transient and is not stored in NABU D1 memory."}]},
          inputAudioTranscription:{},outputAudioTranscription:{},
          realtimeInputConfig:{automaticActivityDetection:{disabled:false,startOfSpeechSensitivity:"START_SENSITIVITY_LOW",endOfSpeechSensitivity:"END_SENSITIVITY_HIGH",prefixPaddingMs:300,silenceDurationMs:1200}}
        }}));
      });
      ws.on("message",d=>this.handleGemini(d));
      ws.on("error",e=>{console.error("Gemini socket error:",e.message);fail(e)});
      ws.on("close",()=>{this.geminiReady=false;if(!this.destroyed)this.send({type:"error",message:"Gemini Live session closed"})});
      this.setupResolve=()=>{if(!settled){settled=true;resolve()}};
      setTimeout(()=>{if(!settled)fail(new Error("Gemini setup timeout"))},15000);
    });
  }

  async handleGemini(data){
    let m; try{m=JSON.parse(Buffer.isBuffer(data)?data.toString():String(data))}catch{return}
    if(m.setupComplete){this.geminiReady=true;this.setupResolve?.();return}
    if(m.error){this.send({type:"error",message:m.error.message||"Gemini error"});return}
    const c=m.serverContent;if(!c)return;
    if(c.inputTranscription?.text)this.transcript+=c.inputTranscription.text;
    if(c.outputTranscription?.text)this.transcript+=" "+c.outputTranscription.text;
    for(const p of c.modelTurn?.parts||[]){
      const a=p?.inlineData?.data;if(!a)continue;
      if(!this.responseStarted){this.responseStarted=true;this.send({type:"assistant_start"})}
      this.send({type:"audio",data:a});
    }
    if(c.turnComplete){
      this.send({type:"assistant_end"});
      this.responseStarted=false;this.waitingForResponse=false;this.turnActive=false;
      this.transcript="";this.geminiAudioStarted=false;this.clearTimers();
      this.send({type:"stop_listening"});
    }
  }

  async onSpeechStart(){
    if(this.destroyed||this.waitingForResponse||this.responseStarted||this.turnActive)return;
    if(!this.geminiReady||!this.gemini||this.gemini.readyState!==WebSocket.OPEN)return;
    this.turnActive=true;this.send({type:"speech_start"});this.send({type:"listening"});
    for(const c of this.prebuffer)this.sendGeminiAudio(c);
    this.prebuffer=[];this.prebufferSamples=0;
    clearTimeout(this.maxTurnTimer);
    this.maxTurnTimer=setTimeout(()=>this.endTurn("max_time"),30000);
  }

  onSpeechEnd(){
    if(!this.turnActive||this.waitingForResponse)return;
    clearTimeout(this.endTimer);
    this.endTimer=setTimeout(()=>this.endTurn("silero_end"),900);
  }

  sendGeminiAudio(buf){
    if(!this.gemini||this.gemini.readyState!==WebSocket.OPEN)return;
    this.gemini.send(JSON.stringify({realtimeInput:{audio:{data:bufferToB64(buf),mimeType:"audio/pcm;rate=16000"}}}));
    this.geminiAudioStarted=true;
  }

  endTurn(reason){
    if(!this.turnActive||this.waitingForResponse)return;
    this.turnActive=false;this.waitingForResponse=true;this.clearTimers();
    if(this.gemini?.readyState===WebSocket.OPEN&&this.geminiAudioStarted)
      this.gemini.send(JSON.stringify({realtimeInput:{audioStreamEnd:true}}));
    this.send({type:"thinking",reason});
  }

  async processAudio(pcm){
    if(this.destroyed||!this.vad)return;
    const samples=Math.floor(pcm.length/2);
    this.prebuffer.push(pcm);this.prebufferSamples+=samples;
    while(this.prebufferSamples>this.maxPrebufferSamples&&this.prebuffer.length){
      const old=this.prebuffer.shift();this.prebufferSamples-=Math.floor(old.length/2);
    }
    await this.vad.processAudio(pcm16ToFloat32(pcm));
    if(this.turnActive&&!this.responseStarted&&!this.waitingForResponse){
      clearTimeout(this.endTimer);this.sendGeminiAudio(pcm);
    }
  }

  async stop(){
    this.destroyed=true;this.clearTimers();
    try{await this.vad?.flush?.()}catch{}
    try{this.vad?.destroy?.()}catch{}
    try{this.gemini?.close()}catch{}
  }
}

wss.on("connection",async ws=>{
  console.log("NABU client connected"); const s=new NabuSession(ws); await s.start();
  ws.on("message",async raw=>{
    if(typeof raw!=="string")return;let m;try{m=JSON.parse(raw)}catch{return}
    if(m.type==="start"){s.waitingForResponse=false;s.responseStarted=false;s.send({type:"listening"});return}
    if(m.type==="stop"){await s.stop();return}
    if(m.type==="audio"&&typeof m.data==="string")try{await s.processAudio(b64ToBuffer(m.data))}catch(e){console.error("VAD error:",e);s.send({type:"error",message:"VAD processing error"})}
  });
  ws.on("close",()=>s.stop());
});

httpServer.listen(PORT,"0.0.0.0",()=>console.log(`NABU voice server listening on ${PORT}`));
