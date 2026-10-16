import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newCode, newRef, normCode, fmtCode, remaining, dgUrl, sendable, dgRefusal, originOk, Limiter, codeHash,
  validRegistration, validGrant, validNewUser, validTopup, validSettings, loadSettings, DEFAULT_SETTINGS,
  wibDayStart, wibMonthStart, wibDate, fmtMinutes, codeMessage, type Plan,
} from "../src/lib.ts";

// Shared with the page (livecaption/lite lc-core normCode): same inputs must give the same canonical code.
const NORM_VECTORS: [string, string | null][] = [
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

test("codes: format, tolerant normalisation (shared vectors), hash", async () => {
  const c = newCode();
  assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  assert.equal(normCode(" " + c.toLowerCase().replace(/-/g, " ") + "　"), c.replace(/-/g, ""));
  assert.equal(fmtCode(normCode(c)!), c);
  for (const [input, want] of NORM_VECTORS) assert.equal(normCode(input), want, JSON.stringify(input));
  assert.equal((await codeHash("A")).length, 64);
  assert.notEqual(await codeHash("A"), await codeHash("B"));
  assert.notEqual(newCode(), newCode());
  // all-zero and all-one bits map to the ends of the alphabet: 80 bits -> exactly 16 chars
  assert.equal(newCode((n) => new Uint8Array(n)), "0000-0000-0000-0000");
  assert.equal(newCode((n) => new Uint8Array(n).fill(255)), "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  assert.match(newRef(), /^R[0-9A-HJKMNP-TV-Z]{5}$/);
});

test("remaining: quota, expiry, status", () => {
  const now = 1_000_000;
  assert.equal(remaining({ id: 1, quota_ms: 5000, used_ms: 2000, expires_at: null, status: "active" }, now), 3000);
  assert.equal(remaining({ id: 1, quota_ms: null, used_ms: 9e9, expires_at: now + 10, status: "active" }, now), 10);
  assert.equal(remaining({ id: 1, quota_ms: 5000, used_ms: 0, expires_at: now + 10, status: "active" }, now), 10);
  assert.equal(remaining({ id: 1, quota_ms: null, used_ms: 0, expires_at: null, status: "active" }, now), Infinity);
  assert.equal(remaining({ id: 1, quota_ms: 5000, used_ms: 0, expires_at: null, status: "disabled" }, now), 0);
  assert.ok(remaining({ id: 1, quota_ms: 5000, used_ms: 6000, expires_at: null, status: "active" }, now) < 0);
  assert.equal(remaining(undefined, now), 0);
});

test("dgUrl: whitelist only, forced privacy", () => {
  const u = dgUrl("https://api.deepgram.com/v1/listen", new URLSearchParams("lang=zh&diarize=0&model=x&mip_opt_out=false"), 7)!;
  assert.equal(u.searchParams.get("language"), "zh-CN");
  assert.equal(u.searchParams.get("model"), "nova-3");
  assert.equal(u.searchParams.get("mip_opt_out"), "true");
  assert.deepEqual(u.searchParams.getAll("tag"), ["zhiyin", "u7"]);
  assert.equal(u.searchParams.has("diarize"), false);
  assert.equal(dgUrl("https://x/v1/listen", new URLSearchParams("lang=en&diarize=1"), 1)!.searchParams.get("diarize"), "true");
  assert.equal(dgUrl("https://x/v1/listen", new URLSearchParams("lang=fr"), 1), null);
  assert.equal(dgUrl("https://x/v1/listen", new URLSearchParams("diarize=yes"), 1), null);
});

test("close codes", () => {
  for (const c of [1004, 1005, 1006, 1015, 999, 5000]) assert.equal(sendable(c), 1011);
  for (const c of [1000, 1008, 1011, 4401, 4999]) assert.equal(sendable(c), c);
  assert.equal(dgRefusal(402).code, 4503); assert.equal(dgRefusal(401).code, 4503); assert.equal(dgRefusal(403).code, 4503);
  assert.equal(dgRefusal(429).code, 4429); assert.equal(dgRefusal(500).code, 1011); assert.equal(dgRefusal(0).code, 1011);
});

test("origin + limiter", () => {
  assert.ok(originOk("https://a.github.io", "https://a.github.io,null"));
  assert.ok(originOk("null", "https://a.github.io,null"));
  assert.ok(originOk(null, "https://a.github.io"));
  assert.ok(!originOk("https://evil.example", "https://a.github.io"));
  assert.ok(!originOk("null", "https://a.github.io"));
  const l = new Limiter(2, 1000);
  assert.ok(l.hit("k", 0) && l.hit("k", 1)); assert.ok(!l.hit("k", 2)); assert.ok(l.blocked("k", 3)); assert.ok(l.hit("k", 2000));
  assert.ok(!l.blocked("other", 3));
});

test("validators: registration", () => {
  const plans: Plan[] = [{ id: "p1", name: "试用", minutes: 60, days: 30, price: "¥10" }];
  const ok = validRegistration({ name: " 小王 ", contact: "wx: wang", plan_id: "p1", note: "", website: "" }, plans);
  assert.deepEqual(ok, { ok: true, value: { name: "小王", contact: "wx: wang", plan_id: "p1", note: "", honeypot: false } });
  const field = (b: unknown, p: Plan[] = plans) => { const r = validRegistration(b, p); return r.ok ? "ok" : r.field; };
  const base = { name: "小王", contact: "wx: wang", plan_id: "p1", note: "" };
  assert.equal(field({ ...base, name: "" }), "name");
  assert.equal(field({ ...base, name: "   " }), "name");
  assert.equal(field({ ...base, name: "字".repeat(40) }), "ok");      // 40 characters, not bytes
  assert.equal(field({ ...base, name: "字".repeat(41) }), "name");
  assert.equal(field({ ...base, name: 5 }), "name");
  assert.equal(field({ ...base, contact: "ab" }), "contact");
  assert.equal(field({ ...base, contact: "x".repeat(81) }), "contact");
  assert.equal(field({ ...base, note: "x".repeat(201) }), "note");
  assert.equal(field({ ...base, plan_id: "zz" }), "plan_id");
  assert.equal(field({ ...base, plan_id: "" }), "plan_id");        // plans exist: must pick one
  assert.equal(field({ ...base, plan_id: null }, []), "ok");      // no plans configured: none needed
  assert.equal(field("str"), "body");
  assert.equal(field([1]), "body");
  const hp = validRegistration({ ...base, website: "http://x" }, plans);
  assert.ok(hp.ok && hp.value.honeypot);
});

test("validators: grant, new user, top-up", () => {
  assert.deepEqual(validGrant({ minutes: 600, days: 90, note: "微信 ¥50" }), { ok: true, value: { minutes: 600, days: 90, note: "微信 ¥50" } });
  assert.deepEqual(validGrant({ minutes: null, days: "", note: undefined }), { ok: true, value: { minutes: null, days: null, note: "" } });
  assert.deepEqual(validGrant({ minutes: "30", days: "7" }), { ok: true, value: { minutes: 30, days: 7, note: "" } });
  const f = (r: { ok: boolean; field?: string }) => (r.ok ? "ok" : r.field);
  assert.equal(f(validGrant({ minutes: 0 })), "minutes");
  assert.equal(f(validGrant({ minutes: -5 })), "minutes");
  assert.equal(f(validGrant({ minutes: "abc" })), "minutes");
  assert.equal(f(validGrant({ minutes: 1e7 })), "minutes");
  assert.equal(f(validGrant({ days: 4000 })), "days");
  assert.equal(f(validGrant({ note: "x".repeat(201) })), "note");
  assert.equal(f(validNewUser({ name: "", minutes: 10 })), "name");
  assert.equal(f(validNewUser({ name: "小张", contact: "x".repeat(81) })), "contact");
  assert.equal(f(validNewUser({ name: "小张", minutes: 10, days: null })), "ok");
  assert.deepEqual(validTopup({ add_minutes: 30, note: "" }), { ok: true, value: { add_minutes: 30, add_days: 0, note: "" } });
  assert.equal(f(validTopup({ add_minutes: -10 })), "ok"); // corrections allowed; the quota never goes below 0
  assert.equal(f(validTopup({})), "add_minutes");
  assert.equal(f(validTopup({ add_days: -1 })), "add_days");
  assert.equal(f(validTopup({ add_minutes: "x" })), "add_minutes");
});

test("validators: settings", () => {
  let n = 0;
  const id = () => "gen" + ++n;
  const good = { pay_text: " 微信：abc \r\n", registration_open: true, max_streams: 25, usd_per_min: 0.0077,
    plans: [{ name: "试用", minutes: 60, days: 30, price: 10 }, { id: "keep", name: "包月", minutes: null, days: 30, price: "¥99" }, { id: "keep", name: "dup", minutes: 1, days: null, price: "" }] };
  const r = validSettings(good, id);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.pay_text, "微信：abc");
    assert.deepEqual(r.value.plans.map((p) => p.id), ["gen1", "keep", "gen2"]); // missing and duplicate ids are replaced
    assert.equal(r.value.plans[0].price, "10");
    assert.equal(r.value.plans[1].minutes, null);
  }
  const f = (b: unknown) => { const x = validSettings(b, id); return x.ok ? "ok" : x.field; };
  assert.equal(f({ ...good, max_streams: 0 }), "max_streams");
  assert.equal(f({ ...good, max_streams: 61 }), "max_streams");
  assert.equal(f({ ...good, max_streams: 2.5 }), "max_streams");
  assert.equal(f({ ...good, pay_text: "x".repeat(2001) }), "pay_text");
  assert.equal(f({ ...good, pay_text: 5 }), "pay_text");
  assert.equal(f({ ...good, plans: Array(11).fill(good.plans[0]) }), "plans");
  assert.equal(f({ ...good, plans: "x" }), "plans");
  assert.equal(f({ ...good, plans: [{ name: "", minutes: 1 }] }), "plans.0.name");
  assert.equal(f({ ...good, plans: [{ name: "a", minutes: 0 }] }), "plans.0.minutes");
  assert.equal(f({ ...good, plans: [{ name: "a", days: -1 }] }), "plans.0.days");
  assert.equal(f({ ...good, plans: [{ name: "a", price: "x".repeat(31) }] }), "plans.0.price");
  assert.equal(f({ ...good, registration_open: 1 }), "registration_open");
  assert.equal(f({ ...good, usd_per_min: -0.1 }), "usd_per_min");
  assert.equal(f({ ...good, usd_per_min: "0.01" }), "usd_per_min");
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings("{bad"), DEFAULT_SETTINGS);
  assert.equal(loadSettings('{"max_streams":5}').max_streams, 5);
  assert.equal(loadSettings('{"max_streams":5}').usd_per_min, 0.0077);
});

