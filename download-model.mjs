
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const out = path.resolve("models/silero_vad.onnx");
const url = "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx";

fs.mkdirSync(path.dirname(out), {recursive: true});

function download(current, redirects = 0) {
  if (redirects > 10) throw new Error("Too many redirects");
  return new Promise((resolve, reject) => {
    https.get(current, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        const next = new URL(res.headers.location, current).href;
        res.resume();
        return download(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Model download failed: HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(out);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

if (fs.existsSync(out) && fs.statSync(out).size > 1000000) {
  console.log("Silero model already present:", out);
} else {
  console.log("Downloading Silero VAD model...");
  await download(url);
  console.log("Saved:", out, fs.statSync(out).size, "bytes");
}
