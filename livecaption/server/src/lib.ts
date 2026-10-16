// Pure helpers (no Workers APIs except WebCrypto). Erasable TypeScript only, so `node --test` runs it directly.
export const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LANGS: Record<string, string> = { en: "en", id: "id", zh: "zh-CN", ja: "ja", ko: "ko" };
export const PROTO = "zhiyin.v1";
export const MAX_TIMER = 2_147_483_647;
export const MIN_START_MS = 10_000; // refuse a new stream when less than this is left (4402)
export const MIN = 60_000, DAY = 86_400_000, WIB = 7 * 3_600_000;

export type UserRow = { id: number; quota_ms: number | null; used_ms: number; expires_at: number | null; status: string };
export type Plan = { id: string; name: string; minutes: number | null; days: number | null; price: string };
export type Settings = { pay_text: string; plans: Plan[]; registration_open: boolean; max_streams: number; usd_per_min: number };
export const DEFAULT_SETTINGS: Settings = { pay_text: "", plans: [], registration_open: true, max_streams: 25, usd_per_min: 0.0077 };

function crock(bytes: Uint8Array, chars: number): string {
  let bits = 0, acc = 0, out = "";
  for (const x of bytes) { acc = ((acc << 8) | x) & 0xffff; bits += 8; while (bits >= 5 && out.length < chars) { bits -= 5; out += CROCK[(acc >> bits) & 31]; } }
  return out;
}
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
/** 80 random bits -> "XXXX-XXXX-XXXX-XXXX" (Crockford base32; valid WebSocket subprotocol token). */
export function newCode(rand: (n: number) => Uint8Array = rnd): string {
  return crock(rand(10), 16).match(/.{4}/g)!.join("-");
}
/** Registration reference the friend writes in the payment memo: "R" + 5 Crockford chars. */
export function newRef(rand: (n: number) => Uint8Array = rnd): string {
  return "R" + crock(rand(4), 5);
}
/** Tolerant input: case, spaces (incl. full-width), dashes, O->0, I/L->1. Returns the 16-char canonical code or null. */
export function normCode(s: string): string | null {
  const c = String(s || "").toUpperCase().replace(/[\s　\-‐-―−－]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c) ? c : null;
}
export const fmtCode = (canon: string) => canon.match(/.{4}/g)!.join("-");
export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const codeHash = (canon: string) => sha256hex("zy1:" + canon);

/** ms left for a user; Infinity when neither quota nor expiry applies; <= 0 means "no service". */
export function remaining(u: UserRow | null | undefined, now = Date.now()): number {
  if (!u || u.status !== "active") return 0;
  return Math.min(u.quota_ms == null ? Infinity : u.quota_ms - u.used_ms, u.expires_at == null ? Infinity : u.expires_at - now);
}
/** The server, not the browser, decides every Deepgram parameter (ToS: no generic pass-through). */
export function dgUrl(base: string, q: URLSearchParams, userId: number): URL | null {
  const lang = LANGS[q.get("lang") || "en"];
  const diarize = q.get("diarize") || "0";
  if (!lang || (diarize !== "0" && diarize !== "1")) return null;
  const u = new URL(base);
  for (const [k, v] of [["model", "nova-3"], ["language", lang], ["interim_results", "true"], ["smart_format", "true"],
    ["punctuate", "true"], ["endpointing", "300"], ["utterance_end_ms", "1000"], ["vad_events", "true"], ["mip_opt_out", "true"],
    ["tag", "zhiyin"], ["tag", "u" + userId]]) u.searchParams.append(k, v);
  if (diarize === "1") u.searchParams.set("diarize", "true");
  return u;
}
/** close() throws for 1004/1005/1006/1015 and anything outside 1000-4999. */
export function sendable(code: number): number { return code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011; }
/** Deepgram handshake status -> close code for the browser (which cannot read HTTP status). */
export function dgRefusal(status: number): { code: number; reason: string } {
  if (status === 429) return { code: 4429, reason: "speech service busy" };
  if (status === 401 || status === 402 || status === 403) return { code: 4503, reason: "speech service account problem" };
  return { code: 1011, reason: "speech service unavailable" };
}
/** Origin allowlist. `null` (header absent) = non-browser client: the code is the real check. */
export function originOk(origin: string | null, allowed: string): boolean {
  if (origin === null) return true;
  return allowed.split(",").map((s) => s.trim()).filter(Boolean).includes(origin);
}
/** Fixed-window counter kept in memory (no storage writes, so abuse cannot burn the SQLite write quota). */
export class Limiter {
  m = new Map<string, { n: number; reset: number }>();
  max: number; windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  hit(key: string, now = Date.now()): boolean { // true = allowed
    if (this.m.size > 5000) for (const [k, v] of this.m) if (v.reset < now) this.m.delete(k);
    const e = this.m.get(key);
    if (!e || e.reset < now) { this.m.set(key, { n: 1, reset: now + this.windowMs }); return true; }
    return ++e.n <= this.max;
  }
  blocked(key: string, now = Date.now()): boolean { const e = this.m.get(key); return !!e && e.reset >= now && e.n >= this.max; }
}

