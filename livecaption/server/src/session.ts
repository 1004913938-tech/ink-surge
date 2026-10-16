// One live stream: browser socket <-> Deepgram socket. Metered as max(wall-clock time, Deepgram's audio time) since the
// Deepgram upstream opened: real-time audio (the page) is charged by the clock, and audio pushed faster than real time
// is charged for the audio Deepgram received and bills. Uploads far above real time end the stream (4413).
import {
  MAX_TIMER, AUDIO_LEAD_MS, GRACE_MS, CLOSE_TOO_FAST, remaining, sendable, upBudgetOk, type UserRow,
} from "./lib.ts";

/** What a Session needs from the Hub (kept as an interface so hub.ts and session.ts do not import each other's values). */
export interface SessionHost {
  sql: SqlStorage;
  live: Map<number, Session>;
  user(id: number): UserRow | undefined;
  flushMs(): number;
}

export class Session {
  host: SessionHost; uid: number; client: WebSocket; upstream: WebSocket; sid: number;
  started = Date.now();
  charged = 0;   // ms already added to users.used_ms by this session
  audioMs = 0;   // Deepgram's audio cursor: the furthest Results start+duration, or Metadata.duration
  endedAt = 0;   // wall clock when the stream ended (the wait for Metadata afterwards is not charged)
  bytesUp = 0;   // audio bytes (sessions.bytes_up)
  inBytes = 0;   // every byte from the client, for the upload budget
  msgsUp = 0;
  done = false;  // end() ran: the client side is over
  closed = false; // finish() ran: upstream closed, books closed
  endCode = 1000; endReason = "";
  cutoff: ReturnType<typeof setTimeout> | undefined; grace: ReturnType<typeof setTimeout> | undefined;
  tick: ReturnType<typeof setInterval>;

  constructor(host: SessionHost, uid: number, client: WebSocket, upstream: WebSocket, q: URLSearchParams, dgReq: string | null) {
    this.host = host; this.uid = uid; this.client = client; this.upstream = upstream;
    this.sid = host.sql.exec<{ id: number }>("INSERT INTO sessions (user_id, started_at, lang, diarize, dg_request_id) VALUES (?, ?, ?, ?, ?) RETURNING id",
      uid, this.started, q.get("lang") || "en", q.get("diarize") === "1" ? 1 : 0, dgReq).one().id;
    // forward only while the other side is open: send() after close throws
    client.addEventListener("message", (e) => {
      if (this.done) return;
      const d = e.data as string | ArrayBuffer, n = typeof d === "string" ? d.length : d.byteLength;
      this.msgsUp++; this.inBytes += n;
      if (typeof d !== "string") this.bytesUp += n;
      // checked before forwarding: the frame that breaks the budget never reaches Deepgram
      if (!upBudgetOk(this.inBytes, this.msgsUp, Date.now() - this.started)) return this.end(CLOSE_TOO_FAST, "audio sent faster than real time");
      if (upstream.readyState === 1) upstream.send(d);
    });
    upstream.addEventListener("message", (e) => {
      const d = e.data as string | ArrayBuffer;
      if (typeof d === "string") this.fromDeepgram(d);
      if (!this.done && client.readyState === 1) client.send(d);
    });
    client.addEventListener("close", (e) => this.end(e.code, e.reason, "client"));
    upstream.addEventListener("close", (e) => (this.done ? this.finish() : this.end(e.code, e.reason, "upstream")));
    client.addEventListener("error", () => this.end(1011, "client socket error", "client"));
    upstream.addEventListener("error", () => (this.done ? this.finish() : this.end(1011, "speech service socket error", "upstream")));
    this.tick = setInterval(() => this.flush(), host.flushMs());
  }

  /** Deepgram's own clock: Results carry start+duration of the audio they cover, Metadata the total it received. */
  fromDeepgram(d: string) {
    const results = d.includes('"Results"'), meta = !results && d.includes('"Metadata"');
    if (!results && !meta) return;
    let m: { type?: unknown; start?: unknown; duration?: unknown; request_id?: unknown };
    try { m = JSON.parse(d); } catch { return; }
    if (m.type === "Results") {
      const end = (Number(m.start) + Number(m.duration)) * 1000;
      if (Number.isFinite(end) && end > this.audioMs) this.audioMs = end;
    } else if (m.type === "Metadata") {
      const dur = Number(m.duration);
      if (Number.isFinite(dur) && dur * 1000 > this.audioMs) this.audioMs = dur * 1000;
      try {
        this.host.sql.exec("UPDATE sessions SET dg_duration_s = ?, dg_request_id = COALESCE(?, dg_request_id) WHERE id = ?",
          Number.isFinite(dur) ? dur : null, typeof m.request_id === "string" ? m.request_id.slice(0, 100) : null, this.sid);
      } catch (err) { console.error(JSON.stringify({ ev: "metadata_write_failed", user_id: this.uid, err: String(err).slice(0, 200) })); }
    }
    // Results lag the audio, so this catches a burst a little late; the final charge still includes all of it
    if (!this.done && this.audioMs > Date.now() - this.started + AUDIO_LEAD_MS) this.end(CLOSE_TOO_FAST, "audio sent faster than real time");
  }

