import 'server-only';
import { createDb, createPool, type Db } from '@cds/db';
import { env } from './env';

// One pool per server process. The connection uses the non-owner runtime role (cds_app);
// every request sets its organisation/branch context transaction-locally.
const g = globalThis as unknown as { __cdsDb?: Db };

export function db(): Db {
  if (!g.__cdsDb) g.__cdsDb = createDb(createPool(env().DATABASE_URL, 10));
  return g.__cdsDb;
}
