import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newCode, newRef, normCode, fmtCode, remaining, dgUrl, sendable, dgRefusal, originOk, Limiter, codeHash,
  validRegistration, validGrant, validNewUser, validTopup, validSettings, loadSettings, DEFAULT_SETTINGS,
  wibDayStart, wibMonthStart, wibDate, fmtMinutes, codeMessage, type Plan,
  ipKey, upBudgetOk, grantExpiry, msSince, UP_BYTES_PER_S, UP_SLACK_BYTES, UP_MSGS_PER_S, UP_SLACK_MSGS,
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
  // regression: names inherited from Object.prototype are not languages (they used to pass the whitelist)
  for (const l of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"])
    assert.equal(dgUrl("https://x/v1/listen", new URLSearchParams("lang=" + l), 1), null, l);
});

test("ipKey: IPv4 as is, IPv6 by /64", () => {
  assert.equal(ipKey("203.0.113.9"), "203.0.113.9");
  assert.equal(ipKey("local"), "local");
  assert.equal(ipKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:DB8:1:2:FFFF::9"), "2001:db8:1:2::/64");          // case and the host part do not matter
  assert.notEqual(ipKey("2001:db8:1:3::1"), ipKey("2001:db8:1:2::1"));        // another /64 is another key
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");                    // "::" inside the prefix
  assert.equal(ipKey("::1"), "0:0:0:0::/64");
  assert.equal(ipKey("::ffff:198.51.100.7"), "198.51.100.7");                // IPv4-mapped
  // a host rotating through its /64 (the reviewer's attack): one key, so the per-address limits hold
  const keys = new Set(Array.from({ length: 50 }, (_, i) => ipKey(`2001:db8:aa:bb:${i.toString(16)}::${(i * 7).toString(16)}`)));
  assert.equal(keys.size, 1);
});

test("Limiter: bounded size, cheap sweep, same answers", () => {
  const l = new Limiter(3, 1000, 100);
  for (let i = 0; i < 1000; i++) l.hit("k" + i, 0);
  assert.ok(l.m.size <= 100, "never more than cap entries");
  assert.ok(l.hit("k999", 1) && l.hit("k999", 2) && !l.hit("k999", 3)); // the newest keys are the ones kept
  assert.ok(l.blocked("k999", 4));
  assert.ok(!l.blocked("k999", 1001) && l.hit("k999", 1001));         // window over: allowed again
  l.hit("x", 5000);
  assert.equal(l.m.size, 1, "expired entries are dropped from the front");
  // many distinct keys inside one window: each hit stays O(1) (it used to walk the whole Map once it held 5000)
  const big = new Limiter(20, 3_600_000);
  const t0 = performance.now();
  for (let i = 0; i < 200_000; i++) big.hit("2001:db8:" + i.toString(16) + "::/64", 1_000_000 + i);
  const ms = performance.now() - t0;
  assert.ok(big.m.size <= 20_000, String(big.m.size));
  assert.ok(ms < 2000, `200k hits took ${ms.toFixed(0)} ms`);
});

test("upload budget: real time passes, bursts do not", () => {
  // the page: one ~250 ms chunk (at most ~4 KB at 128 kbit/s) 4x a second + a KeepAlive every 5 s, for an hour
  for (let t = 250; t <= 3_600_000; t += 250) assert.ok(upBudgetOk((t / 250) * 4000, (t / 250) * 1.05, t), String(t));
  assert.ok(upBudgetOk(UP_SLACK_BYTES, UP_SLACK_MSGS, 0));
  assert.ok(!upBudgetOk(UP_SLACK_BYTES + 1, 1, 0));
  assert.ok(!upBudgetOk(1, UP_SLACK_MSGS + 1, 0));
  assert.ok(upBudgetOk(UP_SLACK_BYTES + 10 * UP_BYTES_PER_S, UP_SLACK_MSGS + 10 * UP_MSGS_PER_S, 10_000));
  assert.ok(!upBudgetOk(2_400 * 4096, 2_400, 700)); // the reviewer's burst: 10 minutes of 4 KB frames in 0.7 s
});

test("grantExpiry: whole days run to the end of the WIB day; less than a day stays exact", () => {
  const now = Date.UTC(2026, 9, 16, 8, 0); // 2026-10-16 15:00 WIB
  const e30 = grantExpiry(now, 30);
  assert.equal(wibDate(e30), "2026-11-15");
  assert.equal(e30, Date.UTC(2026, 10, 15, 16, 59, 59, 999));        // 2026-11-15 23:59:59.999 WIB
  assert.equal(wibDate(e30 + 1), "2026-11-16");
  assert.equal(grantExpiry(e30, 2), e30 + 2 * 86_400_000);             // topping up an end-of-day expiry keeps it end-of-day
  assert.equal(grantExpiry(now, 13 / 86400), now + 13_000);             // seconds (tests) stay exact
  assert.equal(grantExpiry(now, 0.5), now + 43_200_000);
  assert.equal(wibDate(grantExpiry(Date.UTC(2026, 9, 16, 16, 59), 1)), "2026-10-17"); // 23:59 WIB + 1 day = end of the 17th
});

test("msSince: a session across a boundary is split in proportion", () => {
  const b = 1_000_000;
  assert.equal(msSince({ started_at: b, ended_at: b + 500, ms: 500 }, b), 500);             // started at the boundary
  assert.equal(msSince({ started_at: b - 1000, ended_at: b - 10, ms: 990 }, b), 0);          // ended before it
  assert.equal(msSince({ started_at: b - 3000, ended_at: b + 1000, ms: 4000 }, b), 1000);    // 3/4 before, 1/4 after
  assert.equal(msSince({ started_at: b - 3000, ended_at: b + 1000, ms: 8000 }, b), 2000);    // charged > wall (audio): same share
  assert.equal(msSince({ started_at: b - 3000, ended_at: null, ms: 4000 }, b), 1000);        // live: up to its last flush
  assert.equal(msSince({ started_at: b - 3000, ended_at: null, ms: 2000 }, b), 0);
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
    `用电脑版 Chrome 打开 ${url} → 第 1 步粘贴授权码 → 开始。同一授权码同时只能在一个页面使用。`);
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
