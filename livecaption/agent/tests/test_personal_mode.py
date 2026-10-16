"""Personal mode: one user, meeting audio (diarized) + optional own mic, captions only for them.

Invariants (ARCHITECTURE.md §3a):
  P1  An unattributed interim line is replaced IN PLACE (same sid) by its final, which
      carries the real speaker.
  P2  Diarized speakers get stable lanes "说话人 N" numbered by first appearance; each
      lane's seq is gap-free and its patches arrive in order.
  P3  A final that spans a speaker change is split per speaker.
  P4  Per-utterance language: only translate into display languages != utterance lang.
  P5  Echo: the mic hearing the meeting through loudspeakers never shows a duplicate line.
"""

import asyncio
import random
from collections import defaultdict

from livecaption_core import FakeTranslator, SessionConfig, SpeakerInfo, TranslationHubConfig
from livecaption_core.tracks import TrackSpec, Word, similarity, word_runs

from conftest import make_session

ME = SpeakerInfo(id="me", name="我", lang="zh")
MEETING = SpeakerInfo(id="me:sys", name="会议声音", lang="auto")


def personal(**cfg):
    sc = SessionConfig(base_targets=frozenset({"zh"}), **cfg)
    sess, sink, hub, bc = make_session(session_cfg=sc, hub_cfg=TranslationHubConfig(reorder_window_s=5.0))
    sess.add_track(TrackSpec("sys", MEETING, diarized=True))
    return sess, sink, hub


async def test_interim_line_is_replaced_by_attributed_final():
    sess, sink, hub = personal()
    await sess.on_track_interim("sys", "Selamat")
    await sess.on_track_interim("sys", "Selamat pagi")
    await sess.on_track_final("sys", "Selamat pagi semuanya.", speaker_label="S0", lang="id")
    await hub.drain()
    i1, i2, fin, patch = sink.messages
    assert i1["kind"] == i2["kind"] == "interim"
    assert i1["sid"] == i2["sid"] == fin["sid"] == patch["sid"]  # P1
    assert i1["spk"]["name"] == "会议声音"
    assert fin["spk"] == {"id": "sys#S0", "name": "说话人 1"}
    assert fin["src"] == {"lang": "id", "text": "Selamat pagi semuanya."}
    assert patch["tr"] == {"zh": "[zh] Selamat pagi semuanya."}


async def test_speakers_numbered_by_first_appearance_and_lanes_ordered():
    sess, sink, hub = personal()
    for label in ["S3", "S0", "S3", "S1", "S0"]:
        await sess.on_track_final("sys", f"hello from {label}", speaker_label=label, lang="en")
    await hub.drain()
    finals = [m for m in sink.messages if m["kind"] == "final"]
    assert [(m["spk"]["name"], m["seq"]) for m in finals] == [
        ("说话人 1", 1), ("说话人 2", 1), ("说话人 1", 2), ("说话人 3", 1), ("说话人 2", 2),
    ]


async def test_final_spanning_speaker_change_is_split():
    sess, sink, hub = personal()
    await sess.on_track_interim("sys", "ok so the price")
    words = [Word("ok", "S0"), Word("so", "S0"), Word("the", "S0"), Word("price?", "S0"),
             Word("Harganya", "S1"), Word("naik.", "S1")]
    await sess.on_track_final("sys", "ok so the price? Harganya naik.", words=words, lang="en")
    await hub.drain()
    interim = sink.messages[0]
    finals = [m for m in sink.messages if m["kind"] == "final"]
    assert [(f["spk"]["name"], f["src"]["text"]) for f in finals] == [
        ("说话人 1", "ok so the price?"), ("说话人 2", "Harganya naik."),
    ]
    assert finals[0]["sid"] == interim["sid"] and finals[1]["sid"] != interim["sid"]  # P3


def test_word_runs_joins_cjk_without_spaces():
    runs = word_runs([Word("我们", "S0"), Word("下季度", "S0"), Word("好的", "S1")], "zh")
    assert [(r.speaker, r.text) for r in runs] == [("S0", "我们下季度"), ("S1", "好的")]


async def test_per_utterance_language_controls_translation():
    sess, sink, hub = personal()
    sess.cfg.base_targets = frozenset({"zh", "en"})
    await sess.on_track_final("sys", "我们同意这个价格。", speaker_label="S0", lang="zh")
    await sess.on_track_final("sys", "Kami setuju.", speaker_label="S1", lang="id")
    await hub.drain()
    patches = {m["sid"]: m for m in sink.messages if m["kind"] == "patch"}
    finals = [m for m in sink.messages if m["kind"] == "final"]
    assert set(patches[finals[0]["sid"]]["tr"]) == {"en"}         # zh source: only en
    assert set(patches[finals[1]["sid"]]["tr"]) == {"zh", "en"}   # id source: zh + en  (P4)


