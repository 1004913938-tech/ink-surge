/**
 * PLACEHOLDER — owned by the boat subsystem.
 *
 * This is a walking-skeleton implementation: a crude hull, a real buoyancy
 * solver against the Gerstner field, and arcade handling good enough to prove
 * the loop. The boat agent replaces this file wholesale with proper hull
 * geometry, a tuned handling model, drift/boost, and landing impacts.
 *
 * What must be preserved: the `Racer` interface from core/types, and the rule
 * that AI and player drive through the *same* `controls` struct.
 */

import { BoxGeometry, Group, Object3D, Vector3 } from 'three';
import { CONFIG } from '../core/config';
import { createInputState } from '../core/input';
import { clamp, clamp01, damp } from '../core/mathx';
import { PAL, RACER_COLORS } from '../core/palette';
import { applyCel, createCelMaterial } from '../render/celMaterial';
import { Mesh } from 'three';
import type { BoatState, GameContext, Racer, RacerId, Subsystem } from '../core/types';
import type { OceanSample } from '../water/gerstner';

const RACER_NAMES = ['YOU', 'KAIRA', 'NOX', 'PIP'];
const PERSONALITIES = [null, 'aggressive', 'clean', 'erratic'] as const;

function createHull(id: number): Group {
  const g = new Group();
  const colors = RACER_COLORS[id];

  // Crude proxy shapes. Replaced by the boat agent.
  const hull = new Mesh(new BoxGeometry(CONFIG.boat.beam, 0.62, CONFIG.boat.length));
  applyCel(hull, createCelMaterial({ color: colors.hull, outlineWidthPx: 2.6, name: `hull${id}` }));
  hull.position.y = 0.1;
  g.add(hull);

  const deck = new Mesh(new BoxGeometry(CONFIG.boat.beam * 0.72, 0.3, CONFIG.boat.length * 0.44));
  applyCel(deck, createCelMaterial({ color: PAL.foamShade, outlineWidthPx: 2.2, name: `deck${id}` }));
  deck.position.set(0, 0.5, -0.35);
  g.add(deck);

  return g;
}

export function createRacer(id: RacerId, position: Vector3, heading: number): Racer {
  const root = new Group();
  root.name = `racer${id}`;
  root.position.copy(position);
  root.add(createHull(id));

  const state: BoatState = {
    position: root.position,
    velocity: new Vector3(),
    heading,
    forwardSpeed: 0,
    lateralSpeed: 0,
    speedFrac: 0,
    pitch: 0,
    roll: 0,
    airborne: false,
    airTime: 0,
    landingImpact: 0,
    drifting: false,
    driftCharge: 0,
    driftTier: 0,
    boostTime: 0,
    boostMeter: 0,
    appliedThrottle: 0,
  };

  return {
    id,
    isPlayer: id === 0,
    name: RACER_NAMES[id],
    root,
    state,
    controls: createInputState(),
    personality: PERSONALITIES[id] as Racer['personality'],
    lap: 0,
    nextCheckpoint: 0,
    progress: 0,
    place: id + 1,
    finished: false,
    finishTime: 0,
    lapTimes: [],
    bestLap: Infinity,
    wrongWay: false,
  };
}

/** Hull probe offsets in local space, used for buoyancy. */
const PROBES: Vector3[] = [
  new Vector3(0, 0, CONFIG.boat.length * 0.46),
  new Vector3(0, 0, -CONFIG.boat.length * 0.46),
  new Vector3(CONFIG.boat.beam * 0.5, 0, CONFIG.boat.length * 0.2),
  new Vector3(-CONFIG.boat.beam * 0.5, 0, CONFIG.boat.length * 0.2),
  new Vector3(CONFIG.boat.beam * 0.5, 0, -CONFIG.boat.length * 0.2),
  new Vector3(-CONFIG.boat.beam * 0.5, 0, -CONFIG.boat.length * 0.2),
];

const _probeWorld = new Vector3();
const _sample: OceanSample = {
  position: new Vector3(),
  normal: new Vector3(0, 1, 0),
  height: 0,
  jacobian: 1,
};

export class BoatPhysics implements Subsystem {
  readonly name = 'boatPhysics';
  readonly order = 30;

  constructor(private racers: Racer[]) {}

  update(ctx: GameContext) {
    for (const r of this.racers) this.step(ctx, r);
  }

