// End-to-end test of ../index.html in Chromium against a mock Deepgram streaming server.
// Needs playwright + ws: LC_DEPS=<dir containing node_modules> node livecaption/lite/tests/browser.e2e.mjs
// Optional: CHROMIUM=<executable path>, OUT=<screenshot dir>.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(join(process.env.LC_DEPS || process.cwd(), "noop.js"));
const { chromium } = require("playwright");
const { WebSocketServer } = require("ws");

const INDEX = process.env.LC_INDEX || fileURLToPath(new URL("../index.html", import.meta.url));
const OUT = process.env.OUT || "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = "") { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); }

// ------------------------------------------------------------------ mock Deepgram
const w = (word, speaker, punct) => ({ word: word.toLowerCase().replace(/[.,?!]/g, ""), start: 0, end: 0, confidence: 0.95, punctuated_word: punct ?? word, speaker, speaker_confidence: 0.8 });
const res = (words, is_final, speech_final = false) => JSON.stringify({
  type: "Results", channel_index: [0, 1], duration: 1, start: 0, is_final, speech_final, from_finalize: false,
  channel: { alternatives: [{ transcript: words.map((x) => x.punctuated_word).join(" "), confidence: 0.95, words }] },
  metadata: { request_id: "mock", model_info: { name: "general-nova-3" } },
});
const SCRIPTS = {
  // first connection: two interviewers, then the server drops the connection
  "goodkey#1": async (ws) => {
    ws.send(JSON.stringify({ type: "SpeechStarted", channel: [0], timestamp: 0.1 }));
    ws.send(res([w("Could", 0), w("you", 0)], false));
    await sleep(300);
    ws.send(res([w("Could", 0), w("you", 0), w("introduce", 0)], true));
    await sleep(1200);                                    // long enough to see the provisional translation
    ws.send(res([w("yourself", 0)], false));
    await sleep(300);
    ws.send(res([w("yourself", 0), w("briefly?", 0)], true, true));
    await sleep(300);
    ws.send(res([w("And", 1), w("your", 1), w("notice", 1), w("period?", 1)], true));
    await sleep(200);
    ws.send(JSON.stringify({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 3.2 }));
    await sleep(800);
    ws.close(1011, "mock: server restart");
  },
  // second connection after the automatic reconnect: speaker numbering restarts at 0
  "goodkey#2": async (ws) => {
    ws.send(res([w("Great,", 0), w("thank", 0), w("you.", 0)], true, true));
  },
  "filekey#1": async (ws) => {
    ws.send(res([w("Hello", 0), w("from", 0), w("file.", 0)], true, true));
  },
  "hidkey#1": async (ws) => {
    ws.send(res([w("Still", 0), w("updating.", 0)], true, true));
  },
  "nolkey#1": async (ws) => {
    ws.send(res([w("No", 0), w("translator", 0), w("here.", 0)], true, true));
  },
};
const conns = [];
let rejected = 0;
const http = createServer((req, resp) => {
  if (req.url.startsWith("/index.html")) { resp.writeHead(200, { "content-type": "text/html; charset=utf-8" }); resp.end(readFileSync(INDEX)); }
  else { resp.writeHead(404); resp.end(); }
});
const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has("token") ? "token" : false) });
http.on("upgrade", (req, sock, head) => {
  const protos = (req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  const key = protos[0] === "token" ? protos[1] : null;
  if (!key || !/^(goodkey|filekey|nolkey|hidkey)$/.test(key)) {
    rejected++;
    sock.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const n = conns.filter((c) => c.key === key).length + 1;
    const c = { key, n, url: new URL(req.url, "http://x"), protocol: ws.protocol, bins: 0, bytes: 0, head: null, json: [], closed: false };
    conns.push(c);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        c.bins++; c.bytes += data.length;
        if (!c.head) { c.head = Buffer.from(data).subarray(0, 4).toString("hex"); SCRIPTS[`${key}#${n}`]?.(ws); }
      } else { try { c.json.push(JSON.parse(data.toString())); } catch { c.json.push(data.toString()); } }
    });
    ws.on("close", () => { c.closed = true; });
  });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const PORT = http.address().port;
const DG = `ws://127.0.0.1:${PORT}/v1/listen`;

