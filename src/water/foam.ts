/**
 * Wake ribbons — the persistent trail every boat leaves in the water.
 *
 * ── Why a ribbon and not a decal ────────────────────────────────────────────
 * A projected decal has to be re-projected onto a moving displaced surface
 * every frame and always ends up either floating or clipping. A ribbon of
 * geometry whose vertices are *evaluated on the wave field in the vertex
 * shader* cannot float: it rides the exact same `gerstnerSurface` the ocean
 * mesh and the buoyancy solver use, so it stays welded to the water no matter
 * how the swell moves under it.
 *
 * ── Shape of the system ─────────────────────────────────────────────────────
 * One `Mesh`, one draw call, for all four boats. Each boat owns a slice of a
 * shared vertex buffer: a ring buffer of `POINTS` trail samples, two vertices
 * per sample (port and starboard). Every frame:
 *
 *   1. if the boat has moved far enough, push a new sample at the stern
 *   2. age every sample
 *   3. rewrite the boat's vertex slice oldest → newest
 *
 * The lateral offset is computed on the CPU (we know the direction between
 * consecutive samples there) so the shader only has to do the wave lookup.
 *
 * ── Age drives three things ─────────────────────────────────────────────────
 *   • **spread** — the ribbon widens behind the boat, the way a real Kelvin
 *     wake diverges. Width is baked into the CPU-side vertex positions.
 *   • **alpha**, quantised to hard steps. A smooth fade is the single fastest
 *     way to make foam read as a semi-transparent PNG rather than as ink.
 *   • **dissipation** — the alpha step is compared against world-space noise, so
 *     as the ribbon ages holes open in it and it breaks into patches instead of
 *     ghosting out uniformly. This is what makes the trail read as foam
 *     *dispersing* rather than as a fading ribbon.
 *
 * A gap opens automatically when a boat is airborne: those samples are marked
 * invalid and written with zero width, which collapses the quad to a degenerate
 * sliver.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Texture,
} from 'three';
import { GERSTNER_GLSL, waveUniformArrays } from './gerstner';
import { CONFIG } from '../core/config';
import { PAL } from '../core/palette';
import { SHARED } from '../render/celMaterial';
import { makeNoiseTexture } from '../render/textures';
import { SprayField } from './spray';
import type { GameContext, Racer } from '../core/types';

/** Trail samples per boat. 96 × ~1.15 m ≈ 110 m of visible wake. */
const POINTS = 96;
/**
 * Metres of travel between samples. 1.15 m puts ~4.8 s of trail on screen at
 * race speed, which is what makes the age-driven dissipation legible — at the
 * 0.85 m of the first pass the whole ribbon was under 3.5 s old and the tail
 * never got far enough into its life to visibly break up.
 */
const EMIT_STEP = 1.15;
/** Seconds a sample lives before it is fully dissipated. */
const LIFE = 4.6;
/** Metres per second the ribbon half-width grows — the Kelvin divergence. */
const SPREAD = 1.35;
/**
 * Vertices across the ribbon.
 *
 * Two is not enough, and the reason is geometric: with only the two edges as
 * vertices, Y is linearly interpolated across a strip that can be ten metres
 * wide, so the middle of the ribbon cuts a straight chord under a curved wave
 * and sinks below the ocean mesh, where it is depth-rejected. Five vertices
 * across follow the swell closely enough that the whole ribbon stays on top of
 * the water, and give the fragment shader a real cross-section to shade.
 */
const CROSS = 5;

interface Trail {
  /** Chronological ring buffer. `head` is the index of the newest sample. */
  x: Float32Array;
  z: Float32Array;
  /** Unit lateral direction (perpendicular to travel) at this sample. */
  nx: Float32Array;
  nz: Float32Array;
  age: Float32Array;
  /** Half-width at emission, metres. */
  w0: Float32Array;
  /** 0…1 — how much churn this sample was born with (speed, drift, landing). */
  power: Float32Array;
  /** 0 = the boat was airborne or stopped; the segment collapses. */
  valid: Float32Array;
  head: number;
  count: number;
  lastX: number;
  lastZ: number;
  /** Distance travelled since the last emitted sample. */
  carry: number;
}

