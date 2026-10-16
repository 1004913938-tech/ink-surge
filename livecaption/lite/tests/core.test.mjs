// Unit tests for the pure logic block (<script id="lc-core">) of ../index.html.
// Run: node --test livecaption/lite/tests/core.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

process.env.TZ = "Asia/Jakarta"; // fmtLeft prints local dates; pin the zone (WIB, UTC+7) so the vectors are stable
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = html.match(/<script id="lc-core">([\s\S]*?)<\/script>/)[1];
const sandbox = { module: { exports: {} } };
vm.runInNewContext(src, sandbox);
const LC = sandbox.module.exports;

// Deepgram streaming message builders (shape per Deepgram /v1/listen "Results")
const w = (word, speaker, punct) => ({ word: word.toLowerCase(), punctuated_word: punct ?? word, speaker, start: 0, end: 0, confidence: 0.9 });
const results = (words, { is_final = true, speech_final = false } = {}) => ({
  type: "Results", is_final, speech_final,
  channel: { alternatives: [{ transcript: words.map((x) => x.punctuated_word).join(" "), words }] },
});
const interim = (text) => ({ type: "Results", is_final: false, speech_final: false, channel: { alternatives: [{ transcript: text, words: [] }] } });

function collect(opts = {}) {
  const lines = [], prog = [];
  const asm = LC.createAssembler({ lang: "en", ...opts, onLine: (l) => lines.push({ ...l }), onProgress: (p) => prog.push({ ...p }) });
  return { asm, lines, prog };
}

test("listenUrl: Deepgram params, language mapping, optional diarize, base override", () => {
  const u = new URL(LC.listenUrl(undefined, { lang: "en", diarize: true }));
  assert.equal(u.origin + u.pathname, "wss://api.deepgram.com/v1/listen");
  const p = Object.fromEntries(u.searchParams);
  assert.equal(p.model, "nova-3");
  assert.equal(p.language, "en");
  assert.equal(p.interim_results, "true");
  assert.equal(p.smart_format, "true");
  assert.equal(p.utterance_end_ms, "1000");
  assert.equal(p.vad_events, "true");
  assert.equal(p.diarize, "true");
  assert.equal(p.mip_opt_out, "true", "keep the interviewer's voice out of Deepgram model training");
  assert.ok(!("encoding" in p), "container audio (webm/opus) must not send encoding/sample_rate");
  const z = new URL(LC.listenUrl("ws://localhost:9/v1/listen", { lang: "zh", diarize: false }));
  assert.equal(z.host, "localhost:9");
  assert.equal(z.searchParams.get("language"), "zh-CN");
  assert.equal(z.searchParams.get("diarize"), null);
});

test("runs: split by speaker; CJK joins without spaces", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(LC.runs([
    { text: "Hi,", speaker: 0 }, { text: "there.", speaker: 0 }, { text: "Hello.", speaker: 1 }, { text: "Bye.", speaker: 0 },
  ], "en"))), [{ speaker: 0, text: "Hi, there." }, { speaker: 1, text: "Hello." }, { speaker: 0, text: "Bye." }]);
  assert.equal(LC.runs([{ text: "你好", speaker: 0 }, { text: "世界。", speaker: 0 }], "zh")[0].text, "你好世界。");
});

test("speakerNamer: first voice heard is 1, stable afterwards, undefined stays unnamed", () => {
  const n = LC.speakerNamer();
  assert.equal(n(3), 1);
  assert.equal(n(0), 2);
  assert.equal(n(3), 1);
  assert.equal(n(undefined), null);
});

test("assembler: interim shows progress, is_final accumulates, speech_final commits", () => {
  const { asm, lines, prog } = collect();
  asm.handle(interim("tell me"));
  assert.deepEqual(prog.at(-1), { stable: "", interim: "tell me" });
  asm.handle(results([w("Tell", 0), w("me", 0), w("about", 0)]));
  assert.equal(lines.length, 0);
  assert.deepEqual(prog.at(-1), { stable: "Tell me about", interim: "" });
  asm.handle(interim("yourself"));
  assert.deepEqual(prog.at(-1), { stable: "Tell me about", interim: "yourself" });
  asm.handle(results([w("yourself", 0, "yourself.")], { speech_final: true }));
  assert.deepEqual(lines, [{ id: 1, speaker: 0, text: "Tell me about yourself.", cut: false }]);
  assert.deepEqual(prog.at(-1), { stable: "", interim: "" });
});

