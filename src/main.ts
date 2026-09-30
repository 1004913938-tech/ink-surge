/**
 * Bootstrap and frame loop.
 *
 * Owns the `GameContext`, the ordered subsystem list, resize handling, menu
 * flow, and the `window.__INKTIDE__` harness API.
 */

import { Scene } from 'three';
import { applySession, ACTIVE } from './core/activeRace';
import { CONFIG } from './core/config';
import { InputManager } from './core/input';
import { clamp } from './core/mathx';
import { setSeaState } from './water/gerstner';
import type { GameContext, RacePhase, Racer, RacerId, Subsystem } from './core/types';
import { defaultSession, type RaceSession } from './meta/session';
import { getTrackDef } from './race/trackDef';

import { AdaptiveResolution, createRenderer } from './render/renderer';
import { InkComposer } from './render/composer';
import { SHARED } from './render/celMaterial';
import { createSky } from './render/sky';
import { Ocean } from './water/ocean';
import { Track } from './race/track';
import { BoatPhysics, createRacer } from './boat/boat';
import { AiDrivers } from './race/ai';
import { RaceState } from './race/raceState';
import { SwellRun } from './race/swellRun';
import { ItemSystem } from './race/items';
import { Riders } from './rider/rider';
import { ChaseCamera, type CameraPreset } from './camera/chaseCamera';
import { Hud } from './ui/hud';
import { GameAudio } from './audio/audio';
import { BRAND } from './brand';

class Game {
  private scene = new Scene();
  private subsystems: Subsystem[] = [];
  private input: InputManager;
  private adaptive: AdaptiveResolution;
  private composer: InkComposer;
  private cameraRig: ChaseCamera;
  private ocean: Ocean;
  private track: Track;
  private race!: RaceState;
  private hud: Hud;
  private audio = new GameAudio();
  private racers: Racer[] = [];
  private ai!: AiDrivers;
  private swell!: SwellRun;
  private items!: ItemSystem;
  private settledResults = false;

  private ctx: GameContext;
  private lastTime = 0;
  private running = false;

  /** Harness overrides. */
  private forcedControls:
    | Partial<{ steer: number; throttle: number; brake: number; drift: boolean; autopilot: boolean }>
    | null = null;
  /** True while a harness script owns the clock; suppresses the rAF step. */
  private scripted = false;

