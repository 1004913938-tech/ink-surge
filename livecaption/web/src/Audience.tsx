import { useEffect, useMemo, useState } from "react";

import { CaptionView } from "./CaptionView";
import { joinSession, LANG_LABEL, type JoinInfo } from "./api";
import { useCaptionRoom } from "./useRoom";

export function Audience({ code }: { code: string }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [langs, setLangs] = useState<string[]>(() => {
    const saved = localStorage.getItem("lc.langs");
    return saved ? saved.split(",") : [];
  });
  const [showSource, setShowSource] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    joinSession(code, langs.length ? langs : ["en"]).then((j) => {
      setInfo(j);
      if (!langs.length) setLangs([j.targets[0] ?? "en"]);
    }).catch((e) => setErr(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const { store, state, error, setLangs: pushLangs } = useCaptionRoom(
    info?.livekit_url ?? null, info?.token ?? null, { langs },
  );

  const toggle = (l: string) => {
    const next = langs.includes(l) ? langs.filter((x) => x !== l) : [...langs, l];
    setLangs(next);
    localStorage.setItem("lc.langs", next.join(","));
    pushLangs(next).catch(() => {});
  };

  const lines = useMemo(() => store.lines().slice(-8), [store, state, store.size()]);
  const choices = useMemo(() => {
    const base = new Set([...(info?.targets ?? []), ...langs, "en", "id", "zh", "ja", "ko", "th", "vi", "ms"]);
    base.delete(info?.src_lang ?? "");
    return Array.from(base);
  }, [info, langs]);

  if (err) return <div className="page"><p className="err">{err}</p></div>;
  if (!info) return <div className="page"><p>正在加入 {code}…</p></div>;

  return (
    <div className="page audience">
      <header>
        <strong>{info.title}</strong>
        <span className={"dot " + state} title={error ?? state} />
      </header>
      <div className="langbar">
        {choices.map((l) => (
          <button key={l} className={langs.includes(l) ? "on" : ""} onClick={() => toggle(l)}>{LANG_LABEL[l] ?? l}</button>
        ))}
        <button className={showSource ? "on" : ""} onClick={() => setShowSource(!showSource)}>原文</button>
      </div>
      <CaptionView lines={lines} langs={langs} showSource={showSource} />
    </div>
  );
}
