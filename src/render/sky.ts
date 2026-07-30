/**
 * Sky dome, cel clouds and a graphic sun.
 *
 * A single inverted sphere carries all three. The clouds are not billboards or
 * a texture — they are procedural shapes evaluated in the fragment shader and
 * then *hard-thresholded*, which is what makes them read as painted cel shapes
 * with a defined rim rather than as soft volumetric fog.
 *
 * The sky writes no G-buffer (`skipPrepass`) and has `edgeBias = 0`, so
 * neither ink system touches it. Inked clouds would fight the boats for
 * attention; in anime backgrounds the sky is almost always line-free.
 */

import {
  BackSide,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { PAL, SUN_DIR } from '../core/palette';
import { SHARED } from './celMaterial';
import { CONFIG } from '../core/config';

export function createSky(): Mesh {
  const geometry = new SphereGeometry(CONFIG.render.far * 0.46, 48, 32);

  const material = new ShaderMaterial({
    name: 'sky',
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTime: SHARED.uTime,
      uSunDir: SHARED.uSunDir,
      uZenith: { value: PAL.skyZenith.clone() },
      uMid: { value: PAL.skyMid.clone() },
      uHorizon: { value: PAL.skyHorizon.clone() },
      uHaze: { value: PAL.skyHaze.clone() },
      uSun: { value: PAL.sun.clone() },
      uSunCore: { value: PAL.sunCore.clone() },
      uFlare: { value: PAL.sunFlare.clone() },
      uCloudLit: { value: PAL.cloudLit.clone() },
      uCloudShade: { value: PAL.cloudShade.clone() },
      uCloudCover: { value: 0.52 },
      uWind: { value: new Vector3(0.011, 0, 0.006) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        // Strip translation: the dome is infinitely far away, so it must not
        // parallax as the camera drives across the ocean.
        vec4 mv = viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w; // force to the far plane
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uZenith, uMid, uHorizon, uHaze;
      uniform vec3 uSun, uSunCore, uFlare;
      uniform vec3 uCloudLit, uCloudShade;
      uniform float uCloudCover;
      uniform vec3 uWind;

      varying vec3 vDir;

      // ── Value noise ────────────────────────────────────────────────────────
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
        return v;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;

        // ── Banded gradient ─────────────────────────────────────────────────
        // Three tones with *narrow smoothsteps* rather than one long ramp.
        // Fully hard steps in the sky read as a rendering error at this scale,
        // so the transitions are tight but not zero-width — the compromise
        // that keeps it graphic while still reading as atmosphere.
        float t = clamp(h, 0.0, 1.0);
        vec3 sky = mix(uHaze, uHorizon, smoothstep(-0.02, 0.09, h));
        sky = mix(sky, uMid, smoothstep(0.07, 0.30, h));
        sky = mix(sky, uZenith, smoothstep(0.28, 0.72, h));

        // A deliberate extra band near the horizon — the pale bloom you see in
        // anime skies where the haze layer meets clear air.
        sky = mix(sky, uHaze, smoothstep(0.14, 0.02, abs(h - 0.045)) * 0.4);

        // ── Sun ─────────────────────────────────────────────────────────────
        vec3 L = normalize(uSunDir);
        float sd = dot(dir, L);
        // Hard disc + two hard flare rings. No inverse-square falloff anywhere.
        float disc = smoothstep(0.9985, 0.9993, sd);
        float ring1 = smoothstep(0.986, 0.9955, sd) * (1.0 - disc);
        float ring2 = smoothstep(0.955, 0.988, sd) * (1.0 - smoothstep(0.986, 0.9955, sd));
        sky = mix(sky, uFlare, ring2 * 0.34);
        sky = mix(sky, uSun, ring1 * 0.75);
        sky = mix(sky, uSunCore, disc);

        // Graphic starburst spokes, drawn not simulated.
        float ang = atan(dir.y - L.y, dir.x - L.x);
        float spokes = pow(abs(sin(ang * 4.0)), 26.0) * smoothstep(0.93, 0.999, sd);
        sky += uFlare * spokes * 0.5;

        // ── Cel clouds ──────────────────────────────────────────────────────
        // Project onto a plane above the camera. Above the horizon only.
        if (h > 0.015) {
          vec2 cuv = dir.xz / max(h, 0.015) * 0.09;
          vec2 drift = uWind.xz * uTime;
          float base = fbm(cuv * 1.15 + drift);
          // Domain-warp so the silhouettes are lumpy and organic rather than
          // the obvious smeared blobs raw fbm gives you.
          float warp = fbm(cuv * 2.4 - drift * 1.7);
          float d = fbm(cuv * 1.4 + vec2(warp) * 0.75 + drift * 1.2);

          float cover = uCloudCover;
          // Two hard thresholds → body and a brighter lit shoulder. The gap
          // between them is the "rim" that makes these read as drawn shapes.
          float body = smoothstep(cover, cover + 0.012, d);
          float litMask = smoothstep(cover + 0.085, cover + 0.098, d + base * 0.14);

          // Fade clouds into the haze near the horizon so the dome doesn't
          // show its geometry where the projection stretches to infinity.
          float horizonFade = smoothstep(0.015, 0.16, h);
          float alpha = body * horizonFade;

          vec3 cloud = mix(uCloudShade, uCloudLit, litMask);
          // Warm the sun-facing side of each cloud, one extra hard step.
          float sunward = smoothstep(0.25, 0.85, dot(normalize(vec3(dir.x, 0.25, dir.z)), L));
          cloud = mix(cloud, uCloudLit * 1.06 + uFlare * 0.16, step(0.6, sunward) * litMask * 0.7);

          sky = mix(sky, cloud, alpha);
        }

        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });

  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  // Neither ink system touches the sky.
  mesh.userData.skipPrepass = true;
  return mesh;
}
