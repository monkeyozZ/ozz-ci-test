import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  statfs,
  unlink,
} from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { dirname, resolve } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs, parseEnv } from 'node:util';
import { PrismaClient } from '../../packages/database/dist/index.js';
import {
  HttpBuilderClient,
  HttpsBuilderTransport,
  hashJson,
  verifyInventoryPages,
  verifySigned,
} from '../../packages/infrastructure/dist/build.js';
import { hashFile, verifyBackupSnapshot } from '../../scripts/backup-helpers.mjs';
import {
  checkFixtureHealth,
  checkProductHttpsHealth,
  publicAppOrigin,
  readProductConfiguration,
  registryProxyOrigin,
} from './support/s6-github-product.mjs';
import {
  assertJointApplicationIdentity,
  observeJointApplications,
} from './support/g-mvp-recovery-joint-continuity.mjs';
import {
  atomicState,
  commandRunner,
  encode,
  freePort,
  GiB,
  hash,
  live,
  newFile,
  ownedRuntime,
  owner,
  portState,
  privateFile,
  requestJson,
  requireValue,
  safeCode,
  waitFor,
} from './support/g-mvp-recovery-joint-runtime.mjs';

// An independent, single-process measurement. Preparation never stops a service,
// writes a checkpoint, locks a database or creates a backup. All data is retained.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const parentDirectory = resolve(lab, 'g-mvp-recovery-joint-timing');
const originalRuntimePath = resolve(root, '.local/s3-runtime.json');
const postgresImage =
  'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const redisImage = 'redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sessionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,79}$/u;
const maximumXid = (1n << 64n) - 1n;

function parseSnapshot(value) {
  requireValue(typeof value === 'string' && value.length <= 65536, 'SNAPSHOT_INVALID');
  const [minimum, maximum, active, extra] = value.split(':');
  const decimal = (text) => {
    requireValue(
      typeof text === 'string' && /^(0|[1-9]\d{0,19})$/u.test(text),
      'SNAPSHOT_XID_INVALID',
    );
    const result = BigInt(text);
    requireValue(result <= maximumXid, 'SNAPSHOT_XID_INVALID');
    return result;
  };
  requireValue(extra === undefined && active !== undefined, 'SNAPSHOT_INVALID');
  const xmin = decimal(minimum),
    xmax = decimal(maximum);
  requireValue(xmin <= xmax, 'SNAPSHOT_INVALID');
  const xip = active ? active.split(',').map(decimal) : [];
  requireValue(
    xip.every((xid, index) => xid >= xmin && xid < xmax && (!index || xid > xip[index - 1])),
    'SNAPSHOT_INVALID',
  );
  return { xmin, xmax, xip };
}

/** Resolve a freshly acknowledged tuple xmin without truncating the XID epoch. */
export function recentFullXid(tupleXmin, observedSnapshot) {
  requireValue(
    typeof tupleXmin === 'string' && /^[1-9]\d{0,9}$/u.test(tupleXmin),
    'CHECKPOINT_XMIN_INVALID',
  );
  const low = BigInt(tupleXmin),
    cycle = 1n << 32n;
  requireValue(low >= 3n && low < cycle, 'CHECKPOINT_XMIN_INVALID');
  const { xmax } = parseSnapshot(observedSnapshot);
  let xid = (xmax / cycle) * cycle + low;
  if (xid >= xmax) xid -= cycle;
  // This is a new checkpoint observed immediately after its HTTP acknowledgement.
  // Refuse an old/frozen tuple or an ambiguous epoch instead of guessing across a wrap.
  requireValue(xid >= 3n && xid < xmax && xmax - xid <= 1_000_000n, 'CHECKPOINT_XID_NOT_RECENT');
  return xid.toString();
}

export function visibleInSnapshot(fullXid, value) {
  requireValue(
    typeof fullXid === 'string' && /^[1-9]\d{0,19}$/u.test(fullXid),
    'CHECKPOINT_XID_INVALID',
  );
  const xid = BigInt(fullXid),
    { xmin, xmax, xip } = parseSnapshot(value);
  requireValue(xid >= 3n && xid <= maximumXid, 'CHECKPOINT_XID_INVALID');
  return xid < xmin || (xid < xmax && !xip.includes(xid));
}

/** Never combine marks from another process, including an interrupted run. */
export function summarizeJointTiming(marks) {
  const between = (start, end) => {
    const a = marks[start],
      b = marks[end];
    if (!a || !b) return null;
    requireValue(
      uuid.test(a.clockId) &&
        a.clockId === b.clockId &&
        /^\d+$/u.test(a.elapsedNanoseconds) &&
        /^\d+$/u.test(b.elapsedNanoseconds),
      'TIMING_CLOCK_CHANGED',
    );
    const difference = BigInt(b.elapsedNanoseconds) - BigInt(a.elapsedNanoseconds);
    requireValue(
      difference >= 0n && difference <= BigInt(Number.MAX_SAFE_INTEGER),
      'TIMING_ORDER_INVALID',
    );
    return Number(difference) / 1e6;
  };
  return {
    clockId: marks.incident?.clockId ?? marks.originalReturnStarted?.clockId ?? null,
    totalRtoMs: between('incident', 'recovered'),
    restoreImportMs: between('restoreStarted', 'restoreCompleted'),
    readOnlyRtoMs: between('incident', 'readOnlyVerified'),
    writableRtoMs: between('incident', 'writableReady'),
    unlockMs: between('unlockStarted', 'unlockCompleted'),
    originalReturnMs: between('originalReturnStarted', 'originalReady'),
    totalWindowThroughOriginalReturnMs: between('incident', 'originalReady'),
    snapshotAgeAtIncidentBoundsMs:
      marks.incident && marks.backupCompleted
        ? {
            minimum: between('backupCompleted', 'incident'),
            maximum: between('backupStarted', 'incident'),
            basis: 'The exported snapshot was acquired during this parent process backup call.',
          }
        : null,
    savedCheckpointCommitAgeAtIncidentBoundsMs:
      marks.incident && marks.checkpointAcknowledged
        ? {
            minimum: between('checkpointAcknowledged', 'incident'),
            maximum: between('checkpointRequested', 'incident'),
            basis: 'Commit is bounded by the dedicated successful API request and acknowledgement.',
          }
        : null,
    acknowledgedOmittedRevisionAgeAtIncidentMs: between('omittedAcknowledged', 'incident'),
    exactPostgresSnapshotRpoMs: null,
    exactSnapshotAcquisitionTimeKnown: false,
  };
}

async function safeDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  requireValue(
    info.isDirectory() &&
      info.uid === process.getuid() &&
      !(info.mode & 0o077) &&
      (await realpath(path)) === path,
    'DIRECTORY_UNSAFE',
  );
}

function database(url) {
  const value = new URL(url);
  value.searchParams.set('connection_limit', '3');
  value.searchParams.set('connect_timeout', '5');
  value.searchParams.set('pool_timeout', '5');
  value.searchParams.set('socket_timeout', '30');
  return new PrismaClient({ datasourceUrl: value.href });
}

async function facts(db) {
  const control = await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  const [builders, runs, deployments, services, operations, waitingTargets] = await Promise.all([
    db.builder.findMany({
      orderBy: { id: 'asc' },
      take: 3,
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
      take: 2001,
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
      take: 2001,
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
      take: 2001,
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
      take: 10001,
      select: { id: true, kind: true, status: true, generation: true, errorCode: true },
    }),
    db.webhookTarget.count({ where: { state: 'waiting' } }),
  ]);
  requireValue(
    runs.length <= 2000 &&
      deployments.length <= 2000 &&
      services.length <= 2000 &&
      operations.length <= 10000,
    'LOCAL_INVENTORY_LIMIT',
  );
  return JSON.parse(
    JSON.stringify({
      control: {
        installationId: control.installationId,
        generation: control.generation,
        restoreLocked: control.restoreLocked,
      },
      builders,
      runs: runs.map(({ endProofJson, ...row }) => ({
        ...row,
        proofHash: endProofJson ? hashJson(endProofJson) : null,
      })),
      deployments: deployments.map(({ snapshotJson, targetJson, result, ...row }) => ({
        ...row,
        snapshotSha256: hashJson(snapshotJson),
        targetSha256: hashJson(targetJson),
        failureObservationSha256: hashJson(result?.failureObservation ?? null),
      })),
      services,
      operations,
      waitingTargets,
    }),
  );
}

function retained(value) {
  return {
    builders: value.builders,
    runs: value.runs,
    deployments: value.deployments,
    services: value.services,
    operations: value.operations,
  };
}
function idle(value) {
  requireValue(
    value.runs.every((row) => row.executionClosedAt) &&
      value.deployments.every((row) => !['queued', 'running'].includes(row.status)) &&
      value.operations.every((row) => !['queued', 'running'].includes(row.status)) &&
      !value.waitingTargets,
    'ACTIVE_WORK_REFUSED',
  );
}

async function loadTrust() {
  const path = resolve(lab, 'builder'),
    pki = resolve(path, 'pki');
  const operator = JSON.parse(await privateFile(resolve(path, 'operator-config.json')));
  const publicKey = await readFile(resolve(path, 'identity-public-key.pem'), 'utf8');
  requireValue(
    uuid.test(operator.instanceId) && uuid.test(operator.installationId),
    'BUILDER_DEPLOYMENT_IDENTITY_INVALID',
  );
  const tls = {
    origin: 'https://127.0.0.1:49443',
    caCertificate: await readFile(resolve(pki, 'ca.crt'), 'utf8'),
    clientCertificate: await readFile(resolve(pki, 'client.crt'), 'utf8'),
    clientPrivateKey: (await privateFile(resolve(pki, 'client.key'))).toString('utf8'),
    timeoutMs: 5000,
  };
  return {
    operator,
    publicKey,
    tls,
    client: new HttpBuilderClient(new HttpsBuilderTransport(tls)),
  };
}

