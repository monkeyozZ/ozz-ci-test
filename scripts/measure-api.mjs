import { fork, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { cpus, platform, release, totalmem, arch } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { seedS3Baseline, s3BaselineRoute } from '../tests/probes/s3-baseline-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseRequire = createRequire(resolve(root, 'packages/database/package.json'));
const { PrismaClient } = databaseRequire('./dist/index.js');
const runId = randomUUID().replaceAll('-', '').slice(0, 12);
const schema = `ozz_baseline_${runId}`;
const cancellation = new globalThis.AbortController();
const { values } = parseArgs({
  options: {
    duration: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '10' },
    concurrency: { type: 'string', default: '5' },
    projects: { type: 'string', default: '50' },
    scenario: { type: 'string', default: 's1' },
    'redis-mode': { type: 'string', default: 'available' },
    output: { type: 'string' },
  },
  strict: true,
});
if (!['s1', 's3'].includes(values.scenario)) throw new Error('INVALID_BASELINE_SCENARIO');
if (!['available', 'unavailable'].includes(values['redis-mode']))
  throw new Error('INVALID_BASELINE_REDIS_MODE');
const s3 = values.scenario === 's3';

function integer(value, minimum, maximum) {
  const number = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    throw new Error('INVALID_BASELINE_OPTION');
  }
  return number;
}

const settings = {
  durationSeconds: integer(values.duration, 5, 600),
  warmupSeconds: integer(values.warmup, 0, 30),
  concurrency: integer(values.concurrency, 1, 20),
  projectCount: integer(values.projects, 20, 500),
  clusterCount: 5,
  serverCount: 10,
  secretCount: 10,
  scenario: values.scenario,
  redisMode: values['redis-mode'],
  ...(s3 ? { serviceCount: 100, deploymentCount: 10_000, maxTaskAdmissionsPerClient: 20 } : {}),
};
const output = resolve(root, values.output ?? `tests/probes/results/api-baseline-${runId}.json`);
const report = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  status: 'preparing',
  scope: s3
    ? 'Local S3 API/PostgreSQL load with 100 synthetic services and 10000 deployment histories; log rendering and real workload execution have separate evidence.'
    : 'Local S1 metadata baseline; not the PRD 100-Service/10000-Deployment/10-minute gate.',
  settings,
  host: {
    platform: platform(),
    osRelease: release(),
    architecture: arch(),
    logicalCpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
    totalMemoryBytes: totalmem(),
  },
  process: {
    mode: 'production',
    build: 'apps/api/dist/main.js',
    node: process.version,
    transport: 'HTTP loopback to a production Node process; no TLS proxy or public RTT',
    instrumentation: '1 Hz process.cpuUsage/memoryUsage over IPC; no product metrics endpoint',
    logLevel: 'info',
  },
  limits: [
    'Developer machine, not Oracle or the 2-core/12-GB target.',
    s3
      ? 'Service metadata is created through the API against synthetic cluster identity fixtures; synthetic failed histories are seeded directly only in the disposable schema and are never queued.'
      : 'This S1 scenario seeds only the earlier metadata models, not Service or Deployment history.',
    'No Kubernetes/SSH/build/rollout, log-window or model-provider workload.',
    s3
      ? 'At most 20 diagnostic tasks per client exercise durable acceptance; no Worker executes this disposable schema. Queue execution/recovery is tested separately.'
      : 'No queue acceptance load is injected.',
    'The isolated schema has no Worker heartbeat; a degraded queue observation does not constitute a Redis fault test.',
    'CPU/RSS describe the isolated API process, excluding the driver, PostgreSQL, Redis and Worker.',
    'Pool wait time and per-query timing are not instrumented; database connection snapshots are database-wide.',
  ],
  cleanup: { schema, schemaDropped: false, apiStopped: false },
};
let stage = 'configuration';
let mainDb;
let db;
let api;
let schemaCreated = false;
let apiExit;
let origin;
let headers;
let logTail = '';
let s3Samples;
const pendingLogs = new Map();
const metricsSamples = [];
const stats = new Map();

const abort = () => cancellation.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

function statistics(key) {
  if (!stats.has(key))
    stats.set(key, {
      requests: 0,
      errors: 0,
      statuses: {},
      problemCodes: {},
      clientMs: [],
      serverMs: [],
      successfulClientMs: [],
      successfulServerMs: [],
    });
  return stats.get(key);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function latency(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? values.reduce((maximum, value) => Math.max(maximum, value), 0) : null,
  };
}

