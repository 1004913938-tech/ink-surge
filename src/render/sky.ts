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
 *
 * ── What the first capture got wrong ───────────────────────────────────────
 * Two things, both visible in shots/cel_r0/sky.png:
 *
 * 1. **Nothing overhead.** The cloud layer was projected onto a flat plane as
 *    `dir.xz / h`, which is geometrically correct and artistically useless: the
 *    magnification goes to infinity at the zenith, so the whole upper sky sampled
 *    one noise value and came back "no cloud". 80% of the frame was an empty navy
 *    field. The projection is now `dir.xz / (h + k)` — a *flattened dome* — which
 *    keeps the perspective compression near the horizon but bounds the
 *    magnification overhead, so cumulus actually populate the sky you are looking
 *    at. Two layers at different heights give parallax.
 *
 * 2. **A photographic sun.** The disc was a smoothstep and the flare was left to
 *    the post-process blur, which turned it into an orange radial haze with soft
 *    spokes — precisely the look the brief forbids. The sun is now drawn: a hard
 *    disc, a hard detached annulus, and crisp straight rays whose *length* steps
 *    rather than fades. It is drawn bright but under the flare threshold, so the
 *    post pass streaks it instead of smothering it.
 *
 * The gradient is also dithered. A 3-tone blue ramp across 1600 device pixels
 * lands well inside 8-bit quantisation and contours visibly; an ordered dither at
 * ±1 LSB removes it without touching the graphic banding we put there on purpose.
 */

