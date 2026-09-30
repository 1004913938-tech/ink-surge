/**
 * Mario-style item boxes for standard races.
 *
 * Three items only (first slice):
 *   surge  — short boost burst
 *   ink    — drop a hazard behind you
 *   shield — absorb one hazard hit
 */

import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  Vector3,
} from 'three';
import { ACTIVE, isSwellRun } from '../core/activeRace';
import { PAL } from '../core/palette';
import { clamp01 } from '../core/mathx';
import { applyCel, createCelMaterial } from '../render/celMaterial';
import type { GameContext, Racer, Subsystem, TrackPoint } from '../core/types';
import type { Track } from './track';

export type ItemKind = 'surge' | 'ink' | 'shield';

export interface ItemHudView {
  enabled: boolean;
  held: ItemKind | null;
  shield: number;
  pickupFlash: number;
  tip: boolean;
}

const BOX_COUNT = 8;
const PICK_RADIUS = 4.2;
const RESPAWN = 9.0;
const SURGE_TIME = 1.85;
const SHIELD_TIME = 5.0;
const STUN_TIME = 1.35;
const INK_LIFE = 9.0;
const INK_RADIUS = 3.4;

const ITEM_POOL: ItemKind[] = ['surge', 'ink', 'shield', 'surge', 'ink', 'shield', 'surge'];

export function itemsEnabledForSession(): boolean {
  if (isSwellRun()) return false;
  const k = ACTIVE.session.eventKind;
  // Standard / elimination races with a field. Solo time trial stays clean.
  return (k === 'standard' || k === 'elimination') && ACTIVE.session.racerCount > 1;
}

interface BoxSlot {
  mesh: Mesh;
  u: number;
  lateral: number;
  alive: boolean;
  respawn: number;
}

interface InkHazard {
  mesh: Mesh;
  life: number;
  x: number;
  z: number;
}

interface RacerBag {
  held: ItemKind | null;
  shield: number;
  stun: number;
  aiDelay: number;
  pickupFlash: number;
}

const _tp: TrackPoint = {
  position: new Vector3(),
  tangent: new Vector3(0, 0, 1),
  curvature: 0,
  u: 0,
};

export class ItemSystem implements Subsystem {
  readonly name = 'items';
  readonly order = 52;

  readonly group = new Group();
  private boxes: BoxSlot[] = [];
  private hazards: InkHazard[] = [];
  private bags = new Map<number, RacerBag>();
  private track: Track;
  private tipTimer = 0;
  private tipShown = false;
  private enabled = false;

  constructor(track: Track, private racers: Racer[]) {
    this.track = track;
    this.group.name = 'itemSystem';
    for (const r of racers) this.bags.set(r.id, blankBag());
  }

  setTrack(track: Track) {
    this.track = track;
    this.rebuildBoxes();
  }

  reset() {
    this.enabled = itemsEnabledForSession();
    this.tipTimer = 0;
    this.tipShown = false;
    for (const r of this.racers) this.bags.set(r.id, blankBag());
    for (const h of this.hazards) {
      this.group.remove(h.mesh);
      h.mesh.geometry.dispose();
    }
    this.hazards.length = 0;
    if (this.enabled) this.rebuildBoxes();
    else this.hideAllBoxes();
    // Never show boxes on the hub — only during countdown / race.
    this.group.visible = false;
  }

  view(): ItemHudView {
    const bag = this.bags.get(0)!;
    return {
      enabled: this.enabled,
      held: bag.held,
      shield: bag.shield,
      pickupFlash: bag.pickupFlash,
      tip: this.enabled && this.tipShown && this.tipTimer < 3.4,
    };
  }

  update(ctx: GameContext) {
    if (!this.enabled) {
      this.group.visible = false;
      return;
    }
    const phase = ctx.race.phase;
    const live = phase === 'racing' || phase === 'countdown';
    this.group.visible = live;
    if (!live) return;

    this.bobBoxes(ctx);
    if (phase === 'countdown') return;

    if (!this.tipShown) {
      this.tipShown = true;
      this.tipTimer = 0;
    }
    this.tipTimer += ctx.dt;

    this.tickRespawn(ctx.dt);
    this.pickups(ctx);
    this.useItems(ctx);
    this.aiUse(ctx);
    this.tickHazards(ctx);
    this.applyStun(ctx);
    this.tickBags(ctx.dt);
  }

  dispose() {
    for (const b of this.boxes) {
      b.mesh.geometry.dispose();
    }
    for (const h of this.hazards) {
      h.mesh.geometry.dispose();
    }
    this.group.clear();
  }

  // ── Build ────────────────────────────────────────────────────────────────

