/**
 * The cel-shading core. Every solid surface in the game is drawn with a
 * CelMaterial, and every one of them also produces:
 *
 *   • a **prepass** material — GLSL3, writes view normal + linear depth +
 *     object id into an MRT G-buffer for the screen-space edge pass
 *   • an **outline** material — inverted hull, back faces, pushed along
 *     smoothed normals by a *constant number of screen pixels*
 *
 * All three are generated from the same vertex chunks, which is the only way
 * to keep them in register when a surface displaces in the vertex shader (the
 * ocean, the wake ribbons, and every rider limb do exactly that). A hand-
 * written outline shader that forgets the displacement produces the classic
 * "outline floating off the model" bug.
 *
 * ── Why not MeshToonMaterial ───────────────────────────────────────────────
 * MeshToonMaterial gives you a gradient-map diffuse and nothing else: no
 * banded specular, no fresnel term you can shape, no hook for the G-buffer,
 * and its lighting goes through three's physical pipeline. We want full
 * control of the terminator, so we own the whole shader.
 */

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  GLSL3,
  type IUniform,
  Material,
  Mesh,
  type Object3D,
  RawShaderMaterial,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { PAL, SUN_DIR } from '../core/palette';
import { makeMatcapTexture, makeRampTexture } from './textures';

// ─────────────────────────────────────────────────────────────────────────────
// Shared uniforms — one object per name, referenced by every material, so the
// main loop updates them once and the whole scene sees it.
// ─────────────────────────────────────────────────────────────────────────────

export const SHARED = {
  uTime: { value: 0 } as IUniform<number>,
  uSunDir: { value: new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z).normalize() } as IUniform<Vector3>,
  uCameraPos: { value: new Vector3() } as IUniform<Vector3>,
  /** (width, height) in device pixels — outline width is measured against this. */
  uResolution: { value: new Vector2(1, 1) } as IUniform<Vector2>,
  /** tan(fovY / 2), needed to convert pixels to world units at a given depth. */
  uTanHalfFov: { value: 0.5 } as IUniform<number>,
  uNear: { value: 0.1 } as IUniform<number>,
  uFar: { value: 4000 } as IUniform<number>,
};

/** Chunk injection points, so subsystems can extend the shader without forking it. */
export interface CelChunks {
  uniforms?: Record<string, IUniform>;
  defines?: Record<string, string | number | boolean>;
  /** Declarations available to the vertex stage. */
  vertexHead?: string;
  /**
   * Runs after `transformed` (vec3, object space) and `objectNormal` are set.
   * Mutate them to displace. Shared verbatim by main / prepass / outline.
   */
  vertexBody?: string;
  fragmentHead?: string;
  /**
   * Runs with `baseColor` (vec3), `ndl` (float), `celShade` (vec3) in scope,
   * just before the final composite. Mutate `baseColor` / `celShade`.
   */
  fragmentBody?: string;
}

export interface CelMaterialOptions {
  color?: Color;
  /** Ramp colours from shadow → light. 3 or 4 entries. */
  rampColors?: Color[];
  /** Where each band starts, in NdotL space. Tuned by eye; see textures.ts. */
  rampStops?: number[];
  rimColor?: Color;
  /** Higher = tighter rim. 2–5 is the useful range. */
  rimPower?: number;
  rimStrength?: number;
  /** Banded specular. `specSize` is a hard threshold on the blinn term. */
  specColor?: Color;
  specSize?: number;
  specStrength?: number;
  /** Second, smaller spec band — gives the highlight a stepped shoulder. */
  specSize2?: number;
  matcap?: Texture | null;
  matcapStrength?: number;
  /** Inverted-hull outline. Width is in *screen pixels* and stays constant. */
  outline?: boolean;
  outlineWidthPx?: number;
  outlineColor?: Color;
  /** Written to the G-buffer; a discontinuity here forces an interior line. */
  objectId?: number;
  /** Multiplier on the Sobel response for this surface. 0 = never inked. */
  edgeBias?: number;
  side?: typeof FrontSide | typeof BackSide | typeof DoubleSide;
  transparent?: boolean;
  opacity?: number;
  vertexColors?: boolean;
  /** Flat-shade the fragment normal — good for faceted, low-poly forms. */
  flatShading?: boolean;
  chunks?: CelChunks;
  name?: string;
}

