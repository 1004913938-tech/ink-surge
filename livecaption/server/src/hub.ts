// The Hub: ONE SQLite-backed Durable Object ("main") that is both the database and the WebSocket relay for every stream.
import { DurableObject } from "cloudflare:workers";
import {
  PROTO, MIN, DAY, MIN_START_MS, type UserRow, type Settings, type Grant, Limiter,
  newCode, newRef, normCode, codeHash, remaining, dgUrl, dgRefusal, loadSettings, codeMessage,
  validRegistration, validGrant, validNewUser, validTopup, validSettings, wibDayStart, wibMonthStart,
} from "./lib";
import { Session, type SessionHost } from "./session";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  DEEPGRAM_API_KEY: string;
  ADMIN_PASSWORD: string;
  ALLOWED_ORIGINS: string;
  PUBLIC_PAGE_URL: string;
  DG_URL?: string;   // tests only: mock Deepgram, e.g. http://127.0.0.1:9911/v1/listen
  FLUSH_MS?: string; // tests only: metering flush period (default 15000)
}

export const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, error: string, message?: string, extra?: Record<string, unknown>) => json({ error, message, ...extra }, status);
const bearer = (req: Request) => (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
const toMin = (ms: number) => Math.round(ms / 6000) / 10;
const digest = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));

const SCHEMA_VERSION = 1;
const MAX_PENDING = 200;

type UserFull = UserRow & { name: string; contact: string; code_hint: string; created_at: number; last_used_at: number | null; month_ms: number; deleted: number };
type RegRow = { ref: string; created_at: number; name: string; contact: string; plan_id: string | null; note: string | null; status: string; user_id: number | null; decided_at: number | null };

