from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field

from .broadcast import Broadcaster
from .models import Caption, Segment, SpeakerInfo, new_segment_id
from .translate import TranslationHub

log = logging.getLogger("livecaption.session")


@dataclass
class SessionConfig:
    base_targets: frozenset[str] = frozenset({"en", "id"})
    """Languages always translated (the host's desktop view), regardless of listeners."""
    context_window: int = 3
    """How many previous finals of the same speaker to pass as translation context."""
    glossary: dict[str, str] = field(default_factory=dict)


class SpeakerLane:
    """Orders one speaker's utterances. Interims update the open segment; a final
    seals it and the next utterance gets seq+1."""

    def __init__(self, speaker: SpeakerInfo) -> None:
        self.speaker = speaker
        self.seq = 0
        self.current: Segment | None = None
        self.history: deque[str] = deque(maxlen=8)

    def _open(self) -> Segment:
        self.seq += 1
        self.current = Segment(sid=new_segment_id(), speaker=self.speaker, seq=self.seq)
        return self.current

    def on_interim(self, text: str) -> Caption | None:
        text = text.strip()
        if not text:
            return None
        seg = self.current or self._open()
        seg.text = text
        return Caption.from_segment(seg, "interim")

    def on_final(self, text: str) -> tuple[Caption, Segment] | None:
        text = text.strip()
        if not text:
            # An empty final still closes an open interim-only segment.
            self.current = None
            return None
        seg = self.current or self._open()
        seg.text = text
        seg.final = True
        seg.finalized_at = time.time()
        self.current = None
        self.history.append(text)
        return Caption.from_segment(seg, "final"), seg

    def close(self) -> tuple[Caption, Segment] | None:
        if self.current and self.current.text:
            return self.on_final(self.current.text)
        self.current = None
        return None


class CaptionSession:
    """One meeting room. Owns speaker lanes, listener language demand, the
    translation hub and the broadcaster."""

    def __init__(
        self,
        broadcaster: Broadcaster,
        hub: TranslationHub,
        config: SessionConfig | None = None,
    ) -> None:
        self.cfg = config or SessionConfig()
        self._bc = broadcaster
        self._hub = hub
        self._lanes: dict[str, SpeakerLane] = {}
        self._listener_langs: dict[str, frozenset[str]] = {}
        self.metrics = {"interims": 0, "finals": 0, "patches": 0}

    # ------------------------------------------------------------ membership

    def add_speaker(self, speaker: SpeakerInfo) -> SpeakerLane:
        lane = self._lanes.get(speaker.id)
        if lane is None:
            lane = SpeakerLane(speaker)
            self._lanes[speaker.id] = lane
        return lane

    async def remove_speaker(self, speaker_id: str) -> None:
        lane = self._lanes.pop(speaker_id, None)
        if lane is None:
            return
        closed = lane.close()
        if closed:
            await self._publish_final(*closed, lane)

    def set_listener_langs(self, identity: str, langs: set[str] | frozenset[str]) -> None:
        self._listener_langs[identity] = frozenset(l for l in langs if l)

    def remove_listener(self, identity: str) -> None:
        self._listener_langs.pop(identity, None)

    def demanded_langs(self, src_lang: str) -> frozenset[str]:
        langs = set(self.cfg.base_targets)
        for ls in self._listener_langs.values():
            langs |= ls
        langs.discard(src_lang)
        return frozenset(langs)

    @property
    def speakers(self) -> list[SpeakerInfo]:
        return [l.speaker for l in self._lanes.values()]

    # --------------------------------------------------------------- captions

    async def on_interim(self, speaker_id: str, text: str) -> None:
        lane = self._lanes.get(speaker_id)
        if lane is None:
            return
        cap = lane.on_interim(text)
        if cap is not None:
            self.metrics["interims"] += 1
            await self._bc.send(cap)

    async def on_final(self, speaker_id: str, text: str) -> None:
        lane = self._lanes.get(speaker_id)
        if lane is None:
            return
        res = lane.on_final(text)
        if res is None:
            return
        await self._publish_final(*res, lane)

    async def _publish_final(self, cap: Caption, seg: Segment, lane: SpeakerLane) -> None:
        self.metrics["finals"] += 1
        targets = self.demanded_langs(seg.speaker.lang)
        if not targets:
            seg.tr_status = "ok"
            cap.tr_status = "ok"
        await self._bc.send(cap)  # source text first, never waits for translation
        context = list(lane.history)[-self.cfg.context_window - 1 : -1]
        self._hub.submit(seg, sorted(targets), self._on_translated, context=context)

    async def _on_translated(self, seg: Segment) -> None:
        self.metrics["patches"] += 1
        await self._bc.send(
            Caption(kind="patch", sid=seg.sid, spk=seg.speaker, seq=seg.seq,
                    tr=dict(seg.translations), tr_status=seg.tr_status)
        )

    async def reset(self) -> None:
        await self._bc.send(Caption(kind="reset", sid=""))

    async def aclose(self) -> None:
        for sid in list(self._lanes):
            await self.remove_speaker(sid)
        await self._hub.drain()
        await self._bc.aclose()
