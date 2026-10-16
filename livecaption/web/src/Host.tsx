import QRCode from "qrcode";
import { useEffect, useState } from "react";

import { CaptionView } from "./CaptionView";
import { createSession, endSession, LANG_LABEL, type HostSession } from "./api";
import { useCaptionRoom } from "./useRoom";

const ALL_LANGS = Object.keys(LANG_LABEL);

export function Host() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("lc.apiKey") ?? "");
  const [hostName, setHostName] = useState("主持人");
  const [title, setTitle] = useState("会议");
  const [srcLang, setSrcLang] = useState("zh");
  const [targets, setTargets] = useState<string[]>(["en", "id"]);
  const [session, setSession] = useState<HostSession | null>(null);
  const [qr, setQr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(false);

  const { store, state, error, setMic } = useCaptionRoom(
    session?.livekit_url ?? null, session?.host_token ?? null, { mic: true },
  );

  useEffect(() => {
    if (session?.join_url) QRCode.toDataURL(session.join_url, { width: 240, margin: 1 }).then(setQr);
  }, [session]);

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      localStorage.setItem("lc.apiKey", apiKey);
      setSession(await createSession(apiKey, { title, host_name: hostName, src_lang: srcLang, targets }));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!session) return;
    await setMic(false);
    await endSession(apiKey, session.session_id).catch(() => {});
    setSession(null);
  };

  // recomputed every render: the store mutates in place and renders are rAF-throttled
  const lines = store.lines().slice(-6);

  if (session && overlay) {
    // Desktop "subtitle bar": put this window on top of the meeting app.
    return (
      <div className="overlay" onDoubleClick={() => setOverlay(false)} title="双击退出字幕模式">
        <CaptionView lines={lines.slice(-2)} langs={session.targets} big />
      </div>
    );
  }

  return (
    <div className="page">
      <h1>LiveCaption <small>主持人控制台</small></h1>
      {!session ? (
        <form className="card" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <label>API Key<input value={apiKey} onChange={(e) => setApiKey(e.target.value)} required placeholder="lc_…" /></label>
          <label>会议名<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label>我的名字<input value={hostName} onChange={(e) => setHostName(e.target.value)} /></label>
          <label>我说的语言
            <select value={srcLang} onChange={(e) => setSrcLang(e.target.value)}>
              {ALL_LANGS.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
            </select>
          </label>
          <fieldset><legend>桌面同时显示的译文</legend>
            {ALL_LANGS.filter((l) => l !== srcLang).map((l) => (
              <label key={l} className="inline">
                <input type="checkbox" checked={targets.includes(l)}
                  onChange={(e) => setTargets(e.target.checked ? [...targets, l] : targets.filter((x) => x !== l))} />
                {LANG_LABEL[l]}
              </label>
            ))}
          </fieldset>
          <button disabled={busy || !apiKey}>{busy ? "正在创建…" : "开始会议"}</button>
          {err && <p className="err">{err}</p>}
          {store.status && <p className="err">⚠ {store.status.msg || store.status.code}</p>}
        </form>
      ) : (
        <>
          <div className="card row">
            <div>
              <div className="code">入会码 <b>{session.join_code}</b></div>
              <div className="small">{session.join_url}</div>
              <div className="small">连接：{state}{error ? ` — ${error}` : ""}</div>
              <div className="actions">
                <button onClick={() => setOverlay(true)}>桌面字幕模式</button>
                <button className="danger" onClick={stop}>结束会议</button>
              </div>
            </div>
            {qr && <img src={qr} alt="扫码看字幕" width={160} height={160} />}
          </div>
          <CaptionView lines={lines} langs={session.targets} />
        </>
      )}
    </div>
  );
}
