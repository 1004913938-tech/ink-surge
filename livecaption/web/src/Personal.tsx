import { useCallback, useEffect, useRef, useState } from "react";

import { CaptionView } from "./CaptionView";
import { createSession, endSession, LANG_LABEL, serverConfig, type HostSession, type ServerConfig } from "./api";
import type { Line } from "./captions";
import { captureFromDevice, captureHint, captureMeetingAudio, listAudioInputs, looksLikeLoopback, MIC_CONSTRAINTS, unsupportedReason, type MeetingCapture } from "./meetingAudio";
import { openPip, PipPortal, pipSupported } from "./pip";
import { SpeakerNames } from "./speakers";
import { useCaptionRoom } from "./useRoom";

const READ_LANGS = ["zh", "en", "id", "ja", "ko", "th", "vi", "ms"];
const REMOTE_LANGS = ["auto", "id", "en", "zh", "ja", "ko", "th", "vi", "ms"];

/**
 * Personal mode (#/me): I join an online meeting in Tencent Meeting / Zoom / Teams;
 * this page listens to the meeting audio, separates the speakers and shows translated
 * captions only to me. Nobody else can join this session.
 */
export function Personal() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("lc.apiKey") ?? "");
  const [myLang, setMyLang] = useState(() => localStorage.getItem("lc.myLang") ?? "zh");
  const [remoteLang, setRemoteLang] = useState(() => localStorage.getItem("lc.remoteLang") ?? "auto");
  const [readLangs, setReadLangs] = useState<string[]>(() => (localStorage.getItem("lc.readLangs") ?? "zh").split(","));
  const [withMic, setWithMic] = useState(false);
  const [session, setSession] = useState<HostSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [capture, setCapture] = useState<MeetingCapture | null>(null);
  const unsupported = unsupportedReason();
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const [, bump] = useState(0);
  const namesRef = useRef<SpeakerNames | null>(null);
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  useEffect(() => {
    serverConfig().then((c) => {
      setCfg(c);
      // e.g. Deepgram cannot auto-detect zh/id: pre-select a concrete language instead
      if (!c.auto_lang) setRemoteLang((v) => (v === "auto" ? "id" : v));
    }).catch(() => {});
  }, []);

  const { store, state, error, micError, publishMeetingAudio, stopMeetingAudio } = useCaptionRoom(
    session?.livekit_url ?? null, session?.host_token ?? null, { mic: withMic, micOptions: MIC_CONSTRAINTS },
  );

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      localStorage.setItem("lc.apiKey", apiKey);
      localStorage.setItem("lc.myLang", myLang);
      localStorage.setItem("lc.remoteLang", remoteLang);
      localStorage.setItem("lc.readLangs", readLangs.join(","));
      const s = await createSession(apiKey, {
        title: "个人字幕", host_name: "我", src_lang: myLang, targets: readLangs,
        mode: "personal", remote_lang: remoteLang,
      });
      namesRef.current = new SpeakerNames(`lc.names.${s.room}`);
      setSession(s);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const showDevices = async () => {
    try { setDevices(await listAudioInputs()); } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  const listen = async (deviceId?: string) => {
    setErr(null);
    try {
      const cap = deviceId ? await captureFromDevice(deviceId) : await captureMeetingAudio();
      cap.audio.addEventListener("ended", () => setCapture(null)); // user clicked "stop sharing"
      await publishMeetingAudio(cap.audio);
      setCapture(cap);
    } catch (e) {
      const msg = (e as Error).name === "NotAllowedError" ? "你取消了共享。再点一次并选择会议声音即可。" : String((e as Error).message ?? e);
      setErr(msg);
    }
  };

  const stopListening = async () => {
    if (!capture) return;
    await stopMeetingAudio(capture.audio).catch(() => {});
    capture.stop();
    setCapture(null);
  };

  const stop = async () => {
    await stopListening();
    pipWin?.close();
    if (session) await endSession(apiKey, session.session_id).catch(() => {});
    setSession(null);
  };

  // LiveKit stops the published track on disconnect WITHOUT firing 'ended'; release the
  // screen capture ourselves so Chrome's sharing bar goes away and the UI tells the truth.
  const captureRef = useRef<MeetingCapture | null>(null);
  captureRef.current = capture;
  const pipRef = useRef<Window | null>(null);
  pipRef.current = pipWin;
  useEffect(() => {
    if (state === "disconnected" || state === "error") {
      captureRef.current?.stop();
      setCapture(null);
    }
  }, [state]);
  useEffect(() => () => { captureRef.current?.stop(); pipRef.current?.close(); }, []);

  const restart = async () => {
    captureRef.current?.stop();
    setCapture(null);
    pipWin?.close();
    setSession(null);
    await start();
  };

  const float = async () => {
    try { setPipWin(await openPip()); } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  const closePip = useCallback(() => setPipWin(null), []);

  const nameOf = (l: Line) => namesRef.current?.name(l.speakerId, l.speakerName) ?? l.speakerName;
  const rename = (l: Line) => {
    const n = window.prompt(`给「${nameOf(l)}」改个名字（只有你看得到）`, nameOf(l));
    if (n !== null && namesRef.current) { namesRef.current.rename(l.speakerId, n); bump((x) => x + 1); }
  };

  // recomputed every render: the store mutates in place and renders are rAF-throttled
  const lines = store.lines().slice(-30);
  const latest = lines.slice(-3);

  const toggleRead = (l: string) =>
    setReadLangs(readLangs.includes(l) ? readLangs.filter((x) => x !== l) : [...readLangs, l]);

  if (!session) {
    return (
      <div className="page">
        <h1>LiveCaption <small>个人会议字幕 · 只有你看得到</small></h1>
        <form className="card" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <label>API Key<input value={apiKey} onChange={(e) => setApiKey(e.target.value)} required placeholder="lc_…" /></label>
          <label>对方说的语言
            <select value={remoteLang} onChange={(e) => setRemoteLang(e.target.value)}>
              {REMOTE_LANGS.map((l) => (
                <option key={l} value={l} disabled={l === "auto" && cfg?.auto_lang === false}>
                  {l === "auto" ? (cfg?.auto_lang === false ? "自动识别（当前识别服务不支持，需要 Soniox）" : "自动识别（多语混说）") : LANG_LABEL[l]}
                </option>
              ))}
            </select>
          </label>
          <fieldset><legend>字幕翻译成</legend>
            {READ_LANGS.map((l) => (
              <label key={l} className="inline">
                <input type="checkbox" checked={readLangs.includes(l)} onChange={() => toggleRead(l)} />{LANG_LABEL[l]}
              </label>
            ))}
          </fieldset>
          <label className="inline">
            <input type="checkbox" checked={withMic} onChange={(e) => setWithMic(e.target.checked)} />
            也显示我自己说的话（建议戴耳机；Chrome 141+ 会自动消除外放的会议声音）
          </label>
          {withMic && (
            <label>我说的语言
              <select value={myLang} onChange={(e) => setMyLang(e.target.value)}>
                {READ_LANGS.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
              </select>
            </label>
          )}
          {unsupported && <p className="small warn">{unsupported}</p>}
          <button disabled={busy || !apiKey || readLangs.length === 0}>{busy ? "正在准备…" : "开始"}</button>
          {err && <p className="err">{err}</p>}
        </form>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>LiveCaption <small>个人会议字幕 · 只有你看得到</small></h1>
      <div className="card">
        {!capture ? (
          <>
            <div><b>第 1 步：</b>先在腾讯会议 / Zoom 里入会，然后点下面的按钮，选择会议的声音。</div>
            <div className="small">{captureHint()}</div>
            <div className="actions">
              <button onClick={() => listen()} disabled={state !== "connected" || !!unsupported}>选择会议声音</button>
              <button className="ghost" onClick={showDevices} disabled={state !== "connected"}>高级：虚拟声卡</button>
            </div>
            {unsupported && <div className="small warn">{unsupported}</div>}
            {devices && (
              <div className="small">
                选择把电脑声音转成输入的设备（Mac：BlackHole；Windows：VB-CABLE 或「立体声混音」；Linux：Monitor of …）。
                需要先在系统里把会议声音输出到它。
                <div className="actions">
                  {devices.length === 0 && <span>没有找到输入设备。</span>}
                  {devices.map((d) => (
                    <button key={d.deviceId} className={looksLikeLoopback(d) ? "" : "ghost"} onClick={() => listen(d.deviceId)}>
                      {d.label || "未命名设备"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="row-inline">
            <span className="dot connected" /> 正在收听会议声音
            <div className="actions">
              {pipSupported() && !pipWin && <button onClick={float}>悬浮字幕窗</button>}
              <button className="ghost" onClick={stopListening}>暂停</button>
            </div>
          </div>
        )}
        <div className="small">连接：{state}{error ? ` — ${error}` : ""} · 点说话人名字可以改名</div>
        {(state === "disconnected" || state === "error") && (
          <div className="err">连接已断开，字幕已停止。<button onClick={restart}>重新开始</button></div>
        )}
        {micError && <div className="small warn">麦克风没有打开（{micError}），只显示会议里别人的话。</div>}
        {pipWin && <div className="small warn">提示：你在会议里共享屏幕时，悬浮字幕窗也会被别人看到。共享前请关闭它，或只共享某个窗口。</div>}
        {capture && !pipWin && pipSupported() && (
          <div className="small">Chrome 同时只允许一个画中画窗口：其他网页打开画中画（如 Google Meet）会关掉字幕悬浮窗，点「悬浮字幕窗」可重新打开。</div>
        )}
        <div className="actions"><button className="danger" onClick={stop}>结束</button></div>
        {err && <p className="err">{err}</p>}
      </div>
      <CaptionView lines={lines} langs={session.targets} nameOf={nameOf} onRename={rename} />
      {pipWin && (
        <PipPortal win={pipWin} onClose={closePip}>
          <CaptionView lines={latest} langs={session.targets} nameOf={nameOf} compact />
        </PipPortal>
      )}
    </div>
  );
}