test("assembler: one utterance with two speakers becomes two lines", () => {
  const { asm, lines } = collect();
  asm.handle(results([w("Thanks.", 0), w("Sure,", 1), w("go", 1), w("ahead.", 1)], { speech_final: true }));
  assert.deepEqual(lines.map((l) => [l.id, l.speaker, l.text]), [[1, 0, "Thanks."], [2, 1, "Sure, go ahead."]]);
});

test("assembler: UtteranceEnd commits when speech_final never came (noisy audio)", () => {
  const { asm, lines } = collect();
  asm.handle(results([w("What", 0), w("is", 0), w("your", 0), w("salary", 0), w("expectation?", 0)]));
  asm.handle({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 2.5 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "What is your salary expectation?");
  asm.handle({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 2.5 }); // nothing pending: no empty line
  assert.equal(lines.length, 1);
});

test("assembler: long monologue is cut at a sentence end after maxWords", () => {
  const { asm, lines } = collect({ maxWords: 5 });
  asm.handle(results([w("one", 0), w("two", 0), w("three", 0), w("four", 0), w("five", 0), w("six", 0)]));
  assert.equal(lines.length, 0, "no sentence end yet: keep waiting");
  asm.handle(results([w("seven.", 0)]));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "one two three four five six seven.");
});

test("assembler: a mid-sentence pause does not cut the sentence", () => {
  const { asm, lines, prog } = collect();
  asm.handle(results([w("Can", 0), w("you", 0), w("walk", 0), w("me", 0), w("through", 0)], { speech_final: true }));
  assert.equal(lines.length, 0, "no sentence end: keep the words, show them as in progress");
  assert.equal(prog.at(-1).stable, "Can you walk me through");
  asm.handle(results([w("your", 0), w("last", 0), w("project?", 0)], { speech_final: true }));
  assert.deepEqual(lines.map((l) => l.text), ["Can you walk me through your last project?"]);
  // an unpunctuated pause still ends at UtteranceEnd
  asm.handle(results([w("Okay", 0), w("so", 0)], { speech_final: true }));
  asm.handle({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 9 });
  assert.equal(lines.at(-1).text, "Okay so");
});

test("assembler: hard cap without punctuation", () => {
  const { asm, lines } = collect({ maxWords: 3 });
  asm.handle(results(["a", "b", "c", "d", "e"].map((x) => w(x, 0))));
  assert.equal(lines.length, 0);
  asm.handle(results([w("f", 0)]));
  assert.equal(lines[0].text, "a b c d e f");
});

test("assembler: ignores Metadata / SpeechStarted / garbage; flush commits leftovers", () => {
  const { asm, lines, prog } = collect();
  asm.handle({ type: "Metadata", request_id: "x" });
  asm.handle({ type: "SpeechStarted", timestamp: 1 });
  asm.handle(null);
  asm.handle("nope");
  asm.handle({ type: "Results" });
  assert.equal(prog.length, 0);
  asm.handle(results([w("Okay", undefined)]));
  asm.flush();
  assert.deepEqual(lines, [{ id: 1, speaker: undefined, text: "Okay", cut: false }]);
  asm.flush();
  assert.equal(lines.length, 1);
});

test("assembler: final with transcript but no word list still captured", () => {
  const { asm, lines } = collect();
  asm.handle({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: "Good morning." }] } });
  assert.equal(lines[0].text, "Good morning.");
});

test("closeReason: never-opened vs auth vs balance vs undecodable audio vs normal", () => {
  assert.match(LC.closeReason(false, 1006, ""), /Key/);
  assert.match(LC.closeReason(false, 1006, ""), /余额/);
  assert.match(LC.closeReason(true, 1000, "Unauthorized"), /拒绝/);
  assert.match(LC.closeReason(true, 1011, "Insufficient credits"), /余额/);
  assert.match(LC.closeReason(true, 1008, ""), /音频/, "1008 is DATA-0000 (undecodable audio), not a bad key");
  assert.equal(LC.closeReason(true, 1000, ""), "");
});

