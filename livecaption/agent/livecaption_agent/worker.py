"""LiveKit Agents worker: one job per room.

Per remote participant with lc.role=speaker: audio track -> STT stream -> CaptionSession.
Listeners' lc.langs attribute drives which target languages get translated.
Captions go out as LiveKit text streams on topic `lc.caption` (room broadcast).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

import aiohttp
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli, stt

from livecaption_core import (
    Broadcaster,
    CaptionSession,
    SessionConfig,
    SpeakerInfo,
    TranslationHub,
    TranslationHubConfig,
)
from livecaption_core.models import CAPTION_TOPIC

from .config import ATTR_LANG, ATTR_LANGS, ATTR_NAME, ATTR_ROLE, AgentConfig
from .providers import make_stt, make_translator

log = logging.getLogger("livecaption.worker")


class LiveKitSink:
    def __init__(self, room: rtc.Room) -> None:
        self._room = room

    async def publish(self, payload: str) -> None:
        try:
            await self._room.local_participant.send_text(payload, topic=CAPTION_TOPIC)
        except Exception:  # a transient data-channel error must not kill the pipeline
            log.warning("send_text failed", exc_info=True)


class SpeakerPipe:
    """Audio track -> STT -> session, with automatic STT stream restart."""

    def __init__(self, cfg: AgentConfig, session: CaptionSession, speaker: SpeakerInfo, track: rtc.Track):
        self._cfg = cfg
        self._session = session
        self._speaker = speaker
        self._track = track
        self._task: asyncio.Task | None = None
        self._closed = False

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"pipe-{self._speaker.id}")

    async def aclose(self) -> None:
        self._closed = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        await self._session.remove_speaker(self._speaker.id)

    async def _run(self) -> None:
        backoff = 0.5
        while not self._closed:
            try:
                await self._run_once()
                return  # audio stream ended normally (track unpublished)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("STT pipe for %s crashed; restarting in %.1fs", self._speaker.id, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10)

    async def _run_once(self) -> None:
        stt_impl = make_stt(self._cfg, self._speaker.lang)
        audio = rtc.AudioStream.from_track(
            track=self._track, sample_rate=self._cfg.stt_sample_rate, num_channels=1
        )
        stream = stt_impl.stream()

        async def pump_audio() -> None:
            try:
                async for ev in audio:
                    stream.push_frame(ev.frame)
            finally:
                stream.end_input()

        pump = asyncio.create_task(pump_audio())
        try:
            async for ev in stream:
                if not ev.alternatives:
                    continue
                text = ev.alternatives[0].text
                if ev.type == stt.SpeechEventType.INTERIM_TRANSCRIPT:
                    await self._session.on_interim(self._speaker.id, text)
                elif ev.type == stt.SpeechEventType.FINAL_TRANSCRIPT:
                    await self._session.on_final(self._speaker.id, text)
        finally:
            pump.cancel()
            await audio.aclose()
            await stream.aclose()
            await stt_impl.aclose()


class RoomCaptioner:
    def __init__(self, ctx: JobContext, cfg: AgentConfig) -> None:
        self._ctx = ctx
        self._cfg = cfg
        self._room = ctx.room
        meta = self._parse_metadata(ctx.room.metadata)
        glossary = meta.get("glossary", {}) or {}
        targets = frozenset(meta.get("targets") or cfg.base_targets)

        self._bc = Broadcaster(LiveKitSink(self._room), interim_hz=cfg.interim_hz)
        self._hub = TranslationHub(
            make_translator(cfg, glossary),
            TranslationHubConfig(
                max_concurrency=cfg.max_concurrency,
                timeout_s=cfg.translate_timeout_s,
                reorder_window_s=cfg.reorder_window_s,
            ),
            glossary=glossary,
        )
        self._session = CaptionSession(self._bc, self._hub, SessionConfig(base_targets=targets, glossary=glossary))
        self._pipes: dict[str, SpeakerPipe] = {}
        self._started_at = time.time()

    @staticmethod
    def _parse_metadata(raw: str | None) -> dict:
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            log.warning("room metadata is not JSON: %r", raw[:80])
            return {}

    # ---- room events --------------------------------------------------------

    def bind(self) -> None:
        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)
        self._room.on("participant_connected", self._on_participant_connected)
        self._room.on("participant_disconnected", self._on_participant_disconnected)
        self._room.on("participant_attributes_changed", self._on_attributes_changed)
        for p in self._room.remote_participants.values():
            self._register_listener(p)
            for pub in p.track_publications.values():
                if pub.track is not None and pub.kind == rtc.TrackKind.KIND_AUDIO:
                    self._on_track_subscribed(pub.track, pub, p)

    def _speaker_info(self, p: rtc.RemoteParticipant) -> SpeakerInfo:
        return SpeakerInfo(
            id=p.identity,
            name=p.attributes.get(ATTR_NAME) or p.name or p.identity,
            lang=p.attributes.get(ATTR_LANG) or self._cfg.default_src_lang,
        )

    def _register_listener(self, p: rtc.RemoteParticipant) -> None:
        langs = p.attributes.get(ATTR_LANGS, "")
        if langs:
            self._session.set_listener_langs(p.identity, set(langs.split(",")))

    def _on_track_subscribed(self, track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        if p.attributes.get(ATTR_ROLE, "speaker") != "speaker":
            return  # listeners cannot publish anyway (token), belt and braces
        if p.identity in self._pipes:
            return
        info = self._speaker_info(p)
        self._session.add_speaker(info)
        pipe = SpeakerPipe(self._cfg, self._session, info, track)
        self._pipes[p.identity] = pipe
        pipe.start()
        log.info("speaker %s (%s) joined, lang=%s", info.id, info.name, info.lang)

    def _on_track_unsubscribed(self, track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            self._drop_speaker(p.identity)

    def _on_participant_connected(self, p: rtc.RemoteParticipant) -> None:
        self._register_listener(p)

    def _on_participant_disconnected(self, p: rtc.RemoteParticipant) -> None:
        self._session.remove_listener(p.identity)
        self._drop_speaker(p.identity)

    def _on_attributes_changed(self, changed: dict[str, str], p: rtc.RemoteParticipant) -> None:
        if ATTR_LANGS in changed:
            self._session.set_listener_langs(p.identity, set(changed[ATTR_LANGS].split(",")))

    def _drop_speaker(self, identity: str) -> None:
        pipe = self._pipes.pop(identity, None)
        if pipe is not None:
            asyncio.create_task(pipe.aclose())

    # ---- lifecycle ----------------------------------------------------------

    async def run(self) -> None:
        self.bind()
        await self._session.reset()  # tells clients a (re)start happened
        meter = asyncio.create_task(self._meter_usage())
        try:
            # Stay alive until the room closes; the worker cancels this on shutdown.
            while self._room.connection_state != rtc.ConnectionState.CONN_DISCONNECTED:
                await asyncio.sleep(1)
        finally:
            meter.cancel()
            for pipe in list(self._pipes.values()):
                await pipe.aclose()
            await self._session.aclose()

    async def _meter_usage(self) -> None:
        """Report one active minute per minute while any speaker is live (plan metering)."""
        if not self._cfg.api_url:
            return
        async with aiohttp.ClientSession() as http:
            while True:
                await asyncio.sleep(60)
                if not self._pipes:
                    continue
                try:
                    async with http.post(
                        f"{self._cfg.api_url}/internal/usage",
                        json={"room": self._room.name, "minutes": 1},
                        headers={"X-Internal-Token": self._cfg.internal_token},
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        data = await resp.json()
                        if data.get("over_quota"):
                            log.warning("room %s over quota: translation disabled", self._room.name)
                            self._session.cfg.base_targets = frozenset()
                except Exception:
                    log.warning("usage report failed", exc_info=True)


async def entrypoint(ctx: JobContext) -> None:
    cfg = AgentConfig()
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)
    log.info("captioner joined room %s", ctx.room.name)
    await RoomCaptioner(ctx, cfg).run()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))


if __name__ == "__main__":
    main()
