// Full chain (spec §11.4): the real page (livecaption/lite/index.html) in Chromium -> `wrangler dev` running this server
// -> test/mock-deepgram.mjs. One friend and the owner, end to end:
//   friend applies in the page -> owner approves through the admin API -> friend types the code from the WeChat message
//   -> captions through the relay -> minutes run out mid-stream (4402): the page stops with the right Chinese message and
//   does NOT reconnect -> /api/me shows the minutes used -> owner tops up -> captions again -> the same code on a second
//   device (4409) -> owner disables the code (4401).
// Run from livecaption/server:  LC_DEPS=<dir whose node_modules has playwright> node test/fullchain.mjs
// Optional: CHROMIUM=<executable> (default /opt/pw-browsers/chromium if present), OUT=<dir for screenshots>,
// LC_INDEX=<another build of the page, e.g. the one pages.yml produced>.
// No Cloudflare or Deepgram account: fake secrets in a temporary .dev.vars-format file passed with --env-file, so a
// developer's own livecaption/server/.dev.vars is never read or touched. The admin Bearer password is read from that file.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INDEX = process.env.LC_INDEX || join(ROOT, "../lite/index.html");
let chromium;
try { ({ chromium } = createRequire(join(process.env.LC_DEPS || ROOT, "noop.js"))("playwright")); }
catch { console.error("fullchain needs Playwright: LC_DEPS=<dir whose node_modules has playwright> node test/fullchain.mjs"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? "  " + JSON.stringify(extra) : ""}`); };
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const wibDate = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10); // the server writes dates in WIB (UTC+7)

// ------------------------------------------------------------ the page, served like GitHub Pages serves it
const pageSrv = httpServer((req, res) => {
  if (new URL(req.url, "http://x").pathname !== "/ink-surge/zhiyin/") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(INDEX));
});
await new Promise((r) => pageSrv.listen(0, "127.0.0.1", r));
const PAGE_ORIGIN = `http://127.0.0.1:${pageSrv.address().port}`, PAGE_URL = PAGE_ORIGIN + "/ink-surge/zhiyin/";

// ------------------------------------------------------------ mock Deepgram + wrangler dev
const PORT = await freePort(), MOCK_PORT = await freePort(), INSPECT = await freePort();
const W = `http://127.0.0.1:${PORT}`, MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "zy-fullchain-"));
const DEV_VARS = join(TMP, ".dev.vars");
writeFileSync(DEV_VARS, `DEEPGRAM_API_KEY=testkey\nADMIN_PASSWORD=fullchain-${randomBytes(12).toString("hex")}\n`);
const ADMIN = Object.fromEntries(readFileSync(DEV_VARS, "utf8").split("\n").filter((l) => l.includes("="))
  .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])).ADMIN_PASSWORD;

const mock = spawn(process.execPath, [join(ROOT, "test/mock-deepgram.mjs"), String(MOCK_PORT)], { stdio: ["ignore", "ignore", "inherit"] });
const noProxy = (v) => [v, "127.0.0.1,localhost"].filter(Boolean).join(",");
const dev = spawn(join(ROOT, "node_modules/.bin/wrangler"), ["dev", "--port", String(PORT), "--ip", "127.0.0.1", "--inspector-port", String(INSPECT),
  "--persist-to", join(TMP, "state"), "--env-file", DEV_VARS, "--var", `DG_URL:${MOCK}/v1/listen`, "--var", "FLUSH_MS:500",
  "--var", `ALLOWED_ORIGINS:${PAGE_ORIGIN}`, "--var", `PUBLIC_PAGE_URL:${PAGE_URL}`, "--show-interactive-dev-session=false", "--log-level", "warn"],
{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_PROXY: noProxy(process.env.NO_PROXY), no_proxy: noProxy(process.env.no_proxy) } });
dev.stdout.on("data", () => {});
dev.stderr.on("data", (d) => { if (/error/i.test(d) && !/Network connection lost/.test(d)) process.stderr.write(d); });

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(W + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: j };
}
const admin = (path, body, method) => call("/admin/api" + path, { method: method ?? (body !== undefined ? "POST" : "GET"), body, headers: { Authorization: "Bearer " + ADMIN } });
const me = (code) => call("/api/me", { headers: { Origin: PAGE_ORIGIN, Authorization: "Bearer " + code } });
const seen = () => fetch(MOCK + "/seen").then((r) => r.json());

