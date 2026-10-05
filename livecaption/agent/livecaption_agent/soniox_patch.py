"""Make livekit-plugins-soniox (1.8.4) keep per-token speakers.

The plugin builds one final per Soniox endpoint and labels it with the FIRST token's
speaker; it does not populate SpeechData.words. In a meeting one endpoint can span a
speaker change ("...right? / Ya, betul"), so we record speaker runs and expose them as
`words` (TimedString with speaker_id and .language). CaptionSession then splits the final
per speaker, each part with its own language (livecaption_core.tracks.word_runs).

Applied by providers.make_stt when LC_STT=soniox. Pinned to the plugin version in
pyproject.toml; tests/test_soniox_patch.py fails loudly if the plugin internals change.
"""

from __future__ import annotations

from typing import Any

from livekit.agents.types import TimedString
from livekit.plugins.soniox import stt as soniox_stt

_Base = soniox_stt._TokenAccumulator


class SpeakerRunAccumulator(_Base):  # type: ignore[misc, valid-type]
    def __init__(self) -> None:
        super().__init__()
        self._runs: list[list[Any]] = []  # [speaker | None, language | None, text]

    def update(self, token: dict[str, Any]) -> None:
        super().update(token)
        text = token.get("text", "")
        if not text:
            return
        spk = str(token["speaker"]) if "speaker" in token else None
        lang = token.get("language") or None
        if self._runs and self._runs[-1][0] == spk and self._runs[-1][1] == lang:
            self._runs[-1][2] += text
        else:
            self._runs.append([spk, lang, text])

    def reset(self) -> None:
        super().reset()
        self._runs = []

    def speaker_words(self) -> list[TimedString] | None:
        """One TimedString per (speaker, language) run; `.language` is set on each so a
        split run keeps its own language (a speaker change is usually a language change)."""
        if not any(spk for spk, _, _ in self._runs):
            return None
        words = []
        for spk, lang, text in self._runs:
            w = TimedString(text, speaker_id=spk)
            w.language = lang  # type: ignore[attr-defined]
            words.append(w)
        return words

    def to_speech_data(self, *args: Any, **kwargs: Any):  # noqa: ANN201
        sd = super().to_speech_data(*args, **kwargs)
        sd.words = self.speaker_words()
        return sd


_applied = False


def apply() -> None:
    global _applied
    if _applied:
        return
    if not hasattr(_Base, "update") or not hasattr(_Base, "to_speech_data"):
        raise RuntimeError("livekit-plugins-soniox internals changed; update soniox_patch.py")
    soniox_stt._TokenAccumulator = SpeakerRunAccumulator
    _applied = True
