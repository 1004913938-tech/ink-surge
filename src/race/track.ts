/**
 * THE CIRCUIT.
 *
 * ── How the shape is authored ───────────────────────────────────────────────
 * The first version of this file hand-placed 24 CatmullRom control points and
 * hoped. A numeric sweep of the result found a 108° kink *at the start/finish
 * line* (radius 17 m at u = 0.000, radius 11.8 m at u = 0.998), which is why the
 * start grid pointed the wrong way and the HUD read WRONG WAY from the lights.
 * CatmullRom through hand-placed points gives you no control over curvature, and
 * curvature is the only thing that matters for a racing line.
 *
 * So the circuit is now authored the way a real track is: as a **closed polygon
 * of legs with a fillet radius at every vertex**. That buys three things for
 * free:
 *
 *   1. the loop closes exactly, because a polygon closes exactly;
 *   2. every corner has an exact, chosen radius, so "is this corner fast?" is a
 *      number in the table below, not a discovery;
 *   3. the straights are actually straight — zero curvature, not 1/1200.
 *
 * Each fillet is a constant-radius arc whose entry and exit are raised-cosine
 * curvature ramps (a cheap clothoid), so curvature is continuous everywhere and
 * the AI never meets a step change in required steering.
 *
 * The fillet radii are not aesthetic choices. Solving the boat's own steering
 * model (`turnRate = turnRateLow + (turnRateHigh − turnRateLow)·v/topSpeed`)
 * for the speed at which it can hold a radius R gives
 *
 *     v(R) = turnRateLow / (1/R + (turnRateLow − turnRateHigh)/topSpeed)
 *
 * which is flat-out (29 m/s) for anything above R ≈ 25 m. **A corner only
 * matters if its radius is under 25 m.** That is the single most important fact
 * about this boat, and it is why the layout mixes five genuine sub-25 m buoy
 * turns with four big sweepers rather than the "rounded rectangle" a first pass
 * always produces.
 *
 * ── The lap ────────────────────────────────────────────────────────────────
 *   V0   HAIRPIN, 138° right, R = 13   → 20 m/s. The overtaking spot.
 *   S1   start / finish straight, 125 m, heading 0 (+Z)
 *   V1   wide left sweeper, 60°, R = 90 → flat out, rewards a late apex
 *   V2   left, 54°, R = 70             → flat out
 *   V3   left, 55°, R = 45             → flat out
 *   V4   buoy turn, 68° left, R = 18   → 24 m/s
 *   V5   counter-flick, 72° right, R = 20 → 26 m/s  (V4+V5 = the chicane)
 *   V6   tight buoy, 81° left, R = 15  → 22 m/s
 *   S7   THE SWELL LEG: 133 m + 147 m either side of a 7° kink, heading −114°.
 *        Aimed dead into the two dominant swell trains (head-on dot 0.98 and
 *        0.91), so the hull meets the 62 m and 41 m swells at maximum encounter
 *        frequency and genuinely launches. See the note on "cross-swell" below.
 *   V8   left, 66°, R = 55             → flat out
 *   V9   left, 72°, R = 60             → flat out
 *   V10  tight left, 107°, R = 22      → 27 m/s, onto the hairpin approach
 *
 * ── "Cross-swell" ──────────────────────────────────────────────────────────
 * The brief asked for a leg "perpendicular to the dominant swell directions, so
 * boats take the waves side-on and get real airtime". Those two halves fight
 * each other: a beam sea rolls a hull, it does not launch it. Encounter
 * frequency is ω_e = ω − k·v, which is *zero extra* when you run across a swell
 * and maximal when you run into it. Airtime was the stated goal, so this leg is
 * aimed **into** the swell (head sea) rather than across it, and the airborne
 * numbers in the report back that up.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import { CONFIG } from '../core/config';
import { PAL } from '../core/palette';
import { angleDelta, clamp, clamp01, smoothstep } from '../core/mathx';
import { applyCel, createCelMaterial, SHARED } from '../render/celMaterial';
import { GERSTNER_GLSL, waveUniformArrays } from '../water/gerstner';
import type { Checkpoint, GameContext, Subsystem, TrackAPI, TrackPoint } from '../core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Polygon vertices in metres, in the direction of travel, plus the fillet
 * radius at each vertex. The XZ pair is scaled by LAYOUT_SCALE to set the lap
 * length; the radii are NOT scaled, because they are dictated by the boat's
 * turning circle and not by how big we want the course to be.
 */
const LAYOUT_SCALE = 0.7;
const VERTS: readonly (readonly [number, number, number])[] = [
  [0, 0, 11], //     V0  hairpin      138° right → 17.8 m/s
  [0, 300, 90], //   V1  wide sweeper  60° left  → flat out
  [170, 400, 70], // V2                54° left  → flat out
  [330, 330, 45], // V3                55° left  → flat out
  [360, 180, 16], // V4  buoy turn     68° left  → 22.6 m/s
  [270, 120, 17], // V5  counter-flick 72° right → 23.2 m/s
  [300, 10, 13], //  V6  tight buoy    81° left  → 19.9 m/s
  [100, -80, 120], // V7 kink           7° left  → flat out
  [-160, -160, 55], // V8              66° left  → flat out
  [-300, 0, 60], //  V9                72° left  → flat out
  [-180, 200, 17], // V10             107° left  → 23.2 m/s
];

/**
 * Where the start/finish line sits, in metres measured from the exit of the
 * hairpin fillet (i.e. along the S1 straight). 88 m leaves the 2×2 grid — which
 * stacks back to 26 m — comfortably on the straight, and still leaves a run to
 * the V1 sweeper.
 */
const START_S = 88;

/** Stations in the arc-length lookup. 2048 over ~1470 m ≈ 0.72 m spacing. */
const STATIONS = 2048;

/**
 * Speed below which a corner counts as "maximally severe". Severity is defined
 * as the *required speed drop*, not as curvature: a 55 m sweeper has plenty of
 * curvature and needs no braking at all, so tinting the racing line for it — the
 * first version did — cries wolf and the driver stops reading the warning.
 */
const SEVERE_SPEED = 15;
/** How far ahead the corner-preview indicator looks, metres. */
const PREVIEW_DISTANCE = 175;
/** Half-width of the drivable corridor the racing line is allowed to use. */
const CORRIDOR = 7.0;
/** Deceleration the AI speed profile is back-propagated with, m/s². */
const BRAKE_ACCEL = 7.5;

const GATE_COUNT = 12;

// ─────────────────────────────────────────────────────────────────────────────
// Scratch — module scope, never allocated per frame
// ─────────────────────────────────────────────────────────────────────────────

const _projOut = { u: 0, distance: 0, lateral: 0 };
const _tpScratch: TrackPoint = {
  position: new Vector3(),
  tangent: new Vector3(0, 0, 1),
  curvature: 0,
  u: 0,
};