  private rebuildBoxes() {
    for (const b of this.boxes) {
      this.group.remove(b.mesh);
      b.mesh.geometry.dispose();
    }
    this.boxes = [];
    const L = this.track.length;
    for (let i = 0; i < BOX_COUNT; i++) {
      const u = (i + 0.55) / BOX_COUNT;
      const lateral = i % 2 === 0 ? 5.5 : -5.5;
      const mesh = makeBoxMesh(PAL.buoy);
      mesh.name = `itemBox${i}`;
      this.group.add(mesh);
      this.boxes.push({ mesh, u, lateral, alive: true, respawn: 0 });
      this.placeBox(this.boxes[i], 0);
    }
  }

  private hideAllBoxes() {
    for (const b of this.boxes) {
      b.alive = false;
      b.mesh.visible = false;
    }
  }

  private placeBox(b: BoxSlot, t: number) {
    const tp = this.track.sample(b.u, _tp);
    const rx = tp.tangent.z;
    const rz = -tp.tangent.x;
    const x = tp.position.x + rx * b.lateral;
    const z = tp.position.z + rz * b.lateral;
    b.mesh.position.set(x, 1.2, z);
    void t;
  }

  private bobBoxes(ctx: GameContext) {
    for (const b of this.boxes) {
      if (!b.alive) {
        b.mesh.visible = false;
        continue;
      }
      b.mesh.visible = true;
      const tp = this.track.sample(b.u, _tp);
      const rx = tp.tangent.z;
      const rz = -tp.tangent.x;
      const x = tp.position.x + rx * b.lateral;
      const z = tp.position.z + rz * b.lateral;
      const y = ctx.ocean.height(x, z, ctx.time) + 1.15 + Math.sin(ctx.time * 3.2 + b.u * 20) * 0.18;
      b.mesh.position.set(x, y, z);
      b.mesh.rotation.y = ctx.time * 1.6 + b.u * 8;
      const pulse = 0.85 + 0.15 * Math.sin(ctx.time * 5 + b.u * 10);
      b.mesh.scale.setScalar(pulse);
    }
  }

  private tickRespawn(dt: number) {
    for (const b of this.boxes) {
      if (b.alive) continue;
      b.respawn -= dt;
      if (b.respawn <= 0) {
        b.alive = true;
        b.mesh.visible = true;
      }
    }
  }

  // ── Pickup / use ─────────────────────────────────────────────────────────

  private pickups(ctx: GameContext) {
    for (const r of this.racers) {
      if (!r.root.visible || r.finished) continue;
      const bag = this.bags.get(r.id)!;
      if (bag.held) continue;
      const px = r.root.position.x;
      const pz = r.root.position.z;
      for (const b of this.boxes) {
        if (!b.alive) continue;
        const dx = b.mesh.position.x - px;
        const dz = b.mesh.position.z - pz;
        if (dx * dx + dz * dz > PICK_RADIUS * PICK_RADIUS) continue;
        b.alive = false;
        b.respawn = RESPAWN;
        b.mesh.visible = false;
        bag.held = rollItem(r.place);
        bag.pickupFlash = 1;
        bag.aiDelay = 0.8 + Math.random() * 2.2;
        if (r.isPlayer) {
          ctx.audio.checkpoint();
          ctx.cameraRig.addShake(0.06);
        }
        break;
      }
    }
  }

  private useItems(ctx: GameContext) {
    const player = ctx.player;
    if (!player.root.visible || player.finished) return;
    if (!ctx.input.itemPressed) return;
    this.fire(ctx, player);
  }

  private aiUse(ctx: GameContext) {
    for (const r of this.racers) {
      if (r.isPlayer || !r.root.visible || r.finished) continue;
      const bag = this.bags.get(r.id)!;
      if (!bag.held) continue;
      bag.aiDelay -= ctx.dt;
      if (bag.aiDelay > 0) continue;
      // Simple: surge if behind, ink if ahead of someone close, else shield/surge.
      const kind = bag.held;
      if (kind === 'surge' && r.place > 1) this.fire(ctx, r);
      else if (kind === 'ink' && someoneBehind(r, this.racers)) this.fire(ctx, r);
      else if (kind === 'shield' && r.place === 1) this.fire(ctx, r);
      else if (bag.aiDelay < -1.5) this.fire(ctx, r);
    }
  }

