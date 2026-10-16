/** Per-user speaker display: stable colours and local renames ("说话人 2" -> "Budi"). */

const PALETTE = ["#4f8cff", "#22c55e", "#f59e0b", "#ec4899", "#a855f7", "#14b8a6", "#ef4444", "#84cc16"];
const UNATTRIBUTED = "#6b7280";
const assigned = new Map<string, string>();

/** Colours by order of first appearance, so the first 8 speakers never share a colour.
 *  The unattributed placeholder ("会议声音", id ending in ":meeting") stays grey. */
export function speakerColor(id: string): string {
  if (id.endsWith(":meeting")) return UNATTRIBUTED;
  let c = assigned.get(id);
  if (!c) {
    c = PALETTE[assigned.size % PALETTE.length];
    assigned.set(id, c);
  }
  return c;
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
