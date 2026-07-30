/**
 * Procedural racing-boat hull.
 *
 * Everything here is authored as raw triangles in a tiny `Surface` builder and
 * merged into **three** BufferGeometries — one per cel material — so a boat
 * costs 3 shaded draw calls plus 3 inverted-hull outlines rather than one call
 * per greeble.
 *
 * ── Why hand-rolled triangles instead of CSG or lathes ─────────────────────
 * The brief is cel art, not CAD. A cel silhouette wants *few, confident*
 * planes with hard creases: every crease is a place the Sobel pass can put an
 * interior line and every large flat plane is a place the banded specular can
 * land as a readable shape. Smooth lathed forms give you neither — they read as
 * soft plastic under a quantised ramp. So the hull is a loft over eight
 * hand-tuned stations with a **hard chine** (a deliberate crease running the
 * whole length) and the superstructure is a set of tapered boxes.
 *
 * ── Silhouette contract ────────────────────────────────────────────────────
 * The player mostly sees rivals at 40–80 m, where only the outline survives.
 * Read from the side, the boat must break down into five distinct masses:
 *
 *      spoiler ─┐        ┌── raked windscreen
 *               ▼        ▼
 *          ╭──▒▒▒╮   ╭─╮
 *      ────┤ cowl│═══╡ ╞═══════════◣  ← pointed, rising bow
 *          ╰─────╯   ╰─╯            ◤
 *             │  saddle
 *             fin
 *
 * Those five (bow spike, windscreen, saddle, engine hump, spoiler) are what
 * make it read as a *racing* boat and not a dinghy at distance.
 *
 * ── Normals ────────────────────────────────────────────────────────────────
 * Geometry is non-indexed with per-face normals, i.e. genuinely faceted. That
 * matters twice: the main pass gets flat shading without needing the
 * FLAT_SHADING define, and the *prepass* also gets flat normals, so the
 * screen-space edge pass inks every crease. `computeSmoothNormals` (called by
 * `applyCel`) then welds by position for the outline hull, so the outline stays
 * closed across those same creases.
 */

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, Object3D, Vector3 } from 'three';
import { PAL, RACER_COLORS } from '../core/palette';
import { applyCel, createCelMaterial, type CelMaterialSet } from '../render/celMaterial';

// ─────────────────────────────────────────────────────────────────────────────
// Triangle soup builder
// ─────────────────────────────────────────────────────────────────────────────

type V3 = readonly [number, number, number];
/** 2D cross-section point, (x, y). */
type P2 = readonly [number, number];
/** Corner rect for a tapered box: [x0, x1, y0, y1]. */
type Rect = readonly [number, number, number, number];

const mirrorX = (v: V3): V3 => [-v[0], v[1], v[2]];

class Surface {
  private p: number[] = [];

