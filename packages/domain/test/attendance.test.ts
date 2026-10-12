import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { assignments, cases, clients, exportBatches, orders, sites, tasks, withContext } from '@cds/db';
import {
  addBreakPolicy,
  approveTimesheet,
  attendanceDay,
  correctSegment,
  createExport,
  createOrder,
  disputeTimesheet,
  getTimesheet,
  listBreakPolicies,
  proposeAssignments,
  read,
  readExportFile,
  recordArrival,
  recordTimesheet,
  recordWorkerResponse,
  voidSegment,
  type ServiceContext,
  type SegmentInput,
} from '@cds/domain';
import type { LineInput } from '@cds/contracts';
import type { Seed } from '@cds/test-fixtures';
import { acceptedOrder, line, useWorld } from './support';

const world = useWorld();

async function booked(ctx: ServiceContext, seed: Seed, keys: (keyof Seed['workers'])[], overrides: Partial<LineInput> = {}, clientId = seed.clients.growers) {
  const o = await acceptedOrder(ctx, seed, [line(seed, { requestedCount: keys.length, ...overrides })], 'Synthetic order', clientId);
  const l = o.lines[0]!;
  const { assignmentIds } = await proposeAssignments(ctx, l.id, { workers: keys.map((k) => ({ workerId: seed.workers[k] })) });
  for (const id of assignmentIds)
    await recordWorkerResponse(ctx, id, { lineVersion: 1, response: 'accepted', channel: 'phone', respondedAt: '2026-10-09T18:00:00+01:00' });
  return Object.fromEntries(keys.map((k, i) => [k, assignmentIds[i]!])) as Record<string, string>;
}

function sheet(seed: Seed, date: string, entries: SegmentInput[], over: { clientId?: string; siteId?: string; supervisor?: string } = {}) {
  return {
    branchId: seed.branches.north,
    clientId: over.clientId ?? seed.clients.growers,
    siteId: over.siteId ?? seed.sites.packhouse,
    serviceDate: date,
    supervisorName: over.supervisor ?? 'Gwen Tasker (synthetic)',
    rawText: entries.map((e) => `${e.rawName} ${e.startLocal}-${e.endLocal}`).join('\n'),
    receivedAt: `${date}T19:00:00+01:00`,
    entries,
  };
}

const row = (seed: Seed, k: keyof Seed['workers'], start: string, end: string, extra: Partial<SegmentInput> = {}): SegmentInput => ({
  workerId: seed.workers[k],
  rawName: k,
  startLocal: start,
  endLocal: end,
  ...extra,
});

async function codes(ctx: ServiceContext, batchId: string) {
  return (await getTimesheet(ctx, batchId)).discrepancies.map((d) => d.code);
}

