/**
 * The circuit.
 *
 * A closed CatmullRom spline on open water, rendered as a glowing ribbon that
 * is displaced by the *same* Gerstner field as the ocean — so it rises and
 * falls with the swell instead of clipping through it. The ribbon's vertex
 * shader includes GERSTNER_GLSL directly; there is no CPU work per frame.
 *
 * ── Circuit design ─────────────────────────────────────────────────────────
 * Deliberately shaped, not a rounded rectangle:
 *
 *   S1  start/finish straight, long, flat-out
 *   C1  wide right-hand sweeper — carries speed, rewards a late apex
 *   S2  short straight into…
 *   C2  hairpin — hard brake, the main overtaking spot
 *   C3  chicane — left-right flick, punishes a boat still sliding
 *   X   cross-swell run: this leg is aimed roughly perpendicular to the two
 *       dominant swell directions, so boats take the waves side-on and get
 *       real airtime off the crests
 *   C4  long constant-radius sweeper back onto the straight
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { CONFIG } from '../core/config';
import { PAL } from '../core/palette';
import { applyCel, createCelMaterial, SHARED } from '../render/celMaterial';
import { GERSTNER_GLSL, sampleOcean, waveUniformArrays } from '../water/gerstner';
import type { Checkpoint, GameContext, Subsystem, TrackAPI, TrackPoint } from '../core/types';

/**
 * Control points, metres. Hand-placed. The swell runs roughly along +X/+Z, so
 * the CROSS-SWELL leg (marked) is aimed to cut across it.
 */
const CONTROL_POINTS: [number, number][] = [
  [0, 0],        // start / finish line
  [4, 150],
  [16, 300],     // S1 — start straight
  [70, 420],
  [190, 486],    // C1 — wide sweeper entry
  [330, 500],
  [452, 452],    // C1 exit
  [530, 352],    // S2
  [566, 236],
  [540, 140],    // C2 — hairpin approach
  [470, 84],
  [418, 46],
  [452, -22],    // C2 — hairpin apex
  [520, -60],
  [498, -150],   // C3 — chicane in
  [396, -178],
  [330, -128],   // C3 — chicane out
  [232, -166],
  [120, -212],   // X — cross-swell leg begins
  [-20, -218],
  [-132, -168],  // X — cross-swell leg ends
  [-196, -70],   // C4 — long sweeper home
  [-168, 24],
  [-92, 34],
];

const _up = new Vector3(0, 1, 0);
const _t0 = new Vector3();
const _t1 = new Vector3();

export class Track implements TrackAPI, Subsystem {
  readonly name = 'track';
  readonly order = 25;

  readonly group = new Group();
  readonly curve: CatmullRomCurve3;
  readonly checkpoints: Checkpoint[] = [];
  readonly length: number;

  /** Arc-length lookup: cumulative distance at each of N uniform t samples. */
  private arcLengths: Float32Array;
  private readonly SAMPLES = 2048;
  private ribbon!: Mesh;
  private gateGroup = new Group();

  constructor() {
    const pts = CONTROL_POINTS.map(([x, z]) => new Vector3(x, 0, z));
    this.curve = new CatmullRomCurve3(pts, true, 'catmullrom', 0.5);

    // Build an arc-length table so we can sample by metres rather than by the
    // spline's non-uniform parameter. Without this, AI lookahead and gate
    // spacing bunch up in the corners.
    this.arcLengths = new Float32Array(this.SAMPLES + 1);
    let acc = 0;
    let prev = this.curve.getPoint(0);
    for (let i = 1; i <= this.SAMPLES; i++) {
      const p = this.curve.getPoint(i / this.SAMPLES);
      acc += p.distanceTo(prev);
      this.arcLengths[i] = acc;
      prev = p;
    }
    this.length = acc;

    this.buildCheckpoints();
    this.buildRibbon();
    this.buildGates();
    this.group.add(this.gateGroup);
  }

  // ── Sampling ──────────────────────────────────────────────────────────────

