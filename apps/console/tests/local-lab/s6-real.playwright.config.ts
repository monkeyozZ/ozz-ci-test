import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { realArtifactDirectory, realOrigin, realRunId } from './s6-real-support';

if (process.env.E2E_BASE_URL && process.env.E2E_BASE_URL !== realOrigin)
  throw new Error('S6 real UI uses the independently configured HTTPS origin on port 51448.');

export default defineConfig({
  testDir: '.',
  testMatch: /s6-real\.spec\.ts/,
  globalSetup: './s6-real-support.ts',
  outputDir: fileURLToPath(
    new URL(`../../test-results/s6-real-product/${realRunId}`, import.meta.url),
  ),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: realArtifactDirectory + '/browser-results.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: realOrigin,
    viewport: { width: 1440, height: 1000 },
    // Scoped to this test context. The global setup independently verifies the supplied CA first.
    ignoreHTTPSErrors: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