describe('arrivals', () => {
  it('records arrivals and no-shows; a no-show keeps the booking and starts a replacement', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const ids = await booked(coord, seed, ['mira', 'teodor'], { serviceDate: '2026-11-02' });
    await recordArrival(coord, ids.mira!, { status: 'arrived' });
    await recordArrival(coord, ids.teodor!, { status: 'no_show', note: 'Not at pickup; phone off' });
    const day = await attendanceDay(coord, { branchId: seed.branches.north, date: '2026-11-02' });
    expect(day.booked.map((b) => b.state).sort()).toEqual(['arrived', 'no_show']);
    const noShow = await read(coord, (tx) => tx.select().from(cases).where(eq(cases.type, 'no_show')));
    expect(noShow).toHaveLength(1);
    const repl = await read(coord, (tx) =>
      tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.type, 'find_replacement'), eq(tasks.state, 'open'))),
    );
    expect(repl.length).toBeGreaterThan(0);
  });

  it('a proposed worker who never confirmed cannot be marked a no-show', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const o = await acceptedOrder(coord, seed, [line(seed, { serviceDate: '2026-11-03', requestedCount: 1 })]);
    const { assignmentIds } = await proposeAssignments(coord, o.lines[0]!.id, { workers: [{ workerId: seed.workers.ralitsa }] });
    await expect(recordArrival(coord, assignmentIds[0]!, { status: 'no_show' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('timesheets', () => {
  it('AT28: two clients with different agreed break rules give different paid minutes; no rule means the break must be entered', async () => {
    const coord = await world.as('coordinator');
    const { seed, tdb } = world;
    const d = '2026-11-04';
    const a = await recordTimesheet(coord, sheet(seed, d, [row(seed, 'bozhidar', '07:00', '15:00')]));
    const b = await recordTimesheet(
      coord,
      sheet(seed, d, [row(seed, 'nevena', '07:00', '15:00')], { clientId: seed.clients.coldStore, siteId: seed.sites.coldStore }),
    );
    const segA = (await getTimesheet(coord, a.id)).segments[0]!.s;
    const segB = (await getTimesheet(coord, b.id)).segments[0]!.s;
    expect([segA.paidMinutes, segA.breakBasis]).toEqual([480, 'rule v1']); // growers pay breaks
    expect([segB.paidMinutes, segB.breakBasis]).toEqual([450, 'rule v1']); // cold store: 30 unpaid after 6h
    // A client with no agreed rule: the unpaid break is never guessed.
    const [c] = await tdb.ownerDb
      .insert(clients)
      .values({ organisationId: seed.organisationId, legalName: 'No Rule Farms (fictional)', displayName: 'No Rule Farms' })
      .returning();
    const [s] = await tdb.ownerDb
      .insert(sites)
      .values({ organisationId: seed.organisationId, clientId: c!.id, branchId: seed.branches.north, canonicalName: 'No Rule Yard' })
      .returning();
    await expect(recordTimesheet(coord, sheet(seed, d, [row(seed, 'ognyan', '07:00', '15:00')], { clientId: c!.id, siteId: s!.id }))).rejects.toThrow(
      /enter the unpaid break shown on the timesheet/,
    );
    const ok = await recordTimesheet(
      coord,
      sheet(seed, d, [row(seed, 'ognyan', '07:00', '15:00', { unpaidBreakMinutes: 20 })], { clientId: c!.id, siteId: s!.id }),
    );
    expect((await getTimesheet(coord, ok.id)).segments[0]!.s.paidMinutes).toBe(460);
  });

  it('AT29: an overnight shift across the clock change counts real elapsed time; an ambiguous time is refused', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const cold = { clientId: seed.clients.coldStore, siteId: seed.sites.coldStore };
    const t = await recordTimesheet(coord, sheet(seed, '2026-10-24', [row(seed, 'radka', '22:00', '06:00', { endDayOffset: 1 })], cold));
    const seg = (await getTimesheet(coord, t.id)).segments[0]!.s;
    expect(seg.elapsedMinutes).toBe(540); // 22:00 BST to 06:00 GMT is 9 hours
    expect(seg.paidMinutes).toBe(510);
    await expect(recordTimesheet(coord, sheet(seed, '2026-10-25', [row(seed, 'radka', '01:30', '05:00')], cold))).rejects.toThrow(/happens twice/);
    await expect(recordTimesheet(coord, sheet(seed, '2026-10-26', [row(seed, 'radka', '22:00', '06:00')], cold))).rejects.toThrow(/finishing the next day/);
  });

  it('AT20/AT30: an extra, unbooked arrival is recorded and must be justified; a timesheet never creates an order', async () => {
    const coord = await world.as('coordinator');
    const manager = await world.as('manager');
    const { seed } = world;
    const d = '2026-11-05';
    await booked(coord, seed, ['desislava'], { serviceDate: d });
    const ordersBefore = (await read(coord, (tx) => tx.select({ id: orders.id }).from(orders))).length;
    const t = await recordTimesheet(coord, sheet(seed, d, [row(seed, 'desislava', '07:00', '15:00'), row(seed, 'kaloyan', '07:00', '15:00')]));
    expect((await read(coord, (tx) => tx.select({ id: orders.id }).from(orders))).length).toBe(ordersBefore);
    // Its source text cannot be cited as the request for a new order either.
    const sourceId = (await getTimesheet(coord, t.id)).source.id;
    await expect(
      createOrder(coord, {
        branchId: seed.branches.north,
        clientId: seed.clients.growers,
        sourceMessageIds: [sourceId],
        lines: [line(seed, { serviceDate: d })],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await codes(coord, t.id)).toEqual(['NO_BOOKING']);
    const v = (await getTimesheet(manager, t.id)).b.version;
    await expect(approveTimesheet(manager, t.id, { expectedVersion: v })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const r = await approveTimesheet(manager, t.id, {
      expectedVersion: v,
      justification: 'Supervisor asked for a third packer on the day; client confirmed by phone',
    });
    expect(r.state).toBe('approved');
  });

  it('AT26: hours for someone not ready are recorded as worked and open an exception case', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const t = await recordTimesheet(coord, sheet(seed, '2026-11-06', [row(seed, 'yordan', '07:00', '12:00')]));
    const ts = await getTimesheet(coord, t.id);
    expect(ts.segments).toHaveLength(1);
    expect(ts.discrepancies.map((d) => d.code)).toEqual(expect.arrayContaining(['READINESS_BLOCKED', 'NO_BOOKING']));
    const ex = await read(coord, (tx) => tx.select().from(cases).where(eq(cases.type, 'readiness_exception')));
    expect(ex.some((c) => c.summary.includes('Yordan Pelov'))).toBe(true);
  });

  it('AT27: the same hours on two supervisors’ sheets block approval until the duplicate is voided', async () => {
    const coord = await world.as('coordinator');
    const payroll = await world.as('payroll');
    const { seed } = world;
    const d = '2026-11-07';
    await booked(coord, seed, ['lazar'], { serviceDate: d });
    const a = await recordTimesheet(coord, sheet(seed, d, [row(seed, 'lazar', '07:00', '15:00')], { supervisor: 'Supervisor A' }));
    const b = await recordTimesheet(coord, sheet(seed, d, [row(seed, 'lazar', '07:00', '15:00')], { supervisor: 'Supervisor B' }));
    expect(await codes(coord, a.id)).toContain('OVERLAP');
    const vb = (await getTimesheet(payroll, b.id)).b.version;
    await expect(approveTimesheet(payroll, b.id, { expectedVersion: vb })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const dup = (await getTimesheet(coord, b.id)).segments[0]!.s;
    await voidSegment(coord, dup.id, 'Same hours already on Supervisor A sheet');
    const after = await getTimesheet(coord, b.id);
    expect(after.segments.map((s) => [s.s.revision, s.s.isCurrent, s.s.status])).toEqual([
      [1, false, 'active'],
      [2, true, 'voided'],
    ]);
    expect(await codes(coord, a.id)).not.toContain('OVERLAP');
    const va = (await getTimesheet(payroll, a.id)).b.version;
    expect((await approveTimesheet(payroll, a.id, { expectedVersion: va })).state).toBe('approved');
  });

  it('flags a worker booked at a different site, and booked people missing from every timesheet', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const d = '2026-11-08';
    await booked(coord, seed, ['siyana', 'petar_a'], { serviceDate: d, endLocal: '15:00' });
    const t = await recordTimesheet(coord, sheet(seed, d, [row(seed, 'siyana', '07:00', '15:00')], { siteId: seed.sites.field }));
    const found = (await getTimesheet(coord, t.id)).discrepancies;
    expect(found.find((x) => x.code === 'DIFFERENT_SITE')).toBeTruthy();
    const packhouse = await recordTimesheet(coord, sheet(seed, d, [row(seed, 'siyana', '16:00', '17:00')]));
    expect((await getTimesheet(coord, packhouse.id)).discrepancies.find((x) => x.code === 'NOT_ON_TIMESHEET')?.message).toContain('Petar Iliev');
  });

  it('the person who entered a timesheet cannot approve it, and coordinators cannot approve or export', async () => {
    const coord = await world.as('coordinator');
    const manager = await world.as('manager');
    const { seed } = world;
    const d = '2026-11-09';
    await booked(coord, seed, ['velina'], { serviceDate: d });
    const t = await recordTimesheet(manager, sheet(seed, d, [row(seed, 'velina', '07:00', '15:00')]));
    const v = (await getTimesheet(manager, t.id)).b.version;
    await expect(approveTimesheet(coord, t.id, { expectedVersion: v })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(approveTimesheet(manager, t.id, { expectedVersion: v })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(createExport(coord, { branchId: seed.branches.north, dateFrom: d, dateTo: d })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(createExport(manager, { branchId: seed.branches.north, dateFrom: d, dateTo: d })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const disputed = await disputeTimesheet(manager, t.id, { expectedVersion: v, note: 'Finish time looks wrong; asking the supervisor' });
    expect(disputed.state).toBe('disputed');
  });

  it('break rules are versioned, set only by an administrator, and visible to whoever records timesheets', async () => {
    const admin = await world.as('admin');
    const coord = await world.as('coordinator');
    const { seed } = world;
    const rule = {
      clientId: seed.clients.growers,
      effectiveFrom: '2026-12-01',
      unpaidBreakMinutes: 30,
      unpaidAfterMinutes: 360,
      paidBreakMinutes: 0,
      agreementReference: 'SYN-AGR-GROWERS-2',
    };
    await expect(addBreakPolicy(coord, rule)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await addBreakPolicy(admin, rule)).policyVersion).toBe(2);
    await expect(addBreakPolicy(admin, { ...rule, siteId: seed.sites.coldStore })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // The administrator who sets rules does not record attendance but must still see the rules.
    const forAdmin = await listBreakPolicies(admin);
    const forCoord = await listBreakPolicies(coord);
    expect(forAdmin.map((r) => r.p.agreementReference)).toContain('SYN-AGR-GROWERS-2');
    expect(forCoord).toHaveLength(forAdmin.length);
    // Earlier dates keep version 1 (no unpaid break); later dates use version 2.
    const before = await recordTimesheet(coord, sheet(seed, '2026-11-30', [row(seed, 'velina', '07:00', '15:00')]));
    const after = await recordTimesheet(coord, sheet(seed, '2026-12-01', [row(seed, 'velina', '07:00', '15:00')]));
    expect((await getTimesheet(coord, before.id)).segments[0]!.s.paidMinutes).toBe(480);
    expect((await getTimesheet(coord, after.id)).segments[0]!.s.paidMinutes).toBe(450);
  });

  it('AT32: a correction after export goes out as a correction batch; the first file never changes', async () => {
    const coord = await world.as('coordinator');
    const payroll = await world.as('payroll');
    const { seed, tdb } = world;
    const d = '2026-11-10';
    await booked(coord, seed, ['ivo', 'stoyko'], { serviceDate: d });
    const t = await recordTimesheet(coord, sheet(seed, d, [row(seed, 'ivo', '07:00', '15:00'), row(seed, 'stoyko', '07:00', '15:00')]));
    let v = (await getTimesheet(payroll, t.id)).b.version;
    await approveTimesheet(payroll, t.id, { expectedVersion: v });
    const first = await createExport(payroll, { branchId: seed.branches.north, dateFrom: d, dateTo: d });
    expect([first.kind, first.rowCount]).toEqual(['hours', 2]);
    const file1 = await readExportFile(payroll, first.id);
    expect(file1.content).toContain(',000417,'); // leading-zero JoinedUp ID kept
    await expect(createExport(payroll, { branchId: seed.branches.north, dateFrom: d, dateTo: d })).rejects.toThrow(/Nothing new to export/);

    // Ivo actually finished at 14:00.
    const ivo = (await getTimesheet(coord, t.id)).segments.find((s) => s.s.rawName === 'ivo')!.s;
    await correctSegment(coord, ivo.id, { ...row(seed, 'ivo', '07:00', '14:00'), reason: 'Supervisor corrected finish to 14:00 by phone' });
    const reopened = await getTimesheet(payroll, t.id);
    expect(reopened.b.state).toBe('submitted');
    await expect(createExport(payroll, { branchId: seed.branches.north, dateFrom: d, dateTo: d })).rejects.toThrow(/Nothing new to export/);
    v = reopened.b.version;
    await approveTimesheet(payroll, t.id, { expectedVersion: v });
    const second = await createExport(payroll, { branchId: seed.branches.north, dateFrom: d, dateTo: d });
    expect([second.kind, second.rowCount]).toEqual(['correction', 2]);
    const file2 = await readExportFile(payroll, second.id);
    expect(file2.content).toMatch(/reversal,000417,Ivo Dragnev,.*,-480,/);
    expect(file2.content).toMatch(/hours,000417,Ivo Dragnev,.*,420,/);
    // The first file is unchanged and the runtime role cannot rewrite it.
    expect((await readExportFile(payroll, first.id)).checksum).toBe(first.checksum);
    const denied = await withContext(tdb.appDb, { organisationId: seed.organisationId, branchIds: [seed.branches.north] }, (tx) =>
      tx.update(exportBatches).set({ content: 'tampered' }).where(eq(exportBatches.id, first.id)),
    ).then(
      () => null,
      (e) => (e as { cause?: { code?: string } }).cause?.code,
    );
    expect(denied).toBe('42501');
    // Reported times cannot be rewritten in place either.
    const rewrite = await withContext(tdb.appDb, { organisationId: seed.organisationId, branchIds: [seed.branches.north] }, (tx) =>
      tx.execute(sql`update app.attendance_segments set paid_minutes = 999`),
    ).then(
      () => null,
      (e) => (e as { cause?: { code?: string } }).cause?.code,
    );
    expect(rewrite).toBe('42501');
  });

  it('marking arrivals does not change the booking for anyone else, and versions guard concurrent edits', async () => {
    const coord = await world.as('coordinator');
    const { seed } = world;
    const ids = await booked(coord, seed, ['petar_b'], { serviceDate: '2026-11-11' });
    const [a] = await read(coord, (tx) => tx.select().from(assignments).where(eq(assignments.id, ids.petar_b!)));
    await recordArrival(coord, ids.petar_b!, { status: 'arrived', expectedVersion: a!.version });
    await expect(recordArrival(coord, ids.petar_b!, { status: 'no_show', expectedVersion: a!.version })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});
