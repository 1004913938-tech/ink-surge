import { Room, RoomEvent, Track, type AudioCaptureOptions } from "livekit-client";
import { useEffect, useRef, useState } from "react";

import { CaptionStore, parseCaption } from "./captions";

export const CAPTION_TOPIC = "lc.caption";

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

/**
 * Connects to a LiveKit room, feeds caption text streams into a CaptionStore and
 * re-renders on every message (throttled to animation frames).
 */
export function useCaptionRoom(
  url: string | null,
  token: string | null,
  opts: { mic?: boolean; micOptions?: MediaTrackConstraints; langs?: string[] } = {},
) {
  const storeRef = useRef(new CaptionStore());
  const roomRef = useRef<Room | null>(null);
  const [state, setState] = useState<ConnState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!url || !token) return;
    const room = new Room({ adaptiveStream: false, dynacast: false });
    roomRef.current = room;
    let raf = 0;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; bump((n) => n + 1); });
    };

    room.registerTextStreamHandler(CAPTION_TOPIC, async (reader) => {
      const text = await reader.readAll();
      const msg = parseCaption(text);
      if (msg) { storeRef.current.apply(msg); schedule(); }
    });
    room.on(RoomEvent.Connected, () => { setError(null); setState("connected"); });
    room.on(RoomEvent.Reconnecting, () => setState("reconnecting"));
    room.on(RoomEvent.Reconnected, () => { setError(null); setState("connected"); });
    room.on(RoomEvent.Disconnected, () => setState("disconnected"));

    setState("connecting");
    setError(null);
    setMicError(null);
    let disposed = false;
    (async () => {
      try {
        await room.connect(url, token);
        if (opts.langs) await room.localParticipant.setAttributes({ "lc.langs": opts.langs.join(",") });
      } catch (e) {
        if (!disposed) { setError(String(e)); setState("error"); }
        return;
      }
      if (opts.mic) {
        try {
          await room.localParticipant.setMicrophoneEnabled(true, opts.micOptions as AudioCaptureOptions | undefined);
        } catch (e) {
          // The mic is optional (personal mode) — report it, keep the room usable.
          if (!disposed) setMicError(String((e as Error).message ?? e));
        }
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      room.unregisterTextStreamHandler(CAPTION_TOPIC);
      room.disconnect();
      roomRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token]);

  const setLangs = async (langs: string[]) => {
    await roomRef.current?.localParticipant.setAttributes({ "lc.langs": langs.join(",") });
  };
  const setMic = async (on: boolean) => {
    await roomRef.current?.localParticipant.setMicrophoneEnabled(on);
  };
  /** Personal mode: publish the meeting's captured system/tab audio for diarized captions. */
  const publishMeetingAudio = async (track: MediaStreamTrack) => {
    const room = roomRef.current;
    if (!room) throw new Error("not connected");
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShareAudio,
      name: "meeting-audio",
      dtx: false, // keep sending during quiet stretches; the STT needs continuous audio
    });
  };
  const stopMeetingAudio = async (track: MediaStreamTrack) => {
    await roomRef.current?.localParticipant.unpublishTrack(track, true);
  };

  return { store: storeRef.current, state, error, micError, setLangs, setMic, publishMeetingAudio, stopMeetingAudio };
}
