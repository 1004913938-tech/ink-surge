/**
 * Swell Run — timed airborne scoring, not lap racing.
 *
 * Score = cumulative seconds where `player.state.airborne` is latched true.
 * Longest single hop is tracked for the results board only.
 */

import { ACTIVE, isSwellRun } from '../core/activeRace';
import type { GameContext, RacePhase, Subsystem } from '../core/types';
import type { RaceState } from './raceState';

export interface SwellRunSnapshot {
  active: boolean;
  /** Seconds remaining on the clock. */
  timeLeft: number;
  /** Session length. */
  duration: number;
  /** Cumulative airborne seconds (the score). */
  score: number;
  /** Longest continuous airborne latch, seconds. */
  bestHop: number;
  /** Current hop air time while latched, else 0. */
  currentHop: number;
  /** One-shot tip until dismissed. */
  showTip: boolean;
  finished: boolean;
}

export class SwellRun implements Subsystem {
  readonly name = 'swellRun';
  /** After raceState (50) so phase transitions are visible; before HUD. */
  readonly order = 55;

  private duration = 75;
  private elapsed = 0;
  private score = 0;
  private bestHop = 0;
  private hopAccum = 0;
  private wasAirborne = false;
  private tipTimer = 0;
  private tipShown = false;
  private ended = false;
  private endFlash = 0;

  constructor(private race: RaceState) {}

  reset() {
    this.duration = ACTIVE.session.durationSec ?? 75;
    this.elapsed = 0;
    this.score = 0;
    this.bestHop = 0;
    this.hopAccum = 0;
    this.wasAirborne = false;
    this.tipTimer = 0;
    this.tipShown = false;
    this.ended = false;
    this.endFlash = 0;
  }

  snapshot(): SwellRunSnapshot {
    return {
      active: isSwellRun(),
      timeLeft: Math.max(0, this.duration - this.elapsed),
      duration: this.duration,
      score: this.score,
      bestHop: this.bestHop,
      currentHop: this.wasAirborne ? this.hopAccum : 0,
      showTip: this.tipShown && this.tipTimer < 3.2,
      finished: this.ended,
    };
  }

  update(ctx: GameContext) {
    if (!isSwellRun()) return;

    const phase: RacePhase = this.race.phase;

    if (phase === 'countdown') {
      // Keep scoreboard zeroed until GO.
      if (this.elapsed !== 0 || this.score !== 0) this.reset();
      return;
    }

    if (phase === 'racing') {
      if (!this.tipShown) {
        this.tipShown = true;
        this.tipTimer = 0;
      }
      this.tipTimer += ctx.dt;

      if (this.ended) return;

      this.elapsed += ctx.dt;
      const air = ctx.player.state.airborne;
      if (air) {
        this.score += ctx.dt;
        this.hopAccum += ctx.dt;
        if (this.hopAccum > this.bestHop) this.bestHop = this.hopAccum;
        this.wasAirborne = true;
      } else if (this.wasAirborne) {
        this.hopAccum = 0;
        this.wasAirborne = false;
      }

      if (this.elapsed >= this.duration) {
        this.ended = true;
        this.endFlash = 0;
        ctx.player.finished = true;
        ctx.player.finishTime = this.score; // stash score for settlement bridge
        ctx.player.place = 1;
        ctx.audio.horn(0.9);
        this.race.forceFinished();
      }
      return;
    }

    if (phase === 'finished') {
      this.endFlash += ctx.dt;
    }
  }
}