function summarize(value) {
  return {
    requests: value.requests,
    errors: value.errors,
    errorRate: value.requests ? value.errors / value.requests : null,
    statuses: value.statuses,
    problemCodes: value.problemCodes,
    clientLatency: latency(value.clientMs),
    serverLatency: latency(value.serverMs),
    successfulClientLatency: latency(value.successfulClientMs),
    successfulServerLatency: latency(value.successfulServerMs),
  };
}

function consumeLogs(chunk) {
  logTail += chunk.toString('utf8');
  const lines = logTail.split('\n');
  logTail = lines.pop() ?? '';
  if (logTail.length > 65536) logTail = '';
  for (const line of lines) {
    try {
      const log = JSON.parse(line);
      const route = pendingLogs.get(log.requestId);
      if (!route || !Number.isFinite(log.durationMs) || log.durationMs < 0) continue;
      for (const value of [statistics(route), statistics('all')]) {
        value.serverMs.push(log.durationMs);
        if (log.status >= 200 && log.status < 300) value.successfulServerMs.push(log.durationMs);
      }
      pendingLogs.delete(log.requestId);
    } catch {
      // Child output is consumed, never echoed or retained as unredacted diagnostics.
    }
  }
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function childMessage(type) {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      api.off('message', received);
      reject(new Error('METRICS_IPC_TIMEOUT'));
    }, 5000);
    function received(message) {
      if (message?.type !== type) return;
      clearTimeout(timer);
      api.off('message', received);
      done(message);
    }
    api.on('message', received);
  });
}

