from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Sequence

from .broadcast import Broadcaster
from .models import Caption, Segment, SpeakerInfo, new_segment_id
from .tracks import UNKNOWN_LABEL, EchoIndex, EchoPolicy, Run, TrackSpec, TrackState, Word, word_runs
from .translate import TranslationHub

log = logging.getLogger("livecaption.session")


@dataclass
class SessionConfig:
    base_targets: frozenset[str] = frozenset({"en", "id"})
    """Languages always translated (the host's desktop view), regardless of listeners."""
    context_window: int = 3
    """How many previous finals of the same speaker to pass as translation context."""
    glossary: dict[str, str] = field(default_factory=dict)
    speaker_name: str = "说话人 {n}"
    """Display name for diarized speakers; {n} is 1-based in order of first appearance."""
    echo_hold_s: float = 1.0
    """Echo-guarded (mic) finals wait this long for the meeting-audio copy before being
    shown. Only applies while a diarized track exists."""
    echo: EchoPolicy = field(default_factory=EchoPolicy)


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

    def on_interim(self, text: str, lang: str | None = None) -> Caption | None:
        text = text.strip()
        if not text:
            return None
        seg = self.current or self._open()
        seg.text = text
        if lang:
            seg.lang = lang
        return Caption.from_segment(seg, "interim")

    def on_final(
        self, text: str, *, sid: str | None = None, lang: str | None = None
    ) -> tuple[Caption, Segment] | None:
        """`sid`: reuse an id the client already shows (an unattributed interim line of
        a diarized track) so the final replaces it in place."""
        text = text.strip()
        if not text:
            # An empty final still closes an open interim-only segment.
            self.current = None
            return None
        if sid is not None:
            self.seq += 1
            seg = Segment(sid=sid, speaker=self.speaker, seq=self.seq)
        else:
            seg = self.current or self._open()
            self.current = None
        seg.text = text
        if lang:
            seg.lang = lang
        seg.final = True
        seg.finalized_at = time.time()
        self.history.append(text)
        return Caption.from_segment(seg, "final"), seg

    def close(self) -> tuple[Caption, Segment] | None:
        if self.current and self.current.text:
            return self.on_final(self.current.text)
        self.current = None
        return None


