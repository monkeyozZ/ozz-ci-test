import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient, type Cluster } from '../../packages/database/dist/index.js';
import { ClusterObserver } from '../../packages/control-plane/dist/infrastructure/index.js';
import { SecretCipher } from '../../packages/control-plane/dist/secrets.js';
import { TaskRepository } from '../../packages/control-plane/dist/tasks/index.js';
import {
  KubernetesAdapterError,
  parseKubeconfig,
  type KubernetesConnectionInspector,
  type KubernetesInspection,
  type KubernetesInspectOptions,
  type ParsedKubernetesConnection,
} from '../../packages/infrastructure/dist/kubernetes.js';

// This suite tests observer scheduling/fencing against real PostgreSQL. TLS and
// the official SDK are exercised separately by the Kubernetes Adapter suite and
// B04 lab probe; the controllable Inspector implements the same public seam.
const execute = promisify(execFile);
const schema = `observer_${randomUUID().replaceAll('-', '')}`;
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl) throw new Error('Observer integration requires DATABASE_URL.');
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-observer-integration-'));
const cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
const observers: ClusterObserver[] = [];
const inspectors: ControlledInspector[] = [];
const clients: PrismaClient[] = [];
let db: PrismaClient;
let ca: string;
let sequence = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Observer condition was not reached within the test deadline.');
}

interface PendingInspection {
  endpoint: string;
  options: KubernetesInspectOptions;
  aborted: boolean;
  settled: boolean;
  resolve: (value: KubernetesInspection) => void;
  reject: (error: KubernetesAdapterError) => void;
  finishAbort: () => void;
}

class ControlledInspector implements KubernetesConnectionInspector {
  readonly calls: PendingInspection[] = [];
  holdAbortCompletion = false;

  async inspect(connection: ParsedKubernetesConnection, options: KubernetesInspectOptions = {}) {
    const completion = deferred<KubernetesInspection>();
    const call: PendingInspection = {
      endpoint: connection.endpoint,
      options,
      aborted: false,
      settled: false,
      resolve: (value) => completion.resolve(value),
      reject: (error) => completion.reject(error),
      finishAbort: () => completion.reject(new KubernetesAdapterError('KUBERNETES_CANCELLED')),
    };
    const onAbort = () => {
      call.aborted = true;
      if (!this.holdAbortCompletion) call.finishAbort();
    };
    this.calls.push(call);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    try {
      return await completion.promise;
    } finally {
      call.settled = true;
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  forEndpoint(endpoint: string): PendingInspection[] {
    return this.calls.filter((call) => call.endpoint === endpoint);
  }

  releaseAll(): void {
    for (const call of this.calls) if (!call.settled) call.finishAbort();
  }
}

interface Target {
  cluster: Cluster;
  connection: ParsedKubernetesConnection;
  observation: KubernetesInspection;
}

async function target(
  label: string,
  nextObservationAt = new Date(Date.now() - 10_000),
): Promise<Target> {
  const name = `${label}-${++sequence}`;
  const endpoint = `https://${name}.observer.invalid`;
  const raw = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    preferences: {},
    clusters: [
      {
        name: 'cluster',
        cluster: {
          server: endpoint,
          'certificate-authority-data': Buffer.from(ca).toString('base64'),
        },
      },
    ],
    users: [{ name: 'user', user: { token: 'synthetic-observer-token' } }],
    contexts: [{ name: 'context', context: { cluster: 'cluster', user: 'user' } }],
    'current-context': 'context',
  });
  const connection = parseKubeconfig(raw);
  const credential = await db.secretReference.create({
    data: {
      name,
      kind: 'kubeconfig',
      ...cipher.encrypt('kubeconfig', { kubeconfig: raw }),
    },
  });
  const cluster = await db.cluster.create({
    data: {
      name,
      slug: name,
      apiEndpoint: endpoint,
      credentialRefId: credential.id,
      connectionStatus: 'connected',
      kubeSystemUid: randomUUID(),
      caFingerprint: connection.caFingerprint,
      lastObservedAt: new Date(Date.now() - 120_000),
      nextObservationAt,
    },
  });
  const metrics = { state: 'unavailable' as const, errorCode: null, observedAt: null };
  const resources = { cpuCores: 2, memoryBytes: 1024 ** 3, ephemeralStorageBytes: null, pods: 110 };
  const observation: KubernetesInspection = {
    endpoint,
    version: 'v1.35.9+scheduling-fixture',
    identity: { kubeSystemUid: cluster.kubeSystemUid!, caFingerprint: connection.caFingerprint },
    credential: connection.credential,
    observedAt: new Date().toISOString(),
    permissions: { clusterWideAdmin: false, checks: [] },
    nodesResourceVersion: 'scheduling-fixture',
    metrics,
    nodes: [
      {
        uid: randomUUID(),
        name: 'same-node',
        resourceVersion: 'one',
        createdAt: null,
        architecture: 'arm64',
        operatingSystem: 'linux',
        osImage: null,
        kubeletVersion: null,
        containerRuntimeVersion: null,
        machineId: null,
        systemUuid: null,
        roles: [],
        addresses: [],
        unschedulable: false,
        conditions: {
          ready: 'true',
          diskPressure: 'false',
          memoryPressure: 'false',
          pidPressure: 'false',
          networkUnavailable: 'false',
        },
        capacity: resources,
        allocatable: resources,
        metrics: {
          state: 'unknown',
          cpuCores: null,
          memoryBytes: null,
          observedAt: null,
          windowSeconds: null,
        },
      },
    ],
    capabilities: {
      metrics,
      ingress: { state: 'unavailable', classes: [], errorCode: null },
      storage: { state: 'unavailable', classes: [], errorCode: null },
      traefik: {
        state: 'unavailable',
        namespace: 'kube-system',
        deployment: 'traefik',
        ready: null,
        desiredReplicas: null,
        readyReplicas: null,
        availableReplicas: null,
        errorCode: null,
      },
    },
    workloads: {
      state: 'unknown',
      items: [],
      collections: [],
      observedAt: new Date().toISOString(),
    },
    secretsEncryption: { state: 'unknown', evidence: 'not_available_via_standard_api' },
  };
  return { cluster, connection, observation };
}

