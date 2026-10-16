from __future__ import annotations

import os
from dataclasses import dataclass, field


def _split(s: str) -> frozenset[str]:
    return frozenset(x.strip() for x in s.split(",") if x.strip())


def _split_ordered(s: str) -> list[str]:
    return [x.strip() for x in s.split(",") if x.strip()]


@dataclass
class AgentConfig:
    stt_provider: str = os.getenv("LC_STT", "deepgram")
    translator: str = os.getenv("LC_TRANSLATOR", "claude")
    claude_model: str = os.getenv("LC_CLAUDE_MODEL", "claude-opus-5-5")
    default_src_lang: str = os.getenv("LC_SRC_LANG", "zh")
    base_targets: frozenset[str] = field(default_factory=lambda: _split(os.getenv("LC_TARGETS", "en,id")))
    domain_hint: str = os.getenv("LC_DOMAIN_HINT", "")
    interim_hz: float = float(os.getenv("LC_INTERIM_HZ", "4"))
    max_concurrency: int = int(os.getenv("LC_TR_CONCURRENCY", "8"))
    translate_timeout_s: float = float(os.getenv("LC_TR_TIMEOUT_S", "6"))
    reorder_window_s: float = float(os.getenv("LC_REORDER_WINDOW_S", "1.5"))
    api_url: str = os.getenv("LC_API_URL", "")  # usage metering; empty disables
    internal_token: str = os.getenv("LC_INTERNAL_TOKEN", "")
    lang_hints: tuple[str, ...] = field(
        default_factory=lambda: tuple(_split_ordered(os.getenv("LC_LANG_HINTS", "zh,id,en")))
    )
    """Languages expected in auto-detect mode (meeting audio); improves detection."""
    deepgram_auto_lang: str = os.getenv("LC_DEEPGRAM_AUTO_LANG", "id")
    """Deepgram cannot auto-detect zh/id: meeting audio in "auto" mode is transcribed as this."""
    soniox_url: str = os.getenv("LC_SONIOX_URL", "")
    """e.g. wss://stt-rt.jp.soniox.com/transcribe-websocket (region-bound key; no mainland-China region)."""
    stt_sample_rate: int = 16000


# Participant attribute keys (set by the API when minting tokens / by the web client)
ATTR_ROLE = "lc.role"        # speaker | listener
ATTR_LANG = "lc.lang"        # speaker's spoken language
ATTR_LANGS = "lc.langs"      # listener's wanted languages, comma separated
ATTR_NAME = "lc.name"
