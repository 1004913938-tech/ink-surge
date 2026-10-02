from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict
from typing import Protocol

from .models import Caption


class Sink(Protocol):
    async def publish(self, payload: str) -> None: ...


class MemorySink:
    """Test sink: records every published message (parsed) in order."""

    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.raw: list[str] = []

    async def publish(self, payload: str) -> None:
        self.raw.append(payload)
        self.messages.append(json.loads(payload))


class Broadcaster:
    """Serialises captions and throttles interim updates per speaker.

    final / patch / reset are never throttled. Interims are coalesced: if a speaker
    produces interims faster than `interim_hz`, only the latest one is sent when the
    window elapses (so the listener still ends up with the newest text).
    """

    def __init__(self, sink: Sink, *, interim_hz: float = 4.0) -> None:
        self._sink = sink
        self._min_gap = 1.0 / interim_hz if interim_hz > 0 else 0.0
        self._last_interim_at: dict[str, float] = defaultdict(float)
        self._pending_interim: dict[str, Caption] = {}
        self._flush_tasks: dict[str, asyncio.Task] = {}
        self.sent = 0
        self.coalesced = 0

    async def send(self, cap: Caption) -> None:
        if cap.kind != "interim":
            # A final supersedes any pending interim for the same speaker.
            if cap.spk is not None:
                self._pending_interim.pop(cap.spk.id, None)
            await self._emit(cap)
            return

        key = cap.spk.id if cap.spk else "_"
        now = time.monotonic()
        gap = now - self._last_interim_at[key]
        if gap >= self._min_gap:
            self._last_interim_at[key] = now
            await self._emit(cap)
            return

        # Too soon: keep only the newest interim and schedule one flush.
        self._pending_interim[key] = cap
        self.coalesced += 1
        if key not in self._flush_tasks or self._flush_tasks[key].done():
            self._flush_tasks[key] = asyncio.create_task(self._flush_later(key, self._min_gap - gap))

    async def _flush_later(self, key: str, delay: float) -> None:
        await asyncio.sleep(delay)
        cap = self._pending_interim.pop(key, None)
        if cap is not None:
            self._last_interim_at[key] = time.monotonic()
            await self._emit(cap)

    async def _emit(self, cap: Caption) -> None:
        self.sent += 1
        await self._sink.publish(json.dumps(cap.to_dict(), ensure_ascii=False))

    async def aclose(self) -> None:
        for t in self._flush_tasks.values():
            t.cancel()
        self._flush_tasks.clear()
