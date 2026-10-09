import { DateTime } from 'luxon';

export const BUSINESS_TIMEZONE = 'Europe/London';

export type LocalResolution =
  { kind: 'ok'; instant: Date } | { kind: 'ambiguous'; candidates: [Date, Date] } | { kind: 'nonexistent' } | { kind: 'invalid'; reason: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isLocalDate(s: string): boolean {
  return DATE_RE.test(s) && DateTime.fromISO(s, { zone: 'UTC' }).isValid;
}

export function isLocalTime(s: string): boolean {
  return TIME_RE.test(s);
}

/**
 * Resolve a wall-clock date/time in a named zone to an instant.
 * Unlike a naive conversion this reports DST gaps (nonexistent) and overlaps
 * (ambiguous) so the caller can ask a person for the offset instead of guessing.
 */
export function resolveLocal(date: string, time: string, zone: string): LocalResolution {
  if (!isLocalDate(date)) return { kind: 'invalid', reason: `invalid date ${date}` };
  if (!isLocalTime(time)) return { kind: 'invalid', reason: `invalid time ${time}` };
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const probe = DateTime.fromObject({ year: y, month: mo, day: d, hour: 12 }, { zone });
  if (!probe.isValid) return { kind: 'invalid', reason: `invalid zone ${zone}` };

  const offsets = new Set<number>([probe.minus({ days: 1 }).offset, probe.offset, probe.plus({ days: 1 }).offset]);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  const found: Date[] = [];
  for (const off of offsets) {
    const candidate = new Date(wallAsUtc - off * 60_000);
    const back = DateTime.fromJSDate(candidate, { zone });
    if (back.year === y && back.month === mo && back.day === d && back.hour === h && back.minute === mi) {
      if (!found.some((f) => f.getTime() === candidate.getTime())) found.push(candidate);
    }
  }
  found.sort((a, b) => a.getTime() - b.getTime());
  if (found.length === 0) return { kind: 'nonexistent' };
  if (found.length === 1) return { kind: 'ok', instant: found[0]! };
  return { kind: 'ambiguous', candidates: [found[0]!, found[1]!] };
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days }).toISODate()!;
}

/** "Saturday 10 October 2026" — full date with the weekday computed, never typed by hand. */
export function formatServiceDate(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' }).setLocale('en-GB').toFormat('cccc d LLLL yyyy');
}

export function formatInstantLocal(instant: Date, zone: string = BUSINESS_TIMEZONE): string {
  return DateTime.fromJSDate(instant, { zone }).setLocale('en-GB').toFormat('ccc d LLL yyyy HH:mm');
}

export function formatTimeLocal(instant: Date, zone: string = BUSINESS_TIMEZONE): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('HH:mm');
}

/** Local calendar date of an instant in a zone, e.g. to resolve "tomorrow" from a message timestamp. */
export function localDateOf(instant: Date, zone: string = BUSINESS_TIMEZONE): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60_000);
}
