"""Real-STT evaluation of PERSONAL mode: a recorded meeting -> LiveKit -> agent (LC_STT=soniox).

Not collected by pytest (needs LiveKit + API + agent running with a real SONIOX_API_KEY). Run:
    python tests/make_meeting_audio.py /tmp/meeting        # once: TTS meeting + ground truth
    python tests/e2e_soniox_personal.py /tmp/meeting [result.json]

The owner publishes meeting.wav in real time as screen-share audio (= "会议声音") into a new
personal room. Every caption message is timestamped on arrival and aligned with the ground
truth by text overlap. Reports:
  * diarization: distinct 说话人 N vs 6 real people, one-to-one mapping accuracy (by characters/words),
    mid-sentence hand-overs split into two speakers,
  * language: detected src.lang of each final vs the truth,
  * latency: end of an utterance -> its final caption; start -> first interim.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import statistics
import sys
import time
import urllib.request
import wave
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from livekit import rtc

API = os.getenv("LC_API_URL", "http://localhost:8000")
API_KEY = os.getenv("LC_DEV_API_KEY", "lc_dev_key")
FRAME_MS = 20

_PUNCT = re.compile(r"[^\w\s]+|_", re.UNICODE)
_CJK = re.compile(r"[㐀-鿿]")


def units(text: str) -> list[str]:
    """Characters for Chinese, lower-cased words otherwise (mixed text: both)."""
    out: list[str] = []
    for tok in _PUNCT.sub(" ", text.lower()).split():
        out.extend(list(tok) if _CJK.search(tok) else [tok])
    return out


def overlap(a: list[str], b: list[str]) -> int:
    return sum((Counter(a) & Counter(b)).values())


def call(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "X-Api-Key": API_KEY})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


async def play(room: rtc.Room, pcm: np.ndarray, sr: int, ready: asyncio.Event) -> float:
    """Publish as screen-share audio: silence until `ready` (agent joined and its STT is up),
    then `pcm` paced in real time. Returns the wall time of pcm sample 0."""
    source = rtc.AudioSource(sr, 1)
    track = rtc.LocalAudioTrack.create_audio_track("meeting-audio", source)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO))
    n = sr * FRAME_MS // 1000
    silence = rtc.AudioFrame(bytes(2 * n), sr, 1, n)
    t_mono = time.monotonic()
    while not ready.is_set():
        await source.capture_frame(silence)
        t_mono += FRAME_MS / 1000
        await asyncio.sleep(max(0.0, t_mono - time.monotonic()))
    t0_mono, t0_wall = time.monotonic(), time.time()
    for k, i in enumerate(range(0, len(pcm) - n + 1, n)):
        await source.capture_frame(rtc.AudioFrame(pcm[i:i + n].tobytes(), sr, 1, n))
        await asyncio.sleep(max(0.0, t0_mono + (k + 1) * FRAME_MS / 1000 - time.monotonic()))
    return t0_wall


def assign(text: str, truth: list[dict]) -> tuple[int, list[int]]:
    """Best ground-truth utterance for a caption, plus every utterance it covers >= 30 %."""
    u = units(text)
    if not u:
        return -1, []
    scores = [overlap(u, t["_u"]) for t in truth]
    best = max(range(len(truth)), key=lambda i: scores[i])
    covers = [i for i, t in enumerate(truth) if scores[i] >= 0.3 * len(t["_u"]) and scores[i] >= 2]
    return (best if scores[best] >= max(2, 0.3 * len(u)) else -1), covers


def evaluate(msgs: list[dict], truth: list[dict], t0: float) -> dict:
    for t in truth:
        t["_u"] = units(t["text"])
    retracted = {m["sid"] for m in msgs if m["kind"] == "retract"}
    finals = [m for m in msgs if m["kind"] == "final" and m["sid"] not in retracted]
    interims = [m for m in msgs if m["kind"] == "interim"]

    rows = []
    for f in finals:
        best, covers = assign(f["src"]["text"], truth)
        rows.append({"sid": f["sid"], "spk": f["spk"]["name"], "lang": f["src"].get("lang"),
                     "text": f["src"]["text"], "arrived": f["_rx"] - t0, "truth": best, "covers": covers})

    # diarization: one-to-one mapping label -> person by shared units (greedy on counts)
    weight: Counter[tuple[str, str]] = Counter()
    for r in rows:
        if r["truth"] >= 0:
            weight[(r["spk"], truth[r["truth"]]["speaker"])] += len(units(r["text"]))
    mapping: dict[str, str] = {}
    for (lab, person), _ in weight.most_common():
        if lab not in mapping and person not in mapping.values():
            mapping[lab] = person
    total = sum(weight.values()) or 1
    correct = sum(w for (lab, person), w in weight.items() if mapping.get(lab) == person)
    labels = sorted({r["spk"] for r in rows})

    # language
    lang_ok = [r for r in rows if r["truth"] >= 0 and r["lang"] == truth[r["truth"]]["lang"]]
    lang_bad = [r for r in rows if r["truth"] >= 0 and r["lang"] != truth[r["truth"]]["lang"]]

    # latency per utterance
    per_utt = []
    for i, t in enumerate(truth):
        mine = [r for r in rows if r["truth"] == i]
        first_int = None
        for m in interims:
            if m["_rx"] - t0 >= t["start"] and assign(m["src"]["text"], truth)[0] == i:
                first_int = m["_rx"] - t0
                break
        persons = sorted({mapping.get(r["spk"], "?" + r["spk"]) for r in mine})
        per_utt.append({
            "i": i, "speaker": t["speaker"], "lang": t["lang"], "handover": t["handover"],
            "start": t["start"], "end": t["end"],
            "final_at": max((r["arrived"] for r in mine), default=None),
            "end_to_final": round(max(r["arrived"] for r in mine) - t["end"], 3) if mine else None,
            "start_to_first_interim": round(first_int - t["start"], 3) if first_int is not None else None,
            "got_speakers": persons, "got_langs": sorted({r["lang"] for r in mine}),
            "speaker_ok": persons == [t["speaker"]], "lang_ok": bool(mine) and all(
                r["lang"] == t["lang"] for r in mine),
            "merged_with": sorted({j for r in mine for j in r["covers"] if j != i}),
        })
    lat = [u["end_to_final"] for u in per_utt if u["end_to_final"] is not None]
    first = [u["start_to_first_interim"] for u in per_utt if u["start_to_first_interim"] is not None]
    handovers = [u for u in per_utt if u["handover"]]
    return {
        "finals": rows,
        "utterances": per_utt,
        "summary": {
            "messages": Counter(m["kind"] for m in msgs),
            "real_speakers": len({t["speaker"] for t in truth}),
            "labels": labels, "mapping": mapping,
            "diarization_accuracy": round(correct / total, 4),
            "utterances_speaker_ok": sum(u["speaker_ok"] for u in per_utt),
            "handover_split_ok": sum(u["speaker_ok"] and not u["merged_with"] for u in handovers),
            "handovers": len(handovers),
            "finals_lang_ok": len(lang_ok), "finals_lang_bad": len(lang_bad),
            "utterances_lang_ok": sum(u["lang_ok"] for u in per_utt),
            "utterances_missing": [u["i"] for u in per_utt if u["final_at"] is None],
            "unmatched_finals": [r["text"] for r in rows if r["truth"] < 0],
            "end_to_final_s": _stats(lat),
            "start_to_first_interim_s": _stats(first),
        },
    }


def _stats(xs: list[float]) -> dict:
    if not xs:
        return {}
    xs = sorted(xs)
    return {"n": len(xs), "min": round(xs[0], 3), "median": round(statistics.median(xs), 3),
            "mean": round(statistics.fmean(xs), 3), "p90": round(xs[min(len(xs) - 1, int(0.9 * len(xs)))], 3),
            "max": round(xs[-1], 3)}


async def main(audio_dir: Path, out: Path | None) -> int:
    meta = json.loads((audio_dir / "meeting.json").read_text())
    truth = meta["utterances"]
    with wave.open(str(audio_dir / "meeting.wav")) as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)

    s = call("POST", "/api/sessions", {"title": "e2e-soniox", "host_name": "我", "src_lang": "zh",
                                         "targets": ["zh"], "mode": "personal", "remote_lang": "auto"})
    print("personal session", s["session_id"], "room", s["room"])
    msgs: list[dict] = []

    async def collect(reader) -> None:
        m = json.loads(await reader.read_all())
        m["_rx"] = time.time()
        msgs.append(m)

    owner = rtc.Room()
    owner.register_text_stream_handler("lc.caption", lambda r, pid: asyncio.ensure_future(collect(r)))
    await owner.connect(s["livekit_url"], s["host_token"])
    ready = asyncio.Event()
    play_task = asyncio.create_task(play(owner, pcm, sr, ready))
    t_wait = time.monotonic()
    while not any(m["kind"] == "reset" for m in msgs) and time.monotonic() - t_wait < 40:
        await asyncio.sleep(0.2)
    if not any(m["kind"] == "reset" for m in msgs):
        print("agent never joined")
        return 2
    print(f"agent joined after {time.monotonic() - t_wait:.1f} s; playing {len(pcm) / sr:.1f} s of meeting audio")
    await asyncio.sleep(2.0)  # the agent subscribes and opens its STT websocket
    ready.set()
    t0 = await play_task
    await asyncio.sleep(5)
    await owner.disconnect()

    res = evaluate(msgs, truth, t0)
    for r in res["finals"]:
        tr = truth[r["truth"]] if r["truth"] >= 0 else None
        mark = "" if tr and tr["lang"] == r["lang"] else "  <-- lang"
        print(f"  {r['arrived']:6.2f}s {r['spk']:<6} [{r['lang']}] {r['text']}"
              f"   (truth #{r['truth']} {tr['speaker'] if tr else '-'} {tr['lang'] if tr else ''}){mark}")
    print()
    for u in res["utterances"]:
        print(f"  #{u['i']:<2} {u['speaker']} {u['lang']} {'handover' if u['handover'] else '        '} "
              f"end->final={u['end_to_final']}  start->interim={u['start_to_first_interim']}  "
              f"got={u['got_speakers']} {u['got_langs']} merged={u['merged_with']}")
    print(json.dumps(res["summary"], ensure_ascii=False, indent=1))
    if out:
        out.write_text(json.dumps({"truth": truth, "messages": msgs, **res}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else None)))
