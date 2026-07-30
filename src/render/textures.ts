/**
 * Procedural texture factory. Zero external assets — everything the game
 * samples is generated here, either as a DataTexture (for exact, un-dithered
 * control of ramp steps) or via canvas 2D (for shapes we'd rather draw than
 * compute).
 *
 * All ramps use NearestFilter. This is not an optimisation — bilinear
 * filtering on a 4-pixel ramp is exactly what turns crisp cel banding back
 * into a gradient, which is the single most common way this look fails.
 */

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  LinearSRGBColorSpace,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three';

const cache = new Map<string, Texture>();
function memo<T extends Texture>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  const tex = make();
  cache.set(key, tex);
  return tex;
}

/**
 * Step ramp: N hard bands, sampled by NdotL.
 *
 * `stops` gives the *thresholds* (in 0..1 lighting space) at which each band
 * begins, so the terminator can be pushed toward the lit side — which is what
 * anime key art actually does. Evenly spaced bands read as a technical demo;
 * a wide lit band with a narrow, late shadow band reads as illustration.
 */
export function makeRampTexture(colors: Color[], stops: number[], size = 64): DataTexture {
  const key = `ramp:${colors.map((c) => c.getHexString()).join(',')}:${stops.join(',')}:${size}`;
  return memo(key, () => {
    const data = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);
      // Find the last stop we're past — hard selection, no blending.
      let band = 0;
      for (let s = 0; s < stops.length; s++) if (t >= stops[s]) band = s;
      const c = colors[Math.min(band, colors.length - 1)];
      data[i * 4 + 0] = Math.round(c.r * 255);
      data[i * 4 + 1] = Math.round(c.g * 255);
      data[i * 4 + 2] = Math.round(c.b * 255);
      data[i * 4 + 3] = 255;
    }
    const tex = new DataTexture(data, size, 1, RGBAFormat, UnsignedByteType);
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.colorSpace = LinearSRGBColorSpace; // colours are already linear
    tex.needsUpdate = true;
    return tex;
  }) as DataTexture;
}

/**
 * Stylised matcap, drawn rather than captured. Used in place of an environment
 * probe: a real cubemap reflection immediately reads as PBR, whereas a
 * hand-drawn matcap keeps metal and gloss graphic.
 *
 * The disc is built from: a base tone, a hard-edged bright cap toward the
 * light, a cool bounce along the lower rim, and a thin white sliver at the
 * very edge for the "inked highlight" you see on anime metal.
 */
