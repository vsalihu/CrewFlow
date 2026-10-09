import { defineConfig } from 'drizzle-kit';

// Generation only: produces reviewed DDL into ./migrations. Migrations are applied by
// scripts/migrate.ts using DATABASE_MIGRATION_URL, never by the web process.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  casing: 'snake_case',
  schemaFilter: ['app'],
});