  private step(ctx: GameContext, racer: Racer) {
    const { dt, time } = ctx;
    const s = racer.state;
    const c = racer.controls;
    const cfg = CONFIG.boat;

    // ── Steering ────────────────────────────────────────────────────────────
    // Turn authority falls off with speed so the boat feels heavy at pace.
    const speedT = clamp01(Math.abs(s.forwardSpeed) / cfg.topSpeed);
    const turnRate = cfg.turnRateLow + (cfg.turnRateHigh - cfg.turnRateLow) * speedT;
    // Only steer with water under the hull.
    const authority = s.airborne ? 0.18 : 1;
    s.heading -= c.steer * turnRate * authority * dt * clamp01(0.25 + speedT * 1.4);

    // ── Longitudinal ────────────────────────────────────────────────────────
    const fwd = new Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
    const right = new Vector3(fwd.z, 0, -fwd.x);

    s.appliedThrottle = c.throttle;
    const boosting = s.boostTime > 0;
    let accel = c.throttle * (cfg.thrust / cfg.mass);
    if (boosting) accel += cfg.boostForce / cfg.mass;
    accel -= c.brake * (cfg.reverseThrust / cfg.mass);
    if (s.airborne) accel *= 0.15;

    s.velocity.addScaledVector(fwd, accel * dt);

    // Drag, quadratic above a threshold so top speed is well-defined.
    const speed = s.velocity.length();
    const top = boosting ? cfg.boostTopSpeed : cfg.topSpeed;
    const drag = 0.42 + Math.max(0, speed - top * 0.85) * 0.42;
    s.velocity.addScaledVector(s.velocity, -drag * dt);

    // ── Lateral grip ────────────────────────────────────────────────────────
    s.drifting = c.drift && speed > 6 && Math.abs(c.steer) > 0.25 && !s.airborne;
    const grip = s.drifting ? cfg.driftGrip : cfg.lateralGrip;
    const lateral = s.velocity.dot(right);
    s.velocity.addScaledVector(right, -lateral * clamp01(grip * dt));
    s.lateralSpeed = lateral;

    // ── Drift charge → boost ────────────────────────────────────────────────
    if (s.drifting) {
      s.driftCharge += dt;
      let tier = 0;
      for (let i = 0; i < cfg.driftTiers.length; i++) if (s.driftCharge >= cfg.driftTiers[i]) tier = i + 1;
      s.driftTier = tier;
      s.boostMeter = clamp01(s.driftCharge / cfg.driftTiers[cfg.driftTiers.length - 1]);
    } else {
      if (s.driftTier > 0) {
        s.boostTime = cfg.boostDuration[s.driftTier - 1];
        ctx.audio.boost();
      }
      s.driftCharge = 0;
      s.driftTier = 0;
      s.boostMeter = damp(s.boostMeter, s.boostTime > 0 ? 1 : 0, 4, dt);
    }
    s.boostTime = Math.max(0, s.boostTime - dt);

    // ── Integrate ───────────────────────────────────────────────────────────
    racer.root.position.addScaledVector(s.velocity, dt);
    s.forwardSpeed = s.velocity.dot(fwd);
    s.speedFrac = clamp01(speed / cfg.boostTopSpeed);

    // ── Buoyancy ────────────────────────────────────────────────────────────
    // Sample the real wave field at each hull probe and accumulate a vertical
    // force plus a pitch/roll torque. This is what makes the hull slam into
    // troughs instead of gliding.
    let sumHeight = 0;
    let pitchTorque = 0;
    let rollTorque = 0;
    let submerged = 0;

    for (const p of PROBES) {
      _probeWorld
        .copy(p)
        .applyAxisAngle(new Vector3(0, 1, 0), s.heading)
        .add(racer.root.position);
      const surf = ctx.ocean.sample(_probeWorld.x, _probeWorld.z, time, _sample);
      const depth = surf.height - _probeWorld.y;
      sumHeight += surf.height;
      if (depth > 0) {
        submerged++;
        pitchTorque += depth * p.z;
        rollTorque += depth * p.x;
      }
    }
    const avgHeight = sumHeight / PROBES.length;
    const submergedFrac = submerged / PROBES.length;

    // Vertical spring toward the average surface height.
    const targetY = avgHeight + 0.22;
    const dy = targetY - racer.root.position.y;
    s.velocity.y += dy * CONFIG.boat.buoyancy * dt;
    s.velocity.y -= s.velocity.y * CONFIG.boat.buoyancyDamping * dt * submergedFrac;
    s.velocity.y -= 9.81 * dt * (1 - submergedFrac);

    // Airborne + landing detection.
    const wasAirborne = s.airborne;
    s.airborne = racer.root.position.y - avgHeight > CONFIG.boat.airborneThreshold;
    s.landingImpact = 0;
    if (wasAirborne && !s.airborne) {
      s.landingImpact = Math.max(0, -s.velocity.y);
      if (s.landingImpact > 1.5) {
        ctx.cameraRig.addShake(clamp01(s.landingImpact / 14) * 0.75);
        ctx.audio.impact(clamp01(s.landingImpact / 14));
      }
      s.airTime = 0;
    }
    if (s.airborne) s.airTime += dt;

    // ── Attitude ────────────────────────────────────────────────────────────
    const targetPitch = clamp(-pitchTorque * 0.09, -0.42, 0.42) - s.speedFrac * 0.06;
    const targetRoll =
      clamp(rollTorque * 0.09, -0.4, 0.4) + clamp(-s.lateralSpeed * 0.035, -0.35, 0.35);
    s.pitch = damp(s.pitch, s.airborne ? -0.14 : targetPitch, 6, dt);
    s.roll = damp(s.roll, targetRoll, 5.2, dt);

    racer.root.rotation.set(0, 0, 0);
    racer.root.rotateY(s.heading);
    racer.root.rotateX(s.pitch);
    racer.root.rotateZ(s.roll);
  }
}
