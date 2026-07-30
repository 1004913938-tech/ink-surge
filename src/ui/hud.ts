/**
 * PLACEHOLDER — owned by the presentation subsystem.
 *
 * Canvas-2D HUD drawn in the game's ink style. This version wires up the
 * plumbing (DPR-correct sizing, a draw call per frame, the data it needs) and
 * lays out the basics. The presentation agent replaces it with the designed
 * HUD: speedometer, lap counter, position, split times, boost meter, minimap.
 */

import { css, HEX } from '../core/palette';
import { formatTime, ordinal } from '../core/mathx';
import { CONFIG } from '../core/config';
import type { GameContext, HudAPI, TrackAPI } from '../core/types';

export class Hud implements HudAPI {
  private ctx2d: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  /** Cached minimap path in track space, rebuilt only on resize. */
  private minimapPath: Path2D | null = null;
  private mapBounds = { minX: 0, minZ: 0, scale: 1 };

  constructor(
    private canvas: HTMLCanvasElement,
    private track: TrackAPI,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('HUD: 2D context unavailable');
    this.ctx2d = c;
  }

  resize(width: number, height: number, dpr: number) {
    this.w = width;
    this.h = height;
    this.dpr = dpr;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.minimapPath = null;
  }

  private buildMinimap(size: number) {
    // Sample the spline once and normalise it into a square.
    const N = 220;
    const pts: { x: number; z: number }[] = [];
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
      const p = this.track.sample(i / N).position;
      pts.push({ x: p.x, z: p.z });
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ) || 1;
    const scale = (size * 0.86) / span;
    this.mapBounds = { minX, minZ, scale };