  tri(a: V3, b: V3, c: V3) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }

  /** Convex quad a→b→c→d. Normal is cross(b-a, c-a). */
  quad(a: V3, b: V3, c: V3, d: V3) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /**
   * Same quad mirrored to port when `sign < 0`. Mirroring flips winding, so the
   * vertex order is reversed to keep the normal pointing outboard.
   */
  quadMirrored(sign: number, a: V3, b: V3, c: V3, d: V3) {
    if (sign > 0) this.quad(a, b, c, d);
    else this.quad(mirrorX(a), mirrorX(d), mirrorX(c), mirrorX(b));
  }

  /** Loft two equal-length open rings. `flip` reverses the quad winding. */
  loft(ringA: V3[], ringB: V3[], flip = false, from = 0, to = -1) {
    const end = to < 0 ? ringA.length - 1 : to;
    for (let j = from; j < end; j++) {
      if (flip) this.quad(ringA[j], ringB[j], ringB[j + 1], ringA[j + 1]);
      else this.quad(ringA[j], ringA[j + 1], ringB[j + 1], ringB[j]);
    }
  }

  /**
   * Cap a ring with a triangle fan about `centre`, winding chosen so the face
   * normal agrees with `want`. Deciding the winding from the geometry rather
   * than by hand is why none of the caps in this file can end up inside-out.
   */
  cap(ring: V3[], centre: V3, want: V3, closed = true) {
    const n = ring.length;
    const probe = triNormal(centre, ring[0], ring[1]);
    const flip = probe[0] * want[0] + probe[1] * want[1] + probe[2] * want[2] < 0;
    const last = closed ? n : n - 1;
    for (let j = 0; j < last; j++) {
      const a = ring[j];
      const b = ring[(j + 1) % n];
      if (flip) this.tri(centre, b, a);
      else this.tri(centre, a, b);
    }
  }

  /** Axis-aligned box with outward normals. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    this.taperBox(z0, z1, [x0, x1, y0, y1], [x0, x1, y0, y1]);
  }

  /**
   * Box tapered along Z between two corner rects. This is the workhorse for
   * the greebles — a frustum has six flat faces and twelve hard creases, which
   * is exactly what the cel pipeline wants to chew on.
   */
  taperBox(z0: number, z1: number, rect0: Rect, rect1: Rect, capBack = true, capFront = true) {
    // Normalise the inputs. Mirrored greebles are written as `sign * 0.8` pairs
    // and half of them come out with x0 > x1; an unsorted rect flips the winding
    // and the box renders inside-out, which is invisible in the code and very
    // visible as a hole in the outline hull.
    if (z0 > z1) {
      const t = z0; z0 = z1; z1 = t;
      const rt = rect0; rect0 = rect1; rect1 = rt;
    }
    const r0 = sortRect(rect0);
    const r1 = sortRect(rect1);
    const A0: V3 = [r0[0], r0[2], z0], B0: V3 = [r0[1], r0[2], z0];
    const C0: V3 = [r0[1], r0[3], z0], D0: V3 = [r0[0], r0[3], z0];
    const A1: V3 = [r1[0], r1[2], z1], B1: V3 = [r1[1], r1[2], z1];
    const C1: V3 = [r1[1], r1[3], z1], D1: V3 = [r1[0], r1[3], z1];
    this.quad(B0, C0, C1, B1); // +X
    this.quad(A1, D1, D0, A0); // -X
    this.quad(D0, D1, C1, C0); // +Y
    this.quad(A1, A0, B0, B1); // -Y
    if (capFront) this.quad(A1, B1, C1, D1); // +Z
    if (capBack) this.quad(B0, A0, D0, C0); // -Z
  }

  /** Extrude a closed CCW (x, y) profile along Z. */
  prism(profile: P2[], z0: number, z1: number, capBack = true, capFront = true) {
    const n = profile.length;
    for (let j = 0; j < n; j++) {
      const p = profile[j];
      const q = profile[(j + 1) % n];
      this.quad([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
    }
    const cx = profile.reduce((s, p) => s + p[0], 0) / n;
    const cy = profile.reduce((s, p) => s + p[1], 0) / n;
    const ring0 = profile.map((p): V3 => [p[0], p[1], z0]);
    const ring1 = profile.map((p): V3 => [p[0], p[1], z1]);
    if (capBack) this.cap(ring0, [cx, cy, z0], [0, 0, -1]);
    if (capFront) this.cap(ring1, [cx, cy, z1], [0, 0, 1]);
  }

  append(other: Surface) {
    for (let i = 0; i < other.p.length; i++) this.p.push(other.p[i]);
  }

  get triangleCount() {
    return this.p.length / 9;
  }

  /**
   * Bake to a BufferGeometry with flat per-face normals. UVs are a cheap planar
   * projection — nothing samples them today, but three declares the attribute
   * unconditionally so shipping real values avoids a disabled-attrib warning.
   */
  geometry(name: string): BufferGeometry {
    const count = this.p.length / 3;
    const pos = new Float32Array(this.p);
    const nrm = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    for (let t = 0; t < count; t += 3) {
      const o = t * 3;
      const n = triNormal(
        [pos[o], pos[o + 1], pos[o + 2]],
        [pos[o + 3], pos[o + 4], pos[o + 5]],
        [pos[o + 6], pos[o + 7], pos[o + 8]],
      );
      for (let k = 0; k < 3; k++) {
        nrm[o + k * 3 + 0] = n[0];
        nrm[o + k * 3 + 1] = n[1];
        nrm[o + k * 3 + 2] = n[2];
      }
    }
    for (let i = 0; i < count; i++) {
      uv[i * 2 + 0] = pos[i * 3 + 0] * 0.5 + 0.5;
      uv[i * 2 + 1] = pos[i * 3 + 2] * 0.2 + 0.5;
    }
    const g = new BufferGeometry();
    g.name = name;
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(nrm, 3));
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

function sortRect(r: Rect): Rect {
  return [Math.min(r[0], r[1]), Math.max(r[0], r[1]), Math.min(r[2], r[3]), Math.max(r[2], r[3])];
}

function triNormal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// ─────────────────────────────────────────────────────────────────────────────
// Hull stations
// ─────────────────────────────────────────────────────────────────────────────

interface Station {
  /** Longitudinal position, metres. +Z is the bow. */
  z: number;
  /** Half-beam at the chine. */
  w: number;
  /** Keel (centreline bottom) height. Negative = below the origin plane. */
  keel: number;
  /** Chine height — the hard crease where the bottom meets the side. */
  chine: number;
  /** Sheer height — the top edge of the side, where the deck starts. */
  sheer: number;
}

/**
 * Eight control stations, stern → bow. Read the `keel` column top-to-bottom and
 * you can see the rocker: flat and deep amidships, lifting sharply forward so
 * the boat has a raked forefoot rather than a barge nose. The `sheer` column
 * rises the same way, which is what gives the profile its wedge.
 */
const CONTROL: Station[] = [
  { z: -2.32, w: 0.88, keel: -0.22, chine: -0.06, sheer: 0.20 },
  { z: -1.60, w: 0.94, keel: -0.29, chine: -0.10, sheer: 0.19 },
  { z: -0.70, w: 0.95, keel: -0.33, chine: -0.12, sheer: 0.18 },
  { z: 0.20, w: 0.90, keel: -0.32, chine: -0.11, sheer: 0.22 },
  { z: 0.90, w: 0.78, keel: -0.26, chine: -0.04, sheer: 0.34 },
  { z: 1.55, w: 0.58, keel: -0.12, chine: 0.06, sheer: 0.46 },
  { z: 2.05, w: 0.30, keel: 0.10, chine: 0.22, sheer: 0.58 },
  { z: 2.34, w: 0.05, keel: 0.34, chine: 0.40, sheer: 0.64 },
];

/** Stations the loft is actually evaluated at — denser where the eye looks. */
const STATION_Z = [
  -2.32, -2.05, -1.70, -1.32, -1.06, -0.60, -0.10, 0.35, 0.90, 1.35, 1.80, 2.10, 2.34,
];

function stationAt(z: number): Station {
  let i = 0;
  while (i < CONTROL.length - 2 && CONTROL[i + 1].z < z) i++;
  const a = CONTROL[i];
  const b = CONTROL[i + 1];
  const t = Math.max(0, Math.min(1, (z - a.z) / (b.z - a.z)));
  // Smoothstep between control stations: linear interpolation puts a visible
  // kink at every control point, which reads as a dent in the hull.
  const s = t * t * (3 - 2 * t);
  const mix = (u: number, v: number) => u + (v - u) * s;
  return {
    z,
    w: mix(a.w, b.w),
    keel: mix(a.keel, b.keel),
    chine: mix(a.chine, b.chine),
    sheer: mix(a.sheer, b.sheer),
  };
}

const DECK_CROWN = 0.055;
const RAIL_H = 0.07;
const RAIL_W = 0.055;
/**
 * Fraction of the sheer half-width the deck columns sit at. The innermost pair
 * is deliberately narrow: the first build used ±0.30 and the racing stripe
 * swallowed half the foredeck, which read as a bare metal panel rather than a
 * stripe.
 */
const DECK_COLS = [-1, -0.62, -0.32, -0.11, 0.11, 0.32, 0.62, 1];
/** Columns inside this fraction get the bright racing stripe. */
const STRIPE_HALF = 0.115;

const sheerHalf = (st: Station) => st.w * 0.985;

/**
 * Hull cross-section, port sheer → keel → starboard sheer. Eleven points:
 * the extra pair either side of the chine is the **spray rail**, a hard step
 * that both throws water outward in reality and gives us a crisp horizontal
 * crease to hang the waterline stripe off.
 */
function hullRing(st: Station): V3[] {
  const w = st.w;
  const sw = sheerHalf(st);
  const keelMid = st.keel + (st.chine - st.keel) * 0.34;
  const band = st.chine + (st.sheer - st.chine) * 0.32;
  const z = st.z;
  return [
    [-sw, st.sheer, z],
    [-w * 0.995, band, z],
    [-w, st.chine + 0.022, z],
    [-w * 0.82, st.chine, z],
    [-w * 0.42, keelMid, z],
    [0, st.keel, z],
    [w * 0.42, keelMid, z],
    [w * 0.82, st.chine, z],
    [w, st.chine + 0.022, z],
    [w * 0.995, band, z],
    [sw, st.sheer, z],
  ];
}

function deckPoint(st: Station, f: number): V3 {
  const sw = sheerHalf(st);
  return [f * sw, st.sheer + DECK_CROWN * (1 - f * f), st.z];
}

// ─────────────────────────────────────────────────────────────────────────────
// Superstructure tables
// ─────────────────────────────────────────────────────────────────────────────

/** Engine hump: the biggest silhouette mass and the boat's identity from behind. */
const COWL: { z: number; hw: number; top: number }[] = [
  { z: -1.04, hw: 0.32, top: 0.66 },
  { z: -1.30, hw: 0.46, top: 0.75 },
  { z: -1.62, hw: 0.47, top: 0.71 },
  { z: -1.92, hw: 0.42, top: 0.56 },
  { z: -2.16, hw: 0.34, top: 0.40 },
];

/** Saddle the rider straddles. Narrow waist so the legs read as legs. */
const SADDLE: { z: number; hw: number; top: number }[] = [
  { z: -1.06, hw: 0.30, top: 0.60 },
  { z: -0.80, hw: 0.335, top: 0.575 },
  { z: -0.42, hw: 0.32, top: 0.545 },
  { z: -0.05, hw: 0.25, top: 0.495 },
];

const HUMP_BASE = 0.22;

/**
 * Rounded-trapezoid cross-section used by both the cowling and the saddle.
 *
 * Nine points, not seven: the extra pair at ±0.30·hw exists purely so the
 * cowling's crown stripe can be a *stripe*. With the crown as one wide segment
 * the bright band covered 74 % of the hump and read as a white block bolted to
 * the engine.
 */
function humpRing(hw: number, top: number, z: number): V3[] {
  const h = top - HUMP_BASE;
  return [
    [-hw, HUMP_BASE, z],
    [-hw * 1.05, HUMP_BASE + h * 0.55, z],
    [-hw * 0.74, top, z],
    [-hw * 0.3, top + 0.016, z],
    [0, top + 0.022, z],
    [hw * 0.3, top + 0.016, z],
    [hw * 0.74, top, z],
    [hw * 1.05, HUMP_BASE + h * 0.55, z],
    [hw, HUMP_BASE, z],
  ];
}
/** Ring segments that carry the crown stripe. Indexes into `humpRing`. */
const CROWN_SEGMENTS = [3, 4];

// ─────────────────────────────────────────────────────────────────────────────
// Seat contract for the rider subsystem
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a rider's **hips** go, in boat-local space. The rider subsystem should
 * parent its rig root here (or read `boatMesh.seat`, an `Object3D` named
 * `"seat"` living under the boat's mesh group) rather than hard-coding an
 * offset, so re-proportioning the hull cannot silently sink the rider into the
 * deck.
 *
 * Derived, not guessed: the saddle's top surface runs 0.60 → 0.50 m over
 * z = -1.06 → -0.05, so hips at y = 0.615 puts the seat pad just under them
 * with the pelvis clear of the coaming.
 */
export const SEAT_LOCAL = new Vector3(0, 0.615, -0.46);

/** Where the rider's hands want to be — the handlebar grip centre, boat-local. */
export const GRIP_LOCAL = new Vector3(0, 0.775, -0.01);
/** Half-distance between the two grips. */
export const GRIP_HALF_WIDTH = 0.31;

export interface BoatMesh {
  group: Group;
  /** Named `"seat"`; parent a rider rig here. */
  seat: Object3D;
  /** Named `"grip"`; hands reach for this. */
  grip: Object3D;
  materials: CelMaterialSet[];
  triangles: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cel material set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `createCelMaterial` multiplies the ramp texture into the base colour, so the
 * ramp must be a *luminance* ladder or the hull hue gets squared and a
 * vermilion boat turns black in shadow (which is exactly what the first capture
 * of this scene showed). We build the ladder from palette hues — cool for the
 * shadow steps, warm for the lit steps — normalised so its brightest channel is
 * 1.0, then scaled. That keeps the shadow side reading as *sea bounce on paint*
 * rather than as dimmer paint.
 */
function normalisedHue(c: Color): Color {
  const m = Math.max(c.r, c.g, c.b) || 1;
  return c.clone().multiplyScalar(1 / m);
}
const NEUTRAL = normalisedHue(PAL.hudPaper);
/**
 * The hues are pulled most of the way back to neutral. Full-strength
 * `normalisedHue(PAL.skyMid)` is (0.07, 0.40, 1.00) and multiplying paint by
 * that does not read as "in shadow", it reads as "someone turned the red
 * channel off": the first capture had a black stripe down the shaded side of
 * the hull and a *yellow* racing stripe, because the warm hue was equally
 * extreme. A multiplicative ramp needs mostly-neutral steps with a hue *lean*.
 */
const COOL = normalisedHue(PAL.skyMid).lerp(NEUTRAL, 0.62);
const WARM = normalisedHue(PAL.sun).lerp(NEUTRAL, 0.74);

function paintRamp(): Color[] {
  return [
    COOL.clone().multiplyScalar(0.44),
    COOL.clone().multiplyScalar(0.68),
    WARM.clone().multiplyScalar(0.92),
    WARM.clone().multiplyScalar(1.0),
  ];
}
/** Terminator pushed late and hard — a wide lit band, a narrow decisive shadow. */
const PAINT_STOPS = [0.0, 0.4, 0.56, 0.82];

function makeMaterials(id: number) {
  const hullColor = RACER_COLORS[id].hull;
  const hull = createCelMaterial({
    name: `hull${id}`,
    color: hullColor,
    rampColors: paintRamp(),
    rampStops: PAINT_STOPS,
    // A glint, not a wash. The default 0.86 turned the whole boat white; 0.945
    // at strength 0.3 still washed every up-facing plane — the foredeck came out
    // pale pink and read as a bare panel rather than as paint. The spec band on
    // a cel surface has to be small enough to be a *shape*.
    specSize: 0.978,
    specSize2: 0.994,
    specStrength: 0.14,
    rimColor: PAL.skyHorizon,
    rimPower: 3.4,
    rimStrength: 0.5,
    outlineWidthPx: 5.0,
  });
  const trim = createCelMaterial({
    name: `trim${id}`,
    color: PAL.inkSoft,
    // Graphite parts need a brighter ladder or they collapse into the outline.
    rampColors: [
      COOL.clone().multiplyScalar(1.6),
      COOL.clone().multiplyScalar(2.8),
      WARM.clone().multiplyScalar(4.2),
      WARM.clone().multiplyScalar(5.2),
    ],
    rampStops: PAINT_STOPS,
    specSize: 0.965,
    specSize2: 0.992,
    specStrength: 0.34,
    rimColor: PAL.skyHorizon,
    rimPower: 2.6,
    rimStrength: 0.9,
    outlineWidthPx: 3.4,
  });
  const bright = createCelMaterial({
    name: `bright${id}`,
    color: PAL.hudPaper,
    rampColors: [
      COOL.clone().multiplyScalar(0.56),
      COOL.clone().multiplyScalar(0.76),
      WARM.clone().multiplyScalar(0.94),
      WARM.clone().multiplyScalar(1.0),
    ],
    rampStops: PAINT_STOPS,
    specSize: 0.975,
    specSize2: 0.993,
    specStrength: 0.1,
    rimColor: PAL.waterShallow,
    rimPower: 3.0,
    rimStrength: 0.4,
    outlineWidthPx: 3.4,
  });
  return { hull, trim, bright };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

export function createBoatMesh(id: number): BoatMesh {
  const HULL = new Surface();
  const TRIM = new Surface();
  const BRIGHT = new Surface();

  const stations = STATION_Z.map(stationAt);
  const rings = stations.map(hullRing);
  const nStations = stations.length;

  // ── Hull shell ────────────────────────────────────────────────────────────
  // Ten longitudinal strips per segment. Strips 1 and 8 are the low side band
  // just above the spray rail; they go to the bright material and become a
  // waterline stripe that runs the full length of the boat. That single stripe
  // does more for reading the hull's sheer line than any amount of shading.
  for (let i = 0; i < nStations - 1; i++) {
    const A = rings[i];
    const B = rings[i + 1];
    for (let j = 0; j < 10; j++) {
      const target = j === 1 || j === 8 ? BRIGHT : HULL;
      target.quad(A[j], A[j + 1], B[j + 1], B[j]);
    }
  }

  // Transom: a full polygon from sheer to sheer, closed across the top so the
  // deck's aft edge and the shell meet with no gap for the outline to leak
  // through.
  {
    const st = stations[0];
    const r = rings[0];
    HULL.cap(r, [0, (st.keel + st.sheer) * 0.5, st.z], [0, 0, -1], true);
  }
  // Bow: the last station is nearly a point, so this is a sliver.
  {
    const st = stations[nStations - 1];
    const r = rings[nStations - 1];
    HULL.cap(r, [0, (st.keel + st.sheer) * 0.5, st.z], [0, 0, 1], true);
  }

  // ── Deck ──────────────────────────────────────────────────────────────────
  // Six columns per segment. The two central columns forward of the cockpit are
  // bright: that is the racing stripe, and it is the single strongest cue that
  // tells you which way a boat 60 m away is pointing.
  const STRIPE_FROM_Z = 0.3;
  for (let i = 0; i < nStations - 1; i++) {
    const sa = stations[i];
    const sb = stations[i + 1];
    const stripe = sa.z >= STRIPE_FROM_Z;
    for (let j = 0; j < DECK_COLS.length - 1; j++) {
      const f0 = DECK_COLS[j];
      const f1 = DECK_COLS[j + 1];
      const central = Math.abs(f0) <= STRIPE_HALF && Math.abs(f1) <= STRIPE_HALF;
      const target = stripe && central ? BRIGHT : HULL;
      target.quad(deckPoint(sa, f0), deckPoint(sb, f0), deckPoint(sb, f1), deckPoint(sa, f1));
    }
  }

  // ── Gunwale rail ──────────────────────────────────────────────────────────
  // A 7 cm bead following the sheer from transom to bow, in the dark trim. It
  // reads as a drawn line at any distance and it thickens the silhouette edge,
  // which is what stops the boat looking like folded paper.
  for (const sign of [-1, 1]) {
    for (let i = 0; i < nStations - 1; i++) {
      const sa = stations[i];
      const sb = stations[i + 1];
      const swa = sheerHalf(sa);
      const swb = sheerHalf(sb);
      const ta = sa.sheer + RAIL_H;
      const tb = sb.sheer + RAIL_H;
      const wa = Math.min(RAIL_W, swa * 0.5);
      const wb = Math.min(RAIL_W, swb * 0.5);
      // outer face
      TRIM.quadMirrored(sign, [swa, sa.sheer, sa.z], [swa, ta, sa.z], [swb, tb, sb.z], [swb, sb.sheer, sb.z]);
      // top face
      TRIM.quadMirrored(sign, [swa, ta, sa.z], [swa - wa, ta, sa.z], [swb - wb, tb, sb.z], [swb, tb, sb.z]);
      // inner face, down onto the deck
      TRIM.quadMirrored(
        sign,
        [swa - wa, ta, sa.z],
        [swa - wa, deckPoint(sa, (swa - wa) / swa)[1], sa.z],
        [swb - wb, deckPoint(sb, (swb - wb) / swb)[1], sb.z],
        [swb - wb, tb, sb.z],
      );
    }
    // Close the rail's ends so the inverted hull has no aperture.
    for (const idx of [0, nStations - 1]) {
      const st = stations[idx];
      const sw = sheerHalf(st);
      const w = Math.min(RAIL_W, sw * 0.5);
      const t = st.sheer + RAIL_H;
      const inner = deckPoint(st, (sw - w) / sw)[1];
      const zFace = idx === 0 ? st.z - 0.001 : st.z + 0.001;
      TRIM.quadMirrored(
        sign,
        [sw, st.sheer, zFace],
        [sw, t, zFace],
        [sw - w, t, zFace],
        [sw - w, inner, zFace],
      );
    }
  }

  // ── Engine cowling ────────────────────────────────────────────────────────
  {
    const cowlRings = COWL.map((c) => humpRing(c.hw, c.top, c.z));
    for (let i = 0; i < cowlRings.length - 1; i++) {
      const A = cowlRings[i];
      const B = cowlRings[i + 1];
      for (let j = 0; j < A.length - 1; j++) {
        // Segments 2 and 3 are the crown. Running the racing stripe over them
        // gives the boat a readable graphic from directly behind, which is the
        // angle the player spends most of the race looking at a rival from.
        //
        // COWL is listed forward → aft (z decreasing). `humpRing` runs
        // port-bottom over the crown to starboard-bottom, and with the ring pair
        // going aft the default winding is already outboard. Getting this
        // backwards is not a subtle bug: the shell vanishes behind backface
        // culling and the *outline* hull shows through instead, so the cowling
        // renders as a solid ink blob — which is exactly how it looked in the
        // first capture of this file.
        const target = CROWN_SEGMENTS.includes(j) ? BRIGHT : HULL;
        target.quad(A[j], A[j + 1], B[j + 1], B[j]);
      }
    }
    const front = COWL[0];
    const back = COWL[COWL.length - 1];
    HULL.cap(cowlRings[0], [0, (HUMP_BASE + front.top) * 0.5, front.z], [0, 0, 1], true);
    HULL.cap(
      cowlRings[cowlRings.length - 1],
      [0, (HUMP_BASE + back.top) * 0.5, back.z],
      [0, 0, -1],
      true,
    );
    // Floor, so the shell is closed where it meets the deck.
    HULL.quad(
      [-front.hw, HUMP_BASE, front.z],
      [-back.hw, HUMP_BASE, back.z],
      [back.hw, HUMP_BASE, back.z],
      [front.hw, HUMP_BASE, front.z],
    );

    // Air intake: a forward-facing scoop on the crown. Dark mouth, hard lip.
    TRIM.taperBox(-1.66, -1.24, [-0.2, 0.2, 0.7, 0.795], [-0.155, 0.155, 0.66, 0.83]);
    TRIM.box(-1.235, -1.19, -0.15, 0.15, 0.6, 0.82);
  }

  // ── Saddle ────────────────────────────────────────────────────────────────
  {
    const saddleRings = SADDLE.map((c) => humpRing(c.hw, c.top, c.z));
    for (let i = 0; i < saddleRings.length - 1; i++) {
      TRIM.loft(saddleRings[i], saddleRings[i + 1], true);
    }
    const back = SADDLE[0];
    const front = SADDLE[SADDLE.length - 1];
    TRIM.cap(saddleRings[0], [0, (HUMP_BASE + back.top) * 0.5, back.z], [0, 0, -1], true);
    TRIM.cap(
      saddleRings[saddleRings.length - 1],
      [0, (HUMP_BASE + front.top) * 0.5, front.z],
      [0, 0, 1],
      true,
    );
    TRIM.quad(
      [-back.hw, HUMP_BASE, back.z],
      [back.hw, HUMP_BASE, back.z],
      [front.hw, HUMP_BASE, front.z],
      [-front.hw, HUMP_BASE, front.z],
    );
    // Seat pad — bright, so the rider reads as sitting *on* something.
    BRIGHT.taperBox(-1.0, -0.2, [-0.245, 0.245, 0.575, 0.605], [-0.205, 0.205, 0.52, 0.55]);
  }

  // ── Footboards ────────────────────────────────────────────────────────────
  // Flat trim plates either side of the saddle. Not a modelled recess — at the
  // distances this game is played at, the tonal break does the work and the
  // Sobel pass inks the material boundary for free.
  for (const sign of [-1, 1]) {
    const zs = [-0.85, -0.5, -0.1, 0.3];
    for (let i = 0; i < zs.length - 1; i++) {
      const sa = stationAt(zs[i]);
      const sb = stationAt(zs[i + 1]);
      const lift = 0.008;
      const inner = 0.34, outer = 0.78;
      const p = (st: Station, f: number): V3 => {
        const d = deckPoint(st, f);
        return [d[0], d[1] + lift, d[2]];
      };
      TRIM.quadMirrored(sign, p(sa, inner), p(sb, inner), p(sb, outer), p(sa, outer));
    }
  }

  // ── Handlebar column, bar, windscreen ─────────────────────────────────────
  // The column leans back off the foredeck to meet the bar, which sits where
  // GRIP_LOCAL says the rider's hands are. A vertical post at the wrong z looks
  // like a bollard and gives the rider nothing to hold.
  TRIM.taperBox(-0.02, 0.34, [-0.055, 0.055, 0.7, 0.79], [-0.085, 0.085, 0.22, 0.3]);
  TRIM.box(-0.35, 0.35, 0.757, 0.793, -0.042, 0.006);
  for (const sign of [-1, 1]) {
    BRIGHT.box(sign * 0.235, sign * 0.352, 0.748, 0.802, -0.058, 0.022);
  }
  // Raked windscreen: a pale wedge leaning back over the handlebar, tall enough
  // that the rider's helmet sits *behind* something. It is the second-strongest
  // silhouette event after the engine hump, and it tells you instantly which end
  // of the boat is the front.
  BRIGHT.taperBox(0.16, 0.6, [-0.255, 0.255, 0.775, 0.845], [-0.33, 0.33, 0.29, 0.355]);

  // ── Wing and tail fin ─────────────────────────────────────────────────────
  // Two attempts got binned here. A wing as wide as the beam read as a swim
  // platform; adding pale end plates turned it into a grey table with white
  // legs. What actually works is a narrow dark wing plus a *vertical* fin in the
  // racer's own colour: the fin adds 25 cm of height to the silhouette without
  // adding any width, and it is the single element that survives at 100 m.
  TRIM.taperBox(-2.44, -2.14, [-0.5, 0.5, 0.805, 0.85], [-0.45, 0.45, 0.835, 0.88]);
  HULL.taperBox(-2.4, -2.0, [-0.05, 0.05, 0.83, 1.14], [-0.042, 0.042, 0.8, 0.92]);
  for (const sign of [-1, 1]) {
    // Struts down to the cowling crown.
    const sx0 = sign * 0.2;
    const sx1 = sign * 0.28;
    TRIM.taperBox(-2.36, -2.2, [sx0, sx1, 0.36, 0.82], [sx0, sx1, 0.42, 0.85]);
  }

  // ── Nose spike ────────────────────────────────────────────────────────────
  // Must straddle the bow's sheer/keel band (0.34 → 0.64 at z = 2.34) or it
  // sits *inside* the hull and contributes nothing to the silhouette.
  TRIM.taperBox(2.2, 2.54, [-0.085, 0.085, 0.3, 0.66], [-0.02, 0.02, 0.47, 0.51]);

  // ── Fin, skeg, exhausts ───────────────────────────────────────────────────
  BRIGHT.box(-0.62, 0.62, -0.06, 0.065, -2.4, -2.33);
  TRIM.taperBox(-2.34, -1.66, [-0.048, 0.048, -0.62, -0.18], [-0.04, 0.04, -0.3, -0.2]);
  TRIM.box(-0.24, 0.24, -0.63, -0.575, -2.28, -2.0);
  for (const sign of [-1, 1]) {
    TRIM.box(sign * 0.2, sign * 0.34, 0.115, 0.235, -2.44, -2.3);
  }

  // ── Bake ──────────────────────────────────────────────────────────────────
  const mats = makeMaterials(id);
  const group = new Group();
  group.name = `boatMesh${id}`;

  const parts: [Surface, CelMaterialSet, string][] = [
    [HULL, mats.hull, 'hullShell'],
    [TRIM, mats.trim, 'hullTrim'],
    [BRIGHT, mats.bright, 'hullBright'],
  ];
  let triangles = 0;
  for (const [surf, set, name] of parts) {
    const mesh = new Mesh(surf.geometry(`${name}${id}`));
    mesh.name = `${name}${id}`;
    applyCel(mesh, set);
    group.add(mesh);
    triangles += surf.triangleCount;
  }

  const seat = new Object3D();
  seat.name = 'seat';
  seat.position.copy(SEAT_LOCAL);
  group.add(seat);

  const grip = new Object3D();
  grip.name = 'grip';
  grip.position.copy(GRIP_LOCAL);
  group.add(grip);

  return {
    group,
    seat,
    grip,
    materials: [mats.hull, mats.trim, mats.bright],
    triangles,
  };
}