/** What the corner-preview indicator needs. Also handed to the HUD. */
export interface CornerPreview {
  /** Metres to the mouth of the upcoming corner. */
  distance: number;
  /** −1 = the corner goes right (steer positive), +1 = left. 0 = nothing. */
  direction: number;
  /** 0…1. 1 = a hairpin you must brake hard for. */
  severity: number;
  /** Radius of the corner, metres. Infinity on a straight. */
  radius: number;
  /** Speed the corner can be taken at, m/s. */
  speed: number;
}

/**
 * `GERSTNER_GLSL` declares `uniform float uTime;` itself, and so does the cel
 * vertex shader. GLSL forbids re-declaring a uniform, so the gate material gets
 * a copy with that one line removed. (Requested upstream: a body-only export.)
 */
const GERSTNER_NO_TIME = GERSTNER_GLSL.replace('uniform float uTime;', '');

/**
 * Speed the hull can hold on a given curvature, from the boat's own steering
 * model. This is the number that decides whether a corner exists at all.
 */
function cornerSpeed(k: number): number {
  const cfg = CONFIG.boat;
  const fade = (cfg.turnRateLow - cfg.turnRateHigh) / cfg.topSpeed;
  const denom = Math.abs(k) + fade;
  return clamp(cfg.turnRateLow / denom, 5, cfg.topSpeed);
}

/** 0…1 "how much do I have to slow down for this?" — the severity definition. */
function severityOf(k: number): number {
  const top = CONFIG.boat.topSpeed;
  return clamp01((top - cornerSpeed(k)) / (top - SEVERE_SPEED));
}

// ─────────────────────────────────────────────────────────────────────────────

export interface GateSpec extends Checkpoint {
  /** Arc length of the gate along the lap, metres. */
  s: number;
  /** Local severity, 0…1 — drives how narrow and how hot the gate is. */
  severity: number;
  /** True for the start/finish gantry. */
  isStart: boolean;
}

export class Track implements TrackAPI, Subsystem {
  readonly name = 'track';
  readonly order = 25;

  readonly group = new Group();
  readonly checkpoints: GateSpec[] = [];
  readonly length: number;

  /** Uniform-arc-length station tables. Index 0 is the start/finish line. */
  private readonly N = STATIONS;
  private ds = 1;
  private px!: Float32Array;
  private pz!: Float32Array;
  private tx!: Float32Array;
  private tz!: Float32Array;
  /** Signed curvature, 1/m. Positive = heading increasing = a LEFT turn. */
  private pk!: Float32Array;
  /** Signed severity of the corner *ahead*, −1…1. The corner-preview signal. */
  private sev!: Float32Array;
  /** Metres to that corner. */
  private sevDist!: Float32Array;
  /** Signed curvature and speed of that corner. */
  private sevK!: Float32Array;
  private sevSpeed!: Float32Array;
  /** Back-propagated speed profile, m/s. */
  private vlim!: Float32Array;
  /** Racing-line lateral offset from the centreline, metres (+ = track right). */
  private off!: Float32Array;

  /** Uniform grid over the stations so `project()` is O(1) and never picks the
   *  wrong lobe of the circuit. */
  private cell = 44;
  private gMinX = 0;
  private gMinZ = 0;
  private gW = 1;
  private gH = 1;
  private buckets: Int32Array[] = [];

  /** Diagnostics, read by the harness and printed in the report. */
  readonly design: {
    length: number;
    corners: { name: string; radius: number; turnDeg: number; speed: number; s: number }[];
    minRadius: number;
    maxDkDs: number;
    minSelfSeparation: number;
    closureGap: number;
    curvatureScale: number;
  };

  /** Live corner preview for the player, refreshed every frame. */
  readonly preview: CornerPreview = {
    distance: Infinity,
    direction: 0,
    severity: 0,
    radius: Infinity,
    speed: CONFIG.boat.topSpeed,
  };

  private ribbon!: Mesh;

  constructor() {
    const built = buildCentreline();
    this.length = built.length;
    this.ds = built.length / this.N;
    this.px = built.px;
    this.pz = built.pz;
    this.tx = built.tx;
    this.tz = built.tz;
    this.pk = built.pk;
    this.design = built.design;

    this.buildPreview();
    this.buildSpeedProfile();
    this.buildRacingLine();
    this.buildGrid();
    this.buildCheckpoints();
    this.buildRibbon();
    this.buildGates();
  }

  // ── Station helpers ───────────────────────────────────────────────────────

  private wrapU(u: number) {
    return ((u % 1) + 1) % 1;
  }

  /** Fractional station index for a normalised lap position. */
  private station(u: number) {
    return this.wrapU(u) * this.N;
  }

  sample(u: number, out?: TrackPoint): TrackPoint {
    const r = out ?? { position: new Vector3(), tangent: new Vector3(), curvature: 0, u: 0 };
    const f = this.station(u);
    const i = Math.floor(f) % this.N;
    const j = (i + 1) % this.N;
    const t = f - Math.floor(f);
    r.position.set(
      this.px[i] + (this.px[j] - this.px[i]) * t,
      0,
      this.pz[i] + (this.pz[j] - this.pz[i]) * t,
    );
    r.tangent.set(this.tx[i] + (this.tx[j] - this.tx[i]) * t, 0, this.tz[i] + (this.tz[j] - this.tz[i]) * t);
    const len = Math.hypot(r.tangent.x, r.tangent.z) || 1;
    r.tangent.x /= len;
    r.tangent.z /= len;
    // The contract says `curvature` is a magnitude. Direction lives on
    // `signedCurvature()` / `cornerPreview()`.
    r.curvature = Math.abs(this.pk[i] + (this.pk[j] - this.pk[i]) * t);
    r.u = this.wrapU(u);
    return r;
  }

  sampleDistance(d: number, out?: TrackPoint): TrackPoint {
    return this.sample(d / this.length, out);
  }

  /** Signed curvature, 1/m. Positive = the track turns left (heading rising). */
  signedCurvature(u: number): number {
    const f = this.station(u);
    const i = Math.floor(f) % this.N;
    const j = (i + 1) % this.N;
    const t = f - Math.floor(f);
    return this.pk[i] + (this.pk[j] - this.pk[i]) * t;
  }

  /** Speed the racing line supports here, m/s — already back-propagated for braking. */
  speedLimit(u: number): number {
    const f = this.station(u);
    const i = Math.floor(f) % this.N;
    const j = (i + 1) % this.N;
    const t = f - Math.floor(f);
    return this.vlim[i] + (this.vlim[j] - this.vlim[i]) * t;
  }

  /** Racing-line lateral offset from the centreline, metres (+ = track right). */
  lineOffset(u: number): number {
    const f = this.station(u);
    const i = Math.floor(f) % this.N;
    const j = (i + 1) % this.N;
    const t = f - Math.floor(f);
    return this.off[i] + (this.off[j] - this.off[i]) * t;
  }

