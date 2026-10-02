"""SQLite persistence (stdlib only). Accounts, sessions, usage."""

from __future__ import annotations

import os
import secrets
import sqlite3
import time
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  api_key TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  minutes_quota INTEGER NOT NULL,
  minutes_used INTEGER NOT NULL DEFAULT 0,
  period_start REAL NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  room TEXT UNIQUE NOT NULL,
  join_code TEXT UNIQUE NOT NULL,
  title TEXT,
  src_lang TEXT NOT NULL,
  targets TEXT NOT NULL,
  created_at REAL NOT NULL,
  ended_at REAL,
  minutes INTEGER NOT NULL DEFAULT 0
);
"""

PLANS = {
    "free": {"minutes": 60, "max_listeners": 20, "max_langs": 2, "price_usd": 0},
    "pro": {"minutes": 1500, "max_listeners": 200, "max_langs": 5, "price_usd": 49},
    "team": {"minutes": 10000, "max_listeners": 2000, "max_langs": 10, "price_usd": 299},
}


class Database:
    def __init__(self, path: str | None = None) -> None:
        self._path = path or os.getenv("LC_DB_PATH", "livecaption.db")
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self):
        c = sqlite3.connect(self._path)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()

    # ---- accounts ----------------------------------------------------------

    def create_account(self, email: str | None, plan: str = "free", api_key: str | None = None) -> dict:
        api_key = api_key or "lc_" + secrets.token_urlsafe(24)
        acc = {
            "id": "acc_" + secrets.token_hex(6),
            "email": email,
            "api_key": api_key,
            "plan": plan,
            "minutes_quota": PLANS[plan]["minutes"],
            "minutes_used": 0,
            "period_start": time.time(),
            "created_at": time.time(),
        }
        with self.conn() as c:
            c.execute(
                "INSERT INTO accounts VALUES (:id,:email,:api_key,:plan,:minutes_quota,:minutes_used,:period_start,:created_at)",
                acc,
            )
        return acc

    def account_by_key(self, api_key: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM accounts WHERE api_key=?", (api_key,)).fetchone()
        return dict(row) if row else None

    def set_plan(self, account_id: str, plan: str) -> None:
        with self.conn() as c:
            c.execute(
                "UPDATE accounts SET plan=?, minutes_quota=?, minutes_used=0, period_start=? WHERE id=?",
                (plan, PLANS[plan]["minutes"], time.time(), account_id),
            )

    # ---- sessions ----------------------------------------------------------

    def create_session(self, account_id: str, title: str, src_lang: str, targets: list[str]) -> dict:
        sid = "ses_" + secrets.token_hex(5)
        s = {
            "id": sid,
            "account_id": account_id,
            "room": f"lc_{account_id}_{sid}",
            "join_code": _join_code(),
            "title": title,
            "src_lang": src_lang,
            "targets": ",".join(targets),
            "created_at": time.time(),
            "ended_at": None,
            "minutes": 0,
        }
        with self.conn() as c:
            c.execute(
                "INSERT INTO sessions VALUES (:id,:account_id,:room,:join_code,:title,:src_lang,:targets,:created_at,:ended_at,:minutes)",
                s,
            )
        return s

    def session_by_code(self, code: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM sessions WHERE join_code=? AND ended_at IS NULL", (code.upper(),)).fetchone()
        return dict(row) if row else None

    def session_by_id(self, sid: str) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        return dict(row) if row else None

    def end_session(self, sid: str) -> None:
        with self.conn() as c:
            c.execute("UPDATE sessions SET ended_at=? WHERE id=? AND ended_at IS NULL", (time.time(), sid))

    def add_usage(self, room: str, minutes: int) -> dict | None:
        """Charge minutes to the session's account. Returns the updated account."""
        with self.conn() as c:
            s = c.execute("SELECT account_id, id FROM sessions WHERE room=?", (room,)).fetchone()
            if s is None:
                return None
            c.execute("UPDATE sessions SET minutes=minutes+? WHERE id=?", (minutes, s["id"]))
            c.execute("UPDATE accounts SET minutes_used=minutes_used+? WHERE id=?", (minutes, s["account_id"]))
            row = c.execute("SELECT * FROM accounts WHERE id=?", (s["account_id"],)).fetchone()
        return dict(row) if row else None


_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def _join_code(n: int = 6) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(n))
