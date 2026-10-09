import { afterAll, beforeAll } from 'vitest';
import { createTestDatabase, contextFor, seedSyntheticOrganisation, testClock, type Seed, type StaffKey, type TestDatabase } from '@cds/test-fixtures';
import { captureSource, createOrder, decideAcceptance, type ServiceContext } from '@cds/domain';
import type { LineInput } from '@cds/contracts';

export type World = {
  tdb: TestDatabase;
  seed: Seed;
  clock: ReturnType<typeof testClock>;
  as(who: StaffKey): Promise<ServiceContext>;
};

/** One isolated database + synthetic organisation per test file. */
export function useWorld(startIso = '2026-10-09T17:00:00Z'): World {
  const world = {} as World;
  beforeAll(async () => {
    world.tdb = await createTestDatabase();
    world.seed = await seedSyntheticOrganisation(world.tdb.ownerDb);
    world.clock = testClock(startIso);
    world.as = (who) => contextFor(world.tdb.appDb, world.seed, who, world.clock);
  });
  afterAll(async () => {
    await world.tdb?.drop();
  });
  return world;
}

export async function source(ctx: ServiceContext, seed: Seed, text: string, receivedAt = '2026-10-09T16:48:00+01:00', kind: 'pasted_message' | 'phone_note' = 'pasted_message') {
  return captureSource(ctx, {
    branchId: seed.branches.north,
    kind,
    rawText: text,
    receivedAt,
    senderLabel: 'Gwen Tasker (synthetic)',
    callerName: kind === 'phone_note' ? 'Gwen Tasker' : null,
  });
}

export function line(seed: Seed, overrides: Partial<LineInput> = {}): LineInput {
  return {
    serviceDate: '2026-10-10',
    siteId: seed.sites.packhouse,
    workLocationId: seed.locations.packhouseGate,
    role: 'Grader',
    requestedCount: 4,
    arrivalLocal: '06:50',
    startLocal: '07:00',
    endLocal: '15:00',
    ...overrides,
  };
}

/** Create an order with one source and accept every line in full. */
export async function acceptedOrder(ctx: ServiceContext, seed: Seed, lines: LineInput[], text = 'Synthetic order message') {
  const s = await source(ctx, seed, text);
  const o = await createOrder(ctx, { branchId: seed.branches.north, clientId: seed.clients.growers, sourceMessageIds: [s.id], lines });
  const { orderLines } = await import('@cds/db');
  const { eq, asc } = await import('drizzle-orm');
  const { read } = await import('@cds/domain');
  const ls = await read(ctx, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, o.id)).orderBy(asc(orderLines.lineNo)));
  const acc = await decideAcceptance(ctx, o.id, { expectedVersion: 1, decisions: ls.map((l) => ({ lineId: l.id, acceptedCount: l.requestedCount })) });
  return { ...o, lines: ls, version: acc.version, sourceId: s.id };
}
