import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const baseURL = 'http://127.0.0.1:5199';

export default defineConfig({
  testDir: './local-lab',
  testMatch: [
    '**/creation-v3.spec.ts',
    '**/service-workspace-v3.spec.ts',
    '**/*-polish.spec.ts',
    '**/s5-interface.spec.ts',
    '**/s6-interface.spec.ts',
  ],
  outputDir: './artifacts/fixtures-ci/test-results',
  timeout: 120_000,
  expect: { timeout: 12_000 },
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: fileURLToPath(
          new URL('./artifacts/fixtures-ci/browser-results.json', import.meta.url),
        ),
      },
    ],
  ],
  use: {
    browserName: 'chromium',
    baseURL,
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 5199 --strictPort',
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
    // These suites intercept every API request. A missed interception must not reach the real API.
    env: { OZZ_API_PROXY: 'http://127.0.0.1:1' },
  },
});
