import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 's3-performance.spec.mjs',
  outputDir: '../../test-results/s3-performance',
  timeout: 840_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: fileURLToPath(
          new URL('../artifacts/s3-performance/browser-results.json', import.meta.url),
        ),
      },
    ],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    locale: 'zh-CN',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
