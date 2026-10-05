"""API: personal sessions are private, survive room re-creation, and migrate old DBs."""

import importlib
import json
import sqlite3
import sys

import jwt
import pytest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LC_DB_PATH", str(tmp_path / "lc.db"))
    monkeypatch.setenv("LC_DEV_API_KEY", "k")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "secretsecretsecretsecretsecret12")
    sys.modules.pop("livecaption_api.app", None)
    app_mod = importlib.import_module("livecaption_api.app")
    app_mod.LIVEKIT_API_SECRET = "secretsecretsecretsecretsecret12"
    created = []

    class FakeRoomSvc:
        async def create_room(self, req):
            created.append(req)

    class FakeLK:
        def __init__(self, *a, **k):
            self.room = FakeRoomSvc()

        async def aclose(self):
            pass

    monkeypatch.setattr(app_mod.api, "LiveKitAPI", FakeLK)
    from fastapi.testclient import TestClient

    return TestClient(app_mod.app), app_mod, created


def decode(tok):
    return jwt.decode(tok, "secretsecretsecretsecretsecret12", algorithms=["HS256"], options={"verify_aud": False})


def test_personal_session_is_private_and_carries_room_config(client):
    c, app_mod, created = client
    r = c.post("/api/sessions", headers={"X-Api-Key": "k"},
               json={"mode": "personal", "targets": ["zh"], "remote_lang": "auto", "host_name": "我"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["join_code"] is None and s["join_url"] is None and s["targets"] == ["zh"]
    req = created[0]
    meta = json.loads(req.metadata)
    assert meta["mode"] == "personal" and meta["owner"].startswith("host-")
    assert req.max_participants == 3 and req.departure_timeout == app_mod.DEPARTURE_TIMEOUT_S
    claims = decode(s["host_token"])
    assert claims["sub"] == meta["owner"]
    rc = claims["roomConfig"]
    assert json.loads(rc["metadata"]) == meta and rc["maxParticipants"] == 3  # survives auto re-create
    # not joinable, no extra speakers
    row = app_mod.db.session_by_id(s["session_id"])
    assert c.get(f"/api/join/{row['join_code']}").status_code == 404
    assert c.post(f"/api/sessions/{s['session_id']}/speakers", headers={"X-Api-Key": "k"},
                  json={"name": "x"}).status_code == 409


def test_broadcast_listener_token_carries_room_config(client):
    c, app_mod, created = client
    s = c.post("/api/sessions", headers={"X-Api-Key": "k"}, json={"targets": ["en", "id"]}).json()
    j = c.get(f"/api/join/{s['join_code']}?langs=en").json()
    rc = decode(j["token"])["roomConfig"]
    assert json.loads(rc["metadata"])["mode"] == "broadcast"


def test_livekit_down_ends_session(client, monkeypatch):
    c, app_mod, created = client

    class Boom:
        def __init__(self, *a, **k):
            self.room = self

        async def create_room(self, req):
            raise ConnectionError("down")

        async def aclose(self):
            pass

    monkeypatch.setattr(app_mod.api, "LiveKitAPI", Boom)
    r = c.post("/api/sessions", headers={"X-Api-Key": "k"}, json={})
    assert r.status_code == 503


def test_migration_adds_columns_to_old_db(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript("""
    CREATE TABLE sessions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, room TEXT UNIQUE NOT NULL,
      join_code TEXT UNIQUE NOT NULL, title TEXT, src_lang TEXT NOT NULL, targets TEXT NOT NULL,
      created_at REAL NOT NULL, ended_at REAL, minutes INTEGER NOT NULL DEFAULT 0);
    INSERT INTO sessions VALUES ('ses_old','acc','room1','ABCDEF','t','zh','en',0,NULL,0);
    """)
    con.commit(); con.close()
    from livecaption_api.db import Database

    db = Database(str(path))
    Database(str(path))  # idempotent
    old = db.session_by_code("ABCDEF")
    assert old["mode"] == "broadcast" and old["meta"] == "{}"
    new = db.create_session("acc", "t", "zh", ["en"], mode="personal")
    assert db.session_by_id(new["id"])["mode"] == "personal"


@pytest.mark.parametrize("stt,auto", [("deepgram", False), ("soniox", True), ("demo", True)])
def test_config_tells_ui_whether_auto_language_works(client, monkeypatch, stt, auto):
    c, app_mod, _ = client
    monkeypatch.setenv("LC_STT", stt)
    monkeypatch.setenv("LC_LANG_HINTS", "zh,id,en")
    assert c.get("/api/config").json()["auto_lang"] is auto
