/**
 * Chase camera.
 *
 * Spring-damped position and look-at, FOV that opens with speed, and an
 * impulse-driven shake for slams. Also hosts the fixed presets the screenshot
 * harness drives, so every captured frame comes from a real in-game camera
 * rather than a bespoke debug view.
 *
 * The rig deliberately lags the boat in *yaw* more than in position: snapping
 * the camera to the boat's heading during a powerslide hides the slide, which
 * is the thing that makes drifting feel good. Letting the camera trail means
 * you see the hull rotate away from its direction of travel.
 */

import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CONFIG } from '../core/config';
import { clamp, clamp01, damp, dampAngle, lerp } from '../core/mathx';
import type { CameraRig, GameContext } from '../core/types';

export type CameraMode = 'chase' | 'orbit' | 'cinematic' | 'far' | 'bow';

/** Fixed rigs the harness can request by name. */
export type CameraPreset =
  | 'chase' | 'far' | 'bow' | 'wake' | 'rider'
  | 'orbit_near' | 'far_boat' | 'broadcast' | 'aerial' | 'sky' | 'auto';

const _target = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();
const _fwd = new Vector3();
const _tmp = new Vector3();

export class ChaseCamera implements CameraRig {
  readonly camera: PerspectiveCamera;

  private mode: CameraMode = 'chase';
  private preset: CameraPreset | null = null;
  private pos = new Vector3(0, 6, -14);
  private vel = new Vector3();
  private lookAt = new Vector3();
  private yaw = 0;
  private shake = 0;
  private shakeSeed = Math.random() * 100;
  private orbitAngle = 0;
  private baseFov = CONFIG.render.fov;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(
      CONFIG.render.fov,
      aspect,
      CONFIG.render.near,
      CONFIG.render.far,
    );
    this.camera.position.copy(this.pos);
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    this.preset = null;
  }

  /** Harness entry point. `auto` means "whatever the race phase wants". */
  setPreset(preset: CameraPreset) {
    this.preset = preset === 'auto' ? null : preset;
    if (preset === 'auto') this.mode = 'chase';
  }

  addShake(amount: number) {
    this.shake = clamp01(this.shake + amount);
  }

  snapToTarget() {
    this.vel.set(0, 0, 0);
  }

  update(ctx: GameContext) {
    const { dt } = ctx;
    const boat = ctx.player;
    const s = boat.state;

    // Camera targets the hull a little above its origin so the boat sits low
    // in frame and the horizon stays visible — a low horizon reads as speed.
    _target.copy(boat.root.position);
    _target.y += 0.9;

    this.orbitAngle += dt * 0.32;

    if (this.preset) {
      this.applyPreset(ctx, _target);
    } else {
      this.applyChase(ctx, _target);
    }

    // ── FOV kick ────────────────────────────────────────────────────────────
    // Opens with speed, and opens further during a boost. This is most of what
    // makes an arcade racer feel fast; the actual velocity change is secondary.
    const boosting = s.boostTime > 0 ? 1 : 0;
    const targetFov =
      this.baseFov + CONFIG.render.fovSpeedKick * s.speedFrac + boosting * 6.5;
    this.camera.fov = damp(this.camera.fov, targetFov, 5.5, dt);
    this.camera.updateProjectionMatrix();

    // ── Shake ───────────────────────────────────────────────────────────────
    if (this.shake > 0.0005) {
      const t = ctx.time * 34 + this.shakeSeed;
      const amp = this.shake * this.shake * 0.42; // squared → punchy, not woolly
      this.camera.position.x += Math.sin(t * 1.7) * amp;
      this.camera.position.y += Math.sin(t * 2.3 + 1.1) * amp;
      this.camera.position.z += Math.sin(t * 1.9 + 2.7) * amp;
      this.shake = damp(this.shake, 0, CONFIG.camera.shakeDecay, dt);
    }

    // Never let the camera dip below the water surface — a frame of underwater
    // camera is far more jarring than a slightly high camera.
    const surface = ctx.ocean.height(this.camera.position.x, this.camera.position.z, ctx.time);
    const minY = surface + 0.85;
    if (this.camera.position.y < minY) this.camera.position.y = minY;

    this.camera.lookAt(this.lookAt);
  }

  // ── Modes ─────────────────────────────────────────────────────────────────

  private applyChase(ctx: GameContext, target: Vector3) {
    const { dt } = ctx;
    const s = ctx.player.state;
    const cfg = CONFIG.camera;

    // Trail the heading. During a drift we bias toward the *velocity* direction
    // so the hull visibly rotates within the frame.
    const velHeading = Math.atan2(ctx.player.state.velocity.x, ctx.player.state.velocity.z);
    const speed = ctx.player.state.velocity.length();
    const blend = speed > 3 ? (s.drifting ? 0.55 : 0.22) : 0;
    let desiredYaw = ctx.player.state.heading;
    if (blend > 0) {
      // Interpolate in angle space, shortest way round.
      const d = Math.atan2(
        Math.sin(velHeading - desiredYaw),
        Math.cos(velHeading - desiredYaw),
      );
      desiredYaw += d * blend;
    }
    this.yaw = dampAngle(this.yaw, desiredYaw, cfg.rotStiffness, dt);

    // Pull back and up as speed rises.
    const dist = cfg.distance * (1 + s.speedFrac * 0.22);
    const height = cfg.height * (1 + s.speedFrac * 0.1);

    _desired.set(
      target.x - Math.sin(this.yaw) * dist,
      target.y + height,
      target.z - Math.cos(this.yaw) * dist,
    );

    // Critically-damped follow.
    this.smoothFollow(_desired, cfg.posStiffness, dt);

    // Look ahead of the boat, further at speed.
    _look.set(
      target.x + Math.sin(this.yaw) * cfg.lookAhead * (0.5 + s.speedFrac),
      target.y + 0.4 - s.speedFrac * 0.5,
      target.z + Math.cos(this.yaw) * cfg.lookAhead * (0.5 + s.speedFrac),
    );
    this.lookAt.lerp(_look, 1 - Math.exp(-8 * dt));
  }

  private smoothFollow(desired: Vector3, stiffness: number, dt: number) {
    // Exponential approach on position with a velocity term, which gives the
    // slight overshoot-free "weight" a raw lerp lacks.
    const f = 1 - Math.exp(-stiffness * dt);
    _tmp.copy(desired).sub(this.camera.position).multiplyScalar(f);
    this.camera.position.add(_tmp);
  }

  private applyPreset(ctx: GameContext, target: Vector3) {
    const p = ctx.player;
    const h = p.state.heading;
    const sin = Math.sin(h),
      cos = Math.cos(h);
    const cam = this.camera;

    switch (this.preset) {
      case 'chase':
        this.applyChase(ctx, target);
        return;

      case 'far':
        cam.position.set(target.x - sin * 46, target.y + 24, target.z - cos * 46);
        this.lookAt.copy(target).add(new Vector3(sin * 40, -2, cos * 40));
        return;

      case 'bow':
        // Low, just off the bow, near the waterline — shows the wave silhouette.
        cam.position.set(target.x + sin * 5.4 + cos * 2.2, target.y + 0.55, target.z + cos * 5.4 - sin * 2.2);
        this.lookAt.copy(target).setY(target.y + 0.2);
        return;

      case 'wake':
        // Behind and low, looking down the wake ribbon.
        cam.position.set(target.x - sin * 13, target.y + 2.4, target.z - cos * 13);
        this.lookAt.copy(target).setY(target.y - 0.35);
        return;

      case 'rider':
        // Three-quarter close-up on the rider.
        cam.position.set(target.x - sin * 3.6 - cos * 3.1, target.y + 1.75, target.z - cos * 3.6 + sin * 3.1);
        this.lookAt.set(target.x, target.y + 1.05, target.z);
        return;

      case 'orbit_near': {
        const a = this.orbitAngle;
        cam.position.set(target.x + Math.sin(a) * 7.5, target.y + 2.6, target.z + Math.cos(a) * 7.5);
        this.lookAt.copy(target).setY(target.y + 0.7);
        return;
      }

      case 'far_boat':
        // Deliberately the same subject as orbit_near, much further away, so
        // the two captures can be compared for constant outline width.
        cam.position.set(target.x + 74, target.y + 17, target.z + 74);
        this.lookAt.copy(target);
        return;

      case 'broadcast':
        cam.position.set(target.x - sin * 30 + cos * 20, target.y + 13, target.z - cos * 30 - sin * 20);
        this.lookAt.copy(target);
        return;

      case 'aerial':
        cam.position.set(target.x, target.y + 210, target.z - 40);
        this.lookAt.copy(target);
        return;

      case 'sky':
        cam.position.set(target.x - sin * 12, target.y + 3.5, target.z - cos * 12);
        this.lookAt.set(target.x - sin * 60, target.y + 42, target.z - cos * 60);
        return;

      default:
        this.applyChase(ctx, target);
    }
  }

  /** Cinematic orbit used during the countdown and on the results screen. */
  applyCinematicOrbit(ctx: GameContext, radius = 13, height = 4.2, speed = 0.28) {
    const target = ctx.player.root.position;
    this.orbitAngle += ctx.dt * speed;
    const a = this.orbitAngle;
    this.camera.position.set(
      target.x + Math.sin(a) * radius,
      target.y + height + Math.sin(a * 0.7) * 1.2,
      target.z + Math.cos(a) * radius,
    );
    this.lookAt.copy(target).setY(target.y + 0.9);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
