/**
 * INK TIDE — the HUD.
 *
 * Canvas 2D, hand-composed, no DOM, no fonts beyond the system stack (headline
 * *numerals* are drawn as geometry — see `inkDraw.segText`). Everything is built
 * from the primitives in `inkDraw.ts` so the whole overlay reads as one piece of
 * ink art rather than four widgets.
 *
 * Structure of a frame:
 *
 *   1. Blit the **chrome layer** — the static half of the overlay (gauge dial,
 *      tick ring, minimap frame and course ribbon). It is baked once per resize
 *      into its own DPR-sized canvas. Re-stroking a 260-point spline and 30 tick
 *      marks every frame is pure waste, and baking also keeps the hairlines
 *      identical frame to frame instead of shimmering.
 *   2. Draw the **live layer** — needle, digits, meters, pips, standings.
 *   3. Draw the **screens** (countdown / GO / lap flash / results) on top.
 *
 * The in-race instruments fade out entirely for the countdown and the results
 * board, so those moments get the whole frame. `hudAlpha` is damped, never
 * snapped, so the fade reads as a deliberate wipe.
 *
 * Layout is anchored to the four corners and scaled by a single `s` factor
 * derived from the viewport height, so the composition holds from a laptop
 * window to a retina 1440p capture without a media query.
 */

import { CONFIG } from '../core/config';
import { HEX } from '../core/palette';
import { clamp, clamp01, damp, formatTime, ordinal } from '../core/mathx';
import {
  FONT_STACK,
  chevronPath,
  cutPath,
  diamondPath,
  halo,
  hatch,
  inkText,
  inked,
  mixHex,
  rgba,
  segText,
  slantPath,
} from './inkDraw';
import { Minimap } from './minimap';
import { Screens } from './screens';
import type { GameContext, HudAPI, Racer, TrackAPI } from '../core/types';

/** Full-scale gauge reading. boostTopSpeed is 39 m/s ≈ 140 km/h. */
const GAUGE_MAX_KMH = 150;
/** Dial sweep, canvas angles (0 = +x, positive clockwise because y is down). */
const DIAL_A0 = (130 * Math.PI) / 180;
const DIAL_SWEEP = (280 * Math.PI) / 180;

interface Layout {
  s: number;
  /** Speedometer dial. */
  gx: number;
  gy: number;
  gr: number;
  /** Digital readout plate, left of the dial. */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  /** Top-left info slab. */
  ix: number;
  iy: number;
  iw: number;
  /** Boost meter origin. */
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

export class Hud implements HudAPI {
  private ctx2d: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;

  /** Baked static overlay. */
  private chrome: HTMLCanvasElement;
  private chromeCtx: CanvasRenderingContext2D;

  private minimap: Minimap;
  private screens = new Screens();
  private L: Layout = {
    s: 1, gx: 0, gy: 0, gr: 1, rx: 0, ry: 0, rw: 1, rh: 1,
    ix: 0, iy: 0, iw: 1, bx: 0, by: 0, bw: 1, bh: 1,
  };

  // ── Animation state ────────────────────────────────────────────────────────
  /** Needle and readout lag the physics slightly; a gauge with no inertia looks fake. */
  private needleKmh = 0;
  private shownKmh = 0;
  private hudAlpha = 0;
  /** Position-change animation: 1 → 0, sign in `placeDir`. */
  private placeFlash = 0;
  private placeDir = 0;
  private lastPlace = 0;
  /** Per-tier charge flash. */
  private tierFlash = [0, 0, 0];
  private lastTier = 0;
  private boostPulse = 0;
  private lastBoostTime = 0;
  private pulse = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private track: TrackAPI,
  ) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('HUD: 2D context unavailable');
    this.ctx2d = c;
    this.minimap = new Minimap(track);

    this.chrome = document.createElement('canvas');
    const cc = this.chrome.getContext('2d');
    if (!cc) throw new Error('HUD: chrome 2D context unavailable');
    this.chromeCtx = cc;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Layout
  // ───────────────────────────────────────────────────────────────────────────

  resize(width: number, height: number, dpr: number) {
    this.w = width;
    this.h = height;
    this.dpr = dpr;

    for (const cv of [this.canvas, this.chrome]) {
      cv.width = Math.max(1, Math.floor(width * dpr));
      cv.height = Math.max(1, Math.floor(height * dpr));
    }
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.chromeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // One scale factor for the whole overlay. Tied to height because that is
    // what constrains a bottom-anchored gauge.
    const s = clamp(height / 810, 0.62, 1.55);
    const map = Math.round(206 * s);
    const gr = 84 * s;
    const gx = width - 118 * s;
    const gy = height - 140 * s;
    const rw = 186 * s;

    this.L = {
      s,
      gr,
      gx,
      gy,
      rw,
      rh: 84 * s,
      rx: gx - gr - 32 * s - rw,
      ry: gy - 42 * s,
      ix: 28 * s,
      iy: 26 * s,
      iw: 306 * s,
      bx: 30 * s,
      by: height - 78 * s,
      bw: 78 * s,
      bh: 31 * s,
    };

    this.minimap.layout(width - 34 * s - map, 28 * s, map);
    this.computeChromeRects();
    this.bakeChrome();
  }

