/**
 * Bootstrap and frame loop.
 *
 * Owns the `GameContext`, the ordered subsystem list, resize handling, and the
 * `window.__INKTIDE__` harness API. Nothing here knows how any subsystem works
 * — it only knows the interfaces in core/types.
 */

import { Scene, Vector3 } from 'three';
import { CONFIG } from './core/config';
import { InputManager } from './core/input';
import { clamp } from './core/mathx';
import { setSeaState } from './water/gerstner';
import type { GameContext, Racer, RacerId, Subsystem } from './core/types';

import { AdaptiveResolution, createRenderer } from './render/renderer';
import { InkComposer } from './render/composer';
import { SHARED } from './render/celMaterial';
import { createSky } from './render/sky';
import { Ocean } from './water/ocean';
import { Track } from './race/track';
import { BoatPhysics, createRacer } from './boat/boat';
import { AiDrivers } from './race/ai';
import { RaceState } from './race/raceState';
import { Riders } from './rider/rider';
import { ChaseCamera, type CameraPreset } from './camera/chaseCamera';
import { Hud } from './ui/hud';
import { GameAudio } from './audio/audio';

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

  private ctx: GameContext;
  private lastTime = 0;
  private running = false;

  /** Harness overrides. */
  private forcedControls: Partial<{ steer: number; throttle: number; brake: number; drift: boolean }> | null = null;
  private fixedDt: number | null = null;

  constructor(
    private glCanvas: HTMLCanvasElement,
    private hudCanvas: HTMLCanvasElement,
  ) {
    const { renderer } = createRenderer(glCanvas);
    this.adaptive = new AdaptiveResolution(renderer);
    this.input = new InputManager();

    const aspect = window.innerWidth / window.innerHeight;
    this.cameraRig = new ChaseCamera(aspect);

    // ── Scene assembly ──────────────────────────────────────────────────────
    this.scene.add(createSky());

    this.ocean = new Ocean();
    this.scene.add(this.ocean.mesh);

    this.track = new Track();
    this.scene.add(this.track.group);

    for (let i = 0; i < CONFIG.race.racerCount; i++) {
      const grid = this.track.startGrid(i);
      const racer = createRacer(i as RacerId, grid.position, grid.heading);
      this.racers.push(racer);
      this.scene.add(racer.root);
    }

    this.race = new RaceState(this.racers, this.track, () => this.resetRacers());
    this.hud = new Hud(hudCanvas, this.track);
    this.composer = new InkComposer(renderer, this.scene, this.cameraRig.camera);

    // ── Context ─────────────────────────────────────────────────────────────
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
    };

    // ── Subsystems, in execution order ──────────────────────────────────────
    this.subsystems = [
      this.ocean,
      this.track,
      new BoatPhysics(this.racers),
      new AiDrivers(this.racers, this.track),
      this.race,
      new Riders(this.racers),
    ].sort((a, b) => a.order - b.order);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Audio can only start from a gesture; arm it on the first interaction.
    const unlock = () => {
      void this.audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private resetRacers() {
    for (const r of this.racers) {
      const grid = this.track.startGrid(r.id);
      r.root.position.copy(grid.position);
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
      this.frame(now);
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
    // Clamp so a tab-switch or a breakpoint cannot fling the boats into orbit.
    ctx.dt = clamp(rawDt, 0, 1 / 20);
    ctx.time += ctx.dt;
    ctx.frame++;

    const t0 = performance.now();

    // ── Input ───────────────────────────────────────────────────────────────
    this.input.update(ctx.dt);
    const pc = this.racers[0].controls;
    if (this.forcedControls) {
      pc.steer = this.forcedControls.steer ?? 0;
      pc.throttle = this.forcedControls.throttle ?? 0;
      pc.brake = this.forcedControls.brake ?? 0;
      pc.drift = this.forcedControls.drift ?? false;
    } else {
      const s = this.input.state;
      pc.steer = s.steer;
      pc.throttle = s.throttle;
      pc.brake = s.brake;
      pc.drift = s.drift;
    }
    if (this.input.state.restartPressed && this.race.phase === 'results') this.race.restart();

    // ── Shared shader uniforms — written once for the whole scene ────────────
    SHARED.uTime.value = ctx.time;
    SHARED.uCameraPos.value.copy(this.cameraRig.camera.position);
    SHARED.uTanHalfFov.value = Math.tan((this.cameraRig.camera.fov * Math.PI) / 360);

    // ── Subsystems ──────────────────────────────────────────────────────────
    for (const s of this.subsystems) s.update(ctx);

    // Camera and audio run after everything that can move the boat.
    if (this.race.phase === 'countdown' || this.race.phase === 'results') {
      this.cameraRig.applyCinematicOrbit(ctx);
      this.cameraRig.update(ctx);
    } else {
      this.cameraRig.update(ctx);
    }
    this.audio.update(ctx);

    // ── Render ──────────────────────────────────────────────────────────────
    ctx.renderer.info.reset();
    this.composer.render();
    // Hand the G-buffer depth to the water so its foam ring can read it.
    this.ocean.setSceneDepth(this.composer.gbufferDepth);

    const stats = this.adaptive.drawStats();
    ctx.perf.drawCalls = stats.drawCalls;
    ctx.perf.triangles = stats.triangles;

    this.hud.render(ctx);

    // ── Adaptive resolution ─────────────────────────────────────────────────
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
        self.race.restart();
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
          // Fabricate a plausible finished race so the results board has data.
          self.race.phase = 'results';
          self.racers.forEach((r, i) => {
            r.finished = true;
            r.finishTime = 214.5 + i * 3.4;
            r.lapTimes = [71.2 + i, 70.8 + i, 72.5 + i];
            r.bestLap = Math.min(...r.lapTimes);
            r.place = i + 1;
            r.lap = CONFIG.race.laps;
          });
        }
      },

      setControls(c: Record<string, number | boolean>) {
        self.forcedControls = c as any;
      },

      /** Fixed-step advance — identical output on every machine. */
      async simulate(seconds: number, dt = 1 / 60) {
        const steps = Math.max(1, Math.round(seconds / dt));
        for (let i = 0; i < steps; i++) {
          self.frame(performance.now(), dt);
          // Yield periodically so the compositor can breathe and WebGL does not
          // build an unbounded command backlog.
          if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
        }
      },

      /** Render N real frames so springs and particles settle. */
      async settle(frames = 6) {
        for (let i = 0; i < frames; i++) {
          self.frame(performance.now(), 1 / 60);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
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
          drifting: p.drifting,
          boostTime: p.boostTime,
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

      /** Escape hatch for ad-hoc probing from the harness. */
      _game: self,
    };
  }
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

  // Expose the harness API once the first frame is definitely on screen.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      (window as any).__INKTIDE__ = game.harness();
      boot?.classList.add('gone');
      setTimeout(() => boot?.remove(), 700);
    }),
  );
} catch (err) {
  console.error('[ink-tide] boot failed', err);
  if (boot) {
    boot.textContent = 'Boot failed — see console';
    boot.style.letterSpacing = '0.1em';
  }
  throw err;
}