function start(inspector = new ControlledInspector(), client = db) {
  const observer = new ClusterObserver(new TaskRepository(client), cipher, inspector);
  observers.push(observer);
  inspectors.push(inspector);
  observer.start();
  return { observer, inspector };
}

beforeAll(async () => {
  await execute(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../packages/database/node_modules/prisma/build/index.js', import.meta.url),
      ),
      'migrate',
      'deploy',
      '--schema',
      fileURLToPath(new URL('../../packages/database/prisma/schema.prisma', import.meta.url)),
    ],
    { env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, timeout: 25_000 },
  );
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  await db.controlPlaneState.upsert({
    where: { id: 'control-plane' },
    create: { id: 'control-plane' },
    update: {},
  });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'fixture-ca.key'),
      '-out',
      join(directory, 'fixture-ca.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=ozz-observer-fixture',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { stdio: 'ignore' },
  );
  ca = readFileSync(join(directory, 'fixture-ca.pem'), 'utf8');
}, 30_000);

afterEach(async () => {
  const closing = observers.splice(0).map((observer) => observer.stop());
  for (const inspector of inspectors.splice(0)) inspector.releaseAll();
  await Promise.allSettled(closing);
  for (const client of clients.splice(0)) await client.$disconnect();
  if (db) {
    await db.node.deleteMany();
    await db.cluster.deleteMany();
    await db.secretReference.deleteMany();
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: false, generation: 0 },
    });
  }
});

