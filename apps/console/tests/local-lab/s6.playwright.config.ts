import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const runId = process.env.S6_UI_RUN_ID ?? 'latest';
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('S6_UI_RUN_ID must be a simple run name.');

export default defineConfig({
  testDir: '.',
  testMatch: /s6-interface\.spec\.ts/,
  outputDir: `../../test-results/s6-interface/${runId}`,
  timeout: 120_000,
  expect: { timeout: 12_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: fileURLToPath(
          new URL(`../artifacts/s6-interface/${runId}/browser-results.json`, import.meta.url),
        ),
      },
    ],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
