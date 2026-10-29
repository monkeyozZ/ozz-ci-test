import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs, parseEnv, promisify } from 'node:util';
import { PrismaClient } from '../../packages/database/dist/index.js';
import {
  BuildRecovery,
  BuildRecoveryBlocked,
} from '../../packages/control-plane/dist/builds/index.js';
import { SecretCipher, readMasterKeys } from '../../packages/control-plane/dist/secrets.js';
import { TaskRepository } from '../../packages/control-plane/dist/tasks/index.js';
import {
  HttpBuilderClient,
  HttpsBuilderTransport,
  hashJson,
  verifyInventoryPages,
  verifySigned,
} from '../../packages/infrastructure/dist/build.js';
import { privateFile, productRoot, registryProxyOrigin } from './support/s6-github-product.mjs';

// Preparation is not execution evidence. Only explicit phase commands act.
// Original runtime/Redis stop and start belong to root's separate idle window.
const owner = 'ozz-g-mvp-recovery-local-v1';
const directory = resolve(productRoot, '.local/local-lab/g-mvp-recovery');
const statePath = resolve(directory, 'state.json');
const runtimePath = resolve(productRoot, '.local/s3-runtime.json');
const builderDirectory = resolve(productRoot, '.local/local-lab/builder');
const databaseBackupRoot = resolve(productRoot, '.local/backups/postgresql');
const keyBackupRoot = resolve(productRoot, '.local/key-backups');
const postgresImage =
  'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const redisImage = 'redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99';
const { values, positionals } = parseArgs({
  options: {
    'old-backup': { type: 'string', default: 'g-mvp-s6-before-faults-20261026T045124227Z' },
    'source-env': { type: 'string', default: '.env' },
    'resume-redis-as-user': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
const mode = positionals[0] ?? 'status';
const modes = [
  'status',
  'prepare',
  'capture-final',
  'old',
  'old-accept',
  'final',
  'return-original',
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const backupId = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/u;
const gibibyte = 1024 ** 3;
const execute = promisify(execFile);
const attempt = `${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
const attemptDirectory = resolve(directory, attempt);
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let state, sourceEnv, sourceUrl, sourceKeyFile, sourceDb, trusted;
let stage = 'preflight';
let diskFailure;
const locks = [];
const report = {
  version: 1,
  owner,
  attempt,
  mode,
  startedAt: new Date().toISOString(),
  checks: [],
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2) +
  '\n';

function requireValue(value, code) {
  if (!value) throw new Error('GMVP_RECOVERY_' + code);
}

async function atomic(path, value) {
  const temporary = path + '.' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}
const save = () => atomic(statePath, encode(state));
async function evidence(label, value) {
  requireValue(/^[a-z0-9-]+$/u.test(label), 'EVIDENCE_LABEL_INVALID');
  const path = resolve(attemptDirectory, `${label}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, encode({ observedAt: new Date().toISOString(), ...value }), {
    mode: 0o600,
    flag: 'wx',
  });
  return path;
}
async function check(name, facts = {}) {
  const result = { name, attempt, at: new Date().toISOString(), ...facts };
  state.checks.push(result);
  report.checks.push(result);
  await save();
  console.log(JSON.stringify({ check: name, status: 'passed' }));
}
async function phase(name, action) {
  stage = name;
  if (state.completed[name]) return;
  console.log(JSON.stringify({ stage }));
  await action();
  state.completed[name] = { attempt, at: new Date().toISOString() };
  await save();
}
async function disk(minimum = 8) {
  const value = await statfs(productRoot);
  const availableBytes = value.bavail * value.bsize;
  report.minimumObservedHostFreeBytes = Math.min(
    report.minimumObservedHostFreeBytes ?? Infinity,
    availableBytes,
  );
  await evidence('disk', { availableBytes, minimumBytes: minimum * gibibyte });
  requireValue(availableBytes >= minimum * gibibyte, 'LOCAL_DISK_RESERVE_REQUIRED');
}
async function waitFor(read, accept, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    const value = await read();
    if (accept(value)) return value;
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('GMVP_RECOVERY_OBSERVATION_TIMEOUT');
}

async function runProcess(label, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execute(command, args, {
      cwd: productRoot,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 2 * 1024 * 1024,
      signal: options.ignoreAbort ? undefined : abort.signal,
    });
    await evidence(label, { startedAt, exitCode: 0 });
    return result.stdout.trim();
  } catch (error) {
    let problem;
    try {
      problem = JSON.parse(error.stderr);
    } catch {
      /* Untrusted stderr is not copied into reports. */
    }
    await evidence(label, {
      startedAt,
      exitCode: Number.isInteger(error.code) ? error.code : null,
      code: /^[A-Z][A-Z0-9_]+$/u.test(problem?.code ?? '') ? problem.code : 'SUBPROCESS_FAILED',
      ...(label === 'recovery-cli' && problem?.code === 'BUILD_RECOVERY_BLOCKED'
        ? {
            issues: Array.isArray(problem.issues)
              ? problem.issues.slice(0, 50).map((issue) => ({
                  code: /^[A-Z][A-Z0-9_]{0,79}$/u.test(issue?.code ?? '')
                    ? issue.code
                    : 'UNRECOGNIZED_RECOVERY_ISSUE',
                  builderId:
                    issue?.builderId === 'control-plane' || uuid.test(issue?.builderId ?? '')
                      ? issue.builderId
                      : null,
                  ...(uuid.test(issue?.runId ?? '') ? { runId: issue.runId } : {}),
                }))
              : [],
            omittedIssues:
              Number.isSafeInteger(problem.omittedIssues) && problem.omittedIssues >= 0
                ? problem.omittedIssues
                : null,
          }
        : {}),
    });
    throw new Error('GMVP_RECOVERY_SUBPROCESS_FAILED');
  }
}

function nodeEnvironment() {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    NODE_OPTIONS: '--max-old-space-size=1536',
  };
}
const cli = (envFile, command, args = []) =>
  runProcess(
    'recovery-cli',
    process.execPath,
    [
      `--env-file=${envFile}`,
      'apps/api/dist/cli.js',
      command,
      ...(command === 'recovery:unlock' ? ['--reconciled'] : []),
      ...args,
    ],
    { env: nodeEnvironment(), timeout: 150_000 },
  );

