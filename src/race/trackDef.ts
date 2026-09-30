/**
 * Data-driven circuit definitions.
 *
 * Geometry is authored as a closed polygon of vertices [x, z, filletRadius],
 * then scaled by `layoutScale`. Fillet radii are NOT scaled — they are tied to
 * the boat turning circle (see track.ts).
 */

export interface TrackLayout {
  /** Polygon vertices [x, z, filletRadiusMetres], travel order. */
  verts: readonly (readonly [number, number, number])[];
  /** Scales XZ only. */
  layoutScale: number;
  /** Start/finish offset along the first straight after V0 fillet, metres. */
  startS: number;
}

export interface TrackTheme {
  /** Multiplier on the shared Gerstner sea state (1 = default). */
  seaState: number;
  /** Optional label for sky/fog packs — reserved for V1 themes. */
  skyPreset: 'day' | 'storm' | 'dusk';
}

export interface TrackDef {
  id: string;
  name: string;
  blurb: string;
  layout: TrackLayout;
  theme: TrackTheme;
  /** When true, verts are stored in reverse travel order already. */
  reverse?: boolean;
}

/** Original Ink Tide circuit — Novice Bay. */
export const TRACK_NOVICE_BAY: TrackDef = {
  id: 'noviceBay',
  name: 'NOVICE BAY',
  blurb: 'Wide sweepers, one hairpin, a head-sea launch straight.',
  layout: {
    layoutScale: 0.7,
    startS: 88,
    verts: [
      [0, 0, 11],
      [0, 300, 90],
      [170, 400, 70],
      [330, 330, 45],
      [360, 180, 16],
      [270, 120, 17],
      [300, 10, 13],
      [100, -80, 120],
      [-160, -160, 55],
      [-300, 0, 60],
      [-180, 200, 17],
    ],
  },
  theme: { seaState: 1.0, skyPreset: 'day' },
};

/**
 * Tighter, more technical loop — Storm Atoll.
 * Smaller scale + tighter fillets → more braking corners.
 */
export const TRACK_STORM_ATOLL: TrackDef = {
  id: 'stormAtoll',
  name: 'STORM ATOLL',
  blurb: 'Narrow buoys, stacked chicanes, angry chop.',
  layout: {
    layoutScale: 0.62,
    startS: 72,
    verts: [
      [0, 0, 12],
      [40, 260, 55],
      [200, 340, 22],
      [320, 260, 18],
      [300, 120, 14],
      [180, 40, 16],
      [220, -60, 20],
      [60, -140, 70],
      [-140, -100, 18],
      [-260, 40, 40],
      [-200, 180, 15],
      [-80, 220, 50],
    ],
  },
  theme: { seaState: 1.22, skyPreset: 'storm' },
};

/** Reverse of Novice Bay — same geometry, opposite travel. */
export const TRACK_NOVICE_REVERSE: TrackDef = {
  id: 'noviceReverse',
  name: 'NOVICE BAY R',
  blurb: 'Same island, mirrored line. Hairpin now opens the lap.',
  layout: {
    layoutScale: TRACK_NOVICE_BAY.layout.layoutScale,
    startS: 88,
    verts: [...TRACK_NOVICE_BAY.layout.verts].reverse().map(([x, z, r]) => [x, z, r] as const),
  },
  theme: { seaState: 1.05, skyPreset: 'dusk' },
  reverse: true,
};

export const TRACK_CATALOG: Record<string, TrackDef> = {
  [TRACK_NOVICE_BAY.id]: TRACK_NOVICE_BAY,
  [TRACK_STORM_ATOLL.id]: TRACK_STORM_ATOLL,
  [TRACK_NOVICE_REVERSE.id]: TRACK_NOVICE_REVERSE,
};

export const TRACK_LIST = [TRACK_NOVICE_BAY, TRACK_STORM_ATOLL, TRACK_NOVICE_REVERSE];

export function getTrackDef(id: string): TrackDef {
  return TRACK_CATALOG[id] ?? TRACK_NOVICE_BAY;
}
