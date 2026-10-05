import type { Line } from "./captions";
import { LANG_LABEL } from "./api";
import { speakerColor } from "./speakers";

/**
 * Renders lines as: speaker • source text, then one row per target language.
 * `langs` controls which translations are shown (host: all; listener: chosen).
 * A translation row is skipped when the line is already in that language.
 * Translation state is visible but unobtrusive (… pending, ⚠ failed/skipped).
 */
export function CaptionView({ lines, langs, big, showSource = true, nameOf, onRename, compact }: {
  lines: Line[];
  langs: string[];
  big?: boolean;
  showSource?: boolean;
  nameOf?: (l: Line) => string;
  onRename?: (l: Line) => void;
  compact?: boolean;
}) {
  return (
    <div className={"captions" + (big ? " big" : "") + (compact ? " compact" : "")}>
      {lines.map((l) => {
        const color = speakerColor(l.speakerId);
        const rows = langs.filter((lang) => lang !== l.srcLang);
        return (
          <div key={l.sid} className={"line" + (l.final ? "" : " interim")} style={{ borderLeftColor: color }}>
            <div className="meta">
              <span
                className={"who" + (onRename ? " editable" : "")}
                style={{ color }}
                onClick={onRename ? () => onRename(l) : undefined}
                title={onRename ? "点击改名" : undefined}
              >
                {nameOf ? nameOf(l) : l.speakerName}
              </span>
              {l.srcLang && l.srcLang !== "auto" && <span className="srclang">{LANG_LABEL[l.srcLang] ?? l.srcLang}</span>}
            </div>
            {(showSource || rows.length === 0) && <div className="src">{l.text}</div>}
            {rows.map((lang) => {
              const txt = l.tr[lang];
              return (
                <div key={lang} className={"tr" + (txt ? "" : " waiting")}>
                  {langs.length > 1 && <span className="lang">{LANG_LABEL[lang] ?? lang}</span>}
                  {txt ?? (l.final ? statusGlyph(l.trStatus) : "")}
                </div>
              );
            })}
          </div>
        );
      })}
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
