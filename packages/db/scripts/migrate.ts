// Applies reviewed migrations using DATABASE_MIGRATION_URL (owner credentials).
// The web process never receives these credentials.
import { migrateDatabase } from '../src/migrate';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is required');
  process.exit(1);
}
await migrateDatabase(url);
console.log('migrations applied');
