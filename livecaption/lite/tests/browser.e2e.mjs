// End-to-end test of ../index.html in Chromium against a mock Deepgram streaming server.
// Needs playwright + ws: LC_DEPS=<dir containing node_modules> node livecaption/lite/tests/browser.e2e.mjs
// Optional: CHROMIUM=<executable path>, OUT=<screenshot dir>, LC_INDEX=<another build of the page>.
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
    return "closed";
  },
  // second connection after the automatic reconnect: speaker numbering restarts at 0
  "goodkey#2": async (ws) => { ws.send(res([w("Great,", 0), w("thank", 0), w("you.", 0)], true, true)); },
  // translator stub throws for "Explode" and never answers for "Hang"
  "filekey#1": async (ws) => {
    for (const s of ["Hello from file.", "Explode now.", "Hang on.", "After that."]) {
      ws.send(res(s.split(" ").map((x) => w(x, 0)), true, true));
      await sleep(150);
    }
  },
  "hidkey#1": async (ws) => { ws.send(res([w("Still", 0), w("updating.", 0)], true, true)); },
  "nolkey#1": async (ws) => { ws.send(res([w("No", 0), w("translator", 0), w("here.", 0)], true, true)); },
  // answers once, then goes silent with the socket open (stalled server / half-open proxy)
  "stallkey#1": async (ws) => { ws.send(res([w("Before", 0), w("the", 0), w("stall.", 0)], true, true)); return "silent"; },
  "stallkey#2": async (ws) => { ws.send(res([w("Back", 0), w("again.", 0)], true, true)); },
  // network blip in the middle of a question; the next 3 handshakes fail (see upgrade handler)
  "blipkey#1": async (ws) => {
    ws.send(res([w("So", 0), w("how", 0), w("would", 0), w("you", 0)], true));
    await sleep(100);
    ws.send(res([w("handle", 0), w("a", 0), w("conflict", 0)], false));
    await sleep(600);
    ws.terminate();
    return "closed";
  },
  "blipkey#2": async (ws) => { ws.send(res([w("Welcome", 0), w("back.", 0)], true, true)); },
  // first connection closes; the next handshake hangs until the user clicks 立即重连
  "hangkey#1": async (ws) => { ws.send(res([w("Before", 0), w("hang.", 0)], true, true)); await sleep(300); ws.close(1011, "mock"); return "closed"; },
  "hangkey#2": async (ws) => { ws.send(res([w("After", 0), w("retry.", 0)], true, true)); },
  // a reply, then no messages (the network died under the socket) and a late reset before the stall watchdog
  "gapkey#1": async (ws) => { ws.send(res([w("Before", 0), w("the", 0), w("drop.", 0)], true, true)); setTimeout(() => ws.terminate(), 2500); return "silent"; },
  "gapkey#2": async (ws) => { ws.send(res([w("Back", 0), w("again.", 0)], true, true)); },
  // a non-fatal Error message, then results keep coming
  "errkey#1": async (ws) => {
    ws.send(JSON.stringify({ type: "Error", variant: "mock", description: "mock hiccup" }));
    await sleep(1200);
    ws.send(res([w("Still", 0), w("fine.", 0)], true, true));
  },
  "quietkey#1": async () => {},
};
const ACCEPT = /^(goodkey|filekey|nolkey|hidkey|stallkey|blipkey|hangkey|gapkey|errkey|quietkey)$/;
const conns = [], attempts = {}, rejectedAt = [], hung = [];
let rejected = 0;
const http = createServer((req, resp) => {
  if (req.url.startsWith("/index.html")) { resp.writeHead(200, { "content-type": "text/html; charset=utf-8" }); resp.end(readFileSync(INDEX)); }
  else { resp.writeHead(404); resp.end(); }
});
const wss = new WebSocketServer({ noServer: true, handleProtocols: (set) => (set.has("token") ? "token" : false) });
http.on("upgrade", (req, sock, head) => {
  const protos = (req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim());
  const key = protos[0] === "token" ? protos[1] : null;
  const a = attempts[key] = (attempts[key] || 0) + 1;
  if (key === "hangkey" && a === 2) { hung.push({ sock, t: Date.now() }); return; } // never answer this handshake
  if (!key || !ACCEPT.test(key) || (key === "blipkey" && a >= 2 && a <= 4)) {
    rejected++; rejectedAt.push({ key, t: Date.now() });
    sock.end(`HTTP/1.1 ${key === "blipkey" ? "503 Service Unavailable" : "401 Unauthorized"}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => {
    const n = conns.filter((c) => c.key === key).length + 1;
    const c = { key, n, url: new URL(req.url, "http://x"), protocol: ws.protocol, openedAt: Date.now(), bins: 0, head: null, json: [], closed: false };
    conns.push(c);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        c.bins++;
        if (!c.head) {
          c.head = Buffer.from(data).subarray(0, 4).toString("hex");
          Promise.resolve(SCRIPTS[`${key}#${n}`]?.(ws)).then((how) => {
            // like Deepgram while audio keeps coming: an empty final about once a second
            if (how === "silent" || how === "closed") return;
            const t = setInterval(() => (ws.readyState === 1 ? ws.send(res([], true)) : clearInterval(t)), 1000);
          });
        }
      } else {
        let m; try { m = JSON.parse(data.toString()); } catch { m = data.toString(); }
        c.json.push(m);
        if (m && m.type === "CloseStream") ws.close(1000);
      }
    });
    ws.on("close", () => { c.closed = true; c.closedAt = Date.now(); });
  });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const PORT = http.address().port;
