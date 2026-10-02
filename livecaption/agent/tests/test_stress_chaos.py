"""Stress and chaos tests for the caption core.

Invariants proven here (see ARCHITECTURE.md §3):
  I1  Within a speaker, finals and their patches are delivered in strictly increasing seq.
  I2  Messages from different speakers never share a sid; each speaker's seq is gap-free.
  I3  Source captions are never delayed by translation (slow / dead translator).
  I4  Every final gets exactly one patch (ok / failed / late / skipped) — nothing is lost.
  I5  Translator outages trip the breaker and the session keeps producing source text.
"""

import asyncio
import random
import time
from collections import defaultdict

import pytest

from livecaption_core import FakeTranslator, TranslationHubConfig, SessionConfig

from conftest import jitter, make_session, speaker


def _by_speaker(messages):
    out = defaultdict(list)
    for m in messages:
        if m["kind"] in ("final", "patch"):
            out[m["spk"]["id"]].append(m)
    return out


def _assert_invariants(messages, n_speakers, n_utt_per_speaker, *, allow_late=False):
    per = _by_speaker(messages)
    assert len(per) == n_speakers
    all_sids = set()
    for spk, msgs in per.items():
        finals = [m for m in msgs if m["kind"] == "final"]
        patches = [m for m in msgs if m["kind"] == "patch"]
        # I2: gap-free seqs, unique sids
        assert [m["seq"] for m in finals] == list(range(1, n_utt_per_speaker + 1))
        sids = {m["sid"] for m in finals}
        assert len(sids) == n_utt_per_speaker and not (sids & all_sids)
        all_sids |= sids
        # I4: exactly one patch per final
        assert sorted(m["sid"] for m in patches) == sorted(sids)
        # I1: patches are released in seq order (unless the reorder window gave up)
        patch_seqs = [m["seq"] for m in patches]
        if not allow_late:
            assert patch_seqs == sorted(patch_seqs), f"{spk}: patches out of order {patch_seqs}"


async def _drive(sess, speakers, n_utt, *, interim_per_utt=2, gap=lambda: 0.0):
    async def one(spk):
        sess.add_speaker(spk)
        for i in range(1, n_utt + 1):
            for j in range(interim_per_utt):
                await sess.on_interim(spk.id, f"{spk.id} 句{i} 部分{j}")
                g = gap()
                if g:
                    await asyncio.sleep(g)
            await sess.on_final(spk.id, f"{spk.id} 第{i}句话 完整")
    await asyncio.gather(*(one(s) for s in speakers))


async def test_eight_speakers_concurrent_jittery_translator():
    tr = FakeTranslator(latency=jitter(0.001, 0.05, seed=7))
    sess, sink, hub, _ = make_session(translator=tr, hub_cfg=TranslationHubConfig(reorder_window_s=5.0))
    spks = [speaker(i) for i in range(8)]
    await _drive(sess, spks, 25, gap=jitter(0, 0.003, seed=3))
    await hub.drain()
    _assert_invariants(sink.messages, 8, 25)
    assert hub.metrics["failed"] == 0 and hub.metrics["late"] == 0


async def test_out_of_order_translation_is_released_in_order():
    # Make the FIRST call slow and the rest instant: seq 1 finishes last.
    calls = {"n": 0}

    def lat():
        calls["n"] += 1
        return 0.3 if calls["n"] == 1 else 0.0

    tr = FakeTranslator(latency=lat)
    sess, sink, hub, _ = make_session(translator=tr, hub_cfg=TranslationHubConfig(reorder_window_s=2.0))
    sess.add_speaker(speaker(1))
    for i in range(1, 6):
        await sess.on_final("spk1", f"句子{i}")
    await hub.drain()
    patches = [m["seq"] for m in sink.messages if m["kind"] == "patch"]
    assert patches == [1, 2, 3, 4, 5]
    assert hub.metrics["late"] == 0


async def test_reorder_window_gives_up_on_stuck_segment():
    calls = {"n": 0}

    def lat():
        calls["n"] += 1
        return 1.0 if calls["n"] == 1 else 0.0  # seq 1 stuck for 1 s

    tr = FakeTranslator(latency=lat)
    sess, sink, hub, _ = make_session(translator=tr, hub_cfg=TranslationHubConfig(reorder_window_s=0.1, timeout_s=5))
    sess.add_speaker(speaker(1))
    for i in range(1, 4):
        await sess.on_final("spk1", f"句子{i}")
    t0 = time.monotonic()
    await asyncio.sleep(0.3)
    # seq 2 and 3 must already be out, marked late; seq 1 still pending
    early = [(m["seq"], m["tr_status"]) for m in sink.messages if m["kind"] == "patch"]
    assert early == [(2, "late"), (3, "late")]
    await hub.drain()
    assert time.monotonic() - t0 < 2.0
    final = [(m["seq"], m["tr_status"]) for m in sink.messages if m["kind"] == "patch"]
    assert final == [(2, "late"), (3, "late"), (1, "late")]
    _assert_invariants(sink.messages, 1, 3, allow_late=True)