function completeInventory(local, remote, trusted) {
  requireValue(
    local.control.installationId === trusted.operator.installationId &&
      local.builders.length === 1 &&
      local.builders[0].instanceId === trusted.operator.instanceId &&
      local.builders[0].endpoint === trusted.tls.origin &&
      local.builders[0].identityPublicKey === trusted.publicKey,
    'BUILDER_REGISTRATION_CHANGED',
  );
  const runs = new Map(local.runs.map((row) => [row.id, row])),
    remoteIds = new Set(remote.runs.map((row) => row.runId));
  requireValue(
    remote.runs.every((row) => {
      const saved = runs.get(row.runId);
      return (
        saved &&
        saved.builderId === local.builders[0].id &&
        saved.builderInstanceId === trusted.operator.instanceId &&
        saved.specHash === row.specHash &&
        saved.executionClosedAt &&
        row.executionClosed &&
        saved.proofHash === row.proofHash
      );
    }) &&
      local.runs.every(
        (row) =>
          remoteIds.has(row.id) ||
          (row.executionState === 'never_submitted' &&
            row.executionClosedAt &&
            !row.submissionAttemptedAt),
      ),
    'BUILDER_INVENTORY_NOT_COMPLETE',
  );
}

export async function runJointRecovery(mode, session, sourceFile = '.env') {
  requireValue(
    process.versions.node.split('.')[0] === '24' && process.platform === 'darwin',
    'NODE_24_MACOS_REQUIRED',
  );
  requireValue(
    ['prepare', 'run', 'return-original', 'status'].includes(mode) && sessionPattern.test(session),
    'USAGE_INVALID',
  );
  process.umask(0o077);
  const directory = resolve(parentDirectory, session),
    statePath = resolve(directory, 'state.json');
  let state, initialStateDigest;
  try {
    const bytes = await privateFile(statePath, 16 * 1024 * 1024);
    state = JSON.parse(bytes);
    initialStateDigest = hash(bytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  requireValue(
    !state ||
      (state.formatVersion === 1 &&
        state.owner === owner &&
        state.session === session &&
        uuid.test(state.id)),
    'STATE_IDENTITY_CHANGED',
  );
  const publicState = () =>
    state
      ? {
          owner,
          session,
          id: state.id,
          status: state.status,
          preparedAt: state.preparedAt ?? null,
          runAttempt: state.runAttempt ?? null,
          originalNeedsReconcile: state.originalNeedsReconcile ?? false,
          originalReturnRequired: state.originalReturnRequired ?? false,
          originalReturnedGeneration: state.originalReturnedGeneration ?? null,
          lastReport: state.lastReport ?? null,
          retainedDatabase: state.target?.database ?? null,
        }
      : { owner, session, status: 'not-prepared' };
  const receiptStatus = (receipt) =>
    receipt.status !== 'passed'
      ? 'failed'
      : receipt.mode === 'prepare'
        ? 'prepared'
        : receipt.mode === 'run'
          ? 'completed'
          : 'original-returned-after-interruption';
  async function finalReceipt() {
    requireValue(
      state &&
        uuid.test(state.lastAttempt) &&
        ['prepare', 'run', 'return-original'].includes(state.lastMode) &&
        state.lastReport === resolve(directory, state.lastAttempt, 'report.json'),
      'FINAL_RECEIPT_PATH_CHANGED',
    );
    const receipt = JSON.parse(await privateFile(state.lastReport, 16 * 1024 * 1024));
    requireValue(
      receipt.owner === owner &&
        receipt.session === session &&
        receipt.attempt === state.lastAttempt &&
        receipt.mode === state.lastMode &&
        receipt.result?.id === state.id &&
        ['passed', 'failed'].includes(receipt.status),
      'FINAL_RECEIPT_IDENTITY_CHANGED',
    );
    return receipt;
  }
  if (mode === 'status') {
    const result = publicState();
    if (['prepared', 'finished'].includes(state?.status)) {
      try {
        result.status = receiptStatus(await finalReceipt());
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        result.status = 'awaiting-final-report';
      }
    }
    console.log(JSON.stringify(result));
    return result;
  }
  requireValue(mode === 'prepare' ? !state : state?.preparedAt, 'PREPARE_NEW_SESSION_REQUIRED');
  requireValue(mode !== 'run' || !state.runAttempt, 'MEASUREMENT_ATTEMPT_ALREADY_USED');
  await safeDirectory(directory, true);
  const attempt = randomUUID(),
    attemptDirectory = resolve(directory, attempt);
  await safeDirectory(attemptDirectory, true);
  const events = await open(resolve(attemptDirectory, 'events.jsonl'), 'wx', 0o600);
  const clockId = randomUUID(),
    originNs = process.hrtime.bigint(),
    abort = new globalThis.AbortController(),
    cleanupAbort = new globalThis.AbortController();
  const interrupt = () => abort.abort(new Error('GMVP_JOINT_INTERRUPTED'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const report = {
    formatVersion: 1,
    owner,
    session,
    attempt,
    mode,
    clockId,
    startedAt: new Date().toISOString(),
    status: 'running',
    marks: {},
    checks: [],
    resourcesRetained: true,
    limits: [
      'One local PostgreSQL server hosts the retained source and a fresh target database; physical database-host loss and target VPS capacity are not measured.',
      'Artifacts, cached images, credentials, local TLS entry configuration and VM capacity are prepared before the incident. Target database creation, local backup retrieval, restore, Redis creation, API/Worker startup, real Builder reconciliation and all final checks are timed.',
      'No public DNS switch, remote backup download, human response time, physical host provisioning or production end-to-end RPO/RTO is claimed.',
      'The full API/Worker implementation uses the existing local ACME development configuration. Target HTTPS uses a dedicated local CA; production cookie policy is not a claim of this sample.',
      'The physical PostgreSQL snapshot instant is not observable exactly. Database wall labels and child-process durations are retained as their own observations, never subtracted from this parent monotonic clock.',
      'Only a new dedicated metadata checkpoint and one current backup are used. No old-backup history acceptance, build, deployment, old-task matrix or fault matrix is repeated.',
    ],
  };
  const stamp = () => ({
    at: new Date().toISOString(),
    clockId,
    elapsedNanoseconds: (process.hrtime.bigint() - originNs).toString(),
  });
  let eventTail = Promise.resolve(),
    stateTail = Promise.resolve(),
    sourceDb,
    targetDb,
    sourceEnv,
    sourceKeyFile,
    trusted,
    product,
    sourceOrigin,
    server,
    stage = 'initialize',
    failingStage,
    diskFailure,
    monitor,
    monitoring = false,
    runtime,
    returningOriginal = mode === 'return-original';
  const locks = [];
  const event = (kind, details = {}) => {
    const row = { ...stamp(), kind, ...details };
    eventTail = eventTail
      .catch(() => {})
      .then(async () => {
        try {
          await events.writeFile(JSON.stringify(row) + '\n');
          await events.sync();
        } catch (error) {
          report.evidencePersistenceFailed = true;
          if (!returningOriginal) throw error;
        }
        return row;
      });
    return eventTail;
  };
  const save = () => {
    const value = globalThis.structuredClone(state);
    stateTail = stateTail.catch(() => {}).then(() => atomicState(statePath, value));
    return stateTail;
  };
  const { command: rawCommand, assertClosed } = commandRunner({
    root,
    signal: abort.signal,
    event,
  });
  const mutations = new Set([
    'create-owned-redis-volume',
    'create-owned-redis',
    'start-owned-redis',
    'stop-owned-redis',
    'stop-original-api-worker',
    'stop-original-redis',
    'start-original-redis',
    'start-original-api-worker',
    'formal-target-restore',
    'current-consistent-backup',
  ]);
  async function command(label, binary, args, options = {}) {
    if (!mutations.has(label) && !options.trackMutation)
      return rawCommand(label, binary, args, options);
    requireValue(
      state && [process.execPath, 'docker'].includes(binary),
      'MUTATION_COMMAND_INVALID',
    );
    const record = { label, binary, tail: args.join(' '), at: new Date().toISOString(), attempt };
    (state.mutationCommands ??= []).push(record);
    try {
      await save();
    } catch (error) {
      // Shutting down a proven owned target is still necessary when the disk is
      // unavailable. This exception cannot start/restart anything or fence a Builder.
      if (options.cleanup && label === 'stop-owned-redis')
        return rawCommand(label, binary, args, options);
      throw error;
    }
    let closed = false;
    try {
      const output = await rawCommand(label, binary, args, {
        ...options,
        onSpawn: async (pid) => {
          record.pid = pid;
          record.processGroup = pid;
          await save();
          if (live(pid)) {
            try {
              record.processStart = await rawCommand(
                'mutation-process-start',
                'ps',
                ['-p', String(pid), '-o', 'lstart='],
                { cleanup: true, timeoutMs: 5000 },
              );
            } catch (error) {
              if (live(pid)) throw error;
            }
            await save();
          }
          await options.onSpawn?.(pid);
        },
      });
      closed = true;
      return output;
    } catch (error) {
      closed = error.commandClosed === true;
      throw error;
    } finally {
      if (closed) {
        record.closedAt = new Date().toISOString();
        await save();
      }
    }
  }
  const mark = async (name) => {
    requireValue(!report.marks[name], 'TIMING_MARK_REPEATED');
    report.marks[name] = await event(name);
  };
  const phase = async (name) => {
    stage = name;
    await event('stage', { stage });
    console.log(JSON.stringify({ stage, session, attempt }));
  };
  const check = async (name, details = {}) => {
    report.checks.push({ name, passed: true, ...details });
    await event('check', { name, ...details });
  };
  const evidence = async (label, value) => {
    requireValue(/^[a-z0-9-]+$/u.test(label), 'EVIDENCE_LABEL_INVALID');
    const path = resolve(attemptDirectory, `${label}-${randomUUID()}.json`);
    await newFile(path, encode({ ...stamp(), ...value }));
    return path;
  };
  const activeSignal = (cleanup) => (cleanup ? cleanupAbort.signal : abort.signal);
  async function reserve(minimum = 8) {
    const disk = await statfs(root),
      available = disk.bavail * disk.bsize;
    report.minimumObservedHostFreeBytes = Math.min(
      report.minimumObservedHostFreeBytes ?? Infinity,
      available,
    );
    await event('disk', { availableBytes: available, minimumBytes: minimum * GiB });
    requireValue(available >= minimum * GiB, 'LOCAL_DISK_RESERVE_REQUIRED');
  }
  async function acquire(path) {
    await safeDirectory(dirname(path), true);
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST' || mode !== 'return-original') throw error;
      const stale = JSON.parse(await privateFile(path));
      requireValue(
        stale.owner === owner && stale.session === session && !live(stale.pid),
        'WINDOW_LOCK_HELD',
      );
      await rename(path, `${path}.retained-${randomUUID()}`);
      handle = await open(path, 'wx', 0o600);
    }
    const record = { owner, session, attempt, pid: process.pid, clockId };
    const info = await handle.stat();
    locks.push({ path, handle, record, inode: info.ino, device: info.dev });
    await handle.writeFile(encode(record));
    await handle.sync();
  }
  async function vmState(cleanup = false) {
    const assets = JSON.parse(
      await readFile(resolve(root, 'infra/local-lab/assets.lock.json'), 'utf8'),
    );
    requireValue(/^\d+\.\d+\.\d+$/u.test(assets.lima.version), 'LIMA_VERSION_INVALID');
    const binary = resolve(lab, `tools/lima-${assets.lima.version}/bin/limactl`),
      result = [];
    for (const [name, home] of [
      ['applications', resolve(lab, 'lima')],
      ['builder', resolve(lab, 'builder/lima')],
    ]) {
      const output = await command('observe-' + name + '-vms', binary, ['list', '--json'], {
        cleanup,
        timeoutMs: 15000,
        env: { ...process.env, LIMA_HOME: home, LIMA_SHELL: '/bin/bash' },
      });
      const rows = output.startsWith('[')
        ? JSON.parse(output)
        : output
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
      if (name === 'applications')
        requireValue(
          ['ozz-lab-a', 'ozz-lab-b'].every(
            (vm) => rows.find((row) => row.name === vm)?.status === 'Running',
          ) && rows.find((row) => row.name === 'ozz-lab-c')?.status === 'Stopped',
          'APPLICATION_VM_WINDOW_CHANGED',
        );
      else
        requireValue(
          rows.find((row) => row.name === 'ozz-build')?.status === 'Running',
          'BUILDER_VM_NOT_RUNNING',
        );
      result.push(...rows.map(({ name: vm, status }) => ({ name: vm, status })));
    }
    await event('vm-state', { instances: result });
  }
  async function inventory(label, cleanup = false) {
    const signal = activeSignal(cleanup),
      identityChallenge = randomBytes(32).toString('base64url');
    const signed = await trusted.client.identity(identityChallenge, signal),
      identity = verifySigned(signed, trusted.publicKey);
    requireValue(
      identity.challenge === identityChallenge &&
        identity.instanceId === trusted.operator.instanceId &&
        Math.abs(Date.now() - Date.parse(identity.checkedAt)) < 60000,
      'SIGNED_BUILDER_IDENTITY_CHANGED',
    );
    const challenge = randomBytes(32).toString('base64url'),
      pages = [],
      seen = new Set();
    let cursor;
    do {
      requireValue(pages.length < 20, 'BUILDER_INVENTORY_PAGE_LIMIT');
      const page = await trusted.client.inventory(challenge, cursor, signal),
        checked = verifySigned(page, trusted.publicKey);
      requireValue(
        checked.totalRuns <= 2000 && checked.offset === pages.length * 100,
        'BUILDER_INVENTORY_LIMIT',
      );
      pages.push(page);
      cursor = checked.nextCursor ?? undefined;
      requireValue(!cursor || !seen.has(cursor), 'BUILDER_INVENTORY_CURSOR_LOOP');
      if (cursor) seen.add(cursor);
    } while (cursor);
    const result = verifyInventoryPages(pages, {
      installationId: trusted.operator.installationId,
      builderInstanceId: trusted.operator.instanceId,
      challenge,
      publicKey: trusted.publicKey,
    });
    requireValue(
      result.highGeneration === identity.highGeneration,
      'BUILDER_HIGH_WATER_CHANGED_DURING_READ',
    );
    await evidence(label, { identity: signed, pages });
    return result;
  }
  async function kube(label, cleanup = false) {
    const source = await readFile(
        resolve(root, 'tests/probes/support/g-mvp-recovery-k3s.py'),
        'utf8',
      ),
      resources = [];
    for (const alias of ['ozz-lab-a', 'ozz-lab-b']) {
      const parameters = { alias, installationId: trusted.operator.installationId };
      const value = JSON.parse(
        await command(
          'observe-k3s-' + alias,
          'ssh',
          [
            '-F',
            resolve(lab, 'credentials/ssh_config'),
            '-o',
            'BatchMode=yes',
            '-o',
            'StrictHostKeyChecking=yes',
            '-o',
            'ConnectTimeout=5',
            alias,
            'sudo -n /usr/bin/python3 -I -B -',
          ],
          {
            cleanup,
            timeoutMs: 30000,
            input: `import json\nparameters = json.loads(${JSON.stringify(JSON.stringify(parameters))})\n${source}`,
          },
        ),
      );
      requireValue(value.version === 1 && Array.isArray(value.resources), 'K3S_RESPONSE_INVALID');
      resources.push(...value.resources);
    }
    await evidence(label, { resources });
    return resources;
  }
  async function applications(label, db, cleanup = false) {
    try {
      const observed = await observeJointApplications({
        root,
        command: (name, binary, args, options = {}) =>
          command(name, binary, args, { ...options, cleanup }),
        readDb: (sql, parameters = []) => db.$queryRawUnsafe(sql, ...parameters),
        signal: activeSignal(cleanup),
        installationId: trusted.operator.installationId,
      });
      await evidence(label, { applications: observed });
      return observed;
    } catch (error) {
      if (error.jointObservation)
        await evidence(label + '-failed', { applications: error.jointObservation });
      throw error;
    }
  }
  async function workloadIdentity(label, cleanup = false) {
    requireValue(
      isDeepStrictEqual(await kube(label, cleanup), state.kubeBaseline),
      'K3S_RESOURCE_IDENTITY_CHANGED',
    );
  }
  async function processIdentity(name, pid, cleanup = false) {
    requireValue(live(pid), 'ORIGINAL_PROCESS_MISSING');
    const args = await command(
      'original-process-command',
      'ps',
      ['-p', String(pid), '-o', 'args='],
      { cleanup, timeoutMs: 5000 },
    );
    const cwd = await command(
      'original-process-cwd',
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { cleanup, timeoutMs: 5000 },
    );
    const started = await command(
      'original-process-start',
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      { cleanup, timeoutMs: 5000 },
    );
    requireValue(
      args.endsWith(`--env-file=.env tests/probes/s6-product-${name}.mjs`) &&
        cwd.split('\n').includes(`n${root}`),
      'ORIGINAL_PROCESS_NOT_OWNED',
    );
    return { pid, started, entry: `tests/probes/s6-product-${name}.mjs` };
  }
  async function originalProcesses(cleanup = false, requireOnline = false) {
    const value = JSON.parse(await privateFile(originalRuntimePath));
    requireValue(value.profile === 's6-github', 'ORIGINAL_RUNTIME_PROFILE_CHANGED');
    const processes = {};
    for (const name of ['api', 'worker']) {
      if (live(value[name])) processes[name] = await processIdentity(name, value[name], cleanup);
      else {
        requireValue(!requireOnline, 'ORIGINAL_RUNTIME_NOT_ONLINE');
        processes[name] = null;
      }
    }
    return processes;
  }
  function redisIdentity(container) {
    const ports = container.HostConfig.PortBindings?.['6379/tcp'];
    requireValue(
      container.Config.Labels?.['com.docker.compose.project'] === 'ozz-dev' &&
        container.Config.Labels?.['com.docker.compose.service'] === 'redis' &&
        container.Config.Image === redisImage &&
        ports?.length === 1 &&
        ports[0].HostIp === '127.0.0.1' &&
        ports[0].HostPort === String(state.originalPorts.redis) &&
        container.Mounts.length === 1 &&
        container.Mounts[0].Type === 'volume' &&
        container.Mounts[0].Destination === '/data',
      'ORIGINAL_REDIS_CONFIGURATION_CHANGED',
    );
    return {
      id: container.Id,
      name: container.Name,
      image: container.Config.Image,
      volume: container.Mounts[0].Name,
      destination: container.Mounts[0].Destination,
      port: ports[0].HostPort,
    };
  }
  async function originalRedis(cleanup = false) {
    const id = await command(
      'locate-original-redis',
      'docker',
      [
        'compose',
        '--env-file',
        state.sourceControlEnv ?? state.sourceEnvFile,
        '-f',
        'compose.dev.yaml',
        'ps',
        '--all',
        '--quiet',
        'redis',
      ],
      { cleanup, timeoutMs: 10000 },
    );
    requireValue(/^[a-f0-9]{64}$/u.test(id), 'ORIGINAL_REDIS_AMBIGUOUS');
    const result = JSON.parse(
      await command(
        'inspect-original-redis',
        'docker',
        ['container', 'inspect', id, '--format', '{{json .}}'],
        { cleanup, timeoutMs: 10000 },
      ),
    );
    const identity = redisIdentity(result);
    if (state.originalRedis)
      requireValue(
        isDeepStrictEqual(identity, state.originalRedis),
        'ORIGINAL_REDIS_IDENTITY_CHANGED',
      );
    return {
      identity,
      running: result.State.Running,
      healthy: result.State.Health?.Status === 'healthy',
    };
  }
  const targetUrl = () => {
    const value = new URL(sourceEnv.DATABASE_URL);
    value.pathname = '/' + state.target.database;
    return value.href;
  };
  const sessions = new Map();
  async function api(which, path, options = {}) {
    const target = which === 'target',
      authentication = options.session ?? sessions.get(which);
    return requestJson((target ? state.target.origin : sourceOrigin) + '/api' + path, {
      ...options,
      ca: target ? await readFile(state.target.caFile) : product.ca,
      signal: activeSignal(options.cleanup),
      headers: {
        origin: target ? state.target.origin : sourceOrigin,
        ...(authentication
          ? { cookie: authentication.cookie, 'x-csrf-token': authentication.csrf }
          : {}),
        ...options.headers,
      },
    });
  }
  async function login(which, cleanup = false) {
    sessions.delete(which);
    const password = (await privateFile(resolve(root, '.secrets/admin-password')))
      .toString('utf8')
      .trim();
    const reply = await api(which, '/auth/login', {
      method: 'POST',
      body: { username: 'admin', password },
      cleanup,
    });
    requireValue(
      reply.status === 200 && typeof reply.value?.data?.csrfToken === 'string',
      'LOGIN_FAILED',
    );
    const cookie = reply.headers['set-cookie']?.find((value) => value.startsWith('ozz_session='));
    requireValue(
      cookie &&
        /;\s*HttpOnly(?:;|$)/iu.test(cookie) &&
        /;\s*SameSite=Strict(?:;|$)/iu.test(cookie) &&
        (sourceEnv.NODE_ENV !== 'production' || /;\s*Secure(?:;|$)/iu.test(cookie)),
      'SESSION_COOKIE_INVALID',
    );
    const session = { cookie: cookie.split(';')[0], csrf: reply.value.data.csrfToken };
    sessions.set(which, session);
    return session;
  }
  async function ready(which, locked, cleanup = false) {
    await waitFor(
      async () => {
        try {
          const health = await api(which, '/health/ready', { cleanup });
          const ports = which === 'target' ? state.target.ports : state.originalPorts;
          const worker = await requestJson(`http://127.0.0.1:${ports.worker}/health/live`, {
            signal: activeSignal(cleanup),
          });
          const age = Date.now() - Date.parse(worker.value?.lastHeartbeatAt);
          return (
            health.status === 200 &&
            health.value?.mode === (locked ? 'read_only' : 'read_write') &&
            worker.status === 200 &&
            worker.value?.status === (locked ? 'paused' : 'ready') &&
            worker.value.database === true &&
            worker.value.recoveryMode === locked &&
            (locked || worker.value.queueConnected === true) &&
            worker.value.activeOperations === 0 &&
            Number.isFinite(age) &&
            age >= 0 &&
            age < 20000
          );
        } catch {
          return false;
        }
      },
      Boolean,
      { timeoutMs: 60000, signal: activeSignal(cleanup) },
    );
  }
  async function metadata(which, method, path, body, status) {
    const reply = await api(which, path, {
      method,
      body,
      headers: { 'idempotency-key': randomUUID() },
    });
    requireValue(
      reply.status === status && uuid.test(reply.value?.data?.id),
      'CHECKPOINT_API_FAILED',
    );
    return reply.value.data;
  }
  const checkpointView = (row) => ({
    id: row.id,
    revision: row.revision,
    descriptionSha256: hash(row.description ?? ''),
  });
  async function checkpointTuple(db, expected) {
    const rows = await db.$queryRawUnsafe(
      'SELECT id, revision, description, xmin::text AS "xmin32", pg_current_snapshot()::text AS "currentSnapshot" FROM "Cluster" WHERE id=$1::uuid',
      expected.id,
    );
    requireValue(
      rows.length === 1 && isDeepStrictEqual(checkpointView(rows[0]), checkpointView(expected)),
      'CHECKPOINT_ROW_CHANGED',
    );
    return {
      ...checkpointView(rows[0]),
      xmin32: rows[0].xmin32,
      currentSnapshot: rows[0].currentSnapshot,
      xid: recentFullXid(rows[0].xmin32, rows[0].currentSnapshot),
    };
  }
  async function verifyInputs() {
    for (const [path, digest] of Object.entries(state.protectedHashes))
      requireValue(hash(await readFile(path)) === digest, 'PROTECTED_INPUT_CHANGED');
  }
  async function invokeRecovery(which, action, cleanup = false) {
    const envFile = which === 'target' ? state.target.envWritable : state.sourceControlEnv;
    const args = [
      `--env-file=${envFile}`,
      'apps/api/dist/cli.js',
      action,
      ...(action === 'recovery:unlock' ? ['--reconciled'] : []),
    ];
    // A remote fence can survive a failed database transaction or process death.
    state.originalNeedsReconcile = true;
    await save();
    await command(which + '-' + action, process.execPath, args, {
      cleanup,
      trackMutation: true,
      timeoutMs: 150000,
    });
  }
  async function quiesceRecoveryCommands() {
    assertClosed();
    for (const record of state.mutationCommands ?? []) {
      if (record.closedAt) continue;
      requireValue(
        [process.execPath, 'docker'].includes(record.binary) &&
          typeof record.tail === 'string' &&
          record.tail.length < 8192 &&
          (record.tail.includes(directory + '/') ||
            record.tail.includes(state.target.redisName) ||
            record.tail.includes(state.target.volumeName) ||
            record.tail.includes(state.target.redisContainerId ?? 'UNSAVED_CONTAINER')),
        'RECOVERY_COMMAND_INTENT_CHANGED',
      );
      const rows = (
        await command('find-interrupted-mutation-command', 'ps', ['-axo', 'pid=,pgid=,command='], {
          cleanup: true,
          timeoutMs: 5000,
        })
      )
        .split('\n')
        .map((row) => /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(row))
        .filter(Boolean)
        .map((match) => ({ pid: Number(match[1]), group: Number(match[2]), command: match[3] }));
      const matches = rows.filter((row) => row.command.endsWith(record.tail));
      requireValue(matches.length <= 1, 'RECOVERY_COMMAND_AMBIGUOUS');
      if (matches.length) {
        const { pid, group } = matches[0];
        const cwd = await command(
          'interrupted-recovery-cwd',
          'lsof',
          ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
          { cleanup: true, timeoutMs: 5000 },
        );
        const start = await command(
          'interrupted-recovery-start',
          'ps',
          ['-p', String(pid), '-o', 'lstart='],
          { cleanup: true, timeoutMs: 5000 },
        );
        requireValue(
          pid === group &&
            (!record.pid || record.pid === pid) &&
            cwd.split('\n').includes(`n${root}`) &&
            (!record.processStart || record.processStart === start),
          'RECOVERY_COMMAND_IDENTITY_CHANGED',
        );
        const groupAlive = () => {
          try {
            process.kill(-group, 0);
            return true;
          } catch (error) {
            if (error.code === 'ESRCH') return false;
            throw error;
          }
        };
        process.kill(-group, 'SIGTERM');
        try {
          await waitFor(groupAlive, (value) => !value, {
            timeoutMs: 5000,
            signal: cleanupAbort.signal,
          });
        } catch {
          // If the group leader survives, re-check its start identity before escalation.
          if (live(pid))
            requireValue(
              (await command(
                'interrupted-recovery-recheck',
                'ps',
                ['-p', String(pid), '-o', 'lstart='],
                { cleanup: true, timeoutMs: 5000 },
              )) === start,
              'RECOVERY_COMMAND_IDENTITY_CHANGED',
            );
          if (groupAlive()) process.kill(-group, 'SIGKILL');
          await waitFor(groupAlive, (value) => !value, {
            timeoutMs: 5000,
            signal: cleanupAbort.signal,
          });
        }
      } else {
        requireValue(!live(record.pid), 'RECOVERY_COMMAND_PID_CHANGED');
        // Do not guess ownership of a leaderless group on a later invocation.
        requireValue(
          !record.processGroup || !rows.some((row) => row.group === record.processGroup),
          'ORPHANED_MUTATION_GROUP_REQUIRES_REVIEW',
        );
      }
      record.closedAt = new Date().toISOString();
      record.interrupted = true;
      await save();
    }
  }
  async function confirmUnlocked(db, intent) {
    const current = await db.controlPlaneState.findUniqueOrThrow({
      where: { id: 'control-plane' },
    });
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
        current.generation > intent.beforeHighGeneration &&
        !audit.metadata.historyAcceptanceId &&
        !(audit.metadata.acceptedUnknownRunCount ?? 0),
      'FORMAL_UNLOCK_AUDIT_MISSING',
    );
    return { generation: current.generation, auditId: audit.id };
  }
  async function startProxy() {
    await freePort(state.target.httpsPort);
    server = httpsServer(
      {
        key: await privateFile(state.target.tlsKeyFile),
        cert: await readFile(state.target.tlsCertificateFile),
        minVersion: 'TLSv1.2',
      },
      (incoming, outgoing) => {
        if (!incoming.url?.startsWith('/api/')) {
          outgoing
            .writeHead(404, { 'content-type': 'application/json' })
            .end('{"code":"JOINT_ROUTE_MISSING"}');
          return;
        }
        const upstream = httpRequest(
          {
            hostname: '127.0.0.1',
            port: state.target.ports.api,
            path: incoming.url,
            method: incoming.method,
            agent: false,
            headers: {
              ...incoming.headers,
              host: `127.0.0.1:${state.target.ports.api}`,
              connection: 'close',
              'x-forwarded-proto': 'https',
            },
          },
          (reply) => {
            outgoing.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(outgoing);
            reply.once('error', () => outgoing.destroy());
          },
        );
        upstream.setTimeout(5000, () => upstream.destroy());
        upstream.once('error', () => {
          if (!outgoing.headersSent)
            outgoing
              .writeHead(502, { 'content-type': 'application/json' })
              .end('{"code":"JOINT_UPSTREAM_UNAVAILABLE"}');
          else outgoing.destroy();
        });
        incoming.once('aborted', () => upstream.destroy());
        incoming.once('error', () => upstream.destroy());
        outgoing.once('close', () => upstream.destroy());
        incoming.pipe(upstream);
      },
    );
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(state.target.httpsPort, '127.0.0.1', accept);
    });
  }
  async function stopProxy() {
    if (server) {
      server.closeAllConnections();
      await new Promise((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      server = undefined;
    }
    if (state.target)
      requireValue(
        (await portState(state.target.httpsPort)) === 'closed',
        'HTTPS_ENTRY_STILL_RUNNING',
      );
  }
  async function originalOffline() {
    requireValue(
      Object.values(await originalProcesses(true)).every((value) => value === null),
      'ORIGINAL_PROCESS_STILL_RUNNING',
    );
    for (const port of Object.values(state.originalPorts))
      requireValue((await portState(port)) === 'closed', 'ORIGINAL_PORT_STILL_OPEN');
    requireValue(!(await originalRedis(true)).running, 'ORIGINAL_REDIS_STILL_RUNNING');
    idle(await facts(sourceDb));
  }
  async function stopOriginal(cleanup = false, beginIncident = false) {
    await originalProcesses(cleanup);
    await originalRedis(cleanup);
    if (beginIncident) await mark('incident');
    await command(
      'stop-original-api-worker',
      process.execPath,
      [`--env-file=${state.sourceControlEnv}`, 'tests/probes/local-runtime.mjs', 'stop'],
      { cleanup, timeoutMs: 30000 },
    );
    await command(
      'stop-original-redis',
      'docker',
      ['compose', '--env-file', state.sourceControlEnv, '-f', 'compose.dev.yaml', 'stop', 'redis'],
      { cleanup, timeoutMs: 30000 },
    );
    await originalOffline();
  }
  async function returnOriginal() {
    returningOriginal = true;
    await phase('return-original');
    if (!report.marks.originalReturnStarted) await mark('originalReturnStarted');
    let stoppingFailure;
    try {
      await quiesceRecoveryCommands();
    } catch (error) {
      stoppingFailure = error;
    }
    try {
      await stopProxy();
    } catch (error) {
      stoppingFailure ??= error;
    }
    try {
      await runtime.stopAll();
    } catch (error) {
      stoppingFailure ??= error;
    }
    if (stoppingFailure) throw stoppingFailure;
    assertClosed();
    await verifyInputs();
    await vmState(true);
    await stopOriginal(true);
    const before = await facts(sourceDb);
    idle(before);
    requireValue(
      isDeepStrictEqual(retained(before), retained(state.sourceSnapshot)),
      'ORIGINAL_FACTS_CHANGED',
    );
    const remote = await inventory('original-before-return-inventory', true);
    completeInventory(before, remote, trusted);
    state.originalNeedsReconcile = true;
    state.originalReturnRequired = true;
    state.originalReturnIntent = {
      at: new Date().toISOString(),
      attempt,
      beforeHighGeneration: remote.highGeneration,
    };
    await save();
    await invokeRecovery('source', 'recovery:lock', true);
    await invokeRecovery('source', 'recovery:unlock', true);
    const confirmed = await confirmUnlocked(sourceDb, state.originalReturnIntent);
    requireValue(confirmed, 'ORIGINAL_UNLOCK_NOT_CONFIRMED');
    const after = await facts(sourceDb),
      afterRemote = await inventory('original-after-return-inventory', true);
    completeInventory(after, afterRemote, trusted);
    requireValue(
      afterRemote.highGeneration === confirmed.generation &&
        !after.control.restoreLocked &&
        isDeepStrictEqual(retained(after), retained(state.sourceSnapshot)),
      'ORIGINAL_GENERATION_OR_HISTORY_CHANGED',
    );
    await workloadIdentity('original-return-k3s', true);
    await command(
      'start-original-redis',
      'docker',
      ['compose', '--env-file', state.sourceControlEnv, '-f', 'compose.dev.yaml', 'start', 'redis'],
      { cleanup: true, timeoutMs: 30000 },
    );
    await waitFor(
      () => originalRedis(true),
      (value) => value.running && value.healthy,
      { timeoutMs: 60000, signal: cleanupAbort.signal },
    );
    state.originalRestartIntent = { at: new Date().toISOString(), attempt };
    await save();
    await command(
      'start-original-api-worker',
      process.execPath,
      [
        `--env-file=${state.sourceControlEnv}`,
        'tests/probes/local-runtime.mjs',
        'start',
        '--profile=s6-github',
      ],
      { cleanup: true, timeoutMs: 90000 },
    );
    await originalProcesses(true, true);
    await ready('source', false, true);
    await login('source', true);
    if (state.omittedCheckpoint) {
      const reply = await api('source', '/clusters/' + state.omittedCheckpoint.id, {
        cleanup: true,
      });
      requireValue(
        reply.status === 200 &&
          isDeepStrictEqual(checkpointView(reply.value.data), state.omittedCheckpoint),
        'ORIGINAL_OMITTED_CHECKPOINT_CHANGED',
      );
    }
    const last = await facts(sourceDb),
      lastRemote = await inventory('original-ready-inventory', true);
    completeInventory(last, lastRemote, trusted);
    idle(last);
    requireValue(
      lastRemote.highGeneration === confirmed.generation &&
        last.control.generation === confirmed.generation &&
        isDeepStrictEqual(retained(last), retained(state.sourceSnapshot)),
      'ORIGINAL_READY_FACTS_CHANGED',
    );
    await workloadIdentity('original-ready-k3s', true);
    state.originalApplications = await applications('original-ready-applications', sourceDb, true);
    assertJointApplicationIdentity(state.applicationsBaseline, state.originalApplications);
    await mark('originalReady');
    state.originalNeedsReconcile = false;
    state.originalReturnRequired = false;
    state.originalReturnedGeneration = confirmed.generation;
    state.originalReturnCompletedAt = new Date().toISOString();
    await save();
    await check('original-runtime-returned-and-formally-reconciled', {
      ...confirmed,
      originalEnvAndKeysUnchanged: true,
    });
  }

  // Main state-machine bodies are deliberately below the cleanup implementation:
  // every mutation after incident has an already defined path back to the source.
  async function prepare() {
    await phase('prepare-read-only-preflight');
    await reserve(10);
    await vmState();
    await ready('source', false);
    const current = await facts(sourceDb);
    idle(current);
    requireValue(!current.control.restoreLocked, 'SOURCE_ALREADY_LOCKED');
    const remote = await inventory('prepared-builder-inventory');
    completeInventory(current, remote, trusted);
    requireValue(
      current.control.generation === remote.highGeneration,
      'SOURCE_BUILDER_GENERATION_MISMATCH',
    );
    state.preparedSourceProcesses = await originalProcesses(false, true);
    const redis = await originalRedis();
    requireValue(redis.running && redis.healthy, 'ORIGINAL_REDIS_NOT_HEALTHY');
    state.originalRedis = redis.identity;
    state.preparedKube = await kube('prepared-k3s');
    state.preparedApplications = await applications('prepared-applications', sourceDb);
    await phase('prepare-protected-local-configuration');
    const target = (state.target = {
      database: `ozz_joint_${state.id.replaceAll('-', '').slice(0, 16)}`,
      keyFile: resolve(directory, 'restored-master-key.json'),
      envLocked: resolve(directory, 'target-read-only.env'),
      envWritable: resolve(directory, 'target-writable.env'),
      passwordFile: resolve(directory, 'redis-password'),
      redisName: `ozz-joint-${state.id.slice(0, 12)}-redis`,
      volumeName: `ozz-joint-${state.id.slice(0, 12)}-redis-data`,
      redisImage,
      ports: { api: await freePort(), worker: await freePort(), redis: await freePort() },
      httpsPort: await freePort(),
      runtime: {},
      caFile: resolve(directory, 'tls/ca.crt'),
      tlsKeyFile: resolve(directory, 'tls/server.key'),
      tlsCertificateFile: resolve(directory, 'tls/server.crt'),
    });
    const usedPorts = [...Object.values(target.ports), target.httpsPort];
    requireValue(
      new Set(usedPorts).size === usedPorts.length &&
        usedPorts.every((port) => !Object.values(state.originalPorts).includes(port)),
      'TARGET_PORT_COLLISION',
    );
    target.origin = `https://127.0.0.1:${target.httpsPort}`;
    const redisPassword = randomBytes(32).toString('base64url');
    await newFile(target.passwordFile, redisPassword + '\n');
    const environment = {
      ...sourceEnv,
      HOST: '127.0.0.1',
      DATABASE_URL: targetUrl(),
      MASTER_KEY_FILE: target.keyFile,
      APP_ORIGIN: target.origin,
      PORT: String(target.ports.api),
      WORKER_HEALTH_PORT: String(target.ports.worker),
      REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${target.ports.redis}/0`,
      LOG_LEVEL: 'silent',
      REGISTRY_HTTP_PROXY: registryProxyOrigin,
      POSTGRES_IMAGE: postgresImage,
    };
    const envText = (values) =>
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
        .join('\n') + '\n';
    for (const locked of [true, false])
      await newFile(
        locked ? target.envLocked : target.envWritable,
        envText({ ...environment, RESTORE_MODE: String(locked) }),
      );
    state.sourceControlEnv = resolve(directory, 'original-control.env');
    await newFile(
      state.sourceControlEnv,
      envText({ ...sourceEnv, MASTER_KEY_FILE: sourceKeyFile }),
    );
    const tls = resolve(directory, 'tls');
    await safeDirectory(tls, true);
    await newFile(
      resolve(tls, 'ca.cnf'),
      '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Ozz joint recovery local CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',
    );
    await newFile(
      resolve(tls, 'leaf.cnf'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n',
    );
    await command('create-local-ca', 'openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-config',
      resolve(tls, 'ca.cnf'),
      '-keyout',
      resolve(tls, 'ca.key'),
      '-out',
      target.caFile,
    ]);
    await command('create-local-leaf-request', 'openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=127.0.0.1',
      '-keyout',
      target.tlsKeyFile,
      '-out',
      resolve(tls, 'server.csr'),
    ]);
    await command('sign-local-leaf', 'openssl', [
      'x509',
      '-req',
      '-in',
      resolve(tls, 'server.csr'),
      '-CA',
      target.caFile,
      '-CAkey',
      resolve(tls, 'ca.key'),
      '-CAcreateserial',
      '-out',
      target.tlsCertificateFile,
      '-days',
      '2',
      '-sha256',
      '-extfile',
      resolve(tls, 'leaf.cnf'),
    ]);
    for (const name of ['database-backups', 'key-backups'])
      await safeDirectory(resolve(directory, name), true);
    for (const image of [postgresImage, redisImage])
      await command('cached-image', 'docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
    const count = await sourceDb.$queryRawUnsafe(
      'SELECT datname FROM pg_database WHERE datname=$1',
      target.database,
    );
    requireValue(!count.length, 'TARGET_DATABASE_EXISTS');
    const code = [
      'tests/probes/g-mvp-recovery-joint-timing-local-lab.mjs',
      'tests/probes/support/g-mvp-recovery-joint-runtime.mjs',
      'tests/probes/support/g-mvp-recovery-joint-continuity.mjs',
      'tests/probes/support/g-mvp-recovery-k3s.py',
      'tests/probes/support/g-mvp-continuity-k3s.py',
      'docs/acceptance/s4-product-local-results.json',
      'docs/acceptance/s6-product-results.json',
      'docs/acceptance/s6-webhook-local-results.json',
      'tests/probes/local-runtime.mjs',
      'tests/probes/s6-product-api.mjs',
      'tests/probes/s6-product-worker.mjs',
      'tests/probes/support/s6-github-product.mjs',
      'scripts/backup-control-plane.mjs',
      'scripts/restore-control-plane.mjs',
      'scripts/backup-helpers.mjs',
      'scripts/backup-snapshot.mjs',
      'apps/api/dist/cli.js',
      'apps/api/dist/app.js',
      'apps/worker/dist/main.js',
      'packages/control-plane/dist/builds/recovery.js',
      'packages/control-plane/dist/builds/recovery-history.js',
      'infra/local-lab/assets.lock.json',
      'compose.dev.yaml',
    ].map((path) => resolve(root, path));
    const protectedPaths = [
      state.sourceEnvFile,
      resolve(root, '.env'),
      sourceKeyFile,
      resolve(root, '.secrets/admin-password'),
      state.sourceControlEnv,
      target.envLocked,
      target.envWritable,
      target.passwordFile,
      target.caFile,
      target.tlsKeyFile,
      target.tlsCertificateFile,
      resolve(lab, 'builder/operator-config.json'),
      resolve(lab, 'builder/identity-public-key.pem'),
      ...['ca.crt', 'client.crt', 'client.key'].map((name) => resolve(lab, 'builder/pki', name)),
      resolve(lab, 'credentials/ssh_config'),
      resolve(lab, 'credentials/known_hosts'),
    ];
    state.protectedHashes = {};
    for (const path of [...code, ...protectedPaths])
      state.protectedHashes[path] = hash(await readFile(path));
    state.identity = {
      installationId: current.control.installationId,
      builderId: current.builders[0].id,
      builderInstanceId: trusted.operator.instanceId,
      builderPublicKeySha256: hash(trusted.publicKey),
      originalDatabase: decodeURIComponent(new URL(sourceEnv.DATABASE_URL).pathname.slice(1)),
      targetHttps: target.origin,
      targetCaSha256: hash(await readFile(target.caFile)),
      targetLeafFingerprint256: new X509Certificate(await readFile(target.tlsCertificateFile))
        .fingerprint256,
    };
    state.status = 'prepared';
    state.preparedAt = new Date().toISOString();
    await save();
    await check('prepared-without-runtime-or-database-mutation', {
      remoteRuns: remote.totalRuns,
      remoteGeneration: remote.highGeneration,
    });
  }

  async function run() {
    state.runAttempt = attempt;
    state.status = 'running';
    await save();
    await phase('run-preflight');
    await verifyInputs();
    await reserve(10);
    await vmState();
    await ready('source', false);
    await originalProcesses(false, true);
    const redis = await originalRedis();
    requireValue(redis.running && redis.healthy, 'ORIGINAL_REDIS_NOT_HEALTHY');
    const initial = await facts(sourceDb);
    idle(initial);
    requireValue(!initial.control.restoreLocked, 'SOURCE_ALREADY_LOCKED');
    const baselineInventory = await inventory('source-current-inventory');
    completeInventory(initial, baselineInventory, trusted);
    requireValue(
      initial.control.generation === baselineInventory.highGeneration,
      'SOURCE_BUILDER_GENERATION_MISMATCH',
    );
    state.kubeBaseline = await kube('source-current-k3s');
    state.applicationsBaseline = await applications('source-current-applications', sourceDb);
    const oldSession = await login('source');
    await phase('dedicated-checkpoint-and-current-backup');
    state.checkpointIntent = {
      slug: `joint-${state.id.slice(0, 12)}`,
      at: new Date().toISOString(),
    };
    await save();
    const created = await metadata(
      'source',
      'POST',
      '/clusters',
      {
        name: 'Joint recovery checkpoint ' + state.id.slice(0, 8),
        slug: state.checkpointIntent.slug,
      },
      201,
    );
    state.checkpointId = created.id;
    await save();
    await mark('checkpointRequested');
    const saved = await metadata(
      'source',
      'PATCH',
      '/clusters/' + created.id,
      { revision: created.revision, description: `saved-${state.id}` },
      200,
    );
    await mark('checkpointAcknowledged');
    state.savedCheckpoint = checkpointView(saved);
    state.savedTuple = await checkpointTuple(sourceDb, saved);
    await save();
    state.sourceSnapshot = await facts(sourceDb);
    idle(state.sourceSnapshot);
    await mark('backupStarted');
    const receipt = JSON.parse(
      await command(
        'current-consistent-backup',
        process.execPath,
        [
          'scripts/backup-control-plane.mjs',
          '--env-file',
          state.sourceControlEnv,
          '--database-dir',
          resolve(directory, 'database-backups'),
          '--key-dir',
          resolve(directory, 'key-backups'),
          '--label',
          'joint-' + state.id,
        ],
        { timeoutMs: 600000 },
      ),
    );
    await mark('backupCompleted');
    requireValue(
      receipt.status === 'complete' &&
        receipt.backupId === 'joint-' + state.id &&
        receipt.databaseDirectory === resolve(directory, 'database-backups', receipt.backupId) &&
        receipt.keyDirectory === resolve(directory, 'key-backups', receipt.backupId),
      'BACKUP_RECEIPT_CHANGED',
    );
    const manifest = JSON.parse(
        await privateFile(resolve(receipt.databaseDirectory, 'manifest.json')),
      ),
      keyManifest = JSON.parse(await privateFile(resolve(receipt.keyDirectory, 'manifest.json')));
    const observation = verifyBackupSnapshot(manifest, keyManifest);
    requireValue(observation, 'CURRENT_SNAPSHOT_OBSERVATION_REQUIRED');
    requireValue(
      manifest.backupId === receipt.backupId &&
        keyManifest.backupId === receipt.backupId &&
        manifest.kind === 'ozz-control-plane' &&
        keyManifest.kind === 'ozz-master-key' &&
        manifest.status === 'complete' &&
        keyManifest.status === 'complete' &&
        manifest.sourceDatabase === state.identity.originalDatabase &&
        manifest.generation === state.sourceSnapshot.control.generation &&
        (await hashFile(resolve(receipt.databaseDirectory, 'database.dump'))) ===
          manifest.databaseSha256 &&
        hash(await privateFile(resolve(receipt.keyDirectory, 'master-key.json'))) ===
          manifest.masterKeySha256 &&
        manifest.masterKeySha256 === keyManifest.masterKeySha256,
      'BACKUP_PAIR_CHANGED',
    );
    requireValue(
      visibleInSnapshot(state.savedTuple.xid, observation.pgSnapshot),
      'SAVED_CHECKPOINT_OUTSIDE_SNAPSHOT',
    );
    state.backup = { ...receipt, manifest, snapshotObservation: observation };
    await save();
    report.backup = {
      backupId: receipt.backupId,
      databaseSha256: manifest.databaseSha256,
      masterKeySha256: manifest.masterKeySha256,
      snapshotObservationSha256: manifest.snapshotObservationSha256,
      snapshotObservation: observation,
      parentProcessBounded: true,
    };
    await mark('omittedRequested');
    const omitted = await metadata(
      'source',
      'PATCH',
      '/clusters/' + created.id,
      { revision: saved.revision, description: `omitted-${state.id}` },
      200,
    );
    await mark('omittedAcknowledged');
    state.omittedCheckpoint = checkpointView(omitted);
    state.omittedTuple = await checkpointTuple(sourceDb, omitted);
    requireValue(
      !visibleInSnapshot(state.omittedTuple.xid, observation.pgSnapshot) &&
        BigInt(state.omittedTuple.xid) > BigInt(state.savedTuple.xid),
      'POST_SNAPSHOT_CHECKPOINT_VISIBLE',
    );
    const beforeIncident = await facts(sourceDb);
    idle(beforeIncident);
    requireValue(
      isDeepStrictEqual(retained(beforeIncident), retained(state.sourceSnapshot)),
      'SOURCE_BUSINESS_HISTORY_CHANGED_BEFORE_INCIDENT',
    );
    completeInventory(beforeIncident, await inventory('source-before-incident-inventory'), trusted);
    await workloadIdentity('source-before-incident-k3s');
    for (const port of [...Object.values(state.target.ports), state.target.httpsPort])
      await freePort(port);
    state.originalReturnRequired = true;
    state.incidentIntent = { at: new Date().toISOString(), attempt };
    await save();
    await phase('incident-original-runtime-stop');
    await stopOriginal(false, true);
    await mark('originalStopped');
    // The original API, Worker and Redis are all confirmed stopped, and no target
    // runtime exists yet. Observe live workload HTTPS in that actual outage window.
    state.originalOfflineApplications = await applications(
      'original-offline-applications',
      sourceDb,
    );
    assertJointApplicationIdentity(state.applicationsBaseline, state.originalOfflineApplications);
    await mark('originalOfflineApplicationsVerified');
    await check('applications-observed-during-control-plane-outage', {
      observedTargets: 2,
      continuousAvailabilityClaimed: false,
    });
    state.originalNeedsReconcile = true;
    await save();
    await invokeRecovery('source', 'recovery:lock');
    const lockedOriginal = await facts(sourceDb);
    requireValue(
      lockedOriginal.control.restoreLocked &&
        lockedOriginal.control.generation > state.sourceSnapshot.control.generation,
      'ORIGINAL_LOCK_NOT_CONFIRMED',
    );
    await phase('target-preparation-and-backup-retrieval');
    requireValue(
      /^ozz_joint_[a-f0-9]{16}$/u.test(state.target.database),
      'TARGET_DATABASE_NAME_INVALID',
    );
    const existing = await sourceDb.$queryRawUnsafe(
      'SELECT datname FROM pg_database WHERE datname=$1',
      state.target.database,
    );
    requireValue(!existing.length, 'TARGET_DATABASE_EXISTS');
    state.target.createIntent = { at: new Date().toISOString(), attempt };
    await save();
    await sourceDb.$executeRawUnsafe(`CREATE DATABASE "${state.target.database}"`);
    state.target.created = true;
    await save();
    await mark('targetCreated');
    targetDb = database(targetUrl());
    const retrievedDatabase = resolve(directory, 'retrieved-database'),
      retrievedKeys = resolve(directory, 'retrieved-keys');
    await cp(receipt.databaseDirectory, retrievedDatabase, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await cp(receipt.keyDirectory, retrievedKeys, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await mark('backupRetrieved');
    await phase('formal-restore');
    state.target.restoreIntent = { at: new Date().toISOString(), attempt };
    await save();
    await mark('restoreStarted');
    const restored = JSON.parse(
      await command(
        'formal-target-restore',
        process.execPath,
        [
          'scripts/restore-control-plane.mjs',
          '--env-file',
          state.target.envLocked,
          '--database-backup',
          retrievedDatabase,
          '--key-backup',
          retrievedKeys,
          '--target-key-file',
          state.target.keyFile,
        ],
        { timeoutMs: 600000 },
      ),
    );
    await mark('restoreCompleted');
    const sealedReceipt = JSON.parse(await privateFile(state.target.keyFile + '.restore.json'));
    requireValue(
      restored.backupId === manifest.backupId &&
        restored.database === state.target.database &&
        restored.restoreLocked === true &&
        restored.generation === manifest.generation + 1 &&
        restored.snapshotObservationSha256 === manifest.snapshotObservationSha256 &&
        sealedReceipt.formatVersion === 1 &&
        sealedReceipt.backupId === manifest.backupId &&
        sealedReceipt.database === state.target.database &&
        sealedReceipt.restoreLocked === true &&
        sealedReceipt.snapshotObservationSha256 === manifest.snapshotObservationSha256 &&
        sealedReceipt.generation === restored.generation &&
        hash(await privateFile(state.target.keyFile)) === manifest.masterKeySha256,
      'RESTORE_RECEIPT_CHANGED',
    );
    state.target.restoreReceipt = sealedReceipt;
    state.target.restoredFacts = await facts(targetDb);
    idle(state.target.restoredFacts);
    requireValue(
      state.target.restoredFacts.control.restoreLocked &&
        state.target.restoredFacts.control.installationId === state.identity.installationId &&
        state.target.restoredFacts.control.generation === restored.generation &&
        isDeepStrictEqual(retained(state.target.restoredFacts), retained(state.sourceSnapshot)),
      'RESTORED_FACTS_CHANGED',
    );
    await save();
    await phase('read-only-https-authentication');
    await runtime.startRedis();
    await startProxy();
    await runtime.startNodes(true);
    await ready('target', true);
    requireValue(
      (await api('target', '/auth/me', { session: oldSession })).status === 401,
      'RESTORED_OLD_SESSION_STILL_VALID',
    );
    await login('target');
    const targetCheckpoint = await api('target', '/clusters/' + state.savedCheckpoint.id);
    requireValue(
      targetCheckpoint.status === 200 &&
        isDeepStrictEqual(checkpointView(targetCheckpoint.value.data), state.savedCheckpoint) &&
        !isDeepStrictEqual(checkpointView(targetCheckpoint.value.data), state.omittedCheckpoint),
      'RESTORED_CHECKPOINT_WRONG',
    );
    const rejected = await api('target', '/operations/diagnostics', {
      method: 'POST',
      body: { durationMs: 25 },
      headers: { 'idempotency-key': randomUUID() },
    });
    requireValue(
      rejected.status === 503 &&
        rejected.value?.code === 'RESTORE_READ_ONLY' &&
        isDeepStrictEqual(retained(await facts(targetDb)), retained(state.target.restoredFacts)),
      'READ_ONLY_WRITE_NOT_REFUSED',
    );
    await mark('readOnlyVerified');
    await check('current-snapshot-logical-checkpoints-verified', {
      savedXid: state.savedTuple.xid,
      omittedXid: state.omittedTuple.xid,
      snapshotObservationSha256: manifest.snapshotObservationSha256,
      oldSessionRevoked: true,
    });
    await phase('real-builder-and-k3s-reconciliation');
    await runtime.stopNodes();
    const remoteBefore = await inventory('target-before-unlock-inventory');
    completeInventory(await facts(targetDb), remoteBefore, trusted);
    await workloadIdentity('target-before-unlock-k3s');
    state.target.unlockIntent = {
      at: new Date().toISOString(),
      attempt,
      beforeHighGeneration: remoteBefore.highGeneration,
    };
    state.originalNeedsReconcile = true;
    await save();
    await mark('unlockStarted');
    await invokeRecovery('target', 'recovery:unlock');
    const confirmed = await confirmUnlocked(targetDb, state.target.unlockIntent);
    requireValue(confirmed, 'TARGET_UNLOCK_NOT_CONFIRMED');
    const remoteAfter = await inventory('target-after-unlock-inventory');
    completeInventory(await facts(targetDb), remoteAfter, trusted);
    requireValue(
      remoteAfter.highGeneration === confirmed.generation,
      'TARGET_GENERATION_BELOW_BUILDER',
    );
    state.target.unlockedGeneration = confirmed.generation;
    state.target.unlockAuditId = confirmed.auditId;
    await save();
    await mark('unlockCompleted');
    await phase('writable-readiness-and-new-generation-diagnostic');
    await runtime.startNodes(false);
    await ready('target', false);
    await login('target');
    await mark('writableReady');
    state.target.diagnosticIntent = { key: randomUUID(), at: new Date().toISOString(), attempt };
    await save();
    const accepted = await api('target', '/operations/diagnostics', {
      method: 'POST',
      body: { durationMs: 25 },
      headers: { 'idempotency-key': state.target.diagnosticIntent.key },
    });
    requireValue(
      accepted.status === 202 && uuid.test(accepted.value?.data?.id),
      'DIAGNOSTIC_NOT_ACCEPTED',
    );
    state.target.diagnosticIntent.id = accepted.value.data.id;
    await save();
    await waitFor(
      async () => {
        const response = await api('target', '/operations/' + state.target.diagnosticIntent.id);
        requireValue(
          response.status === 200 && !['failed', 'cancelled'].includes(response.value.data.status),
          'DIAGNOSTIC_FAILED',
        );
        return response.value.data;
      },
      (value) => value.status === 'succeeded',
      { timeoutMs: 60000, signal: abort.signal },
    );
    await mark('diagnosticCompleted');
    await phase('final-identity-and-resource-verification');
    const final = await facts(targetDb),
      operation = final.operations.find((row) => row.id === state.target.diagnosticIntent.id),
      rest = {
        ...final,
        operations: final.operations.filter((row) => row.id !== state.target.diagnosticIntent.id),
      };
    requireValue(
      operation?.kind === 'diagnostic' &&
        operation.status === 'succeeded' &&
        operation.generation === confirmed.generation &&
        isDeepStrictEqual(retained(rest), retained(state.sourceSnapshot)),
      'DIAGNOSTIC_GENERATION_OR_HISTORY_CHANGED',
    );
    idle(final);
    const lastRemote = await inventory('target-final-inventory');
    completeInventory(final, lastRemote, trusted);
    requireValue(
      lastRemote.highGeneration === confirmed.generation &&
        final.control.generation === confirmed.generation &&
        !final.control.restoreLocked,
      'FINAL_GENERATION_CHANGED',
    );
    await workloadIdentity('target-final-k3s');
    state.target.finalApplications = await applications('target-final-applications', targetDb);
    assertJointApplicationIdentity(state.applicationsBaseline, state.target.finalApplications);
    await verifyInputs();
    await reserve(8);
    await mark('recovered');
    state.target.recoveredAt = new Date().toISOString();
    await save();
    await check('same-process-joint-recovery-completed', {
      generation: confirmed.generation,
      diagnosticId: operation.id,
      signedInventoryRuns: lastRemote.totalRuns,
      newBuildOrDeployment: false,
    });
  }

  let failure,
    cleanupFailure,
    stateAdmitted = false;
  try {
    for (const path of [
      statePath + '.lock',
      resolve(parentDirectory, 'window.lock'),
      resolve(lab, 'g-mvp-recovery/state.json.lock'),
      resolve(lab, 's6-product/state.json.lock'),
      resolve(lab, 's6-webhook/state.json.lock'),
      resolve(lab, 's6-builder-faults/state.json.lock'),
      resolve(lab, 'g-mvp-workload-faults/probe.lock'),
    ])
      await acquire(path);
    if (state)
      requireValue(
        hash(await privateFile(statePath, 16 * 1024 * 1024)) === initialStateDigest,
        'STATE_CHANGED_BEFORE_LOCK',
      );
    else {
      try {
        await lstat(statePath);
        throw new Error('GMVP_JOINT_STATE_CHANGED_BEFORE_LOCK');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    stateAdmitted = true;
    if (mode === 'run') {
      const prepared = await finalReceipt();
      requireValue(
        prepared.mode === 'prepare' &&
          prepared.status === 'passed' &&
          prepared.closure?.eventsClosed === true &&
          Array.isArray(prepared.closure.failures) &&
          prepared.closure.failures.length === 0,
        'SUCCESSFUL_PREPARE_RECEIPT_REQUIRED',
      );
    }
    if (state) await newFile(resolve(attemptDirectory, 'state-before.json'), encode(state));
    state ??= {
      formatVersion: 1,
      owner,
      id: randomUUID(),
      session,
      sourceEnvFile: resolve(root, sourceFile),
      status: 'preparing',
      originalNeedsReconcile: false,
      originalReturnRequired: false,
    };
    if (state.target)
      requireValue(
        state.target.redisImage === redisImage &&
          state.target.database === `ozz_joint_${state.id.replaceAll('-', '').slice(0, 16)}` &&
          state.target.envLocked === resolve(directory, 'target-read-only.env') &&
          state.target.envWritable === resolve(directory, 'target-writable.env') &&
          state.sourceControlEnv === resolve(directory, 'original-control.env'),
        'TARGET_CONFIGURATION_CHANGED',
      );
    runtime = ownedRuntime({ root, directory, state, save, command, signal: abort.signal });
    if (mode === 'return-original') {
      requireValue(
        state.originalReturnRequired || state.originalNeedsReconcile,
        'ORIGINAL_RETURN_NOT_REQUIRED',
      );
      await mark('originalReturnStarted');
      // Close verified target resources before unrelated fixtures, source code,
      // credentials, or Builder checks can fail. Those still gate original unlock.
      let initialFailure;
      try {
        await quiesceRecoveryCommands();
      } catch (error) {
        initialFailure = error;
      }
      try {
        await stopProxy();
      } catch (error) {
        initialFailure ??= error;
      }
      try {
        await runtime.stopAll();
      } catch (error) {
        initialFailure ??= error;
      }
      if (initialFailure) throw initialFailure;
    }
    requireValue(state.sourceEnvFile === resolve(root, sourceFile), 'SOURCE_SELECTION_CHANGED');
    const raw = await privateFile(state.sourceEnvFile);
    // local-runtime owns processes started with --env-file=.env; a supplied copy
    // is acceptable only when it describes that same original environment.
    requireValue(
      hash(raw) === hash(await privateFile(resolve(root, '.env'))),
      'SOURCE_DOES_NOT_MATCH_OWNED_RUNTIME',
    );
    sourceEnv = parseEnv(raw.toString('utf8'));
    const databaseUrl = new URL(sourceEnv.DATABASE_URL),
      redisUrl = new URL(sourceEnv.REDIS_URL);
    requireValue(
      ['postgres:', 'postgresql:'].includes(databaseUrl.protocol) &&
        ['127.0.0.1', 'localhost'].includes(databaseUrl.hostname) &&
        databaseUrl.username &&
        databaseUrl.password &&
        (databaseUrl.searchParams.get('schema') ?? 'public') === 'public' &&
        sourceEnv.RESTORE_MODE !== 'true' &&
        typeof sourceEnv.MASTER_KEY_FILE === 'string' &&
        ['127.0.0.1', 'localhost'].includes(redisUrl.hostname),
      'SOURCE_CONFIGURATION_UNSUPPORTED',
    );
    sourceKeyFile = resolve(root, sourceEnv.MASTER_KEY_FILE);
    await privateFile(sourceKeyFile);
    const originalPorts = {
      api: Number(sourceEnv.PORT ?? 3000),
      worker: Number(sourceEnv.WORKER_HEALTH_PORT ?? 3001),
      redis: Number(redisUrl.port || 6379),
    };
    requireValue(
      Object.values(originalPorts).every(
        (port) => Number.isInteger(port) && port > 1024 && port < 65536,
      ) &&
        new Set(Object.values(originalPorts)).size === 3 &&
        (!state.originalPorts || isDeepStrictEqual(state.originalPorts, originalPorts)),
      'ORIGINAL_PORTS_CHANGED',
    );
    state.originalPorts = originalPorts;
    sourceDb = database(databaseUrl.href);
    trusted = await loadTrust();
    product = await readProductConfiguration();
    sourceOrigin = publicAppOrigin;
    await checkFixtureHealth(product);
    await checkProductHttpsHealth(product);
    if (mode !== 'prepare') await verifyInputs();
    await save();
    monitor = setInterval(async () => {
      if (monitoring) return;
      monitoring = true;
      try {
        await reserve(8);
      } catch (error) {
        diskFailure = safeCode(error);
        abort.abort();
      } finally {
        monitoring = false;
      }
    }, 15000);
    if (mode === 'prepare') await prepare();
    else if (mode === 'run') await run();
    else {
      requireValue(
        state.originalReturnRequired || state.originalNeedsReconcile,
        'ORIGINAL_RETURN_NOT_REQUIRED',
      );
      await returnOriginal();
    }
  } catch (error) {
    failure = error;
    failingStage = stage;
  } finally {
    if (mode === 'run' && state?.originalReturnRequired && runtime) {
      try {
        await returnOriginal();
      } catch (error) {
        cleanupFailure = error;
      }
    } else if (runtime && mode !== 'prepare' && mode !== 'return-original') {
      try {
        await stopProxy();
        await runtime.stopAll();
      } catch (error) {
        cleanupFailure = error;
      }
    }
    clearInterval(monitor);
    while (monitoring) await delay(10);
    try {
      assertClosed();
    } catch (error) {
      cleanupFailure ??= error;
    }
    try {
      await sourceDb?.$disconnect();
      await targetDb?.$disconnect();
    } catch {
      cleanupFailure ??= new Error('GMVP_JOINT_DATABASE_DISCONNECT_FAILED');
    }
    report.completedAt = new Date().toISOString();
    try {
      report.timing = summarizeJointTiming(report.marks);
    } catch (error) {
      failure ??= error;
    }
    report.status =
      failure || cleanupFailure || diskFailure || report.evidencePersistenceFailed
        ? 'failed'
        : 'passed';
    if (
      mode === 'run' &&
      (!report.marks.recovered ||
        !report.marks.originalReady ||
        state?.originalReturnRequired ||
        state?.originalNeedsReconcile)
    )
      report.status = 'failed';
    if (failure || diskFailure)
      report.failure = {
        stage: failingStage ?? stage,
        code: diskFailure ?? safeCode(failure),
        driverSite:
          /g-mvp-recovery-joint-timing-local-lab\.mjs:[0-9]+:[0-9]+/u.exec(
            failure?.stack ?? '',
          )?.[0] ?? null,
      };
    if (cleanupFailure)
      report.originalReturnFailure = {
        code: safeCode(cleanupFailure),
        retry: `pnpm exec node tests/probes/g-mvp-recovery-joint-timing-local-lab.mjs return-original --session ${session}`,
      };
    if (mode === 'return-original') report.resumedAcrossProcesses = true;
    if (stateAdmitted && state && locks.some((row) => row.path === statePath + '.lock')) {
      // The final report is written after handles and locks actually close. State
      // never claims that pending closure has passed; status reads the final report.
      state.status = mode === 'prepare' && report.status === 'passed' ? 'prepared' : 'finished';
      state.lastMode = mode;
      state.lastAttempt = attempt;
      state.lastReport = resolve(attemptDirectory, 'report.json');
      report.result = publicState();
      report.identity = state.identity;
      report.protectedHashes = state.protectedHashes;
      report.checkpoints = { saved: state.savedTuple ?? null, omitted: state.omittedTuple ?? null };
      report.resources = {
        database: state.target?.database ?? null,
        redisName: state.target?.redisName ?? null,
        volumeName: state.target?.volumeName ?? null,
        keyFile: state.target?.keyFile ?? null,
        backupId: state.backup?.backupId ?? null,
      };
      try {
        await save();
      } catch {
        report.status = 'failed';
        report.statePersistenceFailed = true;
      }
    }
    report.closure = { eventsClosed: false, releasedLocks: [], failures: [] };
    try {
      await eventTail.catch(() => {});
      await events.close();
      report.closure.eventsClosed = true;
    } catch {
      report.status = 'failed';
      report.closure.failures.push({ code: 'EVENTS_CLOSE_FAILED' });
    }
    for (const lock of locks.reverse()) {
      try {
        await lock.handle.close();
        const current = await lstat(lock.path);
        requireValue(
          current.ino === lock.inode &&
            current.dev === lock.device &&
            current.uid === process.getuid(),
          'LOCK_IDENTITY_CHANGED',
        );
        await unlink(lock.path);
        report.closure.releasedLocks.push(lock.path);
      } catch {
        report.status = 'failed';
        report.closure.failures.push({ path: lock.path, code: 'LOCK_RELEASE_FAILED' });
      }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (report.result) report.result.status = receiptStatus(report);
    await newFile(resolve(attemptDirectory, 'report.json'), encode(report));
    console.log(
      JSON.stringify({
        status: report.status,
        report: resolve(attemptDirectory, 'report.json'),
        timing: report.timing,
        result: report.result ?? publicState(),
      }),
    );
  }
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      options: { session: { type: 'string' }, 'source-env': { type: 'string', default: '.env' } },
      allowPositionals: true,
    });
    requireValue(positionals.length === 1 && typeof values.session === 'string', 'USAGE_INVALID');
    await runJointRecovery(positionals[0], values.session, values['source-env']);
  } catch (error) {
    console.error(JSON.stringify({ code: safeCode(error) }));
    process.exitCode = 1;
  }
}
