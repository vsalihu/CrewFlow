// Synthetic organisation for development, tests and demonstrations.
// Every person, company, phone number and identifier here is fictional. Phone numbers use
// Ofcom's reserved drama range (07700 900000-900999). Do not add real chat content,
// worker names, IDs, bank details or access codes to this file.

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  branchMemberships,
  branches,
  clientContacts,
  clients,
  contactPoints,
  drivers,
  externalWorkerIds,
  integrationSettings,
  memberships,
  organisations,
  readinessChecks,
  readinessRequirements,
  sites,
  travelPartyMembers,
  travelParties,
  vehicles,
  workLocations,
  workerAliases,
  workerSkills,
  workers,
  type Db,
} from '@cds/db';

export type Seed = Awaited<ReturnType<typeof seedSyntheticOrganisation>>;

const WORKERS = [
  ['ivo', 'Ivo Dragnev', '000417'],
  ['mira', 'Mira Kostova', '10233'],
  ['teodor', 'Teodor Vlahov', '10234'],
  ['ralitsa', 'Ralitsa Peneva', '10235'],
  ['bozhidar', 'Bozhidar Enchev', '10236'],
  ['nevena', 'Nevena Stancheva', '10237'],
  ['kaloyan', 'Kaloyan Ruschev', '10238'],
  ['desislava', 'Desislava Mineva', '10239'],
  ['ognyan', 'Ognyan Zhelev', '10240'],
  ['radka', 'Radka Bozova', '10241'],
  ['stoyko', 'Stoyko Arnaudov', '10242'],
  ['velina', 'Velina Arnaudova', '10243'],
  ['lazar', 'Lazar Hristakiev', '10244'],
  ['emil', 'Emil Garvanov', '10245'],
  ['siyana', 'Siyana Krasteva', '10246'],
  ['yordan', 'Yordan Pelov', '10247'],
  // Two similarly named, distinct people (identity must never be merged automatically).
  ['petar_a', 'Petar Iliev', '10248'],
  ['petar_b', 'Petur Iliev', '10249'],
] as const;

type WorkerKey = (typeof WORKERS)[number][0];

