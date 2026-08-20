import { defineConfig } from '@playwright/test';
import path from 'path';

// Node 20.6+ / 24 built-in .env loader, so the project needs no dotenv
// dependency. An absent .env is not fatal here — the setup project reports the
// missing variable itself, with the fix, which is a better message than a
// module-load crash.
try {
  (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(
    path.join(__dirname, '.env')
  );
} catch {
  /* no .env, or an older Node — fall through to real environment variables */
}

export const SN_INSTANCE = (
  process.env.SN_INSTANCE || 'https://dev227442.service-now.com'
).replace(/\/$/, '');

export const AUTH_STATE = path.join(__dirname, '.auth', 'servicenow.json');

// The session's user token (g_ck). It travels with AUTH_STATE and is useless
// without it — see the note in lib/servicenow.ts on why the Table API needs it.
export const TOKEN_STATE = path.join(__dirname, '.auth', 'sn-token.json');

export const EVIDENCE_DIR = path.join(__dirname, 'evidence');
export const RESULTS_DIR = path.join(__dirname, 'results');

/** The Service Portal this app lives in, and the pages the cases drive. */
export const PORTAL = 'shiftpay';
export const PAGES = {
  home: 'shiftpay_home',
  calendar: 'fill_shift',
  manager: 'manager_approval',
} as const;

export default defineConfig({
  testDir: __dirname,

  // Service Portal bootstraps Angular after DOMContentLoaded and then fetches
  // the month, so a tight default produces flake that reads as an application
  // defect — which is the one thing this suite must not manufacture.
  timeout: 120_000,
  expect: { timeout: 20_000 },

  // Serial, single worker. Two of these cases write to a live instance and the
  // entitlement lifecycle is order-dependent; parallel workers would interleave
  // state transitions and the failures would be unreproducible.
  fullyParallel: false,
  workers: 1,

  // Never silently re-run. A retried test that passes hides a real flake, and
  // an evidence pack must record what actually happened the first time.
  retries: 0,
  forbidOnly: true,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],

  use: {
    baseURL: SN_INSTANCE,
    // Evidence, not debugging aids — these are the artefacts the docx generator
    // consumes, so they are kept on success as well as on failure.
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: true,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth[\\/]servicenow\.setup\.ts/,
    },
    {
      name: 'sp',
      testMatch: /specs[\\/]shiftpay-cases\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: AUTH_STATE },
    },
  ],
});
