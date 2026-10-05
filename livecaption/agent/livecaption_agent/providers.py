"""STT / translator factories. Add a backend here, select it with env vars."""

from __future__ import annotations

import logging

import aiohttp
from livekit.agents import stt

from livecaption_core import FakeTranslator, Translator
from livecaption_core.models import AUTO_LANG

from .config import AgentConfig

log = logging.getLogger("livecaption.providers")

# Deepgram language codes per spoken language. Nova-3 streams zh / zh-CN / zh-TW / id.
_DEEPGRAM_LANG = {"zh": "zh-CN", "zh-TW": "zh-TW", "en": "en", "id": "id", "ja": "ja", "ko": "ko"}
# Nova-3 language="multi" code-switches only across these (research 2026-10): no zh, no id.
_DEEPGRAM_MULTI = {"en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"}

# Which providers can detect the language per utterance on one stream ("auto").
AUTO_LANG_PROVIDERS = {"soniox", "demo"}


def supports_auto_lang(provider: str, hints: tuple[str, ...] = ()) -> bool:
    if provider == "deepgram":
        return bool(hints) and set(hints) <= _DEEPGRAM_MULTI
    return provider in AUTO_LANG_PROVIDERS


def make_stt(cfg: AgentConfig, lang: str, *, diarize: bool = False,
             http_session: aiohttp.ClientSession | None = None) -> stt.STT:
    """`lang` is the spoken language or "auto" (detect per utterance). `diarize` asks the
    provider to label speakers inside one stream (the meeting's system audio).
    `http_session`: owned by the caller (plugins do not close a session they were given)."""
    if cfg.stt_provider == "deepgram":
        from livekit.plugins import deepgram

        if lang == AUTO_LANG and not supports_auto_lang("deepgram", cfg.lang_hints):
            # Deepgram cannot code-switch zh/id; use one fixed language for the meeting.
            lang = cfg.deepgram_auto_lang
            log.warning("Deepgram cannot auto-detect %s; transcribing meeting audio as %r "
                        "(set the meeting language explicitly, or LC_STT=soniox)", cfg.lang_hints, lang)
        return deepgram.STT(
            model="nova-3",
            language="multi" if lang == AUTO_LANG else _DEEPGRAM_LANG.get(lang, lang),
            interim_results=True,
            punctuate=True,
            enable_diarization=diarize,
            sample_rate=cfg.stt_sample_rate,
            http_session=http_session,
        )
    if cfg.stt_provider == "soniox":
        from livekit.plugins.soniox import STT as SonioxSTT
        from livekit.plugins.soniox import STTOptions

        from . import soniox_patch

        soniox_patch.apply()
        hints = list(cfg.lang_hints) if lang == AUTO_LANG else [lang]
        kwargs = {"base_url": cfg.soniox_url} if cfg.soniox_url else {}
        return SonioxSTT(**kwargs, http_session=http_session, params=STTOptions(
            language_hints=hints,
            enable_language_identification=True,
            enable_speaker_diarization=diarize,
            max_endpoint_delay_ms=1500,  # captions: commit a line within ~1.5 s of a pause
            sample_rate=cfg.stt_sample_rate,
        ))
    if cfg.stt_provider == "demo":
        from .demo_stt import DemoSTT

        return DemoSTT(diarize=diarize)
    if cfg.stt_provider == "paraformer":
        raise NotImplementedError(
            "Alibaba Paraformer realtime adapter is reserved (see ARCHITECTURE.md §1); "
            "set LC_STT=deepgram for now"
        )
    if cfg.stt_provider == "sherpa":
        raise NotImplementedError("sherpa-onnx local STT adapter is reserved; set LC_STT=deepgram")
    raise ValueError(f"unknown LC_STT={cfg.stt_provider!r}")


def make_translator(cfg: AgentConfig, glossary: dict[str, str]) -> Translator:
    if cfg.translator == "claude":
        from livecaption_core.translate_claude import ClaudeTranslator

        return ClaudeTranslator(model=cfg.claude_model, glossary=glossary, domain_hint=cfg.domain_hint)
    if cfg.translator == "fake":
        return FakeTranslator(latency=0.05)
    raise ValueError(f"unknown LC_TRANSLATOR={cfg.translator!r}")