@dataclass
class _HeldFinal:
    cap: Caption
    seg: Segment
    lane: SpeakerLane
    at: float
    """When the mic final arrived (monotonic), for echo timing."""
    task: asyncio.Task | None = None


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
        self._tracks: dict[str, TrackState] = {}
        self._echo = EchoIndex(self.cfg.echo)
        self._held: dict[str, _HeldFinal] = {}
        self._shown_guarded: deque[tuple[float, str, str]] = deque(maxlen=32)  # (arrived, sid, text)
        self.metrics = {"interims": 0, "finals": 0, "patches": 0, "echo_dropped": 0}

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

    # ------------------------------------------------- speaker-level captions

    async def on_interim(self, speaker_id: str, text: str, lang: str | None = None) -> None:
        lane = self._lanes.get(speaker_id)
        if lane is None:
            return
        cap = lane.on_interim(text, lang)
        if cap is not None:
            self.metrics["interims"] += 1
            await self._bc.send(cap)

    async def on_final(self, speaker_id: str, text: str, lang: str | None = None) -> None:
        lane = self._lanes.get(speaker_id)
        if lane is None:
            return
        res = lane.on_final(text, lang=lang)
        if res is None:
            return
        await self._publish_final(*res, lane)

    # --------------------------------------------------- track-level captions

    def add_track(self, spec: TrackSpec) -> None:
        """Register a track. Re-adding the same track id with a NEW spec (a re-subscribe
        while the previous pipe is still closing) replaces the state; the old pipe's
        later remove_track(spec=old) is then a no-op."""
        st = self._tracks.get(spec.track_id)
        if st is not None and st.spec is spec:
            return
        self._tracks[spec.track_id] = TrackState(spec)
        if not spec.diarized:
            self.add_speaker(spec.owner)

    async def remove_track(self, track_id: str, spec: TrackSpec | None = None) -> None:
        """`spec`: only remove if the track still belongs to this spec (pipe ownership)."""
        st = self._tracks.get(track_id)
        if st is None or (spec is not None and st.spec is not spec):
            return
        del self._tracks[track_id]
        if not st.spec.diarized and any(
            not o.spec.diarized and o.spec.owner.id == st.spec.owner.id for o in self._tracks.values()
        ):
            return  # another live track still feeds this speaker
        if st.spec.diarized:
            if st.open is not None and st.open.text:
                await self.on_track_final(track_id, st.open.text, lang=st.open.lang or None, _state=st)
        else:
            await self.remove_speaker(st.spec.owner.id)

    @property
    def _has_diarized_track(self) -> bool:
        return any(s.spec.diarized for s in self._tracks.values())

    def _lane_for(self, st: TrackState, label: str | None) -> SpeakerLane:
        if not label or label == UNKNOWN_LABEL:
            return self.add_speaker(st.spec.owner)
        lane_id = st.labels.get(label)
        if lane_id is None:
            lane_id = f"{st.spec.track_id}#{label}"
            st.labels[label] = lane_id
            self.add_speaker(SpeakerInfo(
                id=lane_id,
                name=self.cfg.speaker_name.format(n=len(st.labels)),
                lang=st.spec.owner.lang,
            ))
        return self._lanes[lane_id]

    async def on_track_interim(
        self, track_id: str, text: str, *, speaker_label: str | None = None, lang: str | None = None
    ) -> None:
        st = self._tracks.get(track_id)
        if st is None:
            return
        if not st.spec.diarized:
            await self.on_interim(st.spec.owner.id, text, lang)
            return
        text = text.strip()
        if not text:
            return
        # Most STTs only attribute speakers on finals; until then show the line under
        # the track placeholder (or the label if the STT already gave one).
        who = self._lane_for(st, speaker_label).speaker if speaker_label else st.spec.owner
        if st.open is None:
            st.open = Segment(sid=new_segment_id(), speaker=who, seq=0)
        st.open.speaker = who
        st.open.text = text
        if lang:
            st.open.lang = lang
        self.metrics["interims"] += 1
        await self._bc.send(Caption.from_segment(st.open, "interim"))

    async def on_track_final(
        self,
        track_id: str,
        text: str,
        *,
        speaker_label: str | None = None,
        words: Sequence[Word] | None = None,
        lang: str | None = None,
        _state: TrackState | None = None,
    ) -> None:
        st = _state or self._tracks.get(track_id)
        if st is None:
            return
        if not st.spec.diarized:
            lane = self._lanes.get(st.spec.owner.id)
            if lane is None:
                return
            res = lane.on_final(text, lang=lang)
            if res is None:
                return
            if st.spec.echo_guard and self._has_diarized_track:
                await self._guarded_final(*res, lane)
            else:
                await self._publish_final(*res, lane)
            return

        open_seg, st.open = st.open, None
        if words and any(w.speaker for w in words):
            runs = word_runs(words, lang or st.spec.owner.lang)
        else:
            runs = [Run(speaker_label, text.strip(), None)] if text.strip() else []
        if not runs:
            if open_seg is not None:  # the interim line turned out to be nothing
                await self._bc.send(Caption(kind="retract", sid=open_seg.sid))
            return
        for i, run in enumerate(runs):
            lane = self._lane_for(st, run.speaker)
            reuse = open_seg.sid if (i == 0 and open_seg is not None) else None
            res = lane.on_final(run.text, sid=reuse, lang=run.lang or lang)
            if res is None:
                continue
            self._echo.add(run.text)
            await self._suppress_echoes_of(run.text)
            await self._publish_final(*res, lane)

    # ------------------------------------------------------- echo suppression

    async def _guarded_final(self, cap: Caption, seg: Segment, lane: SpeakerLane) -> None:
        now = time.monotonic()
        if self._echo.matches(seg.text, at=now):
            await self._drop_echo(seg.sid)
            return
        if self.cfg.echo_hold_s <= 0:
            self._shown_guarded.append((now, seg.sid, seg.text))
            await self._publish_final(cap, seg, lane)
            return
        held = _HeldFinal(cap, seg, lane, at=now)
        self._held[seg.sid] = held
        held.task = asyncio.create_task(self._release_held(seg.sid))

    async def _release_held(self, sid: str) -> None:
        await asyncio.sleep(self.cfg.echo_hold_s)
        held = self._held.pop(sid, None)
        if held is None:
            return
        self._shown_guarded.append((held.at, sid, held.seg.text))
        await self._publish_final(held.cap, held.seg, held.lane)

    async def _suppress_echoes_of(self, remote_text: str) -> None:
        policy, now = self.cfg.echo, time.monotonic()
        for sid, held in list(self._held.items()):
            if policy.is_echo(held.seg.text, remote_text, now - held.at):
                self._held.pop(sid, None)
                if held.task:
                    held.task.cancel()
                await self._drop_echo(sid)
        for item in list(self._shown_guarded):
            at, sid, text = item
            if policy.is_echo(text, remote_text, now - at):
                self._shown_guarded.remove(item)
                await self._drop_echo(sid)

    async def _drop_echo(self, sid: str) -> None:
        self.metrics["echo_dropped"] += 1
        await self._bc.send(Caption(kind="retract", sid=sid))

    # ---------------------------------------------------------------- publish

    async def _publish_final(self, cap: Caption, seg: Segment, lane: SpeakerLane) -> None:
        self.metrics["finals"] += 1
        targets = self.demanded_langs(seg.src_lang)
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
        for tid in list(self._tracks):
            await self.remove_track(tid)
        for sid, held in list(self._held.items()):
            if held.task:
                held.task.cancel()
            self._held.pop(sid, None)
            self._shown_guarded.append((held.at, sid, held.seg.text))
            await self._publish_final(held.cap, held.seg, held.lane)
        for sid in list(self._lanes):
            await self.remove_speaker(sid)
        await self._hub.drain()
        await self._bc.aclose()