import {
  BackSide,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { PAL } from '../core/palette';
import { paletteTone, SHARED } from './celMaterial';
import { CONFIG } from '../core/config';

export function createSky(): Mesh {
  const geometry = new SphereGeometry(CONFIG.render.far * 0.46, 64, 40);

  const material = new ShaderMaterial({
    name: 'sky',
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTime: SHARED.uTime,
      uSunDir: SHARED.uSunDir,
      uZenith: { value: paletteTone(PAL.skyZenith) },
      uMid: { value: paletteTone(PAL.skyMid) },
      uHorizon: { value: paletteTone(PAL.skyHorizon) },
      uHaze: { value: paletteTone(PAL.skyHaze) },
      uSun: { value: paletteTone(PAL.sun) },
      uSunCore: { value: paletteTone(PAL.sunCore) },
      uFlare: { value: paletteTone(PAL.sunFlare) },
      uCloudLit: { value: paletteTone(PAL.cloudLit) },
      uCloudShade: { value: paletteTone(PAL.cloudShade) },
      uCloudRim: { value: paletteTone(PAL.foam) },
      // Higher = *less* cloud (it is a threshold on the noise field). 0.485 put
      // 60% of the frame under a single blown-white mass in shots/cel_r1/sky.png;
      // scattered cumulus with real sky between them wants ~0.60.
      uCloudCover: { value: 0.585 },
      uWind: { value: new Vector3(0.0075, 0, 0.0042) },
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
      uniform vec3 uCloudLit, uCloudShade, uCloudRim;
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
      /**
       * Three octaves only, for the *silhouette* field. Five octaves put enough
       * high-frequency detail near the threshold that the cloud edge came out
       * lacy and amoeba-like; cumulus silhouettes are lumpy but closed, so the
       * shape field is deliberately smoother than the shading field.
       */
      float fbm3(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.11; a *= 0.5; }
        return v / 0.875;
      }

      /** 8×8 ordered dither, ±0.5 LSB, to break 8-bit contouring. */
      float bayer(vec2 c) {
        vec2 p = floor(mod(c, 8.0));
        float b = 0.0;
        // Interleaved-gradient noise is smoother than a real Bayer matrix here
        // and costs one dot product; the goal is only to spread quantisation.
        b = fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
        return b;
      }

      /**
       * One cel cloud layer.
       *
       * 'body' is a hard threshold on the warped fbm — that single step() is what
       * makes the silhouette a painted shape. 'lit' is a second, higher threshold
       * so the sun-facing mass reads as a separate flat tone, and 'rim' is the
       * thin band *between* two nearby thresholds on the same field, which is the
       * inked edge you see on anime cumulus. Nothing here fades.
       */
      vec4 cloudLayer(vec2 uv, float scale, float cover, float sunward, float rimWidth) {
        vec2 drift = uWind.xz * uTime * scale;
        vec2 p = uv * scale;
        float warp = fbm3(p * 1.9 - drift * 1.6);
        float d = fbm3(p * 1.25 + vec2(warp, warp * 0.7) * 0.75 + drift);
        float base = fbm(p * 0.62 + drift * 0.5);

        float body = step(cover, d);
        if (body < 0.5) return vec4(0.0);

        // Interior: three flat tones. The lit threshold sits well above the
        // silhouette threshold so the white is a *shape inside* the cloud rather
        // than the whole cloud — at cover+0.085 nearly every cloud pixel passed
        // and the layer came out as one flat white mass.
        // Thresholds close to the silhouette, so the white core is a large,
        // confident shape. At +0.055 / +0.105 only the biggest masses ever
        // reached the core tone and every small cloud came out uniformly grey
        // (shots/cel_r4/sun_face.png).
        float litMask = step(cover + 0.026, d);
        float coreMask = step(cover + 0.060, d + base * 0.05);
        // The value plan is pale: a fair-weather cumulus is *bright* even in
        // shadow. Dropping the base to 0.80 and the under-shadow to 0.62 turned
        // the mid-sky clouds into grey smudges in shots/cel_r2/sky.png — read as
        // smog, not as cloud. Shadow is a cool blue-lilac at ~0.86 of the shade
        // tone, not a grey at 0.6.
        vec3 col = uCloudShade * 0.94;
        col = mix(col, mix(uCloudShade, uCloudLit, 0.35), litMask);
        col = mix(col, uCloudLit, coreMask);

        // Warm the sun side by one more hard step. Anime clouds get a warm
        // shoulder, never a gradient.
        col = mix(col, uCloudLit + uFlare * 0.20, step(0.62, sunward) * coreMask * 0.8);

        // Under-shadow: the base of each mass drops a step. Uses the
        // low-frequency field so the shadow follows the mass, not the noise.
        col = mix(col, uCloudShade * 0.78, step(base, 0.40) * (1.0 - coreMask) * 0.8);

        // Inked rim: a thin band just inside the silhouette.
        float rim = step(cover, d) - step(cover + rimWidth, d);
        col = mix(col, uCloudRim, rim * 0.85);

        return vec4(col, 1.0);
      }

      /**
       * One opposed pair of hard-edged triangular rays along an axis rotated by
       * 'rot' in the sun's tangent plane. Widest at the sun, tapering linearly to
       * a point at 'len'.
       */
      float rayPair(vec2 t, float rot, float len, float w0) {
        float c = cos(rot), s = sin(rot);
        vec2 q = vec2(t.x * c + t.y * s, -t.x * s + t.y * c);
        float along = abs(q.x);
        float perp = abs(q.y);
        float w = w0 * (1.0 - along / len);
        return step(perp, w) * step(along, len);
      }

      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;
        vec3 L = normalize(uSunDir);

        // ── Banded gradient ─────────────────────────────────────────────────
        // Three tones with *narrow smoothsteps* rather than one long ramp.
        // Fully hard steps in the sky read as a rendering error at this scale,
        // so the transitions are tight but not zero-width — the compromise
        // that keeps it graphic while still reading as atmosphere.
        vec3 sky = mix(uHaze, uHorizon, smoothstep(-0.02, 0.075, h));
        sky = mix(sky, uMid, smoothstep(0.06, 0.26, h));
        sky = mix(sky, uZenith, smoothstep(0.30, 0.78, h));

        // A deliberate extra band near the horizon — the pale bloom you see in
        // anime skies where the haze layer meets clear air.
        sky = mix(sky, uHaze, smoothstep(0.115, 0.015, abs(h - 0.035)) * 0.45);

        // Broad warm bias around the sun's side of the sky. Not a glow: it is a
        // wide, low-amplitude tint that ties the sun into the gradient, so the
        // disc does not look pasted onto an unrelated blue field.
        // Lifting toward the *haze* tone rather than adding the yellow flare
        // colour: adding yellow to a blue field makes grey-purple mud, which is
        // what turned the zenith violet in shots/cel_r1/sky.png. Real skies (and
        // anime skies) desaturate toward the sun, they do not turn orange.
        float sunSide = max(dot(normalize(vec3(dir.x, dir.y * 0.7, dir.z)), L), 0.0);
        sky = mix(sky, uHaze, pow(sunSide, 4.0) * 0.30);
        sky += uFlare * pow(sunSide, 40.0) * 0.16;

        // ── Cel clouds ──────────────────────────────────────────────────────
        // Flattened-dome projection: 'dir.xz / (h + k)'. A true plane ('/h')
        // magnifies without bound at the zenith and leaves the upper sky empty.
        if (h > 0.008) {
          float horizonFade = smoothstep(0.008, 0.075, h);

          // High layer: small, many, drifting faster in uv terms.
          vec2 uvHi = dir.xz / (h + 0.42);
          float sunwardHi = dot(normalize(vec3(dir.x, 0.30, dir.z)), L);
          vec4 hi = cloudLayer(uvHi, 1.35, uCloudCover + 0.055, sunwardHi, 0.020);

          // Low layer: bigger masses, slower, sits under the high one.
          vec2 uvLo = dir.xz / (h + 0.20);
          vec4 lo = cloudLayer(uvLo + 31.7, 0.72, uCloudCover, sunwardHi, 0.014);

          // Flat-bottomed bank hugging the horizon — the cumulus shelf that
          // anchors any anime seascape. Masked to a band in h so it cannot
          // climb into the clear sky above it.
          float bankBand = smoothstep(0.010, 0.040, h) * (1.0 - smoothstep(0.065, 0.155, h));
          vec2 uvBank = dir.xz / (h + 0.085);
          // The bank reads as a shelf only if it is *solid*. Dropping its cover
          // below the other layers made it a lace curtain across the whole
          // horizon (shots/cel_probe3/sun_wide.png), so it now sits slightly
          // above them and gets a coarser field.
          vec4 bank = cloudLayer(uvBank * 0.36 + 77.0, 0.26, uCloudCover + 0.030, sunwardHi, 0.008);

          sky = mix(sky, lo.rgb, lo.a * horizonFade * 0.96);
          sky = mix(sky, bank.rgb, bank.a * bankBand * 0.92);
          sky = mix(sky, hi.rgb, hi.a * horizonFade);
        }

        // ── Sun ─────────────────────────────────────────────────────────────
        // Drawn, not simulated. Hard disc, a *detached* hard annulus, and rays
        // whose length steps in two stages. There is no inverse-square falloff
        // anywhere in here, and nothing that the post blur can turn into haze:
        // the whole figure is made of step()s.
        float sd = dot(dir, L);
        float disc  = step(0.99955, sd);
        float halo  = step(0.9980, sd) * (1.0 - disc);
        float gap   = step(0.9958, sd) * (1.0 - step(0.9980, sd));
        float ring  = step(0.9946, sd) * (1.0 - step(0.9958, sd));

        // Rays. 'ang' is measured in the plane perpendicular to the sun so the
        // spokes stay straight and evenly spaced regardless of where the sun is.
        vec3 up = abs(L.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        vec3 ex = normalize(cross(up, L));
        vec3 ey = cross(L, ex);
        vec2 tang = vec2(dot(dir, ex), dot(dir, ey));
        float ang = atan(tang.y, tang.x);
        float rad = length(tang);

        // Rays as *triangles*, defined by perpendicular distance from an axis
        // rather than by angular width. Thresholding on angle (the first attempt)
        // gives a shape whose linear width grows with radius and then collapses,
        // so each ray came out lens-shaped — pointed at both ends, widest in the
        // middle, reading as a compass rose (shots/cel_probe3/sun_face.png).
        // Perpendicular distance with a linear taper gives the widest-at-the-sun
        // triangle an animator draws, and the edge is still a single step().
        float rays = 0.0;
        rays = max(rays, rayPair(tang,  0.0,       0.300, 0.0130));
        rays = max(rays, rayPair(tang,  1.5707963, 0.235, 0.0105));
        // The diagonals stop *inside* the annulus. When they reached it the
        // ring plus radial spokes read as a ship's wheel rather than as a sun.
        rays = max(rays, rayPair(tang,  0.7853982, 0.062, 0.0042));
        rays = max(rays, rayPair(tang, -0.7853982, 0.062, 0.0042));
        rays *= 1.0 - step(0.9995, sd); // don't draw over the disc itself

        sky = mix(sky, uFlare * 0.92, rays * 0.9);
        sky = mix(sky, uFlare, ring * 0.42);
        sky = mix(sky, uSun * 0.55, gap * 0.35);
        sky = mix(sky, uSun, halo);
        sky = mix(sky, uSunCore, disc);

        // ── Dither ──────────────────────────────────────────────────────────
        // Amplitude tracks the sRGB derivative so one LSB of output is one LSB
        // of dither at every brightness.
        float lsb = 0.0038 * pow(max(max(sky.r, sky.g), sky.b), 0.55);
        sky += (bayer(gl_FragCoord.xy) - 0.5) * lsb;

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
