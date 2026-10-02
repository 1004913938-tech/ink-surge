"""Real end-to-end check against a running LiveKit + API + agent (LC_STT=demo).

Not collected by pytest (needs infrastructure). Run:
    python tests/e2e_livekit.py
Creates a session through the API, joins as a host that publishes silent audio and as
a listener wanting en+id, and asserts captions with translations arrive in order.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.request

from livekit import rtc

API = os.getenv("LC_API_URL", "http://localhost:8000")
API_KEY = os.getenv("LC_DEV_API_KEY", "lc_dev_key")
HOST_LK_URL = os.getenv("LC_E2E_LIVEKIT_URL")  # override if api returns an in-docker hostname


def api(method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


async def publish_silence(room: rtc.Room, seconds: float) -> None:
    source = rtc.AudioSource(16000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    frame = rtc.AudioFrame(data=bytes(640), sample_rate=16000, num_channels=1, samples_per_channel=320)
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        await source.capture_frame(frame)  # 20 ms, paced by the source


async def main() -> int:
    s = api("POST", "/api/sessions", {"title": "e2e", "host_name": "张总", "src_lang": "zh", "targets": ["en", "id"]},
            {"X-Api-Key": API_KEY})
    j = api("GET", f"/api/join/{s['join_code']}?langs=en,id")
    lk_url = HOST_LK_URL or s["livekit_url"]
    print("session", s["session_id"], "code", s["join_code"], "livekit", lk_url)

    got: list[dict] = []
    listener = rtc.Room()
    listener.register_text_stream_handler("lc.caption", lambda reader, pid: asyncio.ensure_future(_collect(reader, got)))
    await listener.connect(lk_url, j["token"])
    print("listener connected as", listener.local_participant.identity)

    host = rtc.Room()
    await host.connect(lk_url, s["host_token"])
    # The agent is dispatched asynchronously; its first message is `reset`. Measure
    # the join latency (part of the product's "scan to captions in 3 s" promise).
    t0 = time.monotonic()
    pub = asyncio.create_task(publish_silence(host, 60))
    while not any(m["kind"] == "reset" for m in got):
        if time.monotonic() - t0 > 40:
            print("agent never joined (no reset within 40 s)")
            break
        await asyncio.sleep(0.2)
    print(f"agent joined after {time.monotonic() - t0:.1f} s; keeping audio up for 12 s")
    await asyncio.sleep(12)
    pub.cancel()
    await asyncio.sleep(2)
    await host.disconnect()
    await listener.disconnect()

    kinds = [m["kind"] for m in got]
    finals = [m for m in got if m["kind"] == "final"]
    patches = [m for m in got if m["kind"] == "patch"]
    print(f"received {len(got)} msgs: reset={kinds.count('reset')} interim={kinds.count('interim')} "
          f"final={len(finals)} patch={len(patches)}")
    for m in finals:
        tr = next((p["tr"] for p in patches if p["sid"] == m["sid"]), {})
        print(f"  seq {m['seq']}: {m['src']['text']}  ->  {tr}")

    ok = (
        len(finals) >= 2
        and [m["seq"] for m in finals] == list(range(1, len(finals) + 1))
        and all(any(p["sid"] == m["sid"] and set(p["tr"]) == {"en", "id"} for p in patches) for m in finals)
        and all(m["spk"]["name"] == "张总" for m in finals)
    )
    print("E2E", "PASS" if ok else "FAIL")
    return 0 if ok else 1


async def _collect(reader, got: list[dict]) -> None:
    got.append(json.loads(await reader.read_all()))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