test("retryDelay: fast and capped once the key has worked; backs off when it never did", () => {
  assert.deepEqual([0, 1, 2, 3, 10].map((f) => LC.retryDelay(f, true)), [500, 1000, 2000, 4000, 4000]);
  assert.deepEqual([1, 2, 3, 9].map((f) => LC.retryDelay(f, false)), [2000, 4000, 30000, 30000]);
});

test("flush on a dropped connection keeps the visible interim text and marks the line cut", () => {
  const { asm, lines, prog } = collect();
  asm.handle(results([w("So", 0), w("how", 0), w("would", 0), w("you", 0)]));
  asm.handle({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "handle a conflict", words: [w("handle", 0), w("a", 0), w("conflict", 0)] }] } });
  asm.flush();
  assert.deepEqual(lines, [{ id: 1, speaker: 0, text: "So how would you handle a conflict", cut: true }]);
  assert.deepEqual(prog.at(-1), { stable: "", interim: "" });
  // only interim text on screen (no final words yet)
  asm.handle(interim("Why did you leave"));
  asm.flush();
  assert.equal(lines.at(-1).text, "Why did you leave");
  assert.equal(lines.at(-1).cut, true);
  // nothing pending: no line, and a normal commit is not "cut"
  asm.flush();
  asm.handle(results([w("Thanks.", 0)], { speech_final: true }));
  assert.equal(lines.length, 3);
  assert.equal(lines.at(-1).cut, false);
});

// ---------------------------------------------------------------- 授权码 (access code) mode helpers
// normCode: the same vectors as the server's test/lib.test.ts (livecaption/server), so page and server agree
test("normCode: tolerant input, same vectors as the server", () => {
  const c = "7K3M-9QX2-HJ4T-WZ8P";
  assert.equal(LC.normCode(" " + c.toLowerCase().replace(/-/g, " ") + "　"), c.replace(/-/g, ""));
  assert.equal(LC.normCode("OIL0-0000-0000-0000"), "0110000000000000");
  assert.equal(LC.normCode("too-short"), null);
  assert.equal(LC.normCode("UUUU-UUUU-UUUU-UUUU"), null);
  // more of what a friend pastes from WeChat: NBSP, tabs, no dashes, lower case l / o
  assert.equal(LC.normCode("7k3m 9qx2\thj4t-wz8p"), "7K3M9QX2HJ4TWZ8P");
  assert.equal(LC.normCode("zyzy-test-oooo-ooo1"), "ZYZYTEST00000001");
  assert.equal(LC.normCode("7K3M-9QX2-HJ4T-WZ8P-0"), null, "17 chars");
  assert.equal(LC.normCode(""), null);
  assert.equal(LC.normCode(undefined), null);
  assert.equal(LC.fmtCode("ZYZYTEST00000001"), "ZYZY-TEST-0000-0001");
  assert.equal(LC.fmtCode(null), "");
  // NORM_VECTORS, copied verbatim from livecaption/server/test/lib.test.ts
  const NORM_VECTORS = [
    ["ABCD-EFGH-JKMN-PQRS", "ABCDEFGHJKMNPQRS"],
    ["abcd-efgh-jkmn-pqrs", "ABCDEFGHJKMNPQRS"],
    ["  abcd efgh jkmn pqrs  ", "ABCDEFGHJKMNPQRS"],
    ["ABCD　EFGH　JKMN　PQRS", "ABCDEFGHJKMNPQRS"], // full-width spaces
    ["ABCD—EFGH–JKMN－PQRS", "ABCDEFGHJKMNPQRS"],             // em dash, en dash, full-width hyphen
    ["OIL0-0000-0000-0000", "0110000000000000"],              // O->0, I/L->1
    ["oil0 0000 0000 0000", "0110000000000000"],
    ["ABCDEFGHJKMNPQRS", "ABCDEFGHJKMNPQRS"],
    ["ABCD-EFGH-JKMN-PQR", null],                              // 15 chars
    ["ABCD-EFGH-JKMN-PQRST", null],                            // 17 chars
    ["UUUU-UUUU-UUUU-UUUU", null],                             // U is not Crockford
    ["ABCD-EFGH-JKMN-PQR!", null],
    ["", null],
  ];
  for (const [input, want] of NORM_VECTORS) assert.equal(LC.normCode(input), want, JSON.stringify(input));
});

