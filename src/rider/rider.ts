/**
 * PLACEHOLDER — owned by the rider subsystem.
 *
 * A blocked-out segment rig: torso, head, two arms, two legs, parented so a
 * pose can be driven from boat state. The rider agent replaces this with a
 * proper rig, procedurally generated cel-shaded geometry, and an animation
 * state machine (lean, weight shift, throttle work, landing crouch, idle bob,
 * celebration).
 */

import { BoxGeometry, CapsuleGeometry, Group, Mesh, Object3D, SphereGeometry, Vector3 } from 'three';
import { clamp, damp } from '../core/mathx';
import { PAL, RACER_COLORS } from '../core/palette';
import { applyCel, createCelMaterial } from '../render/celMaterial';
import type { GameContext, Racer, Subsystem } from '../core/types';

export interface RiderRig {
  root: Group;
  hips: Object3D;
  torso: Object3D;
  head: Object3D;
  armL: Object3D;
  armR: Object3D;
  legL: Object3D;
  legR: Object3D;
}

export function createRider(racerId: number): RiderRig {
  const colors = RACER_COLORS[racerId];
  const root = new Group();
  root.name = `rider${racerId}`;

  const suit = () =>
    createCelMaterial({ color: colors.suit, outlineWidthPx: 2.0, rimStrength: 0.85, name: 'suit' });
  const skin = () =>
    createCelMaterial({ color: PAL.skin, outlineWidthPx: 1.8, rimStrength: 0.7, name: 'skin' });
  const accent = () =>
    createCelMaterial({ color: colors.hull, outlineWidthPx: 2.0, name: 'helmet' });

  const hips = new Group();
  root.add(hips);

  const torso = new Group();
  const torsoMesh = new Mesh(new CapsuleGeometry(0.19, 0.34, 4, 8));
  applyCel(torsoMesh, suit());
  torsoMesh.position.y = 0.28;
  torso.add(torsoMesh);
  hips.add(torso);

  const head = new Group();
  const helmet = new Mesh(new SphereGeometry(0.155, 12, 10));
  applyCel(helmet, accent());
  head.add(helmet);
  head.position.y = 0.62;
  torso.add(head);

  const mkArm = (side: number) => {
    const arm = new Group();
    const upper = new Mesh(new CapsuleGeometry(0.055, 0.2, 3, 6));
    applyCel(upper, suit());
    upper.position.y = -0.12;
    arm.add(upper);
    const fore = new Mesh(new CapsuleGeometry(0.048, 0.19, 3, 6));
    applyCel(fore, skin());
    fore.position.y = -0.33;
    arm.add(fore);
    arm.position.set(side * 0.2, 0.48, 0);
    torso.add(arm);
    return arm;
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  const mkLeg = (side: number) => {
    const leg = new Group();
    const thigh = new Mesh(new CapsuleGeometry(0.075, 0.22, 3, 6));
    applyCel(thigh, suit());
    thigh.position.y = -0.14;
    leg.add(thigh);
    const shin = new Mesh(new CapsuleGeometry(0.062, 0.22, 3, 6));
    applyCel(shin, suit());
    shin.position.y = -0.38;
    leg.add(shin);
    leg.position.set(side * 0.1, 0.02, 0);
    hips.add(leg);
    return leg;
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  return { root, hips, torso, head, armL, armR, legL, legR };
}

/** Drives every rider's pose from its boat's state. */
export class Riders implements Subsystem {
  readonly name = 'riders';
  readonly order = 60;

  private rigs = new Map<number, RiderRig>();

  constructor(racers: Racer[]) {
    for (const r of racers) {
      const rig = createRider(r.id);
      rig.root.position.set(0, 0.62, -0.45);
      r.root.add(rig.root);
      this.rigs.set(r.id, rig);
    }
  }

  update(ctx: GameContext) {
    for (const r of ctx.racers) {
      const rig = this.rigs.get(r.id);
      if (!rig) continue;
      const s = r.state;
      const dt = ctx.dt;

      // Lean into the turn — counter-rotate the torso against the hull roll so
      // the rider looks like they are balancing, not welded to the deck.
      const lean = clamp(-s.lateralSpeed * 0.05, -0.5, 0.5);
      rig.torso.rotation.z = damp(rig.torso.rotation.z, lean, 7, dt);
      rig.torso.rotation.x = damp(
        rig.torso.rotation.x,
        0.16 + s.speedFrac * 0.3 - (s.airborne ? 0.2 : 0),
        6,
        dt,
      );

      // Crouch on landings and while airborne.
      const crouch = s.airborne ? 0.1 : clamp(s.landingImpact * 0.02, 0, 0.16);
      rig.hips.position.y = damp(rig.hips.position.y, -crouch, 9, dt);

      // Idle bob synced to the hull's vertical motion.
      const bob = Math.sin(ctx.time * 2.2 + r.id) * 0.012;
      rig.head.rotation.x = damp(rig.head.rotation.x, -rig.torso.rotation.x * 0.7 + bob, 5, dt);

      // Arms work the throttle.
      const reach = -0.9 - s.appliedThrottle * 0.25;
      rig.armL.rotation.x = damp(rig.armL.rotation.x, reach, 6, dt);
      rig.armR.rotation.x = damp(rig.armR.rotation.x, reach, 6, dt);
      rig.armL.rotation.z = damp(rig.armL.rotation.z, 0.3 + lean * 0.4, 6, dt);
      rig.armR.rotation.z = damp(rig.armR.rotation.z, -0.3 + lean * 0.4, 6, dt);

      // Knees absorb.
      rig.legL.rotation.x = damp(rig.legL.rotation.x, -0.7 - crouch * 2, 7, dt);
      rig.legR.rotation.x = damp(rig.legR.rotation.x, -0.7 - crouch * 2, 7, dt);
    }
  }
}
