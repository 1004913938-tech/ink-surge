/**
 * Local progress save — unlocks, coins, best times, career medals.
 */

import { BOAT_PROFILES, LIVERIES, type BoatClass } from './catalog';

export type Medal = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum';

export interface SaveData {
  version: 1;
  coins: number;
  unlockedBoats: BoatClass[];
  unlockedLiveries: string[];
  selectedBoat: BoatClass;
  selectedLivery: string;
  /** eventId → best medal */
  medals: Record<string, Medal>;
  /** trackId → best finish time (seconds) for time trial */
  bestTimes: Record<string, number>;
  /** Highest career event index cleared in cup (exclusive upper bound). */
  careerProgress: Record<string, number>;
  tutorialDriftDone: boolean;
  tutorialAirDone: boolean;
}

const KEY = 'ink-surge-save-v1';

const MEDAL_RANK: Record<Medal, number> = {
  none: 0,
  bronze: 1,
  silver: 2,
  gold: 3,
  platinum: 4,
};

function fresh(): SaveData {
  return {
    version: 1,
    coins: 0,
    unlockedBoats: (Object.values(BOAT_PROFILES) as typeof BOAT_PROFILES[BoatClass][])
      .filter((b) => b.unlockedByDefault)
      .map((b) => b.id),
    unlockedLiveries: LIVERIES.filter((l) => l.unlockedByDefault).map((l) => l.id),
    selectedBoat: 'balanced',
    selectedLivery: 'vermilion',
    medals: {},
    bestTimes: {},
    careerProgress: { noviceCup: 1 },
    tutorialDriftDone: false,
    tutorialAirDone: false,
  };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw) as SaveData;
    if (parsed.version !== 1) return fresh();
    return { ...fresh(), ...parsed, version: 1 };
  } catch {
    return fresh();
  }
}

export function writeSave(data: SaveData) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function medalBetter(a: Medal, b: Medal): boolean {
  return MEDAL_RANK[a] > MEDAL_RANK[b];
}

export function recordMedal(save: SaveData, eventId: string, medal: Medal): boolean {
  const prev = save.medals[eventId] ?? 'none';
  if (!medalBetter(medal, prev) && medal !== prev) {
    if (MEDAL_RANK[medal] <= MEDAL_RANK[prev]) return false;
  }
  if (MEDAL_RANK[medal] > MEDAL_RANK[prev]) {
    save.medals[eventId] = medal;
    return true;
  }
  if (prev === 'none' && medal !== 'none') {
    save.medals[eventId] = medal;
    return true;
  }
  return false;
}
