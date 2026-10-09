import path from 'node:path';
import { defineConfig } from '@playwright/test';

// End-to-end coordinator journeys against the production build, a real PostgreSQL database
// (created and seeded by global setup) and the development-only synthetic sign-in.
const PORT = 3300;
const dbName = 'cds_e2e';
const appPassword = process.env.CDS_APP_PASSWORD ?? 'cds_app_local';
const admin = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres');
const appUrl = new URL(admin.toString());
appUrl.pathname = `/${dbName}`;
appUrl.username = 'cds_app';
appUrl.password = appPassword;

export const E2E = { dbName, devUsersFile: path.resolve(import.meta.dirname, 'e2e/.dev-users.json') };

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `pnpm start --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { APP_ENV: 'test', DEV_AUTH: 'true', DATABASE_URL: appUrl.toString(), DEV_USERS_FILE: E2E.devUsersFile, PORT: String(PORT) },
  },
});
