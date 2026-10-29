import { execFileSync, spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { PrismaClient } from '../../packages/database/dist/index.js';

const root = resolve(import.meta.dirname, '../..');
const runtimeFile = resolve(root, '.local/s3-runtime.json');
const { values, positionals } = parseArgs({
  options: { profile: { type: 'string' }, only: { type: 'string' } },
  allowPositionals: true,
});
const command = positionals[0] ?? 'status';
const profiles = {
  standard: { api: 'apps/api/dist/main.js', worker: 'apps/worker/dist/main.js' },
  's6-github': {
    api: 'tests/probes/s6-product-api.mjs',
    worker: 'tests/probes/s6-product-worker.mjs',
  },
};
if (
  !['start', 'stop', 'status'].includes(command) ||
  positionals.length > 1 ||
  (values.profile !== undefined && !Object.hasOwn(profiles, values.profile)) ||
  (values.only !== undefined && !['api', 'worker'].includes(values.only)) ||
  (command !== 'start' && (values.profile !== undefined || values.only !== undefined))
)
  throw new Error('LOCAL_RUNTIME_COMMAND_INVALID');
if (process.env.HOST && process.env.HOST !== '127.0.0.1')
  throw new Error('LOCAL_RUNTIME_REQUIRES_LOOPBACK_HOST');
const ports = {
  api: Number(process.env.PORT ?? 3000),
  worker: Number(process.env.WORKER_HEALTH_PORT ?? 3001),
};
const names = ['api', 'worker'];
const selectedNames = values.only ? [values.only] : names;
let runtime = {};
try {
  runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('LOCAL_RUNTIME_STATE_INVALID');
}
function live(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
const previousProfile = runtime.profile ?? 'standard';
if (!Object.hasOwn(profiles, previousProfile)) throw new Error('LOCAL_RUNTIME_STATE_INVALID');
const profile = values.profile ?? previousProfile;
function assertOwned(name, pid) {
  const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (
    !args.endsWith(`--env-file=.env ${profiles[previousProfile][name]}`) ||
    !cwd.split('\n').includes(`n${root}`)
  )
    throw new Error('LOCAL_RUNTIME_PROCESS_NOT_OWNED');
}
async function assertPortFree(port) {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', () => reject(new Error('LOCAL_RUNTIME_PORT_IN_USE')));
    server.listen(port, '127.0.0.1', resolveListen);
  });
  await new Promise((resolveClose) => server.close(resolveClose));
}
for (const name of names) if (live(runtime[name])) assertOwned(name, runtime[name]);

if (command === 'start') {
  if (profile !== previousProfile && names.some((name) => live(runtime[name])))
    throw new Error('LOCAL_RUNTIME_PROFILE_IN_USE');
  const childEnvironment = { ...process.env, HOST: '127.0.0.1' };
  if (profile === 's6-github') {
    const {
      readProductConfiguration,
      checkFixtureHealth,
      checkProductHttpsHealth,
      registryProxyOrigin,
      publicAppOrigin,
    } = await import('./support/s6-github-product.mjs');
    const configuration = await readProductConfiguration();
    if (configuration.proxy.upstream !== (process.env.REGISTRY_HTTP_PROXY || undefined))
      throw new Error('LOCAL_RUNTIME_PROXY_UPSTREAM_CHANGED');
    await checkFixtureHealth(configuration);
    await checkProductHttpsHealth(configuration);
    // Keep the operator's original proxy upstream and all blob-origin settings intact.
    childEnvironment.REGISTRY_HTTP_PROXY = registryProxyOrigin;
    childEnvironment.APP_ORIGIN = publicAppOrigin;
  }
  // One state file owns both profiles, including a deliberately API-only first start.
  for (const name of selectedNames) if (!live(runtime[name])) await assertPortFree(ports[name]);
  await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
  runtime.profile = profile;
  for (const name of selectedNames) {
    if (live(runtime[name])) continue;
    const log = await open(resolve(root, `.local/s3-${name}.log`), 'a', 0o600);
    try {
      const child = spawn(process.execPath, ['--env-file=.env', profiles[profile][name]], {
        cwd: root,
        env: childEnvironment,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolveSpawn, reject) => {
        child.once('spawn', resolveSpawn);
        child.once('error', () => reject(new Error('LOCAL_RUNTIME_START_FAILED')));
      });
      child.unref();
      runtime[name] = child.pid;
      await writeFile(runtimeFile, JSON.stringify(runtime, null, 2) + '\n', { mode: 0o600 });
    } finally {
      await log.close();
    }
  }
  for (const name of selectedNames) {
    const path = name === 'api' ? '/api/health/ready' : '/health/ready';
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${ports[name]}${path}`, {
          signal: globalThis.AbortSignal.timeout(1000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Keep waiting through the bounded startup window.
      }
      await delay(150);
    }
    if (!ready) throw new Error('LOCAL_RUNTIME_READINESS_TIMEOUT');
  }
}
if (command === 'stop') {
  const db = new PrismaClient();
  try {
    const counts = await Promise.all([
      db.deployment.count({ where: { status: { in: ['queued', 'running'] } } }),
      db.operation.count({ where: { status: { in: ['queued', 'running'] } } }),
    ]);
    if (counts.some(Boolean)) throw new Error('LOCAL_RUNTIME_TASKS_ACTIVE');
  } finally {
    await db.$disconnect();
  }
  for (const name of names) if (live(runtime[name])) process.kill(runtime[name], 'SIGTERM');
  const deadline = Date.now() + 15_000;
  while (names.some((name) => live(runtime[name])) && Date.now() < deadline) await delay(100);
  if (names.some((name) => live(runtime[name]))) throw new Error('LOCAL_RUNTIME_STOP_TIMEOUT');
}
console.log(
  JSON.stringify({
    command,
    profile,
    processes: Object.fromEntries(
      names.map((name) => [name, { pid: runtime[name] ?? null, running: live(runtime[name]) }]),
    ),
  }),
);