// ------------------------------------------------------------------ browser
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const TRANSLATOR_STUB = () => {
  self.Translator = {
    availability: async (o) => (o.sourceLanguage === "en" && o.targetLanguage === "zh" ? "downloadable" : "unavailable"),
    create: async (o) => {
      const listeners = [];
      o.monitor?.({ addEventListener: (_n, f) => listeners.push(f) });
      for (const p of [0, 0.5, 1]) { listeners.forEach((f) => f({ loaded: p })); await new Promise((r) => setTimeout(r, 30)); }
      return { translate: async (t) => { await new Promise((r) => setTimeout(r, 40)); return "【译】" + t; } };
    },
  };
};
const errors = [];
async function newPage({ stub = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
  if (stub) await ctx.addInitScript(TRANSLATOR_STUB);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { errors.push(e.message); console.log("pageerror:", e.message); });
  return page;
}
const committed = (page) => page.$$eval(".captions#captions .line:not(.interim)", (ls) => ls.map((l) => ({
  who: l.querySelector(".who")?.textContent || "", zh: l.querySelector(".zh")?.textContent || "", src: l.querySelector(".src")?.textContent || "",
})));

// ---- A: happy path over http (two speakers, provisional translation, reconnect, PiP, export, stop)
{
  const page = await newPage();
  await page.goto(`http://127.0.0.1:${PORT}/index.html?dg=${encodeURIComponent(DG)}&fakeAudio=1`);
  await page.fill("#key", "goodkey");
  await page.selectOption("#diarize", "1");
  await page.click("#prepBtn");
  await page.waitForFunction(() => /翻译已就绪/.test(document.getElementById("prepMsg").textContent), null, { timeout: 5000 });
  check("translator prepared via click (download progress shown)", true);
  const sawInterimZh = page.waitForFunction(() => {
    const z = document.querySelector("#captions .line.interim .zh:not(.pending)");
    return z && /【译】Could you introduce/.test(z.textContent);
  }, null, { timeout: 8000 }).then(() => true, () => false);
  await page.click("#startBtn");
  await page.waitForFunction(() => document.querySelectorAll("#captions .line:not(.interim)").length >= 3, null, { timeout: 15000 }).catch(() => {});
  check("provisional translation of the unfinished sentence is shown", await sawInterimZh);
  await sleep(300);
  const rows = await committed(page);
  for (const r of rows) console.log("   ", JSON.stringify(r));
  check("3 lines committed (speech_final, UtteranceEnd, after reconnect)", rows.length === 3, `got ${rows.length}`);
  check("line 1 text + translation", rows[0]?.src === "Could you introduce yourself briefly?" && rows[0]?.zh === "【译】Could you introduce yourself briefly?");
  check("line 2 is second speaker, committed by UtteranceEnd", rows[1]?.src === "And your notice period?" && rows[1]?.who === "说话人 2");
  check("speaker labels: reconnect gets a fresh label", rows[0]?.who === "说话人 1" && rows[2]?.who === "说话人 3", rows.map((r) => r.who).join(","));
  const [c1, c2] = conns.filter((c) => c.key === "goodkey");
  check("auth via WebSocket subprotocol ['token', key]", c1?.protocol === "token");
  check("query params sent", c1?.url.searchParams.get("model") === "nova-3" && c1?.url.searchParams.get("language") === "en" && c1?.url.searchParams.get("diarize") === "true" && c1?.url.searchParams.get("interim_results") === "true");
  check("each connection starts with a WebM/EBML header", c1?.head === "1a45dfa3" && c2?.head === "1a45dfa3", `${c1?.head} ${c2?.head}`);
  check("reconnected after server close", !!c2);

  // PiP
  const hasPip = await page.evaluate(() => "documentPictureInPicture" in window);
  if (hasPip) {
    await page.click("#pipBtn");
    const pipOk = await page.waitForFunction(() => {
      const w = window.documentPictureInPicture.window;
      return w && w.document.querySelectorAll("#pipCaps .line").length >= 1;
    }, null, { timeout: 5000 }).then(() => true, () => false);
    const warn = await page.textContent("#pipWarn");
    check("floating window shows captions + screen-share warning", pipOk && /共享屏幕/.test(warn));
  } else console.log("SKIP  PiP not available in this Chromium");

  // export
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const txt = readFileSync(await dl.path(), "utf8");
  check("transcript download has source + translation", /Could you introduce yourself briefly\?/.test(txt) && /【译】And your notice period\?/.test(txt), dl.suggestedFilename());

  await page.screenshot({ path: `${OUT}/lite-captions.png` });
  // keepalive, then stop
  await sleep(8600);
  check("KeepAlive sent while connected", c2.json.some((m) => m.type === "KeepAlive"));
  await page.click("#stopBtn");
  await sleep(500);
  check("stop sends CloseStream and closes", c2.json.some((m) => m.type === "CloseStream") && c2.closed);
  const status = await page.textContent("#status");
  check("status shows stopped", status === "已停止");
  await page.context().close();
}

