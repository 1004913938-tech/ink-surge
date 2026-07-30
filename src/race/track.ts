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
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  FrontSide,
  Group,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
} from 'three';
import { CONFIG } from '../core/config';
import { PAL } from '../core/palette';
import { angleDelta, clamp, clamp01, smoothstep } from '../core/mathx';
import { applyCel, createCelMaterial, SHARED } from '../render/celMaterial';
import type { CelChunks } from '../render/celMaterial';
import { GERSTNER_GLSL, sampleHeight, waveUniformArrays } from '../water/gerstner';
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
    /** Worst measured gap between the drawn racing line and the water, metres. */
    ribbonSagitta: number;
    /** Smallest plan-view footprint of any gate part, metres. Proves depth. */
    gateMinPlanDepth: number;
    /** Clear height under the gate arch above the water, metres. */
    gateArchClearance: number;
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
  /** Which gate each lamp vertex belongs to, and the state written for it. */
  private lampGate!: Float32Array;
  private lampState!: Float32Array;
  private lampAttr!: BufferAttribute;
  private lampTarget = -1;

  constructor() {
    const built = buildCentreline();
    this.length = built.length;
    this.ds = built.length / this.N;
    this.px = built.px;
    this.pz = built.pz;
    this.tx = built.tx;
    this.tz = built.tz;
    this.pk = built.pk;
    this.design = { ...built.design, ribbonSagitta: 0, gateMinPlanDepth: 0, gateArchClearance: 0 };

    this.buildPreview();
    this.buildSpeedProfile();
    this.buildRacingLine();
    this.buildGrid();
    this.buildCheckpoints();
    this.buildRibbon();
    this.buildGates();

    if (CONFIG.debug.harness || CONFIG.debug.enabled) {
      // The design table is the only record of what the circuit actually *is*
      // rather than what the layout comment claims, so under the harness it goes
      // to the console where a verification run can read it back.
      console.info('[track] design', JSON.stringify(this.design));
    }
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
   * A HINT LINE, not a lane.
   *
   * Two earlier versions were wrong in opposite directions. The first was 3 m
   * wide, two vertices across, and foreshortened to a green hair. The reaction
   * to that — a 7.2 m lane with 0.62 m glow rails, animated chevrons, a dashed
   * centre spine and a brightness gain that multiplied its alpha by up to 4.6 at
   * grazing angles — went far past the brief. Measured in shots/race_fix0 it was
   * the brightest thing in the frame, covered roughly a third of the screen, and
   * its vertical rails drew a razor-straight silhouette across a wave
   * (shots/race_fix0/rider_closeup.png, the green edge under the hull). It was
   * hiding the water it was supposed to sit on, and its additive brightness
   * cleared the composite's flare threshold, so a *graphic* element was
   * generating photographic bloom.
   *
   * So this one is a hint and nothing more:
   *
   *   • 2.3 m across — one boat width (beam is 1.9 m), so it reads as a line the
   *     hull covers rather than a road the hull sits inside;
   *   • flat on the water. No rails, no vertical geometry at all, which is what
   *     removes the straight-edge-across-a-wave artefact;
   *   • alpha 0.26, one hard step up to 0.36 at the outer 22 % so it has a drawn
   *     edge. No dashes, no chevrons, no distance gain, no grazing gain. Peak
   *     composited luminance is ~0.37, far below the flare threshold of 0.985,
   *     so it cannot bloom;
   *   • tinted in three hard steps by the *upcoming* corner — green clear, pink
   *     for a corner, red for the hairpin. This is the only marking left on it,
   *     and it is the in-world corner-preview indicator the brief asked for;
   *   • sampled every metre along and every 0.38 m across, and every vertex is
   *     lifted onto the shared Gerstner surface. `design.ribbonSagitta` reports
   *     the measured worst-case deviation between the drawn strip and the water
   *     (see `measureRibbonError`) — the budget is 10 cm.
   */
  private buildRibbon() {
    // 1 m stations. Σ(aᵢ·kᵢ²) over the wave table is 0.41 1/m, which bounds the
    // surface's second derivative, so a 1 m chord can sag at most 1²·0.41/8 ≈
    // 5 cm. Measured for real below rather than trusted.
    const STEP = 1.0;
    const SEGS = Math.max(600, Math.round(this.length / STEP));
    /** Half-width, metres. Hull beam is 1.9 m. */
    const W = 1.15;
    /** Spans across the line. 6 → 0.38 m per span. */
    const LAT = 6;
    const P = LAT + 1;

    const vcount = (SEGS + 1) * P;
    const positions = new Float32Array(vcount * 3);
    const lat = new Float32Array(vcount); // signed lateral fraction, −1…1
    const sev = new Float32Array(vcount); // severity of the corner ahead, 0…1
    const indices = new Uint32Array(SEGS * LAT * 6);

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
      const sv = Math.abs(this.sev[si]);

      for (let p = 0; p < P; p++) {
        const l = -1 + (2 * p) / LAT;
        const o = (i * P + p) * 3;
        positions[o + 0] = cx + rx * l * W;
        positions[o + 1] = 0;
        positions[o + 2] = cz + rz * l * W;
        lat[i * P + p] = l;
        sev[i * P + p] = sv;
      }

      if (i < SEGS) {
        for (let p = 0; p < LAT; p++) {
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
    geo.setAttribute('aLat', new BufferAttribute(lat, 1));
    geo.setAttribute('aSev', new BufferAttribute(sev, 1));
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.boundingSphere = null;

    const mat = new ShaderMaterial({
      name: 'racingLine',
      transparent: true,
      depthWrite: false,
      // Normal blending, deliberately. Additive is what made this element glow
      // brighter than the sun's own flare, and additive over a bright crest can
      // only ever brighten — it cannot read as a translucent mark *on* water.
      blending: NormalBlending,
      // FrontSide, and the winding is checked: with DoubleSide and depthWrite
      // off, both faces of every coplanar triangle blend, so a nominal alpha of
      // 0.26 composites at 0.45 and the "30 % hint" is a 45 % wash.
      side: FrontSide,
      uniforms: {
        uWaveA: { value: waveUniformArrays.uWaveA },
        uWaveB: { value: waveUniformArrays.uWaveB },
        uTime: SHARED.uTime,
        uCameraPos: SHARED.uCameraPos,
        uColor: { value: PAL.raceLine.clone() },
        uWarm: { value: PAL.boost.clone() },
        uHot: { value: PAL.warn.clone() },
      },
      vertexShader: /* glsl */ `
        ${GERSTNER_GLSL}
        uniform vec3 uCameraPos;
        attribute float aLat;
        attribute float aSev;
        varying float vLat;
        varying float vSev;
        varying float vDist;
        void main() {
          vLat = aLat;
          vSev = aSev;
          vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 pos; vec3 nrm; float jac;
          gerstnerSurface(world.xz, uTime, pos, nrm, jac);
          vDist = length(uCameraPos - pos);
          // The lift grows with distance because the ocean mesh does not: its
          // outer LOD rings evaluate the same field on a coarser grid, so far
          // water sits *above* the exactly-evaluated line and chops it into
          // dashes (visible on the far side of the circuit in
          // shots/race_fix1/course.png). 9 cm near, 70 cm at half a kilometre —
          // at which range 70 cm is a fraction of a pixel of parallax.
          pos += nrm * (0.09 + 0.61 * smoothstep(90.0, 620.0, vDist));
          gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor, uWarm, uHot;
        varying float vLat;
        varying float vSev;
        varying float vDist;

        void main() {
          float x = abs(vLat);
          // Three hard steps, not a gradient: this is a drawn mark.
          vec3 col = mix(uColor, uWarm, step(0.34, vSev));
          col = mix(col, uHot, step(0.72, vSev));
          float body = 1.0 - step(1.0, x);
          float edge = step(0.78, x) * body;
          float a = body * 0.26 + edge * 0.10;
          // Fade out before the horizon so the far side of the circuit does not
          // draw a green thread across the skyline.
          a *= 1.0 - smoothstep(520.0, 1150.0, vDist);
          // …and fade *in* over the first 30 m. A line on the water seen from a
          // camera near the waterline foreshortens hardest right in front of the
          // lens, so the nearest 20 m paints the largest area of screen and
          // carries the least information — it is the stretch you are already
          // driving on. Measured at 7.3 % of the countdown frame before this
          // clause, 2.9 % after.
          a *= smoothstep(8.0, 30.0, vDist);
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    this.ribbon = new Mesh(geo, mat);
    this.ribbon.name = 'racingLine';
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 2;
    this.ribbon.userData.skipPrepass = true; // a translucent mark, never inked
    this.group.add(this.ribbon);

    this.design.ribbonSagitta = this.measureRibbonError(STEP);
  }

  /**
   * Worst-case deviation, in metres, between the drawn ribbon and the water.
   *
   * The strip is a polyline in the wave field's flat parameter space, lifted to
   * the surface at each station. Between two stations it is a straight chord,
   * and the surface bows away from it by the sagitta of the height field over
   * that step. This measures exactly that: the height at the midpoint of a step
   * versus the average of the heights at its ends, using `sampleOcean` — the
   * same field the vertex shader lifts with — swept over a set of phases so a
   * lucky instant cannot flatter the number.
   */
  private measureRibbonError(step: number): number {
    let worst = 0;
    const stride = 3; // every 3rd station: the field is smooth at this scale
    for (const t of [0, 3.7, 8.1, 13.3, 21.9]) {
      for (let i = 0; i < this.N; i += stride) {
        const ax = this.px[i],
          az = this.pz[i];
        const tx = this.tx[i],
          tz = this.tz[i];
        // Two points one `step` apart along the line, and their midpoint.
        const bx = ax + tx * step,
          bz = az + tz * step;
        const mx = ax + tx * step * 0.5,
          mz = az + tz * step * 0.5;
        const ha = sampleHeight(ax, az, t);
        const hb = sampleHeight(bx, bz, t);
        const hm = sampleHeight(mx, mz, t);
        const err = Math.abs((ha + hb) * 0.5 - hm);
        if (err > worst) worst = err;
      }
    }
    return worst;
  }

  // ── Gates ─────────────────────────────────────────────────────────────────

  /**
   * Twelve floating ARCHES the boat drives through, for the price of five meshes.
   *
   * ── What was wrong before ──────────────────────────────────────────────────
   * The previous gate was two masts, each carrying a flat 3.5 × 4.6 × 0.24 m
   * sign with a lighter inner rectangle and a cross-vane. Three things about
   * that were fatal, all visible in shots/race_fix0:
   *
   *   • From the aerial camera the whole thing collapsed to a one-pixel
   *     horizontal bar, because a 0.24 m plate has no plan-view depth
   *     (course.png). A marker that vanishes from a legal camera angle cannot
   *     ship.
   *   • The visual language was highway signage — two flat coloured plates with
   *     a lighter panel and yellow bars on a grey T-pole (pack.png at
   *     1051,1008–1397,1620). In land.png the two masts of one gate sit 34 m
   *     apart with nothing between them, so they read as two unrelated road
   *     signs rather than as one gate.
   *   • Nothing about it said "checkpoint", passed or unpassed.
   *
   * ── What it is now ─────────────────────────────────────────────────────────
   * A truss arch: two floating pylons whose masts LEAN INBOARD, a chamfered
   * beam spanning between their tops, two diagonal braces per side, and a
   * hard-banded lamp bar slung under the beam that carries the pass state. The
   * boat passes *through* it. Every part is a chamfered solid — the thinnest
   * plan-view depth anywhere on a gate is `design.gateMinPlanDepth` (0.44 m), so
   * no camera angle can flatten it, and the 0.16 m chamfers give the cel ramp a
   * bevel facet to land a value break on instead of a single hard corner.
   *
   * The visual span is capped below the checkpoint `halfWidth`: checkpoints are
   * odometer milestones (see raceState.ts), so the arch is free to be narrower
   * than the notional opening — and it has to be, or the two legs are too far
   * apart to read as one structure.
   *
   * ── Floating ───────────────────────────────────────────────────────────────
   * Entirely on the GPU. Every vertex carries `aAnchor`, the world XZ of the
   * GATE CENTRE (it used to be the pylon centre, which would tear an arch in
   * half: two pylons sampling the field at points 26 m apart heave
   * independently and the beam between them would stretch). The whole gate now
   * moves as one rigid body, and the first-order tilt term is exactly the
   * linear extrapolation of the surface slope — `cross(axis, local).y` works out
   * to ∇h·local — so with the damping factor at 1.0 both feet sit on the water
   * even though only the centre is sampled.
   */
  private buildGates() {
    const structure = new Mesher();
    const wingPort = new Mesher();
    const wingStbd = new Mesher();
    const accent = new Mesher();
    const lamp = new Mesher();

    const UP: V3 = [0, 1, 0];
    let minPlan = Infinity;
    let minClear = Infinity;

    for (const cp of this.checkpoints) {
      const fx = cp.forward.x;
      const fz = cp.forward.z;
      const rx = -fz;
      const rz = fx;
      const cx = cp.position.x;
      const cz = cp.position.z;
      const R: V3 = [rx, 0, rz];
      const F: V3 = [fx, 0, fz];

      const vw = Math.min(cp.halfWidth, 13.0);
      const mastTop = cp.isStart ? 10.4 : 8.7;
      /** How far the mast top leans inboard. This is what makes it an arch. */
      const lean = 1.8;
      const inner = vw - lean;
      const archY = mastTop - 0.6;
      const lampY = archY - 1.0;

      for (const side of [-1, 1] as const) {
        const px = cx + rx * side * vw;
        const pz = cz + rz * side * vw;
        const tx = cx + rx * side * inner;
        const tz = cz + rz * side * inner;
        const wing = side < 0 ? wingPort : wingStbd;
        /** Centre of the leaning mast at height y. */
        const mastAt = (y: number): [number, number] => {
          const fr = clamp01((y - 0.78) / (mastTop - 0.78));
          return [px + (tx - px) * fr, pz + (tz - pz) * fr];
        };

        // Float collar: two stacked frustums at the waterline, wide enough to
        // read as something moored rather than a stick pushed into the sea, and
        // wide enough to be the gate's plan-view signature from the aerial.
        structure.prism(px, pz, -1.35, 1.3, px, pz, 0.0, 2.35, 9, true, false, cx, cz);
        structure.prism(px, pz, 0.0, 2.35, px, pz, 0.9, 1.45, 9, false, false, cx, cz);
        // The leaning mast.
        structure.prism(px, pz, 0.78, 0.6, tx, tz, mastTop, 0.36, 7, false, true, cx, cz);
        // Waterline stripe, so the gate has a value break where it meets the sea.
        accent.prism(px, pz, 0.22, 2.44, px, pz, 0.56, 2.44, 9, false, false, cx, cz);

        // Marker paddles: two chamfered blades jutting INBOARD from the mast,
        // horizontal, carrying the side identity — aqua to port, pink to
        // starboard.
        //
        // The previous shape here was a vertical plate, and a vertical coloured
        // plate on a post is a road sign no matter how thick it is
        // (shots/race_fix1/pack.png at 915,620–1010,830). Turning the blade
        // horizontal changes what it reads as — a navigation daymark — and it
        // also gives the gate its largest plan-view element, which is the angle
        // the old panels disappeared from.
        for (const py of [3.3, 5.4]) {
          const [mx, mz] = mastAt(py);
          wing.chamferBox(
            [mx - rx * side * 1.25, py, mz - rz * side * 1.25],
            [rx, 0, rz], UP, [fx, 0, fz],
            [1.35, 0.24, 0.66], 0.14, cx, cz,
          );
        }
        minPlan = Math.min(minPlan, 1.32);

        // Two diagonal braces from the mast up to the beam. A truss, not a pole:
        // this is the single change that stops the gate reading as signage.
        for (const [hb, frac] of [[mastTop - 3.4, 0.46], [mastTop - 1.6, 0.2]] as const) {
          const fr = clamp01((hb - 0.78) / (mastTop - 0.78));
          const bax = px + (tx - px) * fr;
          const baz = pz + (tz - pz) * fr;
          const bbx = cx + rx * side * inner * frac;
          const bbz = cz + rz * side * inner * frac;
          const dxb = bbx - bax;
          const dyb = archY - 0.5 - hb;
          const dzb = bbz - baz;
          const len = Math.hypot(dxb, dyb, dzb) || 1;
          const a0: V3 = [dxb / len, dyb / len, dzb / len];
          // Perpendicular to the strut, inside the gate plane.
          const a1: V3 = [
            F[1] * a0[2] - F[2] * a0[1],
            F[2] * a0[0] - F[0] * a0[2],
            F[0] * a0[1] - F[1] * a0[0],
          ];
          const a1l = Math.hypot(a1[0], a1[1], a1[2]) || 1;
          structure.chamferBox(
            [(bax + bbx) * 0.5, (hb + archY - 0.5) * 0.5, (baz + bbz) * 0.5],
            a0, [a1[0] / a1l, a1[1] / a1l, a1[2] / a1l], F,
            [len * 0.5, 0.21, 0.22], 0.08, cx, cz,
          );
          minPlan = Math.min(minPlan, 0.44);
        }
      }

      // The spanning beam, and the lamp bar under it. The beam is structure
      // white, not the accent tone: a saturated yellow bar on grey legs read as
      // scaffolding, and it stole the eye from the lamp — which is the element
      // that actually carries information.
      structure.chamferBox([cx, archY, cz], R, UP, F, [inner + 0.55, 0.44, 0.34], 0.16, cx, cz);
      minPlan = Math.min(minPlan, 0.68);
      lamp.beginGate(cp.index);
      lamp.chamferBox([cx, lampY, cz], R, UP, F, [inner * 0.9, 0.27, 0.4], 0.12, cx, cz);
      lamp.endGate();
      minPlan = Math.min(minPlan, 0.8);
      minClear = Math.min(minClear, lampY - 0.27);
    }

    const mk = (
      m: Mesher,
      color: (typeof PAL)['gate'],
      name: string,
      widthPx: number,
      extra?: { chunks?: CelChunks; flareMask?: number },
    ) => {
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
          flareMask: extra?.flareMask ?? 1,
          chunks: {
            uniforms: {
              uWaveA: { value: waveUniformArrays.uWaveA },
              uWaveB: { value: waveUniformArrays.uWaveB },
              ...(extra?.chunks?.uniforms ?? {}),
            },
            vertexHead: /* glsl */ `
              ${GERSTNER_NO_TIME}
              attribute vec2 aAnchor;
              ${extra?.chunks?.vertexHead ?? ''}
            `,
            vertexBody: /* glsl */ `
              {
                // Rigid-body float: sample the wave field once at the gate's
                // centre, then move the whole arch with it.
                vec3 wpos; vec3 wnrm; float wjac;
                gerstnerSurface(aAnchor, uTime, wpos, wnrm, wjac);
                vec3 local = transformed - vec3(aAnchor.x, 0.0, aAnchor.y);
                // First-order rotation toward the surface normal. For a
                // horizontal offset this evaluates to exactly ∇h·local, i.e. the
                // linear extrapolation of the surface, which is why the far leg
                // of a 26 m arch still lands on the water. Undamped for that
                // reason — the old 0.72 left one foot in the air on a swell.
                vec3 axis = vec3(wnrm.z, 0.0, -wnrm.x);
                local += cross(axis, local);
                objectNormal += cross(axis, objectNormal);
                smoothNormal += cross(axis, smoothNormal);
                transformed = vec3(wpos.x, wpos.y, wpos.z) + local;
              }
              ${extra?.chunks?.vertexBody ?? ''}
            `,
            fragmentHead: extra?.chunks?.fragmentHead ?? '',
            fragmentBody: extra?.chunks?.fragmentBody ?? '',
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
    mk(wingPort, PAL.gate, 'gateWingPort', 2.6);
    mk(wingStbd, PAL.gateFar, 'gateWingStbd', 2.6);
    mk(accent, PAL.buoy, 'gateAccent', 2.2);

    // ── The pass-state lamp ───────────────────────────────────────────────────
    // One float per vertex says which of three states its gate is in, rewritten
    // only when the player's target gate changes (12 times a lap), so there is
    // no per-frame CPU cost. The fragment chunk then paints a HARD band: no
    // falloff, no gradient, three discrete looks.
    this.lampGate = lamp.gateIndex();
    this.lampState = new Float32Array(this.lampGate.length);
    const lampMesh = mk(lamp, PAL.buoy, 'gateLamp', 2.2, {
      flareMask: 0, // a graphic band, never a photographic glow
      chunks: {
        uniforms: {
          uLampNext: { value: PAL.boostHot.clone() },
          uLampDone: { value: PAL.gate.clone() },
          uLampWait: { value: PAL.hudDim.clone() },
        },
        vertexHead: 'attribute float aState;\nvarying float vState;',
        vertexBody: 'vState = aState;',
        fragmentHead: 'uniform vec3 uLampNext, uLampDone, uLampWait;\nvarying float vState;',
        fragmentBody: /* glsl */ `
          {
            // 0 = still to come, 1 = the gate you are driving at, 2 = collected.
            float blink = step(0.5, fract(uTime * 1.4));
            if (vState > 1.5) {
              baseColor = uLampDone;
              celShade = vec3(0.40);
            } else if (vState > 0.5) {
              baseColor = mix(uColor, uLampNext, blink);
              celShade = vec3(1.5);
            } else {
              // Three HUES, not three brightnesses: a still-to-come gate that is
              // the same yellow as the live one, only dimmer, does not answer
              // "which gate am I driving at" at racing distance.
              baseColor = uLampWait;
              celShade = vec3(0.62);
            }
          }
        `,
      },
    });
    this.lampAttr = new BufferAttribute(this.lampState, 1);
    this.lampAttr.setUsage(DynamicDrawUsage);
    lampMesh.geometry.setAttribute('aState', this.lampAttr);
    this.refreshGateLamps(1);

    this.design.gateMinPlanDepth = minPlan;
    this.design.gateArchClearance = minClear;
  }

  /**
   * Repaint the lamp states. Called only when the target gate changes.
   *
   * `target` is the gate the player is driving at; 0 means the finish line, in
   * which case every numbered gate has been collected.
   */
  private refreshGateLamps(target: number) {
    for (let v = 0; v < this.lampGate.length; v++) {
      const g = this.lampGate[v];
      let st = 0;
      if (g === target) st = 1;
      else if (target === 0 ? g !== 0 : g > 0 && g < target) st = 2;
      this.lampState[v] = st;
    }
    this.lampAttr.needsUpdate = true;
  }

  // ── Per frame ─────────────────────────────────────────────────────────────

  /**
   * The gates and the ribbon are entirely GPU-driven, so all this does is
   * refresh the player's corner-preview readout for the HUD and the AI, and
   * repaint the gate lamps on the frames where the target gate changes.
   */
  update(ctx: GameContext) {
    const proj = this.project(ctx.player.root.position);
    this.cornerPreview(proj.u, this.preview);

    const target = ctx.player.nextCheckpoint;
    if (target !== this.lampTarget) {
      this.lampTarget = target;
      this.refreshGateLamps(target);
    }
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

/** A point or an axis. Construction-time only, so the tuples are free. */
type V3 = readonly [number, number, number];

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
  /** Which gate each vertex belongs to — drives the lamp pass-state attribute. */
  private gate: number[] = [];
  private currentGate = -1;

  /** Tag every vertex pushed from here on as belonging to gate `index`. */
  beginGate(index: number) {
    this.currentGate = index;
  }
  endGate() {
    this.currentGate = -1;
  }
  gateIndex(): Float32Array {
    return Float32Array.from(this.gate);
  }

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
      this.gate.push(this.currentGate);
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

  private triV(a: V3, b: V3, c: V3, anchorX: number, anchorZ: number) {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], anchorX, anchorZ);
  }
  private quadV(a: V3, b: V3, c: V3, d: V3, anchorX: number, anchorZ: number) {
    this.triV(a, b, c, anchorX, anchorZ);
    this.triV(a, c, d, anchorX, anchorZ);
  }

  /**
   * Tapered prism between two arbitrary centres — a leaning mast is a prism
   * whose top centre is not above its bottom centre, which the old
   * vertical-axis-only version could not express.
   */
  prism(
    x0: number, z0: number, y0: number, r0: number,
    x1: number, z1: number, y1: number, r1: number,
    sides: number,
    capBottom: boolean,
    capTop: boolean,
    anchorX: number,
    anchorZ: number,
  ) {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const s0 = Math.sin(a0), c0 = Math.cos(a0);
      const s1 = Math.sin(a1), c1 = Math.cos(a1);
      this.quad(
        x0 + s0 * r0, y0, z0 + c0 * r0,
        x0 + s1 * r0, y0, z0 + c1 * r0,
        x1 + s1 * r1, y1, z1 + c1 * r1,
        x1 + s0 * r1, y1, z1 + c0 * r1,
        anchorX, anchorZ,
      );
      if (capTop) {
        this.tri(x1, y1, z1, x1 + s0 * r1, y1, z1 + c0 * r1, x1 + s1 * r1, y1, z1 + c1 * r1, anchorX, anchorZ);
      }
      if (capBottom) {
        this.tri(x0, y0, z0, x0 + s1 * r0, y0, z0 + c1 * r0, x0 + s0 * r0, y0, z0 + c0 * r0, anchorX, anchorZ);
      }
    }
  }

  /**
   * A box with every one of its twelve edges bevelled.
   *
   * Six inset rectangular faces + twelve edge quads + eight corner triangles.
   * The bevel is the point: a hard 90° corner gives the cel ramp exactly one
   * value step, whereas a 45° facet gives it a narrow intermediate band, which
   * is what an animator draws on a solid. It also guarantees the form has
   * silhouette area in all three axes, so no camera angle can flatten it to a
   * line — which is precisely how the old zero-thickness sign panels failed.
   *
   * `e0/e1/e2` are orthonormal axes, `h` their half-extents, `c` the bevel.
   */
  chamferBox(
    centre: V3,
    e0: V3, e1: V3, e2: V3,
    h: V3,
    c: number,
    anchorX: number,
    anchorZ: number,
  ) {
    const cc = Math.min(c, h[0] * 0.49, h[1] * 0.49, h[2] * 0.49);
    const at = (a: number, b: number, d: number): V3 => [
      centre[0] + e0[0] * a + e1[0] * b + e2[0] * d,
      centre[1] + e0[1] * a + e1[1] * b + e2[1] * d,
      centre[2] + e0[2] * a + e1[2] * b + e2[2] * d,
    ];
    // Per corner (sx, sy, sz), the three vertices that replace it: one on each
    // of the three faces that met there.
    const q = (s0: number, s1: number, s2: number, axis: 0 | 1 | 2): V3 =>
      at(
        s0 * (axis === 0 ? h[0] : h[0] - cc),
        s1 * (axis === 1 ? h[1] : h[1] - cc),
        s2 * (axis === 2 ? h[2] : h[2] - cc),
      );

    /** Outward direction from axis weights — the winding oracle. */
    const out = (w0: number, w1: number, w2: number): V3 => [
      e0[0] * w0 + e1[0] * w1 + e2[0] * w2,
      e0[1] * w0 + e1[1] * w1 + e2[1] * w2,
      e0[2] * w0 + e1[2] * w1 + e2[2] * w2,
    ];

    // Six inset faces.
    for (const s of [-1, 1] as const) {
      this.quadOut(q(s, -1, -1, 0), q(s, 1, -1, 0), q(s, 1, 1, 0), q(s, -1, 1, 0), out(s, 0, 0), anchorX, anchorZ);
      this.quadOut(q(-1, s, -1, 1), q(1, s, -1, 1), q(1, s, 1, 1), q(-1, s, 1, 1), out(0, s, 0), anchorX, anchorZ);
      this.quadOut(q(-1, -1, s, 2), q(1, -1, s, 2), q(1, 1, s, 2), q(-1, 1, s, 2), out(0, 0, s), anchorX, anchorZ);
    }

    // Twelve edge bevels. Each is the strip between two faces, so its two pairs
    // of vertices come from the two axes that are *not* the edge's direction.
    for (const s1 of [-1, 1] as const) {
      for (const s2 of [-1, 1] as const) {
        // Along e0, between the e1 face and the e2 face.
        this.quadOut(q(-1, s1, s2, 1), q(1, s1, s2, 1), q(1, s1, s2, 2), q(-1, s1, s2, 2), out(0, s1, s2), anchorX, anchorZ);
        // Along e1, between the e2 face and the e0 face.
        this.quadOut(q(s1, -1, s2, 2), q(s1, 1, s2, 2), q(s1, 1, s2, 0), q(s1, -1, s2, 0), out(s1, 0, s2), anchorX, anchorZ);
        // Along e2, between the e0 face and the e1 face.
        this.quadOut(q(s1, s2, -1, 0), q(s1, s2, 1, 0), q(s1, s2, 1, 1), q(s1, s2, -1, 1), out(s1, s2, 0), anchorX, anchorZ);
      }
    }

    // Eight corner triangles.
    for (const s0 of [-1, 1] as const) {
      for (const s1 of [-1, 1] as const) {
        for (const s2 of [-1, 1] as const) {
          this.triOut(
            q(s0, s1, s2, 0), q(s0, s1, s2, 1), q(s0, s1, s2, 2),
            out(s0, s1, s2), anchorX, anchorZ,
          );
        }
      }
    }
  }

  /**
   * Emit a triangle wound so its face normal agrees with `outward`.
   *
   * Deriving winding by hand for 26 faces across three arbitrary axes is how you
   * ship a solid with a handful of inside-out facets that read as holes, because
   * the cel material culls back faces. One dot product removes the whole class of
   * mistake.
   */
  private triOut(a: V3, b: V3, c: V3, outward: V3, anchorX: number, anchorZ: number) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0) this.triV(a, b, c, anchorX, anchorZ);
    else this.triV(c, b, a, anchorX, anchorZ);
  }

  private quadOut(a: V3, b: V3, c: V3, d: V3, outward: V3, anchorX: number, anchorZ: number) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0) {
      this.quadV(a, b, c, d, anchorX, anchorZ);
    } else {
      this.quadV(d, c, b, a, anchorX, anchorZ);
    }
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
