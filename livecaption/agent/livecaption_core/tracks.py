"""Audio-track level helpers: one published audio track may carry one known speaker
(a microphone) or several unknown ones (the meeting's system audio, diarized by STT).

See ARCHITECTURE.md §3a (personal mode).
"""

from __future__ import annotations

import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Sequence

from .models import Segment, SpeakerInfo

# Languages written without spaces between words.
_NO_SPACE_LANGS = ("zh", "ja", "ko", "th", "lo", "my", "km")

UNKNOWN_LABEL = "?"


@dataclass(frozen=True)
class TrackSpec:
    track_id: str
    owner: SpeakerInfo
    """Who this track belongs to. For a mic track this IS the speaker. For a diarized
    track it is a placeholder shown while the STT has not attributed the words yet."""
    diarized: bool = False
    echo_guard: bool = False
    """Suppress finals that duplicate what another (diarized) track just heard: a mic
    picking up the meeting from loudspeakers."""


@dataclass
class TrackState:
    spec: TrackSpec
    open: Segment | None = None
    """The utterance currently shown as interim, not yet attributed to a speaker."""
    labels: dict[str, str] = field(default_factory=dict)
    """STT speaker label (e.g. "S0") -> lane speaker id."""


@dataclass(frozen=True)
class Word:
    text: str
    speaker: str | None = None


def word_runs(words: Sequence[Word], lang: str) -> list[tuple[str | None, str]]:
    """Group consecutive words by speaker label -> [(label, text)]."""
    sep = "" if lang.split("-")[0] in _NO_SPACE_LANGS else " "
    runs: list[tuple[str | None, list[str]]] = []
    for w in words:
        if runs and runs[-1][0] == w.speaker:
            runs[-1][1].append(w.text)
        else:
            runs.append((w.speaker, [w.text]))
    return [(label, sep.join(t.strip() for t in parts).strip()) for label, parts in runs if parts]


_NORM_RE = re.compile(r"[\W_]+", re.UNICODE)


def _bigrams(text: str) -> set[str]:
    s = _NORM_RE.sub("", text.lower())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def similarity(a: str, b: str) -> float:
    """Character-bigram Dice coefficient; language agnostic, cheap, robust to the small
    wording differences two STT streams produce for the same audio."""
    x, y = _bigrams(a), _bigrams(b)
    if not x or not y:
        return 0.0
    return 2 * len(x & y) / (len(x) + len(y))


class EchoIndex:
    """Recent finals from diarized (meeting audio) tracks, for echo suppression."""

    def __init__(self, window_s: float = 6.0, maxlen: int = 64) -> None:
        self.window_s = window_s
        self._items: deque[tuple[float, str]] = deque(maxlen=maxlen)

    def add(self, text: str, at: float | None = None) -> None:
        self._items.append((at if at is not None else time.monotonic(), text))

    def matches(self, text: str, threshold: float, at: float | None = None) -> bool:
        now = at if at is not None else time.monotonic()
        return any(
            abs(now - t) <= self.window_s and similarity(text, other) >= threshold
            for t, other in self._items
        )
