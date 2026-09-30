/**
 * Boat / livery catalog — the garage shelf.
 *
 * Handling differences are three scalars applied on top of CONFIG.boat so the
 * physics solver stays one code path.
 */

export type BoatClass = 'balanced' | 'speed' | 'grip';

export interface BoatProfile {
  id: BoatClass;
  name: string;
  blurb: string;
  /** Multiplies topSpeed / boostTopSpeed. */
  topSpeed: number;
  /** Multiplies turnRateLow / turnRateHigh. */
  turnRate: number;
  /** Multiplies drift charge rate (tier times shorten when > 1). */
  boostCharge: number;
  /** Multiplies thrust. */
  thrust: number;
  unlockCost: number;
  /** Starting unlock. */
  unlockedByDefault: boolean;
}

export interface Livery {
  id: string;
  name: string;
  boatClass: BoatClass;
  /** Index into HEX.hull* palette slot override — 0 = player vermilion family. */
  hullSlot: 0 | 1 | 2 | 3;
  unlockCost: number;
  unlockedByDefault: boolean;
}

export const BOAT_PROFILES: Record<BoatClass, BoatProfile> = {
  balanced: {
    id: 'balanced',
    name: 'REEF RUNNER',
    blurb: 'Even pace. Learn the ocean on this hull.',
    topSpeed: 1.0,
    turnRate: 1.0,
    boostCharge: 1.0,
    thrust: 1.0,
    unlockCost: 0,
    unlockedByDefault: true,
  },
  speed: {
    id: 'speed',
    name: 'SPINE CUTTER',
    blurb: 'Straight-line rocket. Asks for earlier brakes.',
    topSpeed: 1.08,
    turnRate: 0.9,
    boostCharge: 0.95,
    thrust: 1.1,
    unlockCost: 800,
    unlockedByDefault: false,
  },
  grip: {
    id: 'grip',
    name: 'BUOY DANCER',
    blurb: 'Tight turns, quick boost charge, lower top end.',
    topSpeed: 0.94,
    turnRate: 1.14,
    boostCharge: 1.18,
    thrust: 0.96,
    unlockCost: 600,
    unlockedByDefault: false,
  },
};

export const LIVERIES: Livery[] = [
  { id: 'vermilion', name: 'VERMILION', boatClass: 'balanced', hullSlot: 0, unlockCost: 0, unlockedByDefault: true },
  { id: 'sunbar', name: 'SUNBAR', boatClass: 'balanced', hullSlot: 1, unlockCost: 300, unlockedByDefault: false },
  { id: 'violet', name: 'VIOLET RUN', boatClass: 'speed', hullSlot: 2, unlockCost: 0, unlockedByDefault: true },
  { id: 'aqua', name: 'AQUA EDGE', boatClass: 'grip', hullSlot: 3, unlockCost: 0, unlockedByDefault: true },
  { id: 'ember', name: 'EMBER', boatClass: 'speed', hullSlot: 0, unlockCost: 450, unlockedByDefault: false },
  { id: 'foam', name: 'FOAMLINE', boatClass: 'grip', hullSlot: 1, unlockCost: 450, unlockedByDefault: false },
];

export function defaultLiveryFor(boat: BoatClass): string {
  return LIVERIES.find((l) => l.boatClass === boat && l.unlockedByDefault)?.id ?? 'vermilion';
}
