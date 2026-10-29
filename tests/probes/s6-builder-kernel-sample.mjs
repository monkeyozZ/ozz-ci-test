import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const { values, positionals } = parseArgs({
  options: {
    'wait-seconds': { type: 'string' },
    'timeline-seconds': { type: 'string' },
  },
  allowPositionals: true,
});
const [kind, id] = positionals;
const waitSeconds = Number(values['wait-seconds'] ?? 120);
const timelineSeconds = Number(values['timeline-seconds'] ?? 0);
if (
  positionals.length !== 2 ||
  !['run', 'deployment'].includes(kind) ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id ?? '') ||
  !Number.isInteger(waitSeconds) ||
  waitSeconds < 1 ||
  waitSeconds > 120 ||
  !Number.isInteger(timelineSeconds) ||
  timelineSeconds < 0 ||
  timelineSeconds > 120
)
  throw new Error('S6_KERNEL_SELECTOR_INVALID');
const root = resolve(import.meta.dirname, '../..');
const sampler = await readFile(
  resolve(root, 'tests/probes/support/s6-builder-kernel-sample.py'),
  'utf8',
);
const selector = { kind, id, waitSeconds, timelineSeconds };
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const job = promisify(execFile)(
  'ssh',
  [
    '-F',
    resolve(root, '.local/local-lab/builder/credentials/ssh_config'),
    '-o',
    'BatchMode=yes',
    'ozz-build',
    'sudo -n /usr/bin/python3 -I -B -',
  ],
  {
    cwd: root,
    timeout: (waitSeconds + timelineSeconds + 10) * 1000,
    maxBuffer: 4 * 1024 * 1024,
    signal: abort.signal,
  },
);
job.child.stdin.end(`selector = ${JSON.stringify(selector)}\n${sampler}`);
const result = JSON.parse((await job).stdout);
const report = {
  ...result,
  samplerSha256: createHash('sha256').update(sampler).digest('hex'),
};
const directory = resolve(root, '.local/local-lab/builder/b-evidence');
await mkdir(directory, { recursive: true, mode: 0o700 });
const output = resolve(directory, `kernel-${kind}-${id}-${Date.now()}.json`);
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(
  JSON.stringify({
    status: report.status,
    runId: report.runId,
    deploymentId: report.deploymentId,
    processCount: report.processes?.length ?? 0,
    parentLimits: report.parentCgroup?.values ?? null,
    solveUidAccess: report.solveUidAccess ?? null,
    report: output,
  }),
);
