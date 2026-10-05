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