function makeTrail(): Trail {
  return {
    x: new Float32Array(POINTS),
    z: new Float32Array(POINTS),
    nx: new Float32Array(POINTS),
    nz: new Float32Array(POINTS),
    age: new Float32Array(POINTS),
    w0: new Float32Array(POINTS),
    power: new Float32Array(POINTS),
    valid: new Float32Array(POINTS),
    head: -1,
    count: 0,
    lastX: 0,
    lastZ: 0,
    carry: 0,
  };
}

export class WakeRibbons {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private trails: Trail[] = [];

  private aPos: BufferAttribute;
  private aSide: BufferAttribute;
  private aAge: BufferAttribute;
  private aPower: BufferAttribute;
  /** Distance along the ribbon from the stern, metres — drives the churn head. */
  private aRun: BufferAttribute;

  constructor(racerCount: number, noise: Texture) {
    for (let i = 0; i < racerCount; i++) this.trails.push(makeTrail());

    const verts = racerCount * POINTS * CROSS;
    const positions = new Float32Array(verts * 3);
    const sides = new Float32Array(verts);
    const ages = new Float32Array(verts);
    const powers = new Float32Array(verts);
    const runs = new Float32Array(verts);

    // Index buffer is static: two triangles per (segment × cross strip), per boat.
    const quads = racerCount * (POINTS - 1) * (CROSS - 1);
    const indices = new Uint16Array(quads * 6);
    let n = 0;
    for (let r = 0; r < racerCount; r++) {
      const base = r * POINTS * CROSS;
      for (let i = 0; i < POINTS - 1; i++) {
        for (let c = 0; c < CROSS - 1; c++) {
          const a = base + i * CROSS + c;
          const b = a + 1;
          const d = a + CROSS;
          const e = d + 1;
          indices[n++] = a;
          indices[n++] = b;
          indices[n++] = d;
          indices[n++] = b;
          indices[n++] = e;
          indices[n++] = d;
        }
      }
    }

    const geo = new BufferGeometry();
    this.aPos = new BufferAttribute(positions, 3);
    this.aSide = new BufferAttribute(sides, 1);
    this.aAge = new BufferAttribute(ages, 1);
    this.aPower = new BufferAttribute(powers, 1);
    this.aRun = new BufferAttribute(runs, 1);
    this.aPos.setUsage(DynamicDrawUsage);
    this.aAge.setUsage(DynamicDrawUsage);
    this.aPower.setUsage(DynamicDrawUsage);
    this.aRun.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aSide', this.aSide);
    geo.setAttribute('aAge', this.aAge);
    geo.setAttribute('aPower', this.aPower);
    geo.setAttribute('aRun', this.aRun);
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.boundingSphere = null;

    // Static per-vertex side, written once: −1 … +1 across the ribbon.
    for (let i = 0; i < verts; i++) sides[i] = ((i % CROSS) / (CROSS - 1)) * 2 - 1;

    this.material = new ShaderMaterial({
      name: 'wakeRibbon',
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      side: DoubleSide,
      uniforms: {
        uWaveA: { value: waveUniformArrays.uWaveA },
        uWaveB: { value: waveUniformArrays.uWaveB },
        uTime: SHARED.uTime,
        uCameraPos: SHARED.uCameraPos,
        uSunDir: SHARED.uSunDir,
        uNoise: { value: noise },
        uFoam: { value: PAL.foam.clone() },
        uFoamShade: { value: PAL.foamShade.clone() },
        uCrest: { value: PAL.waterCrest.clone() },
        /**
         * Metres above the surface the ribbon sits. The ocean mesh draws the
         * *band-limited* field and the ribbon the raw one, so they differ by a
         * few centimetres near steep crests; the lift has to clear that as well
         * as depth precision.
         */
        uLift: { value: 0.2 },
        uLife: { value: LIFE },
        /** Noise tile in metres — large, so the wake never reads as tiled. */
        uTile: { value: 5.6 },
        uOpacity: { value: 0.85 },
      },
      vertexShader: /* glsl */ `
        ${GERSTNER_GLSL}

        attribute float aSide;
        attribute float aAge;
        attribute float aPower;
        attribute float aRun;

        uniform float uLift;

        varying float vSide;
        varying float vAge;
        varying float vPower;
        varying float vRun;
        varying vec3 vWorldPos;

        void main() {
          // The CPU baked the spread into the XZ position; all the shader does is
          // put that point on the shared wave field, which is the only way the
          // ribbon can stay welded to a displaced surface.
          vec3 p; vec3 nrm; float j;
          gerstnerSurface(position.xz, uTime, p, nrm, j);
          p.y += uLift;

          vSide = aSide;
          vAge = aAge;
          vPower = aPower;
          vRun = aRun;
          vWorldPos = p;

          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;

        uniform sampler2D uNoise;
        uniform vec3 uFoam, uFoamShade, uCrest;
        uniform float uTime, uLife, uTile, uOpacity;

        varying float vSide;
        varying float vAge;
        varying float vPower;
        varying float vRun;
        varying vec3 vWorldPos;

        void main() {
          float life = clamp(1.0 - vAge / uLife, 0.0, 1.0);
          float v = abs(vSide);

          // Dissipation noise. Sampled first because the ribbon's cross-section
          // is warped by it as well as being masked with it. Three scales so the
          // holes are lacy and the rail edges are chewed rather than ruled.
          vec2 uv = vWorldPos.xz / uTile;
          vec4 nA = texture2D(uNoise, uv + vec2(uTime * 0.01, uTime * -0.006));
          vec4 nB = texture2D(uNoise, uv * 3.7 - vec2(uTime * 0.03, 0.0));
          float grain = nA.r * 0.44 + nA.g * 0.2 + nB.b * 0.22 + nB.g * 0.14;

          // Across-ribbon profile, three parts:
          //   • two narrow divergent crest lines — a *ridge* at |v| ≈ 0.86, not a
          //     ramp from the middle outward. The r7 capture had these as
          //     smoothstep(0.50, 0.97), which covers half the ribbon on each side;
          //     with the interior fill on top the whole wake became a solid white
          //     highway with a few holes in it.
          //   • solid churn immediately behind the transom
          //   • a sparse turbulent field between the rails, so the water inside
          //     the V is disturbed without being painted
          // The rail's centre line and width are both noise-modulated, so it is a
          // chewed foam ridge rather than a ruled lane marking — which is what the
          // r8 capture showed when both were constants.
          float railPos = 0.86 + (grain - 0.5) * 0.13;
          float railW = 0.14 + grain * 0.07;
          float rail = 1.0 - smoothstep(0.0, railW, abs(v - railPos));
          float centre = 1.0 - smoothstep(0.0, 0.5, v);
          float head = 1.0 - smoothstep(1.5, 9.0, vRun);
          float fill = (1.0 - smoothstep(0.5, 1.0, v)) * 0.24;
          float edge = rail;
          float shape = max(max(rail * 0.9, centre * head), fill * (0.35 + 0.65 * life));

          // Coverage falls with age; the noise threshold turns that into holes.
          // Capped below 1 so the noise always has range left to bite holes with.
          float coverage = clamp(shape * (0.30 + 0.70 * life) * (0.45 + 0.75 * vPower), 0.0, 0.9);
          float thr = 1.0 - coverage;
          float w = max(fwidth(grain) * 0.7, 0.015);
          float mask = smoothstep(thr - w, thr + w, grain);
          if (mask < 0.02) discard;

          // Alpha in three hard steps. A smooth ramp is what makes foam read as
          // a semi-transparent sprite rather than as ink.
          float a = mask * (step(0.62, life) * 0.40 + step(0.28, life) * 0.32 + 0.28);

          // Mostly uFoamShade. Full uFoam is above the flare pass's threshold, so
          // a wake painted in it blooms into a glowing tube — which is exactly
          // what the r4 capture showed. Only the freshest, most powerful churn on
          // the crest lines is allowed to clear that threshold.
          float hot = smoothstep(0.4, 0.9, life) * max(edge, centre * head) * (0.4 + 0.6 * vPower);
          vec3 col = mix(uFoamShade, uFoam, hot);
          // Old foam settles toward the crest tone so it dissolves into the water.
          col = mix(mix(uCrest, uFoamShade, 0.62), col, smoothstep(0.0, 0.40, life));

          gl_FragColor = vec4(col, a * uOpacity);
        }
      `,
    });

    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'wakeRibbons';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    // FX never enter the G-buffer: they would scribble Sobel lines across the
    // water and the ocean reads that buffer to build its contact foam.
    this.mesh.userData.skipPrepass = true;
  }

