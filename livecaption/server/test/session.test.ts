// Session (relay + metering) with fake sockets, a fake SQL store and mocked clock/timers: the billing rules that the
// e2e can only show through the mock Deepgram.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Session, type SessionHost } from "../src/session.ts";
import { GRACE_MS, UP_SLACK_BYTES, type UserRow } from "../src/lib.ts";

class FakeSocket extends EventTarget {
  readyState = 1; sent: (string | ArrayBuffer)[] = []; closedWith: { code?: number; reason?: string } | null = null;
  send(d: string | ArrayBuffer) { if (this.readyState !== 1) throw new Error("closed"); this.sent.push(d); }
  close(code?: number, reason?: string) { if (this.readyState === 3) return; this.readyState = 3; this.closedWith = { code, reason }; }
  receive(data: string | ArrayBuffer) { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
  drop(code: number, reason = "") { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code, reason })); }
  json() { return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d)); }
}

function fakeHost(user: UserRow) {
  const writes: string[] = [];
  const session: Record<string, unknown> = {};
  let failWrites = false;
  const cursor = (rows: unknown[] = []) => ({ one: () => rows[0], toArray: () => rows });
  const sql = {
    exec(q: string, ...a: unknown[]) {
      if (/^\s*(UPDATE|INSERT)/.test(q) && failWrites) throw new Error("SQLITE_FULL: rows-written limit");
      writes.push(q.split(" ").slice(0, 4).join(" "));
      if (q.startsWith("INSERT INTO sessions")) return cursor([{ id: 1 }]);
      if (q.startsWith("UPDATE users SET used_ms")) { user.used_ms += a[0] as number; return cursor(); }
      if (q.startsWith("UPDATE sessions SET ms")) { session.ms = a[0]; session.bytes_up = a[1]; return cursor(); }
      if (q.startsWith("UPDATE sessions SET dg_duration_s")) { session.dg_duration_s = a[0]; return cursor(); }
      if (q.startsWith("UPDATE sessions SET ended_at")) { Object.assign(session, { ended_at: a[0], end_code: a[1], end_reason: a[2] }); return cursor(); }
      throw new Error("unexpected SQL " + q);
    },
  };
  const host: SessionHost = { sql: sql as unknown as SqlStorage, live: new Map(), user: () => ({ ...user }), flushMs: () => 15_000 };
  return { host, user, session, writes, setFail: (v: boolean) => { failWrites = v; } };
}

