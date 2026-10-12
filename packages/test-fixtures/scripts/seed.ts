// Seeds a synthetic organisation plus a few demonstration orders for tomorrow.
// Refuses to run in staging or production. Writes apps/web/.dev-users.json (gitignored)
// so the development-only sign-in page can list the synthetic staff.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createPool } from '@cds/db';
import { captureSource, createOrder, decideAcceptance, operationalDates, proposeAssignments, raiseConflict, read, recordWorkerResponse } from '@cds/domain';
import { orderLines } from '@cds/db';
import { asc, eq } from 'drizzle-orm';
import { contextFor, seedSyntheticOrganisation } from '../src/index';

if (process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging') {
  console.error('Refusing to seed synthetic data into staging or production.');
  process.exit(1);
}
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error('DATABASE_MIGRATION_URL and DATABASE_URL are required.');
  process.exit(1);
}

const ownerPool = createPool(ownerUrl, 2);
const appPool = createPool(appUrl, 4);
const seed = await seedSyntheticOrganisation(createDb(ownerPool));
const db = createDb(appPool);
const coord = await contextFor(db, seed, 'coordinator');
const { tomorrow } = operationalDates(new Date());
const now = new Date().toISOString();

// A clean order: accepted, partly staffed.
const s1 = await captureSource(coord, {
  branchId: seed.branches.north,
  kind: 'pasted_message',
  rawText: 'Morning, 6 graders for the packhouse tomorrow 7am please, finishing about 3',
  receivedAt: now,
  senderLabel: 'Gwen Tasker (synthetic)',
});
const o1 = await createOrder(coord, {
  branchId: seed.branches.north,
  clientId: seed.clients.growers,
  sourceMessageIds: [s1.id],
  lines: [
    {
      serviceDate: tomorrow,
      siteId: seed.sites.packhouse,
      workLocationId: seed.locations.packhouseGate,
      role: 'Grader',
      requestedCount: 6,
      arrivalLocal: '06:50',
      startLocal: '07:00',
      endLocal: '15:00',
    },
  ],
});
const [l1] = await read(coord, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, o1.id)).orderBy(asc(orderLines.lineNo)));
await decideAcceptance(coord, o1.id, { expectedVersion: 1, decisions: [{ lineId: l1!.id, acceptedCount: 6 }] });
const p1 = await proposeAssignments(coord, l1!.id, {
  workers: ['mira', 'teodor', 'ralitsa', 'bozhidar'].map((k) => ({ workerId: seed.workers[k as 'mira'], rawTransportLabel: 'OWN' })),
});
for (const id of p1.assignmentIds.slice(0, 3))
  await recordWorkerResponse(coord, id, { lineVersion: 1, response: 'accepted', channel: 'phone', respondedAt: now });

// A two-line request with a time conflict between the client message and the internal note.
const s2 = await captureSource(coord, {
  branchId: seed.branches.north,
  kind: 'pasted_message',
  rawText: '4 pickers to Gault Drove for 6:30, and 2 more graders packhouse 11:30 start',
  receivedAt: now,
  senderLabel: 'Gwen Tasker (synthetic)',
});
const o2 = await createOrder(coord, {
  branchId: seed.branches.north,
  clientId: seed.clients.growers,
  sourceMessageIds: [s2.id],
  lines: [
    {
      serviceDate: tomorrow,
      siteId: seed.sites.field,
      workLocationId: seed.locations.fieldEntrance,
      role: 'Picker',
      requestedCount: 4,
      arrivalLocal: '06:50',
      startLocal: '07:00',
    },
    {
      serviceDate: tomorrow,
      siteId: seed.sites.packhouse,
      workLocationId: seed.locations.packhouseGate,
      role: 'Grader',
      requestedCount: 2,
      arrivalLocal: '11:20',
      startLocal: '11:30',
      endLocal: '19:30',
    },
  ],
});
const ls2 = await read(coord, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, o2.id)).orderBy(asc(orderLines.lineNo)));
await raiseConflict(coord, o2.id, {
  lineId: ls2[0]!.id,
  fieldPath: 'arrival time',
  observations: [
    { value: '06:30', sourceMessageId: s2.id },
    { value: '06:50', note: 'Internal booking sheet' },
  ],
});

const devUsers = (Object.entries(seed.staff) as [string, { authUserId: string }][]).map(([key, s]) => ({
  authUserId: s.authUserId,
  name:
    {
      coordinator: 'Hana Lowell',
      coordinator2: 'Jasper Quill',
      dispatcher: 'Mo Ferrant',
      manager: 'Rhiannon Teale',
      compliance: 'Odile Marsh',
      southCoordinator: 'Calum Brisk',
      payroll: 'Tamsin Hale',
      admin: 'Ada Okafor',
    }[key] ?? key,
  role: key,
}));
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/web/.dev-users.json');
await writeFile(out, JSON.stringify(devUsers, null, 2));
console.log(`Seeded ${seed.organisationId}. Orders ${o1.reference}, ${o2.reference} for ${tomorrow}. Dev users written to ${out}.`);
await ownerPool.end();
await appPool.end();