test("WIB (UTC+7) date maths", () => {
  // 2026-10-16 16:59:59.999 UTC = 23:59:59.999 WIB, still the 16th; one ms later it is the 17th in WIB
  const t = Date.UTC(2026, 9, 16, 16, 59, 59, 999);
  assert.equal(wibDate(t), "2026-10-16");
  assert.equal(wibDate(t + 1), "2026-10-17");
  assert.equal(wibDayStart(t), Date.UTC(2026, 9, 15, 17));     // 2026-10-16 00:00 WIB
  assert.equal(wibDayStart(t + 1), Date.UTC(2026, 9, 16, 17)); // 2026-10-17 00:00 WIB
  assert.equal(wibMonthStart(t), Date.UTC(2026, 8, 30, 17));   // 2026-10-01 00:00 WIB
  // 2026-10-31 17:00 UTC is already November 1st in WIB
  assert.equal(wibMonthStart(Date.UTC(2026, 9, 31, 17)), Date.UTC(2026, 9, 31, 17));
  assert.equal(wibMonthStart(Date.UTC(2026, 9, 31, 16, 59)), Date.UTC(2026, 8, 30, 17));
  // January rolls back to December of the previous year correctly
  assert.equal(wibMonthStart(Date.UTC(2027, 0, 1, 3)), Date.UTC(2026, 11, 31, 17));
  for (const now of [t, Date.UTC(2027, 1, 28, 20), Date.UTC(2028, 1, 29, 12)]) {
    assert.ok(wibMonthStart(now) <= wibDayStart(now) && wibDayStart(now) <= now && now - wibDayStart(now) < 86_400_000);
  }
});

