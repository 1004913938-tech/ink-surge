"""Make livekit-plugins-soniox (1.8.4) keep per-token speakers.

The plugin builds one final per Soniox endpoint and labels it with the FIRST token's
speaker; it does not populate SpeechData.words. In a meeting one endpoint can span a
speaker change ("...right? / Ya, betul"), so we record speaker runs and expose them as
`words` (TimedString with speaker_id). CaptionSession then splits the final per speaker
(livecaption_core.tracks.word_runs).

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
        self._runs: list[list[Any]] = []  # [speaker | None, text]

    def update(self, token: dict[str, Any]) -> None:
        super().update(token)
        text = token.get("text", "")
        if not text:
            return
        spk = str(token["speaker"]) if "speaker" in token else None
        if self._runs and self._runs[-1][0] == spk:
            self._runs[-1][1] += text
        else:
            self._runs.append([spk, text])

    def reset(self) -> None:
        super().reset()
        self._runs = []

    def speaker_words(self) -> list[TimedString] | None:
        if not any(spk for spk, _ in self._runs):
            return None
        return [TimedString(text, speaker_id=spk) for spk, text in self._runs]

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