    const path = new Path2D();
    pts.forEach((p, i) => {
      const x = (p.x - minX) * scale + size * 0.07;
      const y = (p.z - minZ) * scale + size * 0.07;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    this.minimapPath = path;
  }

  render(ctx: GameContext) {
    const g = this.ctx2d;
    g.clearRect(0, 0, this.w, this.h);

    const p = ctx.player;
    const s = p.state;

    // ── Speed ──────────────────────────────────────────────────────────────
    const kmh = Math.abs(s.forwardSpeed) * 3.6;
    g.save();
    g.textAlign = 'right';
    g.fillStyle = css(HEX.hudPaper);
    g.strokeStyle = css(HEX.hudInk);
    g.lineWidth = 6;
    g.font = '700 66px ui-sans-serif, system-ui, sans-serif';
    const speedText = Math.round(kmh).toString();
    g.strokeText(speedText, this.w - 42, this.h - 46);
    g.fillText(speedText, this.w - 42, this.h - 46);
    g.font = '600 17px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = css(HEX.hudDim);
    g.fillText('KM/H', this.w - 44, this.h - 24);
    g.restore();

    // ── Lap / position ─────────────────────────────────────────────────────
    g.save();
    g.textAlign = 'left';
    g.fillStyle = css(HEX.hudPaper);
    g.strokeStyle = css(HEX.hudInk);
    g.lineWidth = 5;
    g.font = '700 34px ui-sans-serif, system-ui, sans-serif';
    const lapText = `LAP ${Math.min(p.lap + 1, CONFIG.race.laps)}/${CONFIG.race.laps}`;
    g.strokeText(lapText, 40, 58);
    g.fillText(lapText, 40, 58);

    g.font = '700 44px ui-sans-serif, system-ui, sans-serif';
    const posText = ordinal(p.place);
    g.strokeText(posText, 40, 108);
    g.fillText(posText, 40, 108);

    g.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = css(HEX.hudDim);
    g.fillText(formatTime(Math.max(0, ctx.race.raceTime)), 40, 142);
    g.restore();

    // ── Boost meter ────────────────────────────────────────────────────────
    const bw = 240,
      bh = 14;
    const bx = 40,
      by = this.h - 54;
    g.save();
    g.fillStyle = 'rgba(8,20,38,0.7)';
    g.fillRect(bx, by, bw, bh);
    const meter = s.boostTime > 0 ? 1 : s.boostMeter;
    g.fillStyle = s.boostTime > 0 ? css(HEX.boostHot) : css(HEX.boost);
    g.fillRect(bx, by, bw * meter, bh);
    g.strokeStyle = css(HEX.hudInk);
    g.lineWidth = 3;
    g.strokeRect(bx, by, bw, bh);
    g.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = css(HEX.hudPaper);
    g.fillText('BOOST', bx, by - 8);
    g.restore();

    // ── Minimap ────────────────────────────────────────────────────────────
    const mapSize = 190;
    const mx = this.w - mapSize - 34,
      my = 34;
    if (!this.minimapPath) this.buildMinimap(mapSize);
    g.save();
    g.translate(mx, my);
    g.fillStyle = 'rgba(8,20,38,0.55)';
    g.fillRect(0, 0, mapSize, mapSize);
    g.strokeStyle = css(HEX.hudInk);
    g.lineWidth = 3;
    g.strokeRect(0, 0, mapSize, mapSize);
    if (this.minimapPath) {
      g.strokeStyle = css(HEX.raceLine);
      g.lineWidth = 2.5;
      g.stroke(this.minimapPath);
    }
    const { minX, minZ, scale } = this.mapBounds;
    for (const r of ctx.racers) {
      const x = (r.root.position.x - minX) * scale + mapSize * 0.07;
      const y = (r.root.position.z - minZ) * scale + mapSize * 0.07;
      g.beginPath();
      g.arc(x, y, r.isPlayer ? 5.5 : 4, 0, Math.PI * 2);
      g.fillStyle = css([HEX.hull0, HEX.hull1, HEX.hull2, HEX.hull3][r.id]);
      g.fill();
      g.strokeStyle = css(HEX.hudInk);
      g.lineWidth = 2;
      g.stroke();
    }
    g.restore();

    // ── Countdown / results ────────────────────────────────────────────────
    if (ctx.race.phase === 'countdown') {
      const n = ctx.race.countdownNumber;
      g.save();
      g.textAlign = 'center';
      g.font = '800 150px ui-sans-serif, system-ui, sans-serif';
      g.strokeStyle = css(HEX.hudInk);
      g.lineWidth = 12;
      g.fillStyle = n === 0 ? css(HEX.raceLine) : css(HEX.hudPaper);
      const label = n === 0 ? 'GO!' : String(n);
      g.strokeText(label, this.w / 2, this.h / 2 + 40);
      g.fillText(label, this.w / 2, this.h / 2 + 40);
      g.restore();
    }

    if (ctx.race.phase === 'results') {
      g.save();
      g.fillStyle = 'rgba(6,16,36,0.82)';
      g.fillRect(0, 0, this.w, this.h);
      g.textAlign = 'center';
      g.fillStyle = css(HEX.hudPaper);
      g.font = '800 58px ui-sans-serif, system-ui, sans-serif';
      g.fillText('RESULTS', this.w / 2, 120);
      g.font = '600 26px ui-sans-serif, system-ui, sans-serif';
      ctx.race.standings().forEach((r, i) => {
        const y = 200 + i * 52;
        g.textAlign = 'left';
        g.fillStyle = css([HEX.hull0, HEX.hull1, HEX.hull2, HEX.hull3][r.id]);
        g.fillText(`${i + 1}.  ${r.name}`, this.w / 2 - 240, y);
        g.textAlign = 'right';
        g.fillStyle = css(HEX.hudPaper);
        g.fillText(r.finished ? formatTime(r.finishTime) : 'DNF', this.w / 2 + 240, y);
      });
      g.textAlign = 'center';
      g.fillStyle = css(HEX.hudDim);
      g.font = '600 20px ui-sans-serif, system-ui, sans-serif';
      g.fillText('PRESS  R  TO RACE AGAIN', this.w / 2, this.h - 80);
      g.restore();
    }

    if (ctx.player.wrongWay && ctx.race.phase === 'racing') {
      g.save();
      g.textAlign = 'center';
      g.fillStyle = css(HEX.warn);
      g.font = '800 44px ui-sans-serif, system-ui, sans-serif';
      g.fillText('WRONG WAY', this.w / 2, 120);
      g.restore();
    }

    if (CONFIG.debug.enabled) {
      g.save();
      g.textAlign = 'left';
      g.fillStyle = '#9fe';
      g.font = '600 13px ui-monospace, monospace';
      const lines = [
        `fps ${ctx.perf.fps.toFixed(0)}  ${ctx.perf.frameMs.toFixed(1)}ms`,
        `dpr ${ctx.pixelRatio.toFixed(2)}  scale ${ctx.perf.gpuScale.toFixed(2)}`,
        `draws ${ctx.perf.drawCalls}  tris ${(ctx.perf.triangles / 1000).toFixed(0)}k`,
      ];
      lines.forEach((l, i) => g.fillText(l, 14, this.h - 60 + i * 16));
      g.restore();
    }
  }
}