  constructor(
    private glCanvas: HTMLCanvasElement,
    private hudCanvas: HTMLCanvasElement,
  ) {
    const { renderer } = createRenderer(glCanvas);
    this.adaptive = new AdaptiveResolution(renderer);
    this.input = new InputManager();

    const aspect = window.innerWidth / window.innerHeight;
    this.cameraRig = new ChaseCamera(aspect);

    this.scene.add(createSky());

    this.ocean = new Ocean();
    this.scene.add(this.ocean.mesh);

    this.track = new Track(getTrackDef('noviceBay'));
    this.scene.add(this.track.group);

    for (let i = 0; i < CONFIG.race.racerCount; i++) {
      const grid = this.track.startGrid(i);
      const racer = createRacer(i as RacerId, grid.position, grid.heading);
      this.racers.push(racer);
      this.scene.add(racer.root);
    }

    this.race = new RaceState(this.racers, this.track, () => {
      this.swell.reset();
      this.items.reset();
      this.resetRacers();
    });
    this.race.setReturnToMenu(() => this.enterHub());
    this.swell = new SwellRun(this.race);
    this.items = new ItemSystem(this.track, this.racers);
    this.scene.add(this.items.group);
    this.hud = new Hud(hudCanvas, this.track);
    this.composer = new InkComposer(renderer, this.scene, this.cameraRig.camera);
    this.ai = new AiDrivers(this.racers, this.track);

    this.ctx = {
      renderer,
      scene: this.scene,
      camera: this.cameraRig.camera,
      time: 0,
      dt: 0,
      rawDt: 0,
      frame: 0,
      ocean: this.ocean,
      track: this.track,
      race: this.race,
      racers: this.racers,
      player: this.racers[0],
      input: this.input.state,
      audio: this.audio,
      cameraRig: this.cameraRig,
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: 1,
      perf: { fps: 60, frameMs: 16.6, gpuScale: 1, drawCalls: 0, triangles: 0 },
      swell: this.swell.snapshot(),
      items: this.items.view(),
    };

    this.subsystems = [
      this.ocean,
      this.track,
      new BoatPhysics(this.racers),
      this.ai,
      this.race,
      this.swell,
      this.items,
      new Riders(this.racers),
    ].sort((a, b) => a.order - b.order);

    this.race.phase = 'hub';
    this.hud.menus.syncFromSave();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    const unlock = () => {
      void this.audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private autopilotSteer(racer: Racer): number {
    const proj = this.track.project(racer.root.position);
    const speed = racer.state.velocity.length();
    const lookahead = 15 + speed * 1.0;
    const target = this.track.sampleDistance(proj.u * this.track.length + lookahead);
    const dx = target.position.x - racer.root.position.x;
    const dz = target.position.z - racer.root.position.z;
    let err = Math.atan2(dx, dz) - racer.state.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    return clamp(-err * 2.0, -1, 1);
  }

  private resetRacers() {
    const count = ACTIVE.session.racerCount;
    for (const r of this.racers) {
      const active = r.id < count;
      r.root.visible = active;
      if (!active) {
        r.finished = true;
        r.finishTime = 0;
        r.state.velocity.set(0, 0, 0);
        continue;
      }
      const grid = this.track.startGrid(r.id);
      r.root.position.copy(grid.position);
      r.root.rotation.y = grid.heading;
      r.state.velocity.set(0, 0, 0);
      r.state.heading = grid.heading;
      r.state.forwardSpeed = 0;
      r.state.speedFrac = 0;
      r.state.boostTime = 0;
      r.state.boostMeter = 0;
      r.state.driftCharge = 0;
      r.state.driftTier = 0;
      r.lap = 0;
      r.nextCheckpoint = 0;
      r.progress = 0;
      r.place = r.id + 1;
      r.finished = false;
      r.finishTime = 0;
      r.lapTimes = [];
      r.bestLap = Infinity;
      r.wrongWay = false;
    }
    this.cameraRig.snapToTarget();
  }

  private enterHub() {
    this.race.phase = 'hub';
    this.settledResults = false;
    this.hud.menus.syncFromSave();
    this.hud.menus.lastPayout = '';
    applySession(defaultSession());
    this.swell.reset();
    this.items.reset();
    setSeaState(0.55);
    this.resetRacers();
  }

  private startRace(session: RaceSession) {
    applySession(session);
    const def = getTrackDef(session.trackId);

    if (this.track.def.id !== def.id) {
      this.scene.remove(this.track.group);
      this.track = new Track(def);
      this.scene.add(this.track.group);
      this.race.setTrack(this.track);
      this.ai.setTrack(this.track);
      this.items.setTrack(this.track);
      this.hud.setTrack(this.track);
      this.ctx.track = this.track;
      // Swap track subsystem slot.
      const idx = this.subsystems.findIndex((s) => s.name === 'track');
      if (idx >= 0) this.subsystems[idx] = this.track;
    }

    setSeaState(session.seaState);
    this.settledResults = false;
    this.hud.menus.lastPayout = '';
    this.swell.reset();
    this.items.reset();
    this.resetRacers();
    this.race.beginCountdown();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.width = w;
    this.ctx.height = h;

    const dpr = this.adaptive.pixelRatio;
    this.ctx.pixelRatio = dpr;

    this.ctx.renderer.setPixelRatio(dpr);
    this.ctx.renderer.setSize(w, h, false);
    this.cameraRig.resize(w / h);
    this.composer.setSize(w, h, dpr);
    this.hud.resize(w, h, Math.min(window.devicePixelRatio || 1, 2));

    SHARED.uResolution.value.set(w * dpr, h * dpr);
    SHARED.uNear.value = CONFIG.render.near;
    SHARED.uFar.value = CONFIG.render.far;
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      if (!this.scripted) this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** One simulation + render step. */
  private frame(now: number, forcedDt?: number) {
    const ctx = this.ctx;
    const rawDt = forcedDt ?? (now - this.lastTime) / 1000;
    this.lastTime = now;

    ctx.rawDt = rawDt;
    ctx.dt = clamp(rawDt, 0, 1 / 20);
    ctx.time += ctx.dt;
    ctx.frame++;

    const t0 = performance.now();

    this.input.update(ctx.dt);
    const pc = this.racers[0].controls;
    const menuPhase = isMenuPhase(this.race.phase);

    if (this.forcedControls) {
      pc.throttle = this.forcedControls.throttle ?? 0;
      pc.brake = this.forcedControls.brake ?? 0;
      pc.drift = this.forcedControls.drift ?? false;
      pc.steer = this.forcedControls.autopilot
        ? this.autopilotSteer(this.racers[0])
        : this.forcedControls.steer ?? 0;
    } else if (!menuPhase) {
      const s = this.input.state;
      pc.steer = s.steer;
      pc.throttle = s.throttle;
      pc.brake = s.brake;
      pc.drift = s.drift;
    }

    if (menuPhase) {
      const action = this.hud.menus.update(ctx, ctx.dt);
      if (action.type === 'setPhase') this.race.phase = action.phase;
      if (action.type === 'startRace') this.startRace(action.session);
    }

    SHARED.uTime.value = ctx.time;
    SHARED.uCameraPos.value.copy(this.cameraRig.camera.position);
    SHARED.uTanHalfFov.value = Math.tan((this.cameraRig.camera.fov * Math.PI) / 360);

    for (const s of this.subsystems) s.update(ctx);
    ctx.swell = this.swell.snapshot();
    ctx.items = this.items.view();

    if (this.race.phase === 'results' && !this.settledResults) {
      this.settledResults = true;
      const snap = this.swell.snapshot();
      this.hud.menus.settleResults(
        this.ctx.player.place,
        this.ctx.player.finishTime,
        snap.active ? snap.score : 0,
      );
    }

    if (
      this.race.phase === 'countdown' ||
      this.race.phase === 'results' ||
      menuPhase
    ) {
      this.cameraRig.applyCinematicOrbit(ctx);
      this.cameraRig.update(ctx);
    } else {
      this.cameraRig.update(ctx);
    }
    this.audio.update(ctx);

    ctx.renderer.info.reset();
    this.composer.render();
    this.ocean.setSceneDepth(this.composer.gbufferDepth);

    const stats = this.adaptive.drawStats();
    ctx.perf.drawCalls = stats.drawCalls;
    ctx.perf.triangles = stats.triangles;

    this.hud.render(ctx);

    const frameMs = performance.now() - t0;
    if (this.adaptive.update(frameMs, ctx.dt)) this.resize();
    ctx.perf.fps = this.adaptive.fps;
    ctx.perf.frameMs = this.adaptive.frameMs;
    ctx.perf.gpuScale = this.adaptive.scale;
  }

  // ── Harness API ───────────────────────────────────────────────────────────

  harness() {
    const self = this;
    return {
      ready: true,

      reset() {
        self.ctx.time = 0;
        applySession({
          mode: 'quick',
          trackId: 'noviceBay',
          laps: 3,
          racerCount: 4,
          seaState: 1,
          boatClass: 'balanced',
          liveryId: 'vermilion',
          eventKind: 'standard',
        });
        self.startRace(ACTIVE.session);
        self.forcedControls = null;
      },

      setPhase(phase: 'countdown' | 'racing' | 'results') {
        if (phase === 'racing') {
          self.race.phase = 'racing';
          self.race.raceTime = 0;
          self.race.countdownNumber = -1;
        } else if (phase === 'countdown') {
          self.race.phase = 'countdown';
          self.race.raceTime = -CONFIG.race.countdownSeconds;
        } else {
          self.race.phase = 'results';
          self.racers.forEach((r, i) => {
            r.finished = true;
            r.finishTime = 214.5 + i * 3.4;
            r.lapTimes = [71.2 + i, 70.8 + i, 72.5 + i];
            r.bestLap = Math.min(...r.lapTimes);
            r.place = i + 1;
            r.lap = ACTIVE.session.laps;
          });
        }
      },

      setControls(c: Record<string, number | boolean>) {
        self.forcedControls = c as any;
      },

      async simulate(seconds: number, dt = 1 / 60) {
        self.scripted = true;
        const steps = Math.max(1, Math.round(seconds / dt));
        for (let i = 0; i < steps; i++) {
          self.frame(performance.now(), dt);
          if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
        }
      },

      async simulateUntil(
        predicateSource: string,
        maxSeconds = 90,
        dt = 1 / 60,
      ): Promise<{ found: boolean; t: number }> {
        self.scripted = true;
        // eslint-disable-next-line no-new-func
        const pred = new Function('s', `return (${predicateSource});`) as (s: any) => boolean;
        const steps = Math.round(maxSeconds / dt);
        for (let i = 0; i < steps; i++) {
          self.frame(performance.now(), dt);
          if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
          try {
            if (pred(this.stats())) return { found: true, t: self.ctx.time };
          } catch {
            /* ignore */
          }
        }
        return { found: false, t: self.ctx.time };
      },

      async settle(frames = 6) {
        self.scripted = true;
        for (let i = 0; i < frames; i++) {
          self.frame(performance.now(), 1 / 60);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
      },

      release() {
        self.scripted = false;
        self.lastTime = performance.now();
      },

      probe() {
        return self.racers.map((r) => {
          const proj = self.track.project(r.root.position);
          const tp = self.track.sample(proj.u);
          const speed = r.state.velocity.length();
          const fwd = { x: Math.sin(r.state.heading), z: Math.cos(r.state.heading) };
          return {
            id: r.id,
            name: r.name,
            heading: r.state.heading,
            headingFwd: fwd,
            trackTangent: { x: tp.tangent.x, z: tp.tangent.z },
            headingDotTangent: fwd.x * tp.tangent.x + fwd.z * tp.tangent.z,
            velDotTangent: speed > 0.01 ? r.state.velocity.dot(tp.tangent) / speed : 0,
            speed,
            u: proj.u,
            lateral: proj.lateral,
            distToLine: proj.distance,
            lap: r.lap,
            nextCheckpoint: r.nextCheckpoint,
            progress: r.progress,
            place: r.place,
            wrongWay: r.wrongWay,
            finished: r.finished,
            pos: r.root.position.toArray().map((v) => +v.toFixed(2)),
          };
        });
      },

      setCameraPreset(name: CameraPreset) {
        self.cameraRig.setPreset(name);
      },

      setSeaState(v: number) {
        setSeaState(v);
      },

      stats() {
        const p = self.ctx.player.state;
        return {
          fps: self.ctx.perf.fps,
          frameMs: self.ctx.perf.frameMs,
          drawCalls: self.ctx.perf.drawCalls,
          triangles: self.ctx.perf.triangles,
          pixelRatio: self.ctx.pixelRatio,
          time: self.ctx.time,
          phase: self.race.phase,
          speed: p.forwardSpeed,
          airborne: p.airborne,
          airTime: p.airTime,
          landingImpact: p.landingImpact,
          drifting: p.drifting,
          driftTier: p.driftTier,
          boostMeter: p.boostMeter,
          boostTime: p.boostTime,
          wrongWay: self.ctx.player.wrongWay,
          position: p.position.toArray(),
          lap: self.ctx.player.lap,
          place: self.ctx.player.place,
        };
      },

      rendererInfo() {
        const gl = self.ctx.renderer.getContext();
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
          vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
        };
      },

      _game: self,
    };
  }
}

function isMenuPhase(phase: RacePhase): boolean {
  return (
    phase === 'hub' ||
    phase === 'career' ||
    phase === 'garage' ||
    phase === 'quick' ||
    phase === 'trial'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const boot = document.getElementById('boot');

try {
  const game = new Game(glCanvas, hudCanvas);
  game.start();

  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      (window as any).__INKTIDE__ = game.harness();
      boot?.classList.add('gone');
      setTimeout(() => boot?.remove(), 700);
    }),
  );
} catch (err) {
  console.error(`[${BRAND.id}] boot failed`, err);
  if (boot) {
    boot.textContent = 'Boot failed — see console';
    boot.style.letterSpacing = '0.1em';
  }
  throw err;
}