// ---------- validators: each returns {ok:true, value} or {ok:false, field, message} ----------
export type Valid<T> = { ok: true; value: T } | { ok: false; field: string; message: string };
const bad = (field: string, message: string): { ok: false; field: string; message: string } => ({ ok: false, field, message });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** Trimmed string within [min,max] characters (code points), or undefined. Missing/null counts as "". */
function str(x: unknown, min: number, max: number): string | undefined {
  if (x != null && typeof x !== "string") return undefined;
  const s = (x ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  const n = [...s].length;
  return n >= min && n <= max ? s : undefined;
}
/** null/""/undefined -> null; otherwise a finite number in (0, max]. */
function optPos(x: unknown, max: number): number | null | undefined {
  if (x == null || x === "") return null;
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
}
export const MAX_MINUTES = 1_000_000, MAX_DAYS = 3660;

export type Registration = { name: string; contact: string; plan_id: string | null; note: string; honeypot: boolean };
export function validRegistration(b: unknown, plans: Plan[]): Valid<Registration> {
  if (!isObj(b)) return bad("body", "请求格式不对");
  const name = str(b.name, 1, 40); if (name === undefined) return bad("name", "请填写称呼（1–40 个字）");
  const contact = str(b.contact, 3, 80); if (contact === undefined) return bad("contact", "请填写联系方式（3–80 个字）");
  const note = str(b.note, 0, 200); if (note === undefined) return bad("note", "备注最多 200 个字");
  let plan_id: string | null = null;
  if (b.plan_id != null && b.plan_id !== "") {
    if (typeof b.plan_id !== "string" || !plans.some((p) => p.id === b.plan_id)) return bad("plan_id", "请选择套餐");
    plan_id = b.plan_id;
  } else if (plans.length) return bad("plan_id", "请选择套餐");
  const honeypot = b.website != null && b.website !== "";
  return { ok: true, value: { name, contact, plan_id, note, honeypot } };
}

export type Grant = { minutes: number | null; days: number | null; note: string };
/** Approve / manual issue: minutes|null (null = unlimited), days|null (null = never expires). */
export function validGrant(b: unknown): Valid<Grant> {
  if (!isObj(b)) return bad("body", "请求格式不对");
  const minutes = optPos(b.minutes, MAX_MINUTES); if (minutes === undefined) return bad("minutes", "分钟数要大于 0（留空 = 不限）");
  const days = optPos(b.days, MAX_DAYS); if (days === undefined) return bad("days", "天数要大于 0、最多 3660（留空 = 不限期）");
  const note = str(b.note, 0, 200); if (note === undefined) return bad("note", "备注最多 200 个字");
  return { ok: true, value: { minutes, days, note } };
}
export type NewUser = Grant & { name: string; contact: string };
export function validNewUser(b: unknown): Valid<NewUser> {
  if (!isObj(b)) return bad("body", "请求格式不对");
  const name = str(b.name, 1, 40); if (name === undefined) return bad("name", "请填写称呼（1–40 个字）");
  const contact = str(b.contact, 0, 80); if (contact === undefined) return bad("contact", "联系方式最多 80 个字");
  const g = validGrant(b); if (!g.ok) return g;
  return { ok: true, value: { ...g.value, name, contact } };
}
export type Topup = { add_minutes: number; add_days: number; note: string };
/** add_minutes may be negative (to correct a mistake); add_days >= 0; at least one must be non-zero. */
export function validTopup(b: unknown): Valid<Topup> {
  if (!isObj(b)) return bad("body", "请求格式不对");
  const num = (x: unknown) => (x == null || x === "" ? 0 : typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN);
  const add_minutes = num(b.add_minutes), add_days = num(b.add_days);
  if (!Number.isFinite(add_minutes) || Math.abs(add_minutes) > MAX_MINUTES) return bad("add_minutes", "分钟数不对");
  if (!Number.isFinite(add_days) || add_days < 0 || add_days > MAX_DAYS) return bad("add_days", "天数要在 0–3660 之间");
  if (add_minutes === 0 && add_days === 0) return bad("add_minutes", "请填写要增加的分钟数或天数");
  const note = str(b.note, 0, 200); if (note === undefined) return bad("note", "备注最多 200 个字");
  return { ok: true, value: { add_minutes, add_days, note } };
}
export function validSettings(b: unknown, newId: () => string): Valid<Settings> {
  if (!isObj(b)) return bad("body", "请求格式不对");
  const pay_text = typeof b.pay_text === "string" && [...b.pay_text].length <= 2000 ? b.pay_text.replace(/\r\n/g, "\n").trim() : undefined;
  if (pay_text === undefined) return bad("pay_text", "付款说明最多 2000 个字");
  if (!Array.isArray(b.plans) || b.plans.length > 10) return bad("plans", "套餐最多 10 个");
  const plans: Plan[] = [], ids = new Set<string>();
  for (let i = 0; i < b.plans.length; i++) {
    const p: unknown = b.plans[i], f = `plans.${i}`;
    if (!isObj(p)) return bad(f, `第 ${i + 1} 个套餐格式不对`);
    const name = str(p.name, 1, 30); if (name === undefined) return bad(f + ".name", `第 ${i + 1} 个套餐：请填写名称（1–30 个字）`);
    const minutes = optPos(p.minutes, MAX_MINUTES); if (minutes === undefined) return bad(f + ".minutes", `第 ${i + 1} 个套餐：分钟数要大于 0（留空 = 不限）`);
    const days = optPos(p.days, MAX_DAYS); if (days === undefined) return bad(f + ".days", `第 ${i + 1} 个套餐：天数要大于 0（留空 = 不限期）`);
    const price = str(typeof p.price === "number" ? String(p.price) : p.price, 0, 30); if (price === undefined) return bad(f + ".price", `第 ${i + 1} 个套餐：价格最多 30 个字`);
    let id = typeof p.id === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(p.id) ? p.id : "";
    if (!id || ids.has(id)) id = newId();
    ids.add(id);
    plans.push({ id, name, minutes, days, price });
  }
  if (typeof b.registration_open !== "boolean") return bad("registration_open", "开放申请：是或否");
  const ms = b.max_streams;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 1 || ms > 60) return bad("max_streams", "同时在线上限要在 1–60 之间");
  const usd = b.usd_per_min;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > 10) return bad("usd_per_min", "每分钟成本要在 0–10 美元之间");
  return { ok: true, value: { pay_text, plans, registration_open: b.registration_open, max_streams: ms, usd_per_min: usd } };
}
/** Settings stored in meta are merged over the defaults, so a newer server can add fields. */
export function loadSettings(raw: string | null | undefined): Settings {
  try { return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) }; } catch { return { ...DEFAULT_SETTINGS }; }
}

