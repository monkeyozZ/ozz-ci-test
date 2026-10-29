import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: /s5-interface\.spec\.ts/,
  outputDir: '../../test-results/s5-interface',
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
          new URL('../artifacts/s5-interface/browser-results.json', import.meta.url),
        ),
      },
    ],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