  get tunables() {
    return this.material.uniforms;
  }

  /** Push one sample onto a boat's ring buffer. */
  private emit(
    t: Trail,
    x: number,
    z: number,
    nx: number,
    nz: number,
    w0: number,
    power: number,
    valid: number,
  ) {
    t.head = (t.head + 1) % POINTS;
    const i = t.head;
    t.x[i] = x;
    t.z[i] = z;
    t.nx[i] = nx;
    t.nz[i] = nz;
    t.age[i] = 0;
    t.w0[i] = w0;
    t.power[i] = power;
    t.valid[i] = valid;
    if (t.count < POINTS) t.count++;
  }

  update(ctx: GameContext, racers: Racer[]) {
    const dt = ctx.dt;
    const pos = this.aPos.array as Float32Array;
    const ages = this.aAge.array as Float32Array;
    const powers = this.aPower.array as Float32Array;
    const runs = this.aRun.array as Float32Array;
    const beam = CONFIG.boat.beam;
    const halfLen = CONFIG.boat.length * 0.5;

    for (let r = 0; r < racers.length && r < this.trails.length; r++) {
      const racer = racers[r];
      const s = racer.state;
      const t = this.trails[r];

      for (let i = 0; i < POINTS; i++) t.age[i] += dt;

      // Stern position: heading 0 faces +Z, so forward is (sin h, cos h).
      const fx = Math.sin(s.heading);
      const fz = Math.cos(s.heading);
      const sx = racer.root.position.x - fx * halfLen;
      const sz = racer.root.position.z - fz * halfLen;

      const speed = Math.abs(s.forwardSpeed);
      const dx = sx - t.lastX;
      const dz = sz - t.lastZ;
      t.carry += Math.hypot(dx, dz);
      t.lastX = sx;
      t.lastZ = sz;

      // While the boat is in the air it lays no wake — and, importantly, it must
      // not *overwrite* the wake it already laid. The first pass emitted invalid
      // samples through the whole flight, which walked the ring buffer forward
      // and erased the trail; the foam_wake capture came back with a boat in
      // mid-air and no wake at all behind it.
      const laying = speed > 1.6 && !s.airborne;
      if (laying && (t.head < 0 || t.carry >= EMIT_STEP)) {
        t.carry = 0;
        // Lateral is the travel perpendicular; from the hull axis it is (fz, -fx).
        const w0 = beam * 0.42 + speed * 0.028 + (s.drifting ? 0.55 : 0.0);
        const power = Math.min(
          1,
          speed / CONFIG.boat.topSpeed +
            Math.abs(s.lateralSpeed) * 0.12 +
            (s.boostTime > 0 ? 0.35 : 0),
        );
        this.emit(t, sx, sz, fz, -fx, w0, power, 1);
      }

      // ── Rewrite this boat's vertex slice, oldest → newest ─────────────────
      const base = r * POINTS * CROSS;
      let run = 0;
      let px = 0;
      let pz = 0;
      for (let k = 0; k < POINTS; k++) {
        // k = 0 is the OLDEST sample so the ribbon runs tail → stern.
        const src = (t.head + 1 + k) % POINTS;
        const age = t.age[src];
        const valid = t.valid[src] > 0.5 && t.count > 1 && age < LIFE;
        // Kelvin-style divergence: the ribbon widens as it ages.
        const halfW = valid ? t.w0[src] + age * SPREAD : 0;
        const cx = t.x[src];
        const cz = t.z[src];
        const nx = t.nx[src];
        const nz = t.nz[src];

        if (k > 0) run += Math.hypot(cx - px, cz - pz);
        px = cx;
        pz = cz;

        const row = base + k * CROSS;
        for (let c = 0; c < CROSS; c++) {
          const side = (c / (CROSS - 1)) * 2 - 1;
          const i0 = (row + c) * 3;
          pos[i0 + 0] = cx + nx * halfW * side;
          pos[i0 + 1] = 0;
          pos[i0 + 2] = cz + nz * halfW * side;
          ages[row + c] = valid ? age : LIFE * 2;
          powers[row + c] = t.power[src];
          runs[row + c] = run;
        }
      }
      // `run` accumulates from the tail; the shader wants distance from the
      // stern, so flip it in a second pass over the same slice.
      for (let k = 0; k < POINTS * CROSS; k++) runs[base + k] = run - runs[base + k];
    }

    this.aPos.needsUpdate = true;
    this.aAge.needsUpdate = true;
    this.aPower.needsUpdate = true;
    this.aRun.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Foam collar around every hull.
 *
 * ── Why this exists as geometry ─────────────────────────────────────────────
 * The ocean shader also builds a contact mask from the G-buffer depth
 * difference, and that mask is correct — but it is geometrically incapable of
 * being a *collar*. A depth-difference mask can only mark water that is in
 * front of recorded geometry, i.e. the sliver of surface that overlaps the
 * submerged part of the hull in screen space. From a chase camera that sliver is
 * two or three pixels wide. Verified in shots/water_r3 and r4: the boat sat on
 * the water with a clean outline and no churn at the waterline at all.
 *
 * So the weld is a real patch of geometry: a small grid per boat, riding the
 * shared wave field in the vertex shader like everything else that touches the
 * water, carrying an elliptical annulus mask in local hull space. One mesh, one
 * draw call, four boats.
 */
const COLLAR_U = 11;
const COLLAR_V = 15;

export class HullCollars {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private aPos: BufferAttribute;
  private aPower: BufferAttribute;
  /** Cached local-space lattice — read every frame, so never look it up by name. */
  private localUv: Float32Array;

  constructor(racerCount: number, noise: Texture) {
    const per = COLLAR_U * COLLAR_V;
    const verts = racerCount * per;
    const positions = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    const powers = new Float32Array(verts);

    for (let r = 0; r < racerCount; r++) {
      for (let j = 0; j < COLLAR_V; j++) {
        for (let i = 0; i < COLLAR_U; i++) {
          const k = r * per + j * COLLAR_U + i;
          uvs[k * 2 + 0] = (i / (COLLAR_U - 1)) * 2 - 1;
          uvs[k * 2 + 1] = (j / (COLLAR_V - 1)) * 2 - 1;
        }
      }
    }

    const quads = racerCount * (COLLAR_U - 1) * (COLLAR_V - 1);
    const indices = new Uint16Array(quads * 6);
    let n = 0;
    for (let r = 0; r < racerCount; r++) {
      const base = r * per;
      for (let j = 0; j < COLLAR_V - 1; j++) {
        for (let i = 0; i < COLLAR_U - 1; i++) {
          const a = base + j * COLLAR_U + i;
          const b = a + 1;
          const c = a + COLLAR_U;
          const d = c + 1;
          indices[n++] = a;
          indices[n++] = c;
          indices[n++] = b;
          indices[n++] = b;
          indices[n++] = c;
          indices[n++] = d;
        }
      }
    }

    const geo = new BufferGeometry();
    this.localUv = uvs;
    this.aPos = new BufferAttribute(positions, 3);
    this.aPower = new BufferAttribute(powers, 1);
    this.aPos.setUsage(DynamicDrawUsage);
    this.aPower.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aUv', new BufferAttribute(uvs, 2));
    geo.setAttribute('aPower', this.aPower);
    geo.setIndex(new BufferAttribute(indices, 1));
    geo.boundingSphere = null;

    this.material = new ShaderMaterial({
      name: 'hullCollar',
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      side: DoubleSide,
      uniforms: {
        uWaveA: { value: waveUniformArrays.uWaveA },
        uWaveB: { value: waveUniformArrays.uWaveB },
        uTime: SHARED.uTime,
        uNoise: { value: noise },
        uFoam: { value: PAL.foam.clone() },
        uFoamShade: { value: PAL.foamShade.clone() },
        uCrest: { value: PAL.waterCrest.clone() },
        uLift: { value: 0.11 },
        uTile: { value: 3.3 },
        /** Inner radius of the annulus, in normalised hull-footprint units. */
        uInner: { value: 0.82 },
        uOuter: { value: 1.42 },
        uOpacity: { value: 0.8 },
      },
      vertexShader: /* glsl */ `
        ${GERSTNER_GLSL}
        attribute vec2 aUv;
        attribute float aPower;
        uniform float uLift;
        varying vec2 vUv;
        varying float vPower;
        varying vec3 vWorldPos;
        void main() {
          vec3 p; vec3 nrm; float j;
          gerstnerSurface(position.xz, uTime, p, nrm, j);
          p.y += uLift;
          vUv = aUv;
          vPower = aPower;
          vWorldPos = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uNoise;
        uniform vec3 uFoam, uFoamShade, uCrest;
        uniform float uTime, uTile, uInner, uOuter, uOpacity;
        varying vec2 vUv;
        varying float vPower;
        varying vec3 vWorldPos;

        void main() {
          vec2 uv = vWorldPos.xz / uTile;
          vec4 nA = texture2D(uNoise, uv + vec2(uTime * 0.05, uTime * -0.03));
          vec4 nB = texture2D(uNoise, uv * 2.9 - vec2(uTime * 0.11, 0.0));
          float grain = nA.r * 0.42 + nA.g * 0.24 + nB.b * 0.34;

          // Elliptical distance in hull-footprint units: 1.0 is the hull's own
          // outline, so the annulus starts just inside it and spills outward.
          //
          // The radius is warped by the noise *before* the annulus is built. The
          // r7 capture showed why: threshold a clean ellipse and, however lacy the
          // alpha afterwards, the outer boundary is still a visible circular arc
          // sitting on the water. Warping the metric means there is no arc to see.
          float e = length(vec2(vUv.x / 0.42, vUv.y / 0.56));
          e *= 1.0 + (grain - 0.5) * 0.5 + (nB.g - 0.5) * 0.28;

          float annulus = smoothstep(uInner, uInner + 0.26, e)
                        * (1.0 - smoothstep(uOuter * 0.5, uOuter, e));
          // Bow push and stern churn: the water piles up ahead of the hull and
          // boils behind it, so the collar is not a uniform ring.
          float bow = smoothstep(0.15, 0.85, vUv.y) * 0.5;
          float stern = smoothstep(-0.1, -0.85, vUv.y) * 0.8;
          float shape = annulus * (0.42 + bow + stern);

          float coverage = clamp(shape * (0.35 + 0.85 * vPower), 0.0, 0.88);
          float thr = 1.0 - coverage;
          float w = max(fwidth(grain) * 0.7, 0.02);
          float mask = smoothstep(thr - w, thr + w, grain);
          if (mask < 0.02) discard;

          float a = mask * (0.34 + 0.34 * step(0.35, coverage) + 0.28 * step(0.62, coverage));
          vec3 col = mix(mix(uCrest, uFoamShade, 0.7), uFoamShade, smoothstep(0.2, 0.7, coverage));
          col = mix(col, uFoam, step(0.78, coverage) * vPower * 0.8);
          gl_FragColor = vec4(col, a * uOpacity);
        }
      `,
    });

    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'hullCollars';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.userData.skipPrepass = true;
  }

  get tunables() {
    return this.material.uniforms;
  }

  update(_ctx: GameContext, racers: Racer[]) {
    const pos = this.aPos.array as Float32Array;
    const powers = this.aPower.array as Float32Array;
    const per = COLLAR_U * COLLAR_V;
    // The patch is deliberately larger than the hull so the collar has room to
    // spill outward instead of being clipped at the hull's own silhouette.
    const halfW = CONFIG.boat.beam * 1.55;
    const halfL = CONFIG.boat.length * 1.15;

    for (let r = 0; r < racers.length; r++) {
      const s = racers[r].state;
      const p = racers[r].root.position;
      const fx = Math.sin(s.heading);
      const fz = Math.cos(s.heading);
      const rx = fz;
      const rz = -fx;
      const speed = Math.abs(s.forwardSpeed);
      // Airborne hulls have no waterline, so the collar fades out rather than
      // sliding along the water underneath a boat that is not touching it.
      const power = s.airborne
        ? 0
        : Math.min(1, 0.32 + speed / CONFIG.boat.topSpeed + Math.abs(s.lateralSpeed) * 0.1);

      const base = r * per;
      for (let k = 0; k < per; k++) {
        const u = this.localUv[(base + k) * 2];
        const v = this.localUv[(base + k) * 2 + 1];
        const i0 = (base + k) * 3;
        pos[i0 + 0] = p.x + rx * u * halfW + fx * v * halfL;
        pos[i0 + 1] = 0;
        pos[i0 + 2] = p.z + rz * u * halfW + fz * v * halfL;
        powers[base + k] = power;
      }
    }

    this.aPos.needsUpdate = true;
    this.aPower.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Everything the water throws into the air or leaves behind it, behind one
 * update call: the wake ribbons, the hull collars and the spray field.
 *
 * `Ocean` owns an instance of this so the FX arrive with the water rather than
 * needing a separate registration in `main.ts`. It is still a plain object with
 * `update(ctx)`, so promoting it to its own `Subsystem` at order 70 is a
 * two-line change if the integrator prefers that.
 */
export class WaterFX {
  readonly group = new Group();
  readonly wake: WakeRibbons;
  readonly collars: HullCollars;
  readonly spray: SprayField;

  constructor(racerCount = CONFIG.race.racerCount) {
    // A private cache key so switching this map to trilinear cannot affect any
    // other subsystem's use of makeNoiseTexture.
    const noise = makeNoiseTexture(512, 5, 5);
    noise.minFilter = LinearMipmapLinearFilter;
    noise.generateMipmaps = true;
    noise.anisotropy = 8;
    noise.needsUpdate = true;

    this.wake = new WakeRibbons(racerCount, noise);
    this.collars = new HullCollars(racerCount, noise);
    this.spray = new SprayField(noise);
    this.group.name = 'waterFx';
    this.group.add(this.collars.mesh);
    this.group.add(this.wake.mesh);
    this.group.add(this.spray.points);
  }

  update(ctx: GameContext) {
    this.wake.update(ctx, ctx.racers);
    this.collars.update(ctx, ctx.racers);
    this.spray.update(ctx, ctx.racers);
  }

  dispose() {
    this.wake.dispose();
    this.collars.dispose();
    this.spray.dispose();
  }
}
