"""LiveKit Agents worker: one job per room.

Every audio track published by a participant with lc.role=speaker gets its own pipe:
audio -> STT stream -> CaptionSession.
  * microphone track          -> one known speaker (the participant)
  * screen-share audio track  -> the meeting's system audio: diarized into 说话人 1..N,
                                 language auto-detected (personal mode, ARCHITECTURE.md §3a)
Listeners' lc.langs attribute drives which target languages get translated.
Captions go out as LiveKit text streams on topic `lc.caption`; in personal mode only to
the room owner.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.request
from urllib.parse import urlparse

import aiohttp
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli, stt
from livekit.agents.language import LanguageCode

from livecaption_core import (
    Broadcaster,
    CaptionSession,
    SessionConfig,
    SpeakerInfo,
    TranslationHub,
    TranslationHubConfig,
)
from livecaption_core.models import AUTO_LANG, CAPTION_TOPIC
from livecaption_core.tracks import TrackSpec, Word

from .config import ATTR_LANG, ATTR_LANGS, ATTR_NAME, ATTR_ROLE, AgentConfig
from .providers import make_stt, make_translator

log = logging.getLogger("livecaption.worker")

MEETING_AUDIO_NAME = "会议声音"


class LiveKitSink:
    def __init__(self, room: rtc.Room, destinations: list[str] | None = None) -> None:
        self._room = room
        self._destinations = destinations or None

    async def publish(self, payload: str) -> None:
        try:
            await self._room.local_participant.send_text(
                payload, topic=CAPTION_TOPIC, destination_identities=self._destinations
            )
        except Exception:  # a transient data-channel error must not kill the pipeline
            log.warning("send_text failed", exc_info=True)


def base_lang(code: object) -> str | None:
    """'id-ID' -> 'id', 'cmn' -> 'zh'. None for empty / 'multi'."""
    s = str(code or "").strip()
    if not s or s.lower() in ("multi", AUTO_LANG):
        return None
    try:
        return LanguageCode(s).language
    except Exception:
        return s.split("-")[0].lower()


class TrackPipe:
    """One audio track -> STT -> session, with automatic STT stream restart."""

    def __init__(self, cfg: AgentConfig, session: CaptionSession, spec: TrackSpec, track: rtc.Track):
        self._cfg = cfg
        self._session = session
        self.spec = spec
        self._track = track
        self._task: asyncio.Task | None = None
        self._closed = False
        self._gen = 0
        """STT connection generation. Providers number speakers per connection (S0, "1"…),
        so labels are namespaced by generation: after a reconnect a new voice gets a new
        说话人 N instead of inheriting someone else's lane and local rename."""

    def start(self) -> None:
        self._session.add_track(self.spec)
        self._task = asyncio.create_task(self._run(), name=f"pipe-{self.spec.track_id}")

    async def aclose(self) -> None:
        self._closed = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        await self._session.remove_track(self.spec.track_id, spec=self.spec)

    async def _run(self) -> None:
        backoff = 0.5
        while not self._closed:
            try:
                await self._run_once()
                return  # audio stream ended normally (track unpublished)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("STT pipe %s crashed; restarting in %.1fs", self.spec.track_id, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10)

    async def _run_once(self) -> None:
        tid = self.spec.track_id
        # Own session with trust_env: the STT host is reached through HTTPS_PROXY / NO_PROXY
        # like any HTTP client, independent of the worker's LiveKit proxy (see livekit_proxy).
        http = aiohttp.ClientSession(trust_env=True)
        stt_impl = make_stt(self._cfg, self.spec.owner.lang, diarize=self.spec.diarized, http_session=http)
        audio = rtc.AudioStream.from_track(
            track=self._track, sample_rate=self._cfg.stt_sample_rate, num_channels=1
        )
        stream = stt_impl.stream()
        self._gen += 1
        self._watch_reconnects(stream)

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
                alt = ev.alternatives[0]
                auto = self.spec.owner.lang == AUTO_LANG
                lang = base_lang(alt.language) if auto else None
                label = self._label(alt.speaker_id)
                if ev.type in (stt.SpeechEventType.INTERIM_TRANSCRIPT, stt.SpeechEventType.PREFLIGHT_TRANSCRIPT):
                    await self._session.on_track_interim(tid, alt.text, speaker_label=label, lang=lang)
                elif ev.type == stt.SpeechEventType.FINAL_TRANSCRIPT:
                    words = [
                        Word(str(w), self._label(getattr(w, "speaker_id", None)),
                             base_lang(getattr(w, "language", None)) if auto else None)
                        for w in (alt.words or [])
                    ]
                    await self._session.on_track_final(
                        tid, alt.text, speaker_label=label, words=words or None, lang=lang
                    )
        finally:
            pump.cancel()
            await audio.aclose()
            await stream.aclose()
            await stt_impl.aclose()
            await http.close()


    def _label(self, speaker_id: str | None) -> str | None:
        if not speaker_id or speaker_id in ("UU", "UNKNOWN"):  # Speechmatics / AssemblyAI "unattributed"
            return None
        return f"{self._gen}:{speaker_id}"

    def _watch_reconnects(self, stream: stt.RecognizeStream) -> None:
        """Plugins reconnect inside the same stream (Deepgram/Soniox/AssemblyAI open a new
        websocket via _connect_ws after a drop or a retried error). Bump the generation
        on every connect so their restarted speaker numbering is not mixed with ours."""
        connect = getattr(stream, "_connect_ws", None)
        if connect is None:
            return

        async def connect_and_bump(*args, **kwargs):
            self._gen += 1
            return await connect(*args, **kwargs)

        stream._connect_ws = connect_and_bump  # type: ignore[method-assign]


