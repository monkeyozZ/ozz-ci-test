import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const runId = process.env.S5_REAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('S5_REAL_RUN_ID must be a simple run name.');
if (process.env.PLAYWRIGHT_CHANNEL && process.env.PLAYWRIGHT_CHANNEL !== 'chrome')
  throw new Error('Real S5 acceptance requires installed system Chrome.');
if (process.env.E2E_BASE_URL && process.env.E2E_BASE_URL !== 'http://127.0.0.1:5173')
  throw new Error('Real S5 acceptance uses the configured APP_ORIGIN on port 5173.');

export default defineConfig({
  testDir: '.',
  testMatch: /s5-real\.spec\.ts/,
  outputDir: fileURLToPath(
    new URL(`../../test-results/s5-real-local-lab/${runId}`, import.meta.url),
  ),
  timeout: 900_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: fileURLToPath(
          new URL(`../artifacts/s5-real-local-lab/${runId}/browser-results.json`, import.meta.url),
        ),
      },
    ],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