async def test_six_speakers_random_interleaving_invariants():
    tr = FakeTranslator(latency=lambda: random.Random().uniform(0, 0.02))
    sc = SessionConfig(base_targets=frozenset({"zh", "en"}))
    sess, sink, hub, _ = make_session(translator=tr, session_cfg=sc,
                                      hub_cfg=TranslationHubConfig(reorder_window_s=5.0))
    sess.add_track(TrackSpec("sys", MEETING, diarized=True))
    rng = random.Random(42)
    order = [f"S{rng.randrange(6)}" for _ in range(120)]
    langs = ["id", "en", "zh"]
    for i, label in enumerate(order):
        await sess.on_track_interim("sys", f"partial {i}")
        await sess.on_track_final("sys", f"utterance {i} by {label}", speaker_label=label,
                                  lang=langs[int(label[1]) % 3])
    await hub.drain()
    per = defaultdict(list)
    patches = defaultdict(list)
    for m in sink.messages:
        if m["kind"] == "final":
            per[m["spk"]["id"]].append(m["seq"])
        if m["kind"] == "patch":
            patches[m["spk"]["id"]].append(m["seq"])
    assert len(per) == 6
    for spk, seqs in per.items():
        assert seqs == list(range(1, len(seqs) + 1)), spk          # P2 gap-free
        assert patches[spk] == seqs, spk                            # P2 in-order patches
    names = {m["spk"]["id"]: m["spk"]["name"] for m in sink.messages if m["kind"] == "final"}
    first_seen = list(dict.fromkeys(order))
    assert [names[f"sys#{l}"] for l in first_seen] == [f"说话人 {n}" for n in range(1, 7)]
    # every interim line was replaced by exactly one final with the same sid
    interim_sids = {m["sid"] for m in sink.messages if m["kind"] == "interim"}
    final_sids = {m["sid"] for m in sink.messages if m["kind"] == "final"}
    assert interim_sids <= final_sids


async def test_echo_mic_after_meeting_audio_is_dropped():
    sess, sink, hub = personal(echo_hold_s=0.2)
    sess.add_track(TrackSpec("mic", ME, echo_guard=True))
    await sess.on_track_final("sys", "Selamat pagi semuanya, mari kita mulai.", speaker_label="S0", lang="id")
    await sess.on_track_interim("mic", "selamat pagi")
    await sess.on_track_final("mic", "selamat pagi semuanya mari kita mulai", lang="zh")
    await asyncio.sleep(0.3)
    await hub.drain()
    mic_msgs = [m for m in sink.messages if m.get("spk", {}).get("id") == "me"]
    assert [m["kind"] for m in mic_msgs] == ["interim"]           # never finalised
    retract = [m for m in sink.messages if m["kind"] == "retract"]
    assert [r["sid"] for r in retract] == [mic_msgs[0]["sid"]]    # P5: interim line removed
    assert sess.metrics["echo_dropped"] == 1


async def test_echo_mic_before_meeting_audio_is_dropped_during_hold():
    sess, sink, hub = personal(echo_hold_s=0.5)
    sess.add_track(TrackSpec("mic", ME, echo_guard=True))
    await sess.on_track_final("mic", "we can deliver in november", lang="zh")
    await asyncio.sleep(0.1)
    await sess.on_track_final("sys", "We can deliver in November.", speaker_label="S2", lang="en")
    await asyncio.sleep(0.6)
    await hub.drain()
    assert not any(m["kind"] == "final" and m["spk"]["id"] == "me" for m in sink.messages)
    assert sess.metrics["echo_dropped"] == 1


async def test_echo_after_release_is_retracted():
    sess, sink, hub = personal(echo_hold_s=0.0)
    sess.add_track(TrackSpec("mic", ME, echo_guard=True))
    await sess.on_track_final("mic", "harga sudah termasuk ongkos kirim", lang="zh")
    mine = next(m for m in sink.messages if m["kind"] == "final")
    await sess.on_track_final("sys", "Harga sudah termasuk ongkos kirim.", speaker_label="S0", lang="id")
    await hub.drain()
    assert any(m["kind"] == "retract" and m["sid"] == mine["sid"] for m in sink.messages)


async def test_my_real_speech_is_shown_after_hold():
    sess, sink, hub = personal(echo_hold_s=0.1)
    sess.add_track(TrackSpec("mic", ME, echo_guard=True))
    await sess.on_track_final("sys", "Kapan barangnya dikirim?", speaker_label="S0", lang="id")
    await sess.on_track_final("mic", "下周三发货，我们会提供物流单号。", lang="zh")
    await asyncio.sleep(0.2)
    await hub.drain()
    mine = [m for m in sink.messages if m["kind"] == "final" and m["spk"]["id"] == "me"]
    assert len(mine) == 1 and sess.metrics["echo_dropped"] == 0


async def test_mic_not_held_without_meeting_track():
    sess, sink, hub, _ = make_session(session_cfg=SessionConfig(base_targets=frozenset({"en"}), echo_hold_s=5))
    sess.add_track(TrackSpec("mic", ME, echo_guard=True))
    await sess.on_track_final("mic", "你好", lang="zh")
    assert sink.messages[-1]["kind"] == "final"  # immediately, no 5 s hold


