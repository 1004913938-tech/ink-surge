"""Keyless STT for demos and integration tests (LC_STT=demo).

It does not recognise speech. While audio frames keep arriving it "hears" a scripted
sentence every few seconds: interims word by word, then a final. This lets the whole
chain (LiveKit → agent → captions → browsers) be exercised without a provider key.

diarize=True simulates a meeting's system audio: six participants taking turns in
Indonesian / English / Chinese, with speaker labels on finals only (like Deepgram) and
the detected language on every event.
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

MEETING_SCRIPT = [
    ("S0", "id", "Selamat pagi semuanya, terima kasih sudah bergabung."),
    ("S1", "en", "Thanks. Can we start with the delivery schedule?"),
    ("S2", "id", "Pengiriman pertama dijadwalkan minggu depan."),
    ("S3", "zh", "我们这边的报关资料已经准备好了。"),
    ("S4", "en", "What about the payment terms for the second order?"),
    ("S5", "id", "Kami minta pembayaran tiga puluh persen di muka."),
    ("S0", "id", "Baik, kita catat dulu dan konfirmasi besok."),
]


class DemoSTT(stt.STT):
    def __init__(self, *, sentence_every_s: float = 4.0, diarize: bool = False) -> None:
        super().__init__(capabilities=stt.STTCapabilities(streaming=True, interim_results=True, diarization=diarize))
        self._every = sentence_every_s
        self._diarize = diarize

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
        return DemoStream(stt=self, conn_options=conn_options, every=self._every, diarize=self._diarize)


class DemoStream(stt.RecognizeStream):
    def __init__(self, *, stt: DemoSTT, conn_options: APIConnectOptions, every: float, diarize: bool) -> None:
        super().__init__(stt=stt, conn_options=conn_options)
        self._every = every
        self._diarize = diarize

    def _script(self):
        if self._diarize:
            return itertools.cycle(MEETING_SCRIPT)
        return ((None, "zh", s) for s in itertools.cycle(SCRIPT))

    async def _run(self) -> None:
        script = self._script()
        audio_s = 0.0
        next_at = self._every
        async for item in self._input_ch:
            if isinstance(item, rtc.AudioFrame):
                audio_s += item.samples_per_channel / item.sample_rate
            if audio_s < next_at:
                continue
            next_at += self._every
            label, lang, sentence = next(script)
            # interims: grow the sentence in ~4 chunks, 150 ms apart, no speaker yet
            step = max(1, len(sentence) // 4)
            for cut in range(step, len(sentence), step):
                self._event_ch.send_nowait(
                    stt.SpeechEvent(
                        type=stt.SpeechEventType.INTERIM_TRANSCRIPT,
                        alternatives=[stt.SpeechData(language=lang, text=sentence[:cut])],
                    )
                )
                await asyncio.sleep(0.15)
            self._event_ch.send_nowait(
                stt.SpeechEvent(
                    type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives=[stt.SpeechData(language=lang, text=sentence, confidence=1.0,
                                                 speaker_id=label, end_time=time.time())],
                )
            )
