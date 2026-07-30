/**
 * The ocean surface shader.
 *
 * Displacement comes from `GERSTNER_GLSL` — the same wave table the CPU uses
 * for buoyancy, so the boats sit in the water rather than near it.
 *
 * ── Three rounds of captured frames, three rewrites ──────────────────────────
 * v1 banded by **absolute wave height**. A captured frame proved that reads as
 * a topographic contour map: the height field is smooth and low-frequency, so
 * an iso-height band is an enormous smooth blob. The screen filled with flat
 * navy "continents" and an archipelago silhouette. It looked like an ice floe.
 *
 * v2 banded by **surface facing** with height demoted to a modulator. Better —
 * the bands followed the wave forms — but the capture showed three new,
 * specific failures, all of them visible in `shots/water_r0`:
 *
 *   a) **Dithered band edges.** The band boundary was jittered by a noise
 *      texture with `minFilter = LinearFilter` (no mip chain) and compared with
 *      a hard `step()`. Past ~60 m the noise was sub-pixel, so every boundary
 *      dissolved into salt-and-pepper confetti. It read as JPEG rot, not ink.
 *   b) **No foam anywhere.** `uFoamPinch` was 0.42, but the wave table's total
 *      steepness budget is Σ Q·A·k = 0.52 spread over six directions, so
 *      1 − jacobian realistically peaks near 0.3. The threshold sat *above* the
 *      achievable maximum: the whitecap term was mathematically dead.
 *   c) **Bokeh glints.** Glint cells were sized in *world* units (1.05 m), so
 *      15 m from the camera a single glint was ~40 px across, and the composer's
 *      flare pass blurred them into soft photographic dots.
 *
 * v3, this file, fixes each with a named mechanism:
 *
 *   a) The noise gets its own mip chain (`LinearMipmapLinearFilter`) and every
 *      band edge is resolved with `fwidth()`: the transition is one pixel of the
 *      shade scalar wide, so it is *hard* wherever the surface is resolved and
 *      *converges* where it is not, instead of aliasing. This is the difference
 *      between cel bands and dither.
 *   b) Foam is keyed off compression measured against the real dynamic range of
 *      the field (pinch threshold 0.13), plus a **discrete surface Laplacian**
 *      taken from the same five taps the band-limiting filter already needs —
 *      which is a direct crest-lip detector, so foam lands on pinched lips
 *      rather than on every rising slope.
 *   c) Glint cells are sized in *screen* pixels: `cell = dist · 2·tan(fov/2)/H ·
 *      uGlintPx`, so a glint is ~4 px whether the water is 5 m or 500 m away.
 *
 * ── The tone ladder ─────────────────────────────────────────────────────────
 * Five hard tones, not three. v2 used waterDeep as the whole shadow side, and
 * because waterDeep is very dark (linear ≈ 0.004, 0.03, 0.16) every shadowed
 * region read as a *hole* punched in the image — the "oil slick" note. v3 splits
 * the shadow side into a lifted body tone and a thin true-deep trough accent,
 * which restores a readable value ladder:
 *
 *   trough accent ~8%   deep body ~20%   mid ~35%   shallow ~25%   crest ~10%
 *
 * ── Band-limiting (the far-field striping fix) ───────────────────────────────
 * The radial grid's vertex spacing grows linearly with distance, so past ~80 m
 * the short waves are sampled below Nyquist and alias into regular stripes.
 * The vertex shader *low-passes the wave field itself*: four taps at ±`foot` on
 * each axis, averaged. The offsets cancel exactly, so the result is the field
 * convolved with a 4-tap box — transfer (1 + cos(k·foot))/2, a clean zero at
 * λ = 2·foot. `foot` tracks local vertex spacing (published by ocean.ts), so the
 * surface is always band-limited to what the mesh can represent. A fifth centre
 * tap gives the Laplacian for free: avg₄ = f + h²/4·∇²f, so
 * `centre − avg = −h²/4·∇²f`, positive exactly on crests. This is a filter of
 * the shared field, never a second derivation of it.
 */

