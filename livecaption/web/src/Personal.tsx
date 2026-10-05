import { useCallback, useMemo, useRef, useState } from "react";

import { CaptionView } from "./CaptionView";
import { createSession, endSession, LANG_LABEL, type HostSession } from "./api";
import type { Line } from "./captions";
import { captureHint, captureMeetingAudio } from "./meetingAudio";
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
  const [meetingTrack, setMeetingTrack] = useState<MediaStreamTrack | null>(null);
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const [, bump] = useState(0);
  const namesRef = useRef<SpeakerNames | null>(null);

  const { store, state, error, publishMeetingAudio, stopMeetingAudio } = useCaptionRoom(
    session?.livekit_url ?? null, session?.host_token ?? null, { mic: withMic },
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

  const listen = async () => {
    setErr(null);
    try {
      const track = await captureMeetingAudio();
      track.addEventListener("ended", () => setMeetingTrack(null)); // user clicked "stop sharing"
      await publishMeetingAudio(track);
      setMeetingTrack(track);
    } catch (e) {
      const msg = (e as Error).name === "NotAllowedError" ? "你取消了共享。再点一次并选择会议声音即可。" : String((e as Error).message ?? e);
      setErr(msg);
    }
  };

  const stopListening = async () => {
    if (!meetingTrack) return;
    await stopMeetingAudio(meetingTrack).catch(() => {});
    meetingTrack.stop();
    setMeetingTrack(null);
  };

  const stop = async () => {
    await stopListening();
    pipWin?.close();
    if (session) await endSession(apiKey, session.session_id).catch(() => {});
    setSession(null);
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

  const lines = useMemo(() => store.lines().slice(-30), [store, state, store.size()]); // eslint-disable-line react-hooks/exhaustive-deps
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
              {REMOTE_LANGS.map((l) => <option key={l} value={l}>{l === "auto" ? "自动识别（多语混说）" : LANG_LABEL[l]}</option>)}
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
            也显示我自己说的话（请戴耳机，否则会重复）
          </label>
          {withMic && (
            <label>我说的语言
              <select value={myLang} onChange={(e) => setMyLang(e.target.value)}>
                {READ_LANGS.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
              </select>
            </label>
          )}
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
        {!meetingTrack ? (
          <>
            <div><b>第 1 步：</b>先在腾讯会议 / Zoom 里入会，然后点下面的按钮，选择会议的声音。</div>
            <div className="small">{captureHint()}</div>
            <div className="actions"><button onClick={listen} disabled={state !== "connected"}>选择会议声音</button></div>
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