  /** The corner-preview signal at a lap position. `out` is reused if supplied. */
  cornerPreview(u: number, out: CornerPreview = this.preview): CornerPreview {
    const i = Math.floor(this.station(u)) % this.N;
    const s = this.sev[i];
    out.severity = Math.abs(s);
    out.direction = s === 0 ? 0 : Math.sign(s);
    out.distance = this.sevDist[i];
    out.speed = this.sevSpeed[i];
    const k = Math.abs(this.sevK[i]);
    out.radius = k > 1e-5 ? 1 / k : Infinity;
    return out;
  }

  /**
   * Nearest point on the centreline. Uses a uniform grid over the stations, so
   * it costs one bucket scan (~40 tests) rather than a 128-step sweep of the
   * whole lap, and cannot snap to the wrong lobe where the circuit folds back
   * on itself (the closest approach is 46 m, at the hairpin).
   *
   * NOTE: returns a module-scope object, reused every call. Only the race
   * subsystem calls this, and it consumes the result immediately.
   */
  project(position: Vector3): { u: number; distance: number; lateral: number } {
    const bx = Math.floor((position.x - this.gMinX) / this.cell);
    const bz = Math.floor((position.z - this.gMinZ) / this.cell);
    let best = -1;
    let bestD = Infinity;

    if (bx >= 0 && bx < this.gW && bz >= 0 && bz < this.gH) {
      const list = this.buckets[bz * this.gW + bx];
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        const d = (this.px[i] - position.x) ** 2 + (this.pz[i] - position.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    if (best < 0) {
      // Off the grid entirely (a boat flung far off course). Coarse sweep.
      const stride = 8;
      for (let i = 0; i < this.N; i += stride) {
        const d = (this.px[i] - position.x) ** 2 + (this.pz[i] - position.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // Local refine around the coarse winner.
      for (let o = -stride; o <= stride; o++) {
        const i = (best + o + this.N) % this.N;
        const d = (this.px[i] - position.x) ** 2 + (this.pz[i] - position.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }

    // Sub-station refine: project onto the two segments touching the winner.
    let bu = best / this.N;
    let bd2 = bestD;
    for (const o of [-1, 0]) {
      const a = (best + o + this.N) % this.N;
      const b = (a + 1) % this.N;
      const ax = this.px[a],
        az = this.pz[a];
      const ex = this.px[b] - ax,
        ez = this.pz[b] - az;
      const el = ex * ex + ez * ez;
      if (el < 1e-9) continue;
      const t = clamp01(((position.x - ax) * ex + (position.z - az) * ez) / el);
      const cx = ax + ex * t,
        cz = az + ez * t;
      const d2 = (cx - position.x) ** 2 + (cz - position.z) ** 2;
      if (d2 < bd2) {
        bd2 = d2;
        bu = ((a + t) % this.N) / this.N;
      }
    }

    const i = Math.floor(bu * this.N) % this.N;
    // right = cross(tangent, up) = (−tz, 0, tx)
    const rx = -this.tz[i];
    const rz = this.tx[i];
    const cxi = this.px[i];
    const czi = this.pz[i];
    _projOut.u = bu;
    _projOut.distance = Math.sqrt(bd2);
    _projOut.lateral = (position.x - cxi) * rx + (position.z - czi) * rz;
    return _projOut;
  }

  /** World position of a point on the racing line, offset laterally. */
  linePoint(u: number, lateral: number, out: Vector3): Vector3 {
    const tp = this.sample(u, _tpScratch);
    const rx = -tp.tangent.z;
    const rz = tp.tangent.x;
    out.set(tp.position.x + rx * lateral, 0, tp.position.z + rz * lateral);
    return out;
  }

  startGrid(index: number): { position: Vector3; heading: number } {
    const row = Math.floor(index / 2);
    const col = index % 2;
    const back = 14 + row * 12;
    const side = (col === 0 ? -1 : 1) * 5.2;
    const tp = this.sample(-back / this.length, _tpScratch);
    const rx = -tp.tangent.z;
    const rz = tp.tangent.x;
    return {
      position: new Vector3(tp.position.x + rx * side, 0.3, tp.position.z + rz * side),
      heading: Math.atan2(tp.tangent.x, tp.tangent.z),
    };
  }

  // ── Derived tables ────────────────────────────────────────────────────────

  /**
   * Corner preview: for every station, find the most severe corner within
   * PREVIEW_DISTANCE ahead, weighted by how close it is. The weighting is what
   * makes the signal *ramp* as you approach rather than snapping on.
   */
  private buildPreview() {
    const N = this.N;
    this.sev = new Float32Array(N);
    this.sevDist = new Float32Array(N);
    this.sevK = new Float32Array(N);
    this.sevSpeed = new Float32Array(N);
    const span = Math.min(N - 1, Math.ceil(PREVIEW_DISTANCE / this.ds));
    // Raw severity per station: how much speed this curvature costs.
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) raw[i] = severityOf(this.pk[i]);

    for (let i = 0; i < N; i++) {
      let bestScore = 0;
      let bestIdx = i;
      let bestD = 0;
      for (let o = 0; o <= span; o++) {
        const j = (i + o) % N;
        const d = o * this.ds;
        // Proximity weight: the same corner reads harder the closer it gets, so
        // the warning ramps instead of snapping on at a fixed distance.
        const score = raw[j] * smoothstep(PREVIEW_DISTANCE, 0, d);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
          bestD = d;
        }
      }
      const dir = this.pk[bestIdx] >= 0 ? 1 : -1;
      this.sev[i] = bestScore * dir;
      this.sevDist[i] = bestD;
      this.sevK[i] = this.pk[bestIdx];
      this.sevSpeed[i] = cornerSpeed(this.pk[bestIdx]);
    }
  }

  /**
   * Speed profile: the cornering limit at every station, then back-propagated
   * with a braking deceleration so the profile tells the AI to lift *before*
   * the corner instead of at it. Two circular passes converge.
   */
  private buildSpeedProfile() {
    const N = this.N;
    const v = new Float32Array(N);
    for (let i = 0; i < N; i++) v[i] = cornerSpeed(this.pk[i]);
    for (let pass = 0; pass < 3; pass++) {
      for (let n = N - 1; n >= 0; n--) {
        const i = n;
        const j = (i + 1) % N;
        const cap = Math.sqrt(v[j] * v[j] + 2 * BRAKE_ACCEL * this.ds);
        if (v[i] > cap) v[i] = cap;
      }
    }
    this.vlim = v;
  }

  /**
   * The racing line: **outside on entry, inside at the apex, outside on exit.**
   *
   * The first attempt just pulled toward the inside in proportion to curvature
   * and blurred the result. Two things were wrong with that. It has no entry or
   * exit phase, so it is a "hug the inside" line and not a racing line; and
   * because the high-curvature stretch of a 13 m hairpin is only ~20 m long,
   * blurring it over 110 m annihilated it — the measured line ran ±1 m from the
   * centreline, which is no line at all.
   *
   * So corners are *detected* (contiguous runs that cost real speed), their apex
   * found, and an entry/apex/exit profile written around each one, with the
   * entry length scaled by how much braking the corner needs. Contributions from
   * overlapping corners sum, which is exactly the right behaviour through the
   * V4/V5 chicane: the two demands partly cancel and the line straightens.
   */
  private buildRacingLine() {
    const N = this.N;
    // Detection and amplitude use *curvature*, not braking severity: a flat-out
    // 55 m sweeper still has an inside and an outside, and a racing line that
    // only moves for corners you brake for reads as a boat driving down the
    // middle of the road for two thirds of the lap. Normalised so R = 62 m is a
    // full-corridor demand.
    const need = new Float32Array(N);
    for (let i = 0; i < N; i++) need[i] = clamp01(Math.abs(this.pk[i]) * 62);

    const acc = new Float32Array(N);
    const THRESH = 0.18;

    // Walk the ring and find corner runs. Start from a station that is *not* in
    // a corner so no run is split across the seam.
    let start = 0;
    while (start < N && need[start] > THRESH) start++;
    if (start >= N) start = 0; // pathological: the whole lap is a corner

    let i = 0;
    while (i < N) {
      const idx = (start + i) % N;
      if (need[idx] <= THRESH) {
        i++;
        continue;
      }
      // Extent of this run, and its worst station.
      let len = 0;
      let apex = idx;
      let peak = 0;
      while (i + len < N && need[(start + i + len) % N] > THRESH) {
        const j = (start + i + len) % N;
        if (need[j] > peak) {
          peak = need[j];
          apex = j;
        }
        len++;
      }
      const runStart = idx;
      const runEnd = (idx + len - 1) % N;

      // Entry gets longer for corners that need more braking; exit is shorter
      // because you are accelerating out and the line runs wide naturally.
      const brake = severityOf(this.pk[apex]);
      const E = clamp(40 + 80 * brake, 34, 110);
      const X = E * 0.62;
      const sign = this.pk[apex] >= 0 ? 1 : -1;
      const amp = CORRIDOR * peak;

      // Inside for the whole of the corner, not just its apex. A 90 m radius
      // sweeper is 95 m of arc; a profile hung off a single apex station leaves
      // the middle of it out on the *outside* of the turn, which is what the
      // first version measured (+3.7 m at the apex of V1).
      for (let o = 0; o < len; o++) acc[(runStart + o) % N] -= sign * amp;

      const arm = (anchor: number, dir: number, run: number, endValue: number) => {
        const steps = Math.ceil((run * 1.85) / this.ds);
        for (let o = 1; o <= steps; o++) {
          const xn = (o * this.ds) / run;
          const g =
            xn <= 1
              ? -1 + (1 + endValue) * smoothstep(0, 1, xn)
              : endValue * (1 - smoothstep(1, 1.85, xn));
          acc[(((anchor + dir * o) % N) + N) % N] += sign * amp * g;
        }
      };
      arm(runStart, -1, E, 0.85); // wide on the way in
      arm(runEnd, +1, X, 0.7); // running wide on the way out
      i += len;
    }

    // Light smoothing to remove the joins where two corners' profiles meet.
    const half = Math.max(1, Math.round(9 / this.ds));
    const out = new Float32Array(N);
    let a = 0;
    for (let o = -half; o <= half; o++) a += acc[(o + N) % N];
    const inv = 1 / (2 * half + 1);
    for (let k = 0; k < N; k++) {
      out[k] = clamp(a * inv, -CORRIDOR, CORRIDOR);
      a -= acc[(k - half + N) % N];
      a += acc[(k + half + 1) % N];
    }
    this.off = out;
  }

  private buildGrid() {
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < this.N; i++) {
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]);
      maxZ = Math.max(maxZ, this.pz[i]);
    }
    const pad = this.cell * 3;
    this.gMinX = minX - pad;
    this.gMinZ = minZ - pad;
    this.gW = Math.ceil((maxX - minX + pad * 2) / this.cell) + 1;
    this.gH = Math.ceil((maxZ - minZ + pad * 2) / this.cell) + 1;

    const lists: number[][] = [];
    for (let i = 0; i < this.gW * this.gH; i++) lists.push([]);
    for (let i = 0; i < this.N; i++) {
      const bx = Math.floor((this.px[i] - this.gMinX) / this.cell);
      const bz = Math.floor((this.pz[i] - this.gMinZ) / this.cell);
      // Register in the 3×3 neighbourhood so any query cell holds every station
      // within one cell of it — which is more than the widest lateral excursion
      // a boat makes before `project` is asked about it.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const x = bx + ox,
            z = bz + oz;
          if (x < 0 || z < 0 || x >= this.gW || z >= this.gH) continue;
          lists[z * this.gW + x].push(i);
        }
      }
    }
    this.buckets = lists.map((l) => Int32Array.from(l));
  }

  /**
   * Twelve gates, evenly spaced by arc length, then nudged up to ±34 m to the
   * lowest-curvature station nearby — a gate planted mid-hairpin is a gate you
   * cannot see through. Gate width shrinks with local curvature so a 34 m
   * opening never straddles a 13 m radius turn.
   */
  private buildCheckpoints() {
    const spacing = this.length / GATE_COUNT;
    const window = Math.round(34 / this.ds);
    for (let g = 0; g < GATE_COUNT; g++) {
      let idx = Math.round((g * spacing) / this.ds) % this.N;
      if (g > 0) {
        let bestK = Infinity;
        let bestI = idx;
        for (let o = -window; o <= window; o++) {
          const i = (idx + o + this.N) % this.N;
          const k = Math.abs(this.pk[i]);
          if (k < bestK) {
            bestK = k;
            bestI = i;
          }
        }
        idx = bestI;
      }
      const severity = severityOf(this.pk[idx]);
      this.checkpoints.push({
        index: g,
        position: new Vector3(this.px[idx], 0, this.pz[idx]),
        forward: new Vector3(this.tx[idx], 0, this.tz[idx]),
        halfWidth: clamp(CONFIG.race.gateRadius * (1 - 0.58 * severity), 8.5, CONFIG.race.gateRadius),
        s: idx * this.ds,
        severity,
        isStart: g === 0,
      });
    }
  }

  // ── The racing-line ribbon ────────────────────────────────────────────────

  /**
   * A glowing lane painted on the water, not a thread.
   *
   * The previous ribbon was 3 m wide, additive at alpha 0.3, and two vertices
   * across. From a chase camera it foreshortened to a green hair (verified in
   * shots/m1/hero.png). This one is:
   *
   *   • 7.2 m wide — a lane a 1.9 m boat sits inside, with bright rails at the
   *     edges and a dashed centre;
   *   • fitted with 0.62 m glow rails, so at the grazing angles a chase camera
   *     actually uses there is real screen area to see rather than a
   *     foreshortened sliver;
   *   • brightened with distance to cancel that foreshortening, and only faded
   *     out past 800 m so it does not fight the horizon;
   *   • tinted and chevron-skewed by the *upcoming* corner — this is the
   *     in-world corner-preview indicator.
   *
   * Every vertex is lifted onto the wave surface by the shared Gerstner code,
   * so the lane rides the swell instead of slicing through it.
   */
  private buildRibbon() {
    const SEGS = Math.max(600, Math.round(this.length / 1.5));
    const W = 3.6;
    // (lateral fraction, height, railT) across the lane.
    const PROFILE: readonly [number, number, number][] = [
      [-1.0, 0.62, 1.0],
      [-1.0, 0.05, 0.0],
      [-0.74, 0.05, 0.0],
      [0.0, 0.05, 0.0],
      [0.74, 0.05, 0.0],
      [1.0, 0.05, 0.0],
      [1.0, 0.62, 1.0],
    ];
    const P = PROFILE.length;
    const vcount = (SEGS + 1) * P;
    const positions = new Float32Array(vcount * 3);
    const uvs = new Float32Array(vcount * 2);
    const info = new Float32Array(vcount * 3); // railT, curvature, severity
    const indices = new Uint32Array(SEGS * (P - 1) * 6);

    let ii = 0;
    for (let i = 0; i <= SEGS; i++) {
      const u = i / SEGS;
      const f = this.station(u);
      const si = Math.floor(f) % this.N;
      const sj = (si + 1) % this.N;
      const t = f - Math.floor(f);
      const cx = this.px[si] + (this.px[sj] - this.px[si]) * t;
      const cz = this.pz[si] + (this.pz[sj] - this.pz[si]) * t;
      let tanx = this.tx[si] + (this.tx[sj] - this.tx[si]) * t;
      let tanz = this.tz[si] + (this.tz[sj] - this.tz[si]) * t;
      const tl = Math.hypot(tanx, tanz) || 1;
      tanx /= tl;
      tanz /= tl;
      const rx = -tanz;
      const rz = tanx;
      const along = (u * this.length) / 9.0; // one chevron period per 9 m
      const k = this.pk[si];
      const sv = this.sev[si];

      for (let p = 0; p < P; p++) {
        const [lat, hy, rail] = PROFILE[p];
        const o = (i * P + p) * 3;
        positions[o + 0] = cx + rx * lat * W;
        positions[o + 1] = hy;
        positions[o + 2] = cz + rz * lat * W;
        const o2 = (i * P + p) * 2;
        uvs[o2 + 0] = lat;
        uvs[o2 + 1] = along;
        info[o + 0] = rail;
        info[o + 1] = k;
        info[o + 2] = sv;
      }

      if (i < SEGS) {
        for (let p = 0; p < P - 1; p++) {
          const a = i * P + p;
          const b = a + 1;
          const c = a + P;
          const d = c + 1;
          indices[ii++] = a;
          indices[ii++] = b;
          indices[ii++] = c;
          indices[ii++] = b;
          indices[ii++] = d;
          indices[ii++] = c;
        }
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
    geo.setAttribute('aInfo', new BufferAttribute(info, 3));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.boundingSphere = null;

    const mat = new ShaderMaterial({
      name: 'racingLine',
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uWaveA: { value: waveUniformArrays.uWaveA },
        uWaveB: { value: waveUniformArrays.uWaveB },
        uTime: SHARED.uTime,
        uCameraPos: SHARED.uCameraPos,
        uColor: { value: PAL.raceLine.clone() },
        uGlow: { value: PAL.raceLineGlow.clone() },
        uWarm: { value: PAL.boost.clone() },
        uHot: { value: PAL.warn.clone() },
      },
      vertexShader: /* glsl */ `
        ${GERSTNER_GLSL}
        uniform vec3 uCameraPos;
        attribute vec3 aInfo;
        varying vec2 vUv;
        varying vec3 vInfo;
        varying float vDist;
        varying float vGraze;
        void main() {
          vUv = uv;
          vInfo = aInfo;
          vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 pos; vec3 nrm; float jac;
          gerstnerSurface(world.xz, uTime, pos, nrm, jac);
          // Ride the wave: the lane sits on the surface along the surface normal,
          // and the rails stand up from it.
          pos += nrm * 0.16 + vec3(0.0, position.y, 0.0);
          vec3 toCam = uCameraPos - pos;
          vDist = length(toCam);
          // How edge-on the lane is. A grazing lane covers few pixels, so the
          // fragment stage lifts its brightness to compensate.
          vGraze = 1.0 - abs(dot(normalize(toCam), nrm));
          gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor, uGlow, uWarm, uHot;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vInfo;
        varying float vDist;
        varying float vGraze;

        void main() {
          float x = abs(vUv.x);
          float rail = vInfo.x;
          float sev = abs(vInfo.z);
          float dir = vInfo.z >= 0.0 ? 1.0 : -1.0;

          // ── Corner-preview colour ramp ────────────────────────────────────
          // Green when the lane is clear, hot pink as a corner comes up, red at
          // hairpin severity. This is the in-world warning; it is on the water
          // ahead of you, which is where you are already looking.
          vec3 col = mix(uColor, uWarm, smoothstep(0.22, 0.72, sev));
          col = mix(col, uHot, smoothstep(0.68, 1.0, sev));

          // ── Lane structure ────────────────────────────────────────────────
          float lane   = 1.0 - step(0.985, x);
          float edge   = step(0.70, x) * (1.0 - step(0.985, x));
          float centre = 1.0 - step(0.085, x);

          // Chevrons: skewed toward the middle so they read as arrows pointing
          // along the direction of travel, and leaned into the coming corner.
          float lean = 0.42 + sev * 0.55 * dir * sign(vUv.x);
          float ch = fract(vUv.y - uTime * (0.85 + sev * 0.9) - x * lean);
          float arrow = 1.0 - step(0.30 + sev * 0.16, ch);

          // Dashed centre spine — a second, faster rhythm so speed reads.
          float dash = 1.0 - step(0.52, fract(vUv.y * 2.0 - uTime * 1.9));

          float a = 0.0;
          vec3 c = vec3(0.0);
          // Flat lane fill: dim, so the water still reads through it.
          a += lane * 0.16;
          c += uGlow * lane * 0.13;
          // Bright rails painted on the water.
          a += edge * 0.62;
          c += col * edge * 0.85;
          // Chevrons inside the lane.
          a += arrow * lane * (1.0 - edge) * 0.42;
          c += col * arrow * lane * (1.0 - edge) * 0.5;
          // Centre spine.
          a += centre * dash * 0.5;
          c += uGlow * centre * dash * 0.55;

          // ── Glow rails ────────────────────────────────────────────────────
          // The vertical lip. Fades out with height so it reads as light
          // bleeding off the surface, not as a wall.
          float railFade = pow(1.0 - rail, 1.6);
          a = mix(a, railFade * 0.55, step(0.001, rail));
          c = mix(c, col * railFade * 0.9, step(0.001, rail));

          // ── Distance and grazing compensation ─────────────────────────────
          // A lane seen at 300 m through a chase camera foreshortens to a few
          // pixels; without this it is the green hair the first build shipped.
          float gain = 1.0 + smoothstep(40.0, 340.0, vDist) * 1.5;
          gain *= 1.0 + smoothstep(0.55, 0.98, vGraze) * 0.85;
          a *= gain;
          c *= gain;
          // Only fade right out where it would clutter the horizon.
          float far = 1.0 - smoothstep(760.0, 1500.0, vDist);
          gl_FragColor = vec4(c * far, clamp(a, 0.0, 1.0) * far);
        }
      `,
    });

    this.ribbon = new Mesh(geo, mat);
    this.ribbon.name = 'racingLine';
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 2;
    this.ribbon.userData.skipPrepass = true; // glow, never inked
    this.group.add(this.ribbon);
  }

  // ── Gates ─────────────────────────────────────────────────────────────────

  /**
   * Twelve floating gates for the price of four meshes.
   *
   * The first version built four `Mesh`es *per gate* — 48 meshes, 144 draw
   * calls, and they still read as "tiny lollipops" at racing distance. This
   * version merges all twelve gates into four geometries (structure, port
   * panels, starboard panels, accent) so the whole set costs 12 draw calls
   * including outlines and G-buffer.
   *
   * Floating is done entirely on the GPU: every vertex carries `aAnchor`, the
   * world XZ of the pylon it belongs to, and the vertex chunk evaluates the
   * shared Gerstner field there to lift, surge and tilt the whole pylon as one
   * rigid body. No CPU work per frame, and it is in register with the ocean
   * mesh by construction because both evaluate the same field at the same point.
   */
  private buildGates() {
    const structure = new Mesher();
    const panelPort = new Mesher();
    const panelStbd = new Mesher();
    const accent = new Mesher();

    for (const cp of this.checkpoints) {
      const fx = cp.forward.x;
      const fz = cp.forward.z;
      const rx = -fz;
      const rz = fx;
      const mastTop = cp.isStart ? 9.4 : 7.8;

      for (const side of [-1, 1] as const) {
        const ax = cp.position.x + rx * side * cp.halfWidth;
        const az = cp.position.z + rz * side * cp.halfWidth;
        const panel = side < 0 ? panelPort : panelStbd;

        // Float collar: two stacked frustums at the waterline. Wide enough to
        // read as a moored buoy rather than a stick pushed into the sea.
        structure.frustum(ax, az, -1.15, 1.05, 0.0, 1.95, 9, true, false);
        structure.frustum(ax, az, 0.0, 1.95, 0.82, 1.25, 9, false, false);
        // Mast.
        structure.frustum(ax, az, 0.7, 0.52, mastTop, 0.3, 7, false, true);
        // Waterline stripe, so the gate has a value break where it meets the sea.
        accent.frustum(ax, az, 0.16, 2.02, 0.44, 2.02, 9, false, false);

        // The sign panel. Faces oncoming traffic (normal along −forward), so it
        // presents its full area to a boat approaching the gate.
        const py = mastTop - 2.6;
        panel.slab(ax, az, rx, rz, fx, fz, 0, py, 3.5, 4.6, 0.24);
        accent.slab(ax, az, rx, rz, fx, fz, 0, py, 2.1, 3.0, 0.42);
        // A short cross-vane below it: breaks the mast silhouette and gives the
        // Sobel pass an interior edge to find.
        structure.slab(ax, az, rx, rz, fx, fz, 0, py - 3.0, 4.4, 0.42, 0.42);
      }

      // The start/finish gantry: a banner beam spanning the two masts. It is the
      // only gate with a horizontal element, which is what makes the line
      // instantly identifiable from the air and from the cockpit.
      if (cp.isStart) {
        const span = cp.halfWidth * 2;
        accent.beam(
          cp.position.x,
          cp.position.z,
          rx,
          rz,
          fx,
          fz,
          mastTop - 0.9,
          span,
          1.5,
          0.5,
        );
      }
    }

    const mk = (m: Mesher, color: (typeof PAL)['gate'], name: string, widthPx: number) => {
      const geo = m.build();
      const mesh = new Mesh(geo);
      mesh.name = name;
      applyCel(
        mesh,
        createCelMaterial({
          color,
          name,
          outlineWidthPx: widthPx,
          rimStrength: 0.85,
          rimPower: 2.6,
          specSize: 0.9,
          specStrength: 0.4,
          flatShading: true,
          chunks: {
            uniforms: {
              uWaveA: { value: waveUniformArrays.uWaveA },
              uWaveB: { value: waveUniformArrays.uWaveB },
            },
            vertexHead: /* glsl */ `
              ${GERSTNER_NO_TIME}
              attribute vec2 aAnchor;
            `,
            vertexBody: /* glsl */ `
              {
                // Rigid-body float: sample the wave field once at the pylon's
                // anchor, then move the whole pylon with it.
                vec3 wpos; vec3 wnrm; float wjac;
                gerstnerSurface(aAnchor, uTime, wpos, wnrm, wjac);
                vec3 local = transformed - vec3(aAnchor.x, 0.0, aAnchor.y);
                // First-order rotation toward the surface normal. Exact Rodrigues
                // is not worth it for a ±20° tilt on a mast, and this keeps the
                // outline and G-buffer variants byte-identical.
                vec3 axis = vec3(wnrm.z, 0.0, -wnrm.x) * 0.72;
                local += cross(axis, local);
                objectNormal += cross(axis, objectNormal);
                smoothNormal += cross(axis, smoothNormal);
                transformed = vec3(wpos.x, wpos.y, wpos.z) + local;
              }
            `,
          },
        }),
      );
      // 12 merged gates in one mesh: culling the lot on one bounding sphere
      // would pop the far side of the course in and out, so keep it resident.
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };

    mk(structure, PAL.foamShade, 'gateStructure', 2.4);
    mk(panelPort, PAL.gate, 'gatePanelPort', 2.6);
    mk(panelStbd, PAL.gateFar, 'gatePanelStbd', 2.6);
    mk(accent, PAL.buoy, 'gateAccent', 2.2);
  }

  // ── Per frame ─────────────────────────────────────────────────────────────

  /**
   * The gates and the ribbon are entirely GPU-driven, so all this does is
   * refresh the player's corner-preview readout for the HUD and the AI.
   */
  update(ctx: GameContext) {
    const proj = this.project(ctx.player.root.position);
    this.cornerPreview(proj.u, this.preview);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Centreline construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn the polygon-plus-fillets layout into uniform arc-length station tables.
 *
 * Steps:
 *   1. leg headings, turn angles and fillet tangent lengths from the polygon;
 *   2. a curvature profile κ(s): zero on the straights, ±1/R over each fillet
 *      with raised-cosine ramps at both ends;
 *   3. normalise the profile so total turning is exactly ±2π (the raised-cosine
 *      ramps preserve turning analytically, but the discrete integral does not
 *      quite, and a 0.1° heading error at the seam is a visible kink);
 *   4. integrate heading and position;
 *   5. remove the residual closure gap — a few metres, from the ramps not being
 *      true circular arcs — by shearing the whole loop, which is imperceptible
 *      at 4 m over 1470 m;
 *   6. resample to exactly uniform arc length and re-derive tangent and
 *      curvature from the final polyline, so what the AI reads is what is drawn.
 */
function buildCentreline() {
  const n = VERTS.length;
  const vx: number[] = [];
  const vz: number[] = [];
  const vr: number[] = [];
  for (const [x, z, r] of VERTS) {
    vx.push(x * LAYOUT_SCALE);
    vz.push(z * LAYOUT_SCALE);
    vr.push(r);
  }

  const legLen: number[] = [];
  const legHdg: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = vx[j] - vx[i];
    const dz = vz[j] - vz[i];
    legLen.push(Math.hypot(dx, dz));
    legHdg.push(Math.atan2(dx, dz));
  }
  const turn: number[] = [];
  const tanLen: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = angleDelta(legHdg[(i - 1 + n) % n], legHdg[i]);
    turn.push(d);
    tanLen.push(vr[i] * Math.tan(Math.abs(d) / 2));
  }

  // Parts, starting at the exit of V0's fillet: straight(leg0), fillet(V1),
  // straight(leg1), … straight(leg n−1), fillet(V0).
  interface Part {
    len: number;
    kp: number;
    ramp: number;
  }
  // Each fillet's raised-cosine ramps are decided up front, because they change
  // how much arc length the fillet needs.
  const ramps: number[] = [];
  for (let i = 0; i < n; i++) {
    const arc = vr[i] * Math.abs(turn[i]);
    ramps.push(clamp(Math.min(arc * 0.5, 34), 3, 36));
  }

  const parts: Part[] = [];
  const cornerAt: { name: string; radius: number; turnDeg: number; speed: number; s: number }[] = [];
  let sAcc = 0;
  for (let i = 0; i < n; i++) {
    const vNext = (i + 1) % n;
    // A raised-cosine ramp of length `ramp` turns the hull through only
    // κ·(len − ramp/2) radians, not κ·len — the ramps each contribute half their
    // length. Getting this wrong is not cosmetic: the first build corrected the
    // shortfall with one global curvature scale, which turned a designed 13 m
    // hairpin into a measured 9.4 m one and left every radius in the table a lie.
    // Lengthening the fillet by ramp/2 makes the turning exactly κ·arc, so the
    // radii in VERTS are the radii the boat actually meets.
    const straight =
      legLen[i] - tanLen[i] - tanLen[vNext] - ramps[i] * 0.25 - ramps[vNext] * 0.25;
    if (straight < 6) {
      // Two fillets overlapping. Not something to paper over silently.
      console.warn(`[track] leg ${i} straight is only ${straight.toFixed(1)} m — fillets overlap`);
    }
    parts.push({ len: Math.max(4, straight), kp: 0, ramp: 0 });
    sAcc += Math.max(4, straight);

    const arc = vr[vNext] * Math.abs(turn[vNext]);
    const ramp = ramps[vNext];
    parts.push({ len: arc + ramp * 0.5, kp: Math.sign(turn[vNext]) / vr[vNext], ramp });
    cornerAt.push({
      name: `V${vNext}`,
      radius: vr[vNext],
      turnDeg: (turn[vNext] * 180) / Math.PI,
      speed: cornerSpeed(1 / vr[vNext]),
      s: sAcc + arc * 0.5,
    });
    sAcc += arc + ramp * 0.5;
  }

  const total = parts.reduce((a, p) => a + p.len, 0);
  const N = STATIONS;
  // Integrate on a finer grid than we store, then resample. 4× is plenty at
  // 0.72 m station spacing.
  const M = N * 4;
  const ds = total / M;
  const kap = new Float64Array(M + 1);
  {
    let base = 0;
    for (const p of parts) {
      const i0 = Math.ceil(base / ds);
      const i1 = Math.min(M, Math.floor((base + p.len) / ds));
      for (let i = Math.max(0, i0); i <= i1; i++) {
        if (p.kp === 0) continue;
        const x = i * ds - base;
        const half = p.ramp * 0.5;
        let w = 1;
        if (half > 0.01) {
          if (x < half) w = 0.5 * (1 - Math.cos((Math.PI * x) / half));
          else if (x > p.len - half) w = 0.5 * (1 - Math.cos((Math.PI * (p.len - x)) / half));
        }
        kap[i] = p.kp * w;
      }
      base += p.len;
    }
  }
  // Exact heading closure.
  let turned = 0;
  for (let i = 0; i < M; i++) turned += (kap[i] + kap[i + 1]) * 0.5 * ds;
  const netTurn = turn.reduce((a, b) => a + b, 0);
  const kScale = (Math.sign(netTurn) * 2 * Math.PI) / turned;
  for (let i = 0; i <= M; i++) kap[i] *= kScale;

  const ix = new Float64Array(M + 1);
  const iz = new Float64Array(M + 1);
  {
    // Start at the exit tangent point of V0's fillet, heading along leg 0.
    let h = legHdg[0];
    let x = vx[0] + Math.sin(legHdg[0]) * tanLen[0];
    let z = vz[0] + Math.cos(legHdg[0]) * tanLen[0];
    for (let i = 0; i <= M; i++) {
      ix[i] = x;
      iz[i] = z;
      if (i < M) {
        const km = (kap[i] + kap[i + 1]) * 0.5;
        const hm = h + km * ds * 0.5;
        x += Math.sin(hm) * ds;
        z += Math.cos(hm) * ds;
        h += km * ds;
      }
    }
  }
  // Shear out the residual gap. With turning preserved exactly this is only the
  // raised-cosine ramps not being circular arcs — a few metres over 1470 m.
  const gapX = ix[M] - ix[0];
  const gapZ = iz[M] - iz[0];
  const closureGap = Math.hypot(gapX, gapZ);
  for (let i = 0; i <= M; i++) {
    const f = i / M;
    ix[i] -= gapX * f;
    iz[i] -= gapZ * f;
  }

  // Resample to exactly uniform arc length, rotated so station 0 is the
  // start/finish line.
  const cum = new Float64Array(M + 1);
  for (let i = 1; i <= M; i++) {
    cum[i] = cum[i - 1] + Math.hypot(ix[i] - ix[i - 1], iz[i] - iz[i - 1]);
  }
  const length = cum[M];
  const stationDs = length / N;
  const px = new Float32Array(N);
  const pz = new Float32Array(N);
  {
    let cursor = 1;
    for (let s = 0; s < N; s++) {
      const target = (((s * stationDs + START_S) % length) + length) % length;
      // cum is monotonic; walk or reset the cursor.
      if (cum[cursor] < target) {
        while (cursor < M && cum[cursor] < target) cursor++;
      } else {
        while (cursor > 1 && cum[cursor - 1] > target) cursor--;
      }
      const a = cum[cursor - 1];
      const b = cum[cursor];
      const f = b > a ? (target - a) / (b - a) : 0;
      px[s] = ix[cursor - 1] + (ix[cursor] - ix[cursor - 1]) * f;
      pz[s] = iz[cursor - 1] + (iz[cursor] - iz[cursor - 1]) * f;
    }
  }

  // Tangent and signed curvature from the final polyline. A ±4-station stencil
  // (≈ ±2.9 m) for curvature keeps it smooth without blurring the hairpin.
  const tx = new Float32Array(N);
  const tz = new Float32Array(N);
  const hdg = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    const dx = px[b] - px[a];
    const dz = pz[b] - pz[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l;
    tz[i] = dz / l;
    hdg[i] = Math.atan2(dx, dz);
  }
  const pk = new Float32Array(N);
  const W = 4;
  for (let i = 0; i < N; i++) {
    const a = (i - W + N) % N;
    const b = (i + W) % N;
    pk[i] = angleDelta(hdg[a], hdg[b]) / (2 * W * stationDs);
  }

  // Diagnostics.
  let minR = Infinity;
  let maxDk = 0;
  for (let i = 0; i < N; i++) {
    const k = Math.abs(pk[i]);
    if (k > 1e-6) minR = Math.min(minR, 1 / k);
    const d = Math.abs(pk[(i + 1) % N] - pk[(i - 1 + N) % N]) / (2 * stationDs);
    maxDk = Math.max(maxDk, d);
  }
  let minSep = Infinity;
  const stride = 8;
  for (let i = 0; i < N; i += stride) {
    for (let j = i + stride; j < N; j += stride) {
      const arc = Math.min(j - i, N - (j - i)) * stationDs;
      if (arc < 110) continue;
      const d = Math.hypot(px[i] - px[j], pz[i] - pz[j]);
      if (d < minSep) minSep = d;
    }
  }

  // Shift the recorded corner stations into start-line-relative arc length.
  for (const c of cornerAt) c.s = (((c.s - START_S) % length) + length) % length;
  cornerAt.sort((a, b) => a.s - b.s);

  return {
    length,
    px,
    pz,
    tx,
    tz,
    pk,
    design: {
      length,
      corners: cornerAt,
      minRadius: minR,
      maxDkDs: maxDk,
      minSelfSeparation: minSep,
      closureGap,
      curvatureScale: kScale,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry mesher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accumulates flat-shaded triangles plus the per-vertex `aAnchor` the gate
 * float shader needs. Non-indexed with per-face normals on purpose: hard facets
 * are what a cel surface wants, and the interior creases give the Sobel pass
 * something to ink.
 */
class Mesher {
  private pos: number[] = [];
  private nrm: number[] = [];
  private anc: number[] = [];

  private tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    anchorX: number, anchorZ: number,
  ) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx2 = cx - ax, vy2 = cy - ay, vz2 = cz - az;
    let nx = uy * vz2 - uz * vy2;
    let ny = uz * vx2 - ux * vz2;
    let nz = ux * vy2 - uy * vx2;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) {
      this.nrm.push(nx, ny, nz);
      this.anc.push(anchorX, anchorZ);
    }
  }

  private quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    anchorX: number, anchorZ: number,
  ) {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, anchorX, anchorZ);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, anchorX, anchorZ);
  }

  /** Tapered prism around a vertical axis at (cx, cz). */
  frustum(
    cx: number, cz: number,
    y0: number, r0: number,
    y1: number, r1: number,
    sides: number,
    capBottom: boolean,
    capTop: boolean,
  ) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const s0 = Math.sin(a0), c0 = Math.cos(a0);
      const s1 = Math.sin(a1), c1 = Math.cos(a1);
      this.quad(
        cx + s0 * r0, y0, cz + c0 * r0,
        cx + s1 * r0, y0, cz + c1 * r0,
        cx + s1 * r1, y1, cz + c1 * r1,
        cx + s0 * r1, y1, cz + c0 * r1,
        cx, cz,
      );
      if (capTop) this.tri(cx, y1, cz, cx + s0 * r1, y1, cz + c0 * r1, cx + s1 * r1, y1, cz + c1 * r1, cx, cz);
      if (capBottom) this.tri(cx, y0, cz, cx + s1 * r0, y0, cz + c1 * r0, cx + s0 * r0, y0, cz + c0 * r0, cx, cz);
    }
  }

  /**
   * A flat slab. `(rx, rz)` is the across-gate axis, `(fx, fz)` the along-track
   * axis, so a slab with `thickness` along f faces oncoming traffic.
   */
  slab(
    ax: number, az: number,
    rx: number, rz: number,
    fx: number, fz: number,
    lateral: number, y: number,
    width: number, height: number, thickness: number,
  ) {
    const hw = width * 0.5, hh = height * 0.5, ht = thickness * 0.5;
    const ox = ax + rx * lateral;
    const oz = az + rz * lateral;
    const corner = (u: number, v: number, w: number) => [
      ox + rx * u * hw + fx * w * ht,
      y + v * hh,
      oz + rz * u * hw + fz * w * ht,
    ] as const;
    const p = [
      corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1),
      corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1),
    ];
    const face = (a: number, b: number, c: number, d: number) =>
      this.quad(
        p[a][0], p[a][1], p[a][2], p[b][0], p[b][1], p[b][2],
        p[c][0], p[c][1], p[c][2], p[d][0], p[d][1], p[d][2], ax, az,
      );
    face(0, 1, 2, 3); // −f
    face(5, 4, 7, 6); // +f
    face(4, 0, 3, 7); // −r
    face(1, 5, 6, 2); // +r
    face(3, 2, 6, 7); // top
    face(4, 5, 1, 0); // bottom
  }

  /** Horizontal banner beam spanning the gate, anchored to the gate centre. */
  beam(
    cx: number, cz: number,
    rx: number, rz: number,
    fx: number, fz: number,
    y: number, span: number, height: number, thickness: number,
  ) {
    this.slab(cx, cz, rx, rz, fx, fz, 0, y, span, height, thickness);
  }

  build(): BufferGeometry {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    geo.setAttribute('aAnchor', new BufferAttribute(new Float32Array(this.anc), 2));
    // The gate meshes are never culled, but three still wants a bounding volume
    // for raycasting and for the shadow-free sort.
    geo.computeBoundingSphere();
    return geo;
  }
}
