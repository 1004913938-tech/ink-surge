/**
 * Capture the audio the OTHER meeting participants produce (system, app or tab audio).
 *
 * Browsers only expose it through screen sharing (getDisplayMedia), and only Chromium
 * (Chrome / Edge) returns an audio track at all. What the user can pick depends on the
 * OS (research 2026-10, ARCHITECTURE.md §3a):
 *   Windows 10/11 Chrome 74+  : Entire screen + "Also share system audio"
 *   Windows 11   Chrome 146+  : a single app window + "Also share application audio"
 *   macOS 14.2+  Chrome 141+  : Entire screen + "Also share system audio"
 *   macOS 14.2+  Chrome 150+  : a single app window + "Also share application audio"
 *   any OS                    : a browser TAB + "Also share tab audio" (web meetings)
 * The video track is mandatory in the API; we keep it alive at 1 fps but never publish it
 * (stopping it can end the audio on some capture types).
 */

export type Platform = "windows" | "mac" | "linux" | "other";

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

function chromiumMajor(): number | null {
  const m = navigator.userAgent.match(/(?:Chrome|Chromium|Edg)\/(\d+)/);
  return m && !/Firefox|FxiOS/.test(navigator.userAgent) ? Number(m[1]) : null;
}

/** null when supported; otherwise a user-facing reason (shown before they start). */
export function unsupportedReason(): string | null {
  const v = chromiumMajor();
  if (v === null) return "请用电脑版 Chrome 或 Edge 打开本页：Safari / Firefox 无法获取会议声音。";
  if (platform() === "mac" && v < 141) return "Mac 上需要 Chrome 141 或更新版本（并且 macOS 14.2+）才能获取会议声音，请先升级 Chrome。";
  return null;
}

export function captureHint(p: Platform = platform()): string {
  switch (p) {
    case "windows":
      return "弹窗里选「整个屏幕」并打开「同时共享系统音频」；或选腾讯会议 / Zoom 的窗口并打开「同时共享应用音频」。用网页版开会时，选会议所在的标签页并打开「同时共享标签页音频」。";
    case "mac":
      return "弹窗里选「整个屏幕」并打开「同时共享系统音频」（需要 macOS 14.2+，第一次会让你在系统设置里允许 Chrome「录制屏幕和系统录音」）。用网页版开会时，选会议所在的标签页并打开「同时共享标签页音频」。";
    default:
      return "弹窗里选择会议所在的标签页，并打开「同时共享标签页音频」。";
  }
}

export class NoAudioSelected extends Error {
  constructor(reason = "没有选到声音：请重新选择，并打开弹窗里的「共享音频」开关。") {
    super(reason);
  }
}

export interface MeetingCapture {
  audio: MediaStreamTrack;
  stop(): void;
}

export async function captureMeetingAudio(): Promise<MeetingCapture> {
  const fake = fakeMeetingAudio();
  if (fake) return { audio: fake, stop: () => fake.stop() };
  const opts = {
    video: { frameRate: 1, width: { max: 640 } }, // mandatory; kept alive, never published
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false, // the user must still hear the meeting
      restrictOwnAudio: true,            // never capture this page's own audio (Win11 / macOS 14.2+)
    },
    systemAudio: "include",
    windowAudio: "window", // offer "share application audio" for the meeting app window
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    monitorTypeSurfaces: "include",
  } as unknown as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(opts);
  const [audio] = stream.getAudioTracks();
  const stopAll = () => stream.getTracks().forEach((t) => t.stop());
  if (!audio) {
    stopAll();
    throw new NoAudioSelected();
  }
  if (audio.readyState !== "live") {
    // macOS: Chrome resolves with an already-ended track when the OS denied audio capture.
    stopAll();
    throw new NoAudioSelected(
      platform() === "mac"
        ? "系统没有允许 Chrome 录制声音：打开「系统设置 → 隐私与安全性 → 录屏与系统录音」，允许 Chrome 后重启 Chrome 再试。"
        : "拿到的声音已中断，请重新选择。",
    );
  }
  // When the user clicks the browser's "Stop sharing", end everything together.
  for (const t of stream.getTracks()) t.addEventListener("ended", stopAll);
  return { audio, stop: stopAll };
}

/** Mic constraints: loopback echo cancellation removes the meeting audio the speakers play
 *  (Chrome 141+ on Windows 11 / macOS 14.2+); elsewhere falls back to normal AEC. */
export const MIC_CONSTRAINTS = {
  echoCancellation: { ideal: "all" },
  noiseSuppression: true,
  autoGainControl: true,
} as unknown as MediaTrackConstraints;

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
