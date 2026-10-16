// Deepgram stand-in for the e2e. Usage: node test/mock-deepgram.mjs <port>
// - Every handshake must carry "Authorization: Token testkey" (else 401). Each URL + auth (+ frames received) is recorded:
//   GET /seen.
// - GET /ctl?next=<status> makes the NEXT handshake fail with that status (402, 429, 401...), with a dg-error header.
//   /ctl?delayOnce=<ms> delays only the next handshake; /ctl?delay=<ms> delays every handshake until /ctl?delay=0.
//   /ctl?frameSec=<s> sets how much audio one binary frame stands for (default 0.25 s, the page's MediaRecorder chunk;
//   a larger value plays a client that packs more audio per message than real time allows).
// - Each binary frame is answered with a Results message whose start + duration is the audio received so far (Deepgram's
//   audio cursor); every 4th one (about 1 s of page audio) ends a sentence ("frame 4.", speech_final), so the real page
//   commits a caption line. {"type":"CloseStream"} -> Metadata (duration = all audio received), then close 1000.
// - Text {"type":"MockClose","code":N} closes the stream with code N.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = +(process.argv[2] || 9911);
let next = 0, delay = 0, delayOnce = 0, frameSec = 0.25;
const seen = [];
const http = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ctl") {
    const q = u.searchParams;
    if (q.has("next")) next = +q.get("next") || 0;
    if (q.has("delay")) delay = +q.get("delay") || 0;
    if (q.has("delayOnce")) delayOnce = +q.get("delayOnce") || 0;
    if (q.has("frameSec")) frameSec = +q.get("frameSec") || 0.25;
    res.end("ok"); return;
  }
  if (u.pathname === "/seen") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(seen)); return; }
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", async (req, sock, head) => {
  const auth = req.headers.authorization;
  const rec = { url: req.url, auth, frames: 0, at: Date.now() };
  seen.push(rec);
  const fail = next || (auth === "Token testkey" ? 0 : 401);
  next = 0;
  const wait = delayOnce || delay;
  delayOnce = 0;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  if (fail) {
    sock.end(`HTTP/1.1 ${fail} Nope\r\ndg-error: mock ${fail}\r\ndg-request-id: mock-fail\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    return;
  }
  if (sock.destroyed) return; // the caller gave up while we were "slow"
  wss.handleUpgrade(req, sock, head, (ws) => {
    let frames = 0, audio = 0;
    ws.on("message", (data, bin) => {
      if (bin) {
        frames++; rec.frames = frames;
        const start = audio, dur = frameSec;
        audio += dur;
        const end = frames % 4 === 0;
        ws.send(JSON.stringify({ type: "Results", start, duration: dur, is_final: true, speech_final: end,
          channel: { alternatives: [{ transcript: "frame " + frames + (end ? "." : "") }] } }));
        return;
      }
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "CloseStream") { ws.send(JSON.stringify({ type: "Metadata", request_id: "mock-req", duration: audio })); ws.close(1000); }
      if (m.type === "MockClose") ws.close(m.code, "mock close");
    });
  });
});
http.listen(port, "127.0.0.1", () => console.log("mock deepgram on", port));
