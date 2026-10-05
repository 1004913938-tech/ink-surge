from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Literal

Kind = Literal["interim", "final", "patch", "reset", "retract", "status"]
TrStatus = Literal["ok", "pending", "failed", "late", "skipped"]

PROTOCOL_VERSION = 1
CAPTION_TOPIC = "lc.caption"
AUTO_LANG = "auto"
"""Source language placeholder: the STT detects it per utterance."""


def new_segment_id() -> str:
    return "s_" + secrets.token_hex(4)


@dataclass(frozen=True)
class SpeakerInfo:
    id: str
    name: str
    lang: str  # BCP-47-ish, e.g. "zh", "en", "id", or "auto"


@dataclass
class Segment:
    """One utterance from one speaker. `seq` is strictly increasing per speaker."""

    sid: str
    speaker: SpeakerInfo
    seq: int
    text: str = ""
    final: bool = False
    lang: str = ""
    """Language of this utterance (STT-detected when the speaker's lang is auto)."""
    translations: dict[str, str] = field(default_factory=dict)
    tr_status: TrStatus = "pending"
    created_at: float = field(default_factory=time.time)
    finalized_at: float | None = None

    @property
    def src_lang(self) -> str:
        return self.lang or self.speaker.lang


@dataclass
class Caption:
    """Wire message. See ARCHITECTURE.md §4."""

    kind: Kind
    sid: str
    spk: SpeakerInfo | None = None
    seq: int = 0
    src_lang: str = ""
    src_text: str = ""
    tr: dict[str, str] = field(default_factory=dict)
    tr_status: TrStatus = "pending"
    t: float = field(default_factory=time.time)
    status: dict[str, str] | None = None
    """kind="status": {"code": "ok" | "stt_unavailable" | ..., "msg": shown to the user}."""

    def to_dict(self) -> dict:
        d: dict = {
            "v": PROTOCOL_VERSION,
            "kind": self.kind,
            "sid": self.sid,
            "seq": self.seq,
            "t": round(self.t, 3),
        }
        if self.kind in ("reset", "retract"):
            return d
        if self.kind == "status":
            return d | {"status": dict(self.status or {})}
        if self.spk is not None:
            d["spk"] = {"id": self.spk.id, "name": self.spk.name}
        if self.kind != "patch":
            d["src"] = {"lang": self.src_lang, "text": self.src_text}
        d["tr"] = dict(self.tr)
        d["tr_status"] = self.tr_status
        return d

    @classmethod
    def from_segment(cls, seg: Segment, kind: Kind) -> "Caption":
        return cls(
            kind=kind,
            sid=seg.sid,
            spk=seg.speaker,
            seq=seg.seq,
            src_lang=seg.src_lang,
            src_text=seg.text,
            tr=dict(seg.translations),
            tr_status=seg.tr_status,
        )
