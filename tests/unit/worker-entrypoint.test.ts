import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const worker = resolve(root, 'apps/worker/dist/main.js');
const launcher = resolve(root, 'infra/docker/runtime-env.mjs');

async function run(args: string[]) {
  const options = {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  };
  try {
    const result = await execute(process.execPath, args, options);
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout: string;
      stderr: string;
    };
    if (result.killed || typeof result.code !== 'number') throw error;
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  }
}

describe('Worker process entrypoints', () => {
  it('leaves ordinary imports idle without requiring runtime configuration', async () => {
    const result = await run([
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(worker).href)}); console.log('worker-import-completed');`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('worker-import-completed');
    expect(result.stderr).toBe('');
  });

  it.each<[string, string[]]>([
    ['direct Node execution', [worker]],
    ['the production environment launcher', [launcher, worker]],
  ])(
    'starts through %s and reports missing configuration instead of silently exiting',
    async (_, args) => {
      const result = await run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('WORKER_STARTUP_FAILED');
    },
  );
});