const DEFAULT_RAMP_STOPS = [0.0, 0.36, 0.52, 0.74];

function defaultRamp(base: Color): Color[] {
  // Shadow tones are not "base × 0.5" — that reads as a dimmer, muddier version
  // of the same hue. Real cel art shifts shadows toward the ambient (here: a
  // cool sea blue) and pushes the lit band slightly warm and desaturated-up.
  const shadowDeep = base.clone().lerp(PAL.waterDeep, 0.62).multiplyScalar(0.72);
  const shadow = base.clone().lerp(PAL.waterMid, 0.3).multiplyScalar(0.86);
  const lit = base.clone();
  const hot = base.clone().lerp(PAL.foam, 0.26).multiplyScalar(1.12);
  return [shadowDeep, shadow, lit, hot];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shader source
// ─────────────────────────────────────────────────────────────────────────────

const VERT_COMMON = /* glsl */ `
  attribute vec3 aSmoothNormal;

  // Always present in the uniform block; unused ones are optimised out by the
  // compiler, so declaring them unconditionally keeps the three variants
  // (main / prepass / outline) sharing one vertex source.
  uniform float uTime;
  uniform vec2 uResolution;
  uniform float uTanHalfFov;
  uniform float uNear;
  uniform float uFar;
  uniform float uOutlineWidthPx;
  uniform vec3 uCameraPos;

  varying vec3 vWorldNormal;
  varying vec3 vViewNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec2 vUv;
  varying vec3 vColor4;

  CHUNK_VERTEX_HEAD

  void main() {
    vec3 transformed = position;
    vec3 objectNormal = normal;
    vec3 smoothNormal = aSmoothNormal;
    vUv = uv;
    #ifdef USE_VERTEX_COLORS
      vColor4 = color;
    #else
      vColor4 = vec3(1.0);
    #endif

    CHUNK_VERTEX_BODY

    vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
    vec4 mvPosition = viewMatrix * worldPos;

    vWorldPos = worldPos.xyz;
    vViewPos = mvPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vViewNormal = normalize(normalMatrix * objectNormal);

    CHUNK_VERTEX_OUTLINE

    gl_Position = projectionMatrix * mvPosition;
  }
`;

/**
 * The outline push. Done in *view space* so the offset can be expressed in
 * world units that correspond to a fixed pixel count at this depth:
 *
 *   unitsPerPixel = 2 · depth · tan(fovY/2) / screenHeightInPixels
 *
 * Multiply by the desired pixel width and the line is the same thickness on a
 * boat 3 m away and a gate 300 m away. Scaling the push by a constant instead
 * — the common shortcut — gives fat lines up close and lines that vanish in
 * the distance, which the brief explicitly rules out.
 *
 * The normal used is `aSmoothNormal`: an area-weighted normal merged across
 * split vertices. Using the shading normal instead tears the hull open at
 * every hard edge, which is where inverted-hull outlines usually fall apart.
 */
const OUTLINE_PUSH = /* glsl */ `
  {
    vec3 vn = normalize(normalMatrix * smoothNormal);
    float depth = max(-mvPosition.z, uNear);
    float unitsPerPixel = (2.0 * depth * uTanHalfFov) / uResolution.y;
    // Fade the line out as the surface turns edge-on to the camera, otherwise
    // grazing faces smear the outline into a wide band.
    float grazing = abs(vn.z);
    float w = uOutlineWidthPx * mix(0.55, 1.0, smoothstep(0.0, 0.35, grazing));
    mvPosition.xyz += vn * (w * unitsPerPixel);
    // Nudge toward the camera so the hull doesn't z-fight the surface it hugs.
    mvPosition.z += unitsPerPixel * 0.35;
  }
`;

const FRAG_MAIN = /* glsl */ `
  precision highp float;

  uniform vec3 uColor;
  uniform sampler2D uRamp;
  uniform vec3 uRimColor;
  uniform float uRimPower;
  uniform float uRimStrength;
  uniform vec3 uSpecColor;
  uniform float uSpecSize;
  uniform float uSpecSize2;
  uniform float uSpecStrength;
  uniform sampler2D uMatcap;
  uniform float uMatcapStrength;
  uniform float uOpacity;
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform float uTime;

  varying vec3 vWorldNormal;
  varying vec3 vViewNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying vec2 vUv;
  varying vec3 vColor4;

  CHUNK_FRAGMENT_HEAD

  void main() {
    vec3 N = normalize(vWorldNormal);
    #ifdef FLAT_SHADING
      N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    #endif
    vec3 V = normalize(uCameraPos - vWorldPos);
    vec3 L = normalize(uSunDir);

    vec3 baseColor = uColor * vColor4;

    // ── Quantised diffuse ───────────────────────────────────────────────────
    // Half-lambert widens the usable range so the ramp's bands land where we
    // placed them rather than crushing everything past the terminator into
    // band 0. The ramp texture itself does the stepping (NearestFilter).
    float ndl = dot(N, L) * 0.5 + 0.5;
    vec3 celShade = texture2D(uRamp, vec2(clamp(ndl, 0.01, 0.99), 0.5)).rgb;

    CHUNK_FRAGMENT_BODY

    vec3 lit = baseColor * celShade;

    // ── Banded specular ─────────────────────────────────────────────────────
    // Two hard thresholds on the Blinn term, never a pow() falloff. The result
    // is a highlight with a stepped shoulder — a *shape*, which is what reads
    // as drawn rather than rendered.
    vec3 H = normalize(L + V);
    float spec = dot(N, H);
    float s1 = step(uSpecSize, spec);
    float s2 = step(uSpecSize2, spec);
    lit += uSpecColor * uSpecStrength * (s1 * 0.45 + s2 * 0.55);

    // ── Fresnel rim ─────────────────────────────────────────────────────────
    // Quantised to two steps so the rim is a drawn edge, not an airbrush.
    // Weighted toward the light side so it reads as bounce, not a glow outline.
    float fres = 1.0 - max(dot(N, V), 0.0);
    float rim = pow(fres, uRimPower);
    float rimSide = smoothstep(-0.45, 0.65, dot(N, L));
    float rimStep = step(0.55, rim) * 0.62 + step(0.78, rim) * 0.38;
    lit += uRimColor * (rimStep * uRimStrength * mix(0.35, 1.0, rimSide));

    // ── Faked reflection ────────────────────────────────────────────────────
    // A drawn matcap, sampled by the view-space normal. Deliberately not a
    // cubemap: an accurate reflection is the fastest way to make a surface
    // read as physically based.
    #ifdef USE_MATCAP
      vec3 vn = normalize(vViewNormal);
      vec2 mUv = vn.xy * 0.5 + 0.5;
      vec3 mc = texture2D(uMatcap, mUv).rgb;
      lit = mix(lit, lit + mc * baseColor, uMatcapStrength);
    #endif

    gl_FragColor = vec4(lit, uOpacity);
  }
`;

/**
 * Prepass fragment. GLSL3 with two colour attachments:
 *   layout 0 → view-space normal (rgb, [0,1] encoded) + edge bias (a)
 *   layout 1 → linear view depth (r), object id (g), unused (ba)
 *
 * The Sobel pass reads both. Depth alone misses edges between coplanar
 * surfaces; normals alone miss edges where two parallel surfaces overlap at
 * different depths; the object id catches the remaining case where two
 * separate objects meet at a similar depth *and* a similar normal — which is
 * exactly a rider's arm crossing their chest.
 */
const PREPASS_FRAG = /* glsl */ `
  precision highp float;

  uniform float uObjectId;
  uniform float uEdgeBias;
  uniform float uFar;

  in vec3 vWorldNormal;
  in vec3 vViewNormal;
  in vec3 vWorldPos;
  in vec3 vViewPos;
  in vec2 vUv;
  in vec3 vColor4;

  layout(location = 0) out vec4 gNormal;
  layout(location = 1) out vec4 gDepthId;

  void main() {
    vec3 vn = normalize(vViewNormal);
    gNormal = vec4(vn * 0.5 + 0.5, uEdgeBias);
    gDepthId = vec4(clamp(-vViewPos.z / uFar, 0.0, 1.0), uObjectId, 0.0, 1.0);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Material construction
// ─────────────────────────────────────────────────────────────────────────────

/** A CelMaterial plus the two companion materials generated alongside it. */
export interface CelMaterialSet {
  main: ShaderMaterial;
  prepass: ShaderMaterial;
  outline: ShaderMaterial | null;
  /** Uniforms shared by all three; write here to affect every pass. */
  uniforms: Record<string, IUniform>;
}

function applyChunks(src: string, chunks: CelChunks | undefined, outline: boolean): string {
  return src
    .replace('CHUNK_VERTEX_HEAD', chunks?.vertexHead ?? '')
    .replace('CHUNK_VERTEX_BODY', chunks?.vertexBody ?? '')
    .replace('CHUNK_VERTEX_OUTLINE', outline ? OUTLINE_PUSH : '')
    .replace('CHUNK_FRAGMENT_HEAD', chunks?.fragmentHead ?? '')
    .replace('CHUNK_FRAGMENT_BODY', chunks?.fragmentBody ?? '');
}

/** GLSL3 needs `in`/`out` instead of `attribute`/`varying`. */
function toGLSL3Vertex(src: string): string {
  return src
    .replace(/\battribute\b/g, 'in')
    .replace(/\bvarying\b/g, 'out')
    .replace(/\btexture2D\b/g, 'texture');
}

let objectIdCounter = 1;
/** Object ids are packed into an 8-bit channel, so they wrap at 255. */
export function nextObjectId(): number {
  objectIdCounter = (objectIdCounter % 250) + 1;
  return objectIdCounter / 255;
}

export function createCelMaterial(opts: CelMaterialOptions = {}): CelMaterialSet {
  const color = opts.color ?? PAL.hull0;
  const rampColors = opts.rampColors ?? defaultRamp(color);
  const rampStops = opts.rampStops ?? DEFAULT_RAMP_STOPS;
  const ramp = makeRampTexture(rampColors, rampStops);

  const uniforms: Record<string, IUniform> = {
    uColor: { value: color.clone() },
    uRamp: { value: ramp },
    uRimColor: { value: (opts.rimColor ?? PAL.skyHorizon).clone() },
    uRimPower: { value: opts.rimPower ?? 3.0 },
    uRimStrength: { value: opts.rimStrength ?? 0.6 },
    uSpecColor: { value: (opts.specColor ?? PAL.foam).clone() },
    uSpecSize: { value: opts.specSize ?? 0.86 },
    uSpecSize2: { value: opts.specSize2 ?? 0.955 },
    uSpecStrength: { value: opts.specStrength ?? 0.35 },
    uMatcap: { value: opts.matcap ?? null },
    uMatcapStrength: { value: opts.matcapStrength ?? 0.0 },
    uOpacity: { value: opts.opacity ?? 1.0 },
    uObjectId: { value: opts.objectId ?? nextObjectId() },
    uEdgeBias: { value: opts.edgeBias ?? 1.0 },
    uOutlineWidthPx: { value: opts.outlineWidthPx ?? 2.6 },
    uOutlineColor: { value: (opts.outlineColor ?? PAL.ink).clone() },
    // Shared references — assigning the same IUniform object keeps every
    // material in the scene in sync from a single write per frame.
    uTime: SHARED.uTime,
    uSunDir: SHARED.uSunDir,
    uCameraPos: SHARED.uCameraPos,
    uResolution: SHARED.uResolution,
    uTanHalfFov: SHARED.uTanHalfFov,
    uNear: SHARED.uNear,
    uFar: SHARED.uFar,
    ...(opts.chunks?.uniforms ?? {}),
  };

  const defines: Record<string, string | number | boolean> = { ...(opts.chunks?.defines ?? {}) };
  if (opts.matcap) defines.USE_MATCAP = '';
  if (opts.vertexColors) defines.USE_VERTEX_COLORS = '';
  if (opts.flatShading) defines.FLAT_SHADING = '';

  const main = new ShaderMaterial({
    name: opts.name ?? 'cel',
    uniforms,
    defines,
    vertexShader: applyChunks(VERT_COMMON, opts.chunks, false),
    fragmentShader: applyChunks(FRAG_MAIN, opts.chunks, false),
    side: opts.side ?? FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    vertexColors: !!opts.vertexColors,
  });

  const prepass = new ShaderMaterial({
    name: (opts.name ?? 'cel') + ':prepass',
    uniforms,
    defines,
    glslVersion: GLSL3,
    vertexShader: toGLSL3Vertex(applyChunks(VERT_COMMON, opts.chunks, false)),
    fragmentShader: PREPASS_FRAG,
    side: opts.side ?? FrontSide,
  });

  let outline: ShaderMaterial | null = null;
  if (opts.outline !== false) {
    outline = new ShaderMaterial({
      name: (opts.name ?? 'cel') + ':outline',
      uniforms,
      defines,
      vertexShader: applyChunks(VERT_COMMON, opts.chunks, true),
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uOutlineColor;
        uniform vec3 uSunDir;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPos;
        varying vec3 vViewPos;
        void main() {
          // Ink is not flat black: it warms very slightly on the lit side, the
          // way a brush line thins where light hits it. Subtle, but it stops
          // the outline reading as a hard vector stroke pasted on top.
          float lightSide = dot(normalize(vWorldNormal), normalize(uSunDir)) * 0.5 + 0.5;
          vec3 ink = uOutlineColor * mix(1.0, 1.32, smoothstep(0.55, 1.0, lightSide));
          gl_FragColor = vec4(ink, 1.0);
        }
      `,
      side: BackSide,
    });
  }

  return { main, prepass, outline, uniforms };
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `aSmoothNormal` attribute an inverted-hull outline needs.
 *
 * Vertices that share a position but have different shading normals (any hard
 * edge, any UV seam) get one merged, area-weighted normal. Without this the
 * outline hull splits apart at every crease and you see the model's shell
 * through the gaps — the single most common inverted-hull artefact.
 *
 * Call this on every geometry that will be outlined. It is idempotent.
 */
