const tz = 'Europe/London';

export function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return 'Not set';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(d));
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return 'Not set';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
    new Date(d),
  );
}

export function fmtDate(isoDate: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(`${isoDate}T00:00:00Z`),
  );
}

export function label(s: string): string {
  return s.replaceAll('_', ' ');
}

export function titleCase(s: string): string {
  return label(s).replace(/\b\w/g, (c) => c.toUpperCase());
}
