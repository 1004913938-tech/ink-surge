/**
 * Hub / career / garage / quick / trial menus — canvas 2D over the living ocean.
 */

import { BRAND } from '../brand';
import { ACTIVE } from '../core/activeRace';
import { HEX } from '../core/palette';
import {
  CAREER_CUPS,
  getCup,
  rateEvent,
  rateSwellScore,
  type CareerEvent,
} from '../meta/career';
import {
  BOAT_PROFILES,
  LIVERIES,
  type BoatClass,
} from '../meta/catalog';
import { loadSave, writeSave, type Medal, type SaveData } from '../meta/save';
import type { PlayMode, RaceSession } from '../meta/session';
import { TRACK_LIST, getTrackDef } from '../race/trackDef';
import {
  FONT_STACK,
  PLATE_SKEW,
  cutPath,
  inkText,
  plate,
  rgba,
  slantPath,
} from './inkDraw';
import type { GameContext, RacePhase } from '../core/types';

export type MenuAction =
  | { type: 'none' }
  | { type: 'setPhase'; phase: RacePhase }
  | { type: 'startRace'; session: RaceSession };

const HUB_ITEMS: { id: RacePhase; label: string; blurb: string }[] = [
  { id: 'career', label: 'CAREER CUP', blurb: 'Four events. Medals unlock boats.' },
  { id: 'quick', label: 'QUICK RACE', blurb: 'Pick a track and go.' },
  { id: 'trial', label: 'TIME TRIAL', blurb: 'Solo clock. Beat your ghost pace.' },
  { id: 'garage', label: 'GARAGE', blurb: 'Hull class and liveries.' },
];

export class Menus {
  private save: SaveData = loadSave();
  private hubIndex = 0;
  private careerIndex = 0;
  private garageBoat = 0;
  private garageLivery = 0;
  private quickTrack = 0;
  private trialTrack = 0;
  private pulse = 0;
  /** Last results payout blurb. */
  lastPayout = '';

  getSave(): SaveData {
    return this.save;
  }

  persist() {
    writeSave(this.save);
  }

  /** Call when returning from results so career index stays sensible. */
  syncFromSave() {
    this.save = loadSave();
    const boatIds = Object.keys(BOAT_PROFILES) as BoatClass[];
    this.garageBoat = Math.max(0, boatIds.indexOf(this.save.selectedBoat));
    const livs = LIVERIES.filter((l) => l.boatClass === this.save.selectedBoat);
    this.garageLivery = Math.max(
      0,
      livs.findIndex((l) => l.id === this.save.selectedLivery),
    );
  }

  update(ctx: GameContext, dt: number): MenuAction {
    this.pulse += dt;
    const phase = ctx.race.phase;
    if (phase === 'hub') return this.updateHub(ctx);
    if (phase === 'career') return this.updateCareer(ctx);
    if (phase === 'garage') return this.updateGarage(ctx);
    if (phase === 'quick') return this.updateQuick(ctx);
    if (phase === 'trial') return this.updateTrial(ctx);
    return { type: 'none' };
  }

  render(g: CanvasRenderingContext2D, ctx: GameContext, w: number, h: number) {
    const phase = ctx.race.phase;
    if (phase === 'hub') this.drawHub(g, w, h);
    else if (phase === 'career') this.drawCareer(g, w, h);
    else if (phase === 'garage') this.drawGarage(g, w, h);
    else if (phase === 'quick') this.drawQuick(g, w, h);
    else if (phase === 'trial') this.drawTrial(g, w, h);
  }

  // ── Hub ────────────────────────────────────────────────────────────────────

  private updateHub(ctx: GameContext): MenuAction {
    const i = ctx.input;
    if (i.menuUp) this.hubIndex = (this.hubIndex + HUB_ITEMS.length - 1) % HUB_ITEMS.length;
    if (i.menuDown) this.hubIndex = (this.hubIndex + 1) % HUB_ITEMS.length;
    if (i.menuConfirm) {
      return { type: 'setPhase', phase: HUB_ITEMS[this.hubIndex].id };
    }
    return { type: 'none' };
  }