import {
  Color,
  FrontSide,
  LinearMipmapLinearFilter,
  ShaderMaterial,
  Texture,
} from 'three';
import { GERSTNER_GLSL, waveUniformArrays } from './gerstner';
import { PAL } from '../core/palette';
import { SHARED } from '../render/celMaterial';
import { makeNoiseTexture } from '../render/textures';

export interface OceanMaterialHandles {
  material: ShaderMaterial;
  /** Set once per frame by the renderer so the foam ring can read scene depth. */
  setSceneDepth(tex: Texture | null): void;
  /** Tuning surface — the tunables the harness/critic loop actually twiddles. */
  readonly uniforms: Record<string, { value: unknown }>;
}

/** Two palette tones blended — used where a tone between two entries is needed. */
const blend = (a: Color, b: Color, t: number) => a.clone().lerp(b, t);

/**
 * Noise used for foam break-up and band-edge ragging.
 *
 * A private cache key (7/5 rather than the shared 6/4) so that switching this
 * texture to trilinear filtering cannot affect any other subsystem that asks
 * `makeNoiseTexture` for a map. Mip filtering is not optional here: without a
 * mip chain the distant surface dithers, which was defect (a) above.
 */
function oceanNoise(): Texture {
  const tex = makeNoiseTexture(512, 7, 5);
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export function createOceanMaterial(): OceanMaterialHandles {
  const noise = oceanNoise();

  const material = new ShaderMaterial({
    name: 'ocean',
    side: FrontSide,
    transparent: false,
    uniforms: {
      // Wave field — shared table, uploaded once.
      uWaveA: { value: waveUniformArrays.uWaveA },
      uWaveB: { value: waveUniformArrays.uWaveB },
      uTime: SHARED.uTime,
      uSunDir: SHARED.uSunDir,
      uCameraPos: SHARED.uCameraPos,
      uResolution: SHARED.uResolution,
      uTanHalfFov: SHARED.uTanHalfFov,
      uFar: SHARED.uFar,

      uNoise: { value: noise },
      uSceneDepth: { value: null as Texture | null },

      // ── The tone ladder, dark → light. See the header for why there are five.
      /**
       * Thin trough accent — the darkest tone in the ladder. Still lifted off
       * raw waterDeep: the r1 capture showed that even a *correctly placed*
       * waterDeep band reads as a hole once the composite vignette lands on it.
       */
      uTrough: { value: blend(PAL.waterDeep, PAL.waterMid, 0.16) },
      /** Shadow *body* — lifted further so shadowed wave faces stay blue. */
      uDeep: { value: blend(PAL.waterDeep, PAL.waterMid, 0.55) },
      uMid: { value: PAL.waterMid.clone() },
      uShallow: { value: PAL.waterShallow.clone() },
      uCrest: { value: PAL.waterCrest.clone() },
      uSss: { value: PAL.waterSss.clone() },
      uFoam: { value: PAL.foam.clone() },
      uFoamShade: { value: PAL.foamShade.clone() },
      uHorizonTint: { value: PAL.skyHorizon.clone() },
      uHaze: { value: PAL.skyHaze.clone() },
      /** The tone the sea converges to under aerial perspective. */
      uSeaFar: { value: blend(PAL.waterMid, PAL.skyHorizon, 0.30) },

      // ── Band-limiting footprint ────────────────────────────────────────────
      // foot ≈ (base + r·slope) · scale, fitted to the radial grid's spacing.
      // base/slope are measured and published by ocean.ts; scale is the only
      // artistic knob (how far inside Nyquist to sit).
      uFilterBase: { value: 0.394 },
      uFilterSlope: { value: 0.028 },
      uFilterScale: { value: 0.62 },

      // ── Band selection ─────────────────────────────────────────────────────
      /** "This face turns away from the viewer" — the dominant term. */
      uSlopeWeight: { value: 2.4 },
      /** Sun facing: puts a lit and a shadow side on every wave. */
      uSunWeight: { value: 1.1 },
      /**
       * Grazing-angle sky mirror. The offset matters as much as the weight: at
       * r1 it was `fres - 0.5`, which biases every near-field fragment (where
       * fres → 0) down by a quarter of a band and was half of why the foreground
       * went black. 0.32 is roughly the mean fres over a chase framing.
       */
      uFresWeight: { value: 0.26 },
      uFresPivot: { value: 0.34 },
      /** Absolute height. Deliberately small: see the header. */
      uHeightWeight: { value: 0.22 },
      uHeightScale: { value: 1.9 },
      /** Ragged, hand-inked band edges: amplitude and world scale of the jitter. */
      uBandJitter: { value: 0.46 },
      /**
       * Noise TILE sizes in metres — the world distance over which the whole
       * 512² map repeats, not the feature size. Getting this wrong is what put
       * marbled fingerprint swirls across the r3 mid-field: the jitter tile was
       * 7 m, so the noise map's own fbm structure repeated every 7 metres and
       * the eye read it instantly as texture, which is a named failure mode.
       *
       * The map packs three octaves (r ≈ tile/7, g ≈ tile/14, b ≈ tile/112), so
       * one large tile still yields small features. The three tiles below are
       * mutually irrational-ish so their beats never line up into a lattice.
       */
      uTileBand: { value: 71.3 },
      /** r channel → ≈2.9 m foam clumps. */
      uTileBig: { value: 20.3 },
      /** g channel → ≈1.1 m break-up. */
      uTileMid: { value: 13.1 },
      /** b channel → ≈0.43 m fine bite, on a 48 m repeat. */
      uTileSml: { value: 40.3 },
      /** Fragment-space normal perturbation. Breaks the tessellation zigzag. */
      uRippleStrength: { value: 0.22 },

      // Thresholds on the shade scalar, tuned by eye against captured frames.
      // r1 put ~35% of a chase framing below uBand0 — the "navy continent" note.
      // Sliding the whole ladder down by half a band moves that area into the
      // mid/shallow tones where a sunlit sea actually sits.
      uBand0: { value: -1.18 },
      uBand1: { value: -0.52 },
      uBand2: { value: -0.02 },
      uBand3: { value: 0.52 },
      /** Curvature (crest-lip) bonus folded into the brightest band's selector. */
      uCurvGain: { value: 2.6 },
      /** Thin drawn highlight riding the shallow→crest boundary. */
      uSheen: { value: 0.42 },

      // ── Foam ───────────────────────────────────────────────────────────────
      /** Compression (1 − jacobian) at which whitecaps start. */
      uFoamPinch: { value: 0.15 },
      /** Width of the pinch ramp. */
      uFoamSoft: { value: 0.14 },
      /** Multiplier turning the pinch ramp into fractional area coverage. */
      uFoamGain: { value: 0.98 },
      /** Extra coverage on high, sharply curved crest lips. */
      uFoamLip: { value: 0.5 },
      /**
       * Coverage below this draws nothing. Without a floor, every faintly
       * compressed fragment passes a few percent of the noise and the whole
       * foreground gets a fine white pepper — visible across shots/water_r1.
       */
      uFoamFloor: { value: 0.17 },
      /** Coverage ceiling — keeps the noise biting holes instead of saturating. */
      uFoamCeil: { value: 0.62 },
      /** Metres of view depth behind the water a hull may be and still foam. */
      uFoamRingWidth: { value: 0.85 },
      uFoamRingGain: { value: 1.2 },

      // ── Sparkle ────────────────────────────────────────────────────────────
      /** Glint cell size in SCREEN PIXELS. World-sized cells gave bokeh. */
      uGlintPx: { value: 17.0 },
      /** Specular gate below which no glint is drawn. */
      uGlintGate: { value: 0.14 },
      uGlintStrength: { value: 0.5 },

      uFresnelBand: { value: 0.965 },

      // ── Aerial perspective ─────────────────────────────────────────────────
      /** Band contrast starts collapsing toward uSeaFar here… */
      uFlattenStart: { value: 420.0 },
      uFlattenEnd: { value: 2100.0 },
      uFlattenAmount: { value: 0.8 },
      /** …and the disc dissolves into sky haze here. */
      uHorizonStart: { value: 1200.0 },
      uHorizonEnd: { value: 2480.0 },
    },

    vertexShader: /* glsl */ `
      ${GERSTNER_GLSL}

      uniform vec3 uCameraPos;
      uniform float uFilterBase, uFilterSlope, uFilterScale;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vJacobian;
      varying float vHeight;
      varying float vDist;
      varying float vViewZ;
      varying float vFoot;
      varying float vCurv;
      varying vec4 vScreen;

      void main() {
        // The position attribute arrives as a flat XZ lattice; the mesh is
        // re-centred on the camera on the CPU, and the world-space XZ we feed
        // the wave field is absolute — that is what makes the ocean infinite
        // with no tiling.
        vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;

        // Local vertex spacing, hence the width of the low-pass we must apply
        // to stay inside Nyquist.
        float r = length(world.xz - uCameraPos.xz);
        float foot = (uFilterBase + r * uFilterSlope) * uFilterScale;

        // Four taps at ±foot on each axis plus a centre tap. The offsets cancel
        // in the average, so the average is the same surface convolved with a
        // box of half-width foot; centre − average is −h²/4·∇², a crest detector.
        vec3 p; vec3 n; float j;
        vec3 pAcc = vec3(0.0);
        vec3 nAcc = vec3(0.0);
        float jAcc = 0.0;
        gerstnerSurface(world.xz + vec2(foot, 0.0), uTime, p, n, j);
        pAcc += p; nAcc += n; jAcc += j;
        gerstnerSurface(world.xz - vec2(foot, 0.0), uTime, p, n, j);
        pAcc += p; nAcc += n; jAcc += j;
        gerstnerSurface(world.xz + vec2(0.0, foot), uTime, p, n, j);
        pAcc += p; nAcc += n; jAcc += j;
        gerstnerSurface(world.xz - vec2(0.0, foot), uTime, p, n, j);
        pAcc += p; nAcc += n; jAcc += j;

        vec3 pC; vec3 nC; float jC;
        gerstnerSurface(world.xz, uTime, pC, nC, jC);

        vec3 surfPos = pAcc * 0.25;
        vec3 surfNrm = normalize(nAcc);

        // Normalised discrete Laplacian: 4·(centre − avg)/foot² = −∇²y.
        // Positive on a crest, negative in a trough, and — unlike height — it
        // picks up the short chop, which is what makes a crest read as a *lip*.
        vCurv = 4.0 * (pC.y - surfPos.y) / max(foot * foot, 1e-4);

        vWorldPos = surfPos;
        vNormal = surfNrm;
        vJacobian = jAcc * 0.25;
        vHeight = surfPos.y;
        vFoot = foot;
        vDist = length(surfPos - uCameraPos);

        vec4 mv = viewMatrix * vec4(surfPos, 1.0);
        // Linear *view* depth, matching what the G-buffer prepass writes
        // (-vViewPos.z / uFar). Comparing radial distance against view depth is
        // what made the first foam ring land in the wrong place.
        vViewZ = -mv.z;
        gl_Position = projectionMatrix * mv;
        vScreen = gl_Position;
      }
    `,

    fragmentShader: /* glsl */ `
      precision highp float;

      uniform vec3 uSunDir, uCameraPos;
      uniform float uTime, uFar, uTanHalfFov;
      uniform vec2 uResolution;
      uniform sampler2D uNoise;
      uniform sampler2D uSceneDepth;

      uniform vec3 uTrough, uDeep, uMid, uShallow, uCrest, uSss, uFoam, uFoamShade;
      uniform vec3 uHorizonTint, uHaze, uSeaFar;

      uniform float uSlopeWeight, uSunWeight, uFresWeight, uFresPivot;
      uniform float uHeightWeight, uHeightScale;
      uniform float uBandJitter, uTileBand, uTileBig, uTileMid, uTileSml, uRippleStrength;
      uniform float uBand0, uBand1, uBand2, uBand3, uCurvGain, uSheen;
      uniform float uFoamPinch, uFoamSoft, uFoamGain, uFoamLip;
      uniform float uFoamFloor, uFoamCeil;
      uniform float uFoamRingWidth, uFoamRingGain;
      uniform float uGlintPx, uGlintGate, uGlintStrength;
      uniform float uFresnelBand;
      uniform float uFlattenStart, uFlattenEnd, uFlattenAmount;
      uniform float uHorizonStart, uHorizonEnd;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vJacobian;
      varying float vHeight;
      varying float vDist;
      varying float vViewZ;
      varying float vFoot;
      varying float vCurv;
      varying vec4 vScreen;

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        vec3 Nv = normalize(vNormal);
        vec3 V = normalize(uCameraPos - vWorldPos);
        vec3 L = normalize(uSunDir);

        // World size of one screen pixel here. Everything that must stay a
        // readable *shape* rather than dissolve is measured against this.
        float pxWorld = vDist * 2.0 * uTanHalfFov / max(uResolution.y, 1.0);
        float distFade = smoothstep(80.0, 700.0, vDist);

        // ── Noise, sampled against the actual resolution limit ──────────────
        // Two earlier passes tried to control noise aliasing with grazing-angle
        // heuristics: grow the pattern, bias the mip. Both failed in a captured
        // frame — at 3.2× growth the sea became brushed satin and foam died
        // (r5); at 1.55× the far field filled with dense white hairlines (r6).
        //
        // The honest measure is the screen footprint: fp below is how many world
        // metres one pixel covers along the *worst* axis, which is exactly what
        // goes wrong at grazing angles and what anisotropic filtering runs out
        // of. Every feature size below is floored at a few pixels of that, so
        // nothing finer than a drawable shape is ever asked for.
        //
        // The floors are applied per *channel*, not per fetch. That was the
        // hairline bug: the noise map packs octaves at tile/7, tile/14 and
        // tile/112, so a 4.7 m tile whose r channel is a comfortable 0.67 m has
        // a b channel at 4 cm — two orders of magnitude below Nyquist.
        float fp = max(fwidth(vWorldPos.x), fwidth(vWorldPos.z));
        float floorFeat = fp * 3.2;

        vec2 dr = vec2(uTime * 0.017, uTime * -0.011);
        // r channel = tile/7. Macro shapes for the band-edge ragging.
        float tileBand = max(uTileBand, floorFeat * 7.0);
        // r channel = tile/7, ≥ 2.9 m: the foam clump silhouette.
        float tileBig = max(uTileBig, floorFeat * 7.0);
        // g channel = tile/14, ≥ 1.1 m: mid-scale break-up.
        float tileMid = max(uTileMid, floorFeat * 14.0);
        // b channel = tile/112, ≥ 0.43 m: the fine bite. A 48 m repeat keeps
        // half-metre detail available without a visibly tiled pattern.
        float tileSml = max(uTileSml, floorFeat * 112.0);

        vec4 nBand = texture2D(uNoise, vWorldPos.xz / tileBand + dr * 0.4);
        vec4 nBig  = texture2D(uNoise, vWorldPos.xz / tileBig  - dr * 1.3);
        vec4 nMid  = texture2D(uNoise, vWorldPos.xz / tileMid  + dr * 0.9);
        vec4 nSml  = texture2D(uNoise, vWorldPos.xz / tileSml  - dr * 2.4);

        // ── Fragment-space ripple ───────────────────────────────────────────
        // The band boundary is a function of the *interpolated* vertex normal, so
        // at a grazing bow camera — where one triangle spans many pixels — the
        // boundary zigzagged along the tessellation and read as a row of teeth
        // (visible across the r3 ocean_low foreground). Perturbing the normal
        // per fragment with a sub-triangle ripple breaks that alignment, and
        // doubles as the fine surface detail the mesh cannot carry.
        //
        // It fades out where its own feature size had to be grown to stay
        // drawable: a ripple you cannot resolve is not detail, it is noise.
        vec2 ripple = vec2(nMid.g - 0.5, nSml.b - 0.5);
        float rippleResolve = clamp(0.45 / max(floorFeat * 1.3, 0.45), 0.0, 1.0);
        float rippleFade = rippleResolve * uRippleStrength;
        vec3 N = normalize(Nv + vec3(ripple.x, 0.0, ripple.y) * rippleFade);

        // ── Shade scalar: facing first, height last ─────────────────────────
        // N.xz points downhill. A face whose downhill runs *away* from the
        // camera is the far side of a wave: it mirrors the sky and reads light.
        vec2 camXZ = uCameraPos.xz - vWorldPos.xz;
        vec2 camDir = camXZ / max(length(camXZ), 1e-4);
        float awayFace = -dot(N.xz, camDir);
        float sunFace = dot(N, L) - 0.62;
        float fres = 1.0 - max(dot(N, V), 0.0);
        float hN = clamp(vHeight / uHeightScale, -1.0, 1.0);

        float shade =
            awayFace * uSlopeWeight
          + sunFace  * uSunWeight
          + (fres - uFresPivot) * uFresWeight
          + hN       * uHeightWeight;

        // Ragged, hand-inked band edges. Without this the bands are smooth
        // analytic curves and the surface reads as cut paper. The fine octave
        // is faded out with distance because at range it is sub-pixel detail
        // that would only add noise to the edge.
        // Three octaves: 10 m for the macro silhouette of a band, 5 m for its
        // lobes, and 0.4 m for the chewed edge that reads as a brush stroke. The
        // finest octave is the floored b channel, so it is alias-safe — r7 dropped
        // it and the sea went back to reading as flat paper cut-outs.
        float jitter = (nBand.r - 0.5) * 0.55
                     + (nBand.g - 0.5) * 0.27
                     + (nSml.b - 0.5) * 0.18;
        shade += jitter * uBandJitter;

        // ── Hard bands ──────────────────────────────────────────────────────
        // Transition width is one pixel of the scalar itself (fwidth). Near the
        // camera that is ~0.003 — a genuinely hard cel edge. Far away, where the
        // scalar changes by half a band per pixel, it converges instead of
        // dithering. A fixed epsilon gave the salt-and-pepper edges of v2.
        float bw = clamp(fwidth(shade) * 0.55, 0.0025, 0.6);
        vec3 col = uTrough;
        col = mix(col, uDeep,    smoothstep(uBand0 - bw, uBand0 + bw, shade));
        col = mix(col, uMid,     smoothstep(uBand1 - bw, uBand1 + bw, shade));
        col = mix(col, uShallow, smoothstep(uBand2 - bw, uBand2 + bw, shade));

        // The brightest tone demands curvature as well as facing, so it lands on
        // pinched crest lips rather than on every away-facing slope in the frame.
        float lipCurv = clamp(vCurv * uCurvGain, -1.0, 1.5);
        float crestSel = shade + max(lipCurv, 0.0);
        float crestMask = smoothstep(uBand3 - bw, uBand3 + bw, crestSel);
        col = mix(col, uCrest, crestMask);

        // A thin drawn highlight riding the shallow→crest boundary. Because the
        // boundary follows slope and curvature it traces the wave form, not an
        // elevation contour. Width is held at ~1.5 px so it reads as a *line*.
        // It is additionally gated on curvature: without that gate it drew a
        // continuous iso-line across the whole mid-field, which is precisely the
        // contour-map read this shader exists to avoid.
        float lineW = max(bw * 2.0, 0.02);
        float sheenLine = smoothstep(uBand2 - bw, uBand2 + bw, shade)
                        - smoothstep(uBand2 + lineW, uBand2 + lineW + bw * 2.0, shade);
        sheenLine *= smoothstep(-0.06, 0.14, lipCurv);
        col = mix(col, uCrest, sheenLine * uSheen * (1.0 - crestMask));

        // ── Back-lit crest translucency ─────────────────────────────────────
        // One hard band of saturated teal where a thin, sharply curved crest is
        // between us and the sun. Gated on curvature and killed with distance —
        // v2 let this bleed across the whole far field and the horizon went green.
        float backLit = max(dot(-V, L), 0.0)
                      * smoothstep(0.22, 0.6, hN)
                      * smoothstep(0.10, 0.35, lipCurv)
                      * (1.0 - smoothstep(60.0, 190.0, vDist));
        col = mix(col, uSss, smoothstep(0.16, 0.20, backLit) * 0.55);

        // ── Aerial perspective, stage 1 ─────────────────────────────────────
        // Collapse band contrast toward one sea tone with distance. Applied
        // BEFORE foam so distant whitecaps survive as white speckle — that
        // speckled band is most of what makes a horizon read as open sea.
        float flatten = smoothstep(uFlattenStart, uFlattenEnd, vDist);
        col = mix(col, uSeaFar, flatten * uFlattenAmount);

        // ── Foam ────────────────────────────────────────────────────────────
        // Jacobian < 1 means the surface is compressing; that is where real
        // water piles up and breaks. Coverage is expressed as a *fraction of
        // area*, then realised by thresholding noise against it — so the amount
        // of white on screen is directly controllable and the shapes stay
        // hard-edged and irregular.
        //
        // The threshold is 0.13, not v2's 0.42: Σ Q·A·k for this wave table is
        // 0.52 spread over six directions, so 1 − jacobian peaks near 0.3. v2's
        // threshold sat above the achievable maximum and produced no foam at all.
        float pinch = smoothstep(uFoamPinch, uFoamPinch + uFoamSoft, 1.0 - vJacobian);
        // Crest lips: high, sharply curved, and rising toward the sky.
        float lip = smoothstep(0.10, 0.42, lipCurv) * smoothstep(0.10, 0.55, hN);
        float coverage = pinch * uFoamGain + lip * uFoamLip;

        // Foam cannot exist on water that is not moving. Without this gate, low
        // coverage on flat troughs passes a few percent of the noise and leaves
        // isolated pale rounded patches that read as lily pads floating on the
        // sea — visible across shots/water_r11 and r12.
        // 0.05–0.15 was too aggressive: |N.xz| only reaches ~0.5 on this wave
        // table and sits around 0.2 on an ordinary face, so that window took most
        // of the crest foam with the lily pads.
        coverage *= smoothstep(0.02, 0.085, length(N.xz));
        // Distant whitecaps thin to speckle rather than vanishing entirely.
        coverage *= 1.0 - 0.45 * distFade;
        // Floor and ceiling: the floor removes the fine white pepper that a few
        // percent of coverage sprinkles over the entire frame, the ceiling keeps
        // the noise biting holes so foam never becomes a solid white continent.
        coverage = clamp((coverage - uFoamFloor) / (1.0 - uFoamFloor), 0.0, 1.0) * uFoamCeil;

        // Lacy break-up: one mid-scale channel for the clump silhouette, one
        // fine channel to bite holes in it.
        // The *dominant* octave has to be around a metre. r7 weighted the 2.9 m
        // channel at 0.50 and the whitecaps came back as discrete pale blobs that
        // read as ice floes: foam clumps are 0.5–2 m, so that is where the energy
        // belongs, with the coarse channel only grouping clumps into patches.
        float breakup = clamp(
          (nMid.g * 0.50 + nSml.b * 0.22 + nBig.r * 0.28 - 0.20) / 0.58, 0.0, 1.0);
        // Hard edge, but resolved to ~1 px so foam does not crawl.
        float fw = max(fwidth(breakup) * 0.6, 0.004);
        float thr = 1.0 - coverage;
        float foam = smoothstep(thr - fw, thr + fw, breakup);
        float thrCore = 1.0 - clamp(coverage * 0.55, 0.0, 1.0);
        float foamCore = smoothstep(thrCore - fw, thrCore + fw, breakup);

        // ── Depth-difference contact, two parts ─────────────────────────────
        // The G-buffer records everything except the water (the water is
        // deliberately excluded so it can read it). Where a fragment of water is
        // *in front of* recorded geometry, we are looking through the surface at
        // something submerged — the skin of a hull, a buoy stem, a gate leg.
        //
        // r2 painted that whole region hard white and, from the bow camera, the
        // submerged flank of the hull became a blazing white slab that the flare
        // pass then bloomed. Splitting it in two fixes it:
        //
        //   • a *tinted* shallow band over the whole submerged area — reads as
        //     "you can see the hull through the water", never blooms
        //   • hard lacy foam only in a narrow slot right at the waterline
        vec2 screenUv = (vScreen.xy / vScreen.w) * 0.5 + 0.5;
        vec4 sceneD = texture2D(uSceneDepth, screenUv);
        float sceneZ = sceneD.r * uFar;
        float behind = sceneZ - vViewZ;
        float hasGeo = step(0.5, sceneD.a) * step(-0.02, behind);

        float shallowBand = hasGeo * (1.0 - clamp(behind / (uFoamRingWidth * 5.0), 0.0, 1.0));
        col = mix(col, mix(uShallow, uCrest, 0.35), shallowBand * 0.55);

        float prox = 1.0 - clamp(behind / uFoamRingWidth, 0.0, 1.0);
        float ringCov = clamp(hasGeo * prox * uFoamRingGain, 0.0, 1.0);
        // Its own, tighter break-up so the collar reads as churn, not a decal.
        float ringBreak = clamp(nSml.b * 0.6 + nMid.g * 0.4, 0.0, 1.0) * 0.62 + 0.24;
        float ringFoam = step(1.0 - ringCov, ringBreak);

        float totalFoam = max(foam, ringFoam);
        // The collar tops out at uFoamShade, not uFoam: foamShade's luminance
        // sits just under the flare pass's 0.82 threshold, so a large collar can
        // never turn into a bloom halo around the boat.
        // Almost all foam is uFoamShade, whose linear luminance (0.73) sits just
        // under the flare pass's 0.82 threshold. Only the small core is pushed to
        // uFoam. At r3 the whole whitecap was uFoam, every crest cleared the
        // threshold, and the bloom turned hard-edged foam into airbrushed smudge.
        vec3 foamHot = mix(uFoamShade, uFoam, foamCore * mix(0.85, 0.3, distFade) * (1.0 - ringFoam * 0.8));
        // Distant foam is tinted toward the sea tone so it stops shouting.
        vec3 foamCol = mix(foamHot, mix(uFoamShade, uSeaFar, 0.6), distFade * 0.7);
        col = mix(col, foamCol, totalFoam);

        // ── Fresnel band right at the horizon ───────────────────────────────
        col = mix(col, uHorizonTint, smoothstep(uFresnelBand, 0.995, fres) * 0.35);

        // ── Quantised sparkle — drawn shapes, not specular noise ────────────
        // Glints live in a lattice whose cell size is fixed in SCREEN PIXELS, so
        // a glint is always ~4 px across whether the water is 5 m or 500 m away.
        // v2 sized the cells in world units and a near glint covered 40 px,
        // which the flare pass then blurred into photographic bokeh.
        vec3 H = normalize(L + V);
        float specLobe = pow(max(dot(N, H), 0.0), 34.0);
        float gate = step(uGlintGate, specLobe);

        float cellSize = max(pxWorld * uGlintPx, vFoot * 0.9);
        vec2 gp = vWorldPos.xz / cellSize;
        vec2 cell = floor(gp);
        float h = hash21(cell);
        float h2 = hash21(cell + 17.3);
        // Jitter the stamp inside its cell so the lattice never reads as a grid.
        vec2 f = fract(gp) - vec2(0.28 + 0.44 * h, 0.28 + 0.44 * h2);
        float diamond = step(abs(f.x) * 1.7 + abs(f.y), 0.13 + 0.10 * h2);
        // Only a third of cells are ever live, and each twinkles on its own phase.
        float live = step(0.62, h);
        float twinkle = step(0.62, abs(sin(uTime * (1.6 + h * 2.8) + h2 * 6.2832)));
        float glint = diamond * live * twinkle * gate;
        col += uFoam * glint * uGlintStrength * (1.0 - totalFoam);

        // ── Aerial perspective, stage 2 ─────────────────────────────────────
        // Dissolve the disc edge into the sky haze. Two stages, because doing it
        // in one gives either a hard-edged disc or a washed-out foreground.
        // The target is a *tinted* haze, not the raw near-white sky haze: mixing
        // all the way to uHaze put a blown white band along the horizon.
        float fade = smoothstep(uHorizonStart, uHorizonEnd, vDist);
        col = mix(col, mix(uHaze, uSeaFar, 0.4), fade);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  return {
    material,
    uniforms: material.uniforms as unknown as Record<string, { value: unknown }>,
    setSceneDepth(tex) {
      material.uniforms.uSceneDepth.value = tex;
    },
  };
}
