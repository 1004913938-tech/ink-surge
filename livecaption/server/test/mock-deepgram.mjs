// Deepgram stand-in for the e2e. Usage: node test/mock-deepgram.mjs <port>
// - Every handshake must carry "Authorization: Token testkey" (else 401). Each URL + auth is recorded: GET /seen.
// - GET /ctl?next=<status> makes the NEXT handshake fail with that status (402, 429, 401...), with a dg-error header.
// - Each binary frame is answered with a Results message; every 4th one (about 1 s of page audio) ends a sentence
//   ("frame 4.", speech_final), so the real page commits a caption line. {"type":"CloseStream"} -> Metadata, then close 1000.
// - Text {"type":"MockClose","code":N} closes the stream with code N.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = +(process.argv[2] || 9911);
let next = 0;
const seen = [];
const http = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ctl") { next = +(u.searchParams.get("next") || 0); res.end("ok"); return; }
  if (u.pathname === "/seen") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(seen)); return; }
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, sock, head) => {
  const auth = req.headers.authorization;
  seen.push({ url: req.url, auth });
  const fail = next || (auth === "Token testkey" ? 0 : 401);
  next = 0;
  if (fail) {
    sock.end(`HTTP/1.1 ${fail} Nope\r\ndg-error: mock ${fail}\r\ndg-request-id: mock-fail\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    let frames = 0;
    ws.on("message", (data, bin) => {
      if (bin) {
        frames++;
        const end = frames % 4 === 0;
        ws.send(JSON.stringify({ type: "Results", is_final: true, speech_final: end, channel: { alternatives: [{ transcript: "frame " + frames + (end ? "." : "") }] } }));
        return;
      }
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "CloseStream") { ws.send(JSON.stringify({ type: "Metadata", request_id: "mock-req", duration: frames * 0.25 })); ws.close(1000); }
      if (m.type === "MockClose") ws.close(m.code, "mock close");
    });
  });
});
http.listen(port, "127.0.0.1", () => console.log("mock deepgram on", port));
