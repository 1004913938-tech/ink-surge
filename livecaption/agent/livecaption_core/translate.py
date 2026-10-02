from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol, Sequence

from .models import Segment

log = logging.getLogger("livecaption.translate")


class Translator(Protocol):
    """One call translates `text` into every language in `targets`.

    Must return a dict with exactly the requested target codes as keys. Raise on
    failure; the hub handles retries, timeouts and the circuit breaker.
    """

    async def translate(
        self,
        text: str,
        src_lang: str,
        targets: Sequence[str],
        *,
        glossary: dict[str, str] | None = None,
        context: Sequence[str] = (),
    ) -> dict[str, str]: ...


class CircuitOpen(RuntimeError):
    pass


class FakeTranslator:
    """Deterministic translator for tests and local demos.

    latency: seconds, or a callable returning seconds (lets tests inject jitter).
    fail_rate: probability [0,1] that a call raises RuntimeError.
    """

    def __init__(
        self,
        *,
        latency: float | Callable[[], float] = 0.0,
        fail_rate: float = 0.0,
        seed: int = 0,
    ) -> None:
        self._latency = latency
        self._fail_rate = fail_rate
        self._rng = random.Random(seed)
        self.calls = 0

    async def translate(
        self,
        text: str,
        src_lang: str,
        targets: Sequence[str],
        *,
        glossary: dict[str, str] | None = None,
        context: Sequence[str] = (),
    ) -> dict[str, str]:
        self.calls += 1
        lat = self._latency() if callable(self._latency) else self._latency
        if lat:
            await asyncio.sleep(lat)
        if self._fail_rate and self._rng.random() < self._fail_rate:
            raise RuntimeError("fake translator failure")
        return {lang: f"[{lang}] {text}" for lang in targets}


@dataclass
class TranslationHubConfig:
    max_concurrency: int = 8
    queue_max: int = 64
    """In-flight + waiting segments. Beyond this, new finals are marked `skipped`
    (source still shows) instead of growing an unbounded backlog."""
    timeout_s: float = 6.0
    retries: int = 1
    retry_backoff_s: float = 0.3
    breaker_fail_threshold: int = 5
    breaker_cooldown_s: float = 30.0
    reorder_window_s: float = 1.5
    """How long a finished translation waits for an earlier (still running) segment of
    the same speaker before being released out of order (marked `late`)."""
    cache_size: int = 512


@dataclass
class _LaneState:
    order: deque[int] = field(default_factory=deque)  # submitted seqs, in order
    done: dict[int, Segment] = field(default_factory=dict)
    abandoned: set[int] = field(default_factory=set)  # released past by the reorder timer
    timer: asyncio.Task | None = None


