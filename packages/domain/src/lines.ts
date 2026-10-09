import { DomainError, addDays, resolveLocal, type LineInput } from '@cds/contracts';

export type LineFields = {
  serviceDate: string;
  siteId: string | null;
  workLocationId: string | null;
  role: string | null;
  requiredSkill: string | null;
  teamLabel: string | null;
  requestedCount: number;
  minimumCount: number | null;
  arrivalLocal: string | null;
  startLocal: string | null;
  startWindowEndLocal: string | null;
  endLocal: string | null;
  endDayOffset: number;
  timezone: string;
  breakRule: string | null;
  notes: string | null;
};

export type LineTimes = {
  arrivalAt: Date | null;
  startAt: Date | null;
  endAt: Date | null;
  endUnknown: boolean;
};

/** Fields whose change alters what a worker or driver agreed to. Changing one requires reconfirmation. */
export const MATERIAL_LINE_FIELDS = [
  'serviceDate',
  'siteId',
  'workLocationId',
  'role',
  'requiredSkill',
  'arrivalLocal',
  'startLocal',
  'endLocal',
  'endDayOffset',
  'timezone',
] as const satisfies readonly (keyof LineFields)[];

export const LINE_FIELDS = [
  ...MATERIAL_LINE_FIELDS,
  'teamLabel',
  'requestedCount',
  'minimumCount',
  'startWindowEndLocal',
  'breakRule',
  'notes',
] as const satisfies readonly (keyof LineFields)[];

/** Postgres `time` columns come back as HH:mm:ss; the domain uses HH:mm. */
export function hhmm(v: string | null | undefined): string | null {
  return v ? v.slice(0, 5) : null;
}

export function lineFieldsFromInput(input: LineInput): LineFields {
  return {
    serviceDate: input.serviceDate,
    siteId: input.siteId ?? null,
    workLocationId: input.workLocationId ?? null,
    role: input.role ?? null,
    requiredSkill: input.requiredSkill ?? null,
    teamLabel: input.teamLabel ?? null,
    requestedCount: input.requestedCount,
    minimumCount: input.minimumCount ?? null,
    arrivalLocal: input.arrivalLocal ?? null,
    startLocal: input.startLocal ?? null,
    startWindowEndLocal: input.startWindowEndLocal ?? null,
    endLocal: input.endLocal ?? null,
    endDayOffset: input.endDayOffset ?? 0,
    timezone: input.timezone ?? 'Europe/London',
    breakRule: input.breakRule ?? null,
    notes: input.notes ?? null,
  };
}

function resolveOrThrow(date: string, time: string, zone: string, field: string): Date {
  const r = resolveLocal(date, time, zone);
  if (r.kind === 'ok') return r.instant;
  const msg =
    r.kind === 'ambiguous'
      ? `${time} on ${date} happens twice (clocks go back). Confirm which one with the client.`
      : r.kind === 'nonexistent'
        ? `${time} on ${date} does not exist (clocks go forward). Confirm the intended time.`
        : r.reason;
  throw new DomainError('VALIDATION_FAILED', msg, { fieldErrors: { [field]: [msg] } });
}

/**
 * Convert local wall-clock fields to instants. Rejects DST-ambiguous times, end-before-start
 * without an explicit next-day flag, and arrival after start. Missing values stay null: no
 * default 07:00 is ever invented.
 */
export function computeLineTimes(f: LineFields): LineTimes {
  const errors: Record<string, string[]> = {};
  const arrivalAt = f.arrivalLocal ? resolveOrThrow(f.serviceDate, f.arrivalLocal, f.timezone, 'arrivalLocal') : null;
  const startAt = f.startLocal ? resolveOrThrow(f.serviceDate, f.startLocal, f.timezone, 'startLocal') : null;
  const endAt = f.endLocal ? resolveOrThrow(addDays(f.serviceDate, f.endDayOffset), f.endLocal, f.timezone, 'endLocal') : null;
  if (arrivalAt && startAt && arrivalAt > startAt) errors.arrivalLocal = ['Arrival must be at or before the start time.'];
  if (endAt && startAt && endAt <= startAt) {
    errors.endLocal = [
      f.endDayOffset === 0 ? 'End is before start. If the shift finishes after midnight, mark it as ending the next day.' : 'End must be after start.',
    ];
  }
  if (f.minimumCount !== null && f.minimumCount > f.requestedCount) errors.minimumCount = ['Minimum cannot exceed the requested count.'];
  if (Object.keys(errors).length) throw new DomainError('VALIDATION_FAILED', 'Check the shift details.', { fieldErrors: errors });
  return { arrivalAt, startAt, endAt, endUnknown: endAt === null };
}

/** The interval a worker is reserved for: arrival (or start) to end, or a provisional end flagged uncertain. */
export function reservationInterval(t: LineTimes, provisionalShiftHours: number): { from: Date; to: Date; uncertain: boolean } | null {
  const from = t.arrivalAt ?? t.startAt;
  if (!from || !t.startAt) return null;
  if (t.endAt) return { from, to: t.endAt, uncertain: false };
  return { from, to: new Date(t.startAt.getTime() + provisionalShiftHours * 3_600_000), uncertain: true };
}

export function tstzrange(from: Date, to: Date): string {
  return `[${from.toISOString()},${to.toISOString()})`;
}

export function parseTstzrange(r: string): { from: Date; to: Date } {
  const m = /^[[(]"?([^",]+)"?,"?([^")]+)"?[\])]$/.exec(r);
  if (!m) throw new Error(`cannot parse range ${r}`);
  return { from: new Date(m[1]!), to: new Date(m[2]!) };
}