afterAll(async () => {
  await db?.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await cleanup.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ClusterObserver scheduling and publication against PostgreSQL', () => {
  it('retains one slot per target after a manual sync invalidates its lease, keeps another target moving, and awaits cancelled readers', async () => {
    const a = await target('slow-a');
    const { observer, inspector } = start();
    await until(() => inspector.forEndpoint(a.connection.endpoint).length === 1);
    const oldA = inspector.forEndpoint(a.connection.endpoint)[0]!;
    const manualObservedAt = new Date();
    const currentNodeUid = randomUUID();
    // Reproduce a successful explicit sync while the previous background read
    // remains in flight. Its connection revision is intentionally unchanged.
    await db.$transaction(async (tx) => {
      await tx.cluster.update({
        where: { id: a.cluster.id },
        data: {
          observationLeaseToken: null,
          observationLeaseExpiresAt: null,
          nextObservationAt: new Date(Date.now() - 10_000),
          lastObservedAt: manualObservedAt,
        },
      });
      await tx.node.create({
        data: {
          clusterId: a.cluster.id,
          uid: currentNodeUid,
          name: 'same-node',
          snapshotJson: { source: 'newer-explicit-sync' },
          lastObservedAt: manualObservedAt,
        },
      });
    });
    const b = await target('fast-b', new Date(Date.now() - 1000));
    await until(() => inspector.forEndpoint(b.connection.endpoint).length === 1);
    expect(inspector.forEndpoint(a.connection.endpoint)).toHaveLength(1);
    expect(oldA.options.expectedIdentity).toEqual(a.observation.identity);
    const firstB = inspector.forEndpoint(b.connection.endpoint)[0]!;
    expect(firstB.options.expectedIdentity).toEqual(b.observation.identity);
    firstB.resolve(b.observation);
    await until(async () => (await db.node.count({ where: { clusterId: b.cluster.id } })) === 1);
    oldA.resolve(a.observation);
    await until(() => inspector.forEndpoint(a.connection.endpoint).length === 2);
    expect(
      (await db.node.findMany({ where: { clusterId: a.cluster.id } })).map((node) => node.uid),
    ).toEqual([currentNodeUid]);
    expect(
      (await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } })).lastObservedAt,
    ).toEqual(manualObservedAt);

    await db.cluster.update({
      where: { id: b.cluster.id },
      data: { nextObservationAt: new Date(Date.now() - 1000) },
    });
    await until(() => inspector.forEndpoint(b.connection.endpoint).length === 2);
    inspector.holdAbortCompletion = true;
    const running = inspector.calls.filter((call) => !call.settled);
    expect(running).toHaveLength(2);
    let stopped = false;
    const stop = observer.stop().then(() => {
      stopped = true;
    });
    await until(() => running.every((call) => call.aborted));
    await delay(50);
    expect(stopped).toBe(false);
    for (const call of running) call.finishAbort();
    await stop;
    expect(inspector.calls.every((call) => call.settled)).toBe(true);
    expect(await db.cluster.count({ where: { observationLeaseToken: { not: null } } })).toBe(0);
  });

  it('does not start a newly claimed read after stop begins while the claim waits on the recovery fence', async () => {
    const a = await target('claim-stop');
    const observerUrl = new URL(databaseUrl);
    observerUrl.searchParams.set('connection_limit', '1');
    const observerDb = new PrismaClient({ datasourceUrl: observerUrl.toString() });
    clients.push(observerDb);
    await observerDb.$connect();
    const [backend] = await observerDb.$queryRaw<Array<{ pid: number }>>(
      Prisma.sql`SELECT pg_backend_pid() AS pid`,
    );
    const locked = deferred<void>();
    const release = deferred<void>();
    const gate = db.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ControlPlaneState" WHERE "id" = 'control-plane' FOR UPDATE`,
        );
        locked.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    try {
      await locked.promise;
      const { observer, inspector } = start(new ControlledInspector(), observerDb);
      await until(async () => {
        const [activity] = await db.$queryRaw<Array<{ wait: string | null }>>(
          Prisma.sql`SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = ${backend!.pid}`,
        );
        return activity?.wait === 'Lock';
      });
      let stopped = false;
      const stop = observer.stop().then(() => {
        stopped = true;
      });
      await delay(50);
      expect(stopped).toBe(false);
      release.resolve();
      await gate;
      await until(() => stopped || inspector.calls.length > 0);
      expect(inspector.calls).toHaveLength(0);
      await stop;
      const current = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
      expect(current.observationLeaseToken).toBeNull();
      expect(current.observationLeaseExpiresAt).toBeNull();
    } finally {
      release.resolve();
      await gate;
    }
  });

  it.each(['connection_revision', 'credential_reference', 'restore_generation'] as const)(
    'does not publish a late identity/Node snapshot after %s changes',
    async (change) => {
      const a = await target('late-a');
      const b = await target('held-b');
      const { observer, inspector } = start();
      await until(() => inspector.calls.length === 2);
      const previousTime = a.cluster.lastObservedAt;
      const currentNodeUid = randomUUID();
      await db.node.create({
        data: {
          clusterId: a.cluster.id,
          uid: currentNodeUid,
          name: 'same-node',
          snapshotJson: { source: 'current-snapshot' },
          lastObservedAt: new Date(),
        },
      });
      const originalCredential = await db.secretReference.findUniqueOrThrow({
        where: { id: a.cluster.credentialRefId! },
      });
      const replacement =
        change === 'credential_reference'
          ? await db.secretReference.create({
              data: {
                name: 'replacement-reference',
                kind: 'kubeconfig',
                ...cipher.encrypt('kubeconfig', cipher.decrypt(originalCredential)),
              },
            })
          : null;
      await db.$transaction(async (tx) => {
        await tx.cluster.update({
          where: { id: a.cluster.id },
          data: {
            nextObservationAt: new Date(Date.now() + 3600_000),
            ...(change === 'connection_revision'
              ? { connectionRevision: { increment: 1 }, caFingerprint: 'SHA256:new-confirmed-ca' }
              : {}),
            ...(replacement ? { credentialRefId: replacement.id } : {}),
          },
        });
        if (change === 'restore_generation')
          await tx.controlPlaneState.update({
            where: { id: 'control-plane' },
            data: { generation: { increment: 1 } },
          });
      });
      inspector.forEndpoint(a.connection.endpoint)[0]!.resolve(a.observation);
      const c = await target('slot-completion');
      // B remains pending. C starting proves A's complete observer promise has
      // released its slot, so these assertions cannot race its DB publication.
      await until(() => inspector.forEndpoint(c.connection.endpoint).length === 1);
      const current = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
      expect(current.lastObservedAt).toEqual(previousTime);
      expect(current.caFingerprint).toBe(
        change === 'connection_revision' ? 'SHA256:new-confirmed-ca' : a.cluster.caFingerprint,
      );
      expect(
        (await db.node.findMany({ where: { clusterId: a.cluster.id } })).map((node) => node.uid),
      ).toEqual([currentNodeUid]);
      expect(inspector.forEndpoint(b.connection.endpoint)[0]!.settled).toBe(false);
      await observer.stop();
    },
  );

  it('preserves the last successful snapshot on failure, lets another cluster publish, and recovers on a later successful read', async () => {
    const a = await target('unavailable-a');
    const b = await target('healthy-b');
    const previousNode = await db.node.create({
      data: {
        clusterId: a.cluster.id,
        uid: randomUUID(),
        name: 'same-node',
        snapshotJson: { source: 'last-known-good-node' },
        lastObservedAt: a.cluster.lastObservedAt!,
      },
    });
    await db.cluster.update({
      where: { id: a.cluster.id },
      data: { observationJson: { source: 'last-known-good-observation' } },
    });
    const { observer, inspector } = start();
    await until(() => inspector.calls.length === 2);
    const failedAt = Date.now();
    inspector
      .forEndpoint(a.connection.endpoint)[0]!
      .reject(new KubernetesAdapterError('KUBERNETES_API_UNAVAILABLE', true));
    inspector.forEndpoint(b.connection.endpoint)[0]!.resolve(b.observation);
    await until(async () => {
      const current = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
      return (
        current.observationFailures === 1 &&
        (await db.node.count({ where: { clusterId: b.cluster.id } })) === 1
      );
    });
    const failed = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
    expect(failed).toMatchObject({
      connectionStatus: 'unreachable',
      lastErrorCode: 'KUBERNETES_API_UNAVAILABLE',
      observationJson: { source: 'last-known-good-observation' },
      lastObservedAt: a.cluster.lastObservedAt,
      observationLeaseToken: null,
      observationLeaseExpiresAt: null,
    });
    expect(failed.nextObservationAt!.getTime()).toBeGreaterThan(failedAt + 1000);
    expect(failed.nextObservationAt!.getTime()).toBeLessThan(failedAt + 120_000);
    expect(await db.node.findUniqueOrThrow({ where: { id: previousNode.id } })).toMatchObject({
      present: true,
      snapshotJson: { source: 'last-known-good-node' },
      lastObservedAt: a.cluster.lastObservedAt,
    });

    // Advance only this fixture's due date; do not wait out product backoff.
    await db.cluster.update({
      where: { id: a.cluster.id },
      data: { nextObservationAt: new Date(Date.now() - 1000) },
    });
    await until(() => inspector.forEndpoint(a.connection.endpoint).length === 2);
    const recovered = { ...a.observation, observedAt: new Date().toISOString() };
    inspector.forEndpoint(a.connection.endpoint)[1]!.resolve(recovered);
    await until(async () => {
      const current = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
      return current.lastObservedAt?.toISOString() === recovered.observedAt;
    });
    expect(await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } })).toMatchObject({
      connectionStatus: 'connected',
      observationFailures: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    expect(await db.node.findUniqueOrThrow({ where: { id: previousNode.id } })).toMatchObject({
      present: false,
    });
    expect(
      await db.node.findMany({ where: { clusterId: a.cluster.id, present: true } }),
    ).toHaveLength(1);
    await observer.stop();
  });

  it('rejects an in-flight result when its credential expires, then observes with the replacement reference', async () => {
    const a = await target('expired-credential');
    const { observer, inspector } = start();
    await until(() => inspector.calls.length === 1);
    await db.secretReference.update({
      where: { id: a.cluster.credentialRefId! },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    inspector.calls[0]!.resolve(a.observation);
    await until(async () => {
      const current = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
      return current.lastErrorCode === 'CREDENTIAL_EXPIRED';
    });
    expect(await db.node.count({ where: { clusterId: a.cluster.id } })).toBe(0);
    const failed = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
    expect(failed).toMatchObject({
      connectionStatus: 'unknown',
      lastObservedAt: a.cluster.lastObservedAt,
      observationJson: null,
    });
    const expired = await db.secretReference.findUniqueOrThrow({
      where: { id: a.cluster.credentialRefId! },
    });
    const replacement = await db.secretReference.create({
      data: {
        name: 'renewed-credential',
        kind: 'kubeconfig',
        ...cipher.encrypt('kubeconfig', cipher.decrypt(expired)),
      },
    });
    await db.cluster.update({
      where: { id: a.cluster.id },
      data: {
        credentialRefId: replacement.id,
        connectionRevision: { increment: 1 },
        nextObservationAt: new Date(Date.now() - 1000),
      },
    });
    await until(() => inspector.calls.length === 2);
    inspector.calls[1]!.resolve(a.observation);
    await until(async () => (await db.node.count({ where: { clusterId: a.cluster.id } })) === 1);
    expect(await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } })).toMatchObject({
      credentialRefId: replacement.id,
      connectionStatus: 'connected',
      lastErrorCode: null,
      observationFailures: 0,
    });
    await observer.stop();
  });

  it('cancels reads without publishing during recovery lock and resumes only under the new generation after unlock', async () => {
    const a = await target('recovery-a');
    const controlled = new ControlledInspector();
    controlled.holdAbortCompletion = true;
    const { observer, inspector } = start(controlled);
    await until(() => inspector.calls.length === 1);
    const before = await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } });
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true, generation: { increment: 1 } },
    });
    const b = await target('recovery-b');
    await until(() => inspector.calls[0]!.aborted);
    // A reader may still return data after it has received cancellation.
    inspector.calls[0]!.resolve(a.observation);
    await delay(1100);
    expect(inspector.calls).toHaveLength(1);
    await observer.stop();
    expect(await db.cluster.findUniqueOrThrow({ where: { id: a.cluster.id } })).toMatchObject({
      lastObservedAt: before.lastObservedAt,
      lastErrorCode: before.lastErrorCode,
      observationLeaseToken: before.observationLeaseToken,
      observationLeaseExpiresAt: before.observationLeaseExpiresAt,
    });
    expect(await db.node.count()).toBe(0);
    expect(
      (await db.cluster.findUniqueOrThrow({ where: { id: b.cluster.id } })).observationLeaseToken,
    ).toBeNull();

    // Represent bounded lease expiry in this isolated scheduling fixture.
    await db.cluster.update({
      where: { id: a.cluster.id },
      data: { observationLeaseExpiresAt: new Date(Date.now() - 1000) },
    });
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: false },
    });
    const resumed = start();
    await until(() => resumed.inspector.calls.length === 2);
    resumed.inspector.forEndpoint(a.connection.endpoint)[0]!.resolve(a.observation);
    resumed.inspector.forEndpoint(b.connection.endpoint)[0]!.resolve(b.observation);
    await until(async () => (await db.node.count()) === 2);
    await resumed.observer.stop();
    expect(await db.cluster.count({ where: { connectionStatus: 'connected' } })).toBe(2);
    expect(await db.cluster.count({ where: { observationLeaseToken: { not: null } } })).toBe(0);
    expect(
      await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } }),
    ).toMatchObject({ restoreLocked: false, generation: 1 });
  });
});
