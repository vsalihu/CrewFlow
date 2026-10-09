// CDS background worker (build plan §15, §20).
//
// * Processes the transactional outbox: claims due events, re-checks business currency and
//   performs side effects through enabled adapters. With messaging disabled, nothing is sent.
// * Uses pg-boss (in its own "pgboss" schema) for scheduled maintenance: releasing events left by
//   a crashed worker and recording a heartbeat that monitoring can alert on.
// * Runs as the non-owner runtime role. Each event is processed under its organisation's
//   row-level-security context with a recorded system actor.

import { hostname } from 'node:os';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { createDb, createPool } from '@cds/db';
import { processOutbox, releaseStuckOutbox } from '@cds/domain';
import { ManualMessagingAdapter, SandboxMessagingAdapter, type MessagingAdapter } from '@cds/integrations';

const APP_ENV = process.env.APP_ENV ?? 'development';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  log('error', 'DATABASE_URL is required');
  process.exit(1);
}
const WORKER_NAME = process.env.WORKER_NAME ?? `worker@${hostname()}`;
const OUTBOX_POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 5000);

function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) {
  // Structured logs; never include message bodies, contact details or document contents.
  console.log(JSON.stringify({ level, time: new Date().toISOString(), worker: WORKER_NAME, message, ...extra }));
}

/** Messaging adapter selection. There is no production WhatsApp adapter until the account is verified. */
function messagingAdapter(): MessagingAdapter {
  if (APP_ENV === 'test' && process.env.MESSAGING_SANDBOX === 'true') return new SandboxMessagingAdapter('accept');
  if (process.env.WHATSAPP_ENABLED === 'true') {
    log('warn', 'WHATSAPP_ENABLED is set, but no verified WhatsApp adapter exists yet; messages stay manual.');
  }
  return new ManualMessagingAdapter();
}

const pool = createPool(DATABASE_URL, Number(process.env.WORKER_DB_POOL ?? 4));
const db = createDb(pool);
const adapters = { messaging: messagingAdapter() };

async function heartbeat(detail: Record<string, unknown> = {}) {
  await db.execute(sql`
    insert into app.worker_heartbeats (worker_name, last_seen_at, version, detail)
    values (${WORKER_NAME}, now(), ${process.env.RENDER_GIT_COMMIT ?? null}, ${JSON.stringify(detail)}::jsonb)
    on conflict (worker_name) do update set last_seen_at = excluded.last_seen_at, version = excluded.version, detail = excluded.detail`);
}

let running = true;
let processing = false;
async function outboxLoop() {
  while (running) {
    if (!processing) {
      processing = true;
      try {
        const results = await processOutbox(db, adapters, { limit: 25 });
        for (const r of results)
          log(r.outcome === 'failed' ? 'warn' : 'info', 'outbox event processed', { eventId: r.id, eventType: r.eventType, outcome: r.outcome });
      } catch (e) {
        log('error', 'outbox pass failed', { error: e instanceof Error ? e.message : String(e) });
      } finally {
        processing = false;
      }
    }
    await new Promise((r) => setTimeout(r, OUTBOX_POLL_MS));
  }
}

const boss = new PgBoss({ connectionString: DATABASE_URL, schema: 'pgboss', createSchema: false, migrate: true, max: 2 });
boss.on('error', (e) => log('error', 'pg-boss error', { error: e instanceof Error ? e.message : String(e) }));

async function main() {
  await boss.start();
  await boss.createQueue('outbox-release-stuck');
  await boss.createQueue('worker-heartbeat');
  await boss.schedule('outbox-release-stuck', '*/5 * * * *');
  await boss.schedule('worker-heartbeat', '* * * * *');
  await boss.work('outbox-release-stuck', async () => {
    const n = await releaseStuckOutbox(db, 10);
    if (n) log('warn', 'released outbox events abandoned by a crashed worker', { count: n });
  });
  await boss.work('worker-heartbeat', async () => heartbeat({ messaging: adapters.messaging.status() }));
  await heartbeat({ messaging: adapters.messaging.status(), started: true });
  log('info', 'worker started', { env: APP_ENV, messaging: adapters.messaging.status(), pollMs: OUTBOX_POLL_MS });
  void outboxLoop();
}

async function shutdown(signal: string) {
  log('info', 'shutting down', { signal });
  running = false;
  await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
  while (processing) await new Promise((r) => setTimeout(r, 200));
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((e) => {
  log('error', 'worker failed to start', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
