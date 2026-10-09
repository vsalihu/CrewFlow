import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction handle with trusted request context already applied. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Keep timestamptz as Date, but keep `date` (1082) as 'YYYY-MM-DD' strings so a local
// service date never shifts across a timezone boundary.
pg.types.setTypeParser(1082, (v) => v);

export type DbContext = {
  organisationId: string;
  branchIds: readonly string[];
};

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: 'cds-operations' });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema, casing: 'snake_case' });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in a transaction whose row-level-security context is the given organisation
 * and branches. Context is set with set_config(..., is_local => true), so it ends with the
 * transaction and cannot leak to the next user of a pooled connection.
 */
export async function withContext<T>(db: Db, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(ctx.organisationId)) throw new Error('invalid organisation context');
  for (const b of ctx.branchIds) if (!UUID_RE.test(b)) throw new Error('invalid branch context');
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.organisation_id', ${ctx.organisationId}, true), set_config('app.branch_ids', ${`{${ctx.branchIds.join(',')}}`}, true)`,
    );
    return fn(tx);
  });
}
