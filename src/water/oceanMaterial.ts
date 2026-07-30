/**
 * The ocean surface shader.
 *
 * Displacement comes from `GERSTNER_GLSL` — the same wave table the CPU uses
 * for buoyancy, so the boats sit in the water rather than near it.
 *
 * The shading philosophy is: **the surface is drawn, not lit.** There is no
 * refraction, no real reflection, no subsurface integral. What there is:
 *
 *   • four hard colour bands selected by wave height, so the swell reads as
 *     stacked flat shapes the way painted water does
 *   • a hard foam band keyed off the *Jacobian* (surface compression), not off
 *     height — height gives you a foam stripe on every crest simultaneously,
 *     which reads as regular and fake; compression gives you foam where waves
 *     actually collide, which reads as a sea
 *   • a depth-difference foam ring wherever geometry intersects the surface
 *   • quantised sparkle: an animated noise field thresholded to hard glints
 *   • a fresnel band toward the horizon that picks up the sky tone
 */

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  FrontSide,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import { GERSTNER_GLSL, waveUniformArrays } from './gerstner';
import { PAL } from '../core/palette';
import { SHARED } from '../render/celMaterial';
import { makeNoiseTexture } from '../render/textures';

export interface OceanMaterialHandles {
  material: ShaderMaterial;
  /** Set once per frame by the renderer so the foam ring can read scene depth. */
  setSceneDepth(tex: Texture | null): void;
}