// ------------------------------------------------------------ browser: one context per device, WebSocket spy
const WS_SPY = () => {
  const Native = window.WebSocket;
  window.__ws = [];
  function Spy(url, protocols) {
    const s = new Native(url, protocols), rec = { url: String(url), protocols, protocol: null, closeCode: null };
    window.__ws.push(rec);
    s.addEventListener("open", () => { rec.protocol = s.protocol; });
    s.addEventListener("close", (e) => { rec.closeCode = e.code; });
    return s;
  }
  Spy.prototype = Native.prototype;
  Object.assign(Spy, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Spy;
};
const CHROMIUM = process.env.CHROMIUM || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
let browser;
const pageErrors = [];
async function device() {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  await ctx.addInitScript(WS_SPY);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(e.message));
  await p.goto(PAGE_URL + "?server=" + encodeURIComponent(W) + "&fakeAudio=1");
  return p;
}
const until = (p, fn, arg, timeout = 10_000) => p.waitForFunction(fn, arg, { timeout, polling: 100 }).then(() => true, () => false);
const txt = (p, id) => p.textContent("#" + id);
const shot = async (p, name) => {
  if (!process.env.OUT) return;
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: join(process.env.OUT, `fullchain-${name}.png`) });
};
const FRAME_LINE = /^frame \d+ frame \d+ frame \d+ frame \d+\.$/; // the mock ends a sentence every 4th frame
const captionCount = (p) => p.evaluate((re) => window.__lcl.lines().filter((l) => new RegExp(re).test(l.src)).length, FRAME_LINE.source);
const pageState = (p) => p.evaluate(() => ({ status: document.getElementById("status").textContent, err: document.getElementById("err").textContent,
  ws: window.__ws.length, closes: window.__ws.map((w) => w.closeCode), startVisible: !document.getElementById("startBtn").classList.contains("hidden"),
  codeEnabled: !document.getElementById("code").disabled }));

const MSG_4402 = "授权码的时长已用完或已到期，请联系店主续费";
const MSG_4409 = "这个授权码已在另一个页面或设备上开始使用，这里已停止";
const MSG_4401 = "授权码无效或已停用：请检查授权码，或联系店主";

