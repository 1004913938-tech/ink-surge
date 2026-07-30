/**
 * PLACEHOLDER — owned by the presentation subsystem.
 *
 * Fully synthesised audio: no samples, no files. This version has a working
 * engine tone that tracks RPM, a filtered-noise water rush, and one-shot
 * impacts and horn. The presentation agent replaces it with the designed mix.
 */

import { CONFIG } from '../core/config';
import { clamp, clamp01 } from '../core/mathx';
import type { AudioAPI, GameContext } from '../core/types';

export class GameAudio implements AudioAPI {
  private ac: AudioContext | null = null;
  private master!: GainNode;

  // Engine: two detuned saws through a lowpass, which reads as a small
  // high-strung outboard rather than a pure tone.
  private engineOsc: OscillatorNode[] = [];
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;

  // Water rush: filtered white noise whose cutoff opens with speed.
  private noiseSource!: AudioBufferSourceNode;
  private noiseGain!: GainNode;
  private noiseFilter!: BiquadFilterNode;

  private muted = false;
  private started = false;

  async unlock() {
    if (this.started) return;
    if (CONFIG.debug.harness) {
      // The harness runs muted and must never block on an audio device.
      this.muted = true;
      this.started = true;
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
      const ac: AudioContext = new Ctor();
      await ac.resume();
      this.ac = ac;
      this.build(ac);
      this.started = true;
    } catch {
      this.muted = true;
      this.started = true;
    }
  }

  private build(ac: AudioContext) {
    this.master = ac.createGain();
    this.master.gain.value = CONFIG.audio.masterGain;
    this.master.connect(ac.destination);

    // ── Engine ────────────────────────────────────────────────────────────
    this.engineFilter = ac.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 3.2;

    this.engineGain = ac.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    for (const detune of [0, 7, -11]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 70;
      o.detune.value = detune;
      o.connect(this.engineFilter);
      o.start();
      this.engineOsc.push(o);
    }

    // ── Water rush ────────────────────────────────────────────────────────
    // 2 s of looped white noise. Generated, not loaded.
    const len = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // Brown-ish noise: integrated white, which sits better under an engine
      // than raw white and does not hiss.
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.2;
    }
    this.noiseSource = ac.createBufferSource();
    this.noiseSource.buffer = buf;
    this.noiseSource.loop = true;

    this.noiseFilter = ac.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 500;
    this.noiseFilter.Q.value = 0.7;

    this.noiseGain = ac.createGain();
    this.noiseGain.gain.value = 0;

    this.noiseSource.connect(this.noiseFilter).connect(this.noiseGain).connect(this.master);
    this.noiseSource.start();
  }

  update(ctx: GameContext) {
    if (!this.ac || this.muted) return;
    const s = ctx.player.state;
    const now = this.ac.currentTime;

    // RPM is not just speed: it jumps with throttle even before the boat
    // accelerates, which is most of what makes an engine feel responsive.
    const load = s.appliedThrottle;
    const rpm = clamp01(s.speedFrac * 0.72 + load * 0.28);
    const boosting = s.boostTime > 0;
    const freq = 58 + rpm * 190 + (boosting ? 34 : 0);

    for (const o of this.engineOsc) {
      o.frequency.setTargetAtTime(freq, now, 0.06);
    }
    this.engineFilter.frequency.setTargetAtTime(600 + rpm * 2400, now, 0.08);
    const engineVol = CONFIG.audio.engineGain * (0.18 + load * 0.6 + rpm * 0.35);
    this.engineGain.gain.setTargetAtTime(s.airborne ? engineVol * 0.55 : engineVol, now, 0.07);

    // Water rush scales with speed and drops away in the air.
    const rush = s.airborne ? 0.05 : clamp01(s.speedFrac * 1.15);
    this.noiseGain.gain.setTargetAtTime(CONFIG.audio.waterGain * rush, now, 0.1);
    this.noiseFilter.frequency.setTargetAtTime(260 + rush * 1500, now, 0.12);
  }

  /** Short filtered noise burst with a pitch drop — a hull slam. */
  impact(strength: number) {
    const ac = this.ac;
    if (!ac || this.muted) return;
    const now = ac.currentTime;
    const s = clamp01(strength);

    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(150 + s * 90, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.28);

    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.55 * s + 0.06, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    osc.connect(g).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.45);

    this.splash(s * 0.8);
  }

  /** Bright noise transient — spray. */
  splash(strength: number) {
    const ac = this.ac;
    if (!ac || this.muted) return;
    const now = ac.currentTime;
    const s = clamp01(strength);
    const len = Math.floor(ac.sampleRate * 0.3);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 900;
    const g = ac.createGain();
    g.gain.value = 0.32 * s;
    src.connect(f).connect(g).connect(this.master);
    src.start(now);
  }

  /** Start-light horn. `pitch` 0…1 maps to a musical interval. */
  horn(pitch: number) {
    const ac = this.ac;
    if (!ac || this.muted) return;
    const now = ac.currentTime;
    const base = 220 * Math.pow(2, clamp(pitch, 0, 1.2));
    for (const [mult, gain] of [[1, 0.22], [2, 0.1], [3, 0.05]] as const) {
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = base * mult;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(gain, now + 0.02);
      g.gain.setValueAtTime(gain, now + 0.26);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      o.connect(g).connect(this.master);
      o.start(now);
      o.stop(now + 0.55);
    }
  }

  boost() {
    const ac = this.ac;
    if (!ac || this.muted) return;
    const now = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, now);
    o.frequency.exponentialRampToValueAtTime(900, now + 0.3);
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 700;
    f.Q.value = 4;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.3, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    o.connect(f).connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 0.5);
  }

  checkpoint() {
    const ac = this.ac;
    if (!ac || this.muted) return;
    const now = ac.currentTime;
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, now);
    o.frequency.setValueAtTime(1320, now + 0.07);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    o.connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 0.22);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : CONFIG.audio.masterGain;
  }
}