export class Hub extends DurableObject<Env> implements SessionHost {
  sql: SqlStorage;
  live = new Map<number, Session>();
  badCode = new Limiter(20, 10 * MIN);  // wrong access codes per IP
  badAdmin = new Limiter(10, 15 * MIN); // wrong admin passwords per IP
  regs = new Limiter(5, 60 * MIN);      // registrations per IP
  settings: Settings;
  purgedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registrations (ref TEXT PRIMARY KEY, created_at INTEGER NOT NULL, name TEXT NOT NULL, contact TEXT NOT NULL,
        plan_id TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'pending', user_id INTEGER, decided_at INTEGER);
      CREATE INDEX IF NOT EXISTS registrations_status ON registrations(status, created_at);
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '',
        code_hash TEXT NOT NULL UNIQUE, code_hint TEXT NOT NULL, quota_ms INTEGER, used_ms INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, last_used_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, started_at INTEGER NOT NULL,
        ended_at INTEGER, ms INTEGER NOT NULL DEFAULT 0, bytes_up INTEGER NOT NULL DEFAULT 0, end_code INTEGER, end_reason TEXT,
        lang TEXT, diarize INTEGER, dg_request_id TEXT, dg_duration_s REAL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, started_at);
      CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
        add_ms INTEGER, expires_at INTEGER, note TEXT);
      CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, at);`);
    if (this.meta("schema") !== String(SCHEMA_VERSION)) this.setMeta("schema", String(SCHEMA_VERSION)); // future ALTERs key off this
    // a restart (deploy, runtime update, crash) kills every socket: close the books on sessions left open
    this.sql.exec("UPDATE sessions SET ended_at = started_at + ms, end_code = 1012, end_reason = 'server restart' WHERE ended_at IS NULL");
    this.settings = loadSettings(this.meta("settings"));
  }

  meta(k: string): string | null { return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null; }
  setMeta(k: string, v: string) { this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", k, v); }
  flushMs() { return Math.max(100, Number(this.env.FLUSH_MS) || 15_000); }
  user(id: number): UserRow | undefined {
    return this.sql.exec<UserRow>("SELECT id, quota_ms, used_ms, expires_at, status FROM users WHERE id = ?", id).toArray()[0];
  }
  async byCode(raw: string): Promise<(UserRow & { code_hash: string }) | undefined> {
    const canon = normCode(raw);
    if (!canon) return undefined;
    return this.sql.exec<UserRow & { code_hash: string }>("SELECT id, quota_ms, used_ms, expires_at, status, code_hash FROM users WHERE code_hash = ?", await codeHash(canon)).toArray()[0];
  }
  isDeleted(id: number) { return this.sql.exec("SELECT 1 FROM ledger WHERE user_id = ? AND kind = 'delete' LIMIT 1", id).toArray().length > 0; }
  ledger(user_id: number, at: number, kind: string, add_ms: number | null, expires_at: number | null, note: string | null) {
    this.sql.exec("INSERT INTO ledger (user_id, at, kind, add_ms, expires_at, note) VALUES (?, ?, ?, ?, ?, ?)", user_id, at, kind, add_ms, expires_at, note || null);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), p = url.pathname, ip = req.headers.get("x-zy-ip") ?? "";
    try {
      if (p === "/v1/listen") return await this.listen(req, url, ip);
      if (p === "/api/config") return json(this.publicConfig());
      if (p === "/api/register" && req.method === "POST") return await this.register(req, ip);
      if (p === "/api/me") return await this.me(req, ip);
      if (p.startsWith("/admin/api/")) return await this.admin(req, url, ip);
      return fail(404, "not_found");
    } catch (e) {
      console.error(JSON.stringify({ ev: "hub_error", path: p, err: String(e).slice(0, 300) }));
      return fail(500, "server_error", "服务器出错，请稍后再试");
    }
  }

  // ---------------------------------------------------------------- public API
  publicConfig() {
    const s = this.settings;
    return { service: "zhiyin", version: 1, registration_open: s.registration_open, pay_text: s.pay_text, plans: s.plans };
  }

  async register(req: Request, ip: string): Promise<Response> {
    const s = this.settings;
    if (!s.registration_open) return fail(403, "registration_closed", "店主暂时没有开放申请");
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > 4096) return fail(400, "invalid_input", "内容太长", { field: "body" });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return fail(400, "invalid_input", "请求格式不对", { field: "body" }); }
    const v = validRegistration(body, s.plans);
    if (!v.ok) return fail(400, "invalid_input", v.message, { field: v.field });
    const plan = s.plans.find((x) => x.id === v.value.plan_id) ?? null;
    if (v.value.honeypot) return json({ ref: newRef(), pay_text: s.pay_text, plan }, 201); // bot: looks fine, stores nothing
    if (!this.regs.hit(ip)) return fail(429, "rate_limited", "申请太频繁，请一小时后再试");
    const pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM registrations WHERE status = 'pending'").one().n;
    if (pending >= MAX_PENDING) return fail(503, "too_many_pending", "店主还有很多申请没处理，请过几天再试");
    for (let i = 0; i < 8; i++) {
      const ref = newRef();
      if (this.sql.exec("SELECT 1 FROM registrations WHERE ref = ?", ref).toArray().length) continue;
      this.sql.exec("INSERT INTO registrations (ref, created_at, name, contact, plan_id, note) VALUES (?, ?, ?, ?, ?, ?)",
        ref, Date.now(), v.value.name, v.value.contact, v.value.plan_id, v.value.note || null);
      return json({ ref, pay_text: s.pay_text, plan }, 201);
    }
    return fail(500, "server_error", "服务器出错，请稍后再试");
  }

  async me(req: Request, ip: string): Promise<Response> {
    if (this.badCode.blocked(ip)) return fail(429, "too_many_attempts", "授权码输错太多次，请 10 分钟后再试");
    const u = await this.byCode(bearer(req));
    if (!u) { this.badCode.hit(ip); return fail(401, "unknown_code", "授权码无效"); }
    const now = Date.now(), s = this.live.get(u.id);
    const used = u.used_ms + (s ? now - s.flushedAt : 0), left = remaining({ ...u, used_ms: used }, now);
    return json({ status: u.status, quota_ms: u.quota_ms, used_ms: used, expires_at: u.expires_at,
      remaining_ms: left === Infinity ? null : Math.max(0, left), live: !!s });
  }

  // ---------------------------------------------------------------- relay
  async listen(req: Request, url: URL, ip: string): Promise<Response> {
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    server.binaryType = "arraybuffer"; // Blob is the default since compat 2026-03-17 and send(Blob) would send "[object Blob]"
    server.accept();
    // the browser cannot read HTTP status on a failed handshake, so every refusal is "accept, then close with a 4xxx code"
    const res = new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": PROTO } });
    const refuse = (code: number, reason: string) => { server.close(code, reason); return res; };
    if (this.badCode.blocked(ip)) return refuse(4429, "too many bad codes, wait 10 minutes");
    const u = await this.byCode((req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",")[1] ?? "");
    if (!u) { this.badCode.hit(ip); return refuse(4401, "unknown access code"); }
    const now = Date.now(), prev = this.live.get(u.id);
    const left = remaining({ ...u, used_ms: u.used_ms + (prev ? now - prev.flushedAt : 0) }, now);
    if (left < MIN_START_MS) return u.status === "active" ? refuse(4402, "minutes used up or code expired") : refuse(4401, "access code disabled");
    if (!prev && this.live.size >= this.settings.max_streams) return refuse(4429, "server busy");
    const up = dgUrl(this.env.DG_URL || "https://api.deepgram.com/v1/listen", url.searchParams, u.id); // https:, never wss:
    if (!up) return refuse(4400, "bad parameters");
    const r = await fetch(up, { headers: { Upgrade: "websocket", Authorization: "Token " + this.env.DEEPGRAM_API_KEY } }).catch(() => null);
    if (!r?.webSocket) {
      const st = r?.status ?? 0;
      await r?.body?.cancel().catch(() => {});
      this.setMeta("dg_error", JSON.stringify({ at: Date.now(), status: st, err: (r?.headers.get("dg-error") ?? "network").slice(0, 200) }));
      console.log(JSON.stringify({ ev: "dg_refused", user_id: u.id, status: st }));
      const f = dgRefusal(st);
      return refuse(f.code, f.reason);
    }
    const upstream = r.webSocket;
    upstream.binaryType = "arraybuffer";
    upstream.accept();
    // the code may have been reissued or the user disabled while we waited for Deepgram
    const still = this.sql.exec("SELECT 1 FROM users WHERE id = ? AND code_hash = ? AND status = 'active'", u.id, u.code_hash).toArray().length > 0;
    if (!still) { try { upstream.close(1000, "client gone"); } catch { /* closed */ } return refuse(4401, "access code disabled"); }
    this.live.get(u.id)?.end(4409, "replaced by a newer connection with this code");
    const s = new Session(this, u.id, server, upstream, url.searchParams, r.headers.get("dg-request-id"));
    this.live.set(u.id, s);
    s.flush(); // first quota message + cutoff timer
    return res;
  }

  // ---------------------------------------------------------------- admin API
  async admin(req: Request, url: URL, ip: string): Promise<Response> {
    if (this.badAdmin.blocked(ip)) return fail(429, "locked", "密码错误次数太多，请 15 分钟后再试");
    if ((this.env.ADMIN_PASSWORD ?? "").length < 16)
      return fail(503, "admin_password_too_short", "服务器的 ADMIN_PASSWORD 太短（至少 16 位）。请在 GitHub 的 Secrets 里改长，再重新部署。");
    const [given, want] = await Promise.all([digest(bearer(req)), digest(this.env.ADMIN_PASSWORD)]);
    if (!crypto.subtle.timingSafeEqual(given, want)) { this.badAdmin.hit(ip); return fail(401, "unauthorized", "密码不对"); }

    let body: unknown = {};
    if (req.method === "POST" || req.method === "PUT") {
      const t = await req.text();
      if (t.length > 32_768) return fail(400, "invalid_input", "内容太长", { field: "body" });
      if (t.trim()) { try { body = JSON.parse(t); } catch { return fail(400, "invalid_input", "请求格式不对", { field: "body" }); } }
    }
    const now = Date.now(), p = url.pathname.slice("/admin/api".length), M = req.method;
    let m: RegExpMatchArray | null;
    if (p === "/overview" && M === "GET") return json(this.overview(now));
    if (p === "/settings" && M === "PUT") return this.putSettings(body);
    if (p === "/users" && M === "POST") return this.issue(body, now);
    if ((m = p.match(/^\/registrations\/([0-9A-Za-z]{1,12})\/(approve|reject)$/)) && M === "POST")
      return m[2] === "approve" ? this.approve(m[1], body, now) : this.reject(m[1], now);
    if ((m = p.match(/^\/users\/(\d{1,12})\/sessions$/)) && M === "GET") return this.history(+m[1], url, now);
    if ((m = p.match(/^\/users\/(\d{1,12})\/(topup|status|reissue|delete)$/)) && M === "POST") {
      const id = +m[1];
      if (!this.user(id)) return fail(404, "not_found", "找不到这个用户");
      if (m[2] === "topup") return this.topup(id, body, now);
      if (m[2] === "status") return this.setStatus(id, body, now);
      if (m[2] === "reissue") return this.reissue(id, now);
      return this.remove(id, now);
    }
    return fail(404, "not_found");
  }

  userViews(now: number, id?: number) {
    const month = wibMonthStart(now);
    const rows = this.sql.exec<UserFull>(
      `SELECT u.id, u.name, u.contact, u.code_hint, u.status, u.quota_ms, u.used_ms, u.expires_at, u.created_at, u.last_used_at,
         (SELECT COALESCE(SUM(s.ms), 0) FROM sessions s WHERE s.user_id = u.id AND s.started_at >= ?) AS month_ms,
         EXISTS (SELECT 1 FROM ledger l WHERE l.user_id = u.id AND l.kind = 'delete') AS deleted
       FROM users u ${id == null ? "" : "WHERE u.id = ?"} ORDER BY u.id DESC`, ...(id == null ? [month] : [month, id])).toArray();
    return rows.map((r) => {
      const s = this.live.get(r.id), extra = s ? now - s.flushedAt : 0, used = r.used_ms + extra;
      const left = remaining({ ...r, used_ms: used }, now);
      return { id: r.id, name: r.name, contact: r.contact, code_hint: r.code_hint, status: r.status, deleted: !!r.deleted,
        quota_ms: r.quota_ms, used_ms: used, remaining_ms: left === Infinity ? null : Math.max(0, left), expires_at: r.expires_at,
        created_at: r.created_at, last_used_at: r.last_used_at, month_ms: r.month_ms + extra, live: s ? { started_at: s.started } : null };
    });
  }

  overview(now: number) {
    if (now - this.purgedAt > 3_600_000) { // retention, done lazily (at most hourly)
      this.purgedAt = now;
      this.sql.exec("DELETE FROM registrations WHERE status != 'pending' AND decided_at < ?", now - 90 * DAY);
    }
    let unflushed = 0;
    for (const s of this.live.values()) unflushed += now - s.flushedAt;
    const t = this.sql.exec<{ today: number; month: number }>(
      "SELECT COALESCE(SUM(CASE WHEN started_at >= ? THEN ms ELSE 0 END), 0) AS today, COALESCE(SUM(ms), 0) AS month FROM sessions WHERE started_at >= ?",
      wibDayStart(now), wibMonthStart(now)).one();
    const all = this.sql.exec<{ total: number }>("SELECT COALESCE(SUM(used_ms), 0) AS total FROM users").one().total;
    const cols = "ref, created_at, name, contact, plan_id, note, status, user_id, decided_at";
    const regs = [
      ...this.sql.exec<RegRow>(`SELECT ${cols} FROM registrations WHERE status = 'pending' ORDER BY created_at`).toArray(),
      ...this.sql.exec<RegRow>(`SELECT ${cols} FROM registrations WHERE status != 'pending' ORDER BY decided_at DESC LIMIT 30`).toArray(),
    ].map((r) => ({ ...r, plan: this.settings.plans.find((x) => x.id === r.plan_id) ?? null }));
    const dg = this.meta("dg_error");
    const lastOk = this.sql.exec<{ t: number | null }>("SELECT MAX(started_at) AS t FROM sessions").one().t;
    return {
      now, live_count: this.live.size, max_streams: this.settings.max_streams,
      dg_error: dg ? JSON.parse(dg) : null, last_ok_at: lastOk,
      totals: { today_min: toMin(t.today + unflushed), month_min: toMin(t.month + unflushed), all_min: toMin(all + unflushed) },
      registrations: regs, users: this.userViews(now), settings: this.settings,
    };
  }

  putSettings(body: unknown): Response {
    const v = validSettings(body, () => "p" + newRef().slice(1).toLowerCase());
    if (!v.ok) return fail(400, "invalid_input", v.message, { field: v.field });
    this.settings = v.value;
    this.setMeta("settings", JSON.stringify(v.value));
    return json(v.value);
  }

  /** New code + hash. Awaited BEFORE any write, so the writes that follow run as one synchronous (atomic) block. */
  async freshCode() {
    const code = newCode(), canon = code.replace(/-/g, "");
    return { code, hash: await codeHash(canon), hint: canon.slice(-4) };
  }
  createUser(name: string, contact: string, g: Grant, c: { hash: string; hint: string }, now: number, note: string): number {
    const quota = g.minutes == null ? null : Math.round(g.minutes * MIN);
    const exp = g.days == null ? null : now + Math.round(g.days * DAY);
    const id = this.sql.exec<{ id: number }>(
      "INSERT INTO users (name, contact, code_hash, code_hint, quota_ms, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      name, contact, c.hash, c.hint, quota, exp, now).one().id;
    this.ledger(id, now, "issue", quota, exp, note);
    console.log(JSON.stringify({ ev: "user_issued", user_id: id }));
    return id;
  }
  issued(id: number, code: string, now: number, reissue = false) {
    const user = this.userViews(now, id)[0];
    const message = codeMessage({ code, left_ms: user.quota_ms == null ? null : user.quota_ms - user.used_ms, expires_at: user.expires_at,
      pageUrl: this.env.PUBLIC_PAGE_URL || "", reissue });
    return { user, code, message };
  }

  async issue(body: unknown, now: number): Promise<Response> {
    const v = validNewUser(body);
    if (!v.ok) return fail(400, "invalid_input", v.message, { field: v.field });
    const c = await this.freshCode();
    const id = this.createUser(v.value.name, v.value.contact, v.value, c, now, v.value.note);
    return json(this.issued(id, c.code, now), 201);
  }

  async approve(ref: string, body: unknown, now: number): Promise<Response> {
    const v = validGrant(body);
    if (!v.ok) return fail(400, "invalid_input", v.message, { field: v.field });
    const c = await this.freshCode();
    const r = this.sql.exec<RegRow>("SELECT * FROM registrations WHERE ref = ?", ref).toArray()[0];
    if (!r) return fail(404, "not_found", "找不到这个申请");
    if (r.status !== "pending") return fail(409, "already_decided", "这个申请已经处理过了");
    const id = this.createUser(r.name, r.contact, v.value, c, now, [ref, v.value.note].filter(Boolean).join(" · "));
    this.sql.exec("UPDATE registrations SET status = 'approved', user_id = ?, decided_at = ? WHERE ref = ?", id, now, ref);
    return json(this.issued(id, c.code, now), 201);
  }

  reject(ref: string, now: number): Response {
    const r = this.sql.exec<{ status: string }>("SELECT status FROM registrations WHERE ref = ?", ref).toArray()[0];
    if (!r) return fail(404, "not_found", "找不到这个申请");
    if (r.status !== "pending") return fail(409, "already_decided", "这个申请已经处理过了");
    this.sql.exec("UPDATE registrations SET status = 'rejected', decided_at = ? WHERE ref = ?", now, ref);
    return json({ ok: true, ref, status: "rejected" });
  }

  topup(id: number, body: unknown, now: number): Response {
    const v = validTopup(body);
    if (!v.ok) return fail(400, "invalid_input", v.message, { field: v.field });
    if (this.isDeleted(id)) return fail(409, "deleted", "这个用户已删除");
    const add = Math.round(v.value.add_minutes * MIN), days = Math.round(v.value.add_days * DAY);
    // quota += add (NULL = unlimited stays NULL); expires_at = max(expires_at, now) + days (NULL = never stays NULL)
    this.sql.exec(`UPDATE users SET quota_ms = CASE WHEN quota_ms IS NULL THEN NULL ELSE MAX(0, quota_ms + ?) END,
      expires_at = CASE WHEN expires_at IS NULL OR ? = 0 THEN expires_at ELSE MAX(expires_at, ?) + ? END WHERE id = ?`, add, days, now, days, id);
    const exp = this.sql.exec<{ e: number | null }>("SELECT expires_at AS e FROM users WHERE id = ?", id).one().e;
    this.ledger(id, now, "topup", add || null, days ? exp : null, v.value.note);
    this.live.get(id)?.flush(); // applies to a live stream now (new cutoff, quota message), not at the next tick
    return json({ user: this.userViews(now, id)[0] });
  }

  setStatus(id: number, body: unknown, now: number): Response {
    const st = (body as { status?: unknown } | null)?.status;
    if (st !== "active" && st !== "disabled") return fail(400, "invalid_input", "状态只能是 active 或 disabled", { field: "status" });
    if (st === "active" && this.isDeleted(id)) return fail(409, "deleted", "这个用户已删除，不能启用");
    if (this.user(id)!.status !== st) {
      this.sql.exec("UPDATE users SET status = ? WHERE id = ?", st, id);
      this.ledger(id, now, st === "active" ? "enable" : "disable", null, null, null);
    }
    this.live.get(id)?.flush(); // disabled: the live stream ends with 4401 right here
    return json({ user: this.userViews(now, id)[0] });
  }

  async reissue(id: number, now: number): Promise<Response> {
    const c = await this.freshCode();
    if (this.isDeleted(id)) return fail(409, "deleted", "这个用户已删除");
    this.sql.exec("UPDATE users SET code_hash = ?, code_hint = ? WHERE id = ?", c.hash, c.hint, id);
    this.ledger(id, now, "reissue", null, null, null);
    this.live.get(id)?.end(4401, "access code replaced");
    return json(this.issued(id, c.code, now, true));
  }

  remove(id: number, now: number): Response {
    if (!this.isDeleted(id)) {
      this.sql.exec("UPDATE users SET name = '', contact = '', status = 'disabled' WHERE id = ?", id);
      this.sql.exec("UPDATE registrations SET name = '', contact = '', note = NULL WHERE user_id = ?", id);
      this.ledger(id, now, "delete", null, null, null);
      this.live.get(id)?.end(4401, "access code disabled");
    }
    return json({ ok: true, user: this.userViews(now, id)[0] });
  }

  history(id: number, url: URL, now: number): Response {
    if (!this.user(id)) return fail(404, "not_found", "找不到这个用户");
    const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 100)));
    const s = this.live.get(id);
    const sessions = this.sql.exec<{ id: number; ms: number }>(
      `SELECT id, started_at, ended_at, ms, bytes_up, end_code, end_reason, lang, diarize, dg_request_id, dg_duration_s
       FROM sessions WHERE user_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`, id, limit).toArray()
      .map((r) => (s && s.sid === r.id ? { ...r, ms: r.ms + now - s.flushedAt, live: true } : r));
    const ledger = this.sql.exec("SELECT id, at, kind, add_ms, expires_at, note FROM ledger WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?", id, limit).toArray();
    return json({ sessions, ledger });
  }
}
