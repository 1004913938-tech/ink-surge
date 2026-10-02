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