export function computeSmoothNormals(geometry: BufferGeometry): BufferGeometry {
  if (geometry.getAttribute('aSmoothNormal')) return geometry;
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const count = pos.count;
  const smooth = new Float32Array(count * 3);

  // Bucket by quantised position — 0.1 mm grid, tight enough not to weld
  // genuinely separate surfaces, loose enough to catch float drift.
  const map = new Map<string, number[]>();
  const q = (v: number) => Math.round(v * 10000);
  for (let i = 0; i < count; i++) {
    const key = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`;
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  }

  for (const indices of map.values()) {
    let nx = 0,
      ny = 0,
      nz = 0;
    for (const i of indices) {
      nx += nrm.getX(i);
      ny += nrm.getY(i);
      nz += nrm.getZ(i);
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const i of indices) {
      smooth[i * 3 + 0] = nx;
      smooth[i * 3 + 1] = ny;
      smooth[i * 3 + 2] = nz;
    }
  }

  geometry.setAttribute('aSmoothNormal', new BufferAttribute(smooth, 3));
  return geometry;
}

/**
 * Attach a cel material set to a mesh: assigns the main material, registers
 * the prepass material for the G-buffer pass, and parents an inverted-hull
 * outline child if one was built.
 *
 * The outline is a *child* rather than a second scene-level mesh so it
 * inherits every transform and animation automatically — including skinned
 * and vertex-displaced motion, since it runs the same vertex chunks.
 */
export function applyCel(mesh: Mesh, set: CelMaterialSet, renderOrder = 0): Mesh {
  computeSmoothNormals(mesh.geometry);
  mesh.material = set.main;
  mesh.renderOrder = renderOrder;
  mesh.userData.prepassMaterial = set.prepass;
  mesh.userData.celSet = set;

  if (set.outline) {
    const hull = new Mesh(mesh.geometry, set.outline);
    hull.name = mesh.name + ':outline';
    // Outlines render first so the shaded surface z-tests cleanly over them.
    hull.renderOrder = renderOrder - 1;
    hull.frustumCulled = mesh.frustumCulled;
    // The outline is not part of the G-buffer — the hull trick and the Sobel
    // pass would otherwise double up and produce a doubled, muddy line.
    hull.userData.skipPrepass = true;
    hull.userData.isOutline = true;
    mesh.add(hull);
  }
  return mesh;
}

/** Walk a subtree and set outline width on every cel material found. */
export function setOutlineWidth(root: Object3D, px: number) {
  root.traverse((o) => {
    const set = (o as Mesh).userData?.celSet as CelMaterialSet | undefined;
    if (set) set.uniforms.uOutlineWidthPx.value = px;
  });
}