const DG = `ws://127.0.0.1:${PORT}/v1/listen`;
const pageUrl = (extra = "") => `http://127.0.0.1:${PORT}/index.html?dg=${encodeURIComponent(DG)}&fakeAudio=1${extra}`;

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
      return {
        translate: (t) => {
          if (/Explode/.test(t)) throw new Error("boom");          // synchronous throw
          if (/Hang/.test(t)) return new Promise(() => {});         // never settles
          return new Promise((r) => setTimeout(() => r("【译】" + t), 40));
        },
      };
    },
  };
};
const errors = [];
async function newPage({ stub = true, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height }, acceptDownloads: true });
  if (stub) await ctx.addInitScript(TRANSLATOR_STUB);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { errors.push(e.message); console.log("pageerror:", e.message); });
  return page;
}
const textLines = (page) => page.evaluate(() => window.__lcl.lines().filter((l) => l.kind === "text").map((l) => ({ src: l.src, zh: l.zh, zhState: l.zhState, cut: l.cut })));
const shown = (page) => page.$$eval("#captions .line:not(.interim)", (ls) => ls.map((l) => ({
  gap: l.classList.contains("gap"), who: l.querySelector(".who")?.textContent || "", zh: l.querySelector(".zh")?.textContent || "", src: l.querySelector(".src")?.textContent || "",
})));
const until = (page, fn, arg, timeout = 10000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
const pipText = (page, id) => page.evaluate((id) => { const w = window.documentPictureInPicture?.window; const e = w && w.document.getElementById(id); return e ? (e.classList.contains("hidden") ? "" : e.textContent) : null; }, id);
async function openPip(page) {
  if (!(await page.evaluate(() => "documentPictureInPicture" in window))) return false;
  await page.click("#pipBtn");
  return until(page, () => !!window.documentPictureInPicture.window, null, 5000);
}

// ---- A: happy path over http (two speakers, provisional translation, reconnect, scroll, PiP, export, stop sharing)
{
  const page = await newPage({ height: 560 });
  await page.goto(pageUrl());
  await page.fill("#key", "goodkey");
  await page.selectOption("#diarize", "1");
  await page.click("#prepBtn");
  check("translator prepared via click (download progress shown)", await until(page, () => /翻译已就绪/.test(document.getElementById("prepMsg").textContent), null, 5000));
  const sawInterimZh = until(page, () => /【译】Could you introduce/.test(document.querySelector("#captions .line.interim .zh:not(.pending)")?.textContent || ""), null, 8000);
  await page.click("#startBtn");
  check("settings locked while running", await page.isDisabled("#srcLang"));
  await until(page, () => window.__lcl.lines().filter((l) => l.kind === "text" && l.zhState === "ok").length >= 3, null, 15000);
  check("provisional translation of the unfinished sentence is shown", await sawInterimZh);
  await sleep(300);
  const rows = await shown(page);
  for (const r of rows) console.log("   ", JSON.stringify(r));
  const txt = rows.filter((r) => !r.gap);
  check("3 lines committed (speech_final, UtteranceEnd, after reconnect)", txt.length === 3, `got ${txt.length}`);
  check("line 1 text + translation", txt[0]?.src === "Could you introduce yourself briefly?" && txt[0]?.zh === "【译】Could you introduce yourself briefly?");
  check("line 2 is second speaker, committed by UtteranceEnd", txt[1]?.src === "And your notice period?" && txt[1]?.who === "说话人 2");
  check("speaker labels: reconnect gets a fresh label", txt[0]?.who === "说话人 1" && txt[2]?.who === "说话人 3", txt.map((r) => r.who).join(","));
  check("gap marker after the reconnect (sound during the outage)", rows.findIndex((r) => r.gap) === 2, rows.map((r) => (r.gap ? "GAP" : "line")).join(","));
  const [c1, c2] = conns.filter((c) => c.key === "goodkey");
  check("auth via WebSocket subprotocol ['token', key]", c1?.protocol === "token");
  check("query params sent", c1?.url.searchParams.get("model") === "nova-3" && c1?.url.searchParams.get("language") === "en" && c1?.url.searchParams.get("diarize") === "true" && c1?.url.searchParams.get("interim_results") === "true");
  check("each connection starts with a WebM/EBML header", c1?.head === "1a45dfa3" && c2?.head === "1a45dfa3", `${c1?.head} ${c2?.head}`);
  check("reconnected quickly after a server close", !!c2 && c2.openedAt - c1.closedAt < 2000, c2 ? `${c2.openedAt - c1.closedAt} ms` : "");

  // scrolling back to re-read a question survives incoming messages
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(2500); // the mock sends an empty result every second
  check("main list does not jump to the bottom while the user reads back", (await page.evaluate(() => window.scrollY)) === 0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // PiP
  if (await openPip(page)) {
    const capsOk = await until(page, () => window.documentPictureInPicture.window.document.querySelectorAll("#pipCaps .line").length >= 3, null, 5000);
    const status = await pipText(page, "pipStatus");
    check("floating window: captions + live status + screen-share warning", capsOk && /正在收听/.test(status) && /共享屏幕/.test(await page.textContent("#pipWarn")), status);
    check("floating window: no alarm while healthy", (await pipText(page, "pipBanner")) === "");
  } else console.log("SKIP  PiP not available in this Chromium");

  // export
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const exported = readFileSync(await dl.path(), "utf8");
  check("transcript download: source + translation + gap note, local-time name", /Could you introduce yourself briefly\?/.test(exported) && /【译】And your notice period\?/.test(exported) && /连接中断/.test(exported) && /^captions-\d{4}-\d\d-\d\d-\d{4}\.txt$/.test(dl.suggestedFilename()), dl.suggestedFilename());

  await page.screenshot({ path: `${OUT}/lite-captions.png` });
  await sleep(5600);
  check("KeepAlive sent while connected", c2.json.some((m) => m.type === "KeepAlive"));

  // the user clicks Chrome's "停止共享" by mistake: the floating window must say captions stopped
  await page.evaluate(() => window.__lcl.capture().audio.dispatchEvent(new Event("ended")));
  await sleep(600);
  check("stop sends CloseStream and the server closes", c2.json.some((m) => m.type === "CloseStream") && c2.closed);
  check("status + tab title show stopped", (await page.textContent("#status")) === "已停止" && /已停止/.test(await page.title()));
  const banner = await pipText(page, "pipBanner");
  if (banner !== null) check("floating window alarms after 停止共享", /字幕已停止/.test(banner) && /停止共享/.test(banner), banner);
  await page.context().close();
}

// ---- B: wrong key -> clear message, keeps retrying with backoff
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "wrongkey");
  await page.click("#startBtn");
  const msg = await page.waitForFunction(() => document.getElementById("err").textContent, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => "");
  check("bad key -> actionable error", /Key/.test(msg) && /余额/.test(msg), msg);
  await sleep(3000);
  check("bad key -> retries with backoff", rejected >= 2, `rejected=${rejected}`);
  await page.click("#stopBtn");
  const before = rejected + conns.length;
  await page.fill("#key", "abc，def-ghi xyz");                 // full-width comma: copied from a chat app
  await page.click("#startBtn");
  const err2 = await page.textContent("#err");
  check("malformed key -> format error, key not echoed, no connection", /格式不对/.test(err2) && !/abc/.test(err2) && rejected + conns.length === before, err2);
  await page.fill("#key", "  Token good\u3000key\u00a0 ");      // "Token " prefix, full-width space, NBSP
  const goodBefore = conns.filter((c) => c.key === "goodkey").length;
  await page.click("#startBtn");
  const normalised = await until(page, (n) => document.getElementById("key").value === "goodkey" && document.getElementById("status").textContent === "\u6b63\u5728\u6536\u542c", null, 5000);
  check("key normalisation strips 'Token ' and spaces", normalised && conns.filter((c) => c.key === "goodkey").length === goodBefore + 1);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- C: opened straight from disk (file://); a throwing and a hanging translation don't block later lines
{
  const page = await newPage();
  await page.goto(pathToFileURL(INDEX).href + `?dg=${encodeURIComponent(DG)}&fakeAudio=1&trTimeout=1500`);
  await page.fill("#key", "filekey");
  await page.click("#startBtn");
  const ok = await until(page, () => window.__lcl.lines().filter((l) => l.zhState !== "pending").length >= 4, null, 10000);
  const tl = await textLines(page);
  console.log("   ", JSON.stringify(tl.map((l) => [l.src, l.zhState])));
  check("file:// works: capture -> Deepgram -> translated line", ok && tl[0]?.zh === "【译】Hello from file.");
  check("translation that throws -> 翻译失败, queue continues", tl[1]?.zhState === "error");
  check("translation that hangs -> times out, queue continues", tl[2]?.zhState === "error" && tl[3]?.zh === "【译】After that.");
  await page.click("#stopBtn");
  await page.reload();
  check("key remembered after reload", (await page.inputValue("#key")) === "filekey");
  await page.context().close();
}

// ---- D: real Chromium Translator (no stub): must still show the English, with an explanation
{
  const page = await newPage({ stub: false });
  await page.goto(pageUrl());
  console.log("   real Translator in this Chromium:", await page.evaluate(async () => {
    if (!self.Translator) return "absent";
    try { return await self.Translator.availability({ sourceLanguage: "en", targetLanguage: "zh" }); } catch (e) { return "error " + e.message; }
  }));
  console.log("   prepMsg on load:", await page.textContent("#prepMsg"));
  await page.fill("#key", "nolkey");
  await page.click("#startBtn");
  check("without a translator the English still shows", await until(page, () => /No translator here\./.test(document.querySelector("#captions .line:not(.interim) .src")?.textContent || ""), null, 8000));
  check("…and says the translation is not ready", /翻译未就绪/.test(await page.textContent("#captions .line:not(.interim) .zh")));
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- E: page hidden behind Feishu (Chrome stops requestAnimationFrame) + double click on start
{
  const page = await newPage();
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  await page.goto(pageUrl());
  await page.fill("#key", "hidkey");
  await page.evaluate(() => { const b = document.getElementById("startBtn"); b.click(); b.click(); });
  check("captions update without requestAnimationFrame (occluded window)",
    await until(page, () => /【译】Still updating\./.test(document.querySelector("#captions .line:not(.interim) .zh")?.textContent || ""), null, 8000));
  await sleep(1000);
  check("double click on start opens one stream", conns.filter((c) => c.key === "hidkey").length === 1);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- F: server stops answering while audio keeps flowing -> watchdog reconnects, gap marked
{
  const page = await newPage();
  await page.goto(pageUrl("&stall=3000"));
  await page.fill("#key", "stallkey");
  await page.click("#startBtn");
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "Back again."), null, 12000);
  const kinds = await page.evaluate(() => window.__lcl.lines().map((l) => l.kind + ":" + l.src.slice(0, 12)));
  check("stalled connection is detected and replaced", back && conns.filter((c) => c.key === "stallkey").length === 2, kinds.join(" | "));
  check("stall leaves a gap marker", kinds.some((k) => k.startsWith("gap:")));
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- G: network blip mid-question after the key worked: keep the visible text, retry fast, alarm in PiP
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "blipkey");
  await page.click("#prepBtn");
  await until(page, () => /翻译已就绪/.test(document.getElementById("prepMsg").textContent), null, 5000);
  const pip = await openPip(page);
  await page.click("#startBtn");
  const cutOk = await until(page, () => window.__lcl.lines().some((l) => l.cut && l.src === "So how would you handle a conflict" && l.zhState === "ok"), null, 8000);
  check("text on screen when the connection dropped is kept, marked and translated", cutOk);
  await sleep(1500);
  check("after the key worked, a failed handshake reads as network, not Key", /网络中断/.test(await page.textContent("#err")), await page.textContent("#err"));
  if (pip) {
    await sleep(1600);
    const b = await pipText(page, "pipBanner");
    check("floating window alarms during the outage, with a retry button", !!b && b.length > 0 && (await pipText(page, "pipRetry")) === "立即重连", b);
  }
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "Welcome back."), null, 12000);
  const [b1, b2] = conns.filter((c) => c.key === "blipkey");
  check("reconnects within ~8 s of a 3-attempt outage (short capped backoff)", back && b2 && b2.openedAt - b1.closedAt < 9500, b2 ? `${b2.openedAt - b1.closedAt} ms` : "no reconnect");
  await sleep(300);
  if (pip) check("alarm clears after reconnect", (await pipText(page, "pipBanner")) === "");
  await page.screenshot({ path: `${OUT}/lite-blip.png` });
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- H: connected but the captured audio is silent (headset switched device): yellow, non-dimming notice in PiP
{
  const page = await newPage();
  await page.goto(pageUrl("&silence=1500").replace("fakeAudio=1", "fakeAudio=silent"));
  await page.fill("#key", "quietkey");
  const pip = await openPip(page);
  await page.click("#startBtn");
  await sleep(2500);
  if (pip) {
    const st = await page.evaluate(() => { const d = window.documentPictureInPicture.window.document;
      return { banner: d.getElementById("pipBanner").className + "|" + d.getElementById("pipBannerText").textContent, stale: d.body.classList.contains("stale"), dot: d.getElementById("pipDot").className }; });
    check("silent capture -> yellow notice in floating window, captions not dimmed", /warn/.test(st.banner) && /没有会议声音/.test(st.banner) && !st.stale && /wait/.test(st.dot), JSON.stringify(st));
  }
  check("silent capture -> tab title says so", /没有会议声音/.test(await page.title()), await page.title());
  await page.evaluate(() => window.__lcl.setFakeLevel(1));
  await sleep(600);
  if (pip) check("notice clears when audio comes back", (await pipText(page, "pipBanner")) === "");
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- I: handshake hangs after a drop; 立即重连 abandons it and connects at once
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "hangkey");
  await page.click("#startBtn");
  await until(page, () => window.__lcl.lines().some((l) => l.src === "Before hang."), null, 8000);
  await until(page, () => !document.getElementById("retryBtn").classList.contains("hidden"), null, 5000);
  await sleep(1500); // the second handshake is hanging now
  const t0 = Date.now();
  await page.click("#retryBtn");
  const ok = await until(page, () => window.__lcl.lines().some((l) => l.src === "After retry."), null, 5000);
  check("立即重连 during a hung handshake reconnects at once", ok && hung.length === 1 && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- J: speech, then the socket dies quietly and resets later: the gap marker still covers the lost speech
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "gapkey");
  await page.click("#startBtn");
  await until(page, () => window.__lcl.lines().some((l) => l.src === "Before the drop."), null, 8000);
  await sleep(1000);
  await page.evaluate(() => window.__lcl.setFakeLevel(0)); // the question ended before the reset arrived
  const back = await until(page, () => window.__lcl.lines().some((l) => l.src === "Back again."), null, 10000);
  const kinds = await page.evaluate(() => window.__lcl.lines().map((l) => l.kind));
  check("late reset after speech -> gap marker", back && kinds.join(",") === "text,gap,text", kinds.join(","));
  await page.click("#stopBtn");
  await page.context().close();
}

// ---- K: a Deepgram Error message the stream survives is shown, then cleared when results flow again
{
  const page = await newPage();
  await page.goto(pageUrl());
  await page.fill("#key", "errkey");
  await page.click("#startBtn");
  const shownErr = await until(page, () => /mock hiccup/.test(document.getElementById("err").textContent), null, 5000);
  const cleared = await until(page, () => window.__lcl.lines().some((l) => l.src === "Still fine.") && document.getElementById("err").textContent === "", null, 5000);
  check("non-fatal Deepgram Error shown, then cleared", shownErr && cleared);
  await page.click("#stopBtn");
  check("stop clears stale error text", (await page.textContent("#err")) === "");
  await page.context().close();
}

hung.forEach((h) => h.sock.destroy());
check("no uncaught page errors", errors.length === 0, errors.join(" | "));
await browser.close();
http.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `LITE E2E FAIL (${failed}/${results.length})` : `LITE E2E PASS (${results.length} checks)`);
process.exit(failed ? 1 : 0);
