import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptionStore, parseCaption, type CaptionMsg } from "../src/captions";

const spk = { id: "spk1", name: "A" };
const msg = (p: Partial<CaptionMsg>): CaptionMsg => ({ v: 1, kind: "final", sid: "s", seq: 1, t: 1, spk, src: { lang: "zh", text: "x" }, tr: {}, tr_status: "pending", ...p });

test("merge by sid, patch fills translations, duplicates idempotent", () => {
  const s = new CaptionStore();
  s.apply(msg({ kind: "interim", sid: "a", seq: 1, src: { lang: "zh", text: "我" }, t: 1 }));
  s.apply(msg({ kind: "interim", sid: "a", seq: 1, src: { lang: "zh", text: "我们" }, t: 2 }));
  s.apply(msg({ kind: "final", sid: "a", seq: 1, src: { lang: "zh", text: "我们好" }, t: 3 }));
  s.apply(msg({ kind: "interim", sid: "a", seq: 1, src: { lang: "zh", text: "stale" }, t: 1.5 })); // late interim ignored
  s.apply(msg({ kind: "patch", sid: "a", seq: 1, tr: { en: "We are fine", id: "Kami baik" }, tr_status: "ok" }));
  s.apply(msg({ kind: "patch", sid: "a", seq: 1, tr: { en: "We are fine", id: "Kami baik" }, tr_status: "ok" }));
  const [l] = s.lines();
  assert.equal(s.size(), 1);
  assert.equal(l.text, "我们好");
  assert.equal(l.final, true);
  assert.deepEqual(l.tr, { en: "We are fine", id: "Kami baik" });
});

test("out-of-order delivery across speakers renders each speaker in seq order", () => {
  const s = new CaptionStore();
  const b = { id: "spk2", name: "B" };
  s.apply(msg({ sid: "a2", seq: 2, t: 4 }));
  s.apply(msg({ sid: "b1", seq: 1, t: 2, spk: b }));
  s.apply(msg({ sid: "a1", seq: 1, t: 3 }));
  s.apply(msg({ sid: "b2", seq: 2, t: 5, spk: b }));
  const per = s.bySpeaker(10);
  assert.deepEqual(per.get("spk1")!.map((l) => l.seq), [1, 2]);
  assert.deepEqual(per.get("spk2")!.map((l) => l.seq), [1, 2]);
  assert.deepEqual(s.lines().map((l) => l.sid), ["b1", "a1", "a2", "b2"]);
});

test("reset clears; patch for unknown sid ignored; cap on lines", () => {
  const s = new CaptionStore(3);
  for (let i = 1; i <= 5; i++) s.apply(msg({ sid: "s" + i, seq: i, t: i }));
  assert.equal(s.size(), 3);
  s.apply(msg({ kind: "patch", sid: "nope", tr: { en: "x" } }));
  assert.equal(s.size(), 3);
  s.apply({ v: 1, kind: "reset", sid: "", seq: 0, t: 9 });
  assert.equal(s.size(), 0);
});

test("parseCaption rejects garbage and wrong version", () => {
  assert.equal(parseCaption("not json"), null);
  assert.equal(parseCaption(JSON.stringify({ v: 2, kind: "final" })), null);
  assert.ok(parseCaption(JSON.stringify(msg({}))));
});

test("personal mode: unattributed interim becomes the named speaker's final in place", () => {
  const s = new CaptionStore();
  const meeting = { id: "u:meeting", name: "会议声音" };
  s.apply(msg({ kind: "interim", sid: "x", seq: 0, t: 1, spk: meeting, src: { lang: "auto", text: "Selamat" } }));
  s.apply(msg({ sid: "y", seq: 1, t: 2, spk: { id: "tr#S1", name: "说话人 2" }, src: { lang: "en", text: "Hi" } }));
  s.apply(msg({ kind: "final", sid: "x", seq: 1, t: 3, spk: { id: "tr#S0", name: "说话人 1" }, src: { lang: "id", text: "Selamat pagi." } }));
  const lines = s.lines();
  assert.deepEqual(lines.map((l) => [l.sid, l.speakerName, l.srcLang]), [["x", "说话人 1", "id"], ["y", "说话人 2", "en"]]);
  assert.equal(lines[0].final, true);
});

test("retract removes a line and blocks late messages for it", () => {
  const s = new CaptionStore();
  s.apply(msg({ kind: "interim", sid: "echo", t: 1 }));
  s.apply({ v: 1, kind: "retract", sid: "echo", seq: 0, t: 2 });
  s.apply(msg({ kind: "final", sid: "echo", t: 3 }));
  s.apply(msg({ kind: "patch", sid: "echo", tr: { zh: "x" } }));
  assert.equal(s.size(), 0);
});

test("speaker colours: distinct by first appearance, placeholder grey", async () => {
  const { speakerColor } = await import("../src/speakers");
  const ids = ["t#1:S0", "t#1:S1", "t#1:S2", "t#1:S3", "t#1:S4", "t#1:S5"];
  const colours = ids.map(speakerColor);
  assert.equal(new Set(colours).size, 6);
  assert.equal(speakerColor("t#1:S0"), colours[0]); // stable
  assert.equal(speakerColor("host-1:meeting"), "#6b7280");
});