class TranslationHub:
    """Fan-out translation with dedupe cache, concurrency/queue limits, timeout+retry,
    a circuit breaker, and per-speaker in-order release of results.

    `on_done(segment)` is awaited exactly once per submitted segment, in per-speaker
    seq order whenever the reorder window allows it.
    """

    def __init__(
        self,
        translator: Translator,
        config: TranslationHubConfig | None = None,
        *,
        glossary: dict[str, str] | None = None,
    ) -> None:
        self._tr = translator
        self.cfg = config or TranslationHubConfig()
        self._glossary = glossary or {}
        self._sem = asyncio.Semaphore(self.cfg.max_concurrency)
        self._inflight = 0
        self._cache: OrderedDict[tuple, dict[str, str]] = OrderedDict()
        self._pending: dict[tuple, asyncio.Future[dict[str, str] | None]] = {}
        self._lanes: dict[str, _LaneState] = defaultdict(_LaneState)
        self._tasks: set[asyncio.Task] = set()
        # circuit breaker
        self._consecutive_failures = 0
        self._open_until = 0.0
        self.metrics = {
            "submitted": 0,
            "ok": 0,
            "failed": 0,
            "skipped": 0,
            "late": 0,
            "cache_hits": 0,
            "breaker_opens": 0,
        }

    # ---------------------------------------------------------------- public

    def submit(
        self,
        seg: Segment,
        targets: Sequence[str],
        on_done: Callable[[Segment], Awaitable[None]],
        *,
        context: Sequence[str] = (),
    ) -> None:
        """Non-blocking. Schedules translation and in-order delivery."""
        self.metrics["submitted"] += 1
        lane = self._lanes[seg.speaker.id]
        lane.order.append(seg.seq)
        task = asyncio.create_task(self._run(seg, tuple(sorted(set(targets))), on_done, tuple(context)))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    @property
    def breaker_open(self) -> bool:
        return time.monotonic() < self._open_until

    async def drain(self) -> None:
        """Wait for all outstanding work (tests / shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
        for lane in self._lanes.values():
            if lane.timer is not None and not lane.timer.done():
                await lane.timer

    async def aclose(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        for lane in self._lanes.values():
            if lane.timer is not None:
                lane.timer.cancel()

    # --------------------------------------------------------------- internal

    async def _run(
        self,
        seg: Segment,
        targets: tuple[str, ...],
        on_done: Callable[[Segment], Awaitable[None]],
        context: tuple[str, ...],
    ) -> None:
        try:
            if not targets:
                seg.tr_status = "ok"
            elif self._inflight >= self.cfg.queue_max:
                seg.tr_status = "skipped"
                self.metrics["skipped"] += 1
            elif self.breaker_open:
                seg.tr_status = "skipped"
                self.metrics["skipped"] += 1
            else:
                self._inflight += 1
                try:
                    await self._translate_with_policy(seg, targets, context)
                finally:
                    self._inflight -= 1
        except Exception:  # never let a bug here lose a segment
            log.exception("translation task crashed for %s", seg.sid)
            seg.tr_status = "failed"
        await self._complete(seg, on_done)

    async def _translate_with_policy(
        self, seg: Segment, targets: tuple[str, ...], context: tuple[str, ...]
    ) -> None:
        key = (seg.text, seg.speaker.lang, targets)
        cached = self._cache.get(key)
        if cached is not None:
            self._cache.move_to_end(key)
            self.metrics["cache_hits"] += 1
            seg.translations = dict(cached)
            seg.tr_status = "ok"
            return

        # Identical text already being translated (e.g. two speakers, or a repeated
        # phrase): piggy-back on that request instead of paying twice.
        pending = self._pending.get(key)
        if pending is not None:
            self.metrics["cache_hits"] += 1
            result = await pending
            if result is None:
                seg.tr_status = "failed"
                self.metrics["failed"] += 1
            else:
                seg.translations = dict(result)
                seg.tr_status = "ok"
            return

        fut: asyncio.Future[dict[str, str] | None] = asyncio.get_running_loop().create_future()
        self._pending[key] = fut
        try:
            await self._translate_uncached(seg, targets, context, key)
        finally:
            self._pending.pop(key, None)
            if not fut.done():
                fut.set_result(dict(seg.translations) if seg.tr_status == "ok" else None)

    async def _translate_uncached(
        self, seg: Segment, targets: tuple[str, ...], context: tuple[str, ...], key: tuple
    ) -> None:
        attempt = 0
        while True:
            try:
                async with self._sem:
                    if self.breaker_open:  # opened while we were queued
                        seg.tr_status = "skipped"
                        self.metrics["skipped"] += 1
                        return
                    result = await asyncio.wait_for(
                        self._tr.translate(
                            seg.text,
                            seg.speaker.lang,
                            targets,
                            glossary=self._glossary or None,
                            context=context,
                        ),
                        timeout=self.cfg.timeout_s,
                    )
                missing = [t for t in targets if not result.get(t)]
                if missing:
                    raise ValueError(f"translator omitted {missing}")
                seg.translations = {t: result[t] for t in targets}
                seg.tr_status = "ok"
                self.metrics["ok"] += 1
                self._consecutive_failures = 0
                self._cache[key] = dict(seg.translations)
                if len(self._cache) > self.cfg.cache_size:
                    self._cache.popitem(last=False)
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:  # timeout, network, provider, validation
                attempt += 1
                if attempt > self.cfg.retries:
                    log.warning("translation failed for %s after %d attempts: %r", seg.sid, attempt, e)
                    seg.tr_status = "failed"
                    self.metrics["failed"] += 1
                    self._consecutive_failures += 1
                    if self._consecutive_failures >= self.cfg.breaker_fail_threshold:
                        self._open_until = time.monotonic() + self.cfg.breaker_cooldown_s
                        self._consecutive_failures = 0
                        self.metrics["breaker_opens"] += 1
                        log.error("translation circuit opened for %.0fs", self.cfg.breaker_cooldown_s)
                    return
                await asyncio.sleep(self.cfg.retry_backoff_s * (2 ** (attempt - 1)))

    # ---- in-order release -------------------------------------------------

    async def _complete(self, seg: Segment, on_done: Callable[[Segment], Awaitable[None]]) -> None:
        lane = self._lanes[seg.speaker.id]
        lane.done[seg.seq] = seg
        seg._on_done = on_done  # type: ignore[attr-defined]
        if seg.seq in lane.abandoned:
            lane.abandoned.discard(seg.seq)
            if seg.tr_status == "ok":
                seg.tr_status = "late"
                self.metrics["late"] += 1
            lane.done.pop(seg.seq, None)
            await on_done(seg)
            return
        await self._release(lane)

    async def _release(self, lane: _LaneState) -> None:
        while lane.order and lane.order[0] in lane.done:
            seq = lane.order.popleft()
            seg = lane.done.pop(seq)
            await seg._on_done(seg)  # type: ignore[attr-defined]
        if lane.timer is not None and not lane.timer.done():
            lane.timer.cancel()
            lane.timer = None
        if lane.order and lane.done:
            # Head is still running but a later one finished: start the reorder clock.
            lane.timer = asyncio.create_task(self._reorder_timeout(lane))

    async def _reorder_timeout(self, lane: _LaneState) -> None:
        try:
            await asyncio.sleep(self.cfg.reorder_window_s)
        except asyncio.CancelledError:
            return
        # Give up waiting on every unfinished head; release what is done.
        while lane.order and lane.order[0] not in lane.done:
            lane.abandoned.add(lane.order.popleft())
        released_any = False
        while lane.order and lane.order[0] in lane.done:
            seq = lane.order.popleft()
            seg = lane.done.pop(seq)
            if seg.tr_status == "ok":
                seg.tr_status = "late"
                self.metrics["late"] += 1
            released_any = True
            await seg._on_done(seg)  # type: ignore[attr-defined]
        lane.timer = None
        if lane.order and lane.done:
            lane.timer = asyncio.create_task(self._reorder_timeout(lane))
        elif not released_any and lane.done:
            # Only abandoned seqs remained; nothing else to do.
            pass
