/** Per-user speaker display: stable colours and local renames ("说话人 2" -> "Budi"). */

const PALETTE = ["#4f8cff", "#22c55e", "#f59e0b", "#ec4899", "#a855f7", "#14b8a6", "#ef4444", "#84cc16"];

export function speakerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export class SpeakerNames {
  private map: Record<string, string>;
  constructor(private key: string) {
    try {
      this.map = JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      this.map = {};
    }
  }
  name(id: string, fallback: string): string {
    return this.map[id] || fallback;
  }
  rename(id: string, name: string): void {
    const n = name.trim();
    if (n) this.map[id] = n;
    else delete this.map[id];
    try {
      localStorage.setItem(this.key, JSON.stringify(this.map));
    } catch {
      /* private mode: keep in memory */
    }
  }
}
