// Configurable operating defaults (build plan "Proposed default" items). These are
// documented development defaults, not company policy; organisations override them in
// organisations.settings / branches.settings once management approves values.

export type OperatingPolicy = {
  /** Above this many hours to arrival: normal intake. */
  lateOrderHours: number;
  /** Below this many hours to arrival (or overdue): urgent. */
  urgentOrderHours: number;
  /** Provisional shift length reserved when the end time is unknown. */
  provisionalShiftHours: number;
  /** Minutes before required arrival that transport should arrive (site access buffer). */
  arrivalBufferMinutes: number;
  /** Urgent task acknowledgement target, minutes. */
  urgentAckMinutes: number;
  /** Default worker offer expiry, hours. */
  offerExpiryHours: number;
};

export const DEFAULT_POLICY: OperatingPolicy = {
  lateOrderHours: 12,
  urgentOrderHours: 2,
  provisionalShiftHours: 10,
  arrivalBufferMinutes: 10,
  urgentAckMinutes: 5,
  offerExpiryHours: 12,
};

export function policyFrom(...layers: unknown[]): OperatingPolicy {
  const out: OperatingPolicy = { ...DEFAULT_POLICY };
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const key of Object.keys(DEFAULT_POLICY) as (keyof OperatingPolicy)[]) {
      const v = (layer as Record<string, unknown>)[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
    }
  }
  return out;
}
