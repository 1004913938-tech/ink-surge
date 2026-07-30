/**
 * PLACEHOLDER — owned by the race subsystem.
 *
 * Spline-following with speed-scaled lookahead. Enough to make a race happen;
 * the race agent replaces it with per-personality behaviour, collision
 * avoidance, deliberate mistakes and rubber-banding.
 */

import { Vector3 } from 'three';
import { CONFIG } from '../core/config';
import { clamp, clamp01 } from '../core/mathx';
import { Rng } from '../core/rng';
import type { GameContext, Racer, Subsystem, TrackAPI } from '../core/types';

const _ahead = new Vector3();
const _toAhead = new Vector3();
const _up = new Vector3(0, 1, 0);

export class AiDrivers implements Subsystem {
  readonly name = 'ai';
  readonly order = 40;

  private rng = new Rng(0xa11ce);
  /** Per-racer preferred lateral offset from the centreline, metres. */
  private laneOffset = new Map<number, number>();

  constructor(
    private racers: Racer[],
    private track: TrackAPI,
  ) {
    for (const r of racers) {
      if (!r.isPlayer) this.laneOffset.set(r.id, this.rng.sym(4.5));
    }
  }

  update(ctx: GameContext) {
    for (const r of this.racers) {
      if (r.isPlayer) continue;
      this.drive(ctx, r);
    }
  }

  private drive(ctx: GameContext, r: Racer) {
    const c = r.controls;
    if (r.finished) {
      c.throttle = 0;
      c.brake = 0.4;
      c.steer *= 0.9;
      return;
    }

    const proj = this.track.project(r.root.position);
    const speed = r.state.velocity.length();

    // Lookahead grows with speed so fast boats commit to a line earlier.
    const lookahead = CONFIG.ai.lookaheadBase + speed * CONFIG.ai.lookaheadPerSpeed;
    const target = this.track.sampleDistance(proj.u * this.track.length + lookahead);

    // Offset the aim point to this racer's preferred lane.
    const right = new Vector3().crossVectors(target.tangent, _up).normalize();
    _ahead.copy(target.position).addScaledVector(right, this.laneOffset.get(r.id) ?? 0);

    // Steer toward the aim point.
    _toAhead.subVectors(_ahead, r.root.position);
    const desiredHeading = Math.atan2(_toAhead.x, _toAhead.z);
    let err = desiredHeading - r.state.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    c.steer = clamp(-err * 1.9, -1, 1);

    // Ease off in tight corners.
    const cornerBrake = clamp01(target.curvature * 0.6);
    c.throttle = clamp01(1 - cornerBrake * 0.55);
    c.brake = 0;
    c.drift = Math.abs(c.steer) > 0.6 && speed > 14;
  }
}
