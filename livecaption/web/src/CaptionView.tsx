import type { Line } from "./captions";
import { LANG_LABEL } from "./api";

/**
 * Renders lines as: speaker • source text, then one row per target language.
 * `langs` controls which translations are shown (host: all; listener: chosen).
 * Translation state is visible but unobtrusive (… pending, ⚠ failed/skipped).
 */
export function CaptionView({ lines, langs, big, showSource = true }: {
  lines: Line[]; langs: string[]; big?: boolean; showSource?: boolean;
}) {
  return (
    <div className={"captions" + (big ? " big" : "")}>
      {lines.map((l) => (
        <div key={l.sid} className={"line" + (l.final ? "" : " interim")}>
          <div className="meta">{l.speakerName}</div>
          {showSource && <div className="src">{l.text}</div>}
          {langs.map((lang) => {
            const txt = l.tr[lang];
            return (
              <div key={lang} className={"tr" + (txt ? "" : " waiting")}>
                <span className="lang">{LANG_LABEL[lang] ?? lang}</span>
                {txt ?? (l.final ? statusGlyph(l.trStatus) : "")}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function statusGlyph(s: Line["trStatus"]): string {
  switch (s) {
    case "pending": return "…";
    case "failed": return "⚠ 翻译失败";
    case "skipped": return "⚠ 翻译暂停";
    default: return "";
  }
}