async def test_track_removed_mid_sentence_and_empty_final_retracts():
    sess, sink, hub = personal()
    await sess.on_track_interim("sys", "Baik, jadi")
    await sess.on_track_final("sys", "")  # STT gave up on it
    assert sink.messages[-1]["kind"] == "retract"
    await sess.on_track_interim("sys", "terima kasih")
    await sess.remove_track("sys")
    await hub.drain()
    fin = [m for m in sink.messages if m["kind"] == "final"]
    assert fin and fin[-1]["src"]["text"] == "terima kasih" and fin[-1]["spk"]["name"] == "会议声音"


def test_similarity_bounds():
    assert similarity("Selamat pagi!", "selamat pagi") == 1.0
    assert similarity("你好世界", "完全不同的话") == 0.0
    assert similarity("", "x") == 0.0


# ---------------------------------------------------------------- review regressions

async def test_unrelated_same_language_reply_is_not_dropped_as_echo():
    # review #0: bigram-set Dice matched these at 0.54 and silently dropped my reply
    sess, sink, hub = personal(echo_hold_s=0.1)
    sess.add_track(TrackSpec("mic", ME, echo_guard=True))
    await sess.on_track_final("sys", "So the plan is to deliver the first container next week and the second one "
                                     "at the end of the month.", speaker_label="S0", lang="en")
    await sess.on_track_final("mic", "Okay, then we need the payment of thirty percent before the first container "
                                     "leaves the port.", lang="en")
    await asyncio.sleep(0.2)
    await sess.on_track_final("sys", "Can you confirm the price for the second container and when we should expect "
                                     "the invoice?", speaker_label="S1", lang="en")
    await hub.drain()
    mine = [m for m in sink.messages if m["kind"] == "final" and m["spk"]["id"] == "me"]
    assert len(mine) == 1 and sess.metrics["echo_dropped"] == 0
    assert not any(m["kind"] == "retract" for m in sink.messages)


async def test_short_reply_only_dropped_when_simultaneous():
    sess, sink, hub = personal(echo_hold_s=0.05)
    sess.add_track(TrackSpec("mic", ME, echo_guard=True))
    await sess.on_track_final("sys", "OK.", speaker_label="S0", lang="en")
    await sess.on_track_final("mic", "OK", lang="en")          # same instant -> echo
    assert sess.metrics["echo_dropped"] == 1
    sess._echo._items.clear()
    sess._echo.add("好的。", at=__import__("time").monotonic() - 2.5)  # said 2.5 s ago by someone else
    await sess.on_track_final("mic", "好的", lang="zh")          # my own 好的 -> keep
    await asyncio.sleep(0.1)
    await hub.drain()
    assert sess.metrics["echo_dropped"] == 1
    assert any(m["kind"] == "final" and m["spk"]["id"] == "me" and m["src"]["text"] == "好的" for m in sink.messages)


async def test_split_runs_keep_their_own_language():
    # review #1/#5: both runs used to inherit the endpoint's majority language (zh)
    sess, sink, hub = personal()
    words = [Word("我们这边没问题，", "S0", "zh"), Word("What", "S1", "en"), Word("about", "S1", "en"),
             Word("the", "S1", "en"), Word("payment?", "S1", "en")]
    await sess.on_track_final("sys", "我们这边没问题，What about the payment?", words=words, lang="zh")
    await hub.drain()
    finals = [m for m in sink.messages if m["kind"] == "final"]
    patches = {m["sid"]: m for m in sink.messages if m["kind"] == "patch"}
    assert [(f["src"]["lang"], f["src"]["text"]) for f in finals] == [
        ("zh", "我们这边没问题，"), ("en", "What about the payment?")]
    assert patches[finals[0]["sid"]]["tr"] == {}                          # zh for a zh reader
    assert patches[finals[1]["sid"]]["tr"] == {"zh": "[zh] What about the payment?"}


async def test_labels_from_a_new_stt_connection_get_new_lanes():
    # review #2/#4: the worker namespaces labels by connection generation ("<gen>:<label>")
    sess, sink, hub = personal()
    await sess.on_track_final("sys", "Saya Budi.", speaker_label="1:S0", lang="id")
    await sess.on_track_final("sys", "I am Alice.", speaker_label="1:S1", lang="en")
    await sess.on_track_final("sys", "Still Alice here.", speaker_label="2:S0", lang="en")  # after reconnect
    await hub.drain()
    finals = [(m["spk"]["id"], m["spk"]["name"]) for m in sink.messages if m["kind"] == "final"]
    assert finals[2][0] != finals[0][0] and finals[2][1] == "说话人 3"


async def test_resubscribe_while_old_pipe_closes_keeps_new_state():
    # review #3: old pipe's late remove_track must not delete the new pipe's state
    sess, sink, hub = personal()
    old = TrackSpec("t1", MEETING, diarized=True)
    sess.add_track(old)
    new = TrackSpec("t1", MEETING, diarized=True)  # equal fields, different pipe
    sess.add_track(new)
    await sess.remove_track("t1", spec=old)          # old pipe finishes closing
    await sess.on_track_final("t1", "masih jalan", speaker_label="1:S0", lang="id")
    await hub.drain()
    assert any(m["kind"] == "final" and m["src"]["text"] == "masih jalan" for m in sink.messages)
    await sess.remove_track("t1", spec=new)
    assert "t1" not in sess._tracks
