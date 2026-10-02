"""STT / translator factories. Add a backend here, select it with env vars."""

from __future__ import annotations

from livekit.agents import stt

from livecaption_core import FakeTranslator, Translator

from .config import AgentConfig

# Deepgram language codes per spoken language. Nova-3 streams zh / zh-CN / zh-TW / id.
_DEEPGRAM_LANG = {"zh": "zh-CN", "zh-TW": "zh-TW", "en": "en", "id": "id", "ja": "ja", "ko": "ko"}


def make_stt(cfg: AgentConfig, lang: str) -> stt.STT:
    if cfg.stt_provider == "deepgram":
        from livekit.plugins import deepgram

        return deepgram.STT(
            model="nova-3",
            language=_DEEPGRAM_LANG.get(lang, lang),
            interim_results=True,
            punctuate=True,
            sample_rate=cfg.stt_sample_rate,
        )
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
