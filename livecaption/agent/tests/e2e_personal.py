"""Real end-to-end check of PERSONAL mode against a running LiveKit + API + agent (LC_STT=demo).

Not collected by pytest (needs infrastructure). Run:
    python tests/e2e_personal.py
The owner publishes "meeting audio" (screen-share audio source) and their mic. The demo STT
plays six participants taking turns in id / en / zh. Asserts:
  * finals are attributed to 说话人 N with the detected language,
  * zh utterances are not translated, others get a zh translation,
  * an intruder who obtains a token for the same room receives NO captions,
  * the personal session is not reachable through /api/join.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request

from livekit import api as lkapi
from livekit import rtc

API = os.getenv("LC_API_URL", "http://localhost:8000")
API_KEY = os.getenv("LC_DEV_API_KEY", "lc_dev_key")
LK_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LK_SECRET = os.getenv("LIVEKIT_API_SECRET", "secretsecretsecretsecretsecret12")


def call(method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


async def publish_silence(room: rtc.Room, source_kind: int, name: str, seconds: float) -> None:
    source = rtc.AudioSource(16000, 1)
    track = rtc.LocalAudioTrack.create_audio_track(name, source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=source_kind))
    frame = rtc.AudioFrame(data=bytes(640), sample_rate=16000, num_channels=1, samples_per_channel=320)
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        await source.capture_frame(frame)


async def main() -> int:
    s = call("POST", "/api/sessions", {"title": "e2e-personal", "host_name": "我", "src_lang": "zh",
                                         "targets": ["zh"], "mode": "personal", "remote_lang": "auto"},
             {"X-Api-Key": API_KEY})
    assert s["join_code"] is None and s["mode"] == "personal", s
    lk_url = s["livekit_url"]
    print("personal session", s["session_id"], "room", s["room"])

    got: list[dict] = []
    intruder_got: list[dict] = []

    owner = rtc.Room()
    owner.register_text_stream_handler(
        "lc.caption", lambda r, pid: asyncio.ensure_future(_collect(r, got)))
    await owner.connect(lk_url, s["host_token"])

    # An intruder with a valid token for the same room must not see the owner's captions.
    tok = (lkapi.AccessToken(LK_KEY, LK_SECRET).with_identity("intruder").with_name("x")
           .with_grants(lkapi.VideoGrants(room_join=True, room=s["room"], can_publish=False)).to_jwt())
    intruder = rtc.Room()
    intruder.register_text_stream_handler(
        "lc.caption", lambda r, pid: asyncio.ensure_future(_collect(r, intruder_got)))
    await intruder.connect(lk_url, tok)

    t0 = time.monotonic()
    meeting = asyncio.create_task(publish_silence(owner, rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO, "meeting-audio", 60))
    while not any(m["kind"] == "reset" for m in got) and time.monotonic() - t0 < 40:
        await asyncio.sleep(0.2)
    print(f"agent joined after {time.monotonic() - t0:.1f} s; meeting audio for 30 s")
    await asyncio.sleep(30)
    meeting.cancel()
    await asyncio.sleep(2)

    try:
        call("GET", f"/api/join/{s['room']}")
        join_blocked = False
    except urllib.error.HTTPError as e:
        join_blocked = e.code == 404
    await owner.disconnect()
    await intruder.disconnect()

    finals = [m for m in got if m["kind"] == "final"]
    patches = {m["sid"]: m for m in got if m["kind"] == "patch"}
    interims = [m for m in got if m["kind"] == "interim"]
    print(f"owner received {len(got)} msgs: interim={len(interims)} final={len(finals)} patch={len(patches)}; "
          f"intruder received {len(intruder_got)}")
    for f in finals:
        tr = patches.get(f["sid"], {}).get("tr", {})
        print(f"  {f['spk']['name']:<6} [{f['src']['lang']}] {f['src']['text']}  ->  {tr.get('zh', '(no translation: already zh)')}")

    names = [f["spk"]["name"] for f in finals]
    checks = {
        ">= 6 finals": len(finals) >= 6,
        "6 distinct speakers numbered 1..6": sorted(set(names)) == [f"说话人 {n}" for n in range(1, 7)],
        # the utterance still in flight when the test stopped the audio has no final yet
        "interims replaced in place": {m["sid"] for m in interims if m["t"] <= finals[-1]["t"]}
                                      <= {f["sid"] for f in finals},
        "interims unattributed (会议声音)": all(m["spk"]["name"] == "会议声音" for m in interims),
        "languages detected": {f["src"]["lang"] for f in finals} >= {"id", "en", "zh"},
        "zh not translated, others -> zh": all(
            (set(patches[f["sid"]]["tr"]) == set()) if f["src"]["lang"] == "zh"
            else (set(patches[f["sid"]]["tr"]) == {"zh"}) for f in finals if f["sid"] in patches),
        "every final has a patch": all(f["sid"] in patches for f in finals),
        "intruder saw nothing": len(intruder_got) == 0,
        "join code lookup blocked": join_blocked,
    }
    orphan = [m for m in interims if m["sid"] not in {f["sid"] for f in finals}]
    for m in orphan:
        print("  orphan interim:", m["sid"], m["src"]["text"], "t=", m["t"])
    print("  last final t=", finals[-1]["t"] if finals else None)
    for k, v in checks.items():
        print(("  ok   " if v else "  FAIL ") + k)
    ok = all(checks.values())
    print("E2E PERSONAL", "PASS" if ok else "FAIL")
    return 0 if ok else 1


async def _collect(reader, got: list[dict]) -> None:
    got.append(json.loads(await reader.read_all()))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
