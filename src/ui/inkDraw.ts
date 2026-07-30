/**
 * Canvas-2D ink primitives — the drawing vocabulary the whole HUD is built from.
 *
 * Owned by the presentation subsystem. Nothing here knows about the game; it is
 * purely "how do you draw a shape that looks like it was inked with a brush and
 * filled with a marker". Three ideas carry the style:
 *
 *   1. **Every filled shape is inked.** A flat fill plus a thick dark stroke is
 *      what makes cel art read; a fill with no outline reads as a UI toolkit.
 *   2. **Nothing is axis-aligned.** Plates are parallelograms and corner-cut
 *      octagons, headline text leans. Rectangles read as HTML.
 *   3. **Numerals are drawn, not typed.** The speedometer and the lap counter
 *      use a hand-built seven-segment glyph set so the instrument reads as an
 *      instrument rather than as system-font text on glass.
 *
 * All coordinates are CSS pixels; the caller has already applied the DPR
 * transform. Helpers never allocate inside a loop the caller runs per frame
 * unless a Path2D is unavoidable — static chrome is meant to be baked once into
 * an offscreen layer (see `hud.ts`).
 */

export const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/** `rgba()` string from a palette hex and an alpha. */
export function rgba(hex: number, a: number) {
  return `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;
}

/** Blend two palette hexes in sRGB and return a CSS string. */
export function mixHex(a: number, b: number, t: number) {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return `rgb(${r},${g},${bl})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parallelogram leaning right. `skew` is the horizontal offset of the top edge
 * relative to the bottom, in pixels. This is the workhorse plate shape.
 */
export function slantPath(x: number, y: number, w: number, h: number, skew: number) {
  const p = new Path2D();
  p.moveTo(x + skew, y);
  p.lineTo(x + skew + w, y);
  p.lineTo(x + w, y + h);
  p.lineTo(x, y + h);
  p.closePath();
  return p;
}

/**
 * Rectangle with mitred corners. `cuts` selects which corners are chamfered,
 * clockwise from top-left as a 4-bit mask. Cutting only two opposite corners
 * gives the tapered "tab" the standings rows use.
 */
export function cutPath(
  x: number,
  y: number,
  w: number,
  h: number,
  c: number,
  cuts = 0b1111,
) {
  const p = new Path2D();
  const tl = cuts & 0b1000 ? c : 0;
  const tr = cuts & 0b0100 ? c : 0;
  const br = cuts & 0b0010 ? c : 0;
  const bl = cuts & 0b0001 ? c : 0;
  p.moveTo(x + tl, y);
  p.lineTo(x + w - tr, y);
  if (tr) p.lineTo(x + w, y + tr);
  p.lineTo(x + w, y + h - br);
  if (br) p.lineTo(x + w - br, y + h);
  p.lineTo(x + bl, y + h);
  if (bl) p.lineTo(x, y + h - bl);
  p.lineTo(x, y + tl);
  p.closePath();
  return p;
}

/** Forward-pointing chevron cell — the boost meter segment. */
export function chevronPath(x: number, y: number, w: number, h: number, notch: number) {
  const p = new Path2D();
  p.moveTo(x, y);
  p.lineTo(x + w - notch, y);
  p.lineTo(x + w, y + h * 0.5);
  p.lineTo(x + w - notch, y + h);
  p.lineTo(x, y + h);
  p.lineTo(x + notch, y + h * 0.5);
  p.closePath();
  return p;
}

/** Solid diamond — minimap racer pips and place badges. */
export function diamondPath(cx: number, cy: number, rx: number, ry: number) {
  const p = new Path2D();
  p.moveTo(cx, cy - ry);
  p.lineTo(cx + rx, cy);
  p.lineTo(cx, cy + ry);
  p.lineTo(cx - rx, cy);
  p.closePath();
  return p;
}

/**
 * Wide, soft-dark stroke laid under a plate's real outline. Foam and sun glints
 * behind the HUD can be brighter than `hudPaper`, at which point a 3 px paper
 * stroke disappears into them; a halo keeps every plate legible over any part of
 * the scene without resorting to a drop shadow (which would break the flat look).
 */
export function halo(
  g: CanvasRenderingContext2D,
  path: Path2D,
  color: string,
  width: number,
) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineJoin = 'round';
  g.stroke(path);
  g.restore();
}

/** Fill a path then ink it. Order matters: the stroke must sit on top. */
export function inked(
  g: CanvasRenderingContext2D,
  path: Path2D,
  fill: string | null,
  ink: string | null,
  width = 3,
) {
  if (fill) {
    g.fillStyle = fill;
    g.fill(path);
  }
  if (ink && width > 0) {
    g.strokeStyle = ink;
    g.lineWidth = width;
    g.lineJoin = 'miter';
    g.stroke(path);
  }
}

/**
 * Diagonal hatch inside a path — the "empty" state for meters. Reads as drawn
 * shading rather than as a grey fill, which is the whole point.
 */
