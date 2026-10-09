import { resolveStaffActor } from '@cds/auth';
import type { Db } from '@cds/db';
import type { ServiceContext } from '@cds/domain';
import type { Seed } from './seed';

export type StaffKey = keyof Seed['staff'];

/** A service context for a seeded staff member, resolved through the real membership lookup. */
export async function contextFor(db: Db, seed: Seed, who: StaffKey, clock?: () => Date): Promise<ServiceContext> {
  const actor = await resolveStaffActor(db, seed.staff[who].authUserId, seed.organisationId);
  return { db, actor, now: clock, requestId: `test-${who}` };
}

/** A controllable clock for deterministic tests. */
export function testClock(startIso: string) {
  let t = new Date(startIso).getTime();
  const clock = () => new Date(t);
  clock.set = (iso: string) => {
    t = new Date(iso).getTime();
  };
  clock.advanceMinutes = (m: number) => {
    t += m * 60_000;
  };
  return clock;
}
