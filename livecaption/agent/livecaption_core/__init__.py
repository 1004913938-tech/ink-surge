"""Pure caption-pipeline logic: no network, no LiveKit. Everything here is unit-testable.

Data flow:  STT events --> SpeakerLane (per speaker, ordered segments)
                        --> CaptionSession (language demand, fan-out)
                        --> TranslationHub (dedupe, limits, in-order release)
                        --> Broadcaster (throttle) --> Sink (LiveKit / memory)
"""

from .models import Caption, Segment, SpeakerInfo
from .session import CaptionSession, SessionConfig
from .translate import (
    CircuitOpen,
    FakeTranslator,
    TranslationHub,
    TranslationHubConfig,
    Translator,
)
from .broadcast import Broadcaster, MemorySink, Sink

__all__ = [
    "Broadcaster",
    "Caption",
    "CaptionSession",
    "CircuitOpen",
    "FakeTranslator",
    "MemorySink",
    "Segment",
    "SessionConfig",
    "Sink",
    "SpeakerInfo",
    "TranslationHub",
    "TranslationHubConfig",
    "Translator",
]
