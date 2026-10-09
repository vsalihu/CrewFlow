import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { DomainError, isDomainError } from '@cds/contracts';
import type { ServiceContext } from '@cds/domain';
import { currentActor } from './session';
import { db } from './db';

// JSON API wrapper for /api/v1 (build plan §17). Handlers authenticate, validate and call
// domain services; they never contain the only copy of a business rule.
// Error body: { code, message, fieldErrors, violations, correlationId, currentVersion? }

type Handler<P> = (args: { ctx: ServiceContext; req: NextRequest; params: P; body: unknown; idempotencyKey: string | undefined }) => Promise<unknown>;

function errorBody(e: DomainError, correlationId: string) {
  return {
    code: e.code,
    message: e.message,
    fieldErrors: e.fieldErrors,
    violations: e.violations,
    correlationId,
    ...(e.currentVersion !== undefined ? { currentVersion: e.currentVersion } : {}),
  };
}

export function route<P = Record<string, string>>(handler: Handler<P>, opts: { status?: number } = {}) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID();
    try {
      // Basic CSRF/origin control for cookie-authenticated mutations.
      if (req.method !== 'GET') {
        const origin = req.headers.get('origin');
        if (origin && origin !== req.nextUrl.origin) throw new DomainError('PERMISSION_DENIED', 'Cross-origin request refused.');
      }
      const actor = await currentActor();
      if (!actor) throw new DomainError('UNAUTHENTICATED', 'Sign in to continue.');
      let body: unknown = undefined;
      if (req.method !== 'GET' && req.headers.get('content-type')?.includes('application/json')) body = await req.json();
      const idempotencyKey = req.headers.get('idempotency-key') ?? undefined;
      const result = await handler({ ctx: { db: db(), actor, requestId: correlationId }, req, params: await context.params, body, idempotencyKey });
      return NextResponse.json(result ?? { ok: true }, { status: opts.status ?? 200, headers: { 'x-correlation-id': correlationId } });
    } catch (e) {
      if (e instanceof ZodError) {
        const fieldErrors: Record<string, string[]> = {};
        for (const i of e.issues) (fieldErrors[i.path.join('.') || '_'] ??= []).push(i.message);
        return NextResponse.json(errorBody(new DomainError('VALIDATION_FAILED', 'Check the highlighted fields.', { fieldErrors }), correlationId), { status: 422 });
      }
      if (isDomainError(e)) return NextResponse.json(errorBody(e, correlationId), { status: e.status });
      console.error(JSON.stringify({ level: 'error', correlationId, message: e instanceof Error ? e.message : 'unknown error' }));
      return NextResponse.json({ code: 'INTERNAL', message: 'Something went wrong. Quote this reference if it continues.', correlationId }, { status: 500 });
    }
  };
}
