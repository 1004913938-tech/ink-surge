import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Document Picture-in-Picture: a small always-on-top window that can float above the
 * meeting app (Chrome / Edge 116+ desktop). We render React into it with a portal and
 * copy our stylesheets over.
 */

interface DocumentPiP {
  requestWindow(opts?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  window: Window | null;
}

function api(): DocumentPiP | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture ?? null;
}

export function pipSupported(): boolean {
  return api() !== null;
}

function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
      const style = target.createElement("style");
      style.textContent = css;
      target.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
}

/** Must be called from a click handler (user activation). */
export async function openPip(width = 560, height = 240): Promise<Window> {
  const p = api();
  if (!p) throw new Error("当前浏览器不支持悬浮窗（需要桌面版 Chrome / Edge 116+）");
  if (p.window) return p.window;
  const w = await p.requestWindow({ width, height });
  copyStyles(w.document);
  w.document.body.className = "pip-body";
  return w;
}

export function PipPortal({ win, onClose, children }: { win: Window; onClose: () => void; children: ReactNode }) {
  const [, force] = useState(0);
  useEffect(() => {
    const closed = () => onClose();
    win.addEventListener("pagehide", closed);
    force((n) => n + 1);
    return () => win.removeEventListener("pagehide", closed);
  }, [win, onClose]);
  return createPortal(children, win.document.body);
}