export function hatch(
  g: CanvasRenderingContext2D,
  clip: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  step = 7,
  lw = 1.6,
) {
  g.save();
  g.clip(clip);
  g.strokeStyle = color;
  g.lineWidth = lw;
  g.beginPath();
  for (let i = -h; i < w + h; i += step) {
    g.moveTo(x + i, y + h);
    g.lineTo(x + i + h, y);
  }
  g.stroke();
  g.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

export interface TextOpts {
  font: string;
  fill: string;
  /** Outline colour. Drawn as a stroke *behind* the fill so the fill stays crisp. */
  ink?: string;
  inkWidth?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  /** Positive leans the glyph tops to the right, like an italic. */
  skew?: number;
  /** Extra letter spacing in px. Costs a draw per glyph, so use it on headlines. */
  tracking?: number;
  /** Offset colour layer under the glyph — cheap chromatic punch. */
  ghost?: string;
  ghostDx?: number;
  ghostDy?: number;
}

function drawTracked(
  g: CanvasRenderingContext2D,
  text: string,
  mode: 'fill' | 'stroke',
  tracking: number,
) {
  let x = 0;
  for (const ch of text) {
    if (mode === 'fill') g.fillText(ch, x, 0);
    else g.strokeText(ch, x, 0);
    x += g.measureText(ch).width + tracking;
  }
}

export function trackedWidth(
  g: CanvasRenderingContext2D,
  text: string,
  tracking: number,
) {
  let x = 0;
  for (const ch of text) x += g.measureText(ch).width + tracking;
  return x - tracking;
}

/**
 * Headline text: optional ghost layer, thick ink outline, flat fill, optional
 * lean. This is the only text routine the HUD uses — consistency of treatment
 * is what stops the overlay looking like four different UIs.
 */
export function inkText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  o: TextOpts,
) {
  const tracking = o.tracking ?? 0;
  g.save();
  g.font = o.font;
  g.textBaseline = o.baseline ?? 'alphabetic';
  // Tracked text is laid out by hand, so alignment has to be resolved manually.
  let ox = 0;
  if (tracking !== 0) {
    const w = trackedWidth(g, text, tracking);
    if ((o.align ?? 'left') === 'center') ox = -w / 2;
    else if (o.align === 'right') ox = -w;
    g.textAlign = 'left';
  } else {
    g.textAlign = o.align ?? 'left';
  }
  g.translate(x + ox, y);
  if (o.skew) g.transform(1, 0, -o.skew, 1, 0, 0);
  g.lineJoin = 'round';
  g.miterLimit = 2;

  if (o.ghost) {
    g.save();
    g.translate(o.ghostDx ?? 3, o.ghostDy ?? 3);
    g.fillStyle = o.ghost;
    if (tracking !== 0) drawTracked(g, text, 'fill', tracking);
    else g.fillText(text, 0, 0);
    g.restore();
  }
  if (o.ink && (o.inkWidth ?? 0) > 0) {
    g.strokeStyle = o.ink;
    g.lineWidth = o.inkWidth!;
    if (tracking !== 0) drawTracked(g, text, 'stroke', tracking);
    else g.strokeText(text, 0, 0);
  }
  g.fillStyle = o.fill;
  if (tracking !== 0) drawTracked(g, text, 'fill', tracking);
  else g.fillText(text, 0, 0);
  g.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Seven-segment numerals
// ─────────────────────────────────────────────────────────────────────────────
//
// Built as mitred hexagonal bars in a unit box so the same glyph set scales
// from the 14 px lap counter to the 64 px speed readout without a font. Unlit
// segments are drawn faintly, which is what makes a gauge read as a physical
// display rather than as a number.

/** Segment order: A top, B upper-right, C lower-right, D bottom, E lower-left, F upper-left, G middle. */
const SEG_MASK = [
  0b1111110, // 0  A B C D E F
  0b0110000, // 1  B C
  0b1101101, // 2  A B G E D
  0b1111001, // 3  A B C D G
  0b0110011, // 4  F G B C
  0b1011011, // 5  A F G C D
  0b1011111, // 6  A F G E C D
  0b1110000, // 7  A B C
  0b1111111, // 8
  0b1111011, // 9  A B C D F G
];
const BIT = { A: 0b1000000, B: 0b0100000, C: 0b0010000, D: 0b0001000, E: 0b0000100, F: 0b0000010, G: 0b0000001 };

function hbar(w: number, y: number, t: number) {
  const ht = t * 0.5;
  const p = new Path2D();
  p.moveTo(ht, y - ht);
  p.lineTo(w - ht, y - ht);
  p.lineTo(w, y);
  p.lineTo(w - ht, y + ht);
  p.lineTo(ht, y + ht);
  p.lineTo(0, y);
  p.closePath();
  return p;
}

function vbar(x: number, y0: number, y1: number, t: number) {
  const ht = t * 0.5;
  const p = new Path2D();
  p.moveTo(x - ht, y0 + ht);
  p.lineTo(x, y0);
  p.lineTo(x + ht, y0 + ht);
  p.lineTo(x + ht, y1 - ht);
  p.lineTo(x, y1);
  p.lineTo(x - ht, y1 - ht);
  p.closePath();
  return p;
}

/** Cached unit-box segment geometry, keyed by nothing — it never changes. */
let segCache: { bit: number; path: Path2D }[] | null = null;
function segGeometry() {
  if (segCache) return segCache;
  const W = 0.6;
  const H = 1.0;
  const t = 0.17;
  const ht = t * 0.5;
  segCache = [
    { bit: BIT.A, path: hbar(W, ht, t) },
    { bit: BIT.G, path: hbar(W, H * 0.5, t) },
    { bit: BIT.D, path: hbar(W, H - ht, t) },
    { bit: BIT.F, path: vbar(ht, ht, H * 0.5, t) },
    { bit: BIT.B, path: vbar(W - ht, ht, H * 0.5, t) },
    { bit: BIT.E, path: vbar(ht, H * 0.5, H - ht, t) },
    { bit: BIT.C, path: vbar(W - ht, H * 0.5, H - ht, t) },
  ];
  return segCache;
}

export interface SegOpts {
  lit: string;
  /** Unlit segment colour. Pass null to hide them entirely. */
  dim?: string | null;
  ink?: string | null;
  inkWidth?: number;
  /** Lean, as a fraction of glyph height. 0.1 reads as a racing instrument. */
  skew?: number;
  align?: 'left' | 'right' | 'center';
}

export const SEG_ADVANCE = 0.74; // glyph box 0.6 wide + 0.14 gap, in height units

/**
 * Width of `text` rendered at glyph height `h`. Digits are deliberately
 * monospaced — a proportional `1` makes a live speed readout jitter sideways,
 * which is exactly the kind of thing that reads as "web page", not "instrument".
 */
export function segWidth(text: string, h: number) {
  let w = 0;
  for (const ch of text) w += (ch === ':' || ch === '.' ? 0.3 : SEG_ADVANCE) * h;
  return w - 0.14 * h;
}

/**
 * Draw a seven-segment string. Supports digits, space, `:` and `/`, which is
 * everything the HUD's numeric readouts need.
 */
export function segText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  h: number,
  o: SegOpts,
) {
  const geo = segGeometry();
  const total = segWidth(text, h);
  let ox = 0;
  if (o.align === 'right') ox = -total;
  else if (o.align === 'center') ox = -total / 2;

  g.save();
  g.translate(x + ox, y);
  if (o.skew) g.transform(1, 0, o.skew, 1, 0, 0);
  g.lineJoin = 'miter';

  let cursor = 0;
  for (const ch of text) {
    if (ch === ' ') {
      cursor += SEG_ADVANCE * h;
      continue;
    }
    if (ch === ':' || ch === '.') {
      const cx = cursor + 0.09 * h;
      const r = 0.055 * h;
      g.save();
      g.translate(cx, 0);
      const dots = ch === ':' ? [0.34, 0.7] : [0.9];
      for (const dy of dots) {
        const d = diamondPath(0, dy * h, r, r * 1.35);
        inked(g, d, o.lit, o.ink ?? null, (o.inkWidth ?? 0) * 0.6);
      }
      g.restore();
      cursor += 0.3 * h;
      continue;
    }
    if (ch === '/') {
      g.save();
      g.strokeStyle = o.lit;
      g.lineWidth = 0.13 * h;
      g.beginPath();
      g.moveTo(cursor + 0.42 * h, 0.06 * h);
      g.lineTo(cursor + 0.06 * h, 0.94 * h);
      g.stroke();
      g.restore();
      cursor += SEG_ADVANCE * 0.68 * h;
      continue;
    }
    const d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) {
      cursor += SEG_ADVANCE * h;
      continue;
    }
    const mask = SEG_MASK[d];
    g.save();
    // `1` only lights the two right-hand bars, so in a monospaced cell it sits
    // hard against the following digit. Optically centre it inside its own cell
    // without changing the advance — the readout must not shuffle sideways as
    // the value changes.
    g.translate(cursor + (d === 1 ? -0.21 * h : 0), 0);
    g.scale(h, h);
    for (const s of geo) {
      const on = (mask & s.bit) !== 0;
      if (!on && !o.dim) continue;
      g.fillStyle = on ? o.lit : o.dim!;
      g.fill(s.path);
    }
    if (o.ink && (o.inkWidth ?? 0) > 0) {
      g.strokeStyle = o.ink;
      g.lineWidth = (o.inkWidth ?? 2) / h;
      for (const s of geo) {
        if ((mask & s.bit) === 0 && !o.dim) continue;
        g.stroke(s.path);
      }
    }
    g.restore();
    cursor += SEG_ADVANCE * h;
  }
  g.restore();
}