async function migrate(env) {
  const child = spawn(
    process.execPath,
    [
      databaseRequire.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      resolve(root, 'packages/database/prisma/schema.prisma'),
    ],
    {
      cwd: root,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  const stop = () => child.kill('SIGTERM');
  cancellation.signal.addEventListener('abort', stop, { once: true });
  try {
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error('ISOLATED_MIGRATION_FAILED');
  } finally {
    cancellation.signal.removeEventListener('abort', stop);
  }
}

async function waitForApi() {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline && !cancellation.signal.aborted) {
    if (apiExit) throw new Error('API_STARTUP_EXITED');
    try {
      const response = await fetch(origin + '/api/health/ready', {
        signal: globalThis.AbortSignal.timeout(1000),
      });
      const body = await response.json();
      if (response.status === 200) {
        report.initialReadiness = { status: body.status, mode: body.mode, queue: body.queue };
        return;
      }
    } catch {
      /* The private listener may still be starting. */
    }
    await delay(100);
  }
  throw new Error('API_READINESS_TIMEOUT');
}

async function seedRequest(path, payload) {
  const response = await fetch(origin + '/api' + path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: globalThis.AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (response.status !== 201 || !body.data?.id) {
    report.seedFailure = {
      path,
      status: response.status,
      code: typeof body.code === 'string' && /^[A-Z0-9_]+$/.test(body.code) ? body.code : null,
    };
    throw new Error('METADATA_SEED_FAILED');
  }
  return body.data;
}

async function dataset() {
  const counts = await Promise.all([
    db.cluster.count(),
    db.project.count(),
    db.environment.count(),
    db.server.count(),
    db.secretReference.count(),
    db.operation.count(),
    db.service.count(),
    db.deployment.count(),
    db.outbox.count(),
  ]);
  const [size] = await db.$queryRawUnsafe(
    "SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','m')",
    schema,
  );
  return {
    clusters: counts[0],
    projects: counts[1],
    environments: counts[2],
    servers: counts[3],
    secrets: counts[4],
    operations: counts[5],
    services: counts[6],
    deployments: counts[7],
    outbox: counts[8],
    schemaRelationBytes: Number(size.bytes),
  };
}

async function databaseSnapshot() {
  const [connections] = await mainDb.$queryRawUnsafe(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE state='active')::int AS active FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
  );
  return {
    scope: 'whole database; includes other idle local applications and the baseline driver',
    ...connections,
  };
}

function routeFor(worker, sequence, projects, phase) {
  if (s3) return s3BaselineRoute(worker, sequence, s3Samples, phase === 'm');
  const chosen = projects[(sequence + worker.index * 7) % projects.length];
  switch (sequence % 10) {
    case 0:
    case 6:
      return { key: 'projects.list', method: 'GET', path: '/projects?limit=20' };
    case 1:
    case 5:
      return { key: 'projects.detail', method: 'GET', path: '/projects/' + chosen.id };
    case 2:
    case 7:
      return {
        key: 'environments.list',
        method: 'GET',
        path: '/environments?limit=20&projectId=' + chosen.id,
      };
    case 3:
      return { key: 'clusters.list', method: 'GET', path: '/clusters?limit=20' };
    case 4:
      return { key: 'servers.list', method: 'GET', path: '/servers?limit=20' };
    case 8:
      return { key: 'secrets.metadata-list', method: 'GET', path: '/secrets?limit=20' };
    default:
      return {
        key: 'projects.patch',
        method: 'PATCH',
        path: '/projects/' + worker.project.id,
        payload: {
          revision: worker.project.revision,
          description: 'Measured metadata revision ' + sequence,
        },
      };
  }
}

async function exercise(worker, sequence, projects, phase) {
  const route = routeFor(worker, sequence, projects, phase);
  const requestId = `baseline-${runId}-${phase}-${worker.index}-${sequence}`;
  if (phase === 'm') pendingLogs.set(requestId, route.key);
  const started = performance.now();
  let status = 0;
  let ok = false;
  let problem = 'TRANSPORT_ERROR';
  try {
    const response = await fetch(origin + '/api' + route.path, {
      method: route.method,
      headers: {
        ...headers,
        'x-request-id': requestId,
        ...(route.expectedStatus === 202 ? { 'idempotency-key': requestId } : {}),
        ...(route.payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(route.payload ? { body: JSON.stringify(route.payload) } : {}),
      signal: globalThis.AbortSignal.any([
        cancellation.signal,
        globalThis.AbortSignal.timeout(10000),
      ]),
    });
    status = response.status;
    const body = await response.json();
    ok = status === (route.expectedStatus ?? 200) && body.data != null;
    problem =
      typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)
        ? body.code
        : 'UNEXPECTED_RESPONSE';
    if (ok && route.method === 'PATCH') {
      if (s3) worker.service.revision = body.data.revision;
      else worker.project.revision = body.data.revision;
    }
  } catch {
    /* No payload, cookies, URL credentials or internal driver errors enter the report. */
  }
  if (phase === 'm') {
    const elapsedMs = performance.now() - started;
    for (const value of [statistics(route.key), statistics('all')]) {
      value.requests++;
      value.clientMs.push(elapsedMs);
      value.statuses[status] = (value.statuses[status] ?? 0) + 1;
      if (ok) value.successfulClientMs.push(elapsedMs);
      else {
        value.errors++;
        value.problemCodes[problem] = (value.problemCodes[problem] ?? 0) + 1;
      }
    }
  } else if (!ok && !cancellation.signal.aborted) throw new Error('WARMUP_REQUEST_FAILED');
}

async function loadPhase(seconds, workers, projects, phase) {
  const end = performance.now() + seconds * 1000;
  await Promise.all(
    workers.map(async (worker) => {
      let sequence = worker.index;
      while (performance.now() < end && !cancellation.signal.aborted) {
        await exercise(worker, sequence++, projects, phase);
      }
    }),
  );
}

async function clean() {
  if (api && !apiExit) {
    const exited = once(api, 'exit');
    api.kill('SIGTERM');
    const timeout = setTimeout(() => api.kill('SIGKILL'), 8000);
    await exited;
    clearTimeout(timeout);
  }
  report.cleanup.apiStopped = !api || Boolean(apiExit);
  await db?.$disconnect();
  if (schemaCreated) {
    // The identifier is generated locally and creation must have succeeded in this invocation.
    if (!/^ozz_baseline_[a-f0-9]{12}$/.test(schema)) throw new Error('INVALID_CLEANUP_SCOPE');
    await mainDb.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    report.cleanup.schemaDropped = true;
  }
  await mainDb?.$disconnect();
}

async function measure() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('NODE_24_REQUIRED');
  const originalUrl = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(originalUrl.hostname))
    throw new Error('LOCAL_DATABASE_REQUIRED');
  const isolatedUrl = new URL(originalUrl);
  isolatedUrl.searchParams.set('schema', schema);
  const apiPackage = JSON.parse(await readFile(resolve(root, 'apps/api/package.json'), 'utf8'));
  report.versions = {
    nest: apiPackage.dependencies['@nestjs/core'],
    fastify: apiPackage.dependencies.fastify,
  };
  mainDb = new PrismaClient();
  await mainDb.$connect();
  stage = 'create-isolated-schema';
  await mainDb.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const port = await availablePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: isolatedUrl.href,
    APP_ORIGIN: 'https://baseline.invalid',
    HOST: '127.0.0.1',
    PORT: String(port),
    MASTER_KEY_FILE: resolve(root, process.env.MASTER_KEY_FILE),
    RESTORE_MODE: 'false',
    LOG_LEVEL: 'info',
  };
  if (s3) {
    stage = 'verify-redis-condition';
    if (settings.redisMode === 'unavailable') {
      const unavailable = new URL(env.REDIS_URL);
      unavailable.hostname = '127.0.0.1';
      unavailable.port = String(await availablePort());
      env.REDIS_URL = unavailable.href;
    }
    const runtimeRequire = createRequire(resolve(root, 'packages/control-plane/package.json'));
    const Redis = runtimeRequire('ioredis');
    const redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: 1000,
    });
    redis.on('error', () => undefined);
    let available = false;
    try {
      await redis.connect();
      available = (await redis.ping()) === 'PONG';
    } catch {
      // The unavailable condition uses a refused loopback endpoint, without
      // stopping or changing the shared development Redis instance.
    } finally {
      redis.disconnect(false);
    }
    report.redisCondition = {
      requested: settings.redisMode,
      pingSucceeded: available,
      injection: settings.redisMode === 'unavailable' ? 'refused loopback endpoint' : null,
      observedAt: new Date().toISOString(),
    };
    if (available !== (settings.redisMode === 'available'))
      throw new Error('REDIS_CONDITION_NOT_CONFIRMED');
  }
  stage = 'migrate-isolated-schema';
  await migrate(env);
  db = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });
  await db.$connect();
  const [version] = await db.$queryRawUnsafe('SHOW server_version');
  report.database = {
    version: version.server_version,
    isolation: 'temporary schema',
    configuredConnectionLimit: originalUrl.searchParams.get('connection_limit'),
    configuredPoolTimeoutSeconds: originalUrl.searchParams.get('pool_timeout'),
  };
  stage = 'start-production-api';
  api = fork(resolve(root, 'apps/api/dist/main.js'), [], {
    cwd: root,
    execPath: process.execPath,
    execArgv: ['--import', pathToFileURL(resolve(root, 'tests/probes/process-metrics.mjs')).href],
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  api.once('exit', (code, signal) => {
    apiExit = { code, signal };
  });
  api.once('error', () => {
    apiExit = { code: null, signal: 'spawn-error' };
  });
  api.stdout.on('data', consumeLogs);
  api.stderr.on('data', () => undefined);
  api.on('message', (message) => {
    if (message?.type === 'baseline.sample') metricsSamples.push(message);
  });
  origin = `http://127.0.0.1:${port}`;
  await waitForApi();
  report.process.pid = api.pid;
  report.process.port = port;
  const admin = await db.admin.create({
    data: { username: 'baseline-only', passwordHash: 'baseline-login-disabled' },
  });
  const token = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      adminId: admin.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  headers = { cookie: `ozz_session=${token}`, origin: env.APP_ORIGIN };
  const current = await fetch(origin + '/api/auth/me', {
    headers,
    signal: globalThis.AbortSignal.timeout(5000),
  });
  const me = await current.json();
  if (current.status !== 200 || !me.data?.csrfToken) throw new Error('ISOLATED_SESSION_FAILED');
  headers['x-csrf-token'] = me.data.csrfToken;
  stage = 'seed-representative-metadata';
  const credentials = [];
  for (let index = 0; index < settings.secretCount; index++)
    credentials.push(
      await seedRequest('/secrets', {
        name: 'Baseline credential ' + index,
        kind: index < 5 ? 'kubeconfig' : 'ssh',
        payload: { synthetic: randomBytes(24).toString('base64url') },
      }),
    );
  const clusters = [];
  for (let index = 0; index < settings.clusterCount; index++)
    clusters.push(
      await seedRequest('/clusters', {
        name: 'Baseline cluster ' + index,
        slug: 'baseline-' + index,
        apiEndpoint: `https://192.0.2.${index + 1}:6443`,
        credentialRefId: credentials[index].id,
      }),
    );
  for (let index = 0; index < settings.serverCount; index++)
    await seedRequest('/servers', {
      name: 'Baseline server ' + index,
      host: '192.0.2.' + (index + 1),
      sshUser: 'benchmark',
      credentialRefId: credentials[5 + (index % 5)].id,
      tags: ['baseline'],
    });
  const projects = [];
  for (let index = 0; index < settings.projectCount; index++) {
    const project = await seedRequest('/projects', {
      name: 'Baseline project ' + index,
      slug: 'project-' + index,
      clusterId: clusters[index % clusters.length].id,
    });
    projects.push(project);
    await seedRequest('/environments', { name: 'Staging', slug: 'staging', projectId: project.id });
  }
  if (s3) {
    stage = 'seed-s3-service-and-history-samples';
    s3Samples = await seedS3Baseline({ db, seedRequest, projects, adminId: admin.id, runId });
  }
  report.datasetSeeded = await dataset();
  const workers = Array.from({ length: settings.concurrency }, (_, index) => ({
    index,
    project: projects[index],
    ...(s3 ? { service: s3Samples.services[index], admissions: 0 } : {}),
  }));
  stage = 'warmup';
  console.log(
    JSON.stringify({
      phase: stage,
      seconds: settings.warmupSeconds,
      concurrency: settings.concurrency,
    }),
  );
  await loadPhase(settings.warmupSeconds, workers, projects, 'w');
  if (cancellation.signal.aborted) throw new Error('BASELINE_CANCELLED');
  report.datasetBefore = await dataset();
  report.databaseConnectionsBefore = await databaseSnapshot();
  stage = 'measurement';
  const started = childMessage('baseline.started');
  api.send({ type: 'baseline.start' });
  await started;
  report.measurementStartedAt = new Date().toISOString();
  const wallStart = performance.now();
  console.log(
    JSON.stringify({
      phase: stage,
      seconds: settings.durationSeconds,
      concurrency: settings.concurrency,
    }),
  );
  await loadPhase(settings.durationSeconds, workers, projects, 'm');
  report.requestWindowSeconds = (performance.now() - wallStart) / 1000;
  await delay(200);
  const stopped = childMessage('baseline.summary');
  api.send({ type: 'baseline.stop' });
  report.resources = await stopped;
  report.resourceSamples = metricsSamples;
  report.unmatchedServerLogs = pendingLogs.size;
  report.requests = summarize(statistics('all'));
  report.requests.requestsPerSecond = report.requests.requests / report.requestWindowSeconds;
  report.routes = Object.fromEntries(
    [...stats].filter(([name]) => name !== 'all').map(([name, value]) => [name, summarize(value)]),
  );
  report.methodology = {
    concurrency: 'closed-loop; five clients by default, each has at most one request in flight',
    workload: s3
      ? '20% service lists, 20% service details, 30% deployment lists, 10% deployment details, 10% service PATCH, 10% operation list/limited diagnostic admission. Five closed-loop clients by default.'
      : '20% project lists, 20% project details, 20% environment lists, 10% cluster lists, 10% server lists, 10% credential metadata, 10% revision-conditional project PATCH',
    percentile:
      'nearest rank, computed from every observed request; no automatic retries or excluded failures',
    serverLatency:
      'API production onResponse durationMs, rounded to milliseconds; correlated by synthetic request ID',
    clientLatency:
      'loopback fetch through complete JSON response; includes local transport and driver scheduling',
    cpu: 'process.cpuUsage user + system microseconds divided by elapsed wall time; 100% equals one CPU core',
    rss: 'process.memoryUsage.rss sampled each second and at stop; peak is the largest observed sample',
  };
  report.datasetAfter = await dataset();
  report.databaseConnectionsAfter = await databaseSnapshot();
  report.status = cancellation.signal.aborted
    ? 'cancelled'
    : report.requests.errors
      ? 'completed-with-errors'
      : 'completed';
}

try {
  await measure();
} catch (error) {
  cancellation.abort();
  report.status = 'failed';
  report.failure = {
    stage,
    errorType: error.name,
    code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'BASELINE_FAILED',
    constraint:
      String(error.message).match(/constraint ["']([A-Za-z0-9_]{1,120})["']/)?.[1] ?? null,
  };
  process.exitCode = 1;
} finally {
  try {
    await clean();
  } catch {
    report.cleanup.error = 'CLEANUP_FAILED';
    process.exitCode = 1;
  }
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
  report.finishedAt = new Date().toISOString();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}

if (report.status !== 'completed') process.exitCode = 1;
console.log(
  JSON.stringify({
    status: report.status,
    report: relative(root, output),
    requests: report.requests?.requests ?? 0,
    clientP95Ms: report.requests?.clientLatency.p95Ms ?? null,
    serverP95Ms: report.requests?.serverLatency.p95Ms ?? null,
    errorRate: report.requests?.errorRate ?? null,
    averageCpuPercent: report.resources?.averageCpuPercent ?? null,
    rssPeakBytes: report.resources?.rssPeakBytes ?? null,
    cleanup: report.cleanup,
  }),
);
