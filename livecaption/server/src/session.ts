// One live stream: browser socket <-> Deepgram socket, metered by wall-clock time while Deepgram is open.
import { MAX_TIMER, remaining, sendable, type UserRow } from "./lib";

/** What a Session needs from the Hub (kept as an interface so hub.ts and session.ts do not import each other's values). */
export interface SessionHost {
  sql: SqlStorage;
  live: Map<number, Session>;
  user(id: number): UserRow | undefined;
  flushMs(): number;
}

export class Session {
  host: SessionHost; uid: number; client: WebSocket; upstream: WebSocket; sid: number;
  started = Date.now(); flushedAt = this.started; bytesUp = 0; done = false;
  cutoff: ReturnType<typeof setTimeout> | undefined; tick: ReturnType<typeof setInterval>;

  constructor(host: SessionHost, uid: number, client: WebSocket, upstream: WebSocket, q: URLSearchParams, dgReq: string | null) {
    this.host = host; this.uid = uid; this.client = client; this.upstream = upstream;
    this.sid = host.sql.exec<{ id: number }>("INSERT INTO sessions (user_id, started_at, lang, diarize, dg_request_id) VALUES (?, ?, ?, ?, ?) RETURNING id",
      uid, this.started, q.get("lang") || "en", q.get("diarize") === "1" ? 1 : 0, dgReq).one().id;
    // forward only while the other side is open: send() after close throws
    client.addEventListener("message", (e) => {
      const d = e.data as string | ArrayBuffer;
      if (typeof d !== "string") this.bytesUp += d.byteLength;
      if (upstream.readyState === 1) upstream.send(d);
    });
    upstream.addEventListener("message", (e) => {
      const d = e.data as string | ArrayBuffer;
      if (typeof d === "string" && d.includes('"Metadata"')) this.metadata(d);
      if (client.readyState === 1) client.send(d);
    });
    client.addEventListener("close", (e) => this.end(e.code, e.reason, "client"));
    upstream.addEventListener("close", (e) => this.end(e.code, e.reason, "upstream"));
    client.addEventListener("error", () => this.end(1011, "client socket error", "client"));
    upstream.addEventListener("error", () => this.end(1011, "speech service socket error", "upstream"));
    this.tick = setInterval(() => this.flush(), host.flushMs());
  }

  metadata(d: string) {
    try {
      const m = JSON.parse(d);
      if (m.type === "Metadata") this.host.sql.exec("UPDATE sessions SET dg_duration_s = ?, dg_request_id = COALESCE(?, dg_request_id) WHERE id = ?",
        Number(m.duration) || null, typeof m.request_id === "string" ? m.request_id.slice(0, 100) : null, this.sid);
    } catch { /* not JSON: ignore */ }
  }

  /** Charge wall-clock time since the last flush, then re-read the user (admin changes apply here) and re-arm the cutoff. */
  flush(final = false) {
    const now = Date.now(), ms = now - this.flushedAt;
    this.flushedAt = now;
    const sql = this.host.sql;
    sql.exec("UPDATE users SET used_ms = used_ms + ?, last_used_at = ? WHERE id = ?", ms, now, this.uid);
    sql.exec("UPDATE sessions SET ms = ms + ?, bytes_up = ? WHERE id = ?", ms, this.bytesUp, this.sid);
    if (final || this.done) return;
    const u = this.host.user(this.uid) ?? null, left = remaining(u, now);
    if (left <= 0) {
      const active = u?.status === "active";
      return this.end(active ? 4402 : 4401, active ? "minutes used up or code expired" : "access code disabled");
    }
    if (this.client.readyState === 1) this.client.send(JSON.stringify({ type: "ZhiYinQuota", remaining_ms: left === Infinity ? null : left, expires_at: u?.expires_at ?? null }));
    clearTimeout(this.cutoff ?? null);
    this.cutoff = left === Infinity ? undefined : setTimeout(() => this.flush(), Math.min(left + 50, MAX_TIMER));
  }

  /** Idempotent. `from` says which side ended; undefined = the server ends it (quota, admin, replaced). */
  end(code: number, reason: string, from?: "client" | "upstream") {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.cutoff ?? null); clearInterval(this.tick);
    if (this.host.live.get(this.uid) === this) this.host.live.delete(this.uid);
    if (from !== "upstream") {
      try { this.upstream.send(JSON.stringify({ type: "CloseStream" })); } catch { /* already closed */ }
      try { this.upstream.close(1000, "client gone"); } catch { /* already closed */ }
    }
    if (from !== "client") { try { this.client.close(sendable(code), reason.slice(0, 100)); } catch { /* already closed */ } }
    this.flush(true);
    this.host.sql.exec("UPDATE sessions SET ended_at = ?, end_code = ?, end_reason = ? WHERE id = ?",
      Date.now(), code, ((from ? from + ": " : "") + reason).slice(0, 120), this.sid);
    console.log(JSON.stringify({ ev: "stream_end", user_id: this.uid, code, from: from ?? "server", ms: Date.now() - this.started }));
  }
}
