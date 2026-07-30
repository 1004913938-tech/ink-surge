/**
 * The infinite ocean mesh.
 *
 * ── Why a radial grid ──────────────────────────────────────────────────────
 * The brief rules out three specific failures: visible seams, visible tiling
 * repetition, and LOD popping. Each candidate approach fails at least one:
 *
 *   • tiled patches with per-tile LOD  → seams at the stitch, popping on swap
 *   • a single uniform grid            → either far too dense or far too coarse
 *   • a screen-space projected grid    → no seams, but degenerate at grazing
 *                                        angles and awkward for CPU queries
 *
 * A single **radial disc** centred on the camera has none of them. It is one
 * mesh, so there is no seam anywhere. Vertex density falls off exponentially
 * with radius, so detail is where the camera is without any discrete LOD level
 * to pop between. And because the wave field is evaluated in *absolute world
 * space*, sliding the disc under the camera produces no repetition — the mesh
 * moves, the water does not.
 *
 * The disc is re-centred every frame and snapped to a fixed grid. Snapping
 * matters: without it, vertices creep continuously relative to the wave field
 * and high-frequency crests visibly shimmer as the sampling points slide.
 */

import { BufferAttribute, BufferGeometry, type Camera, Mesh, Texture, Vector3 } from 'three';
import { CONFIG } from '../core/config';
import { createOceanMaterial } from './oceanMaterial';
import { maxWaveHeight, sampleHeight, sampleOcean } from './gerstner';
import type { OceanSample } from './gerstner';
import type { GameContext, OceanSampler, Subsystem } from '../core/types';

/**
 * Build the radial lattice.
 *
 * Radius distribution is exponential: r(i) = R·(e^(k·i/N) − 1)/(e^k − 1).
 * That puts roughly half the rings inside the first 8% of the radius, which is
 * where the camera actually is, while still reaching 2.6 km for the horizon.
 *
 * The centre is a fan of triangles to a single origin vertex, avoiding the
 * pinched degenerate quads a naive polar grid produces at r → 0.
 */
function buildRadialGrid(radialSteps: number, angularSteps: number, radius: number): BufferGeometry {
  const vertCount = 1 + radialSteps * angularSteps;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  // Origin vertex.
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;

  const k = 5.6; // exponential tightness
  const denom = Math.exp(k) - 1;

  let p = 3;
  let t = 2;
  for (let i = 0; i < radialSteps; i++) {
    const fi = (i + 1) / radialSteps;
    const r = radius * (Math.exp(k * fi) - 1) / denom;
    for (let a = 0; a < angularSteps; a++) {
      const theta = (a / angularSteps) * Math.PI * 2;
      positions[p++] = Math.cos(theta) * r;
      positions[p++] = 0;
      positions[p++] = Math.sin(theta) * r;
      uvs[t++] = fi;
      uvs[t++] = a / angularSteps;
    }
  }

  // Indices: a central fan plus quad rings.
  const triCount = angularSteps + (radialSteps - 1) * angularSteps * 2;
  const indices = new Uint32Array(triCount * 3);
  let n = 0;

  // Centre fan.
  for (let a = 0; a < angularSteps; a++) {
    indices[n++] = 0;
    indices[n++] = 1 + ((a + 1) % angularSteps);
    indices[n++] = 1 + a;
  }
  // Rings.
  for (let i = 0; i < radialSteps - 1; i++) {
    const base = 1 + i * angularSteps;
    const next = base + angularSteps;
    for (let a = 0; a < angularSteps; a++) {
      const a1 = (a + 1) % angularSteps;
      indices[n++] = base + a;
      indices[n++] = next + a1;
      indices[n++] = next + a;
      indices[n++] = base + a;
      indices[n++] = base + a1;
      indices[n++] = next + a1;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('uv', new BufferAttribute(uvs, 2));
  geo.setIndex(new BufferAttribute(indices, 1));
  // The mesh follows the camera, so a bounding volume test is meaningless.
  geo.boundingSphere = null;
  return geo;
}

export class Ocean implements Subsystem, OceanSampler {
  readonly name = 'ocean';
  readonly order = 20;

  readonly mesh: Mesh;
  private handles = createOceanMaterial();

  constructor(radialSteps = 190, angularSteps = 256, radius = CONFIG.ocean.extent) {
    const geo = buildRadialGrid(radialSteps, angularSteps, radius);
    this.mesh = new Mesh(geo, this.handles.material);
    this.mesh.name = 'ocean';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    // The water is excluded from the G-buffer for two reasons: we do not want
    // Sobel lines scribbled across the swell, and — more importantly — the
    // water *reads* the G-buffer to build its foam ring, so it must not be in
    // it. See oceanMaterial.ts.
    this.mesh.userData.skipPrepass = true;
  }

  /** Called by the renderer once the G-buffer for this frame exists. */
  setSceneDepth(tex: Texture | null) {
    this.handles.setSceneDepth(tex);
  }

  get material() {
    return this.handles.material;
  }

  update(ctx: GameContext) {
    // Re-centre on the camera, snapped so vertices do not creep against the
    // wave field. The snap interval must be larger than the finest wave
    // wavelength / 2 to be effective, and small enough not to be visible.
    const snap = CONFIG.ocean.snap;
    const cx = Math.round(ctx.camera.position.x / snap) * snap;
    const cz = Math.round(ctx.camera.position.z / snap) * snap;
    this.mesh.position.set(cx, 0, cz);
  }

  // ── OceanSampler ──────────────────────────────────────────────────────────
  sample(x: number, z: number, t: number, out?: OceanSample) {
    return sampleOcean(x, z, t, out);
  }
  height(x: number, z: number, t: number) {
    return sampleHeight(x, z, t);
  }
  maxHeight() {
    return maxWaveHeight();
  }
}