export function createOceanMaterial(): OceanMaterialHandles {
  const noise = makeNoiseTexture(512, 8, 5);

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
      uFar: SHARED.uFar,

      uNoise: { value: noise },
      uSceneDepth: { value: null as Texture | null },

      // Palette
      uDeep: { value: PAL.waterDeep.clone() },
      uMid: { value: PAL.waterMid.clone() },
      uShallow: { value: PAL.waterShallow.clone() },
      uCrest: { value: PAL.waterCrest.clone() },
      uSss: { value: PAL.waterSss.clone() },
      uFoam: { value: PAL.foam.clone() },
      uFoamShade: { value: PAL.foamShade.clone() },
      uHorizonTint: { value: PAL.skyHorizon.clone() },
      uHaze: { value: PAL.skyHaze.clone() },

      // Band thresholds, in normalised wave height (-1 … 1). Tuned by eye:
      // the deep band is generous, the crest band is thin, which is what
      // gives the surface its sense of weight.
      uBand0: { value: -0.30 },
      uBand1: { value: 0.06 },
      uBand2: { value: 0.42 },

      // Foam
      uFoamJacobian: { value: 0.62 },
      uFoamCrest: { value: 0.58 },
      uFoamBreakup: { value: 0.52 },
      uFoamRingWidth: { value: 1.15 },

      uSparkleThreshold: { value: 0.80 },
      uSparkleStrength: { value: 1.15 },
      uFresnelBand: { value: 0.72 },

      /** Distance at which the disc fades into the sky haze. */
      uHorizonStart: { value: 900.0 },
      uHorizonEnd: { value: 2500.0 },
    },

    vertexShader: /* glsl */ `
      ${GERSTNER_GLSL}

      uniform vec3 uCameraPos;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vJacobian;
      varying float vHeight;
      varying float vDist;
      varying vec4 vScreen;

      void main() {
        // The position attribute arrives as a flat XZ lattice; the mesh is
        // re-centred on
        // the camera on the CPU, and the world-space XZ we feed the wave field
        // is absolute — that is what makes the ocean infinite with no tiling.
        vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;

        vec3 surfPos;
        vec3 surfNrm;
        float jac;
        gerstnerSurface(world.xz, uTime, surfPos, surfNrm, jac);

        vWorldPos = surfPos;
        vNormal = surfNrm;
        vJacobian = jac;
        vHeight = surfPos.y;
        vDist = length(surfPos - uCameraPos);

        vec4 mv = viewMatrix * vec4(surfPos, 1.0);
        gl_Position = projectionMatrix * mv;
        vScreen = gl_Position;
      }
    `,

    fragmentShader: /* glsl */ `
      precision highp float;

      uniform vec3 uSunDir, uCameraPos;
      uniform float uTime, uFar;
      uniform vec2 uResolution;
      uniform sampler2D uNoise;
      uniform sampler2D uSceneDepth;

      uniform vec3 uDeep, uMid, uShallow, uCrest, uSss, uFoam, uFoamShade, uHorizonTint, uHaze;
      uniform float uBand0, uBand1, uBand2;
      uniform float uFoamJacobian, uFoamCrest, uFoamBreakup, uFoamRingWidth;
      uniform float uSparkleThreshold, uSparkleStrength, uFresnelBand;
      uniform float uHorizonStart, uHorizonEnd;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vJacobian;
      varying float vHeight;
      varying float vDist;
      varying vec4 vScreen;

      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(uCameraPos - vWorldPos);
        vec3 L = normalize(uSunDir);

        // ── Colour bands by height ──────────────────────────────────────────
        // Hard steps. The tiny smoothstep width (0.012) exists only to stop
        // the band edge aliasing into a jagged staircase at distance; it is
        // far below the width at which the eye reads a gradient.
        float hN = clamp(vHeight / 2.2, -1.0, 1.0);
        vec3 col = uDeep;
        col = mix(col, uMid,      smoothstep(uBand0, uBand0 + 0.012, hN));
        col = mix(col, uShallow,  smoothstep(uBand1, uBand1 + 0.012, hN));
        col = mix(col, uCrest,    smoothstep(uBand2, uBand2 + 0.012, hN));

        // ── Back-lit crest translucency ─────────────────────────────────────
        // Where a crest faces away from us and toward the sun, push the
        // saturated teal through it. One hard band — this is the "glowing wave
        // lip" of stylised water, and a smooth version of it just looks foggy.
        float backLit = max(dot(-V, L), 0.0) * smoothstep(0.15, 0.6, hN);
        col = mix(col, uSss, step(0.35, backLit) * 0.55);

        // ── Diffuse banding ─────────────────────────────────────────────────
        float ndl = dot(N, L) * 0.5 + 0.5;
        float lightBand = step(0.46, ndl) * 0.55 + step(0.62, ndl) * 0.45;
        col *= mix(0.78, 1.14, lightBand);

        // ── Foam ────────────────────────────────────────────────────────────
        // Jacobian < 1 means the surface is compressing. Whitecaps live there.
        float compression = clamp(1.0 - vJacobian, 0.0, 2.0);
        float crestMask = smoothstep(uFoamCrest * 0.6, uFoamCrest, hN);

        // Break the foam up with two noise octaves scrolling at different
        // rates, so it never reads as a clean analytic band — that is what
        // stops it looking like a shader threshold and starts it looking like
        // foam. Sampled in world space so it does not swim with the camera.
        vec2 nuv = vWorldPos.xz * 0.055;
        float n1 = texture2D(uNoise, nuv + vec2(uTime * 0.013, uTime * -0.008)).r;
        float n2 = texture2D(uNoise, nuv * 2.7 - vec2(uTime * 0.021, uTime * 0.017)).g;
        float breakup = n1 * 0.62 + n2 * 0.38;

        float foamAmount = compression * 1.5 + crestMask * 0.75;
        float foam = step(uFoamBreakup, foamAmount * breakup * 1.9);

        // A second, tighter threshold gives the foam a two-tone interior
        // instead of a flat white blob.
        float foamCore = step(uFoamBreakup + 0.22, foamAmount * breakup * 1.9);

        // ── Depth-difference foam ring ──────────────────────────────────────
        // Anything the G-buffer recorded that is *just* below the water line
        // gets a hard white collar. This is what welds the boats into the
        // surface instead of leaving them sitting on top of it like decals.
        vec2 screenUv = (vScreen.xy / vScreen.w) * 0.5 + 0.5;
        vec4 sceneD = texture2D(uSceneDepth, screenUv);
        float sceneLinear = sceneD.r * uFar;
        float ownLinear = vDist;
        float diff = sceneLinear - ownLinear;
        // Only when there is real geometry there (alpha marks a G-buffer write)
        // and it is in front of the water surface.
        float ring = sceneD.a > 0.5 ? (1.0 - smoothstep(0.0, uFoamRingWidth, abs(diff))) : 0.0;
        ring *= step(-0.15, diff + uFoamRingWidth);
        float ringFoam = step(0.35, ring * (0.65 + breakup * 0.7));

        float totalFoam = max(foam, ringFoam);
        vec3 foamCol = mix(uFoamShade, uFoam, max(foamCore, ringFoam));
        col = mix(col, foamCol, totalFoam);

        // ── Fresnel band toward the horizon ─────────────────────────────────
        float fres = 1.0 - max(dot(N, V), 0.0);
        col = mix(col, uHorizonTint, step(uFresnelBand, fres) * 0.42);

        // ── Quantised sparkle ───────────────────────────────────────────────
        // Anime light-glitter: a moving noise field, hard-thresholded, gated by
        // the specular lobe so glints only appear where light would actually
        // bounce. Suppressed on foam so it does not read as noise on white.
        vec3 H = normalize(L + V);
        float specLobe = pow(max(dot(N, H), 0.0), 22.0);
        vec2 suv = vWorldPos.xz * 0.14 + vec2(uTime * 0.05, uTime * -0.037);
        float sn = texture2D(uNoise, suv).b * texture2D(uNoise, suv * 1.9 + 0.37).r * 2.2;
        float sparkle = step(uSparkleThreshold, sn) * step(0.06, specLobe);
        col += uFoam * sparkle * uSparkleStrength * (1.0 - totalFoam);

        // Hard-edged sun glitter path — a wide band of small bright shapes
        // running toward the sun, the single most recognisable feature of
        // stylised daytime water.
        float glitterBand = smoothstep(0.05, 0.35, specLobe);
        float glitter = step(0.66, sn * 0.8 + specLobe * 0.9);
        col += uFoam * glitter * glitterBand * 0.9 * (1.0 - totalFoam);

        // ── Horizon fade ────────────────────────────────────────────────────
        // The disc has a finite radius; blend it into the sky haze so the edge
        // is invisible and the ocean appears to reach the horizon.
        float fade = smoothstep(uHorizonStart, uHorizonEnd, vDist);
        col = mix(col, uHaze, fade);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  return {
    material,
    setSceneDepth(tex) {
      material.uniforms.uSceneDepth.value = tex;
    },
  };
}
