import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditEvents, orderLines, orderRevisions, orders, withContext } from '@cds/db';
import { captureSource, createOrder, getOrderDetail, operationsBoard, read, recordReadinessCheck } from '@cds/domain';
import { contextFor, seedSyntheticOrganisation, type Seed } from '@cds/test-fixtures';
import { acceptedOrder, line, useWorld } from './support';

const world = useWorld();

describe('access boundaries', () => {
  it('AT42: a coordinator from another branch cannot see or act on an order, and learns nothing about it', async () => {
    const north = await world.as('coordinator');
    const south = await world.as('southCoordinator');
    const { seed } = world;
    const o = await acceptedOrder(north, seed, [line(seed)]);
    await expect(getOrderDetail(south, o.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(operationsBoard(south, { branchId: seed.branches.north, date: '2026-10-10' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // Even reading the table directly under their context returns nothing.
    const rows = await read(south, (tx) => tx.select().from(orders).where(eq(orders.id, o.id)));
    expect(rows).toHaveLength(0);
    // They cannot create work in a branch they do not belong to.
    await expect(
      captureSource(south, { branchId: seed.branches.north, kind: 'pasted_message', rawText: 'x', receivedAt: '2026-10-09T10:00:00Z' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('coordinators cannot approve readiness; only an authorised officer can', async () => {
    const coord = await world.as('coordinator');
    const officer = await world.as('compliance');
    const { seed } = world;
    await expect(
      recordReadinessCheck(coord, { requirementId: seed.requirements.registration, workerId: seed.workers.yordan, status: 'cleared', reason: 'Looks fine' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await recordReadinessCheck(officer, {
      requirementId: seed.requirements.registration,
      workerId: seed.workers.yordan,
      status: 'cleared',
      reason: 'Documents checked in JoinedUp (synthetic)',
      externalReference: 'SYN-REG-1',
    });
  });

  it('AT43: organisations are isolated and a pooled connection carries no context after a transaction', async () => {
    const { seed, tdb } = world;
    const other: Seed = await seedSyntheticOrganisation(tdb.ownerDb, { name: 'Other Agency (synthetic)' });
    const otherCtx = await contextFor(tdb.appDb, other, 'coordinator');
    const mine = await world.as('coordinator');
    await acceptedOrder(mine, seed, [line(seed, { serviceDate: '2026-10-20' })]);
    const theirs = await read(otherCtx, (tx) => tx.select().from(orders));
    expect(theirs.every((o) => o.organisationId === other.organisationId)).toBe(true);
    // Reuse every pooled connection with no context: nothing is visible.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        tdb.appPool.query('select count(*)::int as n, current_setting($1, true) as org from app.orders', ['app.organisation_id']),
      ),
    );
    for (const r of results) {
      expect(r.rows[0].n).toBe(0);
      expect(r.rows[0].org ?? '').toBe('');
    }
    // A forged context for an organisation the caller is not in is rejected at the application layer,
    // because contexts are only built from verified memberships (resolveStaffActor).
    await expect(
      contextFor(tdb.appDb, { ...other, staff: { ...other.staff, coordinator: seed.staff.coordinator } } as Seed, 'coordinator'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('cross-organisation references are impossible at the database level', async () => {
    const { seed, tdb } = world;
    const other = await seedSyntheticOrganisation(tdb.ownerDb, { name: 'Third Agency (synthetic)' });
    const ctx = await world.as('coordinator');
    const o = await acceptedOrder(ctx, seed, [line(seed, { serviceDate: '2026-10-21' })]);
    // Even the owner cannot attach another organisation's line to this order.
    await expect(
      tdb.ownerDb.insert(orderLines).values({
        organisationId: other.organisationId,
        branchId: other.branches.north,
        orderId: o.id,
        lineNo: 99,
        serviceDate: '2026-10-21',
        requestedCount: 1,
      }),
    ).rejects.toThrow();
  });

  it('audit events and order revisions are append-only for the runtime role', async () => {
    const { seed, tdb } = world;
    const ctx = await world.as('coordinator');
    await acceptedOrder(ctx, seed, [line(seed, { serviceDate: '2026-10-22' })]);
    const ctxDb = { organisationId: seed.organisationId, branchIds: [seed.branches.north] };
    const pgCode = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e) => (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code,
      );
    // 42501 = insufficient_privilege
    expect(await pgCode(withContext(tdb.appDb, ctxDb, (tx) => tx.update(auditEvents).set({ reason: 'tampered' })))).toBe('42501');
    expect(await pgCode(withContext(tdb.appDb, ctxDb, (tx) => tx.update(orderRevisions).set({ reason: 'tampered' })))).toBe('42501');
    expect(await pgCode(withContext(tdb.appDb, ctxDb, (tx) => tx.execute(sql`delete from app.orders`)))).toBe('42501');
  });

  it('idempotency: a replay returns the first result; reusing a key for different input is refused', async () => {
    const ctx = await world.as('coordinator');
    const { seed } = world;
    const s = await captureSource(ctx, {
      branchId: seed.branches.north,
      kind: 'pasted_message',
      rawText: 'four graders please',
      receivedAt: '2026-10-09T15:00:00Z',
    });
    const input = {
      branchId: seed.branches.north,
      clientId: seed.clients.growers,
      sourceMessageIds: [s.id],
      lines: [line(seed, { serviceDate: '2026-10-23' })],
    };
    const a = await createOrder(ctx, input, 'key-1');
    const b = await createOrder(ctx, input, 'key-1');
    expect(b.id).toBe(a.id);
    await expect(createOrder(ctx, { ...input, lines: [line(seed, { serviceDate: '2026-10-24' })] }, 'key-1')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
});