  /** Draw everything that does not change between frames. */
  private bakeChrome() {
    const g = this.chromeCtx;
    const { s, gx, gy, gr } = this.L;
    g.clearRect(0, 0, this.w, this.h);

    this.minimap.drawChrome(g, s);

    // ── Speedometer dial ────────────────────────────────────────────────────
    g.save();
    g.translate(gx, gy);

    // Dial plate: the arc closed back through the hub, so the open bottom of
    // the sweep is a real cut in the shape rather than a clipped circle.
    const plate = new Path2D();
    plate.arc(0, 0, gr + 9 * s, DIAL_A0, DIAL_A0 + DIAL_SWEEP);
    plate.arc(0, 0, gr - 46 * s, DIAL_A0 + DIAL_SWEEP, DIAL_A0, true);
    plate.closePath();
    halo(g, plate, rgba(HEX.ink, 0.4), 10 * s);
    inked(g, plate, rgba(HEX.hudInk, 0.78), rgba(HEX.hudPaper, 0.92), 3.2 * s);

    // Hatched shading in the dial's lower-left quadrant — drawn shading, not a
    // gradient, so it matches the cel language of the scene behind it.
    hatch(g, plate, -gr - 12 * s, -gr - 12 * s, (gr + 12 * s) * 2, (gr + 12 * s) * 2,
      rgba(HEX.waterMid, 0.13), 9 * s, 1.3 * s);

    // Redline band on the outer edge.
    const rlFrom = DIAL_A0 + DIAL_SWEEP * (118 / GAUGE_MAX_KMH);
    g.strokeStyle = rgba(HEX.warn, 0.85);
    g.lineWidth = 5 * s;
    g.beginPath();
    g.arc(0, 0, gr + 4.5 * s, rlFrom, DIAL_A0 + DIAL_SWEEP);
    g.stroke();

    // Ticks. No numerals on the dial: at this radius they collide with the
    // power band, and the digital readout beside the dial already carries the
    // exact figure. The redline band is what marks the top of the scale.
    for (let v = 0; v <= GAUGE_MAX_KMH; v += 10) {
      const a = DIAL_A0 + DIAL_SWEEP * (v / GAUGE_MAX_KMH);
      const major = v % 30 === 0;
      const r0 = gr - 1 * s;
      const r1 = gr - (major ? 18 : 9) * s;
      g.strokeStyle = major ? rgba(HEX.hudPaper, 0.95) : rgba(HEX.hudDim, 0.85);
      g.lineWidth = (major ? 3.6 : 1.8) * s;
      g.beginPath();
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      g.stroke();
    }
    g.restore();

    // ── Digital readout plate ───────────────────────────────────────────────
    // SPEED and KM/H share the top line. Stacking the unit under the digits put
    // it inside their descender band and the numerals struck straight through it
    // (visible in shots/pres_r3/hero.png).
    const { rx, ry, rw, rh } = this.L;

    // Spine welding the readout to the dial, so the two are one instrument
    // rather than two floating plates.
    const spine = slantPath(rx + rw - 6 * s, ry + rh * 0.42, gx - gr - rx - rw + 20 * s, 9 * s, 3 * s);
    inked(g, spine, rgba(HEX.hudInk, 0.9), rgba(HEX.hudPaper, 0.55), 2 * s);

    const plate2 = slantPath(rx, ry, rw, rh, 20 * s);
    halo(g, plate2, rgba(HEX.ink, 0.4), 10 * s);
    inked(g, plate2, rgba(HEX.hudInk, 0.8), rgba(HEX.hudPaper, 0.9), 3 * s);
    hatch(g, plate2, rx, ry, rw, rh, rgba(HEX.waterMid, 0.12), 10 * s, 1.3 * s);
    inkText(g, 'SPEED', rx + 18 * s, ry + 21 * s, {
      font: `800 ${Math.round(11 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudDim, 1),
      align: 'left',
      tracking: 3.4 * s,
    });
    inkText(g, 'KM/H', rx + rw - 14 * s, ry + 21 * s, {
      font: `800 ${Math.round(11.5 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.foamShade, 0.9),
      align: 'right',
      tracking: 3.2 * s,
    });
    // A rule under the caption line, then the digits below it.
    g.strokeStyle = rgba(HEX.hudDim, 0.45);
    g.lineWidth = 1.6 * s;
    g.beginPath();
    g.moveTo(rx + 14 * s, ry + 27 * s);
    g.lineTo(rx + rw - 10 * s, ry + 27 * s);
    g.stroke();
    // Unlit three-digit field, baked once — it never changes. Kept very faint:
    // at 0.15 the ghosts read as real digits and "77" looked like "8877".
    segText(g, '888', rx + rw - 16 * s, ry + 33 * s, 44 * s, {
      lit: rgba(HEX.hudDim, 0.09),
      dim: null,
      align: 'right',
      skew: 0.1,
    });

    // ── Boost meter: backing plate, caption, empty cells ────────────────────
    const { bx, by, bw, bh } = this.L;
    // The meter used to float as three unbacked chevrons in the corner while
    // every other cluster sat on a plate; giving it the same slab pulls the
    // bottom-left of the composition back into the same design language.
    const bPlate = slantPath(
      bx - 14 * s,
      by - 34 * s,
      3 * (bw + 7 * s) + 20 * s,
      bh + 44 * s,
      16 * s,
    );
    halo(g, bPlate, rgba(HEX.ink, 0.4), 10 * s);
    inked(g, bPlate, rgba(HEX.hudInk, 0.72), rgba(HEX.hudPaper, 0.85), 3 * s);
    hatch(g, bPlate, bx - 14 * s, by - 34 * s, 3 * (bw + 7 * s) + 20 * s, bh + 44 * s,
      rgba(HEX.waterMid, 0.12), 10 * s, 1.3 * s);
    inkText(g, 'DRIFT CHARGE', bx + 2 * s, by - 12 * s, {
      font: `800 ${Math.round(11.5 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.foamShade, 0.85),
      align: 'left',
      tracking: 3.2 * s,
    });
    for (let i = 0; i < 3; i++) {
      const x = bx + i * (bw + 7 * s);
      const cell = chevronPath(x, by, bw, bh, 11 * s);
      inked(g, cell, rgba(HEX.hudInk, 0.8), rgba(HEX.hudPaper, 0.72), 2.6 * s);
      hatch(g, cell, x, by, bw, bh, rgba(HEX.hudDim, 0.34), 8 * s, 1.3 * s);
      // Tier index inside the cell, low contrast — a label, not a readout.
      segText(g, String(i + 1), x + 17 * s, by + bh * 0.5 - 6 * s, 12 * s, {
        lit: rgba(HEX.hudDim, 0.7),
        dim: null,
        align: 'center',
        skew: 0.1,
      });
    }
  }

  /**
   * Sub-rects of the chrome layer, one per screen cluster, in CSS px:
   * [x, y, w, h]. Recomputed on resize. Non-overlapping by construction.
   */
  private CHROME_MAP: [number, number, number, number] = [0, 0, 1, 1];
  private CHROME_GAUGE: [number, number, number, number] = [0, 0, 1, 1];
  private CHROME_BOOST: [number, number, number, number] = [0, 0, 1, 1];

  private computeChromeRects() {
    const { s, gx, gy, gr, rx, bx, by } = this.L;
    const mapLeft = Math.max(0, this.minimap.x - 12 * s);
    this.CHROME_MAP = [mapLeft, 0, this.w - mapLeft, this.minimap.y + this.minimap.size + 18 * s];
    const gTop = gy - gr - 16 * s;
    const gLeft = Math.max(0, rx - 12 * s);
    this.CHROME_GAUGE = [gLeft, gTop, this.w - gLeft, this.h - gTop];
    const bTop = by - 44 * s;
    this.CHROME_BOOST = [Math.max(0, bx - 12 * s), bTop, 380 * s, this.h - bTop];
  }

  private blitChrome(r: [number, number, number, number]) {
    const d = this.dpr;
    this.ctx2d.drawImage(
      this.chrome,
      r[0] * d, r[1] * d, r[2] * d, r[3] * d,
      r[0], r[1], r[2], r[3],
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Frame
  // ───────────────────────────────────────────────────────────────────────────

  render(ctx: GameContext) {
    const g = this.ctx2d;
    const { s } = this.L;
    const dt = ctx.dt;
    const p = ctx.player;
    const st = p.state;
    const phase = ctx.race.phase;

    g.clearRect(0, 0, this.w, this.h);
    this.advance(ctx, dt);
    this.screens.update(ctx, dt);

    // ── In-race instruments ─────────────────────────────────────────────────
    if (this.hudAlpha > 0.004) {
      g.save();
      g.globalAlpha = this.hudAlpha;
      // Instruments slide in from the edges as they fade in — a static fade
      // reads as an opacity tween, a slide reads as hardware powering up.
      //
      // The baked chrome has to move *with* its own cluster, so it is blitted in
      // three sub-rects rather than as one full-screen image. Blitting it whole
      // and offsetting only the live layer leaves the minimap frame and its pips
      // travelling in different directions for the length of the fade.
      const off = (1 - this.hudAlpha) * 34 * s;

      g.save();
      g.translate(off, 0);
      this.blitChrome(this.CHROME_MAP);
      this.minimap.drawLive(g, ctx, s, this.pulse);
      this.drawStandings(ctx, s);
      g.restore();

      g.save();
      g.translate(0, off);
      this.blitChrome(this.CHROME_GAUGE);
      this.blitChrome(this.CHROME_BOOST);
      this.drawGauge(ctx, s);
      this.drawBoost(ctx, s);
      g.restore();

      g.save();
      g.translate(-off, 0);
      this.drawInfoSlab(ctx, s);
      g.restore();

      if (st.boostTime > 0) this.drawBoostFrame(s);
      if (p.wrongWay && phase === 'racing') this.drawWrongWay(s);
      g.restore();
    }

    // ── Screens ─────────────────────────────────────────────────────────────
    if (phase === 'countdown') this.screens.countdown(g, ctx, this.w, this.h, s);
    this.screens.go(g, this.w, this.h, s);
    this.screens.lapFlash(g, ctx, this.w, this.h, s);
    if (phase === 'finished') this.screens.finishFlash(g, ctx, this.w, this.h, s);
    if (phase === 'results') this.screens.results(g, ctx, this.w, this.h, s);

    if (CONFIG.debug.enabled) this.drawDebug(ctx, s);
  }

  /** All time-varying state advanced in one place, frame-rate independent. */
  private advance(ctx: GameContext, dt: number) {
    const st = ctx.player.state;
    const phase = ctx.race.phase;
    this.pulse += dt;

    const kmh = Math.abs(st.forwardSpeed) * 3.6;
    this.needleKmh = damp(this.needleKmh, kmh, 9, dt);
    this.shownKmh = damp(this.shownKmh, kmh, 16, dt);

    const target = phase === 'racing' || phase === 'finished' ? 1 : 0;
    this.hudAlpha = damp(this.hudAlpha, target, 5.5, dt);
    if (Math.abs(this.hudAlpha - target) < 0.01) this.hudAlpha = target;

    // Position change.
    const place = ctx.player.place;
    if (this.lastPlace === 0) this.lastPlace = place;
    else if (place !== this.lastPlace) {
      this.placeDir = place < this.lastPlace ? 1 : -1;
      this.placeFlash = 1;
      this.lastPlace = place;
    }
    this.placeFlash = Math.max(0, this.placeFlash - dt * 0.85);

    // Drift tier ups.
    if (st.driftTier > this.lastTier) this.tierFlash[st.driftTier - 1] = 1;
    this.lastTier = st.driftTier;
    for (let i = 0; i < 3; i++) this.tierFlash[i] = Math.max(0, this.tierFlash[i] - dt * 2.6);

    // Boost fired: rising edge on boostTime.
    if (st.boostTime > this.lastBoostTime + 0.01) this.boostPulse = 1;
    this.lastBoostTime = st.boostTime;
    this.boostPulse = Math.max(0, this.boostPulse - dt * 2.2);

    if (ctx.race.raceTime < -CONFIG.race.countdownSeconds + 0.05) this.screens.resetLatches();
  }

  // ── Speedometer ────────────────────────────────────────────────────────────

  private drawGauge(ctx: GameContext, s: number) {
    const g = this.ctx2d;
    const { gx, gy, gr } = this.L;
    const st = ctx.player.state;
    const boosting = st.boostTime > 0;
    const frac = clamp01(this.needleKmh / GAUGE_MAX_KMH);

    g.save();
    g.translate(gx, gy);

    // Power band — the filled arc from zero to the needle.
    if (frac > 0.002) {
      const a1 = DIAL_A0 + DIAL_SWEEP * frac;
      g.lineCap = 'butt';
      g.strokeStyle = rgba(HEX.ink, 0.9);
      g.lineWidth = 14 * s;
      g.beginPath();
      g.arc(0, 0, gr - 24 * s, DIAL_A0, a1);
      g.stroke();
      g.strokeStyle = boosting ? rgba(HEX.boostHot, 1) : rgba(HEX.waterCrest, 0.96);
      g.lineWidth = 9 * s;
      g.beginPath();
      g.arc(0, 0, gr - 24 * s, DIAL_A0, a1);
      g.stroke();
      if (boosting) {
        // Second, brighter rail on the outside while the boost burns.
        g.strokeStyle = rgba(HEX.boost, 0.95);
        g.lineWidth = 3.4 * s;
        g.beginPath();
        g.arc(0, 0, gr - 14 * s, DIAL_A0, a1);
        g.stroke();
      }
    }

    // Needle: tapered blade plus a stub counterweight.
    const a = DIAL_A0 + DIAL_SWEEP * frac;
    g.save();
    g.rotate(a);
    const len = gr - 20 * s;
    const nd = new Path2D();
    nd.moveTo(len, 0);
    nd.lineTo(len - 14 * s, -4.6 * s);
    nd.lineTo(6 * s, -8.5 * s);
    nd.lineTo(6 * s, 8.5 * s);
    nd.lineTo(len - 14 * s, 4.6 * s);
    nd.closePath();
    inked(g, nd, rgba(HEX.hull0, 1), rgba(HEX.ink, 1), 2.4 * s);
    const tail = new Path2D();
    tail.moveTo(-6 * s, -6 * s);
    tail.lineTo(-26 * s, -3.4 * s);
    tail.lineTo(-26 * s, 3.4 * s);
    tail.lineTo(-6 * s, 6 * s);
    tail.closePath();
    inked(g, tail, rgba(HEX.hudPaper, 0.9), rgba(HEX.ink, 1), 2 * s);
    g.restore();

    // Hub.
    const hub = new Path2D();
    hub.arc(0, 0, 11 * s, 0, Math.PI * 2);
    inked(g, hub, rgba(HEX.hudInk, 1), rgba(HEX.hudPaper, 0.9), 2.6 * s);
    const dot = new Path2D();
    dot.arc(0, 0, 3.4 * s, 0, Math.PI * 2);
    inked(g, dot, rgba(HEX.hull0, 1), null, 0);

    g.restore();

    // Digital readout. The unlit "888" field behind it is baked into the chrome
    // layer, so only the lit digits are drawn here.
    const val = Math.round(clamp(this.shownKmh, 0, 999));
    const { rx, ry, rw } = this.L;
    segText(g, String(val), rx + rw - 16 * s, ry + 33 * s, 44 * s, {
      lit: boosting ? rgba(HEX.boostHot, 1) : rgba(HEX.hudPaper, 1),
      dim: null,
      ink: rgba(HEX.ink, 0.95),
      inkWidth: 2.6 * s,
      align: 'right',
      skew: 0.1,
    });

    // Airborne / reverse annunciator in the dial's open mouth.
    let tag: string | null = null;
    let tagCol: number = HEX.waterCrest;
    if (st.airborne) {
      tag = 'AIR';
      tagCol = HEX.waterCrest;
    } else if (st.forwardSpeed < -0.6) {
      tag = 'REV';
      tagCol = HEX.warn;
    }
    if (tag) {
      const tw = 62 * s;
      const tp = cutPath(gx - tw * 0.5, gy + 30 * s, tw, 23 * s, 7 * s, 0b0101);
      inked(g, tp, rgba(HEX.hudInk, 0.92), rgba(tagCol, 0.95), 2.2 * s);
      inkText(g, tag, gx, gy + 47 * s, {
        font: `800 ${Math.round(13 * s)}px ${FONT_STACK}`,
        fill: rgba(tagCol, 1),
        align: 'center',
        tracking: 2.4 * s,
      });
    }
  }

  // ── Boost / drift meter ────────────────────────────────────────────────────

  private drawBoost(ctx: GameContext, s: number) {
    const g = this.ctx2d;
    const { bx, by, bw, bh } = this.L;
    const st = ctx.player.state;
    const boosting = st.boostTime > 0;
    // Tier thresholds normalised the same way boatPhysics normalises boostMeter.
    const tiers = CONFIG.boat.driftTiers;
    const full = tiers[tiers.length - 1];
    const edges = [0, tiers[0] / full, tiers[1] / full, 1];
    const meter = clamp01(st.boostMeter);

    for (let i = 0; i < 3; i++) {
      const x = bx + i * (bw + 7 * s);
      const cell = chevronPath(x, by, bw, bh, 11 * s);
      // Fill fraction of this cell.
      let f = boosting ? 1 : clamp01((meter - edges[i]) / (edges[i + 1] - edges[i]));
      if (boosting) f = clamp01(st.boostTime / 0.35 - (2 - i) * 0.25);
      if (f <= 0.001 && this.tierFlash[i] <= 0) continue;

      g.save();
      g.clip(cell);
      // Cell colour ramps pink → hot yellow across the three tiers, so the
      // meter reads as one heating element rather than three separate lamps.
      g.fillStyle = boosting ? rgba(HEX.boostHot, 1) : mixHex(HEX.boost, HEX.boostHot, i * 0.5);
      g.fillRect(x - 2 * s, by - 2 * s, (bw + 4 * s) * f, bh + 4 * s);
      // Leading edge highlight so the fill has a drawn front, not a soft ramp.
      if (f < 0.999) {
        g.fillStyle = rgba(HEX.foam, 0.85);
        g.fillRect(x - 2 * s + (bw + 4 * s) * f - 3 * s, by - 2 * s, 3 * s, bh + 4 * s);
      }
      g.restore();

      // Re-ink the cell over the fill.
      inked(g, cell, null, rgba(HEX.hudPaper, 0.8), 2.4 * s);

      // Tier-up flash: a white wash plus an expanding outline.
      const tf = this.tierFlash[i];
      if (tf > 0) {
        g.save();
        g.globalAlpha = tf;
        inked(g, cell, rgba(HEX.foam, 0.75 * tf), null, 0);
        g.restore();
        const k = 1 - tf;
        const grow = 10 * s * k;
        const ring = chevronPath(x - grow, by - grow, bw + grow * 2, bh + grow * 2, 11 * s);
        inked(g, ring, null, rgba(HEX.boostHot, tf * 0.9), 2.6 * s);
      }
    }

    // "BOOST" callout while a boost is burning, punched by the fire pulse.
    if (boosting || this.boostPulse > 0) {
      const k = Math.max(boosting ? 1 : 0, this.boostPulse);
      const cx = bx + 3 * (bw + 7 * s) + 16 * s;
      g.save();
      g.globalAlpha = k;
      inkText(g, 'BOOST', cx, by + bh - 6 * s, {
        font: `900 ${Math.round(27 * s)}px ${FONT_STACK}`,
        fill: rgba(HEX.boostHot, 1),
        ink: rgba(HEX.ink, 1),
        inkWidth: 5 * s,
        align: 'left',
        skew: 0.2,
        tracking: 1.5 * s,
        ghost: rgba(HEX.boost, 0.9),
        ghostDx: 4 * s,
        ghostDy: 4 * s,
      });
      g.restore();
    }

    // Drift annunciator: slip angle read-out while powersliding.
    if (st.drifting) {
      const slip =
        (Math.atan2(Math.abs(st.lateralSpeed), Math.max(1, Math.abs(st.forwardSpeed))) * 180) /
        Math.PI;
      const y = by - 52 * s;
      const tw = 138 * s;
      const tp = slantPath(bx - 6 * s, y - 20 * s, tw, 26 * s, 10 * s);
      inked(g, tp, rgba(HEX.ink, 0.88), rgba(HEX.boost, 0.95), 2.2 * s);
      inkText(g, 'DRIFT', bx + 8 * s, y - 2 * s, {
        font: `800 ${Math.round(14 * s)}px ${FONT_STACK}`,
        fill: rgba(HEX.boost, 1),
        align: 'left',
        skew: 0.14,
        tracking: 2.2 * s,
      });
      // Slip angle in the type face with a real degree sign — the segment face
      // renders "11" as two bare bars, which reads as a tally, not an angle.
      inkText(g, `${Math.round(slip)}\u00B0`, bx + tw - 18 * s, y - 2 * s, {
        font: `900 ${Math.round(19 * s)}px ${FONT_STACK}`,
        fill: rgba(HEX.hudPaper, 1),
        align: 'right',
        skew: 0.14,
      });
    }
  }

  /** Thin coloured rails top and bottom while boosting — a frame-wide cue. */
  private drawBoostFrame(s: number) {
    const g = this.ctx2d;
    const k = 0.55 + 0.45 * Math.sin(this.pulse * 22);
    g.save();
    g.fillStyle = rgba(HEX.boost, 0.5 * k);
    g.fillRect(0, 0, this.w, 3.5 * s);
    g.fillRect(0, this.h - 3.5 * s, this.w, 3.5 * s);
    // Corner speed wedges.
    g.fillStyle = rgba(HEX.boostHot, 0.22 * k);
    for (const sx of [0, 1]) {
      const wedge = new Path2D();
      const X = sx * this.w;
      const d = sx ? -1 : 1;
      wedge.moveTo(X, 0);
      wedge.lineTo(X + d * 130 * s, 0);
      wedge.lineTo(X, this.h * 0.5);
      wedge.closePath();
      g.fill(wedge);
    }
    g.restore();
  }

  // ── Top-left: position, lap, clock, splits ─────────────────────────────────

  private drawInfoSlab(ctx: GameContext, s: number) {
    const g = this.ctx2d;
    const { ix, iy, iw } = this.L;
    const p = ctx.player;
    const h1 = 96 * s;

    // Main slab.
    const slab = slantPath(ix, iy, iw, h1, 24 * s);
    const lead = p.place === 1;
    halo(g, slab, rgba(HEX.ink, 0.42), 11 * s);
    inked(
      g,
      slab,
      rgba(HEX.hudInk, 0.8),
      lead ? rgba(HEX.boostHot, 0.95) : rgba(HEX.hudPaper, 0.9),
      3.4 * s,
    );
    hatch(g, slab, ix, iy, iw, h1, rgba(HEX.waterMid, 0.12), 10 * s, 1.3 * s);

    // Divider between the placement and the lap block.
    const dx = ix + 124 * s;
    g.strokeStyle = rgba(HEX.hudPaper, 0.45);
    g.lineWidth = 2 * s;
    g.beginPath();
    g.moveTo(dx + 24 * s, iy + 6 * s);
    g.lineTo(dx, iy + h1 - 6 * s);
    g.stroke();

    // ── Placement. The suffix is set small and raised, like a race programme.
    const flash = this.placeFlash;
    const pop = 1 + flash * flash * 0.16;
    const num = String(p.place);
    const suf = ordinal(p.place).slice(String(p.place).length).toUpperCase();
    g.save();
    g.translate(ix + 66 * s, iy + h1 * 0.5);
    g.scale(pop, pop);
    const flashCol =
      flash > 0
        ? this.placeDir > 0
          ? rgba(HEX.raceLine, 1)
          : rgba(HEX.warn, 1)
        : lead
          ? rgba(HEX.boostHot, 1)
          : rgba(HEX.hudPaper, 1);
    inkText(g, num, -6 * s, 25 * s, {
      font: `900 ${Math.round(72 * s)}px ${FONT_STACK}`,
      fill: flashCol,
      ink: rgba(HEX.ink, 1),
      inkWidth: 6.5 * s,
      align: 'center',
      skew: 0.17,
      ghost: rgba(HEX.boost, 0.55),
      ghostDx: 4 * s,
      ghostDy: 4 * s,
    });
    inkText(g, suf, 26 * s, -8 * s, {
      font: `800 ${Math.round(22 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudDim, 1),
      align: 'left',
      skew: 0.17,
    });
    g.restore();

    // Position-change arrow, riding out of the badge.
    if (flash > 0 && this.placeDir !== 0) {
      const up = this.placeDir > 0;
      const rise = (1 - flash) * 26 * s;
      g.save();
      g.globalAlpha = flash;
      g.translate(ix + 108 * s, iy + h1 * 0.5 - (up ? rise : -rise));
      const arr = new Path2D();
      const d = up ? -1 : 1;
      arr.moveTo(0, 11 * s * d);
      arr.lineTo(9 * s, -3 * s * d);
      arr.lineTo(3.4 * s, -3 * s * d);
      arr.lineTo(3.4 * s, -12 * s * d);
      arr.lineTo(-3.4 * s, -12 * s * d);
      arr.lineTo(-3.4 * s, -3 * s * d);
      arr.lineTo(-9 * s, -3 * s * d);
      arr.closePath();
      inked(g, arr, up ? rgba(HEX.raceLine, 1) : rgba(HEX.warn, 1), rgba(HEX.ink, 1), 2 * s);
      g.restore();
    }

    // ── Lap counter.
    const lx = ix + 148 * s;
    inkText(g, 'LAP', lx, iy + 26 * s, {
      font: `800 ${Math.round(12 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudDim, 1),
      align: 'left',
      tracking: 3.4 * s,
    });
    const lapNum = String(Math.min(p.lap + 1, CONFIG.race.laps));
    segText(g, `${lapNum}/${CONFIG.race.laps}`, lx, iy + 32 * s, 30 * s, {
      lit: rgba(HEX.hudPaper, 1),
      dim: null,
      ink: rgba(HEX.ink, 0.9),
      inkWidth: 1.8 * s,
      align: 'left',
      skew: 0.1,
    });

    // ── Race clock.
    const t = Math.max(0, ctx.race.raceTime);
    segText(g, formatTime(t), lx, iy + 70 * s, 19 * s, {
      lit: rgba(HEX.waterCrest, 0.95),
      dim: rgba(HEX.hudDim, 0.15),
      align: 'left',
      skew: 0.1,
    });

    // ── Split plate: last lap and best lap.
    const y2 = iy + h1 + 8 * s;
    const h2 = 46 * s;
    const split = slantPath(ix + 6 * s, y2, iw - 34 * s, h2, 18 * s);
    halo(g, split, rgba(HEX.ink, 0.38), 8 * s);
    inked(g, split, rgba(HEX.hudInk, 0.7), rgba(HEX.hudDim, 0.8), 2.2 * s);

    const last = p.lapTimes.length ? p.lapTimes[p.lapTimes.length - 1] : NaN;
    const bestIsNew =
      p.lapTimes.length > 0 && isFinite(p.bestLap) && Math.abs(p.bestLap - last) < 1e-6;
    const cols: [string, number, string][] = [
      ['LAST', last, rgba(HEX.hudPaper, 0.95)],
      ['BEST', p.bestLap, bestIsNew ? rgba(HEX.raceLine, 1) : rgba(HEX.foamShade, 0.95)],
    ];
    cols.forEach(([label, value, col], i) => {
      const cx = ix + 22 * s + i * (iw - 76 * s) * 0.5;
      inkText(g, label, cx, y2 + 17 * s, {
        font: `800 ${Math.round(10.5 * s)}px ${FONT_STACK}`,
        fill: rgba(HEX.hudDim, 1),
        align: 'left',
        tracking: 2.4 * s,
      });
      // With no lap recorded yet the display shows its unlit field only, which
      // reads as "no data" instead of as a genuine 0:00.000.
      const has = isFinite(value) && value > 0;
      segText(g, has ? formatTime(value) : '0:00.000', cx, y2 + 22 * s, 16 * s, {
        lit: has ? col : rgba(HEX.hudDim, 0.14),
        dim: has ? rgba(HEX.hudDim, 0.12) : null,
        align: 'left',
        skew: 0.1,
      });
    });
  }

  // ── Standings ladder ───────────────────────────────────────────────────────

  private drawStandings(ctx: GameContext, s: number) {
    const g = this.ctx2d;
    const board = ctx.race.standings();
    const rowH = 30 * s;
    const gap = 5 * s;
    const w = this.minimap.size;
    const x = this.minimap.x;
    const y0 = this.minimap.y + this.minimap.size + 20 * s;
    const leader = board[0];

    for (let i = 0; i < board.length; i++) {
      const r = board[i];
      const y = y0 + i * (rowH + gap);
      const hex = [HEX.hull0, HEX.hull1, HEX.hull2, HEX.hull3][r.id];
      const isPlayer = r.isPlayer;
      // Rows stagger right as they go down: the ladder reads as a ranked stack.
      const rx = x + i * 7 * s;
      const plate = slantPath(rx, y, w - i * 7 * s, rowH, 11 * s);
      inked(
        g,
        plate,
        rgba(HEX.hudInk, isPlayer ? 0.9 : 0.66),
        isPlayer ? rgba(HEX.hudPaper, 0.92) : rgba(HEX.hudDim, 0.6),
        isPlayer ? 2.8 * s : 1.8 * s,
      );

      // Colour chip.
      const chip = slantPath(rx + 3 * s, y + 3 * s, 7 * s, rowH - 6 * s, 9 * s);
      inked(g, chip, rgba(hex, 1), rgba(HEX.ink, 0.85), 1.4 * s);

      // Place number in the type face, not the segment face: a seven-segment
      // "1" is a bare vertical bar and at ladder size it reads as a tally mark
      // rather than as a position.
      inkText(g, String(i + 1), rx + 26 * s, y + rowH - 9 * s, {
        font: `900 ${Math.round(19 * s)}px ${FONT_STACK}`,
        fill: rgba(i === 0 ? HEX.boostHot : HEX.hudPaper, 0.98),
        align: 'center',
        skew: 0.16,
      });

      inkText(g, r.name.toUpperCase(), rx + 42 * s, y + rowH - 9 * s, {
        font: `800 ${Math.round(13 * s)}px ${FONT_STACK}`,
        fill: rgba(isPlayer ? HEX.hudPaper : HEX.foamShade, 0.95),
        align: 'left',
        skew: 0.1,
        tracking: 1.2 * s,
      });

      // Gap to the leader, estimated from spline progress and current pace.
      const gapTxt = this.gapText(ctx, r, leader);
      inkText(g, gapTxt, rx + w - i * 7 * s - 10 * s, y + rowH - 9 * s, {
        font: `800 ${Math.round(12.5 * s)}px ${FONT_STACK}`,
        fill:
          gapTxt === 'LEAD'
            ? rgba(HEX.boostHot, 1)
            : isPlayer
              ? rgba(HEX.warn, 1)
              : rgba(HEX.hudDim, 1),
        align: 'right',
        skew: 0.1,
      });
    }
  }

  /**
   * Split to the leader in seconds. Distance-behind divided by pace is a rough
   * model, but it is the same one broadcast timing uses and it is stable — a
   * per-gate delta flickers every time two boats straddle a checkpoint.
   */
  private gapText(ctx: GameContext, r: Racer, leader: Racer) {
    if (r === leader) return 'LEAD';
    const dLaps = leader.progress - r.progress;
    const metres = dLaps * ctx.track.length;
    const pace = Math.max(9, Math.abs(r.state.forwardSpeed));
    const secs = metres / pace;
    return '+' + (secs < 100 ? secs.toFixed(1) : Math.round(secs).toString());
  }

  // ── Warnings ───────────────────────────────────────────────────────────────

  private drawWrongWay(s: number) {
    const g = this.ctx2d;
    const blink = 0.45 + 0.55 * Math.abs(Math.sin(this.pulse * 6));
    const cx = this.w * 0.5;
    const cy = this.h * 0.155;
    g.save();
    g.globalAlpha = blink;
    const slab = slantPath(cx - 190 * s, cy - 28 * s, 380 * s, 56 * s, 20 * s);
    inked(g, slab, rgba(HEX.ink, 0.82), rgba(HEX.warn, 0.95), 3 * s);
    // Hazard ticks along the bottom edge.
    g.save();
    g.clip(slab);
    g.strokeStyle = rgba(HEX.warn, 0.5);
    g.lineWidth = 6 * s;
    for (let i = -2; i < 30; i++) {
      const bxx = cx - 190 * s + i * 14 * s;
      g.beginPath();
      g.moveTo(bxx, cy + 28 * s);
      g.lineTo(bxx + 10 * s, cy + 18 * s);
      g.stroke();
    }
    g.restore();
    inkText(g, 'WRONG WAY', cx, cy + 12 * s, {
      font: `900 ${Math.round(34 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.warn, 1),
      ink: rgba(HEX.ink, 1),
      inkWidth: 6 * s,
      align: 'center',
      skew: 0.16,
      tracking: 4 * s,
    });
    // Reverse chevrons either side.
    for (const dir of [-1, 1]) {
      g.strokeStyle = rgba(HEX.warn, 0.9);
      g.lineWidth = 4 * s;
      for (let i = 0; i < 2; i++) {
        const bxx = cx + dir * (150 + i * 16) * s;
        g.beginPath();
        g.moveTo(bxx + dir * 9 * s, cy - 12 * s);
        g.lineTo(bxx - dir * 6 * s, cy);
        g.lineTo(bxx + dir * 9 * s, cy + 12 * s);
        g.stroke();
      }
    }
    g.restore();
  }

  private drawDebug(ctx: GameContext, s: number) {
    const g = this.ctx2d;
    g.save();
    g.font = `600 ${Math.round(12 * s)}px ui-monospace, monospace`;
    g.textAlign = 'left';
    g.fillStyle = rgba(HEX.raceLine, 0.9);
    const lines = [
      `fps ${ctx.perf.fps.toFixed(0)}  ${ctx.perf.frameMs.toFixed(1)}ms`,
      `dpr ${ctx.pixelRatio.toFixed(2)}  scale ${ctx.perf.gpuScale.toFixed(2)}`,
      `draws ${ctx.perf.drawCalls}  tris ${(ctx.perf.triangles / 1000).toFixed(0)}k`,
    ];
    lines.forEach((l, i) => g.fillText(l, this.w * 0.5 - 90 * s, this.h - 54 * s + i * 15 * s));
    g.restore();
  }
}