  /** Usage not yet written: max(wall clock, audio time) since the start, minus what is already charged. */
  unflushed(now = Date.now()): number {
    const wall = (this.endedAt || now) - this.started;
    return Math.max(0, Math.max(wall, this.audioMs) - this.charged);
  }

  /** Charge what accrued since the last flush, then re-read the user (admin changes apply here) and re-arm the cutoff.
   *  Fails closed: when the usage cannot be written, the stream ends instead of running on unmetered. */
  flush(final = false) {
    const now = Date.now(), ms = this.unflushed(now), sql = this.host.sql;
    let u: UserRow | null = null;
    try {
      sql.exec("UPDATE users SET used_ms = used_ms + ?, last_used_at = ? WHERE id = ?", ms, now, this.uid);
      this.charged += ms; // only after the write succeeded: a failed interval is charged on the next good write
      sql.exec("UPDATE sessions SET ms = ?, bytes_up = ? WHERE id = ?", this.charged, this.bytesUp, this.sid);
      if (final || this.done) return;
      u = this.host.user(this.uid) ?? null;
    } catch (err) {
      console.error(JSON.stringify({ ev: "meter_write_failed", user_id: this.uid, err: String(err).slice(0, 200) }));
      if (!final && !this.done) this.end(1011, "usage could not be saved");
      return;
    }
    const left = remaining(u, now);
    if (left <= 0) {
      const active = u?.status === "active";
      return this.end(active ? 4402 : 4401, active ? "minutes used up or code expired" : "access code disabled");
    }
    if (this.client.readyState === 1) this.client.send(JSON.stringify({ type: "ZhiYinQuota", remaining_ms: left === Infinity ? null : left, expires_at: u?.expires_at ?? null }));
    clearTimeout(this.cutoff ?? null);
    this.cutoff = left === Infinity ? undefined : setTimeout(() => this.flush(), Math.min(left + 50, MAX_TIMER));
  }

  /** Idempotent. `from` says which side ended; undefined = the server ends it (quota, admin, replaced, too fast).
   *  Unless Deepgram itself closed, it is asked to finish (CloseStream) and given GRACE_MS to send its Metadata, so the
   *  final charge includes all the audio it received, even from a client that dumped a recording and vanished. */
  end(code: number, reason: string, from?: "client" | "upstream") {
    if (this.done) return;
    this.done = true; this.endedAt = Date.now();
    this.endCode = code; this.endReason = ((from ? from + ": " : "") + reason).slice(0, 120);
    clearTimeout(this.cutoff ?? null); clearInterval(this.tick);
    if (this.host.live.get(this.uid) === this) this.host.live.delete(this.uid);
    if (from !== "client") { try { this.client.close(sendable(code), reason.slice(0, 100)); } catch { /* already closed */ } }
    if (from === "upstream" || this.upstream.readyState !== 1) return this.finish();
    try { this.upstream.send(JSON.stringify({ type: "CloseStream" })); } catch { /* already closed */ }
    this.grace = setTimeout(() => this.finish(), GRACE_MS);
  }

  /** Close the upstream (if Deepgram has not) and the books: final charge, end time, end code. Idempotent. */
  finish() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.grace ?? null);
    try { this.upstream.close(1000, "client gone"); } catch { /* already closed */ }
    this.flush(true);
    try {
      this.host.sql.exec("UPDATE sessions SET ended_at = ?, end_code = ?, end_reason = ? WHERE id = ?", this.endedAt, this.endCode, this.endReason, this.sid);
    } catch (err) { console.error(JSON.stringify({ ev: "session_end_write_failed", user_id: this.uid, err: String(err).slice(0, 200) })); }
    console.log(JSON.stringify({ ev: "stream_end", user_id: this.uid, code: this.endCode, ms: this.charged, audio_ms: Math.round(this.audioMs) }));
  }
}
