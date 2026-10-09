import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, createPool, migrateDatabase, type Db } from '@cds/db';

// Test databases are real PostgreSQL. A migrated template is built once per run;
// each test file clones it, and domain code connects as the non-owner runtime role
// (cds_app) so row-level security is exercised exactly as in production.

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
export const TEMPLATE_DB = 'cds_test_template';
const APP_PASSWORD = 'cds_app_test_only';

function urlFor(db: string, user?: { name: string; password: string }): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Build the migrated template database. Called from vitest global setup. */
export async function buildTemplate(): Promise<void> {
  await admin(async (c) => {
    await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [TEMPLATE_DB]);
    await c.query(`drop database if exists ${TEMPLATE_DB}`);
    await c.query(`create database ${TEMPLATE_DB}`);
  });
  await migrateDatabase(urlFor(TEMPLATE_DB));
  await admin((c) => c.query(`alter role cds_app with login password '${APP_PASSWORD}'`));
}

export type TestDatabase = {
  name: string;
  /** Owner connection: for seeding and inspecting only. Bypasses RLS. */
  ownerDb: Db;
  ownerPool: pg.Pool;
  /** Runtime-role connection used by every domain service in tests. */
  appDb: Db;
  appPool: pg.Pool;
  appUrl: string;
  drop(): Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `cds_test_${randomBytes(5).toString('hex')}`;
  await admin((c) => c.query(`create database ${name} template ${TEMPLATE_DB}`));
  const ownerPool = createPool(urlFor(name), 3);
  const appUrl = urlFor(name, { name: 'cds_app', password: APP_PASSWORD });
  const appPool = createPool(appUrl, 8);
  return {
    name,
    ownerPool,
    ownerDb: createDb(ownerPool),
    appPool,
    appDb: createDb(appPool),
    appUrl,
    async drop() {
      await appPool.end();
      await ownerPool.end();
      await admin(async (c) => {
        await c.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [name]);
        await c.query(`drop database if exists ${name}`);
      });
    },
  };
}
