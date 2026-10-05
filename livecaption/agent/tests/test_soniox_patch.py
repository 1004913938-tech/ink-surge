"""The Soniox plugin patch must expose speaker runs so mixed-speaker finals can be split."""

import pytest

soniox_stt = pytest.importorskip("livekit.plugins.soniox.stt")

from livecaption_agent import soniox_patch  # noqa: E402
from livecaption_core.tracks import Word, word_runs  # noqa: E402


def tokens(*items):
    return [{"text": t, "speaker": s, "language": l, "is_final": True} for t, s, l in items]


def test_patch_installs_and_records_runs():
    soniox_patch.apply()
    assert soniox_stt._TokenAccumulator is soniox_patch.SpeakerRunAccumulator
    acc = soniox_stt._TokenAccumulator()
    for tok in tokens(("Is", "1", "en"), (" that", "1", "en"), (" right?", "1", "en"),
                      (" Ya,", "2", "id"), (" betul.", "2", "id")):
        acc.update(tok)
    sd = acc.to_speech_data()
    assert sd.speaker_id == "1"  # plugin behaviour: first speaker
    assert [(str(w), w.speaker_id, w.language) for w in sd.words] == [
        ("Is that right?", "1", "en"), (" Ya, betul.", "2", "id")]
    runs = word_runs([Word(str(w), w.speaker_id, w.language) for w in sd.words], "en")
    assert [(r.speaker, r.text, r.lang) for r in runs] == [("1", "Is that right?", "en"), ("2", "Ya, betul.", "id")]
    acc.reset()
    assert acc.speaker_words() is None and acc.text == ""


def test_no_speakers_means_no_words():
    soniox_patch.apply()
    acc = soniox_stt._TokenAccumulator()
    acc.update({"text": "你好", "language": "zh", "is_final": True})
    assert acc.to_speech_data().words is None
