import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const consoleDirectory = resolve(root, 'apps/console');
let password = process.env.E2E_PASSWORD;
if (!password) {
  const file = resolve(root, process.env.E2E_PASSWORD_FILE ?? '.secrets/admin-password');
  const info = await stat(file);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) {
    throw new Error('E2E password file must be a small regular file with permissions 0600');
  }
  password = (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
}
if (password.length < 12 || password.length > 256) throw new Error('Invalid E2E password length');

// The secret is inherited in memory, never interpolated into a command line,
// saved as Playwright storage state, or included in test artifacts.
const child = spawn(
  process.execPath,
  [
    resolve(consoleDirectory, 'node_modules/@playwright/test/cli.js'),
    'test',
    ...process.argv.slice(2),
  ],
  {
    cwd: consoleDirectory,
    env: {
      ...process.env,
      E2E_USERNAME: process.env.E2E_USERNAME ?? 'admin',
      E2E_PASSWORD: password,
    },
    stdio: 'inherit',
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', () => {
  console.error('Could not start Playwright');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