  private fire(ctx: GameContext, r: Racer) {
    const bag = this.bags.get(r.id)!;
    const kind = bag.held;
    if (!kind) return;
    bag.held = null;
    if (kind === 'surge') {
      r.state.boostTime = Math.max(r.state.boostTime, SURGE_TIME);
      r.state.boostMeter = 1;
      ctx.audio.boost();
      if (r.isPlayer) ctx.cameraRig.addShake(0.14);
    } else if (kind === 'shield') {
      bag.shield = SHIELD_TIME;
      if (r.isPlayer) ctx.audio.horn(1.15);
    } else if (kind === 'ink') {
      this.spawnInk(ctx, r);
      if (r.isPlayer) ctx.audio.impact(0.35);
    }
  }

  private spawnInk(ctx: GameContext, r: Racer) {
    const hdg = r.state.heading;
    const back = 6.5;
    const x = r.root.position.x - Math.sin(hdg) * back;
    const z = r.root.position.z - Math.cos(hdg) * back;
    const mesh = makeInkMesh();
    const y = ctx.ocean.height(x, z, ctx.time) + 0.55;
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    this.hazards.push({ mesh, life: INK_LIFE, x, z });
  }

  private tickHazards(ctx: GameContext) {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= ctx.dt;
      h.mesh.position.y = ctx.ocean.height(h.x, h.z, ctx.time) + 0.55;
      h.mesh.rotation.y += ctx.dt * 2.4;
      const fade = clamp01(h.life / 1.2);
      h.mesh.scale.setScalar(0.9 + 0.25 * Math.sin(ctx.time * 6) * fade);

      for (const r of this.racers) {
        if (!r.root.visible || r.finished) continue;
        const dx = r.root.position.x - h.x;
        const dz = r.root.position.z - h.z;
        if (dx * dx + dz * dz > INK_RADIUS * INK_RADIUS) continue;
        const bag = this.bags.get(r.id)!;
        // Consume hazard.
        this.group.remove(h.mesh);
        h.mesh.geometry.dispose();
        this.hazards.splice(i, 1);
        if (bag.shield > 0) {
          bag.shield = 0;
          if (r.isPlayer) ctx.audio.horn(1.3);
        } else {
          bag.stun = STUN_TIME;
          r.state.velocity.multiplyScalar(0.45);
          r.state.boostTime = 0;
          ctx.audio.impact(0.7);
          if (r.isPlayer) ctx.cameraRig.addShake(0.22);
        }
        break;
      }

      if (h.life <= 0 && this.hazards[i] === h) {
        this.group.remove(h.mesh);
        h.mesh.geometry.dispose();
        this.hazards.splice(i, 1);
      }
    }
  }

  private applyStun(ctx: GameContext) {
    for (const r of this.racers) {
      const bag = this.bags.get(r.id)!;
      if (bag.stun <= 0) continue;
      r.controls.throttle = 0;
      r.controls.brake = 0.15;
      r.controls.steer = Math.sin(ctx.time * 18 + r.id) * 0.85;
      r.controls.drift = false;
    }
  }

  private tickBags(dt: number) {
    for (const bag of this.bags.values()) {
      bag.shield = Math.max(0, bag.shield - dt);
      bag.stun = Math.max(0, bag.stun - dt);
      bag.pickupFlash = Math.max(0, bag.pickupFlash - dt * 2.2);
    }
  }
}

function blankBag(): RacerBag {
  return { held: null, shield: 0, stun: 0, aiDelay: 0, pickupFlash: 0 };
}

function rollItem(place: number): ItemKind {
  // Slight rubber-band: last place more likely to get surge.
  if (place >= 3 && Math.random() < 0.45) return 'surge';
  if (place === 1 && Math.random() < 0.4) return 'ink';
  return ITEM_POOL[(Math.random() * ITEM_POOL.length) | 0];
}

function someoneBehind(r: Racer, all: Racer[]): boolean {
  for (const o of all) {
    if (o.id === r.id || !o.root.visible) continue;
    if (o.progress < r.progress && r.progress - o.progress < 0.12) return true;
  }
  return false;
}

function makeBoxMesh(color: Color): Mesh {
  const geo = new BoxGeometry(1.6, 1.6, 1.6);
  const set = createCelMaterial({
    color,
    rimColor: PAL.boostHot,
    rimStrength: 0.85,
    outlineWidthPx: 2.2,
  });
  const mesh = new Mesh(geo);
  applyCel(mesh, set);
  return mesh;
}

function makeInkMesh(): Mesh {
  const geo = new BoxGeometry(2.4, 0.9, 2.4);
  const set = createCelMaterial({
    color: PAL.inkSoft,
    rimColor: PAL.boost,
    rimStrength: 0.7,
    outlineWidthPx: 2.0,
  });
  const mesh = new Mesh(geo);
  applyCel(mesh, set);
  return mesh;
}
