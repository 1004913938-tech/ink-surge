/**
 * Caption store: makes rendering idempotent and order-stable.
 *
 * Rules (ARCHITECTURE.md §3.5): group by speaker, sort by seq, merge by sid
 * (later message for the same sid overwrites), `reset` clears everything.
 * Delivery order and duplicates do not matter.
 */

export type TrStatus = "ok" | "pending" | "failed" | "late" | "skipped";

export interface CaptionMsg {
  v: number;
  kind: "interim" | "final" | "patch" | "reset";
  sid: string;
  seq: number;
  t: number;
  spk?: { id: string; name: string };
  src?: { lang: string; text: string };
  tr?: Record<string, string>;
  tr_status?: TrStatus;
}

export interface Line {
  sid: string;
  seq: number;
  speakerId: string;
  speakerName: string;
  srcLang: string;
  text: string;
  final: boolean;
  tr: Record<string, string>;
  trStatus: TrStatus;
  t: number;
}

export class CaptionStore {
  private bySid = new Map<string, Line>();
  private order: string[] = []; // sids in first-seen order (cheap recency)
  readonly maxLines: number;

  constructor(maxLines = 200) {
    this.maxLines = maxLines;
  }

  apply(msg: CaptionMsg): void {
    if (msg.kind === "reset") {
      this.bySid.clear();
      this.order = [];
      return;
    }
    const existing = this.bySid.get(msg.sid);
    if (msg.kind === "patch") {
      if (!existing) return; // patch for a line we never saw (joined late): ignore
      existing.tr = { ...existing.tr, ...(msg.tr ?? {}) };
      existing.trStatus = msg.tr_status ?? "ok";
      return;
    }
    if (!msg.spk || !msg.src) return;
    if (existing) {
      // A final may arrive after a patch? No (patch follows final). But an interim
      // after final (stale) must not reopen a final line.
      if (existing.final && msg.kind === "interim") return;
      existing.text = msg.src.text;
      existing.final = existing.final || msg.kind === "final";
      if (msg.tr && Object.keys(msg.tr).length) existing.tr = { ...existing.tr, ...msg.tr };
      if (msg.tr_status) existing.trStatus = msg.tr_status;
      existing.t = msg.t;
      return;
    }
    this.bySid.set(msg.sid, {
      sid: msg.sid,
      seq: msg.seq,
      speakerId: msg.spk.id,
      speakerName: msg.spk.name,
      srcLang: msg.src.lang,
      text: msg.src.text,
      final: msg.kind === "final",
      tr: { ...(msg.tr ?? {}) },
      trStatus: msg.tr_status ?? "pending",
      t: msg.t,
    });
    this.order.push(msg.sid);
    while (this.order.length > this.maxLines) {
      const old = this.order.shift()!;
      this.bySid.delete(old);
    }
  }

  /** Timeline view: all lines, ordered by (speaker arrival, seq) within interleaving by time. */
  lines(): Line[] {
    const all = Array.from(this.bySid.values());
    // Primary: time of first appearance (t of the message that created it) so a
    // conversation reads top-to-bottom; tie-break by speaker then seq. Within one
    // speaker seq is monotonic, so this never shows a speaker's lines out of order.
    all.sort((a, b) => a.t - b.t || a.speakerId.localeCompare(b.speakerId) || a.seq - b.seq);
    return all;
  }

  /** Per-speaker view: latest N lines of each speaker, strictly by seq. */
  bySpeaker(limit = 3): Map<string, Line[]> {
    const m = new Map<string, Line[]>();
    for (const l of this.bySid.values()) {
      const arr = m.get(l.speakerId) ?? [];
      arr.push(l);
      m.set(l.speakerId, arr);
    }
    for (const [k, arr] of m) {
      arr.sort((a, b) => a.seq - b.seq);
      m.set(k, arr.slice(-limit));
    }
    return m;
  }

  size(): number {
    return this.bySid.size;
  }
}

export function parseCaption(raw: string): CaptionMsg | null {
  try {
    const m = JSON.parse(raw);
    if (m && m.v === 1 && typeof m.kind === "string") return m as CaptionMsg;
  } catch {
    /* ignore malformed */
  }
  return null;
}