// ---------- WIB (UTC+7) date maths for the owner's totals ----------
export const wibDayStart = (now: number) => Math.floor((now + WIB) / DAY) * DAY - WIB;
export function wibMonthStart(now: number): number { const d = new Date(now + WIB); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - WIB; }
export const wibDate = (ms: number) => new Date(ms + WIB).toISOString().slice(0, 10);

/** 600 -> "600", 12.345 -> "12.3", 0.05 -> "0" (rounded down: never promise more than there is). */
export function fmtMinutes(ms: number): string { const m = Math.floor(Math.max(0, ms) / 6000) / 10; return String(m); }

/** The WeChat-ready message the owner pastes to the friend. */
export function codeMessage(o: { code: string; left_ms: number | null; expires_at: number | null; pageUrl: string; reissue?: boolean }): string {
  const head = o.reissue ? "你的知音字幕新授权码（旧码已作废）：" : "你的知音字幕授权码：";
  const amount = o.left_ms == null ? "不限分钟" : fmtMinutes(o.left_ms) + " 分钟";
  const until = o.expires_at == null ? "长期有效" : "有效期至 " + wibDate(o.expires_at);
  const both = o.left_ms != null && o.expires_at != null ? "（先到为准）" : "";
  return `${head}${o.code}\n${o.reissue ? "剩余额度" : "额度"}：${amount}，${until}${both}\n` +
    `用电脑版 Chrome 打开 ${o.pageUrl} → 第 1 步选「用授权码」→ 粘贴 → 开始。同一授权码同时只能在一个页面使用。`;
}
