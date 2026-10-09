import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { buildTemplate, ADMIN_URL, TEMPLATE_DB, seedSyntheticOrganisation } from '@cds/test-fixtures';
import { createDb, createPool } from '@cds/db';
import { E2E } from '../playwright.config';

export default async function globalSetup() {
  await buildTemplate();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [E2E.dbName]);
  await admin.query(`drop database if exists ${E2E.dbName}`);
  await admin.query(`create database ${E2E.dbName} template ${TEMPLATE_DB}`);
  await admin.end();
  const owner = new URL(ADMIN_URL);
  owner.pathname = `/${E2E.dbName}`;
  const pool = createPool(owner.toString(), 2);
  const seed = await seedSyntheticOrganisation(createDb(pool));
  await pool.end();
  await writeFile(
    E2E.devUsersFile,
    JSON.stringify([
      { authUserId: seed.staff.coordinator.authUserId, name: 'Hana Lowell', role: 'coordinator' },
      { authUserId: seed.staff.southCoordinator.authUserId, name: 'Calum Brisk', role: 'southCoordinator' },
    ]),
  );
}
