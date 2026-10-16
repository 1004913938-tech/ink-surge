"""Audio-track level helpers: one published audio track may carry one known speaker
(a microphone) or several unknown ones (the meeting's system audio, diarized by STT).

See ARCHITECTURE.md §3a (personal mode).
"""

from __future__ import annotations

import re
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from difflib import SequenceMatcher
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
    """STT speaker label (e.g. "S0", namespaced per STT connection) -> lane speaker id."""


@dataclass(frozen=True)
class Word:
    text: str
    speaker: str | None = None
    lang: str | None = None


@dataclass(frozen=True)
class Run:
    speaker: str | None
    text: str
    lang: str | None
    """Majority language of the run by characters (None when the STT gave none)."""


def word_runs(words: Sequence[Word], lang: str) -> list[Run]:
    """Group consecutive words by speaker. Each run keeps its own language: in a
    multilingual meeting a speaker change usually is a language change too."""
    groups: list[tuple[str | None, list[Word]]] = []
    for w in words:
        if groups and groups[-1][0] == w.speaker:
            groups[-1][1].append(w)
        else:
            groups.append((w.speaker, [w]))
    runs = []
    for label, ws in groups:
        counts: Counter[str] = Counter()
        for w in ws:
            if w.lang:
                counts[w.lang] += len(w.text.strip())
        run_lang = counts.most_common(1)[0][0] if counts else None
        base = (run_lang or lang).split("-")[0]
        sep = "" if base in _NO_SPACE_LANGS else " "
        text = sep.join(w.text.strip() for w in ws).strip()
        if text:
            runs.append(Run(label, text, run_lang))
    return runs


# ---------------------------------------------------------------- similarity

_PUNCT_RE = re.compile(r"[^\w\s]+|_", re.UNICODE)
_CJK_RE = re.compile(r"[぀-ヿ㐀-鿿가-힯฀-๿]")


def _units(text: str) -> list[str]:
    """Comparison units: characters for scripts without spaces, words otherwise."""
    s = _PUNCT_RE.sub(" ", text.lower())
    if _CJK_RE.search(s):
        return [c for c in s if not c.isspace()]
    return s.split()


def similarity(a: str, b: str) -> float:
    """Order-aware similarity (difflib ratio over words, or characters for CJK/Thai).
    An echo is the same audio transcribed twice, so it matches in order; two different
    sentences on the same topic share words but not their sequence."""
    x, y = _units(a), _units(b)
    if not x or not y:
        return 0.0
    return SequenceMatcher(None, x, y, autojunk=False).ratio()


def unit_count(text: str) -> int:
    return len(_units(text))


@dataclass(frozen=True)
class EchoPolicy:
    threshold: float = 0.7
    window_s: float = 3.0
    """Both STT streams hear the same sound within endpointing jitter (~1-2 s)."""
    short_units: int = 4
    """Utterances this short ("OK", "好的", "yes sure") are only echoes when they are
    near-identical AND nearly simultaneous; otherwise a genuine reply would be lost."""
    short_threshold: float = 0.9
    short_window_s: float = 1.5

    def is_echo(self, mine: str, theirs: str, dt: float) -> bool:
        dt = abs(dt)
        if min(unit_count(mine), unit_count(theirs)) < self.short_units:
            return dt <= self.short_window_s and similarity(mine, theirs) >= self.short_threshold
        return dt <= self.window_s and similarity(mine, theirs) >= self.threshold


class EchoIndex:
    """Recent finals from diarized (meeting audio) tracks, for echo suppression."""

    def __init__(self, policy: EchoPolicy, maxlen: int = 64) -> None:
        self.policy = policy
        self._items: deque[tuple[float, str]] = deque(maxlen=maxlen)

    def add(self, text: str, at: float | None = None) -> None:
        self._items.append((at if at is not None else time.monotonic(), text))

    def matches(self, text: str, at: float | None = None) -> bool:
        now = at if at is not None else time.monotonic()
        return any(self.policy.is_echo(text, other, now - t) for t, other in self._items)