const serverLib = new URL("../../server/src/lib.ts", import.meta.url);
test("normCode: identical to the server's implementation on random input", { skip: !existsSync(serverLib) && "livecaption/server/src/lib.ts not present" }, async () => {
  const S = await import(serverLib.href);
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz - 　\t_." +
    "‐‑‒–—―−－ー‖"; // + every dash either side might strip (en/em, minus, full-width ...)
  for (let i = 0; i < 5000; i++) {
    const n = 12 + Math.floor(Math.random() * 12);
    let s = ""; for (let j = 0; j < n; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    assert.equal(LC.normCode(s), S.normCode(s), JSON.stringify(s));
  }
  for (let i = 0; i < 200; i++) { const c = S.newCode(); assert.equal(LC.normCode(c.toLowerCase()), c.replace(/-/g, "")); assert.equal(LC.fmtCode(LC.normCode(c)), c); }
});

// regression: the admin page's main button copies the whole WeChat message, and WeChat's 复制 on the bubble does too;
// pasting that used to give 「授权码格式不对」
const PAGE = "https://1004913938-tech.github.io/ink-surge/zhiyin/";
test("pickCode: the code alone, or the first code in the owner's whole message", () => {
  const msg = "你的知音字幕授权码：7K3M-9QX2-HJ4T-WZ8P\n额度：600 分钟，有效期至 2027-01-14（先到为准）\n" +
    `用电脑版 Chrome 打开 ${PAGE} → 第 1 步选「用授权码」→ 粘贴 → 开始。同一授权码同时只能在一个页面使用。`;
  assert.equal(LC.pickCode(msg), "7K3M9QX2HJ4TWZ8P");
  assert.equal(LC.pickCode(msg.replace(/\n/g, "")), "7K3M9QX2HJ4TWZ8P", "an <input> drops the line breaks of a paste");
  assert.equal(LC.pickCode(msg.split("\n")[0]), "7K3M9QX2HJ4TWZ8P", "first line only");
  assert.equal(LC.pickCode("授权码 7k3m 9qx2 hj4t wz8p 谢谢"), "7K3M9QX2HJ4TWZ8P");
  assert.equal(LC.pickCode("code:7K3M9QX2HJ4TWZ8P."), "7K3M9QX2HJ4TWZ8P");
  // the code alone keeps working exactly as normCode (same vectors)
  for (const s of ["7K3M-9QX2-HJ4T-WZ8P", " 7k3m 9qx2 hj4t wz8p ", "OIL0-0000-0000-0000"]) assert.equal(LC.pickCode(s), LC.normCode(s));
  // no code in it: nothing picked (the page link and dates are not codes)
  assert.equal(LC.pickCode(`用电脑版 Chrome 打开 ${PAGE} → 开始`), null);
  assert.equal(LC.pickCode("额度：600 分钟，有效期至 2027-01-14"), null);
  assert.equal(LC.pickCode("7K3M-9QX2-HJ4T"), null, "incomplete");
  assert.equal(LC.pickCode("ABCDEFGHJKMNPQRSTV"), null, "a longer run of letters is not cut into a code");
  assert.equal(LC.pickCode("UUUU-UUUU-UUUU-UUUU 7K3M-9QX2-HJ4T-WZ8P"), "7K3M9QX2HJ4TWZ8P", "skips a code-shaped group that is not a code");
  assert.equal(LC.pickCode(""), null);
  assert.equal(LC.pickCode(undefined), null);
});

test("pickCode: finds the code in every message the server writes", { skip: !existsSync(serverLib) && "livecaption/server/src/lib.ts not present" }, async () => {
  const S = await import(serverLib.href);
  for (let i = 0; i < 300; i++) {
    const code = S.newCode(), canon = code.replace(/-/g, "");
    const m = S.codeMessage({ code, left_ms: i % 3 ? i * 60_000 : null, expires_at: i % 2 ? Date.UTC(2027, 0, 14) : null, pageUrl: PAGE, reissue: i % 5 === 0 });
    assert.equal(LC.pickCode(m), canon, m);
    assert.equal(LC.pickCode(m.replace(/\n/g, "")), canon);
  }
});

test("serverFrom / dgFrom: build-time meta, overrides honoured for localhost only", () => {
  assert.equal(LC.serverFrom("", null), "");
  assert.equal(LC.serverFrom("https://zhiyin-api.abc.workers.dev", null), "https://zhiyin-api.abc.workers.dev");
  assert.equal(LC.serverFrom(" https://zhiyin-api.abc.workers.dev/ ", ""), "https://zhiyin-api.abc.workers.dev");
  assert.equal(LC.serverFrom("https://zhiyin-api.abc.workers.dev", "http://127.0.0.1:8799"), "http://127.0.0.1:8799");
  assert.equal(LC.serverFrom("", "http://localhost:3000"), "http://localhost:3000");
  for (const evil of ["https://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "http://127.0.0.1:8799/x",
    "http://evil.example#@127.0.0.1", "javascript:alert(1)", "ws://127.0.0.1:1"]) {
    assert.equal(LC.serverFrom("", evil), "", evil);
    assert.equal(LC.serverFrom("https://a.workers.dev", evil), "https://a.workers.dev", evil);
  }
  for (const bad of ["http://plain-http.example", "https://a.example/path", "https://a.example?x", "javascript:alert(1)"]) assert.equal(LC.serverFrom(bad, null), "", bad);
  assert.equal(LC.dgFrom(null), LC.DG_DEFAULT);
  assert.equal(LC.dgFrom("ws://127.0.0.1:9/v1/listen"), "ws://127.0.0.1:9/v1/listen");
  assert.equal(LC.dgFrom("ws://localhost:9"), "ws://localhost:9");
  for (const evil of ["wss://evil.example/v1/listen", "ws://localhost.evil.example/v1/listen", "ws://127.0.0.1:9/v1/listen?x=1", "http://127.0.0.1:9"]) assert.equal(LC.dgFrom(evil), LC.DG_DEFAULT, evil);
});

test("relayUrl: ws(s) to /v1/listen with only lang and diarize", () => {
  assert.equal(LC.relayUrl("https://zhiyin-api.abc.workers.dev", { lang: "en", diarize: false }), "wss://zhiyin-api.abc.workers.dev/v1/listen?lang=en&diarize=0");
  const u = new URL(LC.relayUrl("http://127.0.0.1:8799", { lang: "zh", diarize: true }));
  assert.equal(u.protocol + "//" + u.host + u.pathname, "ws://127.0.0.1:8799/v1/listen");
  assert.deepEqual([...u.searchParams], [["lang", "zh"], ["diarize", "1"]]);
});

test("relayClose: stop vs wait vs reconnect per server close code", () => {
  const never = LC.relayClose(false, 1006);
  assert.deepEqual({ ...never, msg: "" }, { stop: false, msg: "", delay: 0 });
  assert.match(never.msg, /连不上知音服务器/);
  for (const [code, re] of [[4400, /刷新/], [4401, /授权码无效或已停用/], [4402, /用完|到期/], [4409, /另一个页面或设备/]]) {
    const r = LC.relayClose(true, code);
    assert.equal(r.stop, true, String(code)); assert.match(r.msg, re); assert.equal(r.delay, 0);
  }
  const busy = LC.relayClose(true, 4429), paused = LC.relayClose(true, 4503);
  assert.equal(busy.stop, false); assert.equal(busy.delay, 30000); assert.match(busy.msg, /繁忙/);
  assert.equal(paused.stop, false); assert.equal(paused.delay, 60000); assert.match(paused.msg, /识别服务暂停，请联系店主/);
  // 4413 (server: audio sent faster than real time, only a script does that): a normal reconnect, never a permanent stop
  for (const code of [1000, 1006, 1011, 1012, 4413, 0]) assert.deepEqual({ ...LC.relayClose(true, code) }, { stop: false, msg: "", delay: 0 }, String(code));
  const data = LC.relayClose(true, 1008);
  assert.equal(data.stop, false); assert.match(data.msg, /音频/);
});

test("fmtLeft: remaining time and expiry date, in words", () => {
  const now = Date.UTC(2026, 9, 16, 5, 0); // 12:00 WIB
  const day = 86400000, hour = 3600000, min = 60000;
  assert.equal(LC.fmtLeft((9 * 60 + 12) * min + 30000, Date.UTC(2027, 0, 14, 5), now), "剩余 9 小时 12 分 · 有效期至 2027-01-14");
  assert.equal(LC.fmtLeft(600 * min, now + 30 * day, now), "剩余 10 小时 0 分 · 有效期至 2026-11-15");
  assert.equal(LC.fmtLeft(45 * min + 59000, null, now), "剩余 45 分钟");
  assert.equal(LC.fmtLeft(30000, null, now), "剩余不到 1 分钟");
  assert.equal(LC.fmtLeft(null, null, now), "不限时长");
  assert.equal(LC.fmtLeft(0, null, now), "时长已用完或已到期");
  assert.equal(LC.fmtLeft(-5, now + day, now), "时长已用完或已到期");
  // the expiry date is the limit and far away: say so instead of "剩余 720 小时"
  assert.equal(LC.fmtLeft(30 * day, now + 30 * day, now), "期内不限时长 · 有效期至 2026-11-15");
  // ending within 2 days: the hour matters
  assert.equal(LC.fmtLeft(5 * hour, now + 5 * hour, now), "剩余 5 小时 0 分 · 有效期至 2026-10-16 17:00");
});

test("meInfo: /api/me body -> line under the code input", () => {
  const now = Date.UTC(2026, 9, 16, 5, 0);
  assert.deepEqual({ ...LC.meInfo({ status: "active", quota_ms: 6e6, used_ms: 24e5, expires_at: null, remaining_ms: 36e5, live: false }, now) }, { text: "剩余 1 小时 0 分", bad: false });
  assert.deepEqual({ ...LC.meInfo({ status: "active", quota_ms: null, used_ms: 0, expires_at: null, remaining_ms: null }, now) }, { text: "不限时长", bad: false });
  const off = LC.meInfo({ status: "disabled", remaining_ms: 0 }, now), used = LC.meInfo({ status: "active", remaining_ms: 0 }, now);
  assert.ok(off.bad && /停用/.test(off.text)); assert.ok(used.bad && /用完/.test(used.text));
  assert.equal(LC.meInfo(null, now).bad, true);
});

test("planLabel / regCheck / regError: registration dialog text", () => {
  assert.equal(LC.planLabel({ id: "p2", name: "包月", minutes: 600, days: 30, price: "¥50" }), "包月 · 600 分钟（30 天内有效） · ¥50");
  assert.equal(LC.planLabel({ id: "y", name: "年卡", minutes: null, days: 365, price: "¥300" }), "年卡 · 365 天内不限时长 · ¥300");
  assert.equal(LC.planLabel({ id: "m", name: "按量", minutes: 120, days: null, price: "" }), "按量 · 120 分钟（长期有效）");
  assert.equal(LC.planLabel({ id: "n", name: "试用", minutes: null, days: null, price: 0 }), "试用 · 不限时长 · 0");
  assert.equal(LC.planLabel(null), "");
  const ok = { name: "小王", contact: "wx_xiaowang", note: "" };
  assert.equal(LC.regCheck(ok), "");
  assert.equal(LC.regCheck({ ...ok, name: "" }), "name");
  assert.equal(LC.regCheck({ ...ok, name: "名".repeat(41) }), "name");
  assert.equal(LC.regCheck({ ...ok, contact: "ab" }), "contact");
  assert.equal(LC.regCheck({ ...ok, note: "x".repeat(201) }), "note");
  assert.match(LC.regError(400, { error: "invalid_input", field: "contact" }), /联系方式/);
  assert.match(LC.regError(400, {}), /有误/);
  assert.match(LC.regError(429, { error: "rate_limited" }), /太频繁.*1 小时/);
  assert.match(LC.regError(403, { error: "registration_closed" }), /关闭/);
  assert.match(LC.regError(503, { error: "too_many_pending" }), /太多/);
  assert.match(LC.regError(0), /连不上/);
  assert.match(LC.regError(500), /500/);
});