export async function seedSyntheticOrganisation(db: Db, opts: { name?: string } = {}) {
  const [org] = await db
    .insert(organisations)
    .values({ name: opts.name ?? 'Fenmoor Labour (synthetic)', settings: {} })
    .returning();
  const organisationId = org!.id;
  const [north] = await db.insert(branches).values({ organisationId, name: 'Fenmoor North (test)' }).returning();
  const [south] = await db.insert(branches).values({ organisationId, name: 'Fenmoor South (test)' }).returning();

  const people = {
    coordinator: { name: 'Hana Lowell', roles: ['coordinator'], branch: north!.id },
    coordinator2: { name: 'Jasper Quill', roles: ['coordinator'], branch: north!.id },
    dispatcher: { name: 'Mo Ferrant', roles: ['transport_dispatcher'], branch: north!.id },
    manager: { name: 'Rhiannon Teale', roles: ['branch_manager'], branch: north!.id },
    compliance: { name: 'Odile Marsh', roles: ['compliance_officer'], branch: north!.id },
    southCoordinator: { name: 'Calum Brisk', roles: ['coordinator'], branch: south!.id },
  } as const;
  const staff: Record<keyof typeof people | 'admin', { membershipId: string; authUserId: string }> = {} as never;
  for (const [key, p] of Object.entries(people)) {
    const authUserId = randomUUID();
    const [m] = await db.insert(memberships).values({ organisationId, authUserId, displayName: p.name, email: `${key}@example.test` }).returning();
    await db.insert(branchMemberships).values({ organisationId, membershipId: m!.id, branchId: p.branch, roles: [...p.roles] });
    staff[key as keyof typeof people] = { membershipId: m!.id, authUserId };
  }
  {
    const authUserId = randomUUID();
    const [m] = await db.insert(memberships).values({ organisationId, authUserId, displayName: 'Ada Okafor', email: 'admin@example.test', roles: ['org_admin'] }).returning();
    staff.admin = { membershipId: m!.id, authUserId };
  }

  // Clients and sites. "Gault Drove field" is a working field distinct from the packhouse office.
  const [growers] = await db
    .insert(clients)
    .values({ organisationId, legalName: 'Marshland Growers Ltd (fictional)', displayName: 'Marshland Growers', requiresExternalBooking: true, officialChannel: 'whatsapp_group' })
    .returning();
  const [coldStore] = await db
    .insert(clients)
    .values({ organisationId, legalName: 'Northfield Cold Store Ltd (fictional)', displayName: 'Northfield Cold Store', requiresExternalBooking: true, officialChannel: 'email' })
    .returning();
  const [growersContact] = await db.insert(clientContacts).values({ organisationId, clientId: growers!.id, name: 'Gwen Tasker', roleTitle: 'Harvest supervisor', authorityScope: 'orders' }).returning();
  const [packhouse] = await db
    .insert(sites)
    .values({ organisationId, clientId: growers!.id, branchId: north!.id, canonicalName: 'Haddon Fen Packhouse', address: '1 Example Drove, Fenmoor', postcode: 'ZZ1 1AA' })
    .returning();
  const [field] = await db
    .insert(sites)
    .values({ organisationId, clientId: growers!.id, branchId: north!.id, canonicalName: 'Gault Drove Field', postcode: 'ZZ1 1AB' })
    .returning();
  const [coldStoreSite] = await db
    .insert(sites)
    .values({ organisationId, clientId: coldStore!.id, branchId: north!.id, canonicalName: 'Northfield Cold Store', postcode: 'ZZ2 2BB' })
    .returning();
  const now = new Date('2026-09-01T09:00:00Z');
  const [packhouseGate] = await db
    .insert(workLocations)
    .values({ organisationId, siteId: packhouse!.id, name: 'Packhouse staff gate', pinText: 'what3words ///example.packhouse.gate', accessInstructions: 'Report to goods-in office', verifiedAt: now, verifiedBy: staff.manager.membershipId })
    .returning();
  // Field entrance not yet verified: dispatch to it must be blocked.
  const [fieldEntrance] = await db.insert(workLocations).values({ organisationId, siteId: field!.id, name: 'Field entrance off Gault Drove', pinText: null }).returning();
  const [coldStoreGate] = await db
    .insert(workLocations)
    .values({ organisationId, siteId: coldStoreSite!.id, name: 'Cold store yard', pinText: 'Yard gate B', verifiedAt: now, verifiedBy: staff.manager.membershipId })
    .returning();

  // Workers.
  const w = {} as Record<WorkerKey, string>;
  for (const [key, name, ext] of WORKERS) {
    const [row] = await db.insert(workers).values({ organisationId, homeBranchId: north!.id, legalName: name, displayName: name }).returning();
    w[key] = row!.id;
    await db.insert(externalWorkerIds).values({ organisationId, workerId: row!.id, provider: 'joinedup', externalId: ext });
    const n = String(100 + WORKERS.findIndex((x) => x[0] === key)).padStart(3, '0');
    await db.insert(contactPoints).values({
      organisationId,
      workerId: row!.id,
      type: 'phone',
      value: `07700 900${n}`,
      normalised: `+447700900${n}`,
      status: 'active',
      verifiedAt: now,
      verifiedBy: staff.coordinator.membershipId,
    });
  }
  await db.insert(workerAliases).values({ organisationId, workerId: w.ivo, alias: 'Ivo Dragnew', kind: 'original_spelling', source: 'synthetic roster' });
  await db.insert(workerSkills).values([
    { organisationId, workerId: w.kaloyan, skill: 'FLT', evidence: 'Synthetic certificate ref FLT-TEST-1', expiresOn: '2027-12-31' },
    { organisationId, workerId: w.lazar, skill: 'FLT', evidence: 'Synthetic certificate ref FLT-TEST-2', expiresOn: '2026-01-31' },
  ]);
  // Siyana must leave by 18:00 (personal constraint recorded from the worker).
  await db.update(workers).set({ latestFinishLocal: '18:00' }).where(eq(workers.id, w.siyana));

  // Readiness: two organisation-wide blocking requirements.
  const [registration] = await db.insert(readinessRequirements).values({ organisationId, scope: 'worker', requirementType: 'registration', label: 'Registration complete', policy: 'blocking' }).returning();
  const [eligibility] = await db.insert(readinessRequirements).values({ organisationId, scope: 'worker', requirementType: 'work_eligibility', label: 'Authorised work-eligibility check', policy: 'blocking' }).returning();
  for (const key of Object.keys(w) as WorkerKey[]) {
    await db.insert(readinessChecks).values({ organisationId, requirementId: registration!.id, workerId: w[key], status: key === 'yordan' ? 'pending' : 'cleared', checkedBy: staff.compliance.membershipId, checkedAt: now, reason: 'Synthetic fixture' });
    await db.insert(readinessChecks).values({
      organisationId,
      requirementId: eligibility!.id,
      workerId: w[key],
      status: 'cleared',
      validTo: key === 'emil' ? '2026-09-30' : null,
      checkedBy: staff.compliance.membershipId,
      checkedAt: now,
      externalReference: `SYN-CHK-${key}`,
      reason: 'Synthetic fixture',
    });
  }

  // Transport. Driving is explicit: only these records make someone a driver.
  const [driverIvo] = await db.insert(drivers).values({ organisationId, branchId: north!.id, workerId: w.ivo, displayName: 'Ivo Dragnev', willingToDrive: true, readinessStatus: 'cleared' }).returning();
  const [driverStoyko] = await db.insert(drivers).values({ organisationId, branchId: north!.id, workerId: w.stoyko, displayName: 'Stoyko Arnaudov', willingToDrive: true, readinessStatus: 'cleared' }).returning();
  const [driverMo] = await db.insert(drivers).values({ organisationId, branchId: north!.id, membershipId: staff.dispatcher.membershipId, displayName: 'Mo Ferrant', willingToDrive: true, readinessStatus: 'cleared' }).returning();
  for (const [d, n] of [[driverIvo!, '100'], [driverStoyko!, '110'], [driverMo!, '190']] as const) {
    await db.insert(contactPoints).values({ organisationId, driverId: d.id, type: 'phone', value: `07700 900${n}`, normalised: `+447700900${n}`, status: 'active', verifiedAt: now });
  }
  const [car] = await db.insert(vehicles).values({ organisationId, branchId: north!.id, identifier: 'Agency car 1', registration: 'TE57 AAA', totalSeats: 5, passengerCapacity: 4, readinessStatus: 'cleared' }).returning();
  const [minibus] = await db.insert(vehicles).values({ organisationId, branchId: north!.id, identifier: 'Agency minibus', registration: 'TE57 BBB', totalSeats: 9, passengerCapacity: 8, readinessStatus: 'cleared' }).returning();
  const [privateCar] = await db
    .insert(vehicles)
    .values({ organisationId, branchId: north!.id, identifier: "Stoyko's car", registration: 'TE57 CCC', operator: 'Private', totalSeats: 5, passengerCapacity: 4, ownerDriverId: driverStoyko!.id })
    .returning();
  const [unknownCar] = await db.insert(vehicles).values({ organisationId, branchId: north!.id, identifier: 'Unknown car (capacity unconfirmed)', registration: 'TE57 DDD', passengerCapacity: null }).returning();
  // A couple who travel together privately; no extra passengers.
  const [couple] = await db.insert(travelParties).values({ organisationId, name: 'Arnaudov household', additionalPassengersAllowed: false, source: 'Confirmed by the driver (synthetic)' }).returning();
  await db.insert(travelPartyMembers).values([
    { organisationId, partyId: couple!.id, workerId: w.stoyko },
    { organisationId, partyId: couple!.id, workerId: w.velina },
  ]);

  await db.insert(integrationSettings).values([
    { organisationId, provider: 'joinedup', status: 'manual', note: 'Manual entry and verification queue. No API access verified.' },
    { organisationId, provider: 'whatsapp', status: 'disabled', note: 'Paste/import and manual send only. Business account capabilities not verified.' },
    { organisationId, provider: 'email', status: 'manual', note: '.eml upload and paste only. Mailbox provider not confirmed.' },
    { organisationId, provider: 'ai_extraction', status: 'disabled', note: 'Disabled. Optional P2 feature.' },
  ]);

  return {
    organisationId,
    branches: { north: north!.id, south: south!.id },
    staff,
    clients: { growers: growers!.id, coldStore: coldStore!.id },
    contacts: { growers: growersContact!.id },
    sites: { packhouse: packhouse!.id, field: field!.id, coldStore: coldStoreSite!.id },
    locations: { packhouseGate: packhouseGate!.id, fieldEntrance: fieldEntrance!.id, coldStoreGate: coldStoreGate!.id },
    workers: w,
    requirements: { registration: registration!.id, eligibility: eligibility!.id },
    drivers: { ivo: driverIvo!.id, stoyko: driverStoyko!.id, mo: driverMo!.id },
    vehicles: { car: car!.id, minibus: minibus!.id, privateCar: privateCar!.id, unknownCar: unknownCar!.id },
    parties: { couple: couple!.id },
  };
}

