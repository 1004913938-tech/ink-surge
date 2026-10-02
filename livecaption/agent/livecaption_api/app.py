"""LiveCaption API: sessions, join codes, LiveKit tokens, plan metering.

Auth (MVP): hosts send `X-Api-Key`. A dev account is seeded from LC_DEV_API_KEY so the
stack works out of the box; email-OTP signup is Phase 2 (ARCHITECTURE.md §5).
"""

from __future__ import annotations

import datetime as dt
import os
import secrets
import time

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel, Field

from .db import PLANS, Database

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")
PUBLIC_WEB_URL = os.getenv("LC_PUBLIC_WEB_URL", "http://localhost:5173")
INTERNAL_TOKEN = os.getenv("LC_INTERNAL_TOKEN", "dev-internal")

app = FastAPI(title="LiveCaption API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("LC_CORS_ORIGINS", PUBLIC_WEB_URL).split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
db = Database()

if os.getenv("LC_DEV_API_KEY") and not db.account_by_key(os.environ["LC_DEV_API_KEY"]):
    db.create_account("dev@localhost", plan="team", api_key=os.environ["LC_DEV_API_KEY"])


# ---- helpers ----------------------------------------------------------------

def _token(identity: str, name: str, room: str, *, role: str, attrs: dict[str, str], ttl_h: int) -> str:
    speaker = role == "speaker"
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=speaker,
        can_subscribe=True,
        can_publish_data=False,  # only the agent publishes captions
    )
    return (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(name)
        .with_grants(grants)
        .with_attributes({"lc.role": role, **attrs})
        .with_ttl(dt.timedelta(hours=ttl_h))
        .to_jwt()
    )


def require_account(x_api_key: str = Header(default="")) -> dict:
    acc = db.account_by_key(x_api_key) if x_api_key else None
    if acc is None:
        raise HTTPException(401, "invalid api key")
    return acc


# ---- public API -------------------------------------------------------------

class CreateSession(BaseModel):
    title: str = "Meeting"
    host_name: str = "Host"
    src_lang: str = "zh"
    targets: list[str] = Field(default_factory=lambda: ["en", "id"])
    glossary: dict[str, str] = Field(default_factory=dict)


@app.get("/api/plans")
def plans() -> dict:
    return PLANS


@app.get("/api/me")
def me(acc: dict = Depends(require_account)) -> dict:
    return {k: acc[k] for k in ("id", "email", "plan", "minutes_quota", "minutes_used")}


@app.post("/api/sessions")
async def create_session(body: CreateSession, acc: dict = Depends(require_account)) -> dict:
    plan = PLANS[acc["plan"]]
    if acc["minutes_used"] >= acc["minutes_quota"]:
        raise HTTPException(402, "plan minutes exhausted; upgrade to continue")
    targets = [t for t in body.targets if t != body.src_lang][: plan["max_langs"]]
    s = db.create_session(acc["id"], body.title, body.src_lang, targets)

    # Room metadata is how the agent learns targets + glossary (ARCHITECTURE.md §2).
    import json

    lk = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    try:
        await lk.room.create_room(
            api.CreateRoomRequest(
                name=s["room"],
                empty_timeout=600,
                max_participants=plan["max_listeners"] + 10,
                metadata=json.dumps({"targets": targets, "glossary": body.glossary, "session": s["id"]}),
            )
        )
    finally:
        await lk.aclose()

    host_identity = f"host-{secrets.token_hex(3)}"
    return {
        "session_id": s["id"],
        "room": s["room"],
        "join_code": s["join_code"],
        "join_url": f"{PUBLIC_WEB_URL}/#/j/{s['join_code']}",
        "livekit_url": LIVEKIT_URL,
        "src_lang": body.src_lang,
        "targets": targets,
        "host_token": _token(
            host_identity, body.host_name, s["room"], role="speaker",
            attrs={"lc.lang": body.src_lang, "lc.name": body.host_name}, ttl_h=12,
        ),
    }


class SpeakerToken(BaseModel):
    name: str
    lang: str = "zh"


@app.post("/api/sessions/{sid}/speakers")
def add_speaker(sid: str, body: SpeakerToken, acc: dict = Depends(require_account)) -> dict:
    s = db.session_by_id(sid)
    if s is None or s["account_id"] != acc["id"]:
        raise HTTPException(404, "session not found")
    identity = f"spk-{secrets.token_hex(3)}"
    return {
        "livekit_url": LIVEKIT_URL,
        "room": s["room"],
        "token": _token(identity, body.name, s["room"], role="speaker",
                        attrs={"lc.lang": body.lang, "lc.name": body.name}, ttl_h=12),
    }


@app.post("/api/sessions/{sid}/end")
def end_session(sid: str, acc: dict = Depends(require_account)) -> dict:
    s = db.session_by_id(sid)
    if s is None or s["account_id"] != acc["id"]:
        raise HTTPException(404, "session not found")
    db.end_session(sid)
    return {"ok": True}


@app.get("/api/join/{code}")
def join(code: str, langs: str = "en") -> dict:
    """Listener entry: no account needed. `langs` = comma-separated wanted languages."""
    s = db.session_by_code(code)
    if s is None:
        raise HTTPException(404, "no active session for this code")
    identity = f"lis-{secrets.token_hex(4)}"
    wanted = ",".join(l for l in langs.split(",") if l)
    return {
        "livekit_url": LIVEKIT_URL,
        "room": s["room"],
        "title": s["title"],
        "src_lang": s["src_lang"],
        "targets": s["targets"].split(","),
        "token": _token(identity, "listener", s["room"], role="listener", attrs={"lc.langs": wanted}, ttl_h=6),
    }


# ---- internal (agent -> api) ------------------------------------------------

class Usage(BaseModel):
    room: str
    minutes: int = 1


@app.post("/internal/usage")
def usage(body: Usage, x_internal_token: str = Header(default="")) -> dict:
    if not secrets.compare_digest(x_internal_token, INTERNAL_TOKEN):
        raise HTTPException(401)
    acc = db.add_usage(body.room, body.minutes)
    if acc is None:
        raise HTTPException(404, "unknown room")
    return {"over_quota": acc["minutes_used"] > acc["minutes_quota"], "minutes_used": acc["minutes_used"]}


# ---- billing (Phase 2) ------------------------------------------------------

@app.post("/billing/stripe/webhook", status_code=501)
def stripe_webhook() -> dict:
    """Reserved. Verify Stripe signature, map price -> plan, call db.set_plan()."""
    return {"detail": "billing webhook not implemented yet"}


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "t": time.time()}