test("message text (WeChat-ready)", () => {
  const exp = Date.UTC(2027, 0, 14, 3); // 2027-01-14 10:00 WIB
  const url = "https://1004913938-tech.github.io/ink-surge/zhiyin/";
  assert.equal(codeMessage({ code: "ABCD-EFGH-JKMN-PQRS", left_ms: 600 * 60_000, expires_at: exp, pageUrl: url }),
    "你的知音字幕授权码：ABCD-EFGH-JKMN-PQRS\n额度：600 分钟，有效期至 2027-01-14（先到为准）\n" +
    `用电脑版 Chrome 打开 ${url} → 第 1 步选「用授权码」→ 粘贴 → 开始。同一授权码同时只能在一个页面使用。`);
  assert.match(codeMessage({ code: "X", left_ms: 90 * 60_000, expires_at: null, pageUrl: url }), /\n额度：90 分钟，长期有效\n/);
  assert.match(codeMessage({ code: "X", left_ms: null, expires_at: exp, pageUrl: url }), /\n额度：不限分钟，有效期至 2027-01-14\n/);
  assert.match(codeMessage({ code: "X", left_ms: null, expires_at: null, pageUrl: url }), /\n额度：不限分钟，长期有效\n/);
  const re = codeMessage({ code: "X", left_ms: 12.37 * 60_000, expires_at: null, pageUrl: url, reissue: true });
  assert.ok(re.startsWith("你的知音字幕新授权码（旧码已作废）：X\n剩余额度：12.3 分钟，长期有效\n"), re);
  assert.equal(fmtMinutes(0), "0");
  assert.equal(fmtMinutes(-5), "0");
  assert.equal(fmtMinutes(59_999), "0.9");
  assert.equal(fmtMinutes(36_000_000), "600");
});