try {
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(W + "/")).ok; } catch { /* not up yet */ } if (!up) await sleep(500); }
  if (!up) throw new Error("wrangler dev did not start");
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });

  // ---------------------------------------------------------- owner: payment text and plans (the 设置 tab)
  const PAY = "微信：zhiyin-shop\n支付宝：138 0000 0000\n<b>付款时请备注申请编号</b>";
  const set = await admin("/settings", { pay_text: PAY, registration_open: true, max_streams: 25, usd_per_min: 0.0077,
    plans: [{ name: "试用 30 分钟", minutes: 30, days: 7, price: "¥5" }, { name: "包月 600 分钟", minutes: 600, days: 30, price: "¥50" }] }, "PUT");
  check("owner: settings saved with the Bearer password from .dev.vars (pay text + 2 plans)", set.status === 200 && set.body.plans.length === 2, set);
  const plans = set.body.plans;

  // ---------------------------------------------------------- friend: opens the page; 授权码 mode is the default
  const p = await device();
  const modeUi = await p.evaluate(() => ({ box: !document.getElementById("modeBox").classList.contains("hidden"),
    code: document.querySelector('input[name="mode"][value="code"]').checked, codePane: !document.getElementById("codePane").classList.contains("hidden"),
    keyPane: !document.getElementById("keyPane").classList.contains("hidden"), server: window.__lcl.server() }));
  check("page: 授权码 mode shown and selected by default (no stored key)", modeUi.box && modeUi.code && modeUi.codePane && !modeUi.keyPane && modeUi.server === W, modeUi);

  // ---------------------------------------------------------- friend: applies through the real /api/config + /api/register
  await p.click("#regBtn");
  const dlgOk = await until(p, () => document.getElementById("regDlg").open && document.querySelectorAll("#regPlan option").length === 2);
  const options = await p.$$eval("#regPlan option", (os) => os.map((o) => [o.value, o.textContent]));
  check("register dialog: plans and prices from /api/config", dlgOk && options[0][0] === plans[0].id &&
    options[0][1] === "试用 30 分钟 · 30 分钟（7 天内有效） · ¥5" && options[1][1] === "包月 600 分钟 · 600 分钟（30 天内有效） · ¥50", options);
  await p.fill("#regName", "小林");
  await p.fill("#regContact", "wx_xiaolin");
  await p.selectOption("#regPlan", plans[0].id);
  await p.fill("#regNote", "付款人 林某");
  await p.click("#regSubmit");
  const refOk = await until(p, () => /^R[0-9A-HJKMNP-TV-Z]{5}$/.test(document.getElementById("regRef").textContent));
  const ref = await txt(p, "regRef");
  const pay = await p.$eval("#regPay", (e) => ({ text: e.textContent, elements: e.children.length, ws: getComputedStyle(e).whiteSpace }));
  check("register: reference shown; pay text as plain text with its line breaks (no HTML)", refOk && pay.text === PAY && pay.elements === 0 && pay.ws === "pre-wrap", { ref, pay });
  check("register: chosen plan and price shown", (await txt(p, "regPlanOut")) === "套餐：试用 30 分钟 · 30 分钟（7 天内有效） · ¥5", await txt(p, "regPlanOut"));
  await shot(p, "1-registered");
  await p.click("#regClose");
  check("page: remembers the reference after closing the dialog", (await txt(p, "regInfo")) === `你的申请编号 ${ref}（待店主确认）`, await txt(p, "regInfo"));

  // ---------------------------------------------------------- owner: sees it, confirms the payment, issues the code
  const ov = (await admin("/overview")).body;
  const row = ov.registrations.find((r) => r.ref === ref);
  check("owner: registration pending with name, contact, note and plan", row?.status === "pending" && row.name === "小林" && row.contact === "wx_xiaolin" &&
    row.note === "付款人 林某" && row.plan_id === plans[0].id && row.plan?.name === "试用 30 分钟", row);
  const QUOTA_MS = 18_000; // a tiny quota so the cut happens inside the test (the plan's days are kept)
  const ap = await admin(`/registrations/${encodeURIComponent(ref)}/approve`, { minutes: QUOTA_MS / 60_000, days: row.plan.days, note: "微信 ¥5" });
  const uid = ap.body?.user?.id;
  const msg = (ap.body?.message ?? "").split("\n");
  const code = (msg[0]?.match(/^你的知音字幕授权码：([0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3})$/) ?? [])[1];
  check("owner: approve -> 201 and a WeChat-ready message (code, amount, WIB expiry, page link)", ap.status === 201 && code === ap.body.code &&
    msg[1] === `额度：0.3 分钟，有效期至 ${wibDate(ap.body.user.expires_at)}（先到为准）` && msg[2] === `用电脑版 Chrome 打开 ${PAGE_URL} → 第 1 步选「用授权码」→ 粘贴 → 开始。同一授权码同时只能在一个页面使用。`, ap.body);

  // ---------------------------------------------------------- friend: pastes the code from the message; the page looks it up
  await p.fill("#code", "  " + code + " ");
  await p.press("#code", "Tab");
  const meOk = await until(p, () => /^剩余不到 1 分钟 · 有效期至 \d{4}-\d\d-\d\d$/.test(document.getElementById("codeInfo").textContent));
  check("page: /api/me with the pasted code -> remaining time and expiry date", meOk && (await p.inputValue("#code")) === code, await txt(p, "codeInfo"));
  const regCleared = await until(p, () => document.getElementById("regInfo").textContent === "" && localStorage.getItem("lcl.regRef") === "");
  check("page: the reference note goes away once the new code works", regCleared, await txt(p, "regInfo"));

  // ---------------------------------------------------------- start: captions through the real relay
  const seenBefore = (await seen()).length;
  await p.click("#startBtn");
  const t0 = Date.now();
  const capOk = await until(p, (re) => window.__lcl.lines().some((l) => new RegExp(re).test(l.src)), FRAME_LINE.source, 12_000);
  const ws0 = await p.evaluate(() => window.__ws[0]);
  const wsUrl = new URL(ws0.url);
  check("start: captions from the mock arrive through the server", capOk && (await txt(p, "status")) === "正在收听", await pageState(p));
  check("start: page connects to /v1/listen?lang&diarize only, protocols [zhiyin.v1, code], server echoes zhiyin.v1",
    wsUrl.origin.replace("ws:", "http:") === W && wsUrl.pathname === "/v1/listen" && [...wsUrl.searchParams.keys()].join() === "lang,diarize" &&
    JSON.stringify(ws0.protocols) === JSON.stringify(["zhiyin.v1", code.replace(/-/g, "")]) && ws0.protocol === "zhiyin.v1", ws0);
  const up0 = (await seen()).slice(seenBefore);
  const upQ = up0.length ? new URL(up0[0].url, "http://x").searchParams : new URLSearchParams();
  check("server -> Deepgram: one upstream with the server key and server-chosen params (nova-3, mip_opt_out, tags)",
    up0.length === 1 && up0[0].auth === "Token testkey" && upQ.get("model") === "nova-3" && upQ.get("mip_opt_out") === "true" &&
    upQ.getAll("tag").join() === `zhiyin,u${uid}`, up0);
  const quotaUi = await until(p, () => document.getElementById("quotaWarn").textContent === "授权码剩余约 1 分钟" &&
    /^剩余不到 1 分钟 · 有效期至 /.test(document.getElementById("codeInfo").textContent), null, 5000);
  check("ZhiYinQuota from the server: remaining time and the low-minutes warning", quotaUi, [await txt(p, "quotaWarn"), await txt(p, "codeInfo")]);
  await shot(p, "2-running");

  // ---------------------------------------------------------- minutes run out mid-stream: 4402, stop for good
  const cut = await until(p, (m) => document.getElementById("err").textContent === m && document.getElementById("status").textContent === "已停止",
    MSG_4402, QUOTA_MS + 10_000);
  const cutAfter = Date.now() - t0;
  const st = await pageState(p);
  check("minutes used up -> server closes with 4402 -> page stops with the right message", cut && st.closes.join() === "4402" && st.startVisible && st.codeEnabled,
    { cutAfter, st });
  check("the cut comes when the quota is used (about 18 s after start)", cutAfter > QUOTA_MS - 1000 && cutAfter < QUOTA_MS + 6000, cutAfter);
  const seenAtCut = (await seen()).length;
  await sleep(10_000);
  const st10 = await pageState(p);
  check("no reconnect within 10 s (no new page socket, no new upstream), still stopped with the message",
    st10.ws === 1 && (await seen()).length === seenAtCut && st10.status === "已停止" && st10.err === MSG_4402, st10);
  check("page: /api/me after the stop says the minutes are used up", (await txt(p, "codeInfo")) === MSG_4402, await txt(p, "codeInfo"));
  const m1 = await me(code);
  check("/api/me: used_ms = the 18 s quota, remaining 0, not live", m1.status === 200 && m1.body.quota_ms === QUOTA_MS && m1.body.used_ms >= QUOTA_MS &&
    m1.body.used_ms < QUOTA_MS + 700 && m1.body.remaining_ms === 0 && m1.body.live === false && m1.body.status === "active", m1.body);
  const h1 = (await admin(`/users/${uid}/sessions`)).body;
  check("owner: session row ended 4402 with the metered ms and bytes; ledger issue row carries ref + note",
    h1.sessions[0]?.end_code === 4402 && Math.abs(h1.sessions[0].ms - m1.body.used_ms) < 50 && h1.sessions[0].bytes_up > 0 &&
    h1.ledger.some((l) => l.kind === "issue" && l.note === `${ref} · 微信 ¥5` && l.add_ms === QUOTA_MS), h1);
  check("code mode never writes the own-key usage estimate (lcl.usageMs)", (await p.evaluate(() => localStorage.getItem("lcl.usageMs"))) === null);
  await shot(p, "3-used-up");

  // ---------------------------------------------------------- owner tops up; the friend starts again without reloading
  const tp = await admin(`/users/${uid}/topup`, { add_minutes: 5, add_days: 0, note: "微信 ¥5 续费" });
  check("owner: top-up +5 minutes", tp.status === 200 && tp.body.user.quota_ms === QUOTA_MS + 5 * 60_000 && tp.body.user.remaining_ms > 4.9 * 60_000, tp.body);
  const before = await captionCount(p);
  await p.click("#startBtn");
  const again = await until(p, ([re, n]) => document.getElementById("status").textContent === "正在收听" && document.getElementById("err").textContent === "" &&
    window.__lcl.lines().filter((l) => new RegExp(re).test(l.src)).length > n, [FRAME_LINE.source, before], 12_000);
  const leftOk = await until(p, () => /^剩余 [45] 分钟 · 有效期至 /.test(document.getElementById("codeInfo").textContent) &&
    /^授权码剩余约 [45] 分钟$/.test(document.getElementById("quotaWarn").textContent), null, 5000);
  check("after the top-up: start again, captions flow, remaining about 5 minutes", again && leftOk, [await pageState(p), await txt(p, "codeInfo"), await txt(p, "quotaWarn")]);

  // ---------------------------------------------------------- the same code on a second device: newest wins (4409)
  const p2 = await device();
  await p2.fill("#code", code);
  await p2.press("#code", "Tab");
  await p2.click("#startBtn");
  const replaced = await until(p, (m) => document.getElementById("err").textContent === m && document.getElementById("status").textContent === "已停止", MSG_4409, 12_000);
  const p2on = await until(p2, (re) => document.getElementById("status").textContent === "正在收听" &&
    window.__lcl.lines().some((l) => new RegExp(re).test(l.src)), FRAME_LINE.source, 12_000);
  await sleep(3000);
  const stA = await pageState(p);
  check("same code on a 2nd device: the first page gets 4409 and stops for good; the second has captions",
    replaced && p2on && stA.closes.at(-1) === 4409 && stA.ws === 2 && stA.status === "已停止" && stA.err === MSG_4409, stA);

  // ---------------------------------------------------------- owner disables the code: 4401 on the live page
  const dis = await admin(`/users/${uid}/status`, { status: "disabled" });
  const off = await until(p2, (m) => document.getElementById("err").textContent === m && document.getElementById("status").textContent === "已停止", MSG_4401, 8000);
  const offInfo = await until(p2, () => document.getElementById("codeInfo").textContent === "授权码已停用，请联系店主", null, 5000);
  const seenOff = (await seen()).length;
  await sleep(4000);
  const stB = await pageState(p2);
  check("owner disables -> 4401 -> page stops, /api/me says 已停用, no reconnect", dis.status === 200 && off && offInfo &&
    stB.closes.join() === "4401" && stB.ws === 1 && (await seen()).length === seenOff, [dis.status, stB, await txt(p2, "codeInfo")]);
  await shot(p2, "4-disabled");
  const ovEnd = (await admin("/overview")).body;
  const uEnd = ovEnd.users.find((u) => u.id === uid);
  check("owner overview: nobody live, the user is disabled, usage kept", ovEnd.live_count === 0 && uEnd.status === "disabled" && !uEnd.live &&
    uEnd.used_ms > QUOTA_MS && uEnd.month_ms >= uEnd.used_ms - 50, uEnd);
  check("no uncaught page errors", pageErrors.length === 0, pageErrors);
} catch (e) {
  console.error(e);
  results.push(false);
} finally {
  await browser?.close().catch(() => {});
  if (dev.exitCode === null) {
    const exited = new Promise((r) => dev.once("exit", r));
    dev.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
  }
  mock.kill();
  pageSrv.close();
  rmSync(TMP, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `FULL CHAIN FAIL (${failed} of ${results.length})` : `FULL CHAIN: ALL ${results.length} PASS`);
process.exit(failed ? 1 : 0);