function start(t: TestContext, user: Partial<UserRow> = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  const h = fakeHost({ id: 7, quota_ms: 3_600_000, used_ms: 0, expires_at: null, status: "active", ...user });
  const client = new FakeSocket(), upstream = new FakeSocket();
  const s = new Session(h.host, 7, client as unknown as WebSocket, upstream as unknown as WebSocket, new URLSearchParams("lang=en"), null);
  h.host.live.set(7, s);
  s.flush();
  return { ...h, s, client, upstream, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const results = (start: number, duration: number) => JSON.stringify({ type: "Results", start, duration, is_final: true, channel: { alternatives: [{ transcript: "x" }] } });
const audio = (n: number) => new ArrayBuffer(n);

test("real-time audio is charged by the clock", (t) => {
  const { s, client, upstream, user, tick } = start(t);
  for (let i = 0; i < 40; i++) { tick(250); client.receive(audio(3000)); upstream.receive(results(i * 0.25, 0.25)); }
  tick(5000); // silence / KeepAlive only: still charged (Deepgram bills it too)
  client.receive(JSON.stringify({ type: "KeepAlive" }));
  tick(15_000); // flushes at 15 s and 30 s
  assert.equal(user.used_ms, 30_000);
  assert.equal(s.done, false);
  assert.equal(upstream.sent.length, 41, "every frame and the KeepAlive forwarded");
});

test("audio ahead of the clock is charged as audio (max of the two)", (t) => {
  const { user, upstream, tick, s } = start(t);
  tick(4000);
  upstream.receive(results(0, 12)); // Deepgram has 12 s of audio after 4 s: within the 10 s lead, so the stream goes on
  assert.equal(s.unflushed(), 12_000);
  tick(11_000); // flush at 15 s: wall 15 s > audio 12 s
  assert.equal(user.used_ms, 15_000);
  upstream.receive(results(12, 12)); // 24 s of audio at 15 s wall
  tick(15_000); // flush at 30 s: wall 30 s
  assert.equal(user.used_ms, 30_000);
  assert.equal(s.done, false);
});

test("audio far ahead of the clock ends the stream (4413) and the whole audio is charged", (t) => {
  const { s, client, upstream, user, session, tick } = start(t);
  tick(1000);
  upstream.receive(results(0, 25)); // 25 s of audio after 1 s
  assert.equal(client.closedWith?.code, 4413);
  assert.deepEqual(upstream.json().at(-1), { type: "CloseStream" }, "Deepgram is asked to finish");
  assert.equal(upstream.readyState, 1, "and given time to send its Metadata");
  tick(200);
  upstream.receive(JSON.stringify({ type: "Metadata", duration: 31.5, request_id: "r1" }));
  upstream.drop(1000);
  assert.equal(user.used_ms, 31_500, "charged the audio Deepgram received, not the 1.2 s of wall clock");
  assert.equal(session.ms, 31_500);
  assert.equal(session.dg_duration_s, 31.5);
  assert.equal(session.end_code, 4413);
  assert.equal(session.ended_at, 1_001_000, "end time is when the stream ended, not after the Metadata wait");
  assert.equal(s.host.live.size, 0);
});

test("a burst of bytes ends the stream at once; the frame over budget is not forwarded", (t) => {
  const { client, upstream, tick } = start(t);
  tick(100);
  let i = 0;
  while (client.readyState === 1 && i < 100) { client.receive(audio(4096)); i++; }
  assert.equal(client.closedWith?.code, 4413);
  const forwarded = upstream.sent.filter((d) => typeof d !== "string").length;
  assert.ok(forwarded * 4096 <= UP_SLACK_BYTES + 0.1 * 32_000 && forwarded === i - 1, `forwarded ${forwarded} of ${i}`);
  client.receive(audio(10)); // after the end nothing more goes through
  assert.equal(upstream.sent.filter((d) => typeof d !== "string").length, forwarded);
});

test("a flood of tiny messages ends the stream too (protects the shared Hub)", (t) => {
  const { client, tick } = start(t);
  tick(100);
  for (let i = 0; i < 200 && client.readyState === 1; i++) client.receive(audio(5));
  assert.equal(client.closedWith?.code, 4413);
});

test("client leaves: wait for Metadata, charge its audio, close upstream", (t) => {
  const { client, upstream, user, session, tick } = start(t);
  tick(2000);
  client.receive(audio(1000));
  upstream.receive(results(0, 9)); // a fast client: 9 s of audio in 2 s (within the lead)
  client.drop(1006); // vanishes before the next flush
  assert.deepEqual(upstream.json().at(-1), { type: "CloseStream" });
  assert.equal(upstream.readyState, 1);
  upstream.receive(JSON.stringify({ type: "Metadata", duration: 9.5 }));
  upstream.drop(1000);
  assert.equal(user.used_ms, 9500);
  assert.equal(session.end_code, 1006);
  assert.match(String(session.end_reason), /^client: /);
});

test("no Metadata within the grace period: upstream is closed anyway, the clock is charged", (t) => {
  const { client, upstream, user, session, tick } = start(t);
  tick(5000);
  client.drop(1000);
  tick(GRACE_MS - 1);
  assert.equal(upstream.readyState, 1);
  tick(1);
  assert.equal(upstream.closedWith?.code, 1000);
  assert.equal(user.used_ms, 5000, "the wait itself is not charged");
  assert.equal(session.ended_at, 1_005_000);
});

test("Deepgram closes: no wait, the client gets the code", (t) => {
  const { client, upstream, user, session, tick } = start(t);
  tick(3000);
  upstream.drop(1011, "boom");
  assert.equal(client.closedWith?.code, 1011);
  assert.equal(user.used_ms, 3000);
  assert.equal(session.end_code, 1011);
});

test("fails closed: when usage cannot be written the stream ends instead of running unmetered", (t) => {
  const { client, upstream, user, setFail, tick, s } = start(t, { quota_ms: 20_000 });
  tick(5000);
  setFail(true);
  tick(10_000); // the 15 s flush cannot write
  assert.equal(client.closedWith?.code, 1011);
  assert.equal(s.done, true);
  assert.equal(user.used_ms, 0, "nothing was written");
  assert.equal(s.charged, 0, "and nothing is counted as charged");
  setFail(false);
  upstream.drop(1000); // Deepgram finishes; the final write now works: the 15 s are charged after all
  assert.equal(user.used_ms, 15_000);
});

test("quota cut still fires at the exact remaining time", (t) => {
  const { client, user, tick } = start(t, { quota_ms: 12_000 });
  tick(11_999);
  assert.equal(client.readyState, 1);
  tick(60);
  assert.equal(client.closedWith?.code, 4402);
  assert.ok(user.used_ms >= 12_000 && user.used_ms <= 12_060, String(user.used_ms));
});