async def test_source_captions_not_delayed_by_dead_translator():
    class Dead:
        async def translate(self, *a, **k):
            await asyncio.sleep(10)
            raise RuntimeError("never")

    sess, sink, hub, _ = make_session(
        translator=Dead(),
        hub_cfg=TranslationHubConfig(timeout_s=0.2, retries=0, reorder_window_s=0.1,
                                     breaker_fail_threshold=3, breaker_cooldown_s=60),
    )
    sess.add_speaker(speaker(1))
    t0 = time.monotonic()
    for i in range(10):
        await sess.on_final("spk1", f"第{i}句")
    elapsed = time.monotonic() - t0
    assert elapsed < 0.1, f"source path blocked by translator: {elapsed:.3f}s"  # I3
    finals = [m for m in sink.messages if m["kind"] == "final"]
    assert len(finals) == 10
    await hub.drain()
    statuses = sorted(m["tr_status"] for m in sink.messages if m["kind"] == "patch")
    assert len(statuses) == 10  # I4
    assert hub.metrics["breaker_opens"] >= 1  # I5
    assert "skipped" in statuses and "failed" in statuses
    assert hub.breaker_open


async def test_random_failures_never_lose_segments():
    tr = FakeTranslator(latency=jitter(0, 0.01, seed=11), fail_rate=0.3, seed=5)
    sess, sink, hub, _ = make_session(
        translator=tr,
        hub_cfg=TranslationHubConfig(retries=1, retry_backoff_s=0.001, reorder_window_s=5.0,
                                     breaker_fail_threshold=1000),
    )
    spks = [speaker(i) for i in range(4)]
    await _drive(sess, spks, 30, interim_per_utt=0)
    await hub.drain()
    _assert_invariants(sink.messages, 4, 30)
    assert hub.metrics["failed"] > 0 and hub.metrics["ok"] > 0


async def test_cache_dedupes_repeated_text_and_language_demand_changes_targets():
    tr = FakeTranslator()
    sess, sink, hub, _ = make_session(translator=tr)
    sess.add_speaker(speaker(1))
    for _ in range(5):
        await sess.on_final("spk1", "谢谢大家")
    await hub.drain()
    assert tr.calls == 1 and hub.metrics["cache_hits"] == 4
    sess.set_listener_langs("u-ja", {"ja"})
    await sess.on_final("spk1", "谢谢大家")
    await hub.drain()
    assert tr.calls == 2  # different target set => new call
    last = sink.messages[-1]
    assert set(last["tr"]) == {"en", "id", "ja"}


async def test_queue_overflow_degrades_to_skipped_not_backlog():
    tr = FakeTranslator(latency=0.5)
    sess, sink, hub, _ = make_session(
        translator=tr,
        hub_cfg=TranslationHubConfig(max_concurrency=2, queue_max=4, timeout_s=5, reorder_window_s=0.05),
    )
    sess.add_speaker(speaker(1))
    for i in range(20):
        await sess.on_final("spk1", f"第{i}句")
    await hub.drain()
    statuses = [m["tr_status"] for m in sink.messages if m["kind"] == "patch"]
    assert statuses.count("skipped") >= 10
    assert len(statuses) == 20


async def test_fanout_500_listeners_five_languages_throughput():
    """Agent-side cost is independent of listener count (SFU fans out). Prove the core
    keeps up: 6 speakers x 40 finals x 5 languages must finish well under real time."""
    tr = FakeTranslator(latency=0.005)
    sess, sink, hub, _ = make_session(
        translator=tr,
        hub_cfg=TranslationHubConfig(max_concurrency=16, queue_max=256, reorder_window_s=5.0),
        session_cfg=SessionConfig(base_targets=frozenset({"en", "id", "ja", "ko", "th"})),
    )
    for u in range(500):
        sess.set_listener_langs(f"u{u}", {random.Random(u).choice(["en", "id", "ja", "ko", "th"])})
    spks = [speaker(i) for i in range(6)]
    t0 = time.monotonic()
    await _drive(sess, spks, 40, interim_per_utt=3)
    await hub.drain()
    elapsed = time.monotonic() - t0
    _assert_invariants(sink.messages, 6, 40)
    patches = [m for m in sink.messages if m["kind"] == "patch"]
    assert all(set(p["tr"]) == {"en", "id", "ja", "ko", "th"} for p in patches)
    assert elapsed < 5.0, f"too slow: {elapsed:.2f}s for 240 finals"
    assert len(sess._listener_langs) == 500


async def test_speaker_leaves_mid_sentence_flushes_segment():
    sess, sink, hub, _ = make_session()
    sess.add_speaker(speaker(1))
    await sess.on_interim("spk1", "我还没说完")
    await sess.remove_speaker("spk1")
    await hub.drain()
    kinds = [m["kind"] for m in sink.messages]
    assert kinds == ["interim", "final", "patch"]
    assert sink.messages[1]["src"]["text"] == "我还没说完"
