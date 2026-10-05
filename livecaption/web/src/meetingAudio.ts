/**
 * Capture the audio the OTHER meeting participants produce (system or tab audio).
 *
 * Browsers only expose it through screen sharing (getDisplayMedia). What the user can
 * pick depends on OS/browser; `captureHint()` tells them which option to choose.
 * The video track is required by the API; we stop it right away and keep the audio.
 */

export type Platform = "windows" | "mac" | "linux" | "other";

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

export function captureHint(p: Platform = platform()): string {
  switch (p) {
    case "windows":
      return "在弹窗里选「整个屏幕」，并勾选左下角「同时共享系统音频」。腾讯会议客户端、网页版都能收到。";
    case "mac":
      return "腾讯会议/Zoom 用网页版打开时：选「Chrome 标签页」→ 选会议所在标签页 → 打开「同时共享标签页音频」。若你的 Chrome 选整个屏幕时出现「共享系统音频」开关，也可以直接用客户端。";
    default:
      return "在弹窗里选择会议所在的标签页或屏幕，并打开音频共享开关。";
  }
}

export class NoAudioSelected extends Error {
  constructor() {
    super("没有选到声音：请重新选择，并打开弹窗里的「共享音频」开关。");
  }
}

export async function captureMeetingAudio(): Promise<MediaStreamTrack> {
  const fake = fakeMeetingAudio();
  if (fake) return fake;
  const opts = {
    video: true, // mandatory for getDisplayMedia; stopped below
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false, // the user must still hear the meeting
    },
    systemAudio: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  } as unknown as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(opts);
  const [audio] = stream.getAudioTracks();
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!audio) {
    stream.getTracks().forEach((t) => t.stop());
    throw new NoAudioSelected();
  }
  return audio;
}

/** Test hook (`#/me?lcTest=1`): a synthetic tone instead of a real screen-share prompt. */
function fakeMeetingAudio(): MediaStreamTrack | null {
  if (!/[?&]lcTest=1/.test(window.location.hash + window.location.search)) return null;
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const dest = ctx.createMediaStreamDestination();
  osc.frequency.value = 220;
  osc.connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0];
}
