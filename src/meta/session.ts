/**
 * Active race session — what the next (or current) race is running under.
 */

import type { EventKind } from './career';
import type { BoatClass } from './catalog';

export type PlayMode = 'career' | 'quick' | 'trial';

export interface RaceSession {
  mode: PlayMode;
  trackId: string;
  laps: number;
  racerCount: number;
  seaState: number;
  boatClass: BoatClass;
  liveryId: string;
  eventId?: string;
  eventKind: EventKind;
  cupId?: string;
  /** Career event index within cup, for "next race" flow. */
  eventIndex?: number;
  /** Swell Run duration, seconds. */
  durationSec?: number;
  /** Swell Run medal thresholds (cumulative air seconds). */
  scoreBronze?: number;
  scoreSilver?: number;
  scoreGold?: number;
  scorePlatinum?: number;
}

export function defaultSession(): RaceSession {
  return {
    mode: 'quick',
    trackId: 'noviceBay',
    laps: 3,
    racerCount: 4,
    seaState: 1,
    boatClass: 'balanced',
    liveryId: 'vermilion',
    eventKind: 'standard',
  };
}

/** Standalone Swell Run defaults (Quick can also launch this). */
export function defaultSwellSession(
  boatClass: BoatClass = 'balanced',
  liveryId = 'vermilion',
): RaceSession {
  return {
    mode: 'quick',
    trackId: 'noviceBay',
    laps: 0,
    racerCount: 1,
    seaState: 1.28,
    boatClass,
    liveryId,
    eventKind: 'swellRun',
    durationSec: 75,
    scoreBronze: 4.0,
    scoreSilver: 7.5,
    scoreGold: 11.5,
    scorePlatinum: 15.5,
  };
}