  /** Convert normalised arc-length u → spline parameter t. */
  private uToT(u: number): number {
    const target = ((u % 1) + 1) % 1 * this.length;
    // Binary search the cumulative table.
    let lo = 0,
      hi = this.SAMPLES;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.arcLengths[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const a = this.arcLengths[i - 1],
      b = this.arcLengths[i];
    const frac = b > a ? (target - a) / (b - a) : 0;
    return (i - 1 + frac) / this.SAMPLES;
  }

  sample(u: number, out?: TrackPoint): TrackPoint {
    const t = this.uToT(u);
    const result: TrackPoint = out ?? {
      position: new Vector3(),
      tangent: new Vector3(),
      curvature: 0,
      u: 0,
    };
    this.curve.getPoint(t, result.position);
    this.curve.getTangent(t, result.tangent).normalize();

    // Curvature by finite difference of the tangent — good enough for AI
    // braking cues and the corner-preview arrow, and far cheaper than the
    // analytic second derivative.
    const dt = 0.004;
    this.curve.getTangent((t + dt) % 1, _t1).normalize();
    this.curve.getTangent((t - dt + 1) % 1, _t0).normalize();
    result.curvature = _t1.distanceTo(_t0) / (2 * dt * this.length * 0.001);
    result.u = ((u % 1) + 1) % 1;
    return result;
  }

  sampleDistance(d: number, out?: TrackPoint): TrackPoint {
    return this.sample(d / this.length, out);
  }

  /**
   * Nearest point on the centreline. Coarse scan then local refine — the
   * circuit has no self-intersections, so a 128-step scan cannot pick the
   * wrong lobe.
   */
  project(position: Vector3): { u: number; distance: number; lateral: number } {
    let bestU = 0;
    let bestD = Infinity;
    const COARSE = 128;
    const p = new Vector3();
    for (let i = 0; i < COARSE; i++) {
      const u = i / COARSE;
      this.curve.getPoint(this.uToT(u), p);
      const d = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestU = u;
      }
    }
    // Refine.
    let step = 1 / COARSE;
    for (let iter = 0; iter < 6; iter++) {
      step *= 0.5;
      for (const s of [-step, step]) {
        const u = ((bestU + s) % 1 + 1) % 1;
        this.curve.getPoint(this.uToT(u), p);
        const d = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
        if (d < bestD) {
          bestD = d;
          bestU = u;
        }
      }
    }
    const tp = this.sample(bestU);
    const toPos = new Vector3().subVectors(position, tp.position);
    const rightVec = new Vector3().crossVectors(tp.tangent, _up).normalize();
    return { u: bestU, distance: Math.sqrt(bestD), lateral: toPos.dot(rightVec) };
  }

  startGrid(index: number): { position: Vector3; heading: number } {
    // Two-by-two grid staggered back from the line.
    const row = Math.floor(index / 2);
    const col = index % 2;
    const back = 12 + row * 11;
    const side = (col === 0 ? -1 : 1) * 4.6;
    const u = ((1 - back / this.length) % 1 + 1) % 1;
    const tp = this.sample(u);
    const right = new Vector3().crossVectors(tp.tangent, _up).normalize();
    const position = tp.position.clone().addScaledVector(right, side);
    position.y = 0.3;
    return { position, heading: Math.atan2(tp.tangent.x, tp.tangent.z) };
  }

  // ── Construction ──────────────────────────────────────────────────────────

  private buildCheckpoints() {
    // Gates spaced evenly by arc length, with the first exactly on the line.
    const COUNT = 12;
    for (let i = 0; i < COUNT; i++) {
      const u = i / COUNT;
      const tp = this.sample(u);
      this.checkpoints.push({
        index: i,
        position: tp.position.clone(),
        forward: tp.tangent.clone(),
        halfWidth: CONFIG.race.gateRadius,
      });
    }
  }

