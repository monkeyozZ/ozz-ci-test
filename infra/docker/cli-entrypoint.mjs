import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';

// A CLI guarded by require.main must be a real Node entrypoint. The outer
// runtime-env launcher has already constructed its connection environment.
const [target, ...args] = process.argv.slice(2);
if (!target) throw new Error('A CLI entrypoint is required');
const child = spawn(process.execPath, [resolve(target), ...args], { stdio: 'inherit' });
const handlers = ['SIGTERM', 'SIGINT'].map((signal) => {
  const handler = () => child.kill(signal);
  process.on(signal, handler);
  return [signal, handler];
});
process.exitCode = await new Promise((resolveExit) => {
  child.once('error', () => {
    console.error('The runtime CLI could not be started.');
    resolveExit(1);
  });
  child.once('exit', (code, signal) =>
    resolveExit(code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1)),
  );
});
for (const [signal, handler] of handlers) process.off(signal, handler);