  private drawHub(g: CanvasRenderingContext2D, w: number, h: number) {
    const s = h / 900;
    this.veil(g, w, h, 0.42);
    inkText(g, BRAND.name, w * 0.5, h * 0.16, {
      font: `900 ${Math.round(64 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudPaper, 1),
      ink: rgba(HEX.ink, 1),
      inkWidth: 8 * s,
      align: 'center',
      skew: 0.16,
      tracking: 8 * s,
      ghost: rgba(HEX.boost, 0.75),
      ghostDx: 6 * s,
      ghostDy: 7 * s,
    });
    inkText(g, BRAND.tagline.toUpperCase(), w * 0.5, h * 0.22, {
      font: `700 ${Math.round(14 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.foamShade, 0.95),
      align: 'center',
      tracking: 3 * s,
    });
    inkText(g, `${this.save.coins} COIN`, w * 0.5, h * 0.265, {
      font: `800 ${Math.round(13 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.buoy, 1),
      align: 'center',
      tracking: 2 * s,
    });

    const cx = w * 0.5;
    const itemW = Math.min(520 * s, w * 0.7);
    const itemH = 56 * s;
    const startY = h * 0.34;
    for (let i = 0; i < HUB_ITEMS.length; i++) {
      const y = startY + i * (itemH + 14 * s);
      const sel = i === this.hubIndex;
      const path = slantPath(cx - itemW * 0.5, y, itemW, itemH, itemH * PLATE_SKEW);
      plate(g, path, s, {
        edge: rgba(sel ? HEX.boostHot : HEX.hudPaper, sel ? 1 : 0.55),
      });
      inkText(g, HUB_ITEMS[i].label, cx - itemW * 0.5 + 28 * s, y + itemH * 0.62, {
        font: `800 ${Math.round(20 * s)}px ${FONT_STACK}`,
        fill: rgba(sel ? HEX.boostHot : HEX.hudPaper, 1),
        align: 'left',
        skew: 0.1,
        tracking: 2 * s,
      });
      inkText(g, HUB_ITEMS[i].blurb, cx + itemW * 0.5 - 24 * s, y + itemH * 0.62, {
        font: `600 ${Math.round(12 * s)}px ${FONT_STACK}`,
        fill: rgba(HEX.hudDim, 1),
        align: 'right',
      });
    }

    this.hint(g, w, h, s, '↑↓ SELECT   ENTER CONFIRM');
  }

  // ── Career ─────────────────────────────────────────────────────────────────

  private updateCareer(ctx: GameContext): MenuAction {
    const cup = CAREER_CUPS[0];
    const progress = this.save.careerProgress[cup.id] ?? 1;
    const maxIdx = Math.min(cup.events.length - 1, Math.max(0, progress - 1));
    if (ctx.input.menuBack) return { type: 'setPhase', phase: 'hub' };
    if (ctx.input.menuUp) this.careerIndex = Math.max(0, this.careerIndex - 1);
    if (ctx.input.menuDown) this.careerIndex = Math.min(maxIdx, this.careerIndex + 1);
    this.careerIndex = clamp(this.careerIndex, 0, maxIdx);
    if (ctx.input.menuConfirm) {
      const ev = cup.events[this.careerIndex];
      return { type: 'startRace', session: this.sessionFromEvent(ev, cup.id, this.careerIndex) };
    }
    return { type: 'none' };
  }

  private drawCareer(g: CanvasRenderingContext2D, w: number, h: number) {
    const s = h / 900;
    const cup = CAREER_CUPS[0];
    const progress = this.save.careerProgress[cup.id] ?? 1;
    this.veil(g, w, h, 0.5);
    inkText(g, cup.name, w * 0.5, h * 0.12, {
      font: `900 ${Math.round(36 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudPaper, 1),
      align: 'center',
      skew: 0.12,
      tracking: 4 * s,
    });
    inkText(g, cup.blurb.toUpperCase(), w * 0.5, h * 0.17, {
      font: `600 ${Math.round(12 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.foamShade, 0.9),
      align: 'center',
      tracking: 2 * s,
    });

    const cx = w * 0.5;
    const itemW = Math.min(640 * s, w * 0.82);
    for (let i = 0; i < cup.events.length; i++) {
      const ev = cup.events[i];
      const locked = i > progress - 1;
      const sel = i === this.careerIndex && !locked;
      const y = h * 0.24 + i * 72 * s;
      const path = slantPath(cx - itemW * 0.5, y, itemW, 58 * s, 58 * s * PLATE_SKEW);
      plate(g, path, s, {
        edge: rgba(sel ? HEX.boostHot : HEX.hudPaper, locked ? 0.25 : sel ? 1 : 0.5),
      });
      const medal = this.save.medals[ev.id] ?? 'none';
      inkText(g, locked ? 'LOCKED' : `${i + 1}. ${ev.name}`, cx - itemW * 0.5 + 22 * s, y + 28 * s, {
        font: `800 ${Math.round(16 * s)}px ${FONT_STACK}`,
        fill: rgba(locked ? HEX.hudDim : sel ? HEX.boostHot : HEX.hudPaper, 1),
        align: 'left',
        skew: 0.08,
      });
      const kindLabel =
        ev.kind === 'swellRun'
          ? 'SWELL RUN'
          : ev.kind === 'timeTrial'
            ? 'TIME TRIAL'
            : ev.kind.toUpperCase();
      inkText(
        g,
        locked ? '—' : `${getTrackDef(ev.trackId).name} · ${kindLabel} · ${medalLabel(medal)}`,
        cx - itemW * 0.5 + 22 * s,
        y + 48 * s,
        {
          font: `600 ${Math.round(11 * s)}px ${FONT_STACK}`,
          fill: rgba(HEX.hudDim, 1),
          align: 'left',
        },
      );
    }
    this.hint(g, w, h, s, '↑↓ SELECT   ENTER RACE   ESC BACK');
  }

  // ── Garage ─────────────────────────────────────────────────────────────────

  private updateGarage(ctx: GameContext): MenuAction {
    const boats = Object.keys(BOAT_PROFILES) as BoatClass[];
    if (ctx.input.menuBack) {
      this.persist();
      return { type: 'setPhase', phase: 'hub' };
    }
    if (ctx.input.menuLeft) this.garageBoat = (this.garageBoat + boats.length - 1) % boats.length;
    if (ctx.input.menuRight) this.garageBoat = (this.garageBoat + 1) % boats.length;
    const boat = boats[this.garageBoat];
    const livs = LIVERIES.filter((l) => l.boatClass === boat);
    if (ctx.input.menuUp) this.garageLivery = (this.garageLivery + livs.length - 1) % livs.length;
    if (ctx.input.menuDown) this.garageLivery = (this.garageLivery + 1) % livs.length;
    this.garageLivery = clamp(this.garageLivery, 0, Math.max(0, livs.length - 1));

    if (ctx.input.menuConfirm) {
      const profile = BOAT_PROFILES[boat];
      const liv = livs[this.garageLivery];
      if (!this.save.unlockedBoats.includes(boat)) {
        if (this.save.coins >= profile.unlockCost) {
          this.save.coins -= profile.unlockCost;
          this.save.unlockedBoats.push(boat);
          this.persist();
        }
        return { type: 'none' };
      }
      if (liv && !this.save.unlockedLiveries.includes(liv.id)) {
        if (this.save.coins >= liv.unlockCost) {
          this.save.coins -= liv.unlockCost;
          this.save.unlockedLiveries.push(liv.id);
          this.persist();
        }
        return { type: 'none' };
      }
      if (liv) {
        this.save.selectedBoat = boat;
        this.save.selectedLivery = liv.id;
        this.persist();
      }
    }
    return { type: 'none' };
  }

  private drawGarage(g: CanvasRenderingContext2D, w: number, h: number) {
    const s = h / 900;
    const boats = Object.keys(BOAT_PROFILES) as BoatClass[];
    const boat = boats[this.garageBoat];
    const profile = BOAT_PROFILES[boat];
    const livs = LIVERIES.filter((l) => l.boatClass === boat);
    const liv = livs[this.garageLivery];
    const ownedBoat = this.save.unlockedBoats.includes(boat);
    const ownedLiv = liv ? this.save.unlockedLiveries.includes(liv.id) : false;

    this.veil(g, w, h, 0.5);
    inkText(g, 'GARAGE', w * 0.5, h * 0.12, {
      font: `900 ${Math.round(40 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudPaper, 1),
      align: 'center',
      skew: 0.14,
      tracking: 6 * s,
    });
    inkText(g, `${this.save.coins} COIN`, w * 0.5, h * 0.17, {
      font: `800 ${Math.round(13 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.buoy, 1),
      align: 'center',
    });

    const panel = cutPath(w * 0.18, h * 0.24, w * 0.64, h * 0.48, 18 * s, 0b1111);
    plate(g, panel, s, { edge: rgba(HEX.raceLine, 0.85) });

    inkText(g, profile.name, w * 0.5, h * 0.34, {
      font: `900 ${Math.round(28 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.boostHot, 1),
      align: 'center',
      skew: 0.1,
    });
    inkText(g, profile.blurb.toUpperCase(), w * 0.5, h * 0.39, {
      font: `600 ${Math.round(12 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.foamShade, 1),
      align: 'center',
      tracking: 1.5 * s,
    });
    inkText(
      g,
      `SPD ${pct(profile.topSpeed)}   TURN ${pct(profile.turnRate)}   BOOST ${pct(profile.boostCharge)}`,
      w * 0.5,
      h * 0.46,
      {
        font: `800 ${Math.round(14 * s)}px ${FONT_STACK}`,
        fill: rgba(HEX.hudPaper, 1),
        align: 'center',
        tracking: 2 * s,
      },
    );
    inkText(g, liv ? `LIVERY  ${liv.name}` : '—', w * 0.5, h * 0.54, {
      font: `700 ${Math.round(16 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.gate, 1),
      align: 'center',
    });

    let status = 'ENTER EQUIP';
    if (!ownedBoat) status = `ENTER BUY BOAT  ${profile.unlockCost}c`;
    else if (liv && !ownedLiv) status = `ENTER BUY LIVERY  ${liv.unlockCost}c`;
    else if (this.save.selectedBoat === boat && this.save.selectedLivery === liv?.id) {
      status = 'EQUIPPED';
    }
    inkText(g, status, w * 0.5, h * 0.64, {
      font: `800 ${Math.round(15 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.buoy, 1),
      align: 'center',
      tracking: 2 * s,
    });

    this.hint(g, w, h, s, '←→ BOAT   ↑↓ LIVERY   ENTER BUY/EQUIP   ESC BACK');
  }

  // ── Quick / Trial ──────────────────────────────────────────────────────────

  private updateQuick(ctx: GameContext): MenuAction {
    if (ctx.input.menuBack) return { type: 'setPhase', phase: 'hub' };
    if (ctx.input.menuLeft) this.quickTrack = (this.quickTrack + TRACK_LIST.length - 1) % TRACK_LIST.length;
    if (ctx.input.menuRight) this.quickTrack = (this.quickTrack + 1) % TRACK_LIST.length;
    if (ctx.input.menuConfirm) {
      const t = TRACK_LIST[this.quickTrack];
      return {
        type: 'startRace',
        session: {
          mode: 'quick',
          trackId: t.id,
          laps: 3,
          racerCount: 4,
          seaState: t.theme.seaState,
          boatClass: this.save.selectedBoat,
          liveryId: this.save.selectedLivery,
          eventKind: 'standard',
        },
      };
    }
    return { type: 'none' };
  }

  private updateTrial(ctx: GameContext): MenuAction {
    if (ctx.input.menuBack) return { type: 'setPhase', phase: 'hub' };
    if (ctx.input.menuLeft) this.trialTrack = (this.trialTrack + TRACK_LIST.length - 1) % TRACK_LIST.length;
    if (ctx.input.menuRight) this.trialTrack = (this.trialTrack + 1) % TRACK_LIST.length;
    if (ctx.input.menuConfirm) {
      const t = TRACK_LIST[this.trialTrack];
      return {
        type: 'startRace',
        session: {
          mode: 'trial',
          trackId: t.id,
          laps: 2,
          racerCount: 1,
          seaState: t.theme.seaState,
          boatClass: this.save.selectedBoat,
          liveryId: this.save.selectedLivery,
          eventKind: 'timeTrial',
        },
      };
    }
    return { type: 'none' };
  }

  private drawQuick(g: CanvasRenderingContext2D, w: number, h: number) {
    this.drawTrackPicker(g, w, h, 'QUICK RACE', this.quickTrack, 'quick');
  }

  private drawTrial(g: CanvasRenderingContext2D, w: number, h: number) {
    this.drawTrackPicker(g, w, h, 'TIME TRIAL', this.trialTrack, 'trial');
  }

  private drawTrackPicker(
    g: CanvasRenderingContext2D,
    w: number,
    h: number,
    title: string,
    index: number,
    mode: PlayMode,
  ) {
    const s = h / 900;
    const t = TRACK_LIST[index];
    this.veil(g, w, h, 0.48);
    inkText(g, title, w * 0.5, h * 0.16, {
      font: `900 ${Math.round(40 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudPaper, 1),
      align: 'center',
      skew: 0.12,
      tracking: 5 * s,
    });
    const panel = slantPath(w * 0.2, h * 0.3, w * 0.6, 160 * s, 40 * s);
    plate(g, panel, s, { edge: rgba(HEX.boostHot, 0.95) });
    inkText(g, t.name, w * 0.5, h * 0.4, {
      font: `900 ${Math.round(28 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.boostHot, 1),
      align: 'center',
      skew: 0.1,
    });
    inkText(g, t.blurb.toUpperCase(), w * 0.5, h * 0.46, {
      font: `600 ${Math.round(12 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.foamShade, 1),
      align: 'center',
    });
    const best = this.save.bestTimes[t.id];
    inkText(
      g,
      mode === 'trial' && best != null ? `BEST  ${best.toFixed(2)}s` : `SEA  ${t.theme.seaState.toFixed(2)}×`,
      w * 0.5,
      h * 0.53,
      {
        font: `800 ${Math.round(14 * s)}px ${FONT_STACK}`,
        fill: rgba(HEX.raceLine, 1),
        align: 'center',
      },
    );
    this.hint(g, w, h, s, '←→ TRACK   ENTER START   ESC BACK');
  }

  // ── Results settlement ─────────────────────────────────────────────────────

  settleResults(
    place: number,
    finishTime: number,
    score = 0,
  ): { medal: Medal; coins: number } {
    const session = ACTIVE.session;
    let medal: Medal = 'none';
    let coins = 0;

    if (session.eventKind === 'swellRun') {
      if (session.mode === 'career' && session.eventId) {
        const cup = getCup(session.cupId ?? 'noviceCup');
        const ev = cup.events.find((e) => e.id === session.eventId);
        if (ev) {
          medal = rateEvent(ev, place, finishTime, score);
          if (medal !== 'none') {
            const pay = ev.reward[medal];
            const prev = this.save.medals[ev.id] ?? 'none';
            coins =
              prev === 'none' || medalRank(medal) > medalRank(prev)
                ? pay
                : Math.floor(pay * 0.35);
            this.save.coins += coins;
            if (medalRank(medal) > medalRank(prev)) this.save.medals[ev.id] = medal;
            const idx = session.eventIndex ?? 0;
            const prog = this.save.careerProgress[cup.id] ?? 1;
            if (idx + 1 >= prog) {
              this.save.careerProgress[cup.id] = Math.min(cup.events.length, idx + 2);
            }
          }
        }
      } else {
        medal = rateSwellScore(score, {
          bronze: session.scoreBronze ?? 4.0,
          silver: session.scoreSilver ?? 7.5,
          gold: session.scoreGold ?? 11.5,
          platinum: session.scorePlatinum ?? 15.5,
        });
        coins =
          medal === 'platinum'
            ? 180
            : medal === 'gold'
              ? 120
              : medal === 'silver'
                ? 80
                : medal === 'bronze'
                  ? 50
                  : 20;
        this.save.coins += coins;
      }
      this.persist();
      this.lastPayout =
        coins > 0
          ? `AIR ${score.toFixed(1)}s · +${coins} COIN · ${medalLabel(medal)}`
          : `AIR ${score.toFixed(1)}s · ${medalLabel(medal)}`;
      return { medal, coins };
    }

    if (session.mode === 'career' && session.eventId) {
      const cup = getCup(session.cupId ?? 'noviceCup');
      const ev = cup.events.find((e) => e.id === session.eventId);
      if (ev) {
        medal = rateEvent(ev, place, finishTime, score);
        if (medal !== 'none') {
          const pay = ev.reward[medal];
          const prev = this.save.medals[ev.id] ?? 'none';
          coins =
            prev === 'none' || medalRank(medal) > medalRank(prev)
              ? pay
              : Math.floor(pay * 0.35);
          this.save.coins += coins;
          if (medalRank(medal) > medalRank(prev)) this.save.medals[ev.id] = medal;
          const idx = session.eventIndex ?? 0;
          const prog = this.save.careerProgress[cup.id] ?? 1;
          if (idx + 1 >= prog) {
            this.save.careerProgress[cup.id] = Math.min(cup.events.length, idx + 2);
          }
          if (
            ev.unlockBoat &&
            !this.save.unlockedBoats.includes(ev.unlockBoat) &&
            (medal === 'gold' || medal === 'platinum')
          ) {
            this.save.unlockedBoats.push(ev.unlockBoat);
          }
        }
      }
    } else {
      coins = place === 1 ? 60 : place === 2 ? 40 : 25;
      if (session.mode === 'trial') {
        coins = 40;
        const prev = this.save.bestTimes[session.trackId];
        if (prev == null || finishTime < prev) {
          this.save.bestTimes[session.trackId] = finishTime;
          coins += 40;
        }
      } else if (place === 1) {
        coins = 80;
      }
      this.save.coins += coins;
      medal = place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : 'none';
    }

    this.persist();
    this.lastPayout = coins > 0 ? `+${coins} COIN · ${medalLabel(medal)}` : medalLabel(medal);
    return { medal, coins };
  }

  private sessionFromEvent(ev: CareerEvent, cupId: string, eventIndex: number): RaceSession {
    const track = getTrackDef(ev.trackId);
    return {
      mode: 'career',
      trackId: ev.trackId,
      laps: ev.rules.laps,
      racerCount: ev.rules.racerCount,
      seaState: ev.rules.seaState ?? track.theme.seaState,
      boatClass: this.save.selectedBoat,
      liveryId: this.save.selectedLivery,
      eventId: ev.id,
      eventKind: ev.kind,
      cupId,
      eventIndex,
      durationSec: ev.rules.durationSec,
      scoreBronze: ev.scoreBronze,
      scoreSilver: ev.scoreSilver,
      scoreGold: ev.scoreGold,
      scorePlatinum: ev.scorePlatinum,
    };
  }

  private veil(g: CanvasRenderingContext2D, w: number, h: number, a: number) {
    g.save();
    g.fillStyle = rgba(HEX.ink, a);
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  private hint(g: CanvasRenderingContext2D, w: number, h: number, s: number, text: string) {
    const blink = 0.55 + 0.45 * Math.sin(this.pulse * 4.2);
    inkText(g, text, w * 0.5, h - 40 * s, {
      font: `800 ${Math.round(13 * s)}px ${FONT_STACK}`,
      fill: rgba(HEX.hudPaper, 0.45 + 0.45 * blink),
      align: 'center',
      tracking: 3 * s,
    });
  }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function medalLabel(m: Medal): string {
  if (m === 'none') return 'NO MEDAL';
  return m.toUpperCase();
}

function medalRank(m: Medal): number {
  return { none: 0, bronze: 1, silver: 2, gold: 3, platinum: 4 }[m];
}
