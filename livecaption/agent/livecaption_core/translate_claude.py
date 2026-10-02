"""Claude-backed translator: one request produces every target language.

Latency matters more than depth for live captions, so effort is `low`. The system
prompt is static (glossary included) so it is prompt-cached across segments.
"""

from __future__ import annotations

import json
from typing import Sequence

import anthropic

from .translate import Translator

LANG_NAMES = {
    "zh": "Simplified Chinese", "zh-TW": "Traditional Chinese", "en": "English",
    "id": "Indonesian", "ja": "Japanese", "ko": "Korean", "th": "Thai", "vi": "Vietnamese",
    "ms": "Malay", "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese",
    "ru": "Russian", "ar": "Arabic", "hi": "Hindi",
}


def _lang_name(code: str) -> str:
    return LANG_NAMES.get(code, code)


class ClaudeTranslator(Translator):
    def __init__(
        self,
        *,
        model: str = "claude-opus-5-5",
        glossary: dict[str, str] | None = None,
        domain_hint: str = "",
        client: anthropic.AsyncAnthropic | None = None,
    ) -> None:
        self._client = client or anthropic.AsyncAnthropic(max_retries=0)  # hub owns retries
        self._model = model
        self._system = self._build_system(glossary or {}, domain_hint)

    @staticmethod
    def _build_system(glossary: dict[str, str], domain_hint: str) -> str:
        parts = [
            "You are a simultaneous interpreter producing live meeting captions.",
            "Translate the given utterance into each requested target language.",
            "Rules: keep it short and natural for subtitles; preserve numbers, names and",
            "product terms; do not add explanations; if the utterance is a fragment,",
            "translate the fragment as-is. Use the previous utterances only as context.",
        ]
        if domain_hint:
            parts.append(f"Domain: {domain_hint}.")
        if glossary:
            lines = "\n".join(f"- {k} => {v}" for k, v in sorted(glossary.items()))
            parts.append("Glossary (always use these renderings):\n" + lines)
        return "\n".join(parts)

    async def translate(
        self,
        text: str,
        src_lang: str,
        targets: Sequence[str],
        *,
        glossary: dict[str, str] | None = None,  # baked into the system prompt at init
        context: Sequence[str] = (),
    ) -> dict[str, str]:
        targets = list(targets)
        schema = {
            "type": "object",
            "properties": {t: {"type": "string"} for t in targets},
            "required": targets,
            "additionalProperties": False,
        }
        target_desc = ", ".join(f"{t} ({_lang_name(t)})" for t in targets)
        user = (
            f"Source language: {src_lang} ({_lang_name(src_lang)})\n"
            f"Target languages: {target_desc}\n"
        )
        if context:
            user += "Previous utterances:\n" + "\n".join(f"- {c}" for c in context) + "\n"
        user += f"Utterance:\n{text}"

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=1024,
            system=[{"type": "text", "text": self._system, "cache_control": {"type": "ephemeral"}}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": user}],
        )
        if response.stop_reason == "refusal":
            raise RuntimeError(f"translation refused: {response.stop_details}")
        body = next(b.text for b in response.content if b.type == "text")
        data = json.loads(body)
        return {t: str(data.get(t, "")) for t in targets}
