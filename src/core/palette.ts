/**
 * INK TIDE — committed palette.
 *
 * One palette, used by every subsystem: water, sky, hulls, riders, ink, HUD.
 * High-saturation, limited, deliberately anime. Nothing here is "physically
 * plausible" — these are picked by eye for readability at speed.
 *
 * Rule for contributors: never hand-author a colour literal in a subsystem.
 * If you need a new tone, add it here so the whole game stays one piece of art.
 */
import { Color } from 'three';

/** Hex helper — keeps the table below readable. */
const c = (hex: number) => new Color(hex).convertSRGBToLinear();
/** Raw sRGB hex, for canvas-2D HUD work where we need CSS strings. */
export const css = (hex: number) => '#' + hex.toString(16).padStart(6, '0');

// ─────────────────────────────────────────────────────────────────────────────
// Raw hex table. Keep this as the single source of truth; the Color exports
// below are just linear-space conveniences for materials.
// ─────────────────────────────────────────────────────────────────────────────
export const HEX = {
  // Ink — every outline, every HUD stroke. A deep blue-black, never pure black:
  // pure black reads as a hole in a cel image, this reads as brushed ink.
  ink: 0x0a1a2e,
  inkSoft: 0x17324f,

  // Water bands, deep → crest. Hard steps between these, never a gradient.
  waterDeep: 0x0b2f6e,
  waterMid: 0x1667c8,
  waterShallow: 0x35a8e8,
  waterCrest: 0x7fe0f5,
  waterSss: 0x2fd6c0, // back-lit translucency pushed through thin crests

  // Foam / spray. Slightly blue-white so it sits in the palette.
  foam: 0xf2fbff,
  foamShade: 0xc2e4f5,

  // Sky dome, zenith → horizon.
  skyZenith: 0x12489e,
  skyMid: 0x3d97e0,
  skyHorizon: 0xa8e8ff,
  skyHaze: 0xd9f4ff,

  // Sun + its graphic flare.
  sun: 0xfff6c2,
  sunCore: 0xffffff,
  sunFlare: 0xffd86b,

  // Clouds — flat fill, hard rim, two tones only.
  cloudLit: 0xffffff,
  cloudShade: 0xb9d8f2,

  // Course furniture.
  raceLine: 0x3cff9e,
  raceLineGlow: 0xa8ffd4,
  gate: 0x2ae8c4,
  gateFar: 0xff3d8b,
  buoy: 0xffd23c,

  // Racer hull identity colours. Index 0 is always the player.
  hull0: 0xff4f3d, // player — vermilion
  hull1: 0xffc93c, // yellow
  hull2: 0x7b4dff, // violet
  hull3: 0x2ae8c4, // aqua

  // Rider clothing accents, paired with the hulls above.
  suit0: 0x2b3a6b,
  suit1: 0x3a2b5f,
  suit2: 0x1f3f5c,
  suit3: 0x243d3a,
  skin: 0xffcfa8,
  skinShade: 0xe0a074,

  // UI / feedback.
  boost: 0xff3d8b,
  boostHot: 0xfff06b,
  warn: 0xff5a5a,
  hudInk: 0x081426,
  hudPaper: 0xf2fbff,
  hudDim: 0x6f96b8,
} as const;

export type PaletteKey = keyof typeof HEX;

/** Linear-space Colors for use in materials and uniforms. */
export const PAL = Object.fromEntries(
  Object.entries(HEX).map(([k, v]) => [k, c(v)]),
) as Record<PaletteKey, Color>;

/** Per-racer colour sets, indexed by racer id (0 = player). */
export const RACER_COLORS = [
  { hull: PAL.hull0, suit: PAL.suit0, hex: HEX.hull0 },
  { hull: PAL.hull1, suit: PAL.suit1, hex: HEX.hull1 },
  { hull: PAL.hull2, suit: PAL.suit2, hex: HEX.hull2 },
  { hull: PAL.hull3, suit: PAL.suit3, hex: HEX.hull3 },
];

/**
 * Direction the key light comes from (world space, pointing *from* the sun).
 * Shared by every cel material so the terminator line is consistent across the
 * whole scene — inconsistent light direction is the fastest way to break a
 * flat-shaded look.
 */
export const SUN_DIR = { x: -0.42, y: 0.66, z: 0.62 };
