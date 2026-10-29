import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import interactionConfig from './interaction-polish.playwright.config';

// Run independently without replacing the complete interaction regression report.
const evidenceDirectory = fileURLToPath(
  new URL('../../../../.local/interaction-polish-zoom/', import.meta.url),
);

export default defineConfig(interactionConfig, {
  testMatch: ['**/zoom-polish.spec.ts'],
  outputDir: `${evidenceDirectory}test-results`,
  reporter: [['list'], ['json', { outputFile: `${evidenceDirectory}browser-results.json` }]],
  use: { screenshot: 'off', trace: 'off', video: 'off' },
});