  /**
   * The racing-line ribbon.
   *
   * Built flat in XZ; the vertex shader lifts every vertex onto the wave
   * surface with the shared Gerstner code and offsets it slightly along the
   * surface normal so it lies *on* the water rather than intersecting it.
   */
  private buildRibbon() {
    const SEGS = 1400;
    const HALF_WIDTH = 1.5;
    const positions = new Float32Array((SEGS + 1) * 2 * 3);
    const uvs = new Float32Array((SEGS + 1) * 2 * 2);
    const indices = new Uint32Array(SEGS * 6);

    const p = new Vector3();
    const tan = new Vector3();
    const right = new Vector3();

    for (let i = 0; i <= SEGS; i++) {
      const u = i / SEGS;
      const t = this.uToT(u);
      this.curve.getPoint(t, p);
      this.curve.getTangent(t, tan).normalize();
      right.crossVectors(tan, _up).normalize();

      const o = i * 6;
      positions[o + 0] = p.x - right.x * HALF_WIDTH;
      positions[o + 1] = 0;
      positions[o + 2] = p.z - right.z * HALF_WIDTH;
      positions[o + 3] = p.x + right.x * HALF_WIDTH;
      positions[o + 4] = 0;
      positions[o + 5] = p.z + right.z * HALF_WIDTH;

      const t2 = i * 4;
      // V runs along the ribbon in metres/8 so the dash pattern is uniform.
      const along = (u * this.length) / 8;
      uvs[t2 + 0] = 0;
      uvs[t2 + 1] = along;
      uvs[t2 + 2] = 1;
      uvs[t2 + 3] = along;

      if (i < SEGS) {
        const b = i * 2;
        const n = i * 6;
        indices[n + 0] = b;
        indices[n + 1] = b + 1;
        indices[n + 2] = b + 2;
        indices[n + 3] = b + 1;
        indices[n + 4] = b + 3;
        indices[n + 5] = b + 2;
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    geo.setAttribute('uv', new BufferAttribute(uvs, 2));
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
      },
      vertexShader: /* glsl */ `
        ${GERSTNER_GLSL}
        uniform vec3 uCameraPos;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          vUv = uv;
          vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 pos; vec3 nrm; float jac;
          gerstnerSurface(world.xz, uTime, pos, nrm, jac);
          // Lift along the surface normal so the ribbon hugs the wave face
          // rather than sinking into the back of a crest.
          pos += nrm * 0.14;
          vDist = length(pos - uCameraPos);
          gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor, uGlow;
        uniform float uTime;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          // Hard-edged centre stripe with a softer shoulder — reads as a
          // painted line with a glow, not an airbrushed gradient.
          float edge = abs(vUv.x - 0.5) * 2.0;
          float core = 1.0 - step(0.42, edge);
          float shoulder = 1.0 - step(1.0, edge);

          // Chevrons scrolling in the direction of travel.
          float chev = fract(vUv.y - uTime * 0.55);
          float arrow = step(chev, 0.34);

          vec3 col = mix(uGlow * 0.55, uColor, core);
          col += uColor * arrow * core * 0.7;
          float alpha = shoulder * (0.30 + core * 0.55 + arrow * core * 0.3);
          // Fade out at distance so the line does not fight the horizon.
          alpha *= 1.0 - smoothstep(420.0, 900.0, vDist);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    this.ribbon = new Mesh(geo, mat);
    this.ribbon.name = 'racingLine';
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 2;
    this.ribbon.userData.skipPrepass = true; // the line is glow, never inked
    this.group.add(this.ribbon);
  }

  /** Floating checkpoint gates: two pylons and a ring, cel-shaded and outlined. */
  private buildGates() {
    const pylonGeo = new CylinderGeometry(0.42, 0.62, 4.4, 8);
    const ringGeo = new TorusGeometry(1.5, 0.22, 6, 16);

    for (const cp of this.checkpoints) {
      const g = new Group();
      const right = new Vector3().crossVectors(cp.forward, _up).normalize();

      for (const side of [-1, 1]) {
        const pylon = new Mesh(pylonGeo);
        applyCel(
          pylon,
          createCelMaterial({
            color: side < 0 ? PAL.gate : PAL.gateFar,
            outlineWidthPx: 2.2,
            rimStrength: 0.9,
            name: 'gatePylon',
          }),
        );
        pylon.position.copy(right).multiplyScalar(side * cp.halfWidth * 0.85);
        pylon.position.y = 1.6;
        g.add(pylon);

        const ring = new Mesh(ringGeo);
        applyCel(
          ring,
          createCelMaterial({ color: PAL.buoy, outlineWidthPx: 2.0, name: 'gateRing' }),
        );
        ring.position.copy(pylon.position).setY(3.6);
        ring.rotation.y = Math.atan2(cp.forward.x, cp.forward.z);
        g.add(ring);
      }

      g.position.copy(cp.position);
      g.userData.checkpointIndex = cp.index;
      this.gateGroup.add(g);
    }
  }

  /** Gates float: re-seat each one on the wave surface every frame. */
  update(ctx: GameContext) {
    const t = ctx.time;
    for (const g of this.gateGroup.children) {
      const cp = this.checkpoints[g.userData.checkpointIndex as number];
      const s = ctx.ocean.sample(cp.position.x, cp.position.z, t);
      g.position.y = s.height;
      // Rock with the surface normal — gates that stay perfectly upright on a
      // moving sea instantly read as static props.
      g.rotation.x = Math.asin(-s.normal.z) * 0.55;
      g.rotation.z = Math.asin(s.normal.x) * 0.55;
    }
  }
}
