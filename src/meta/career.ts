/**
 * Career cup table, event rules, and medal thresholds.
 */

import type { Medal } from './save';

export type EventKind = 'standard' | 'timeTrial' | 'elimination' | 'swellRun';

export interface EventRules {
  laps: number;
  racerCount: number;
  /** Override track sea state; falls back to TrackDef.theme.seaState. */
  seaState?: number;
  /** Swell Run: timed session length, seconds. */
  durationSec?: number;
}

export interface CareerEvent {
  id: string;
  name: string;
  kind: EventKind;
  trackId: string;
  rules: EventRules;
  /** Place required for each medal (1 = win). Time trial uses finish time instead. */
  placeBronze: number;
  placeSilver: number;
  placeGold: number;
  /** Optional finish-time ceiling for platinum on race events (seconds). */
  platinumTime?: number;
  /** Time trial targets (seconds). */
  timeBronze?: number;
  timeSilver?: number;
  timeGold?: number;
  timePlatinum?: number;
  /**
   * Swell Run score thresholds — cumulative airborne seconds.
   * Higher score is better.
   */
  scoreBronze?: number;
  scoreSilver?: number;
  scoreGold?: number;
  scorePlatinum?: number;
  reward: { bronze: number; silver: number; gold: number; platinum: number };
  unlockBoat?: 'speed' | 'grip';
}

export interface CareerCup {
  id: string;
  name: string;
  blurb: string;
  events: CareerEvent[];
}

export const NOVICE_CUP: CareerCup = {
  id: 'noviceCup',
  name: 'NOVICE BAY CUP',
  blurb: 'Learn the drift boost. Take the swell. Finish on the podium.',
  events: [
    {
      id: 'novice-1',
      name: 'OPENING HEAT',
      kind: 'standard',
      trackId: 'noviceBay',
      rules: { laps: 3, racerCount: 4 },
      placeBronze: 3,
      placeSilver: 2,
      placeGold: 1,
      platinumTime: 210,
      reward: { bronze: 80, silver: 140, gold: 220, platinum: 320 },
    },
    {
      id: 'novice-2',
      name: 'BUOY SCRAMBLE',
      kind: 'standard',
      trackId: 'stormAtoll',
      rules: { laps: 3, racerCount: 4, seaState: 1.15 },
      placeBronze: 3,
      placeSilver: 2,
      placeGold: 1,
      platinumTime: 200,
      reward: { bronze: 100, silver: 160, gold: 250, platinum: 360 },
      unlockBoat: 'grip',
    },
    {
      id: 'novice-3',
      name: 'SWELL RUN',
      kind: 'swellRun',
      trackId: 'noviceBay',
      rules: { laps: 0, racerCount: 1, seaState: 1.28, durationSec: 75 },
      placeBronze: 99,
      placeSilver: 99,
      placeGold: 99,
      // Cumulative airborne seconds in 75s.
      // Tuned for latched `airborne` (not micro-hops): bronze = a few real jumps,
      // gold = consistent swell-line runs, platinum = near-constant crest farming.
      scoreBronze: 4.0,
      scoreSilver: 7.5,
      scoreGold: 11.5,
      scorePlatinum: 15.5,
      reward: { bronze: 100, silver: 170, gold: 260, platinum: 380 },
    },
    {
      id: 'novice-4',
      name: 'LAST BUOY STANDING',
      kind: 'elimination',
      trackId: 'noviceReverse',
      rules: { laps: 3, racerCount: 4, seaState: 1.1 },
      placeBronze: 2,
      placeSilver: 1,
      placeGold: 1,
      platinumTime: 205,
      reward: { bronze: 120, silver: 200, gold: 300, platinum: 420 },
      unlockBoat: 'speed',
    },
  ],
};

export const CAREER_CUPS: CareerCup[] = [NOVICE_CUP];

export function getCup(id: string): CareerCup {
  return CAREER_CUPS.find((c) => c.id === id) ?? NOVICE_CUP;
}

export function getEvent(eventId: string): CareerEvent | undefined {
  for (const cup of CAREER_CUPS) {
    const e = cup.events.find((x) => x.id === eventId);
    if (e) return e;
  }
  return undefined;
}

export function rateEvent(
  event: CareerEvent,
  place: number,
  finishTime: number,
  score = 0,
): Medal {
  if (event.kind === 'swellRun') {
    if (event.scorePlatinum != null && score >= event.scorePlatinum) return 'platinum';
    if (event.scoreGold != null && score >= event.scoreGold) return 'gold';
    if (event.scoreSilver != null && score >= event.scoreSilver) return 'silver';
    if (event.scoreBronze != null && score >= event.scoreBronze) return 'bronze';
    return 'none';
  }
  if (event.kind === 'timeTrial') {
    if (event.timePlatinum != null && finishTime <= event.timePlatinum) return 'platinum';
    if (event.timeGold != null && finishTime <= event.timeGold) return 'gold';
    if (event.timeSilver != null && finishTime <= event.timeSilver) return 'silver';
    if (event.timeBronze != null && finishTime <= event.timeBronze) return 'bronze';
    return 'none';
  }
  let medal: Medal = 'none';
  if (place <= event.placeBronze) medal = 'bronze';
  if (place <= event.placeSilver) medal = 'silver';
  if (place <= event.placeGold) medal = 'gold';
  if (medal === 'gold' && event.platinumTime != null && finishTime <= event.platinumTime) {
    medal = 'platinum';
  }
  return medal;
}

/** Rate a swell-run score against session thresholds (quick mode). */
export function rateSwellScore(
  score: number,
  thresholds: { bronze: number; silver: number; gold: number; platinum: number },
): Medal {
  if (score >= thresholds.platinum) return 'platinum';
  if (score >= thresholds.gold) return 'gold';
  if (score >= thresholds.silver) return 'silver';
  if (score >= thresholds.bronze) return 'bronze';
  return 'none';
}
