import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { contactPoints, readinessRequirements } from '@cds/db';
import { generateDraft, markManuallySent, proposeAssignments, recordReadinessCheck, recordWorkerResponse } from '@cds/domain';
import { acceptedOrder, line, useWorld } from './support';

const world = useWorld();

describe('readiness and contact changes', () => {
  it('AT51: a blocking site onboarding requirement stops assignment until an authorised decision clears it', async () => {
    const { seed, tdb } = world;
    const coord = await world.as('coordinator');
    const officer = await world.as('compliance');
    const [req] = await tdb.ownerDb
      .insert(readinessRequirements)
      .values({
        organisationId: seed.organisationId,
        scope: 'site',
        requirementType: 'site_risk_assessment',
        label: 'Site risk assessment approved',
        policy: 'blocking',
        siteId: seed.sites.field,
      })
      .returning();
    const o = await acceptedOrder(coord, seed, [
      line(seed, { serviceDate: '2026-10-11', siteId: seed.sites.field, workLocationId: seed.locations.fieldEntrance, requestedCount: 1 }),
    ]);
    await expect(proposeAssignments(coord, o.lines[0]!.id, { workers: [{ workerId: seed.workers.mira }] })).rejects.toMatchObject({
      code: 'READINESS_BLOCKED',
    });
    // Other sites are unaffected.
    const other = await acceptedOrder(coord, seed, [
      line(seed, { serviceDate: '2026-10-11', requestedCount: 1, startLocal: '16:00', arrivalLocal: '15:50', endLocal: '20:00' }),
    ]);
    await proposeAssignments(coord, other.lines[0]!.id, { workers: [{ workerId: seed.workers.teodor }] });
    await recordReadinessCheck(officer, {
      requirementId: req!.id,
      siteId: seed.sites.field,
      status: 'cleared',
      reason: 'Risk assessment reviewed (synthetic)',
      externalReference: 'SYN-RA-1',
    });
    await proposeAssignments(coord, o.lines[0]!.id, { workers: [{ workerId: seed.workers.mira }] });
  });

  it('AT41: a changed contact number makes an existing draft unsendable; a new draft uses the verified new number', async () => {
    const { seed, tdb } = world;
    const coord = await world.as('coordinator');
    const o = await acceptedOrder(coord, seed, [line(seed, { serviceDate: '2026-10-12', requestedCount: 1 })]);
    const { assignmentIds } = await proposeAssignments(coord, o.lines[0]!.id, { workers: [{ workerId: seed.workers.ralitsa }] });
    await recordWorkerResponse(coord, assignmentIds[0]!, { lineVersion: 1, response: 'accepted', channel: 'phone', respondedAt: '2026-10-11T18:00:00+01:00' });
    const draft = await generateDraft(coord, { template: 'worker_booking', assignmentId: assignmentIds[0]! });
    // The worker reports a new number; the old one is superseded and the new one verified.
    const [old] = await tdb.ownerDb.select().from(contactPoints).where(eq(contactPoints.workerId, seed.workers.ralitsa));
    await tdb.ownerDb.update(contactPoints).set({ status: 'superseded' }).where(eq(contactPoints.id, old!.id));
    await tdb.ownerDb.insert(contactPoints).values({
      organisationId: seed.organisationId,
      workerId: seed.workers.ralitsa,
      type: 'phone',
      value: '07700 900999',
      normalised: '+447700900999',
      status: 'active',
      verifiedAt: new Date('2026-10-11T19:00:00Z'),
      supersedesId: old!.id,
    });
    await expect(
      markManuallySent(coord, draft.id, { expectedVersion: 1, channel: 'whatsapp_manual', sentAt: '2026-10-11T19:05:00+01:00' }),
    ).rejects.toMatchObject({
      code: 'STALE_CONFIRMATION',
    });
    const fresh = await generateDraft(coord, { template: 'worker_booking', assignmentId: assignmentIds[0]! });
    expect(fresh.contact).toBe('07700 900999');
  });
});
