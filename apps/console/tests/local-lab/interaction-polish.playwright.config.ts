import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: [
    '**/*-polish.spec.ts',
    '**/creation-v3.spec.ts',
    '**/service-workspace-v3.spec.ts',
    '**/s5-interface.spec.ts',
    '**/s6-interface.spec.ts',
  ],
  outputDir: '../artifacts/interaction-polish/test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: fileURLToPath(
          new URL('../artifacts/interaction-polish/browser-results.json', import.meta.url),
        ),
      },
    ],
  ],
  use: {
    browserName: 'chromium',
    channel: process.env.CI ? undefined : 'chrome',
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  // The coordinator owns the single isolated Vite instance. Every API request
  // is intercepted by these fixtures; this config never starts another server.
});
