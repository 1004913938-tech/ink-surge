"""Worker must never broadcast captions of a room whose LiveCaption metadata is missing."""

import types

import pytest

pytest.importorskip("livekit.agents")

from livecaption_agent import worker  # noqa: E402
from livecaption_agent.config import AgentConfig  # noqa: E402


def ctx_with(metadata):
    room = types.SimpleNamespace(metadata=metadata, name="r1")
    return types.SimpleNamespace(room=room)


@pytest.mark.parametrize("meta", ["", "not json", '{"targets":["zh"]}', '{"mode":"personal"}', '{"mode":"other"}'])
def test_missing_or_invalid_metadata_disables_captioning(meta, monkeypatch):
    monkeypatch.setattr(worker, "make_translator", lambda cfg, g: object())
    rc = worker.RoomCaptioner(ctx_with(meta), AgentConfig())
    assert rc.enabled is False


def test_personal_room_sends_only_to_owner(monkeypatch):
    monkeypatch.setattr(worker, "make_translator", lambda cfg, g: object())
    rc = worker.RoomCaptioner(ctx_with('{"mode":"personal","owner":"host-1","targets":["zh"]}'), AgentConfig())
    assert rc.enabled and rc.personal
    assert rc._bc._sink._destinations == ["host-1"]


def test_broadcast_room_broadcasts(monkeypatch):
    monkeypatch.setattr(worker, "make_translator", lambda cfg, g: object())
    rc = worker.RoomCaptioner(ctx_with('{"mode":"broadcast","targets":["en"]}'), AgentConfig())
    assert rc.enabled and not rc.personal and rc._bc._sink._destinations is None


@pytest.mark.parametrize("url,no_proxy,expected", [
    ("ws://localhost:7880", "localhost,127.0.0.1", None),
    ("ws://livekit:7880", "livekit", None),
    ("wss://lk.example.com", "localhost", "http://proxy:3128"),
    ("wss://lk.example.com", "", "http://proxy:3128"),
])
def test_livekit_connection_honours_no_proxy(url, no_proxy, expected, monkeypatch):
    for k in ("HTTP_PROXY", "http_proxy", "https_proxy", "no_proxy"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy:3128")
    monkeypatch.setenv("NO_PROXY", no_proxy)
    assert worker.livekit_proxy(url) == expected


def test_fatal_stt_errors_are_reported_not_hammered():
    from livekit.agents import APIConnectionError, APIStatusError

    assert "余额不足" in worker.stt_fatal_message(APIStatusError("no credit", status_code=402, retryable=False))
    assert "API Key" in worker.stt_fatal_message(APIStatusError("bad key", status_code=401, retryable=False))
    assert worker.stt_fatal_message(APIStatusError("busy", status_code=503, retryable=True)) is None
    assert worker.stt_fatal_message(APIStatusError("rate", status_code=429, retryable=True)) is None
    assert worker.stt_fatal_message(APIConnectionError()) is None
    assert worker.stt_fatal_message(RuntimeError("x")) is None


async def test_pipe_tells_user_once_then_clears_on_recovery(monkeypatch):
    from livekit.agents import APIStatusError

    from livecaption_core import SpeakerInfo
    from livecaption_core.tracks import TrackSpec

    notices = []

    class Session:
        async def notice(self, code, msg=""):
            notices.append(code)

    monkeypatch.setattr(worker, "FATAL_RETRY_S", 0.01)
    spec = TrackSpec("TR_1", SpeakerInfo("me:meeting", "会议声音", "auto"), diarized=True)
    pipe = worker.TrackPipe(AgentConfig(), Session(), spec, track=None)
    calls = 0

    async def run_once():
        nonlocal calls
        calls += 1
        if calls <= 3:
            raise APIStatusError("Organization balance exhausted", status_code=402, retryable=False)
        # balance topped up: the first STT event clears the banner (done inside _run_once)
        if pipe._failing:
            pipe._failing = False
            await pipe._session.notice("ok")

    monkeypatch.setattr(pipe, "_run_once", run_once)
    await pipe._run()
    assert calls == 4
    assert notices == ["stt_unavailable", "ok"]
