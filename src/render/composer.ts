/**
 * Post stack — the second of the game's two ink systems.
 *
 * Pipeline per frame:
 *
 *   1. G-buffer pass (MRT, 2 attachments)
 *        → view-space normal + edge bias
 *        → linear view depth + object id
 *   2. Beauty pass into an HDR-ish target
 *   3. Stylised flare: hard threshold → two-tap separable blur at ¼ res
 *   4. Composite: Sobel edges over beauty, plus flare, plus a paper vignette
 *
 * ── Why two line systems ───────────────────────────────────────────────────
 * The inverted hull draws exterior silhouettes beautifully and cheaply, but it
 * physically cannot draw a line *inside* a silhouette — the crease where a
 * rider's arm meets their torso, the panel line down a hull, the lip of a
 * cockpit. Those need a screen-space pass.
 *
 * The two must not overlap or every silhouette gets inked twice and reads as a
 * thick, muddy, slightly doubled edge. We keep them apart by excluding outline
 * meshes from the G-buffer entirely (`userData.skipPrepass`), and by biasing
 * the Sobel response *down* where the depth gradient is very large — a large
 * depth gap is exactly a silhouette, which the hull already owns.
 */

import {
  HalfFloatType,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  type PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { PAL } from '../core/palette';

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Sobel over the G-buffer.
 *
 * Three independent edge signals, because no single one is sufficient:
 *   • **depth**  — catches silhouettes and depth discontinuities, but misses
 *                  creases on a continuous surface
 *   • **normal** — catches creases, but misses two parallel surfaces at
 *                  different depths (a wing over a fuselage)
 *   • **id**     — catches two *different objects* meeting at similar depth
 *                  and similar normal, which is exactly an arm across a chest
 *
 * Depth is compared *relatively* (Δd / d) so a line is the same weight at 3 m
 * and 300 m. An absolute threshold gives you dense scribble in the foreground
 * and nothing at all in the distance.
 */
const EdgeShader = {
  uniforms: {
    tDiffuse: { value: null as any },
    tNormal: { value: null as any },
    tDepthId: { value: null as any },
    tFlare: { value: null as any },
    uResolution: { value: new Vector2() },
    uInkColor: { value: PAL.ink.clone() },
    /** Line thickness in pixels. */
    uThickness: { value: 1.35 },
    uDepthThreshold: { value: 0.0055 },
    uNormalThreshold: { value: 0.42 },
    uEdgeStrength: { value: 0.95 },
    uFlareStrength: { value: 0.85 },
    uVignette: { value: 0.28 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepthId;
    uniform sampler2D tFlare;
    uniform vec2 uResolution;
    uniform vec3 uInkColor;
    uniform float uThickness;
    uniform float uDepthThreshold;
    uniform float uNormalThreshold;
    uniform float uEdgeStrength;
    uniform float uFlareStrength;
    uniform float uVignette;

    varying vec2 vUv;

    void main() {
      vec2 texel = uThickness / uResolution;
      vec3 scene = texture2D(tDiffuse, vUv).rgb;

      vec4 nc = texture2D(tNormal, vUv);
      vec4 dc = texture2D(tDepthId, vUv);
      float edgeBias = nc.a;
      float centreDepth = dc.r;
      float centreId = dc.g;

      // Sky / anything that never wrote the G-buffer: leave it untouched.
      if (dc.a < 0.5 || edgeBias <= 0.001) {
        vec3 outc = scene + texture2D(tFlare, vUv).rgb * uFlareStrength;
        float v = 1.0 - uVignette * pow(length(vUv - 0.5) * 1.42, 2.4);
        gl_FragColor = vec4(outc * v, 1.0);
        return;
      }

      vec3 centreNormal = nc.rgb * 2.0 - 1.0;

      // 3×3 Sobel kernels, applied to all three signals in one sweep.
      const vec3 kx = vec3(-1.0, 0.0, 1.0);
      float gxDepth = 0.0, gyDepth = 0.0;
      float normalDiff = 0.0;
      float idDiff = 0.0;

      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 off = vec2(float(i), float(j)) * texel;
          vec4 sd = texture2D(tDepthId, vUv + off);
          vec4 sn = texture2D(tNormal, vUv + off);

          // Sobel weights: [-1 0 1; -2 0 2; -1 0 1]
          float wx = kx[i + 1] * (j == 0 ? 2.0 : 1.0);
          float wy = kx[j + 1] * (i == 0 ? 2.0 : 1.0);
          gxDepth += sd.r * wx;
          gyDepth += sd.r * wy;

          vec3 sNormal = sn.rgb * 2.0 - 1.0;
          normalDiff = max(normalDiff, 1.0 - dot(centreNormal, sNormal));
          idDiff = max(idDiff, abs(sd.g - centreId) > 0.002 ? 1.0 : 0.0);
        }
      }

      // Relative depth gradient → distance-invariant line weight.
      float depthGrad = length(vec2(gxDepth, gyDepth)) / max(centreDepth, 1e-4);
      float depthEdge = smoothstep(uDepthThreshold, uDepthThreshold * 3.4, depthGrad);
      float normalEdge = smoothstep(uNormalThreshold, uNormalThreshold * 1.75, normalDiff);

      // A very large depth gradient *is* a silhouette, and the inverted hull
      // already inked it. Rolling the screen-space contribution off there is
      // what stops the two systems doubling up into a fat, dirty edge.
      float silhouette = smoothstep(uDepthThreshold * 6.0, uDepthThreshold * 16.0, depthGrad);
      depthEdge *= (1.0 - silhouette * 0.88);

      float edge = clamp(max(max(depthEdge, normalEdge), idDiff * 0.85), 0.0, 1.0);
      edge *= edgeBias * uEdgeStrength;

      // Ink is multiplied in rather than mixed to white-point, so lines sit
      // *in* the artwork instead of on top of it.
      vec3 col = mix(scene, uInkColor * (0.35 + 0.65 * scene), edge);
      col += texture2D(tFlare, vUv).rgb * uFlareStrength;

      float v = 1.0 - uVignette * pow(length(vUv - 0.5) * 1.42, 2.4);
      gl_FragColor = vec4(col * v, 1.0);
    }
  `,
};

/** Hard threshold. No soft knee — a soft knee is what makes bloom photographic. */
const ThresholdShader = {
  uniforms: {
    tDiffuse: { value: null as any },
    uThreshold: { value: 0.82 },
    uIntensity: { value: 1.0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uThreshold;
    uniform float uIntensity;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // step(), not smoothstep(): the flare should have a defined shape.
      float m = step(uThreshold, lum);
      gl_FragColor = vec4(c * m * uIntensity, 1.0);
    }
  `,
};

const BlurShader = {
  uniforms: {
    tDiffuse: { value: null as any },
    uDirection: { value: new Vector2(1, 0) },
    uResolution: { value: new Vector2() },
    uRadius: { value: 1.0 },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uDirection;
    uniform vec2 uResolution;
    uniform float uRadius;
    varying vec2 vUv;
    void main() {
      // 9-tap gaussian, linear-sampled to 5 fetches.
      vec2 t = (uDirection / uResolution) * uRadius;
      vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
      sum += texture2D(tDiffuse, vUv + t * 1.3846).rgb * 0.316216;
      sum += texture2D(tDiffuse, vUv - t * 1.3846).rgb * 0.316216;
      sum += texture2D(tDiffuse, vUv + t * 3.2308).rgb * 0.070270;
      sum += texture2D(tDiffuse, vUv - t * 3.2308).rgb * 0.070270;
      gl_FragColor = vec4(sum, 1.0);
    }
  `,
};

export class InkComposer {
  readonly composer: EffectComposer;
  private gbuffer: WebGLRenderTarget;
  private flareA: WebGLRenderTarget;
  private flareB: WebGLRenderTarget;
  private thresholdMat: ShaderMaterial;
  private blurMat: ShaderMaterial;
  private edgePass: ShaderPass;
  private renderPass: RenderPass;
  private fsScene = new Scene();
  private fsCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fsQuad: Mesh;
  private width = 1;
  private height = 1;

  constructor(
    private renderer: WebGLRenderer,
    private scene: Scene,
    private camera: PerspectiveCamera,
  ) {
    // MRT G-buffer. HalfFloat because linear depth in 8 bits gives visibly
    // stepped edge weights on distant geometry.
    this.gbuffer = new WebGLRenderTarget(1, 1, {
      count: 2,
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.gbuffer.textures[0].name = 'gNormal';
    this.gbuffer.textures[1].name = 'gDepthId';

    const flareOpts = { type: UnsignedByteType, format: RGBAFormat, depthBuffer: false };
    this.flareA = new WebGLRenderTarget(1, 1, flareOpts);
    this.flareB = new WebGLRenderTarget(1, 1, flareOpts);

    this.composer = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType }));
    this.composer.renderToScreen = true;

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.edgePass = new ShaderPass(EdgeShader);
    this.edgePass.material.blending = NoBlending;
    this.composer.addPass(this.edgePass);

    this.composer.addPass(new OutputPass());

    // Standalone full-screen quad used for the flare chain, which runs outside
    // the composer so it can work at quarter resolution.
    this.thresholdMat = new ShaderMaterial({ ...ThresholdShader, blending: NoBlending });
    this.blurMat = new ShaderMaterial({ ...BlurShader, blending: NoBlending });
    this.fsQuad = new Mesh(new PlaneGeometry(2, 2), this.thresholdMat);
    this.fsQuad.frustumCulled = false;
    this.fsScene.add(this.fsQuad);
  }

  setSize(width: number, height: number, pixelRatio: number) {
    this.width = Math.max(1, Math.floor(width * pixelRatio));
    this.height = Math.max(1, Math.floor(height * pixelRatio));
    this.composer.setSize(width, height);
    this.composer.setPixelRatio(pixelRatio);
    this.gbuffer.setSize(this.width, this.height);
    this.flareA.setSize(this.width >> 2, this.height >> 2);
    this.flareB.setSize(this.width >> 2, this.height >> 2);

    const u = this.edgePass.uniforms;
    u.uResolution.value.set(this.width, this.height);
    this.blurMat.uniforms.uResolution.value.set(this.width >> 2, this.height >> 2);
  }

  /**
   * Swap every eligible mesh to its prepass material and render the G-buffer.
   *
   * Meshes opt out by setting `userData.skipPrepass` (outlines, particles,
   * the sky dome) — those are hidden for the pass rather than drawn, so they
   * cannot contribute spurious edges.
   */
  private renderGBuffer() {
    const swapped: { mesh: Mesh; material: any; visible: boolean }[] = [];

    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (!(m as any).isMesh && !(m as any).isPoints && !(m as any).isLine) return;
      const prepass = m.userData.prepassMaterial;
      if (m.userData.skipPrepass || !prepass) {
        if (m.visible) {
          swapped.push({ mesh: m, material: null, visible: true });
          m.visible = false;
        }
        return;
      }
      swapped.push({ mesh: m, material: m.material, visible: m.visible });
      m.material = prepass;
    });

    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.gbuffer);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);

    for (const s of swapped) {
      if (s.material === null) s.mesh.visible = s.visible;
      else {
        s.mesh.material = s.material;
        s.mesh.visible = s.visible;
      }
    }
  }

  /** Threshold + separable blur at ¼ res → the stylised sun/spec flare. */
  private renderFlare(sourceTexture: any) {
    const prevTarget = this.renderer.getRenderTarget();

    this.fsQuad.material = this.thresholdMat;
    this.thresholdMat.uniforms.tDiffuse.value = sourceTexture;
    this.renderer.setRenderTarget(this.flareA);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.fsScene, this.fsCamera);

    this.fsQuad.material = this.blurMat;
    for (let i = 0; i < 2; i++) {
      this.blurMat.uniforms.tDiffuse.value = this.flareA.texture;
      this.blurMat.uniforms.uDirection.value.set(1, 0);
      this.blurMat.uniforms.uRadius.value = 1 + i * 2;
      this.renderer.setRenderTarget(this.flareB);
      this.renderer.render(this.fsScene, this.fsCamera);

      this.blurMat.uniforms.tDiffuse.value = this.flareB.texture;
      this.blurMat.uniforms.uDirection.value.set(0, 1);
      this.renderer.setRenderTarget(this.flareA);
      this.renderer.render(this.fsScene, this.fsCamera);
    }

    this.renderer.setRenderTarget(prevTarget);
  }

  render() {
    this.renderGBuffer();

    const u = this.edgePass.uniforms;
    u.tNormal.value = this.gbuffer.textures[0];
    u.tDepthId.value = this.gbuffer.textures[1];

    // The composer's first read target holds the beauty pass once RenderPass
    // has run; we need it before the edge pass, so we run the flare from the
    // previous frame's result. One frame of latency on a soft glow is
    // imperceptible and saves an entire full-res resolve.
    u.tFlare.value = this.flareA.texture;

    this.renderer.setClearColor(0x061024, 1);
    this.composer.render();

    this.renderFlare(this.composer.readBuffer.texture);
  }

  /**
   * The linear-depth + object-id attachment. The water samples this to build
   * its depth-difference foam ring, which is why the ocean itself must stay out
   * of the G-buffer.
   */
  get gbufferDepth() {
    return this.gbuffer.textures[1];
  }

  /** View-space normal attachment, exposed for debugging the edge pass. */
  get gbufferNormal() {
    return this.gbuffer.textures[0];
  }

  get edgeUniforms() {
    return this.edgePass.uniforms;
  }
  get flareUniforms() {
    return this.thresholdMat.uniforms;
  }

  dispose() {
    this.gbuffer.dispose();
    this.flareA.dispose();
    this.flareB.dispose();
    this.composer.dispose();
  }
}