export function makeMatcapTexture(
  base: Color,
  light: Color,
  bounce: Color,
  size = 256,
): CanvasTexture {
  const key = `matcap:${base.getHexString()}:${light.getHexString()}:${bounce.getHexString()}`;
  return memo(key, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d')!;
    const R = size / 2;
    const hex = (c: Color) => '#' + c.clone().convertLinearToSRGB().getHexString();

    g.clearRect(0, 0, size, size);

    // Base disc.
    g.fillStyle = hex(base);
    g.beginPath();
    g.arc(R, R, R, 0, Math.PI * 2);
    g.fill();

    // Cool bounce across the lower half — hard edge, offset down-right.
    g.save();
    g.beginPath();
    g.arc(R, R, R, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = hex(bounce);
    g.beginPath();
    g.ellipse(R * 1.15, R * 1.55, R * 1.05, R * 0.85, 0, 0, Math.PI * 2);
    g.fill();

    // Key highlight: a hard blob up-left, plus a smaller detached spark.
    g.fillStyle = hex(light);
    g.beginPath();
    g.ellipse(R * 0.66, R * 0.6, R * 0.46, R * 0.38, -0.5, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(R * 1.28, R * 0.44, R * 0.16, R * 0.1, 0.4, 0, Math.PI * 2);
    g.fill();

    // Inked rim sliver — bright arc hugging the silhouette edge.
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = size * 0.028;
    g.beginPath();
    g.arc(R, R, R * 0.965, Math.PI * 0.72, Math.PI * 1.62);
    g.stroke();
    g.restore();

    const tex = new CanvasTexture(cv);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
    return tex;
  }) as CanvasTexture;
}

/**
 * Tiling value-noise texture. Used for foam break-up, cloud shaping and the
 * ocean's sparkle mask. Generated on a canvas with a wrapped bilinear lattice
 * so it tiles seamlessly — visible tiling in the water is a named failure mode.
 */
export function makeNoiseTexture(size = 256, lattice = 16, octaves = 4): CanvasTexture {
  const key = `noise:${size}:${lattice}:${octaves}`;
  return memo(key, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(size, size);

    // Seeded lattice so the texture is identical across runs.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const grids: number[][] = [];
    for (let o = 0; o < octaves; o++) {
      const n = lattice << o;
      const grid = new Array(n * n);
      for (let i = 0; i < n * n; i++) grid[i] = rand();
      grids.push(grid);
    }

    const fade = (t: number) => t * t * (3 - 2 * t);
    const sampleOctave = (o: number, u: number, v: number) => {
      const n = lattice << o;
      const grid = grids[o];
      const x = u * n,
        y = v * n;
      const x0 = Math.floor(x) % n,
        y0 = Math.floor(y) % n;
      const x1 = (x0 + 1) % n,
        y1 = (y0 + 1) % n;
      const fx = fade(x - Math.floor(x)),
        fy = fade(y - Math.floor(y));
      const a = grid[y0 * n + x0],
        b = grid[y0 * n + x1];
      const c = grid[y1 * n + x0],
        d = grid[y1 * n + x1];
      return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size,
          v = y / size;
        let amp = 0.5,
          sum = 0,
          norm = 0;
        for (let o = 0; o < octaves; o++) {
          sum += sampleOctave(o, u, v) * amp;
          norm += amp;
          amp *= 0.5;
        }
        const n = sum / norm;
        const i = (y * size + x) * 4;
        // Pack three differently-scaled versions so one fetch feeds three uses.
        img.data[i + 0] = Math.round(n * 255);
        img.data[i + 1] = Math.round(sampleOctave(1, u, v) * 255);
        img.data[i + 2] = Math.round(sampleOctave(octaves - 1, u, v) * 255);
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    const tex = new CanvasTexture(cv);
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.colorSpace = LinearSRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }) as CanvasTexture;
}

/**
 * Hard-edged foam stamp: clustered blobs with a bitten-out interior, the shape
 * language of hand-inked sea foam. Alpha only — tinted at draw time.
 */
export function makeFoamTexture(size = 256): CanvasTexture {
  return memo(`foam:${size}`, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d')!;
    let seed = 1337;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    g.clearRect(0, 0, size, size);
    g.fillStyle = '#ffffff';

    // Outer cluster of overlapping discs → a lumpy, organic silhouette.
    for (let i = 0; i < 90; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.pow(rand(), 0.62) * size * 0.4;
      const x = size / 2 + Math.cos(a) * r;
      const y = size / 2 + Math.sin(a) * r;
      const rad = size * (0.035 + rand() * 0.075);
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
    // Bite holes back out so the stamp reads as foam lace, not a white splodge.
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 46; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.pow(rand(), 0.5) * size * 0.33;
      const x = size / 2 + Math.cos(a) * r;
      const y = size / 2 + Math.sin(a) * r;
      const rad = size * (0.018 + rand() * 0.05);
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';

    const tex = new CanvasTexture(cv);
    tex.colorSpace = LinearSRGBColorSpace;
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    return tex;
  }) as CanvasTexture;
}

/** Four-point anime sparkle, for water glitter and boost pips. */
export function makeSparkleTexture(size = 128): CanvasTexture {
  return memo(`sparkle:${size}`, () => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d')!;
    const R = size / 2;
    g.clearRect(0, 0, size, size);
    g.fillStyle = '#ffffff';
    // Two crossed four-point stars: long thin lobes, concave waist.
    const star = (rot: number, len: number, wid: number) => {
      g.save();
      g.translate(R, R);
      g.rotate(rot);
      g.beginPath();
      g.moveTo(0, -len);
      g.quadraticCurveTo(wid * 0.35, -wid * 0.35, len, 0);
      g.quadraticCurveTo(wid * 0.35, wid * 0.35, 0, len);
      g.quadraticCurveTo(-wid * 0.35, wid * 0.35, -len, 0);
      g.quadraticCurveTo(-wid * 0.35, -wid * 0.35, 0, -len);
      g.fill();
      g.restore();
    };
    star(0, R * 0.98, R * 0.5);
    star(Math.PI / 4, R * 0.5, R * 0.26);
    const tex = new CanvasTexture(cv);
    tex.colorSpace = LinearSRGBColorSpace;
    tex.generateMipmaps = true;
    return tex;
  }) as CanvasTexture;
}