class RoomCaptioner:
    def __init__(self, ctx: JobContext, cfg: AgentConfig) -> None:
        self._ctx = ctx
        self._cfg = cfg
        self._room = ctx.room
        meta = self._parse_metadata(ctx.room.metadata)
        glossary = meta.get("glossary", {}) or {}
        targets = frozenset(meta.get("targets") or cfg.base_targets)
        mode = meta.get("mode")
        self.personal = mode == "personal"
        self._owner = meta.get("owner") or None
        self._remote_lang = meta.get("remote_lang") or AUTO_LANG
        # Fail closed: only caption rooms the API created with an explicit mode. A room
        # LiveKit re-created without our metadata must never fall back to broadcasting
        # someone's private meeting to everyone in it.
        self.enabled = mode == "broadcast" or (self.personal and bool(self._owner))
        if not self.enabled:
            log.error("room %s has no valid LiveCaption metadata (mode=%r owner=%r); not captioning",
                      ctx.room.name, mode, self._owner)

        sink = LiveKitSink(self._room, [self._owner] if self.personal else None)
        self._bc = Broadcaster(sink, interim_hz=cfg.interim_hz)
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
        self._pipes: dict[str, TrackPipe] = {}

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

    def _spec_for(self, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> TrackSpec:
        name = p.attributes.get(ATTR_NAME) or p.name or p.identity
        if pub.source == rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO:
            return TrackSpec(
                track_id=pub.sid,
                owner=SpeakerInfo(id=f"{p.identity}:meeting", name=MEETING_AUDIO_NAME, lang=self._remote_lang),
                diarized=True,
            )
        return TrackSpec(
            track_id=pub.sid,
            owner=SpeakerInfo(id=p.identity, name=name,
                              lang=p.attributes.get(ATTR_LANG) or self._cfg.default_src_lang),
            echo_guard=self.personal,
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
        if self.personal and self._owner and p.identity != self._owner:
            return  # a personal room only captions its owner's tracks
        if pub.sid in self._pipes:
            return
        spec = self._spec_for(pub, p)
        pipe = TrackPipe(self._cfg, self._session, spec, track)
        self._pipes[pub.sid] = pipe
        pipe.start()
        log.info("track %s from %s: %s, lang=%s, diarized=%s",
                 pub.sid, p.identity, spec.owner.name, spec.owner.lang, spec.diarized)

    def _on_track_unsubscribed(self, track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            self._drop_pipe(pub.sid)

    def _on_participant_connected(self, p: rtc.RemoteParticipant) -> None:
        self._register_listener(p)

    def _on_participant_disconnected(self, p: rtc.RemoteParticipant) -> None:
        self._session.remove_listener(p.identity)
        for sid in [s for s, pipe in self._pipes.items() if pipe.spec.owner.id.split(":")[0] == p.identity]:
            self._drop_pipe(sid)

    def _on_attributes_changed(self, changed: dict[str, str], p: rtc.RemoteParticipant) -> None:
        if ATTR_LANGS in changed:
            self._session.set_listener_langs(p.identity, set(changed[ATTR_LANGS].split(",")))

    def _drop_pipe(self, track_sid: str) -> None:
        pipe = self._pipes.pop(track_sid, None)
        if pipe is not None:
            asyncio.create_task(pipe.aclose())

    # ---- lifecycle ----------------------------------------------------------

    async def run(self) -> None:
        if not self.enabled:
            return
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
        """Report one active minute per minute while any audio track is live (plan metering)."""
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


def livekit_proxy(url: str) -> str | None:
    """Proxy for the agent's own LiveKit connection. livekit-agents takes HTTPS_PROXY but
    ignores NO_PROXY, so a LiveKit server on the local network (ws://livekit:7880 behind a
    proxy that is only needed to reach the STT / translation APIs) failed with HTTP 405."""
    host = urlparse(url).hostname or ""
    if host and urllib.request.proxy_bypass(host):
        return None
    return next((v for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")
                 if (v := os.environ.get(k))), None)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint,
                              http_proxy=livekit_proxy(os.environ.get("LIVEKIT_URL", ""))))


if __name__ == "__main__":
    main()