// ---- B: wrong key -> clear message, keeps retrying
{
  const page = await newPage();
  await page.goto(`http://127.0.0.1:${PORT}/index.html?dg=${encodeURIComponent(DG)}&fakeAudio=1`);
  await page.fill("#key", "wrongkey");
  await page.click("#startBtn");
  const msg = await page.waitForFunction(() => document.getElementById("err").textContent, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => "");
  check("bad key -> actionable error", /Key/.test(msg) && /余额/.test(msg), msg);
  await sleep(2500);
  check("bad key -> retries with backoff", rejected >= 2, `rejected=${rejected}`);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- C: opened straight from disk (file://), key remembered
{
  const page = await newPage();
  const url = pathToFileURL(INDEX).href + `?dg=${encodeURIComponent(DG)}&fakeAudio=1`;
  await page.goto(url);
  await page.fill("#key", "filekey");
  await page.click("#startBtn");
  const ok = await page.waitForFunction(() => /【译】Hello from file\./.test(document.querySelector("#captions .line:not(.interim) .zh")?.textContent || ""), null, { timeout: 8000 }).then(() => true, () => false);
  check("file:// works: capture -> Deepgram -> translated line", ok);
  if (!ok) console.log("   diag:", JSON.stringify({ rows: await committed(page), status: await page.textContent("#status"), err: await page.textContent("#err"),
    prep: await page.textContent("#prepMsg"), conns: conns.filter((c) => c.key === "filekey").map((c) => ({ head: c.head, bins: c.bins })) }));
  await page.click("#stopBtn");
  await page.reload();
  check("key remembered after reload", (await page.inputValue("#key")) === "filekey");
  await page.context().close();
}

// ---- D: real Chromium Translator (no stub): must still show the English, with an explanation
{
  const page = await newPage({ stub: false });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?dg=${encodeURIComponent(DG)}&fakeAudio=1`);
  console.log("   real Translator in this Chromium:", await page.evaluate(async () => {
    if (!self.Translator) return "absent";
    try { return await self.Translator.availability({ sourceLanguage: "en", targetLanguage: "zh" }); } catch (e) { return "error " + e.message; }
  }));
  await page.fill("#key", "nolkey");
  await page.click("#prepBtn");
  await sleep(1500);
  console.log("   prepMsg:", await page.textContent("#prepMsg"));
  await page.click("#startBtn");
  const ok = await page.waitForFunction(() => /No translator here\./.test(document.querySelector("#captions .line:not(.interim) .src")?.textContent || ""), null, { timeout: 8000 }).then(() => true, () => false);
  check("without a translator the English still shows", ok);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- E: page hidden behind Feishu (Chrome stops requestAnimationFrame): captions must still update
{
  const page = await newPage();
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?dg=${encodeURIComponent(DG)}&fakeAudio=1`);
  await page.fill("#key", "hidkey");
  await page.click("#startBtn");
  const ok = await page.waitForFunction(() => /【译】Still updating\./.test(document.querySelector("#captions .line:not(.interim) .zh")?.textContent || ""),
    null, { timeout: 8000, polling: 100 }).then(() => true, () => false); // default polling uses rAF, which this case disables
  check("captions update without requestAnimationFrame (occluded window)", ok);
  if (!ok) console.log("   diag:", JSON.stringify({ rows: await committed(page), lines: await page.evaluate(() => window.__lcl.lines()),
    status: await page.textContent("#status"), err: await page.textContent("#err"), prep: await page.textContent("#prepMsg"),
    conns: conns.filter((c) => c.key === "hidkey").map((c) => ({ head: c.head, bins: c.bins })) }));
  await page.click("#stopBtn");
  await page.context().close();
}

check("no uncaught page errors", errors.length === 0, errors.join(" | "));
await browser.close();
http.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `LITE E2E FAIL (${failed}/${results.length})` : `LITE E2E PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