function database(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}
function targetUrl(sample) {
  const value = new URL(sourceUrl);
  value.pathname = '/' + sample.database;
  return value.href;
}
async function withDatabase(sample, action) {
  const db = database(targetUrl(sample));
  try {
    return await action(db);
  } finally {
    await db.$disconnect();
  }
}
async function snapshot(db) {
  const control = await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  const [builders, runs, deployments, services, operations, waitingTargets] = await Promise.all([
    db.builder.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        instanceId: true,
        identityPublicKey: true,
        endpoint: true,
        credentialRefId: true,
      },
    }),
    db.buildRun.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        deploymentId: true,
        builderId: true,
        builderInstanceId: true,
        specHash: true,
        generation: true,
        executionState: true,
        executionClosedAt: true,
        submissionAttemptedAt: true,
        endProofJson: true,
      },
    }),
    db.deployment.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        serviceId: true,
        status: true,
        generation: true,
        sourceRevisionId: true,
        snapshotJson: true,
        targetJson: true,
        artifactId: true,
        result: true,
      },
    }),
    db.service.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        mutationRevision: true,
        configRevision: true,
        publishedDeploymentId: true,
        desiredState: true,
      },
    }),
    db.operation.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, kind: true, status: true, generation: true, errorCode: true },
    }),
    db.webhookTarget.count({ where: { state: 'waiting' } }),
  ]);
  requireValue(
    runs.length <= 2000 && deployments.length <= 2000 && operations.length <= 10000,
    'LOCAL_INVENTORY_LIMIT',
  );
  return JSON.parse(
    encode({
      control: {
        installationId: control.installationId,
        generation: control.generation,
        restoreLocked: control.restoreLocked,
      },
      builders,
      runs: runs.map(({ endProofJson, ...run }) => ({
        ...run,
        proofHash: endProofJson ? hashJson(endProofJson) : null,
      })),
      deployments: deployments.map(({ snapshotJson, targetJson, result, ...item }) => ({
        ...item,
        snapshotSha256: hashJson(snapshotJson),
        targetSha256: hashJson(targetJson),
        // failureObservation is a public Task DTO field; Prisma stores it in result.
        failureObservationSha256: hashJson(result?.failureObservation ?? null),
      })),
      services,
      operations,
      waitingTargets,
    }),
  );
}
function requireIdle(value) {
  requireValue(
    value.deployments.every((item) => !['queued', 'running'].includes(item.status)) &&
      value.operations.every((item) => !['queued', 'running'].includes(item.status)) &&
      value.runs.every((run) => run.executionClosedAt) &&
      value.waitingTargets === 0,
    'SOURCE_MUST_BE_IDLE',
  );
}
async function requireRestoredIdle(sample, value) {
  requireValue(value.control.restoreLocked, 'RESTORED_WORK_ADMISSION_REQUIRES_LOCK');
  const unfinished = {
    deployments: value.deployments
      .filter((item) => ['queued', 'running'].includes(item.status))
      .map(({ id, status, generation }) => ({ id, status, generation })),
    operations: value.operations
      .filter((item) => ['queued', 'running'].includes(item.status))
      .map(({ id, kind, status, generation }) => ({ id, kind, status, generation })),
    buildRuns: value.runs
      .filter((run) => !run.executionClosedAt)
      .map(({ id, executionState, generation, submissionAttemptedAt }) => ({
        id,
        executionState,
        generation,
        submissionAttemptedAt,
      })),
    waitingWebhookTargets: value.waitingTargets,
  };
  const counts = {
    unfinishedTaskCount: unfinished.deployments.length + unfinished.operations.length,
    unclosedBuildRunCount: unfinished.buildRuns.length,
    waitingWebhookTargetCount: unfinished.waitingWebhookTargets,
  };
  const allowed = Object.values(counts).every((count) => count === 0);
  const path = await evidence(sample.name + '-restored-work-admission', {
    sample: sample.name,
    database: sample.database,
    generation: value.control.generation,
    restoreLocked: true,
    allowed,
    ...counts,
    unfinished,
    oldTaskTerminalizationTestedInThisRun: false,
  });
  sample.workAdmission = {
    allowed,
    ...counts,
    evidence: path,
    observedAt: new Date().toISOString(),
  };
  await save();
  requireValue(allowed, 'RESTORED_UNFINISHED_WORK_REQUIRES_REVIEW');
}
function retainedFacts(value) {
  return {
    builders: value.builders,
    runs: value.runs,
    deployments: value.deployments,
    services: value.services,
    operations: value.operations,
  };
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
async function portOpen(port) {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      accept(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}
async function portFree(port) {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  await new Promise((accept) => server.close(accept));
}
async function originalOffline() {
  const runtime = JSON.parse(await privateFile(dirname(runtimePath), 's3-runtime.json'));
  requireValue(!live(runtime.api) && !live(runtime.worker), 'ORIGINAL_RUNTIME_STILL_RUNNING');
  const redis = new URL(sourceEnv.REDIS_URL);
  requireValue(['127.0.0.1', 'localhost'].includes(redis.hostname), 'ORIGINAL_REDIS_NOT_LOCAL');
  const ports = {
    api: Number(sourceEnv.PORT ?? 3000),
    worker: Number(sourceEnv.WORKER_HEALTH_PORT ?? 3001),
    redis: Number(redis.port || 6379),
  };
  for (const [name, port] of Object.entries(ports))
    requireValue(!(await portOpen(port)), 'ORIGINAL_' + name.toUpperCase() + '_PORT_ACTIVE');
  requireIdle(await snapshot(sourceDb));
  state.originalOfflineFirstObservedAt ??= new Date().toISOString();
  await save();
}

async function loadTrust() {
  const operator = JSON.parse(await privateFile(builderDirectory, 'operator-config.json'));
  const pki = resolve(builderDirectory, 'pki');
  const publicKey = await readFile(resolve(builderDirectory, 'identity-public-key.pem'), 'utf8');
  const tls = {
    origin: 'https://127.0.0.1:49443',
    caCertificate: await readFile(resolve(pki, 'ca.crt'), 'utf8'),
    clientCertificate: await readFile(resolve(pki, 'client.crt'), 'utf8'),
    clientPrivateKey: await privateFile(pki, 'client.key'),
    timeoutMs: 5000,
  };
  requireValue(
    uuid.test(operator.instanceId) && uuid.test(operator.installationId),
    'BUILDER_DEPLOYMENT_IDENTITY_INVALID',
  );
  return {
    operator,
    publicKey,
    tls,
    client: new HttpBuilderClient(new HttpsBuilderTransport(tls)),
  };
}
function checkBuilderRegistration(value) {
  requireValue(
    value.control.installationId === trusted.operator.installationId &&
      value.builders.length === 1 &&
      value.builders[0].instanceId === trusted.operator.instanceId &&
      value.builders[0].endpoint === trusted.tls.origin &&
      value.builders[0].identityPublicKey === trusted.publicKey,
    'INDEPENDENT_BUILDER_DEPLOYMENT_INVENTORY_CHANGED',
  );
}
async function signedInventory(label) {
  const identityChallenge = randomBytes(32).toString('base64url');
  const signed = await trusted.client.identity(identityChallenge, abort.signal);
  const identity = verifySigned(signed, trusted.publicKey);
  requireValue(
    identity.challenge === identityChallenge &&
      identity.instanceId === trusted.operator.instanceId &&
      Math.abs(Date.now() - Date.parse(identity.checkedAt)) < 60_000,
    'BUILDER_SIGNED_IDENTITY_CHANGED',
  );
  const challenge = randomBytes(32).toString('base64url');
  const pages = [],
    seen = new Set();
  let cursor;
  do {
    requireValue(pages.length < 20, 'BUILDER_INVENTORY_PAGE_LIMIT');
    const page = await trusted.client.inventory(challenge, cursor, abort.signal);
    const checked = verifySigned(page, trusted.publicKey);
    requireValue(
      checked.totalRuns <= 2000 && checked.offset === pages.length * 100,
      'BUILDER_INVENTORY_BOUND',
    );
    pages.push(page);
    cursor = checked.nextCursor ?? undefined;
    requireValue(!cursor || !seen.has(cursor), 'BUILDER_INVENTORY_CURSOR_REPEATED');
    if (cursor) seen.add(cursor);
  } while (cursor);
  const inventory = verifyInventoryPages(pages, {
    installationId: trusted.operator.installationId,
    builderInstanceId: trusted.operator.instanceId,
    challenge,
    publicKey: trusted.publicKey,
  });
  requireValue(
    inventory.highGeneration === identity.highGeneration,
    'BUILDER_HIGH_WATER_CHANGED_DURING_READ',
  );
  await evidence(label, { identity: signed, pages });
  return inventory;
}
function requireCompleteInventory(local, remote, historical = []) {
  checkBuilderRegistration(local);
  const byId = new Map(local.runs.map((run) => [run.id, run]));
  const accepted = new Map(historical.map((run) => [run.runId, run]));
  const remoteIds = new Set(remote.runs.map((run) => run.runId));
  requireValue(
    remote.runs.every((run) => {
      const saved = byId.get(run.runId);
      if (!saved) {
        const history = accepted.get(run.runId);
        return (
          history &&
          history.builderId === local.builders[0].id &&
          history.builderInstanceId === trusted.operator.instanceId &&
          history.specHash === run.specHash &&
          history.ledgerRevision === run.ledgerRevision &&
          isDeepStrictEqual(history.epoch, run.epoch) &&
          run.executionClosed &&
          history.proofHash === run.proofHash
        );
      }
      return (
        saved &&
        saved.builderId === local.builders[0].id &&
        saved.specHash === run.specHash &&
        saved.builderInstanceId === trusted.operator.instanceId &&
        saved.executionClosedAt &&
        run.executionClosed &&
        saved.proofHash === run.proofHash
      );
    }) &&
      historical.every((run) => remoteIds.has(run.runId) && !byId.has(run.runId)) &&
      local.runs.every(
        (run) =>
          remoteIds.has(run.id) ||
          (run.executionState === 'never_submitted' &&
            run.executionClosedAt &&
            !run.submissionAttemptedAt),
      ),
    'BUILDER_COMPLETE_INVENTORY_NOT_RECONCILED',
  );
}

async function kubeInventory(label) {
  const source = await readFile(
    resolve(productRoot, 'tests/probes/support/g-mvp-recovery-k3s.py'),
    'utf8',
  );
  const resources = [];
  for (const alias of ['ozz-lab-a', 'ozz-lab-b']) {
    const parameters = { alias, installationId: trusted.operator.installationId };
    const job = execute(
      'ssh',
      [
        '-F',
        resolve(productRoot, '.local/local-lab/credentials/ssh_config'),
        '-o',
        'BatchMode=yes',
        alias,
        'sudo -n /usr/bin/python3 -I -B -',
      ],
      { cwd: productRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal: abort.signal },
    );
    job.child.stdin.end(
      `import json\nparameters = json.loads(${JSON.stringify(JSON.stringify(parameters))})\n${source}`,
    );
    const result = JSON.parse((await job).stdout);
    requireValue(result.version === 1 && Array.isArray(result.resources), 'K3S_RESPONSE_INVALID');
    resources.push(...result.resources);
  }
  await evidence(label, { resources });
  return resources;
}

async function preserveWorkloads(label) {
  const current = await kubeInventory(label);
  requireValue(
    isDeepStrictEqual(current, state.kubeBaseline),
    'K3S_RESOURCE_CHANGED_DURING_RECOVERY',
  );
}

async function writeKnownFile(path, content) {
  try {
    requireValue(
      (await privateFile(dirname(path), basename(path))) === content,
      'OWNED_FILE_CHANGED',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  }
}

async function backupPair(id) {
  requireValue(backupId.test(id), 'BACKUP_ID_INVALID');
  const databaseDirectory = resolve(databaseBackupRoot, id);
  const keyDirectory = resolve(keyBackupRoot, id);
  const databaseManifest = JSON.parse(await privateFile(databaseDirectory, 'manifest.json'));
  const keyManifest = JSON.parse(await privateFile(keyDirectory, 'manifest.json'));
  requireValue(
    databaseManifest.formatVersion === 1 &&
      databaseManifest.kind === 'ozz-control-plane' &&
      keyManifest.kind === 'ozz-master-key' &&
      databaseManifest.status === 'complete' &&
      keyManifest.status === 'complete' &&
      databaseManifest.backupId === id &&
      keyManifest.backupId === id &&
      databaseManifest.databaseSha256 === keyManifest.databaseSha256 &&
      databaseManifest.masterKeySha256 === keyManifest.masterKeySha256 &&
      databaseManifest.sourceDatabase === decodeURIComponent(new URL(sourceUrl).pathname.slice(1)),
    'BACKUP_PAIR_OR_SOURCE_CHANGED',
  );
  return { id, databaseDirectory, keyDirectory, manifest: databaseManifest };
}

function sampleEnvironment(sample, locked) {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: targetUrl(sample),
    REDIS_URL: `redis://:${sample.password}@127.0.0.1:${sample.ports.redis}/0`,
    APP_ORIGIN: `http://127.0.0.1:${sample.ports.api}`,
    HOST: '127.0.0.1',
    PORT: String(sample.ports.api),
    WORKER_HEALTH_PORT: String(sample.ports.worker),
    MASTER_KEY_FILE: sample.keyFile,
    RESTORE_MODE: locked ? 'true' : 'false',
    LOG_LEVEL: 'warn',
    POSTGRES_IMAGE: postgresImage,
    NETWORK_DNS_SERVERS: sourceEnv.NETWORK_DNS_SERVERS ?? '',
    NETWORK_LOCAL_ACME_CONFIG_FILE: sourceEnv.NETWORK_LOCAL_ACME_CONFIG_FILE ?? '',
    REGISTRY_HTTP_PROXY: registryProxyOrigin,
    REGISTRY_PROXY_BLOB_ORIGINS: sourceEnv.REGISTRY_PROXY_BLOB_ORIGINS ?? '',
  };
}

async function prepare() {
  await disk(10);
  stage = 'prepare-source-snapshot';
  const current = await snapshot(sourceDb);
  stage = 'prepare-source-admission';
  requireIdle(current);
  requireValue(!current.control.restoreLocked, 'SOURCE_ALREADY_RESTORE_LOCKED');
  checkBuilderRegistration(current);
  stage = 'prepare-backup-pair';
  const pair = await backupPair(values['old-backup']);
  stage = 'prepare-builder-inventory';
  const inventory = await signedInventory('independent-builder-inventory');
  requireCompleteInventory(current, inventory);
  const immutable = {
    installationId: current.control.installationId,
    builderId: current.builders[0].id,
    builderInstanceId: trusted.operator.instanceId,
    builderEndpoint: trusted.tls.origin,
    builderPublicKeySha256: hash(trusted.publicKey),
    builderClientCertificateSha256: hash(trusted.tls.clientCertificate),
    builderCaSha256: hash(trusted.tls.caCertificate),
    oldBackup: pair,
  };
  if (state.identities)
    requireValue(isDeepStrictEqual(state.identities, immutable), 'PREPARATION_IDENTITY_CHANGED');
  state.identities = immutable;
  state.samples ??= {};
  stage = 'prepare-sample-config';
  for (const [index, name] of ['old', 'final'].entries()) {
    const root = resolve(directory, name);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const sample = (state.samples[name] ??= {
      name,
      root,
      database: `ozz_gmvp_${name}_${state.id.replaceAll('-', '').slice(0, 16)}`,
      keyFile: resolve(root, 'restored-master-key.json'),
      envLocked: resolve(root, 'read-only.runtime'),
      envWritable: resolve(root, 'writable.runtime'),
      passwordFile: resolve(root, 'redis-password'),
      redisName: `ozz-gmvp-${state.id.slice(0, 8)}-${name}-redis`,
      volumeName: `ozz-gmvp-${state.id.slice(0, 8)}-${name}-redis-data`,
      ports: { api: 53580 + index * 10, worker: 53581 + index * 10, redis: 53582 + index * 10 },
      runtime: {},
    });
    let password;
    try {
      password = (await privateFile(root, 'redis-password')).trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      password = randomBytes(32).toString('base64url');
      await writeKnownFile(sample.passwordFile, password + '\n');
    }
    requireValue(/^[A-Za-z0-9_-]{43}$/u.test(password), 'OWNED_REDIS_PASSWORD_INVALID');
    for (const port of Object.values(sample.ports)) await portFree(port);
    for (const locked of [true, false]) {
      const content =
        Object.entries(sampleEnvironment({ ...sample, password }, locked))
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join('\n') + '\n';
      await writeKnownFile(locked ? sample.envLocked : sample.envWritable, content);
    }
  }
  stage = 'prepare-protected-inputs';
  const files = [
    state.sourceEnvFile,
    sourceKeyFile,
    ...Object.values(state.samples).flatMap((sample) => [
      sample.envLocked,
      sample.envWritable,
      sample.passwordFile,
    ]),
    resolve(productRoot, 'apps/api/dist/cli.js'),
    resolve(productRoot, 'packages/control-plane/dist/builds/recovery.js'),
    resolve(productRoot, 'packages/control-plane/dist/builds/recovery-history.js'),
    resolve(
      productRoot,
      'packages/database/prisma/migrations/202610260004_s6_git_build/migration.sql',
    ),
  ];
  const protectedHashes = Object.fromEntries(
    await Promise.all(files.map(async (path) => [path, hash(await readFile(path))])),
  );
  if (state.protectedHashes)
    requireValue(
      isDeepStrictEqual(state.protectedHashes, protectedHashes),
      'PROTECTED_INPUT_CHANGED',
    );
  state.protectedHashes = protectedHashes;
  stage = 'prepare-cached-images';
  for (const image of [postgresImage, redisImage])
    await runProcess('cached-image', 'docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  await save();
  await evidence('prepared', {
    identities: immutable,
    samples: state.samples,
    productionRecoveryCodeUsed: true,
  });
  await check('isolated-recovery-targets-and-independent-builder-identity-prepared', {
    oldDatabase: state.samples.old.database,
    finalDatabase: state.samples.final.database,
    sourceDatabasePreserved: true,
    runtimeStarted: false,
    fenceSent: false,
  });
}

async function verifyProtectedInputs() {
  for (const [name, sample] of Object.entries(state.samples)) {
    const root = resolve(directory, name);
    requireValue(
      ['old', 'final'].includes(name) &&
        sample.name === name &&
        sample.root === root &&
        sample.database === `ozz_gmvp_${name}_${state.id.replaceAll('-', '').slice(0, 16)}` &&
        sample.keyFile === resolve(root, 'restored-master-key.json') &&
        sample.envLocked === resolve(root, 'read-only.runtime') &&
        sample.envWritable === resolve(root, 'writable.runtime') &&
        sample.passwordFile === resolve(root, 'redis-password'),
      'SAMPLE_TARGET_IDENTITY_CHANGED',
    );
  }
  for (const [path, expected] of Object.entries(state.protectedHashes ?? {}))
    requireValue(hash(await readFile(path)) === expected, 'PROTECTED_INPUT_CHANGED');
  requireValue(
    hash(trusted.publicKey) === state.identities.builderPublicKeySha256 &&
      hash(trusted.tls.clientCertificate) === state.identities.builderClientCertificateSha256 &&
      hash(trusted.tls.caCertificate) === state.identities.builderCaSha256,
    'INDEPENDENT_BUILDER_TRUST_CHANGED',
  );
}

async function captureFinal() {
  await disk(10);
  const before = await snapshot(sourceDb);
  requireIdle(before);
  requireValue(!before.control.restoreLocked, 'SOURCE_ALREADY_RESTORE_LOCKED');
  requireCompleteInventory(before, await signedInventory('final-backup-builder-inventory'));
  state.finalCaptureIntent ??= { at: new Date().toISOString(), attempt, source: before };
  requireValue(
    isDeepStrictEqual(retainedFacts(before), retainedFacts(state.finalCaptureIntent.source)) &&
      before.control.generation === state.finalCaptureIntent.source.control.generation,
    'SOURCE_CHANGED_AFTER_FINAL_BACKUP_INTENT',
  );
  state.finalBackupId ??= `g-mvp-s6-final-${state.id.slice(0, 8)}-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}`;
  await save();
  let pair;
  try {
    pair = await backupPair(state.finalBackupId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const output = await runProcess(
      'final-consistent-backup',
      process.execPath,
      [
        'scripts/backup-control-plane.mjs',
        '--env-file',
        state.sourceEnvFile,
        '--database-dir',
        databaseBackupRoot,
        '--key-dir',
        keyBackupRoot,
        '--label',
        state.finalBackupId,
      ],
      { timeout: 900_000 },
    );
    const result = JSON.parse(output);
    requireValue(
      result.status === 'complete' && result.backupId === state.finalBackupId,
      'FINAL_BACKUP_NOT_CONFIRMED',
    );
    pair = await backupPair(state.finalBackupId);
  }
  const after = await snapshot(sourceDb);
  requireValue(
    isDeepStrictEqual(retainedFacts(before), retainedFacts(after)) &&
      after.control.generation === pair.manifest.generation,
    'SOURCE_CHANGED_DURING_FINAL_BACKUP',
  );
  state.finalBackup = pair;
  state.sourceSnapshot = after;
  state.kubeBaseline = await kubeInventory('before-recovery-k3s');
  requireValue(
    state.kubeBaseline.some((item) => item.kind === 'Deployment'),
    'NO_LIVE_WORKLOAD_BASELINE',
  );
  await save();
  await evidence('final-backup-baseline', { backup: pair, source: after });
  await check('idle-final-consistent-backup-and-live-workload-baseline-retained', {
    backupId: pair.id,
    generation: after.control.generation,
    buildRunCount: after.runs.length,
    unfinishedTaskCount: 0,
    oldTaskTerminalizationCoverage: 'reused-existing-S1-and-S6-PostgreSQL-regressions',
  });
}

async function createEmptyDatabase(sample) {
  requireValue(
    /^ozz_gmvp_(old|final)_[0-9a-f]{16}$/u.test(sample.database),
    'TARGET_DATABASE_NAME_INVALID',
  );
  requireValue(
    sample.database !== decodeURIComponent(new URL(sourceUrl).pathname.slice(1)),
    'SOURCE_DATABASE_REFUSED',
  );
  const savedIntent = sample.createIntent;
  sample.createIntent ??= { at: new Date().toISOString(), attempt };
  await save();
  const exists =
    await sourceDb.$queryRaw`SELECT datname FROM pg_database WHERE datname=${sample.database}`;
  requireValue(!exists.length || savedIntent, 'EXISTING_TARGET_DATABASE_REFUSED');
  if (!exists.length) {
    // Only database creation is performed here. Import/lock/generation changes use the public restore tool.
    await sourceDb.$executeRawUnsafe(`CREATE DATABASE "${sample.database}"`);
  }
}

async function restore(sample, pair) {
  await disk(10);
  await createEmptyDatabase(sample);
  const objectCount = await withDatabase(sample, async (db) => {
    const [row] =
      await db.$queryRaw`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`;
    return row.count;
  });
  if (objectCount === 0) {
    sample.restoreIntent ??= { at: new Date().toISOString(), attempt, backupId: pair.id };
    requireValue(sample.restoreIntent.backupId === pair.id, 'RESTORE_INTENT_CHANGED');
    await save();
    const output = await runProcess(
      'restore-' + sample.name,
      process.execPath,
      [
        'scripts/restore-control-plane.mjs',
        '--env-file',
        sample.envLocked,
        '--database-backup',
        pair.databaseDirectory,
        '--key-backup',
        pair.keyDirectory,
        '--target-key-file',
        sample.keyFile,
      ],
      { timeout: 900_000 },
    );
    await evidence('restore-receipt-' + sample.name, { receipt: JSON.parse(output) });
  } else requireValue(sample.restoreIntent, 'EXISTING_TARGET_DATABASE_REFUSED');
  const receipt = JSON.parse(
    await privateFile(sample.root, 'restored-master-key.json.restore.json'),
  );
  requireValue(
    receipt.backupId === pair.id &&
      receipt.database === sample.database &&
      receipt.restoreLocked === true &&
      receipt.generation === pair.manifest.generation + 1,
    'RESTORE_RECEIPT_CHANGED',
  );
  const current = await withDatabase(sample, snapshot);
  requireValue(
    current.control.restoreLocked &&
      current.control.generation === receipt.generation &&
      current.control.installationId === state.identities.installationId,
    'RESTORED_STATE_NOT_LOCKED',
  );
  if (sample.name === 'final')
    requireValue(
      isDeepStrictEqual(retainedFacts(current), retainedFacts(state.sourceSnapshot)),
      'FINAL_RESTORE_FACTS_CHANGED',
    );
  sample.restoredSnapshot = current;
  sample.restoreReceipt = receipt;
  await save();
  await check('restored-' + sample.name + '-backup-into-a-new-locked-database', {
    backupId: pair.id,
    database: sample.database,
    generation: current.control.generation,
  });
}

function isMissingDockerObject(kind, name, error) {
  if (error.code !== 1 || error.killed || error.signal || String(error.stdout ?? '').trim() !== '')
    return false;
  const expected = [
    `Error response from daemon: No such ${kind}: ${name}`,
    `Error: No such ${kind}: ${name}`,
    ...(kind === 'volume'
      ? [`Error response from daemon: get ${name}: no such volume`]
      : [`Error: No such object: ${name}`]),
  ];
  const actual = String(error.stderr ?? '')
    .trim()
    .toLowerCase();
  return expected.some((message) => message.toLowerCase() === actual);
}

async function inspectDocker(kind, name, options = {}) {
  const template =
    kind === 'volume'
      ? '{"name":{{json .Name}},"labels":{{json .Labels}}}'
      : '{"id":{{json .Id}},"image":{{json .Config.Image}},"user":{{json .Config.User}},"labels":{{json .Config.Labels}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}},"running":{{json .State.Running}}}';
  try {
    const result = await execute('docker', [kind, 'inspect', '--format', template, name], {
      cwd: productRoot,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      signal: options.ignoreAbort ? undefined : abort.signal,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    if (isMissingDockerObject(kind, name, error)) return null;
    throw new Error('GMVP_RECOVERY_DOCKER_INSPECTION_FAILED');
  }
}
function dockerOwned(value, sample) {
  requireValue(
    value?.labels?.['ozz.recovery.owner'] === owner &&
      value.labels['ozz.recovery.session'] === state.id &&
      value.labels['ozz.recovery.sample'] === sample.name,
    'DOCKER_RESOURCE_NOT_OWNED',
  );
}
function redisConfiguration(container, sample, user) {
  dockerOwned(container, sample);
  requireValue(
    container.image === redisImage &&
      container.user === user &&
      container.readOnlyRootfs === true &&
      isDeepStrictEqual(container.capDrop, ['ALL']) &&
      container.ports?.['6379/tcp']?.length === 1 &&
      container.ports['6379/tcp'][0].HostIp === '127.0.0.1' &&
      container.ports['6379/tcp'][0].HostPort === String(sample.ports.redis) &&
      container.mounts.some(
        (mount) =>
          mount.Type === 'volume' &&
          mount.Name === sample.volumeName &&
          mount.Destination === '/data' &&
          mount.RW === true,
      ),
    'OWNED_REDIS_CONFIGURATION_CHANGED',
  );
}

async function continueRedisAsUser(sample, previous) {
  const originalName = `ozz-gmvp-${state.id.slice(0, 8)}-${sample.name}-redis`;
  const replacementName = originalName + '-user';
  requireValue(
    values['resume-redis-as-user'] &&
      mode === 'old' &&
      sample.name === 'old' &&
      sample.redisName === originalName &&
      !sample.redisUserContinuation &&
      !sample.redisContainerId &&
      Object.keys(sample.runtime).length === 0 &&
      !sample.runtimeHistory?.length &&
      state.originalNeedsReconcile === true &&
      state.completed['old-restored'] &&
      !state.completed['old-read-only'],
    'REDIS_USER_CONTINUATION_NOT_ADMISSIBLE',
  );
  redisConfiguration(previous, sample, '');
  requireValue(
    previous.status === 'exited' &&
      !previous.running &&
      previous.exitCode === 1 &&
      !previous.oomKilled,
    'REDIS_USER_CONTINUATION_REQUIRES_FAILED_CONTAINER',
  );
  await portFree(sample.ports.api);
  await portFree(sample.ports.worker);
  await portFree(sample.ports.redis);
  const logs = await execute('docker', ['logs', '--tail', '80', previous.id], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    signal: abort.signal,
  });
  const output = logs.stdout + '\n' + logs.stderr;
  requireValue(
    output
      .split(/\r?\n/u)
      .some((line) =>
        line.endsWith("# Can't open or create append-only dir appendonlydir: Permission denied"),
      ),
    'REDIS_USER_CONTINUATION_FAILURE_NOT_CONFIRMED',
  );
  requireValue(
    !(await inspectDocker('container', replacementName)),
    'REDIS_USER_CONTINUATION_TARGET_ALREADY_EXISTS',
  );
  const continuation = {
    at: new Date().toISOString(),
    attempt,
    originalName,
    originalContainerId: previous.id,
    replacementName,
    user: 'redis:redis',
    volumeName: sample.volumeName,
    reason: 'APPENDONLY_DIRECTORY_PERMISSION_DENIED',
    originalLogSha256: hash(output),
    originalContainerRetained: true,
    originalVolumeRetained: true,
    sampleProcessesNeverStarted: true,
  };
  const path = await evidence('redis-user-continuation', continuation);
  sample.redisUserContinuation = { ...continuation, evidence: path };
  sample.redisName = replacementName;
  await save();
}

async function startRedis(sample) {
  stage = sample.name + '-redis-start';
  const labels = [
    '--label',
    `ozz.recovery.owner=${owner}`,
    '--label',
    `ozz.recovery.session=${state.id}`,
    '--label',
    `ozz.recovery.sample=${sample.name}`,
  ];
  let volume = await inspectDocker('volume', sample.volumeName);
  if (!volume) {
    requireValue(
      !values['resume-redis-as-user'] && !sample.redisUserContinuation,
      'REDIS_USER_CONTINUATION_REQUIRES_RETAINED_VOLUME',
    );
    await runProcess('create-owned-redis-volume', 'docker', [
      'volume',
      'create',
      ...labels,
      sample.volumeName,
    ]);
    volume = await inspectDocker('volume', sample.volumeName);
  }
  dockerOwned(volume, sample);
  const originalName = `ozz-gmvp-${state.id.slice(0, 8)}-${sample.name}-redis`;
  if (sample.redisUserContinuation) {
    const continuation = sample.redisUserContinuation;
    requireValue(
      continuation.originalName === originalName &&
        continuation.replacementName === originalName + '-user' &&
        sample.redisName === continuation.replacementName &&
        continuation.user === 'redis:redis' &&
        continuation.volumeName === sample.volumeName,
      'REDIS_USER_CONTINUATION_IDENTITY_CHANGED',
    );
    const retained = await inspectDocker('container', originalName);
    redisConfiguration(retained, sample, '');
    requireValue(
      retained.id === continuation.originalContainerId &&
        retained.status === 'exited' &&
        !retained.running &&
        retained.exitCode === 1 &&
        !retained.oomKilled,
      'REDIS_USER_CONTINUATION_EVIDENCE_CHANGED',
    );
  } else requireValue(sample.redisName === originalName, 'OWNED_REDIS_NAME_CHANGED');
  let container = await inspectDocker('container', sample.redisName);
  if (values['resume-redis-as-user'] && !sample.redisUserContinuation) {
    await continueRedisAsUser(sample, container);
    container = null;
  }
  if (!container) {
    requireValue(!sample.redisContainerId, 'OWNED_REDIS_CONTAINER_MISSING');
    await portFree(sample.ports.redis);
    const password = (await privateFile(sample.root, 'redis-password')).trim();
    await runProcess(
      'create-owned-redis',
      'docker',
      [
        'container',
        'create',
        '--pull=never',
        '--name',
        sample.redisName,
        ...labels,
        '--memory=128m',
        '--cpus=0.25',
        '--read-only',
        '--user',
        'redis:redis',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges:true',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        '--mount',
        `type=volume,src=${sample.volumeName},dst=/data`,
        '--publish',
        `127.0.0.1:${sample.ports.redis}:6379`,
        '--env',
        'REDIS_PASSWORD',
        '--env',
        'REDISCLI_AUTH',
        redisImage,
        'sh',
        '-c',
        'exec redis-server --appendonly yes --save "" --maxmemory 64mb --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD"',
      ],
      { env: { ...process.env, REDIS_PASSWORD: password, REDISCLI_AUTH: password } },
    );
    container = await inspectDocker('container', sample.redisName);
  }
  redisConfiguration(container, sample, 'redis:redis');
  requireValue(
    !sample.redisContainerId || sample.redisContainerId === container.id,
    'OWNED_REDIS_ID_CHANGED',
  );
  sample.redisContainerId = container.id;
  await save();
  if (!container.running)
    await runProcess('start-owned-redis', 'docker', ['container', 'start', sample.redisName]);
  stage = sample.name + '-redis-ready';
  await waitFor(
    async () => {
      const current = await inspectDocker('container', sample.redisName);
      redisConfiguration(current, sample, 'redis:redis');
      requireValue(current.id === container.id, 'OWNED_REDIS_ID_CHANGED');
      if (!current.running) {
        await evidence('owned-redis-start-failed', {
          sample: sample.name,
          containerId: current.id,
          status: current.status,
          exitCode: current.exitCode,
          oomKilled: current.oomKilled,
          user: current.user,
        });
        throw new Error('GMVP_RECOVERY_OWNED_REDIS_EXITED_BEFORE_READY');
      }
      try {
        return (
          (
            await execute('docker', ['exec', sample.redisName, 'redis-cli', 'ping'], {
              timeout: 3000,
              maxBuffer: 4096,
              signal: abort.signal,
            })
          ).stdout.trim() === 'PONG'
        );
      } catch {
        return false;
      }
    },
    Boolean,
    30_000,
  );
  sample.redisContainerId = container.id;
  await save();
  await evidence('owned-redis', {
    sample: sample.name,
    containerId: container.id,
    containerName: sample.redisName,
    user: container.user,
    previousContainerId: sample.redisUserContinuation?.originalContainerId ?? null,
    volume: sample.volumeName,
    retained: true,
  });
}

async function findOwnedProcess(record) {
  if (!record) return null;
  requireValue(
    record.envFile.startsWith(directory + '/') &&
      ['tests/probes/s6-product-api.mjs', 'tests/probes/s6-product-worker.mjs'].includes(
        record.entry,
      ),
    'PROCESS_INTENT_INVALID',
  );
  const tail = `--env-file=${record.envFile} ${resolve(productRoot, record.entry)}`;
  const rows = (
    await execute('ps', ['-axo', 'pid=,command='], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 })
  ).stdout
    .split('\n')
    .filter((line) => line.trimEnd().endsWith(tail));
  requireValue(rows.length <= 1, 'OWNED_PROCESS_AMBIGUOUS');
  if (!rows.length) {
    requireValue(record.stoppedAt || !live(record.pid), 'SAVED_PROCESS_IDENTITY_CHANGED');
    return null;
  }
  const pid = Number(rows[0].trim().split(/\s+/u)[0]);
  requireValue(pid > 1, 'OWNED_PROCESS_PID_INVALID');
  const cwd = (
    await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: 5000,
      maxBuffer: 16 * 1024,
    })
  ).stdout;
  requireValue(cwd.split('\n').includes(`n${productRoot}`), 'OWNED_PROCESS_CWD_CHANGED');
  const start = (
    await execute('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 5000, maxBuffer: 4096 })
  ).stdout.trim();
  requireValue(
    !record.processStart || record.processStart === start,
    'OWNED_PROCESS_START_CHANGED',
  );
  record.pid = pid;
  record.processStart = start;
  await save();
  return pid;
}

async function startRuntime(sample, locked) {
  for (const other of Object.values(state.samples)) {
    if (other === sample) continue;
    for (const record of Object.values(other.runtime))
      requireValue(!(await findOwnedProcess(record)), 'ANOTHER_SAMPLE_RUNTIME_RUNNING');
  }
  await disk(9);
  const persisted = await withDatabase(sample, async (db) =>
    db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }),
  );
  const expectReadOnly = locked || persisted.restoreLocked;
  await startRedis(sample);
  for (const name of ['api', 'worker']) {
    const envFile = locked ? sample.envLocked : sample.envWritable;
    const previous = sample.runtime[name];
    const existing = await findOwnedProcess(previous);
    if (existing) {
      requireValue(previous.envFile === envFile, 'SAMPLE_RUNTIME_MODE_CHANGED');
      continue;
    }
    if (previous) (sample.runtimeHistory ??= []).push(previous);
    const record = (sample.runtime[name] = {
      envFile,
      entry: `tests/probes/s6-product-${name}.mjs`,
      attempt,
      intendedAt: new Date().toISOString(),
    });
    await save();
    await portFree(sample.ports[name]);
    const log = await open(resolve(sample.root, `${name}-${attempt}.log`), 'a', 0o600);
    try {
      const child = spawn(
        process.execPath,
        [`--env-file=${envFile}`, resolve(productRoot, record.entry)],
        {
          cwd: productRoot,
          env: nodeEnvironment(),
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
        },
      );
      await new Promise((accept, reject) => {
        child.once('spawn', accept);
        child.once('error', reject);
      });
      child.unref();
      record.pid = child.pid;
      await save();
      await findOwnedProcess(record);
    } finally {
      await log.close();
    }
  }
  stage = sample.name + '-runtime-ready';
  let readiness;
  await waitFor(async () => {
    try {
      const api = await http(sample, '/api/health/ready');
      const worker = await http(sample, '/health/live', { worker: true });
      const heartbeatAgeMs = Date.now() - Date.parse(worker.value.lastHeartbeatAt);
      const ready =
        api.status === 200 &&
        api.value.mode === (expectReadOnly ? 'read_only' : 'read_write') &&
        worker.status === 200 &&
        worker.value.status === (expectReadOnly ? 'paused' : 'ready') &&
        worker.value.database === true &&
        Number.isFinite(heartbeatAgeMs) &&
        heartbeatAgeMs >= 0 &&
        heartbeatAgeMs < 20_000;
      if (ready)
        readiness = {
          observedAt: new Date().toISOString(),
          apiStatus: api.status,
          apiMode: api.value.mode,
          workerStatus: worker.status,
          workerMode: worker.value.status,
          workerDatabase: worker.value.database,
          workerLastHeartbeatAt: worker.value.lastHeartbeatAt,
        };
      return ready;
    } catch {
      return false;
    }
  }, Boolean);
  await evidence('sample-runtime', {
    sample: sample.name,
    processes: sample.runtime,
    environmentRestoreMode: locked,
    readOnly: expectReadOnly,
    readiness,
  });
}

async function stopRuntime(sample) {
  const selected = [];
  for (const record of Object.values(sample.runtime)) {
    const pid = await findOwnedProcess(record);
    if (pid) selected.push({ record, pid });
  }
  for (const { pid } of selected) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 20_000;
  while (selected.some(({ pid }) => live(pid)) && Date.now() < deadline) await delay(200);
  requireValue(
    selected.every(({ pid }) => !live(pid)),
    'OWNED_RUNTIME_STOP_TIMEOUT',
  );
  for (const { record } of selected) record.stoppedAt = new Date().toISOString();
  const container = await inspectDocker('container', sample.redisName, { ignoreAbort: true });
  if (container) {
    dockerOwned(container, sample);
    requireValue(
      !sample.redisContainerId || sample.redisContainerId === container.id,
      'OWNED_REDIS_ID_CHANGED',
    );
    if (container.running)
      await runProcess(
        'stop-owned-redis',
        'docker',
        ['container', 'stop', '--time', '10', sample.redisName],
        { ignoreAbort: true },
      );
  }
  await save();
  await evidence('sample-runtime-stopped', {
    sample: sample.name,
    stoppedPids: selected.map((item) => item.pid),
    databaseRetained: true,
    redisVolumeRetained: true,
  });
}

const sessions = new Map();
async function http(sample, path, options = {}) {
  requireValue(
    ['old', 'final'].includes(sample.name) && path.startsWith('/') && !path.startsWith('//'),
    'SAMPLE_HTTP_TARGET_INVALID',
  );
  const method = options.method ?? 'GET';
  requireValue(
    method === 'GET' ||
      (method === 'POST' &&
        (path === '/api/auth/login' ||
          (path === '/api/operations/diagnostics' &&
            ((sample.name === 'old' && stage === 'old-read-only') ||
              (['old', 'final'].includes(sample.name) &&
                stage === sample.name + '-diagnostic' &&
                sample.unlockedGeneration))))),
    'SAMPLE_HTTP_MUTATION_FORBIDDEN',
  );
  const session = sessions.get(sample.name);
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const origin = `http://127.0.0.1:${sample.ports.api}`;
  return new Promise((accept, reject) => {
    const request = httpRequest(
      `http://127.0.0.1:${options.worker ? sample.ports.worker : sample.ports.api}${path}`,
      {
        method,
        agent: false,
        signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(5000)]),
        headers: {
          origin,
          ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
          ...(options.key ? { 'idempotency-key': options.key } : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024)
            response.destroy(new Error('GMVP_RECOVERY_HTTP_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            accept({
              status: response.statusCode,
              headers: response.headers,
              value: JSON.parse(Buffer.concat(chunks)),
            });
          } catch {
            reject(new Error('GMVP_RECOVERY_HTTP_RESPONSE_INVALID'));
          }
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}
async function login(sample) {
  const password = (await privateFile(resolve(productRoot, '.secrets'), 'admin-password')).trim();
  const result = await http(sample, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password },
  });
  requireValue(result.status === 200, 'RESTORED_LOGIN_FAILED');
  const cookie = result.headers['set-cookie']
    ?.find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  const csrf = result.value.data.csrfToken;
  requireValue(cookie && csrf, 'RESTORED_SESSION_MISSING');
  sessions.set(sample.name, { cookie, csrf });
}
async function data(sample, path) {
  const result = await http(sample, '/api' + path);
  requireValue(result.status === 200, 'SAMPLE_API_READ_FAILED');
  return result.value.data;
}

async function ensureOriginalLocked() {
  await originalOffline();
  const before = await snapshot(sourceDb);
  requireValue(
    isDeepStrictEqual(retainedFacts(before), retainedFacts(state.sourceSnapshot)),
    'ORIGINAL_FACTS_CHANGED',
  );
  state.originalNeedsReconcile = true;
  state.originalLockIntent ??= { at: new Date().toISOString(), attempt };
  await save();
  if (!before.control.restoreLocked) await cli(state.sourceEnvFile, 'recovery:lock');
  const current = await snapshot(sourceDb);
  requireValue(
    current.control.restoreLocked &&
      current.control.generation > state.sourceSnapshot.control.generation,
    'ORIGINAL_LOCK_NOT_CONFIRMED',
  );
  state.originalLockedGeneration = current.control.generation;
  await save();
  await evidence('original-formal-lock', { control: current.control });
}

async function verifyOldReadOnly(sample) {
  await login(sample);
  const readiness = await http(sample, '/api/health/ready');
  const worker = await data(sample, '/operations/worker-status');
  const before = await withDatabase(sample, snapshot);
  requireValue(
    before.control.restoreLocked &&
      readiness.value.mode === 'read_only' &&
      worker.status === 'paused',
    'RESTORED_RUNTIME_NOT_READ_ONLY',
  );
  sample.rejectedWriteKey ??= randomUUID();
  await save();
  const rejected = await http(sample, '/api/operations/diagnostics', {
    method: 'POST',
    key: sample.rejectedWriteKey,
    body: { durationMs: 25 },
  });
  const after = await withDatabase(sample, snapshot);
  requireValue(
    rejected.status === 503 &&
      rejected.value.code === 'RESTORE_READ_ONLY' &&
      isDeepStrictEqual(retainedFacts(before), retainedFacts(after)),
    'RESTORE_WRITE_NOT_REJECTED',
  );
  await evidence('old-read-only', {
    readiness: readiness.value,
    worker,
    rejected: { status: rejected.status, code: rejected.value.code },
    source: after,
  });
  await check('old-restored-api-and-worker-remain-locked', {
    rejectedStatus: 503,
    workerStatus: worker.status,
  });
}

async function oldDifferences(sample) {
  const old = await withDatabase(sample, snapshot);
  checkBuilderRegistration(old);
  const before = await signedInventory('old-before-fence-inventory');
  const localIds = new Set(old.runs.map((run) => run.id));
  const unknownRuns = before.runs
    .filter((run) => !localIds.has(run.runId))
    .map((run) => run.runId)
    .sort();
  const webhook = JSON.parse(
    await privateFile(resolve(productRoot, '.local/local-lab/s6-webhook'), 'state.json'),
  );
  requireValue(
    webhook.running.buildRunIds.some((id) => unknownRuns.includes(id)),
    'OLD_BACKUP_HAS_NO_POST_BACKUP_WEBHOOK_RUN',
  );
  const oldServices = new Map(old.services.map((service) => [service.id, service]));
  const currentServices = new Map(
    state.sourceSnapshot.services.map((service) => [service.id, service]),
  );
  const controllers = state.kubeBaseline.filter((item) =>
    ['Deployment', 'StatefulSet'].includes(item.kind),
  );
  const unknownResources = controllers.filter(
    (item) => item.serviceId && !oldServices.has(item.serviceId),
  );
  const newerResources = controllers.filter((item) => {
    const previous = oldServices.get(item.serviceId),
      current = currentServices.get(item.serviceId);
    return (
      previous &&
      current &&
      previous.publishedDeploymentId !== current.publishedDeploymentId &&
      item.snapshotId === current.publishedDeploymentId &&
      Number(item.mutationRevision) > previous.mutationRevision
    );
  });
  requireValue(
    unknownResources.length > 0 && newerResources.length > 0,
    'LIVE_K3S_RECOVERY_DIFFERENCE_MISSING',
  );
  sample.expectedUnknownRunIds = unknownRuns;
  sample.kubeDifferences = { unknownResources, newerResources };
  await save();
  await evidence('old-backup-real-differences', { unknownRuns, unknownResources, newerResources });
  return { old, before };
}

async function oldRecoveryGate(sample) {
  const { old, before } = await oldDifferences(sample);
  await originalOffline();
  requireValue((await snapshot(sourceDb)).control.restoreLocked, 'ORIGINAL_MUST_STAY_LOCKED');
  sample.fenceIntent ??= {
    at: new Date().toISOString(),
    attempt,
    beforeHighGeneration: before.highGeneration,
  };
  await save();
  let blocked;
  try {
    await withDatabase(sample, async (db) => {
      const recovery = new BuildRecovery(
        new TaskRepository(db),
        new SecretCipher(readMasterKeys(sample.keyFile)),
        {
          clientFactory: (connection) => {
            requireValue(
              connection.origin === trusted.tls.origin &&
                hash(connection.caCertificate) === state.identities.builderCaSha256 &&
                hash(connection.clientCertificate) ===
                  state.identities.builderClientCertificateSha256,
              'RESTORED_BUILDER_TRUST_CHANGED',
            );
            const real = new HttpBuilderClient(new HttpsBuilderTransport(connection));
            return new Proxy(real, {
              get(target, name) {
                requireValue(
                  ['identity', 'fence', 'inventory', 'get'].includes(name),
                  'RECOVERY_CLIENT_MUTATION_FORBIDDEN',
                );
                return async (...args) => {
                  const value = await target[name](...args);
                  await evidence('old-production-builder-' + name, { response: value });
                  return value;
                };
              },
            });
          },
        },
      );
      // Exercise the production gate without falsely claiming unresolved differences are reconciled.
      await recovery.prepare();
    });
  } catch (error) {
    if (!(error instanceof BuildRecoveryBlocked)) throw error;
    blocked = { code: error.code, issues: error.issues };
  }
  await evidence('old-production-recovery-gate', { blocked: blocked ?? null });
  requireValue(
    blocked?.code === 'BUILD_RECOVERY_BLOCKED' &&
      blocked.issues.length > 0 &&
      blocked.issues.every((issue) => issue.code === 'UNKNOWN_REMOTE_RUN') &&
      sample.expectedUnknownRunIds.every((id) =>
        blocked.issues.some((issue) => issue.runId === id),
      ),
    'OLD_UNKNOWN_RUN_GATE_DID_NOT_REMAIN_BLOCKED',
  );
  const after = await signedInventory('old-after-fence-inventory');
  const current = await withDatabase(sample, snapshot);
  requireValue(
    after.highGeneration > before.highGeneration &&
      current.control.restoreLocked &&
      current.control.generation === old.control.generation &&
      isDeepStrictEqual(retainedFacts(current), retainedFacts(old)),
    'OLD_FENCE_OR_RESTORE_LOCK_CHANGED',
  );
  sample.blockedResult = blocked;
  sample.highGenerationAfterFence = after.highGeneration;
  await save();
  await preserveWorkloads('old-after-fence-k3s');
  await check('real-post-backup-builder-runs-block-old-restore-after-a-signed-fence', {
    unknownRunIds: sample.expectedUnknownRunIds,
    highGenerationBefore: before.highGeneration,
    highGenerationAfter: after.highGeneration,
    restoreLocked: true,
    knownNewerK3sResources: sample.kubeDifferences.newerResources.length,
    backupUnknownK3sResources: sample.kubeDifferences.unknownResources.length,
  });
}

async function readHistoryReview(sample) {
  const recorded = sample.historyReview;
  requireValue(
    recorded?.file?.startsWith(sample.root + '/history-review-'),
    'HISTORY_REVIEW_REQUIRED',
  );
  const content = await privateFile(dirname(recorded.file), basename(recorded.file));
  requireValue(hash(content) === recorded.sha256, 'HISTORY_REVIEW_FILE_CHANGED');
  const manifest = JSON.parse(content);
  requireValue(
    manifest.version === 1 &&
      manifest.kind === 'ozz-builder-recovery-history' &&
      manifest.id === recorded.id &&
      manifest.historyMetadataRestored === false &&
      manifest.scope.installationId === state.identities.installationId &&
      manifest.scope.generation === sample.restoreReceipt.generation &&
      uuid.test(manifest.scope.recoveryAuditId) &&
      isDeepStrictEqual(
        manifest.unknownRuns.map((run) => run.runId).sort(),
        sample.expectedUnknownRunIds,
      ),
    'HISTORY_REVIEW_IDENTITY_CHANGED',
  );
  return manifest;
}

async function reviewOldHistory(sample) {
  const before = await withDatabase(sample, snapshot);
  requireValue(before.control.restoreLocked, 'OLD_REVIEW_MUST_STAY_LOCKED');
  const remoteBefore = await signedInventory('old-before-review-inventory');
  if (!sample.historyReview) {
    const intent = {
      attempt,
      at: new Date().toISOString(),
      file: resolve(sample.root, 'history-review-' + randomUUID() + '.json'),
    };
    (sample.historyReviewAttempts ??= []).push(intent);
    await save();
    await cli(sample.envLocked, 'recovery:inspect', ['--output', intent.file]);
    const content = await privateFile(dirname(intent.file), basename(intent.file));
    const manifest = JSON.parse(content);
    sample.historyReview = {
      file: intent.file,
      id: manifest.id,
      sha256: hash(content),
      exportedAt: new Date().toISOString(),
    };
    await save();
  }
  const manifest = await readHistoryReview(sample);
  const audit = await withDatabase(sample, (db) =>
    db.auditEvent.findUnique({ where: { id: manifest.scope.recoveryAuditId } }),
  );
  requireValue(
    audit?.action === 'recovery.restore' && audit.metadata?.backupId === state.oldBackupId,
    'HISTORY_REVIEW_WRONG_RESTORE_INSTANCE',
  );
  const remoteAfter = await signedInventory('old-after-review-inventory');
  const current = await withDatabase(sample, snapshot);
  requireValue(
    current.control.restoreLocked &&
      remoteAfter.highGeneration === remoteBefore.highGeneration &&
      isDeepStrictEqual(remoteAfter.runs, remoteBefore.runs) &&
      isDeepStrictEqual(retainedFacts(current), retainedFacts(before)),
    'HISTORY_REVIEW_MUTATED_STATE',
  );
  for (const run of manifest.unknownRuns) {
    const payload = verifySigned(run.proof, trusted.publicKey);
    requireValue(
      payload.executionClosed &&
        payload.installationId === state.identities.installationId &&
        payload.builderInstanceId === trusted.operator.instanceId &&
        payload.runId === run.runId &&
        payload.specHash === run.specHash &&
        hashJson(run.proof) === run.proofHash,
      'HISTORY_REVIEW_PROOF_INVALID',
    );
  }
  await preserveWorkloads('old-review-k3s');
  await check('old-backup-exports-an-explicit-review-without-accepting-or-fencing', {
    manifestId: manifest.id,
    file: sample.historyReview.file,
    sha256: sample.historyReview.sha256,
    unknownRunIds: sample.expectedUnknownRunIds,
    restoreLocked: true,
    historyMetadataRestored: false,
    nextExplicitMode: 'old-accept',
  });
}

async function acceptOldHistory(sample) {
  const manifest = await readHistoryReview(sample);
  const before = await withDatabase(sample, snapshot);
  await requireRestoredIdle(sample, before);
  requireValue(before.control.restoreLocked, 'HISTORY_ACCEPTANCE_REQUIRES_LOCK');
  const remoteBefore = await signedInventory('old-before-accept-inventory');
  sample.historyAcceptanceIntent ??= {
    attempt,
    at: new Date().toISOString(),
    manifestId: manifest.id,
    sha256: sample.historyReview.sha256,
  };
  await save();
  const receipt = JSON.parse(
    await cli(sample.envLocked, 'recovery:accept', [
      '--manifest',
      sample.historyReview.file,
      '--acknowledge-missing-history',
    ]),
  );
  const audit = await withDatabase(sample, (db) =>
    db.auditEvent.findUnique({ where: { id: receipt.auditId } }),
  );
  requireValue(
    receipt.manifestId === manifest.id &&
      receipt.acceptedRunCount === manifest.unknownRuns.length &&
      receipt.restoreLocked &&
      receipt.historyMetadataRestored === false &&
      audit?.action === 'recovery:accept-builder-history' &&
      audit.resourceId === manifest.id &&
      audit.metadata?.acknowledgeMissingHistory === true &&
      audit.metadata?.manifestHash === hashJson(manifest),
    'HISTORY_ACCEPTANCE_NOT_CONFIRMED',
  );
  const current = await withDatabase(sample, snapshot);
  const remoteAfter = await signedInventory('old-after-accept-inventory');
  requireValue(
    current.control.restoreLocked &&
      isDeepStrictEqual(retainedFacts(current), retainedFacts(before)) &&
      remoteAfter.highGeneration === remoteBefore.highGeneration &&
      isDeepStrictEqual(remoteAfter.runs, remoteBefore.runs),
    'HISTORY_ACCEPTANCE_MUTATED_RUNTIME_OR_BUSINESS_HISTORY',
  );
  sample.historyAcceptanceAuditId = audit.id;
  sample.acceptedHistory = manifest.unknownRuns;
  await save();
  await check('explicitly-reviewed-closed-history-is-recorded-while-old-backup-stays-locked', {
    manifestId: manifest.id,
    auditId: audit.id,
    unknownRunIds: sample.expectedUnknownRunIds,
    restoreLocked: true,
    historyMetadataRestored: false,
  });
}

async function confirmUnlocked(db, intent) {
  const current = await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  if (current.restoreLocked) return null;
  requireValue(intent, 'UNEXPECTED_UNLOCKED_DATABASE');
  const audit = await db.auditEvent.findFirst({
    where: { action: 'recovery:unlock', createdAt: { gte: new Date(intent.at) } },
    orderBy: { createdAt: 'desc' },
  });
  requireValue(
    audit?.outcome === 'succeeded' &&
      audit.metadata?.builderInventoryVerified === true &&
      audit.metadata.generation === current.generation &&
      current.generation > intent.beforeHighGeneration,
    'FORMAL_UNLOCK_RECEIPT_MISSING',
  );
  return {
    generation: current.generation,
    auditId: audit.id,
    historyAcceptanceId: audit.metadata.historyAcceptanceId ?? null,
    acceptedUnknownRunCount: audit.metadata.acceptedUnknownRunCount ?? 0,
  };
}

async function unlockOld(sample) {
  const remoteBefore = await signedInventory('old-before-unlock-inventory');
  let confirmed = await withDatabase(sample, (db) => confirmUnlocked(db, sample.unlockIntent));
  if (!confirmed) {
    sample.unlockIntent ??= {
      at: new Date().toISOString(),
      attempt,
      beforeHighGeneration: remoteBefore.highGeneration,
    };
    await save();
    await cli(sample.envWritable, 'recovery:unlock');
    confirmed = await withDatabase(sample, (db) => confirmUnlocked(db, sample.unlockIntent));
  }
  requireValue(
    confirmed?.historyAcceptanceId === sample.historyAcceptanceAuditId &&
      confirmed.acceptedUnknownRunCount === sample.expectedUnknownRunIds.length,
    'OLD_UNLOCK_DID_NOT_USE_REVIEWED_HISTORY',
  );
  const remoteAfter = await signedInventory('old-after-unlock-inventory');
  const current = await withDatabase(sample, snapshot);
  requireValue(
    remoteAfter.highGeneration === confirmed.generation,
    'OLD_GENERATION_NOT_AT_BUILDER_HIGH_WATER',
  );
  requireCompleteInventory(current, remoteAfter, sample.acceptedHistory);
  requireValue(
    isDeepStrictEqual(retainedFacts(current), retainedFacts(sample.restoredSnapshot)),
    'OLD_UNLOCK_CHANGED_BUSINESS_HISTORY',
  );
  sample.unlockedGeneration = confirmed.generation;
  sample.unlockAuditId = confirmed.auditId;
  sample.verifiedRemoteRunIds = remoteAfter.runs.map((run) => run.runId).sort();
  await save();
  await preserveWorkloads('old-after-unlock-k3s');
  await check('old-backup-unlocks-through-explicit-history-review-and-the-production-cli', {
    generation: confirmed.generation,
    auditId: confirmed.auditId,
    historyAcceptanceId: confirmed.historyAcceptanceId,
    acceptedUnknownRunCount: confirmed.acceptedUnknownRunCount,
    historyMetadataRestored: false,
  });
}

async function unlockFinal(sample) {
  const remoteBefore = await signedInventory('final-before-unlock-inventory');
  const local = await withDatabase(sample, snapshot);
  requireCompleteInventory(local, remoteBefore);
  let confirmed = await withDatabase(sample, (db) => confirmUnlocked(db, sample.unlockIntent));
  if (!confirmed) {
    sample.unlockIntent ??= {
      at: new Date().toISOString(),
      attempt,
      beforeHighGeneration: remoteBefore.highGeneration,
    };
    await save();
    await cli(sample.envWritable, 'recovery:unlock');
    confirmed = await withDatabase(sample, (db) => confirmUnlocked(db, sample.unlockIntent));
  }
  requireValue(confirmed, 'FINAL_UNLOCK_NOT_CONFIRMED');
  const remoteAfter = await signedInventory('final-after-unlock-inventory');
  requireValue(
    remoteAfter.highGeneration === confirmed.generation,
    'FINAL_GENERATION_NOT_AT_BUILDER_HIGH_WATER',
  );
  requireCompleteInventory(await withDatabase(sample, snapshot), remoteAfter);
  sample.unlockedGeneration = confirmed.generation;
  sample.unlockAuditId = confirmed.auditId;
  sample.verifiedRemoteRunIds = remoteAfter.runs.map((run) => run.runId).sort();
  await save();
  await check('complete-final-backup-unlocks-through-the-production-cli', {
    generation: confirmed.generation,
    auditId: confirmed.auditId,
    signedInventoryRuns: remoteAfter.totalRuns,
  });
}

async function recoveredDiagnostic(sample) {
  await login(sample);
  await waitFor(
    () => data(sample, '/operations/worker-status'),
    (value) => value.status === 'ready',
  );
  sample.diagnosticIntent ??= {
    at: new Date().toISOString(),
    attempt,
    key: randomUUID(),
    body: { durationMs: 25 },
  };
  await save();
  if (!sample.diagnosticIntent.id) {
    const accepted = await http(sample, '/api/operations/diagnostics', {
      method: 'POST',
      key: sample.diagnosticIntent.key,
      body: sample.diagnosticIntent.body,
    });
    requireValue(
      accepted.status === 202 && uuid.test(accepted.value.data.id),
      'NEW_DIAGNOSTIC_NOT_ACCEPTED',
    );
    sample.diagnosticIntent.id = accepted.value.data.id;
    await save();
    await evidence('new-diagnostic-accepted', { task: accepted.value.data });
  }
  const task = await waitFor(
    async () => {
      const value = await data(sample, '/operations/' + sample.diagnosticIntent.id);
      requireValue(!['failed', 'cancelled'].includes(value.status), 'NEW_DIAGNOSTIC_FAILED');
      return value;
    },
    (value) => value.status === 'succeeded',
  );
  const current = await withDatabase(sample, snapshot);
  const row = current.operations.find((item) => item.id === task.id);
  const retained = {
    ...current,
    operations: current.operations.filter((item) => item.id !== task.id),
  };
  requireValue(
    row?.generation === sample.unlockedGeneration &&
      row.kind === 'diagnostic' &&
      isDeepStrictEqual(retainedFacts(retained), retainedFacts(sample.restoredSnapshot)),
    'FINAL_HISTORY_OR_DIAGNOSTIC_GENERATION_CHANGED',
  );
  const remote = await signedInventory(sample.name + '-after-diagnostic-inventory');
  requireValue(
    isDeepStrictEqual(remote.runs.map((run) => run.runId).sort(), sample.verifiedRemoteRunIds),
    'DIAGNOSTIC_CREATED_A_BUILD_RUN',
  );
  requireCompleteInventory(current, remote, sample.acceptedHistory);
  await preserveWorkloads(sample.name + '-after-diagnostic-k3s');
  await evidence('new-diagnostic-succeeded', { task, generation: row.generation });
  await check('new-generation-diagnostic-succeeds-without-replaying-workloads-or-builds', {
    sample: sample.name,
    operationId: task.id,
    generation: row.generation,
    restoredUnfinishedTaskCount: 0,
    oldTaskTerminalizationTestedInThisRun: false,
    oldTaskTerminalizationEvidence: 'existing-S1-and-S6-PostgreSQL-regressions',
  });
}

async function withRuntimeCleanup(sample, action) {
  let failure;
  let result;
  try {
    result = await action();
  } catch (error) {
    failure = error;
  }
  try {
    await stopRuntime(sample);
  } catch (error) {
    (report.cleanupIssues ??= []).push({
      sample: sample.name,
      code: /^GMVP_RECOVERY_[A-Z0-9_]+$/u.test(error.message ?? '')
        ? error.message
        : 'GMVP_RECOVERY_OWNED_CLEANUP_FAILED',
    });
    failure ??= error;
  }
  if (failure) throw failure;
  return result;
}

async function oldSample() {
  const sample = state.samples.old;
  await ensureOriginalLocked();
  await phase('old-restored', () => restore(sample, state.identities.oldBackup));
  await withRuntimeCleanup(sample, async () => {
    await startRuntime(sample, true);
    await phase('old-read-only', () => verifyOldReadOnly(sample));
    await phase('old-idle-admission', async () =>
      requireRestoredIdle(sample, await withDatabase(sample, snapshot)),
    );
    await phase('old-builder-gate', () => oldRecoveryGate(sample));
    await phase('old-review-manifest', () => reviewOldHistory(sample));
  });
}

async function oldAcceptedSample() {
  const sample = state.samples.old;
  requireValue(state.completed.old, 'OLD_REVIEW_NOT_FINISHED');
  await ensureOriginalLocked();
  await stopRuntime(sample);
  await withRuntimeCleanup(sample, async () => {
    await phase('old-history-accepted', () => acceptOldHistory(sample));
    await startRuntime(sample, false);
    await phase('old-unlocked', () => unlockOld(sample));
    await phase('old-diagnostic', () => recoveredDiagnostic(sample));
  });
}

async function finalSample() {
  const sample = state.samples.final;
  requireValue(state.completed['old-accept'], 'OLD_SAMPLE_NOT_FINISHED');
  await ensureOriginalLocked();
  await phase('final-restored', () => restore(sample, state.finalBackup));
  await withRuntimeCleanup(sample, async () => {
    const current = await withDatabase(sample, snapshot);
    requireCompleteInventory(current, await signedInventory('final-restored-inventory'));
    if (!sample.unlockIntent) requireIdle(current);
    if (current.control.restoreLocked && !state.completed['final-read-only']) {
      await startRuntime(sample, true);
      await phase('final-read-only', async () => {
        const value = await http(sample, '/api/health/ready');
        requireValue(value.value.mode === 'read_only', 'FINAL_RESTORE_NOT_READ_ONLY');
        await evidence('final-read-only', { readiness: value.value, control: current.control });
      });
      await stopRuntime(sample);
    }
    await startRuntime(sample, false);
    await phase('final-unlocked', () => unlockFinal(sample));
    await phase('final-diagnostic', () => recoveredDiagnostic(sample));
  });
}

async function returnOriginal() {
  requireValue(
    state.originalNeedsReconcile || state.originalReturnIntent,
    'ORIGINAL_RECOVERY_NOT_STARTED',
  );
  await originalOffline();
  for (const sample of Object.values(state.samples)) await stopRuntime(sample);
  await verifyProtectedInputs();
  const source = await snapshot(sourceDb);
  requireValue(
    isDeepStrictEqual(retainedFacts(source), retainedFacts(state.sourceSnapshot)),
    'ORIGINAL_FACTS_CHANGED',
  );
  const remoteBefore = await signedInventory('original-before-return-inventory');
  requireCompleteInventory(source, remoteBefore);
  let confirmed = await confirmUnlocked(sourceDb, state.originalReturnIntent);
  if (!confirmed) {
    state.originalReturnIntent ??= {
      at: new Date().toISOString(),
      attempt,
      beforeHighGeneration: remoteBefore.highGeneration,
    };
    await save();
    await cli(state.sourceEnvFile, 'recovery:lock');
    await cli(state.sourceEnvFile, 'recovery:unlock');
    confirmed = await confirmUnlocked(sourceDb, state.originalReturnIntent);
  }
  requireValue(confirmed, 'ORIGINAL_UNLOCK_NOT_CONFIRMED');
  const after = await signedInventory('original-after-return-inventory');
  const restored = await snapshot(sourceDb);
  requireCompleteInventory(restored, after);
  requireValue(
    after.highGeneration === confirmed.generation &&
      !restored.control.restoreLocked &&
      isDeepStrictEqual(retainedFacts(restored), retainedFacts(state.sourceSnapshot)),
    'ORIGINAL_HIGH_WATER_NOT_RECONCILED',
  );
  await preserveWorkloads('original-return-k3s');
  state.originalNeedsReconcile = false;
  state.originalReturnedGeneration = confirmed.generation;
  await save();
  await check('original-control-plane-formally-reconciles-every-raised-builder-generation', {
    generation: confirmed.generation,
    auditId: confirmed.auditId,
    originalRuntimeRestartedByDriver: false,
    originalEnvAndKeyPreserved: true,
  });
}

function summary() {
  return state
    ? {
        owner,
        id: state.id,
        completed: state.completed,
        oldBackupId: state.oldBackupId,
        finalBackupId: state.finalBackupId ?? null,
        originalNeedsReconcile: state.originalNeedsReconcile ?? false,
        originalOfflineFirstObservedAt: state.originalOfflineFirstObservedAt ?? null,
        originalReturnedGeneration: state.originalReturnedGeneration ?? null,
        oldBlockedIssues: state.samples?.old?.blockedResult?.issues ?? [],
        oldWorkAdmission: state.samples?.old?.workAdmission ?? null,
        oldReviewFile: state.samples?.old?.historyReview?.file ?? null,
        oldHistoryAcceptanceId: state.samples?.old?.historyAcceptanceAuditId ?? null,
        oldUnlockedGeneration: state.samples?.old?.unlockedGeneration ?? null,
        oldNewDiagnosticId: state.samples?.old?.diagnosticIntent?.id ?? null,
        finalUnlockedGeneration: state.samples?.final?.unlockedGeneration ?? null,
        newDiagnosticId: state.samples?.final?.diagnosticIntent?.id ?? null,
        databases: Object.values(state.samples ?? {}).map((sample) => sample.database),
        acceptanceComplete: Boolean(
          state.completed.old &&
          state.completed['old-accept'] &&
          state.completed.final &&
          state.completed['return-original'],
        ),
        oldTaskTerminalizationTestedInThisRun: false,
      }
    : { owner, status: 'not-prepared' };
}

async function main() {
  requireValue(
    process.versions.node.split('.')[0] === '24' &&
      positionals.length <= 1 &&
      modes.includes(mode) &&
      (!values['resume-redis-as-user'] || mode === 'old'),
    'USAGE_INVALID',
  );
  try {
    state = JSON.parse(await privateFile(directory, 'state.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  requireValue(
    !state || (state.owner === owner && state.version === 1 && uuid.test(state.id)),
    'STATE_IDENTITY_CHANGED',
  );
  if (mode === 'status') {
    console.log(JSON.stringify(summary()));
    return;
  }
  requireValue(state || mode === 'prepare', 'PREPARE_REQUIRED');
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(attemptDirectory, { mode: 0o700 });
  let monitoring = false;
  const monitor = setInterval(async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      const value = await statfs(productRoot);
      const available = value.bavail * value.bsize;
      report.minimumObservedHostFreeBytes = Math.min(
        report.minimumObservedHostFreeBytes ?? Infinity,
        available,
      );
      if (available < 8 * gibibyte) {
        diskFailure = 'GMVP_RECOVERY_LOCAL_DISK_RESERVE_REQUIRED';
        abort.abort();
      }
    } catch {
      diskFailure = 'GMVP_RECOVERY_DISK_OBSERVATION_FAILED';
      abort.abort();
    } finally {
      monitoring = false;
    }
  }, 30_000);
  try {
    for (const path of [
      statePath + '.lock',
      resolve(productRoot, '.local/local-lab/s6-product/state.json.lock'),
      resolve(productRoot, '.local/local-lab/s6-webhook/state.json.lock'),
      resolve(productRoot, '.local/local-lab/s6-builder-faults/state.json.lock'),
      resolve(productRoot, '.local/local-lab/g-mvp-workload-faults/probe.lock'),
    ]) {
      const handle = await open(path, 'wx', 0o600);
      locks.push({ path, handle });
      await handle.writeFile(JSON.stringify({ owner, pid: process.pid, mode, attempt }));
    }
    if (state)
      await writeFile(resolve(attemptDirectory, 'state-before.json'), encode(state), {
        mode: 0o600,
        flag: 'wx',
      });
    state ??= {
      version: 1,
      owner,
      id: randomUUID(),
      sourceEnvFile: resolve(productRoot, values['source-env']),
      oldBackupId: values['old-backup'],
      completed: {},
      checks: [],
    };
    requireValue(
      state.sourceEnvFile === resolve(productRoot, values['source-env']) &&
        state.oldBackupId === values['old-backup'],
      'RECOVERY_SELECTION_CHANGED',
    );
    await save();
    if (state.completed[mode]) {
      report.status = 'passed';
      report.reusedCompletedPhase = true;
      return;
    }
    requireValue(!state.completed['return-original'], 'RECOVERY_WINDOW_ALREADY_RETURNED');
    sourceEnv = parseEnv(
      await privateFile(dirname(state.sourceEnvFile), basename(state.sourceEnvFile)),
    );
    const parsedUrl = new URL(sourceEnv.DATABASE_URL);
    requireValue(
      ['postgres:', 'postgresql:'].includes(parsedUrl.protocol) &&
        ['127.0.0.1', 'localhost'].includes(parsedUrl.hostname) &&
        parsedUrl.username &&
        parsedUrl.password,
      'SOURCE_DATABASE_NOT_LOCAL',
    );
    requireValue(
      typeof sourceEnv.MASTER_KEY_FILE === 'string' && sourceEnv.RESTORE_MODE !== 'true',
      'SOURCE_KEY_OR_RUNTIME_MODE_INVALID',
    );
    sourceUrl = parsedUrl.href;
    sourceKeyFile = resolve(dirname(state.sourceEnvFile), sourceEnv.MASTER_KEY_FILE);
    sourceDb = database(sourceUrl);
    trusted = await loadTrust();
    await disk(8);
    if (mode !== 'prepare') {
      requireValue(state.completed.prepare, 'PREPARE_REQUIRED');
      await verifyProtectedInputs();
    }
    if (['old', 'old-accept', 'final', 'return-original'].includes(mode))
      requireValue(state.completed['capture-final'], 'FINAL_BACKUP_REQUIRED');
    if (mode === 'prepare') await phase(mode, prepare);
    else if (mode === 'capture-final') await phase(mode, captureFinal);
    else if (mode === 'old') await phase(mode, oldSample);
    else if (mode === 'old-accept') await phase(mode, oldAcceptedSample);
    else if (mode === 'final') await phase(mode, finalSample);
    else await phase(mode, returnOriginal);
    await disk(8);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = {
      stage,
      code:
        diskFailure ??
        (/^GMVP_RECOVERY_[A-Z0-9_]+$/u.test(error.message ?? '')
          ? error.message
          : 'GMVP_RECOVERY_UNEXPECTED_FAILURE'),
      // Prisma validation messages can include complete query inputs. Record only
      // known error classes/codes and this driver's call site, never raw messages.
      errorType: [
        'Error',
        'TypeError',
        'RangeError',
        'AbortError',
        'BuilderError',
        'PrismaClientValidationError',
        'PrismaClientKnownRequestError',
        'PrismaClientUnknownRequestError',
        'PrismaClientInitializationError',
      ].includes(error.name)
        ? error.name
        : 'UnknownError',
      causeCode:
        /^(?:BUILD_[A-Z0-9_]{1,80}|P[0-9]{4}|ENOENT|EACCES|EPERM|EEXIST|ENOSPC|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|ABORT_ERR)$/u.test(
          error.code ?? '',
        )
          ? error.code
          : /^S6_PRODUCT_[A-Z0-9_]+$/u.test(error.message ?? '')
            ? error.message
            : null,
      httpStatus:
        error.name === 'BuilderError' &&
        Number.isInteger(error.httpStatus) &&
        error.httpStatus >= 100 &&
        error.httpStatus <= 599
          ? error.httpStatus
          : null,
      driverSite:
        /g-mvp-recovery-local-lab\.mjs:[0-9]+:[0-9]+/u.exec(error.stack ?? '')?.[0] ?? null,
    };
    console.error(JSON.stringify(report.failure));
    process.exitCode = 1;
  } finally {
    clearInterval(monitor);
    while (monitoring) await delay(10);
    try {
      await sourceDb?.$disconnect();
    } catch {
      (report.cleanupIssues ??= []).push({ code: 'GMVP_RECOVERY_DATABASE_DISCONNECT_FAILED' });
    }
    report.completedAt = new Date().toISOString();
    report.result = summary();
    report.originalRuntimeControlledByDriver = false;
    report.backupsDatabasesAndOwnedRedisVolumesRetained = true;
    try {
      if (state && locks.some((lock) => lock.path === statePath + '.lock')) await save();
      await writeFile(resolve(attemptDirectory, 'report.json'), encode(report), {
        mode: 0o600,
        flag: 'wx',
      });
    } finally {
      for (const lock of locks.reverse()) {
        await lock.handle.close();
        await unlink(lock.path);
      }
    }
    console.log(
      JSON.stringify({
        status: report.status,
        result: summary(),
        report: resolve(attemptDirectory, 'report.json'),
      }),
    );
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ code: 'GMVP_RECOVERY_DRIVER_FAILED' }));
  process.exitCode = 1;
});
