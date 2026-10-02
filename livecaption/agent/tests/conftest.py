import asyncio
import random

import pytest

from livecaption_core import (
    Broadcaster,
    CaptionSession,
    FakeTranslator,
    MemorySink,
    SessionConfig,
    SpeakerInfo,
    TranslationHub,
    TranslationHubConfig,
)


def make_session(
    *,
    translator=None,
    hub_cfg: TranslationHubConfig | None = None,
    session_cfg: SessionConfig | None = None,
    interim_hz: float = 1000.0,
):
    """Wire a full in-memory session. High interim_hz disables throttling unless a test asks."""
    sink = MemorySink()
    bc = Broadcaster(sink, interim_hz=interim_hz)
    hub = TranslationHub(translator or FakeTranslator(), hub_cfg or TranslationHubConfig(reorder_window_s=0.2))
    sess = CaptionSession(bc, hub, session_cfg or SessionConfig(base_targets=frozenset({"en", "id"})))
    return sess, sink, hub, bc


def speaker(i: int, lang: str = "zh") -> SpeakerInfo:
    return SpeakerInfo(id=f"spk{i}", name=f"Speaker {i}", lang=lang)


def jitter(lo: float, hi: float, seed: int = 1):
    rng = random.Random(seed)
    return lambda: rng.uniform(lo, hi)


@pytest.fixture
def anyio_backend():
    return "asyncio"
