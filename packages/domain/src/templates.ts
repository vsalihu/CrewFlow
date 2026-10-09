import { formatInstantLocal, formatServiceDate, formatTimeLocal } from '@cds/contracts';

// Message templates. English only until other languages are human-reviewed; translation
// must never change times, names or locations. Bump a template's version whenever its
// wording changes so every sent message records exactly which text was used.

export const TEMPLATE_VERSIONS = {
  worker_offer: 1,
  worker_booking: 1,
  driver_manifest: 1,
  amendment: 1,
  cancellation: 1,
  client_receipt: 1,
  agency_acceptance: 1,
} as const;

export type ShiftFacts = {
  reference: string;
  lineNo: number;
  lineVersion: number;
  serviceDate: string;
  siteName: string;
  locationName: string | null;
  /** Only verified pins are ever included. */
  verifiedPin: string | null;
  accessInstructions: string | null;
  role: string | null;
  arrivalAt: Date | null;
  startAt: Date | null;
  endAt: Date | null;
  timezone: string;
  outboundTransport: string;
  returnTransport: string;
};

function ref(f: ShiftFacts): string {
  return `${f.reference}-${f.lineNo} v${f.lineVersion}`;
}

function when(f: ShiftFacts): string[] {
  const lines = [`Date: ${formatServiceDate(f.serviceDate)}`];
  if (f.arrivalAt) lines.push(`Arrive by: ${formatTimeLocal(f.arrivalAt, f.timezone)}`);
  if (f.startAt) lines.push(`Work starts: ${formatTimeLocal(f.startAt, f.timezone)}`);
  lines.push(`Expected finish: ${f.endAt ? formatTimeLocal(f.endAt, f.timezone) : 'not confirmed yet'}`);
  return lines;
}

function where(f: ShiftFacts): string[] {
  const lines = [`Site: ${f.siteName}${f.locationName ? ` (${f.locationName})` : ''}`];
  if (f.verifiedPin) lines.push(`Location: ${f.verifiedPin}`);
  if (f.accessInstructions) lines.push(`On arrival: ${f.accessInstructions}`);
  return lines;
}

export function workerOffer(name: string, f: ShiftFacts): string {
  return [
    `Hello ${name}, CDS has work available. Can you do this shift?`,
    '',
    ...when(f),
    ...where(f),
    `Role: ${f.role ?? 'to be confirmed'}`,
    '',
    `Reply YES ${ref(f)} to accept or NO ${ref(f)} if you cannot. This is an offer, not yet a confirmed booking.`,
  ].join('\n');
}

export function workerBooking(name: string, f: ShiftFacts): string {
  return [
    `Hello ${name}, your shift is confirmed.`,
    '',
    ...when(f),
    ...where(f),
    `Role: ${f.role ?? 'to be confirmed'}`,
    `Transport there: ${f.outboundTransport}`,
    `Transport home: ${f.returnTransport}`,
    '',
    `Please reply OK ${ref(f)} so we know you have this message.`,
  ].join('\n');
}

export function amendment(name: string, f: ShiftFacts, changes: string[]): string {
  return [
    `Hello ${name}, your shift ${f.reference} has CHANGED. The earlier details no longer apply.`,
    '',
    ...(changes.length ? ['What changed:', ...changes.map((c) => `- ${c}`), ''] : []),
    'Current details:',
    ...when(f),
    ...where(f),
    `Role: ${f.role ?? 'to be confirmed'}`,
    '',
    `Reply YES ${ref(f)} if you can still work, or NO ${ref(f)} if you cannot.`,
  ].join('\n');
}

export function cancellation(name: string, f: ShiftFacts): string {
  return [
    `Hello ${name}, your shift ${f.reference} on ${formatServiceDate(f.serviceDate)} at ${f.siteName} is CANCELLED. Please do not travel.`,
    '',
    `Please reply OK ${f.reference} so we know you have seen this.`,
  ].join('\n');
}

export type ManifestFacts = {
  reference: string;
  revisionNo: number;
  serviceDate: string;
  legType: string;
  vehicle: string;
  departureAt: Date | null;
  stops: { seq: number; purpose: string; label: string; eta: Date | null; pin: string | null; board: string[]; alight: string[] }[];
};

export function driverManifest(name: string, m: ManifestFacts): string {
  const lines = [
    `Hello ${name}, journey ${m.reference} (revision ${m.revisionNo}) for ${formatServiceDate(m.serviceDate)}, ${m.legType}.`,
    `Vehicle: ${m.vehicle}`,
    `Depart: ${m.departureAt ? formatInstantLocal(m.departureAt) : 'time to be confirmed'}`,
    '',
  ];
  for (const s of m.stops) {
    const what = s.purpose === 'pickup' ? 'Pick up' : s.purpose === 'driver_own_work' ? 'Your own shift' : 'Drop off';
    lines.push(`${s.seq}. ${s.eta ? formatTimeLocal(s.eta) : '--:--'} ${what}: ${s.label}${s.pin ? ` (${s.pin})` : ''}`);
    if (s.board.length) lines.push(`   Collect: ${s.board.join(', ')}`);
    if (s.alight.length) lines.push(`   Drop: ${s.alight.join(', ')}`);
  }
  lines.push('', `Please reply YES ${m.reference} r${m.revisionNo} to confirm you will drive these passengers on this route.`);
  return lines.join('\n');
}
