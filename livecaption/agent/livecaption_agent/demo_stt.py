"""Keyless STT for demos and integration tests (LC_STT=demo).

It does not recognise speech. While audio frames keep arriving it "hears" a scripted
Chinese sentence every few seconds: interims word by word, then a final. This lets the
whole chain (LiveKit → agent → captions → browsers) be exercised without a Deepgram key.
"""

from __future__ import annotations

import asyncio
import itertools
import time

from livekit import rtc
from livekit.agents import stt
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN, APIConnectOptions, NotGivenOr

SCRIPT = [
    "大家好，欢迎参加今天的会议。",
    "我们下季度的目标是把印尼市场的销售额提高百分之三十。",
    "新产线预计在十一月投产，请各部门提前准备。",
    "关于设备采购预算，财务部下周给出最终方案。",
    "有问题的同事可以随时打断我。",
]


class DemoSTT(stt.STT):
    def __init__(self, *, sentence_every_s: float = 4.0) -> None:
        super().__init__(capabilities=stt.STTCapabilities(streaming=True, interim_results=True))
        self._every = sentence_every_s

    @property
    def model(self) -> str:
        return "demo-script"

    @property
    def provider(self) -> str:
        return "livecaption"

    async def _recognize_impl(self, buffer, *, language=NOT_GIVEN, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        raise NotImplementedError("DemoSTT is streaming-only")

    def stream(
        self,
        *,
        language: NotGivenOr[str] = NOT_GIVEN,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> "DemoStream":
        return DemoStream(stt=self, conn_options=conn_options, every=self._every)


class DemoStream(stt.RecognizeStream):
    def __init__(self, *, stt: DemoSTT, conn_options: APIConnectOptions, every: float) -> None:
        super().__init__(stt=stt, conn_options=conn_options)
        self._every = every

    async def _run(self) -> None:
        script = itertools.cycle(SCRIPT)
        audio_s = 0.0
        next_at = self._every
        async for item in self._input_ch:
            if isinstance(item, rtc.AudioFrame):
                audio_s += item.samples_per_channel / item.sample_rate
            if audio_s < next_at:
                continue
            next_at += self._every
            sentence = next(script)
            # interims: grow the sentence in ~4 chunks, 150 ms apart
            step = max(1, len(sentence) // 4)
            for cut in range(step, len(sentence), step):
                self._event_ch.send_nowait(
                    stt.SpeechEvent(
                        type=stt.SpeechEventType.INTERIM_TRANSCRIPT,
                        alternatives=[stt.SpeechData(language="zh", text=sentence[:cut])],
                    )
                )
                await asyncio.sleep(0.15)
            self._event_ch.send_nowait(
                stt.SpeechEvent(
                    type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives=[stt.SpeechData(language="zh", text=sentence, confidence=1.0,
                                                 end_time=time.time())],
                )
            )
