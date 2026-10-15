// Unit tests for the pure logic block (<script id="lc-core">) of ../index.html.
// Run: node --test livecaption/lite/tests/core.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

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
