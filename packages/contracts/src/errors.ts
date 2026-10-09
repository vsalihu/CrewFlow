export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'SITE_UNVERIFIED',
  'IDENTITY_AMBIGUOUS',
  'WORKER_UNAVAILABLE',
  'READINESS_BLOCKED',
  'CAPACITY_EXCEEDED',
  'PRIVATE_PARTY_CONFLICT',
  'STALE_CONFIRMATION',
  'STALE_PREVIEW',
  'SOURCE_CONFLICT',
  'RESOURCE_CONFLICT',
  'INVALID_STATE',
  'EXTERNAL_STATUS_UNKNOWN',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'INTEGRATION_DISABLED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Violation = { code: ErrorCode | string; message: string; subject?: string };

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SITE_UNVERIFIED: 409,
  IDENTITY_AMBIGUOUS: 409,
  WORKER_UNAVAILABLE: 409,
  READINESS_BLOCKED: 409,
  CAPACITY_EXCEEDED: 409,
  PRIVATE_PARTY_CONFLICT: 409,
  STALE_CONFIRMATION: 409,
  STALE_PREVIEW: 409,
  SOURCE_CONFLICT: 409,
  RESOURCE_CONFLICT: 409,
  INVALID_STATE: 409,
  EXTERNAL_STATUS_UNKNOWN: 409,
  PERMISSION_DENIED: 403,
  UNAUTHENTICATED: 401,
  INTEGRATION_DISABLED: 409,
};

/**
 * The one error type domain services throw for expected business failures.
 * HTTP handlers map it to { code, message, fieldErrors, violations, correlationId, currentVersion? }.
 * Messages must never contain raw SQL, stack traces or private source text.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly violations: Violation[];
  readonly fieldErrors: Record<string, string[]>;
  readonly currentVersion?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { violations?: Violation[]; fieldErrors?: Record<string, string[]>; currentVersion?: number } = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = STATUS[code];
    this.violations = opts.violations ?? [];
    this.fieldErrors = opts.fieldErrors ?? {};
    if (opts.currentVersion !== undefined) this.currentVersion = opts.currentVersion;
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}
