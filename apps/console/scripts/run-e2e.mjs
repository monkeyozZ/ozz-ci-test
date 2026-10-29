import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const consoleRoot = fileURLToPath(new URL('../', import.meta.url));
let password = process.env.E2E_PASSWORD;
if (!password) {
  try {
    password = readFileSync(`${root}.secrets/admin-password`, 'utf8').trim();
  } catch {
    throw new Error('Set E2E_PASSWORD or initialize the isolated local administrator first.');
  }
}
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)),
    'test',
    ...process.argv.slice(2),
  ],
  {
    cwd: consoleRoot,
    env: {
      ...process.env,
      E2E_USERNAME: process.env.E2E_USERNAME ?? 'admin',
      E2E_PASSWORD: password,
    },
    stdio: 'inherit',
  },
);
process.exitCode = result.status ?? 1;
