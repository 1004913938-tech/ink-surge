"""Unit tests: segment ordering, protocol shape, throttling."""

import asyncio

from livecaption_core import Broadcaster, Caption, MemorySink
from livecaption_core.session import SpeakerLane

from conftest import make_session, speaker


def test_lane_interim_then_final_share_segment():
    lane = SpeakerLane(speaker(1))
    c1 = lane.on_interim("我们")
    c2 = lane.on_interim("我们下季度")
    fin, seg = lane.on_final("我们下季度的目标")
    assert c1.sid == c2.sid == fin.sid
    assert c1.seq == 1 and fin.seq == 1
    assert seg.final and seg.text == "我们下季度的目标"
    # next utterance opens a new segment
    c3 = lane.on_interim("第二句")
    assert c3.sid != fin.sid and c3.seq == 2


def test_lane_ignores_blank_and_closes_open_segment():
    lane = SpeakerLane(speaker(1))
    assert lane.on_interim("   ") is None
    lane.on_interim("hello")
    assert lane.on_final("") is None  # empty final closes without emitting
    assert lane.current is None
    lane.on_interim("again")
    closed = lane.close()
    assert closed is not None and closed[1].text == "again" and closed[1].seq == 2


def test_caption_wire_format():
    d = Caption(kind="final", sid="s_1", spk=speaker(1), seq=3, src_lang="zh", src_text="你好",
                tr={"en": "Hello"}, tr_status="ok").to_dict()
    assert d == {
        "v": 1, "kind": "final", "sid": "s_1", "seq": 3, "t": d["t"],
        "spk": {"id": "spk1", "name": "Speaker 1"},
        "src": {"lang": "zh", "text": "你好"},
        "tr": {"en": "Hello"}, "tr_status": "ok",
    }
    p = Caption(kind="patch", sid="s_1", spk=speaker(1), seq=3, tr={"id": "Halo"}, tr_status="ok").to_dict()
    assert "src" not in p and p["tr"] == {"id": "Halo"}
    r = Caption(kind="reset", sid="").to_dict()
    assert set(r) == {"v", "kind", "sid", "seq", "t"}


async def test_session_emits_source_then_patch():
    sess, sink, hub, _ = make_session()
    sess.add_speaker(speaker(1))
    await sess.on_interim("spk1", "我们")
    await sess.on_final("spk1", "我们下季度的目标是增长")
    await hub.drain()
    kinds = [m["kind"] for m in sink.messages]
    assert kinds == ["interim", "final", "patch"]
    final, patch = sink.messages[1], sink.messages[2]
    assert final["sid"] == patch["sid"]
    assert final["tr"] == {} and final["tr_status"] == "pending"
    assert patch["tr"] == {"en": "[en] 我们下季度的目标是增长", "id": "[id] 我们下季度的目标是增长"}
    assert patch["tr_status"] == "ok"


async def test_demanded_langs_follow_listeners_and_exclude_source():
    sess, sink, hub, _ = make_session()
    sess.add_speaker(speaker(1, "zh"))
    assert sess.demanded_langs("zh") == {"en", "id"}
    sess.set_listener_langs("u1", {"ja", "zh"})
    sess.set_listener_langs("u2", {"en"})
    assert sess.demanded_langs("zh") == {"en", "id", "ja"}
    sess.remove_listener("u1")
    assert sess.demanded_langs("zh") == {"en", "id"}
    # an English speaker in the same room is translated into zh too? only if demanded:
    assert sess.demanded_langs("en") == {"id"}


async def test_interim_throttle_coalesces_but_keeps_latest():
    sink = MemorySink()
    bc = Broadcaster(sink, interim_hz=10)  # 100 ms window
    spk = speaker(1)
    for i in range(20):
        await bc.send(Caption(kind="interim", sid="s", spk=spk, seq=1, src_lang="zh", src_text=f"t{i}"))
    await asyncio.sleep(0.15)
    texts = [m["src"]["text"] for m in sink.messages]
    assert texts[0] == "t0" and texts[-1] == "t19"
    assert len(texts) <= 3
    assert bc.coalesced >= 17
    # finals are never throttled and cancel the pending interim
    await bc.send(Caption(kind="interim", sid="s", spk=spk, seq=1, src_lang="zh", src_text="x"))
    await bc.send(Caption(kind="final", sid="s", spk=spk, seq=1, src_lang="zh", src_text="done"))
    await asyncio.sleep(0.15)
    assert sink.messages[-1]["kind"] == "final"
    await bc.aclose()
