"""Build a synthetic 6-person meeting (zh / id / en, with mid-sentence hand-overs) via TTS.

Not collected by pytest (needs network + ffmpeg). Run:
    pip install edge-tts && python tests/make_meeting_audio.py OUT_DIR
Writes OUT_DIR/meeting.wav (16 kHz mono s16) and OUT_DIR/meeting.json (ground truth:
speaker, language, text, start/end seconds of every utterance). Used by e2e_soniox_personal.py.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import wave
from pathlib import Path

import edge_tts
import numpy as np

SR = 16000

VOICES = {
    "P1": "zh-CN-YunyangNeural",          # zh, male (host)
    "P2": "id-ID-ArdiNeural",             # id, male
    "P3": "en-US-JennyNeural",            # en, female
    "P4": "zh-CN-XiaoxiaoNeural",         # zh, female
    "P5": "id-ID-GadisNeural",            # id, female
    "P6": "en-US-AndrewMultilingualNeural",  # en + id, male (one person, two languages)
}

# (speaker, lang, gap before in seconds, text). gap 0.15 = the next person cuts in mid-sentence:
# the STT sees no pause, so one endpoint spans two speakers.
SCRIPT: list[tuple[str, str, float, str]] = [
    ("P1", "zh", 0.0, "大家好，我们开始今天的周会，先请各位简单汇报一下进度。"),
    ("P2", "id", 1.2, "Baik, terima kasih. Minggu ini tim kami sudah menyelesaikan integrasi sistem pembayaran."),
    ("P3", "en", 1.2, "Great. On the marketing side, we launched the new campaign on Monday and the early numbers look promising."),
    ("P4", "zh", 1.2, "我补充一下，客服这边上周的投诉量下降了百分之二十。"),
    ("P5", "id", 1.2, "Untuk logistik, pengiriman ke Surabaya masih terlambat sekitar dua hari."),
    ("P6", "en", 1.2, "I can help with that. We have a new partner in East Java who can start next week, right?"),
    ("P5", "id", 0.15, "Ya, betul. Saya akan hubungi mereka besok pagi."),
    ("P1", "zh", 1.2, "好的，那物流的问题就交给你们两位跟进。"),
    ("P3", "en", 1.2, "One more thing, the budget review has been moved to Thursday afternoon."),
    ("P4", "zh", 0.15, "收到，我会提前把报表发给大家。"),
    ("P2", "id", 1.2, "Apakah kita perlu menambah satu orang lagi untuk proyek ini?"),
    ("P6", "id", 1.2, "Menurut saya belum perlu, kita lihat dulu hasil bulan depan."),
    ("P1", "zh", 1.2, "同意。今天就到这里，谢谢大家。"),
]

LEAD_S = 2.0
TAIL_S = 4.0


async def tts(text: str, voice: str, out: Path) -> np.ndarray:
    await edge_tts.Communicate(text, voice).save(str(out))
    pcm = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(out), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        check=True, capture_output=True,
    ).stdout
    a = np.frombuffer(pcm, dtype=np.int16)
    # trim TTS leading/trailing silence so the ground-truth boundaries are the speech itself
    loud = np.flatnonzero(np.abs(a) > 300)
    return a[loud[0]: loud[-1] + 1] if loud.size else a


async def main(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    clips = await asyncio.gather(*(
        tts(text, VOICES[spk], out_dir / f"u{i:02d}.mp3") for i, (spk, _, _, text) in enumerate(SCRIPT)
    ))
    parts = [np.zeros(int(LEAD_S * SR), np.int16)]
    t = LEAD_S
    truth = []
    for i, ((spk, lang, gap, text), clip) in enumerate(zip(SCRIPT, clips)):
        if i:
            parts.append(np.zeros(int(gap * SR), np.int16))
            t += int(gap * SR) / SR
        start = t
        parts.append(clip)
        t += len(clip) / SR
        truth.append({"i": i, "speaker": spk, "lang": lang, "text": text,
                      "start": round(start, 3), "end": round(t, 3), "handover": gap < 0.5 and i > 0})
    parts.append(np.zeros(int(TAIL_S * SR), np.int16))
    audio = np.concatenate(parts)
    with wave.open(str(out_dir / "meeting.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(audio.tobytes())
    (out_dir / "meeting.json").write_text(json.dumps(
        {"sample_rate": SR, "duration": round(len(audio) / SR, 3), "voices": VOICES, "utterances": truth},
        ensure_ascii=False, indent=1))
    print(f"{out_dir / 'meeting.wav'}: {len(audio) / SR:.1f} s, {len(truth)} utterances")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1] if len(sys.argv) > 1 else "meeting_audio")))
