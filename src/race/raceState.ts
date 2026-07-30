/**
 * Race flow: countdown → racing → finished → results.
 *
 * Also owns progress tracking, which is subtler than it looks. Position in the
 * field is ranked by a *monotonic* progress scalar — laps completed plus the
 * fraction of the lap covered — rather than by distance to the next gate. A
 * distance-based rank flickers wildly whenever two boats straddle a gate, and
 * an un-wrapped spline parameter jumps by a full lap at the start/finish line.
 */

import { Vector3 } from 'three';
import { CONFIG } from '../core/config';
import { clamp01 } from '../core/mathx';
import type { GameContext, Racer, RaceAPI, RacePhase, Subsystem, TrackAPI } from '../core/types';

const _toGate = new Vector3();
const _up = new Vector3(0, 1, 0);

interface RacerProgress {
  /** Last known lap fraction, used to detect the start/finish wrap. */
  lastU: number;
  /** Distance travelled along the spline this lap, metres. */
  lapDistance: number;
  lapStartTime: number;
}

export class RaceState implements RaceAPI, Subsystem {
  readonly name = 'raceState';
  readonly order = 50;

  phase: RacePhase = 'countdown';
  raceTime = -CONFIG.race.countdownSeconds;
  countdownNumber = 3;

  readonly racers: Racer[];
  readonly player: Racer;

  private progressData = new Map<number, RacerProgress>();
  private finishOrder: Racer[] = [];
  private resultsTimer = 0;
  private lastCountdownBeep = 99;

  constructor(
    racers: Racer[],
    private track: TrackAPI,
    private onRestart: () => void,
  ) {
    this.racers = racers;
    this.player = racers.find((r) => r.isPlayer)!;
    this.resetProgress();
  }

  private resetProgress() {
    this.progressData.clear();
    for (const r of this.racers) {
      const proj = this.track.project(r.root.position);
      this.progressData.set(r.id, { lastU: proj.u, lapDistance: 0, lapStartTime: 0 });
    }
  }

  restart() {
    this.phase = 'countdown';
    this.raceTime = -CONFIG.race.countdownSeconds;
    this.countdownNumber = 3;
    this.finishOrder = [];
    this.resultsTimer = 0;
    this.lastCountdownBeep = 99;
    this.onRestart();
    this.resetProgress();
  }

  standings(): Racer[] {
    // Finished racers hold their finishing order; the rest sort by progress.
    return [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
  }

  update(ctx: GameContext) {
    const { dt } = ctx;

    switch (this.phase) {
      case 'countdown': {
        this.raceTime += dt;
        const n = Math.max(0, Math.ceil(-this.raceTime));
        this.countdownNumber = n;
        if (n < this.lastCountdownBeep) {
          this.lastCountdownBeep = n;
          // Rising pitch on 3-2-1, a different, louder tone on GO.
          ctx.audio.horn(n === 0 ? 1.0 : 0.55 + (3 - n) * 0.08);
        }
        // Throttle is locked out until the lights change.
        for (const r of this.racers) {
          r.controls.throttle = 0;
          r.controls.brake = 0;
          r.controls.steer = 0;
        }
        if (this.raceTime >= 0) {
          this.phase = 'racing';
          this.countdownNumber = -1;
          for (const r of this.racers) {
            const d = this.progressData.get(r.id)!;
            d.lapStartTime = 0;
          }
        }
        break;
      }

      case 'racing': {
        this.raceTime += dt;
        for (const r of this.racers) this.trackProgress(ctx, r);
        this.assignPlaces();
        if (this.racers.every((r) => r.finished)) {
          this.phase = 'finished';
          this.resultsTimer = 0;
        }
        break;
      }

      case 'finished': {
        this.raceTime += dt;
        this.resultsTimer += dt;
        // Hold on the finish for a beat before the results board slides in.
        if (this.resultsTimer > 2.2) this.phase = 'results';
        break;
      }

      case 'results': {
        this.resultsTimer += dt;
        if (ctx.input.restartPressed || ctx.input.startPressed) this.restart();
        break;
      }
    }
  }

  /** Advance a racer's lap fraction, detect gate passes and lap completions. */
  private trackProgress(ctx: GameContext, r: Racer) {
    if (r.finished) return;
    const d = this.progressData.get(r.id)!;
    const proj = this.track.project(r.root.position);

    // Signed step in lap fraction, unwrapped across the start/finish seam.
    let du = proj.u - d.lastU;
    if (du > 0.5) du -= 1;
    if (du < -0.5) du += 1;
    d.lastU = proj.u;
    d.lapDistance += du * this.track.length;

    r.progress = r.lap + clamp01(d.lapDistance / this.track.length);

    // ── Wrong-way detection ────────────────────────────────────────────────
    // Compare heading against the spline tangent, but only above a speed
    // threshold — a stationary boat rocking on the swell would otherwise
    // trigger the warning constantly.
    const speed = r.state.velocity.length();
    if (speed > 3.5) {
      const tp = this.track.sample(proj.u);
      const dot = r.state.velocity.dot(tp.tangent) / speed;
      r.wrongWay = dot < CONFIG.race.wrongWayDot;
    } else if (speed < 1.0) {
      r.wrongWay = false;
    }

    // ── Checkpoints ────────────────────────────────────────────────────────
    const cp = this.track.checkpoints[r.nextCheckpoint];
    _toGate.subVectors(r.root.position, cp.position);
    _toGate.y = 0;
    if (_toGate.length() < cp.halfWidth * 1.6 && _toGate.dot(cp.forward) > -1.5) {
      r.nextCheckpoint++;
      if (r.isPlayer) ctx.audio.checkpoint();

      if (r.nextCheckpoint >= this.track.checkpoints.length) {
        r.nextCheckpoint = 0;
        this.completeLap(ctx, r, d);
      }
    }
  }

  private completeLap(ctx: GameContext, r: Racer, d: RacerProgress) {
    const lapTime = this.raceTime - d.lapStartTime;
    d.lapStartTime = this.raceTime;
    d.lapDistance = 0;
    r.lapTimes.push(lapTime);
    if (lapTime < r.bestLap) r.bestLap = lapTime;
    r.lap++;

    if (r.lap >= CONFIG.race.laps) {
      r.finished = true;
      r.finishTime = this.raceTime;
      this.finishOrder.push(r);
      r.place = this.finishOrder.length;
      if (r.isPlayer) ctx.audio.horn(0.85);
    }
  }

  private assignPlaces() {
    const sorted = this.standings();
    for (let i = 0; i < sorted.length; i++) {
      if (!sorted[i].finished) sorted[i].place = i + 1;
    }
  }
}
