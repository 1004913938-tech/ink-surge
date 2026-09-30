/**
 * Mutable per-race overrides. Subsystems read these instead of baking
 * CONFIG.race.laps / sea state into a single global forever.
 */

import { BOAT_PROFILES, type BoatClass, type BoatProfile } from '../meta/catalog';
import { defaultSession, type RaceSession } from '../meta/session';

export const ACTIVE: {
  session: RaceSession;
  profile: BoatProfile;
} = {
  session: defaultSession(),
  profile: BOAT_PROFILES.balanced,
};

export function applySession(session: RaceSession) {
  ACTIVE.session = session;
  ACTIVE.profile = BOAT_PROFILES[session.boatClass as BoatClass] ?? BOAT_PROFILES.balanced;
}

export function activeLaps(): number {
  return ACTIVE.session.laps;
}

export function activeRacerCount(): number {
  return ACTIVE.session.racerCount;
}

export function isSwellRun(): boolean {
  return ACTIVE.session.eventKind === 'swellRun';
}

export function activeDurationSec(): number {
  return ACTIVE.session.durationSec ?? 75;
}
