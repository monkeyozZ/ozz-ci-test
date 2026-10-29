import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '../../packages/database/dist/index.js';
import { createApp } from '../../apps/api/dist/app.js';
import { createTestSession } from './helpers.js';
import {
  KubernetesAdapterError,
  parseKubeconfig,
  type KubernetesConnectionInspector,
} from '../../packages/infrastructure/dist/kubernetes.js';
import {
  StorageAdapterError,
  type KubernetesStorageManager,
  type StorageCapabilities,
  type StoragePodMount,
  type StorageResourceReceipt,
  type StorageVolumeObservation,
  type StorageVolumePlan,
  type StorageWriteHooks,
} from '../../packages/infrastructure/dist/storage.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import { InfrastructureCommands } from '../../packages/control-plane/src/infrastructure/commands.js';
import { ClusterObserver } from '../../packages/control-plane/src/infrastructure/observer.js';
import { ServiceCommands } from '../../packages/control-plane/src/services/commands.js';
import { validateServiceConfiguration } from '../../packages/control-plane/src/services/validation.js';
import { establishDatabaseFence } from '../../packages/control-plane/src/databases/protection.js';
import { TEMPLATE_VERSION } from '../../packages/control-plane/src/templates/catalog.js';
import { StorageCommands } from '../../packages/control-plane/src/storage/commands.js';
import { StorageExecutor } from '../../packages/control-plane/src/storage/executor.js';
import {
  StorageObserver,
  type StorageObserverOptions,
} from '../../packages/control-plane/src/storage/observer.js';
import {
  admitVolumeMutation,
  captureVolumeReferences,
  lockVolume,
  reserveVolume,
  volumePlan,
} from '../../packages/control-plane/src/storage/persistence.js';
import {
  saveStorageReceipt,
  saveVolumeObservation,
} from '../../packages/control-plane/src/storage/ledger.js';
import {
  currentTarget,
  json,
  lockService,
} from '../../packages/control-plane/src/services/persistence.js';
import type { ServiceTarget } from '../../packages/control-plane/src/services/contracts.js';
import type {
  CreateManualDataRecordInput,
  ManualDataIdentity,
  VolumeSnapshotReference,
  VolumeView,
} from '../../packages/control-plane/src/storage/contracts.js';
import {
  TaskRepository,
  type OperationActor,
} from '../../packages/control-plane/src/tasks/repository.js';
import {
  OperationRequestError,
  TaskExecutionError,
} from '../../packages/control-plane/src/tasks/contracts.js';

// Real admission, SQL, HTTP DTO validation and task/observation fencing in an isolated schema.
// Kubernetes effects are controlled fixtures; protocol and real K3s acceptance are separate.
const execute = promisify(execFile);
const schema = `s5storage_${randomUUID().replaceAll('-', '')}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
if (!originalDatabaseUrl) throw new Error('S5 Storage integration requires PostgreSQL.');
const url = new URL(originalDatabaseUrl);
url.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-storage-integration-'));
const db = new PrismaClient({ datasourceUrl: url.toString() });
const cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
const repository = new TaskRepository(db, { leaseMs: 30_000 });
const commands = new StorageCommands(repository);
const serviceCommands = new ServiceCommands(repository, cipher);
const infrastructureCommands = new InfrastructureCommands(repository, cipher);
const manager = {
  inspect: vi.fn<KubernetesStorageManager['inspect']>(),
  create: vi.fn<KubernetesStorageManager['create']>(),
  observe: vi.fn<KubernetesStorageManager['observe']>(),
  destroy: vi.fn<KubernetesStorageManager['destroy']>(),
  prepareBindings: vi.fn<KubernetesStorageManager['prepareBindings']>(),
};
const runtime = new StorageExecutor(repository, cipher, manager, {
  beforeDataWrite: establishDatabaseFence,
});
const observers = new Set<StorageObserver | ClusterObserver>();
const namespaceResources = new Map<string, { uid: string; nonce: string }>();
const claims = new Map<
  string,
  { uid: string; nonce: string; creationRevision: number; mounts: StoragePodMount[] }
>();
const effects: string[] = [];
let lostCreateReceipt = false;
let lateHooks: StorageWriteHooks | undefined;
let beforePvcWrite: (() => Promise<void>) | undefined;
let certificate: string;
let actor: OperationActor;
let app: Awaited<ReturnType<typeof createApp>>;
let session: Awaited<ReturnType<typeof createTestSession>>;
let context: Awaited<ReturnType<typeof makeContext>>;
let capability: StorageCapabilities;
let sequence = 0;

const unique = () => `fixture-${++sequence}`;
function storageCapabilities(): StorageCapabilities {
  return {
    observedAt: new Date().toISOString(),
    truncated: false,
    permissions: 'ready',
    provisioner: { state: 'ready', version: 'v0.0.32' },
    issues: [],
    storageClasses: [
      {
        name: 'local-path',
        uid: randomUUID(),
        provisioner: 'rancher.io/local-path',
        bindingMode: 'WaitForFirstConsumer',
        reclaimPolicy: 'Delete',
        default: true,
        supported: true,
        code: null,
        message: 'Controlled local-path fixture.',
        hardQuotaSupport: 'unsupported',
        allowVolumeExpansion: false,
      },
    ],
  };
}
async function makeContext() {
  const name = unique();
  const endpoint = 'https://127.0.0.1:65534';
  const kubeconfig = JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'fixture',
        cluster: {
          server: endpoint,
          'certificate-authority-data': Buffer.from(certificate).toString('base64'),
        },
      },
    ],
    users: [{ name: 'fixture', user: { token: 'synthetic-storage-fixture-token' } }],
    contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
    'current-context': 'fixture',
  });
  const connection = parseKubeconfig(kubeconfig);
  const credential = await db.secretReference.create({
    data: { name, kind: 'kubeconfig', ...cipher.encrypt('kubeconfig', { kubeconfig }) },
  });
  const cluster = await db.cluster.create({
    data: {
      name,
      slug: name,
      apiEndpoint: endpoint,
      kubeSystemUid: randomUUID(),
      caFingerprint: connection.caFingerprint,
      credentialRefId: credential.id,
      connectionStatus: 'connected',
      storageCapabilitiesJson: json(capability),
      storageCapabilitiesAt: new Date(),
      storageNextObservationAt: new Date(Date.now() + 3600_000),
    },
  });
  const project = await db.project.create({ data: { name, slug: name, clusterId: cluster.id } });
  const environment = await db.environment.create({
    data: { name: 'Production', slug: 'production', projectId: project.id },
  });
  return { cluster, project, environment, credential };
}
function volumeInput(ctx = context) {
  const name = unique();
  return {
    environmentId: ctx.environment.id,
    name,
    slug: name,
    storageClassName: 'local-path',
    requestedBytes: '1073741824',
  };
}
async function newService(ctx = context, replicas = 1, kind = 'application') {
  const name = unique();
  return db.service.create({
    data: {
      name,
      slug: name,
      environmentId: ctx.environment.id,
      kind,
      configJson: { image: 'fixture/app:1', replicas },
    },
  });
}
function claimReceipt(
  plan: StorageVolumePlan,
  action: StorageResourceReceipt['action'],
): StorageResourceReceipt {
  const actual = claims.get(plan.target.volumeId);
  return {
    action,
    name: plan.claim.name,
    namespace: plan.target.namespace,
    creationNonce: plan.claim.creationNonce,
    uid: actual?.uid ?? plan.claim.uid,
    resourceVersion: '10',
    mutationRevision: plan.mutationRevision,
    storageClassUid: plan.storageClassUid ?? capability.storageClasses[0]!.uid,
    specFingerprint: 'a'.repeat(64),
    binding: null,
    observedAt: new Date().toISOString(),
  };
}
function observation(plan: StorageVolumePlan, state?: 'destroyed'): StorageVolumeObservation {
  const actual = claims.get(plan.target.volumeId);
  if (
    actual &&
    (actual.nonce !== plan.claim.creationNonce ||
      (plan.claim.uid && plan.claim.uid !== actual.uid) ||
      (!plan.claim.uid && !plan.claim.creationAttempted))
  )
    throw new StorageAdapterError('STORAGE_OWNERSHIP_MISMATCH', 'Controlled conflicting PVC.');
  if (
    actual &&
    (actual.creationRevision > plan.mutationRevision ||
      (!plan.claim.specFingerprint && actual.creationRevision < plan.claim.mutationRevision))
  )
    throw new StorageAdapterError(
      'STORAGE_CONFIGURATION_DRIFT',
      'Controlled original creation revision mismatch.',
    );
  return {
    observedAt: new Date().toISOString(),
    state: state ?? (actual ? 'pending' : 'missing'),
    code: null,
    message: actual ? 'Waiting for first consumer.' : 'Controlled absence.',
    requestedBytes: plan.requestedBytes,
    hardQuotaSupport: 'unsupported',
    pvc: {
      name: plan.claim.name,
      uid: actual?.uid ?? plan.claim.uid,
      resourceVersion: actual ? '10' : null,
      phase: actual ? 'Pending' : 'Missing',
      deleting: false,
    },
    pv: null,
    storageClass: capability.storageClasses[0]!,
    locality: actual ? 'waiting_for_consumer' : 'unknown',
    nodes: [],
    usage: { usedBytes: null, nodeAvailableBytes: null, observedAt: null },
    mounts: actual?.mounts ?? [],
    mountsTruncated: false,
    destructionBlockers: actual?.mounts.length
      ? [{ code: 'STORAGE_VOLUME_MOUNTED', message: 'Controlled active Pod.' }]
      : [],
    ...(actual ? { verifiedReceipt: claimReceipt(plan, 'verified') } : {}),
  };
}
async function createClaim(
  _connection: unknown,
  source: StorageVolumePlan,
  hooks: StorageWriteHooks,
) {
  const plan = structuredClone(source);
  lateHooks = hooks;
  await hooks.checkpoint();
  let namespace = namespaceResources.get(plan.target.namespace);
  if (!namespace) {
    await hooks.namespace.beforeWrite({
      action: 'create',
      kind: 'Namespace',
      name: plan.target.namespace,
      namespace: null,
      creationNonce: plan.namespace.creationNonce,
      expectedUid: null,
      expectedResourceVersion: null,
      mutationRevision: 0,
    });
    namespace = { uid: randomUUID(), nonce: plan.namespace.creationNonce };
    namespaceResources.set(plan.target.namespace, namespace);
    effects.push('namespace:create');
  }
  expect(namespace.nonce).toBe(plan.namespace.creationNonce);
  await hooks.namespace.onReceipt({
    action: plan.namespace.uid ? 'verified' : 'created',
    kind: 'Namespace',
    name: plan.target.namespace,
    namespace: null,
    creationNonce: namespace.nonce,
    uid: namespace.uid,
    resourceVersion: '5',
    generation: null,
    mutationRevision: 0,
    specFingerprint: null,
    observedAt: new Date().toISOString(),
  });
  let actual = claims.get(plan.target.volumeId);
  if (!actual && plan.claim.uid)
    throw new StorageAdapterError('STORAGE_CLAIM_MISSING', 'Known PVC is absent.');
  if (!actual) {
    await beforePvcWrite?.();
    await hooks.beforeWrite({
      action: 'create',
      name: plan.claim.name,
      namespace: plan.target.namespace,
      creationNonce: plan.claim.creationNonce,
      expectedUid: null,
      expectedResourceVersion: null,
      mutationRevision: plan.mutationRevision,
      storageClassUid: capability.storageClasses[0]!.uid,
      binding: null,
    });
    actual = {
      uid: randomUUID(),
      nonce: plan.claim.creationNonce,
      creationRevision: plan.mutationRevision,
      mounts: [],
    };
    claims.set(plan.target.volumeId, actual);
    effects.push('pvc:create');
    plan.claim.creationAttempted = true;
    if (lostCreateReceipt) {
      lostCreateReceipt = false;
      throw new StorageAdapterError('KUBERNETES_TIMEOUT', 'Controlled lost create response.', true);
    }
  }
  const read = observation(plan);
  const receipt = claimReceipt(plan, source.claim.uid ? 'verified' : 'created');
  await hooks.onReceipt(receipt);
  return { completedAt: new Date().toISOString(), resources: [receipt], observation: read };
}
async function runOperation(id: string, executor = runtime) {
  await db.operation.update({ where: { id }, data: { maxAttempts: 1 } });
  const lease = await repository.claim(id, 'storage-integration');
  if (!lease) throw new Error('Expected a claimable storage task.');
  try {
    const result = await executor.execute(lease, new AbortController().signal);
    expect(await repository.complete(lease, result)).toBe(true);
    return null;
  } catch (error) {
    if (!(error instanceof TaskExecutionError)) throw error;
    expect(
      await repository.fail(lease, error.code, error.message, error.retryable, (tx) =>
        executor.failed(lease, tx, error.code, error.message),
      ),
    ).toBe(true);
    return error;
  }
}
async function createdVolume(ctx = context) {
  const created = await commands.create(volumeInput(ctx), actor, randomUUID());
  expect(await runOperation(created.operation.id)).toBeNull();
  return commands.get(created.volumeId);
}
async function mount(serviceId: string, volume: VolumeView, readOnly = false) {
  const service = await db.service.findUniqueOrThrow({ where: { id: serviceId } });
  return commands.saveMount(serviceId, {
    revision: service.revision,
    volumeId: volume.id,
    volumeRevision: volume.revision,
    mountPath: '/data',
    readOnly,
  });
}
async function publication(serviceId: string) {
  const task = await repository.enqueueDeployment(
    actor,
    randomUUID(),
    { request: { serviceId, fixture: unique() } },
    async (tx) => {
      const service = await lockService(tx, serviceId);
      const refs = await captureVolumeReferences(tx, service);
      const target = await currentTarget(tx, service);
      const updated = await tx.service.update({
        where: { id: serviceId },
        data: { mutationRevision: { increment: 1 } },
      });
      return {
        serviceId,
        input: { serviceId, mutationRevision: updated.mutationRevision },
        mutationRevision: updated.mutationRevision,
        configRevision: updated.configRevision,
        targetJson: json(target),
        snapshotJson: json({
          version: 2,
          serviceId,
          serviceName: service.name,
          serviceSlug: service.slug,
          configRevision: service.configRevision,
          configuration: validateServiceConfiguration(service.configJson),
          deployAndStart: false,
          allowConfigurationRepair: false,
          controller: { kind: 'Deployment', strategy: 'Recreate' },
          volumes: refs,
          database: null,
          databaseBindings: [],
          template: null,
        }),
        onAccepted: (tx, ref) => admitVolumeMutation(tx, refs, ref),
      };
    },
  );
  const stored = await db.deployment.findUniqueOrThrow({ where: { id: task.id } });
  const snapshot = stored.snapshotJson as unknown as {
    volumes: VolumeSnapshotReference[];
  };
  const lease = await repository.claimDeployment(task.id, 'storage-publication-fixture');
  if (!lease) throw new Error('Expected claimable fixture publication.');
  return { task, lease, target: stored.targetJson as unknown as ServiceTarget, ...snapshot };
}
async function publish(serviceId: string) {
  const started = await publication(serviceId);
  const bindings = await runtime.prepareForWorkload(
    started.lease,
    started.target,
    started.volumes,
    new AbortController().signal,
  );
  await runtime.afterWorkload(
    started.lease,
    started.target,
    started.volumes,
    {},
    new AbortController().signal,
  );
  expect(
    await repository.complete(started.lease, {
      result: { fixture: true },
      commit: async (tx) => {
        await tx.deployment.update({
          where: { id: started.task.id },
          data: { appliedAt: new Date() },
        });
        await tx.service.update({
          where: { id: serviceId },
          data: { publishedDeploymentId: started.task.id },
        });
      },
    }),
  ).toBe(true);
  return { ...started, bindings };
}
function pod(volume: VolumeView, serviceId: string | null = null): StoragePodMount {
  return {
    podName: unique(),
    podUid: randomUUID(),
    namespace: volume.namespace,
    nodeName: 'same-node-name',
    phase: 'Running',
    deleting: false,
    readOnly: false,
    paths: ['/data'],
    serviceId,
    controller: null,
  };
}
async function ownedPod(
  volume: VolumeView,
  serviceId: string,
  kind: 'Deployment' | 'StatefulSet',
): Promise<StoragePodMount> {
  const target = await db.$transaction(async (tx) =>
    currentTarget(tx, await lockService(tx, serviceId)),
  );
  const resource = await db.managedResource.create({
    data: {
      clusterId: target.clusterId,
      environmentId: target.environmentId,
      serviceId,
      kind,
      namespace: target.namespace,
      name: `ozz-s-${serviceId.replaceAll('-', '')}`,
      targetJson: json(target),
      creationAttempted: true,
      uid: randomUUID(),
    },
  });
  return {
    ...pod(volume, serviceId),
    readOnly: true,
    controller: { kind, name: resource.name, uid: resource.uid! },
  };
}
async function blockedRead(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted();
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  }
  throw new Error('Expected storage observation did not settle.');
}
function startObserver(options?: StorageObserverOptions) {
  const observer = new StorageObserver(repository, cipher, manager, options);
  observers.add(observer);
  observer.start();
  return observer;
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
    { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 25_000 },
  );
  await execute(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '2',
      '-subj',
      '/CN=ozz-storage-fixture',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { cwd: directory, timeout: 10_000 },
  );
  chmodSync(join(directory, 'ca.key'), 0o600);
  certificate = readFileSync(join(directory, 'ca.pem'), 'utf8');
  await db.$connect();
  const admin = await db.admin.create({
    data: { username: 'storage-fixture', passwordHash: 'fixture-login-disabled' },
  });
  actor = { id: admin.id };
  process.env.DATABASE_URL = url.toString();
  app = await createApp({ silent: true });
  session = await createTestSession(app, db);
});
beforeEach(async () => {
  for (const method of Object.values(manager)) method.mockReset();
  effects.length = 0;
  claims.clear();
  namespaceResources.clear();
  lostCreateReceipt = false;
  lateHooks = undefined;
  beforePvcWrite = undefined;
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "${schema}"."Cluster", "${schema}"."SecretReference", "${schema}"."AuditEvent" CASCADE`,
  );
  capability = storageCapabilities();
  context = await makeContext();
  manager.inspect.mockImplementation(async () => ({
    ...structuredClone(capability),
    observedAt: new Date().toISOString(),
  }));
  manager.create.mockImplementation(createClaim);
  manager.observe.mockImplementation(async (_connection, plan) => observation(plan));
  manager.prepareBindings.mockImplementation(async (_connection, _target, entries) =>
    entries.map(({ plan, path, readOnly }) => ({
      volumeId: plan.target.volumeId,
      namespace: plan.target.namespace,
      claimName: plan.claim.name,
      claimUid: claims.get(plan.target.volumeId)!.uid,
      path,
      readOnly,
      storageClassUid: capability.storageClasses[0]!.uid,
      binding: null,
      observedAt: new Date().toISOString(),
    })),
  );
  manager.destroy.mockImplementation(async (_connection, plan, hooks) => {
    await hooks.checkpoint();
    const actual = claims.get(plan.target.volumeId);
    if (actual?.mounts.length)
      throw new StorageAdapterError('STORAGE_VOLUME_MOUNTED', 'Fixture Pod still holds claim.');
    if (actual) {
      await hooks.beforeWrite({
        action: 'delete',
        name: plan.claim.name,
        namespace: plan.target.namespace,
        creationNonce: plan.claim.creationNonce,
        expectedUid: actual.uid,
        expectedResourceVersion: '10',
        mutationRevision: plan.mutationRevision,
        storageClassUid: capability.storageClasses[0]!.uid,
        binding: null,
      });
      claims.delete(plan.target.volumeId);
      effects.push('pvc:delete');
    }
    const receipt = claimReceipt(plan, 'deleted');
    await hooks.onReceipt(receipt);
    return {
      completedAt: new Date().toISOString(),
      resources: [receipt],
      observation: observation(plan, 'destroyed'),
    };
  });
});
afterEach(async () => {
  for (const observer of observers) await observer.stop();
  observers.clear();
  await db.controlPlaneState.update({
    where: { id: 'control-plane' },
    data: { restoreLocked: false },
  });
});
afterAll(async () => {
  try {
    await app?.close();
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await db.$disconnect();
    process.env.DATABASE_URL = originalDatabaseUrl;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('S5 storage admission and durable execution', () => {
  it('creates one durable volume and one operation for concurrent identical requests, completing WFFC without a consumer', async () => {
    const input = volumeInput(),
      key = randomUUID();
    const [a, b] = await Promise.all([
      commands.create(input, actor, key),
      commands.create(input, actor, key),
    ]);
    expect(a.volumeId).toBe(b.volumeId);
    expect(a.operation.id).toBe(b.operation.id);
    expect(await db.volume.count()).toBe(1);
    expect(await db.volumeMutation.count()).toBe(1);
    expect(manager.create).not.toHaveBeenCalled();
    await expect(
      commands.create({ ...input, requestedBytes: '2147483648' }, actor, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await runOperation(a.operation.id)).toBeNull();
    const view = await commands.get(a.volumeId);
    expect(view).toMatchObject({
      requestedBytes: '1073741824',
      hardQuotaSupport: 'unsupported',
      locality: 'waiting_for_consumer',
      pvc: { phase: 'Pending' },
      activeTask: null,
      nodes: [],
      usage: { usedBytes: null, nodeAvailableBytes: null },
    });
    expect(view.pvc.uid).toBe(claims.get(a.volumeId)!.uid);
    expect(await db.volumeMutation.count()).toBe(0);
  });
  it('rejects unsupported, incomplete or stale capabilities before creating metadata or remote effects', async () => {
    await db.cluster.update({
      where: { id: context.cluster.id },
      data: { storageErrorCode: 'KUBERNETES_UNREACHABLE' },
    });
    await expect(commands.create(volumeInput(), actor, randomUUID())).rejects.toMatchObject({
      code: 'STORAGE_CAPABILITIES_REQUIRED',
    });
    expect(await db.volume.count()).toBe(0);
    expect(await db.operation.count()).toBe(0);
    expect(effects).toEqual([]);
  });
  it('keeps a bound volume usable after its PV and node identity round trips through PostgreSQL JSONB', async () => {
    const volume = await createdVolume();
    const plan = await db.$transaction(async (tx) =>
      volumePlan(tx, await lockVolume(tx, volume.id), context.cluster.caFingerprint!),
    );
    const binding = {
      pvName: `pvc-${volume.pvc.uid}`,
      pvUid: randomUUID(),
      nodes: [
        { name: 'node-a', uid: randomUUID() },
        { name: 'node-b', uid: randomUUID() },
      ],
    };
    const receipt = { ...claimReceipt(plan, 'verified'), binding };
    await db.$transaction((tx) =>
      saveStorageReceipt(tx, volume.id, receipt, plan.claim.ledgerVersion, {}),
    );
    const next = await db.$transaction(async (tx) =>
      volumePlan(tx, await lockVolume(tx, volume.id), context.cluster.caFingerprint!),
    );
    expect(next.knownBinding).toEqual(binding);
    // Both the DB object key order and the read-side node order can differ.
    const read = observation(next);
    Object.assign(read, {
      state: 'ready',
      locality: 'verified',
      pv: {
        name: binding.pvName,
        uid: binding.pvUid,
        claimUid: volume.pvc.uid,
        capacityBytes: 1073741824,
        reclaimPolicy: 'Delete',
        storageClassName: 'local-path',
        provisioner: 'rancher.io/local-path',
        nodeAffinity: {},
      },
      nodes: binding.nodes.toReversed().map(({ name, uid }) => ({ uid, name, ready: true })),
    });
    await expect(
      db.$transaction(async (tx) =>
        saveVolumeObservation(tx, await lockVolume(tx, volume.id), read),
      ),
    ).resolves.toBeUndefined();
    await expect(
      db.$transaction((tx) =>
        saveStorageReceipt(tx, volume.id, receipt, next.claim.ledgerVersion, {}),
      ),
    ).resolves.toBe(next.claim.ledgerVersion + 1);
    expect((await commands.get(volume.id)).observation).toMatchObject({
      state: 'ready',
      stale: false,
    });
  });
  it('still rejects a changed PV or node identity after a stored binding round trip', async () => {
    const volume = await createdVolume();
    const plan = await db.$transaction(async (tx) =>
      volumePlan(tx, await lockVolume(tx, volume.id), context.cluster.caFingerprint!),
    );
    const binding = {
      pvName: `pvc-${volume.pvc.uid}`,
      pvUid: randomUUID(),
      nodes: [{ name: 'original-node', uid: randomUUID() }],
    };
    const receipt = { ...claimReceipt(plan, 'verified'), binding };
    await db.$transaction((tx) =>
      saveStorageReceipt(tx, volume.id, receipt, plan.claim.ledgerVersion, {}),
    );
    for (const replacement of [
      { ...binding, pvName: 'another-pv' },
      { ...binding, pvUid: randomUUID() },
      { ...binding, nodes: [{ ...binding.nodes[0]!, name: 'another-node' }] },
      { ...binding, nodes: [{ ...binding.nodes[0]!, uid: randomUUID() }] },
      { ...binding, nodes: [] },
    ]) {
      await expect(
        db.$transaction((tx) =>
          saveStorageReceipt(
            tx,
            volume.id,
            { ...receipt, binding: replacement },
            plan.claim.ledgerVersion + 1,
            {},
          ),
        ),
      ).rejects.toMatchObject({ code: 'VOLUME_DATA_IDENTITY_CHANGED' });
    }
    const retained = await db.volume.findUniqueOrThrow({ where: { id: volume.id } });
    expect(retained.pvcUid).toBe(volume.pvc.uid);
    expect(retained.receiptJson).toMatchObject({ binding });
  });
  it('recovers a lost PVC create response using the original nonce and creation revision without another PVC create', async () => {
    lostCreateReceipt = true;
    const created = await commands.create(volumeInput(), actor, randomUUID());
    expect(await runOperation(created.operation.id)).toMatchObject({ code: 'KUBERNETES_TIMEOUT' });
    const pending = await db.volume.findUniqueOrThrow({ where: { id: created.volumeId } });
    expect(pending).toMatchObject({
      creationAttempted: true,
      pvcUid: null,
      receiptJson: { creationMutationRevision: 1 },
    });
    const nonce = pending.creationNonce,
      originalUid = claims.get(created.volumeId)!.uid;
    const retry = await commands.retry(created.operation.id, actor, randomUUID());
    expect(await runOperation(retry.id)).toBeNull();
    const recovered = await db.volume.findUniqueOrThrow({ where: { id: created.volumeId } });
    expect(recovered).toMatchObject({
      pvcUid: originalUid,
      creationNonce: nonce,
      mutationRevision: 2,
      receiptJson: { creationMutationRevision: 1 },
    });
    expect(effects.filter((effect) => effect === 'pvc:create')).toHaveLength(1);
  });
  it('shares the environment Namespace nonce across independent volumes and rejects a late receipt after its lease ends', async () => {
    const first = await createdVolume();
    const firstHooks = lateHooks!;
    const second = await createdVolume();
    expect(first.namespace).toBe(second.namespace);
    expect(effects.filter((effect) => effect === 'namespace:create')).toHaveLength(1);
    expect(await db.managedResource.count({ where: { kind: 'Namespace' } })).toBe(1);
    const row = await db.volume.findUniqueOrThrow({ where: { id: first.id } });
    await expect(
      firstHooks.onReceipt({
        action: 'verified',
        name: row.pvcName,
        namespace: row.namespace,
        creationNonce: row.creationNonce,
        uid: randomUUID(),
        resourceVersion: '99',
        mutationRevision: row.mutationRevision,
        storageClassUid: row.storageClassUid,
        specFingerprint: row.specFingerprint,
        binding: null,
        observedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'VOLUME_TASK_FENCE_LOST' });
    expect((await commands.get(first.id)).pvc.uid).toBe(first.pvc.uid);
  });
  it('rechecks management credentials at the write fence and stops before PVC creation after a mid-task change', async () => {
    const created = await commands.create(volumeInput(), actor, randomUUID());
    beforePvcWrite = async () => {
      await db.cluster.update({
        where: { id: context.cluster.id },
        data: { connectionRevision: { increment: 1 } },
      });
    };
    expect(await runOperation(created.operation.id)).toMatchObject({
      code: 'VOLUME_CREDENTIAL_CHANGED',
    });
    expect(effects.filter((effect) => effect === 'pvc:create')).toHaveLength(0);
    expect(
      (await db.volume.findUniqueOrThrow({ where: { id: created.volumeId } })).creationAttempted,
    ).toBe(false);
  });
  it.each([false, true])(
    'rejects a superseded recovery generation at the PVC write fence before creating any claim (restoreLocked=%s)',
    async (restoreLocked) => {
      const created = await commands.create(volumeInput(), actor, randomUUID());
      const lease = await repository.claim(created.operation.id, 'storage-generation-fixture');
      expect(lease).not.toBeNull();
      beforePvcWrite = async () => {
        await db.controlPlaneState.update({
          where: { id: 'control-plane' },
          data: { restoreLocked, generation: { increment: 1 } },
        });
      };
      await expect(runtime.execute(lease!, new AbortController().signal)).rejects.toMatchObject({
        code: 'VOLUME_TASK_FENCE_LOST',
      });
      expect(effects).not.toContain('pvc:create');
      expect(await db.volume.findUniqueOrThrow({ where: { id: created.volumeId } })).toMatchObject({
        creationAttempted: false,
        pvcUid: null,
      });
    },
  );
  it('preserves the recorded PVC identity when an identically named claim is replaced before synchronization', async () => {
    const volume = await createdVolume();
    claims.get(volume.id)!.uid = randomUUID();
    const sync = await commands.action(
      volume.id,
      'volume_sync',
      { revision: volume.revision },
      actor,
      randomUUID(),
    );
    expect(await runOperation(sync.id)).toMatchObject({ code: 'STORAGE_OWNERSHIP_MISMATCH' });
    expect((await commands.get(volume.id)).pvc.uid).toBe(volume.pvc.uid);
    expect(effects.filter((effect) => effect === 'pvc:create')).toHaveLength(1);
    expect(effects).not.toContain('pvc:delete');
  });
  it('retains writer occupancy after a published mount is removed from the draft, then releases it only after confirmed unmount', async () => {
    const volume = await createdVolume(),
      service = await newService(),
      other = await newService();
    const mounted = await mount(service.id, volume);
    await publish(service.id);
    const current = await commands.mounts(service.id);
    await commands.removeMount(service.id, mounted.data[0]!.id, {
      revision: current.serviceRevision,
    });
    await expect(mount(other.id, volume)).rejects.toMatchObject({ code: 'VOLUME_WRITER_CONFLICT' });
    expect((await commands.get(volume.id)).mounts.published).toHaveLength(1);
    claims.get(volume.id)!.mounts = [pod(volume, service.id)];
    const next = await publication(service.id);
    await expect(
      runtime.afterWorkload(
        next.lease,
        next.target,
        next.volumes,
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'VOLUME_DETACH_UNCONFIRMED' });
    expect(
      (await db.volumeMount.findUniqueOrThrow({ where: { id: mounted.data[0]!.id } })).detachedAt,
    ).toBeNull();
    claims.get(volume.id)!.mounts = [];
    await runtime.afterWorkload(
      next.lease,
      next.target,
      next.volumes,
      {},
      new AbortController().signal,
    );
    await repository.complete(next.lease, {
      result: { fixture: true },
      commit: async (tx) => {
        await tx.service.update({
          where: { id: service.id },
          data: { publishedDeploymentId: next.task.id },
        });
      },
    });
    await expect(mount(other.id, await commands.get(volume.id))).resolves.toHaveProperty('data');
  });
  it.each(['publication', 'service_delete'] as const)(
    'allows %s to detach its own reader while verified readers remain, rejecting labels or a substituted controller UID',
    async (kind) => {
      const volume = await createdVolume();
      const services = await Promise.all([newService(), newService(), newService()]);
      const service = services[0]!;
      const mounted = await mount(service.id, volume, true);
      const published = await publish(service.id);
      for (const other of services.slice(1)) {
        await mount(other.id, await commands.get(volume.id), true);
        await publish(other.id);
      }
      const readers = [
        await ownedPod(volume, services[1]!.id, 'Deployment'),
        await ownedPod(volume, services[2]!.id, 'StatefulSet'),
      ];
      const current = await commands.mounts(service.id);
      if (kind === 'publication')
        await commands.removeMount(service.id, mounted.data[0]!.id, {
          revision: current.serviceRevision,
        });
      const started =
        kind === 'publication'
          ? await publication(service.id)
          : await (async () => {
              const task = await serviceCommands.action(
                service.id,
                'delete',
                { revision: current.serviceRevision },
                actor,
                randomUUID(),
              );
              const lease = await repository.claim(task.id, 'storage-delete-fixture');
              if (!lease) throw new Error('Expected a claimable service deletion.');
              return { task, lease, target: published.target, volumes: published.volumes };
            })();
      const finish = () =>
        runtime.afterWorkload(
          started.lease,
          started.target,
          started.volumes,
          { deleted: kind === 'service_delete' },
          new AbortController().signal,
        );
      claims.get(volume.id)!.mounts = [{ ...readers[0]!, controller: null }, readers[1]!];
      await expect(finish()).rejects.toMatchObject({ code: 'VOLUME_DETACH_UNCONFIRMED' });
      claims.get(volume.id)!.mounts = [
        { ...readers[0]!, controller: { ...readers[0]!.controller!, uid: randomUUID() } },
        readers[1]!,
      ];
      await expect(finish()).rejects.toMatchObject({ code: 'VOLUME_DETACH_UNCONFIRMED' });
      const ledger = await db.managedResource.findFirstOrThrow({
        where: { uid: readers[0]!.controller!.uid },
      });
      await db.managedResource.update({
        where: { id: ledger.id },
        data: {
          targetJson: json({
            ...(ledger.targetJson as unknown as ServiceTarget),
            installationId: randomUUID(),
          }),
        },
      });
      claims.get(volume.id)!.mounts = readers;
      await expect(finish()).rejects.toMatchObject({ code: 'VOLUME_DETACH_UNCONFIRMED' });
      expect(
        (await db.volumeMount.findUniqueOrThrow({ where: { id: mounted.data[0]!.id } })).detachedAt,
      ).toBeNull();
      await db.managedResource.update({
        where: { id: ledger.id },
        data: { targetJson: ledger.targetJson! },
      });
      await finish();
      expect(await repository.complete(started.lease, { result: { fixture: true } })).toBe(true);
      expect(
        (await db.volumeMount.findUniqueOrThrow({ where: { id: mounted.data[0]!.id } })).detachedAt,
      ).not.toBeNull();
      expect(await db.volumeMount.count({ where: { volumeId: volume.id, detachedAt: null } })).toBe(
        2,
      );
      expect((await commands.get(volume.id)).mounts.actual).toHaveLength(2);
      expect((await commands.get(volume.id)).pvc.uid).toBe(volume.pvc.uid);
      expect(effects).not.toContain('pvc:delete');
    },
  );
  it('rejects cross-environment mounts, overlapping paths, and multi-replica writers without changing either draft', async () => {
    const volume = await createdVolume();
    const otherContext = await makeContext();
    const wrong = await newService(otherContext),
      scaled = await newService(context, 2),
      service = await newService();
    await expect(mount(wrong.id, volume)).rejects.toMatchObject({
      code: 'VOLUME_ENVIRONMENT_MISMATCH',
    });
    await expect(mount(scaled.id, volume)).rejects.toMatchObject({
      code: 'VOLUME_SINGLE_WRITER_REQUIRED',
    });
    const mounted = await mount(service.id, volume);
    const second = await createdVolume();
    await expect(
      commands.saveMount(service.id, {
        revision: mounted.serviceRevision,
        volumeId: second.id,
        volumeRevision: second.revision,
        mountPath: '/data/nested',
        readOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'VOLUME_MOUNT_PATH_CONFLICT' });
    expect((await commands.mounts(service.id)).data).toHaveLength(1);
  });
  it('persists a first-write database fence even when initialization never becomes ready or a create response is lost', async () => {
    const volume = await db.$transaction((tx) => reserveVolume(tx, volumeInput()));
    const service = await newService(context, 1, 'database');
    const secret = await db.secretReference.create({
      data: {
        name: unique(),
        kind: 'database',
        ...cipher.encrypt('database', { password: 'synthetic-storage-database-password' }),
      },
    });
    const database = await db.databaseInstance.create({
      data: {
        serviceId: service.id,
        dataVolumeId: volume.id,
        originalServiceJson: { id: service.id },
        engine: 'postgresql',
        majorVersion: 17,
        exactVersion: '17.fixture',
        templateId: 'postgresql',
        templateVersion: '1',
        image: 'fixture/postgres:17',
        dataLayout: 'pgdata-fixture',
        credentialRefId: secret.id,
        username: 'app',
        databaseName: 'app',
      },
    });
    const enter = await commands.action(
      volume.id,
      'volume_maintenance_enter',
      { revision: 1, purpose: 'restore' },
      actor,
      randomUUID(),
    );
    lostCreateReceipt = true;
    expect(await runOperation(enter.id)).toMatchObject({ code: 'KUBERNETES_TIMEOUT' });
    const protectedData = await db.databaseInstance.findUniqueOrThrow({
      where: { id: database.id },
    });
    expect(protectedData.initializationFenceAt).not.toBeNull();
    expect(protectedData.initializedAt).toBeNull();
    const retry = await commands.retry(enter.id, actor, randomUUID());
    expect(await runOperation(retry.id)).toBeNull();
    expect(
      (await db.databaseInstance.findUniqueOrThrow({ where: { id: database.id } }))
        .initializationPvcUid,
    ).toBe(claims.get(volume.id)!.uid);
    await expect(
      db.secretReference.update({
        where: { id: secret.id },
        data: { contentRevision: { increment: 1 } },
      }),
    ).rejects.toThrow();
  });
  it('rejects concurrent database deletion without deadlocking its first restore data fence', async () => {
    const name = unique();
    const service = await serviceCommands.create(
      {
        environmentId: context.environment.id,
        name,
        slug: name,
        template: { id: 'postgresql', version: TEMPLATE_VERSION, parameters: {} },
      },
      actor,
      randomUUID(),
    );
    const database = await db.databaseInstance.findUniqueOrThrow({
      where: { serviceId: service.id },
      include: { dataVolume: true },
    });
    const enter = await commands.action(
      database.dataVolumeId,
      'volume_maintenance_enter',
      { revision: database.dataVolume.revision, purpose: 'restore' },
      actor,
      randomUUID(),
    );
    let reportVolumeLock!: (pid: number) => void;
    const volumeLocked = new Promise<number>((resolve) => {
      reportVolumeLock = resolve;
    });
    let releaseDataWrite!: () => void;
    const dataWriteAllowed = new Promise<void>((resolve) => {
      releaseDataWrite = resolve;
    });
    let paused = false;
    let writeError: string | null = null;
    const concurrentRuntime = new StorageExecutor(repository, cipher, manager, {
      beforeDataWrite: async (tx, volumeId, pvcUid) => {
        if (!paused) {
          paused = true;
          const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          reportVolumeLock(backend!.pid);
          await dataWriteAllowed;
        }
        try {
          await establishDatabaseFence(tx, volumeId, pvcUid);
        } catch (error) {
          writeError =
            error instanceof Prisma.PrismaClientKnownRequestError
              ? String(error.meta?.code ?? error.code)
              : 'UNEXPECTED_DATA_WRITE_FAILURE';
          throw error;
        }
      },
    });
    const restoring = runOperation(enter.id, concurrentRuntime);
    const restorePid = await volumeLocked;
    const deleting = serviceCommands
      .action(service.id, 'delete', { revision: service.revision }, actor, randomUUID())
      .then(
        () => ({ status: 202, code: null }),
        (error: unknown) => ({
          status: error instanceof OperationRequestError ? error.status : null,
          code:
            error instanceof OperationRequestError
              ? error.code
              : error instanceof Prisma.PrismaClientKnownRequestError
                ? String(error.meta?.code ?? error.code)
                : 'UNEXPECTED_DELETE_FAILURE',
        }),
      );
    let observedLockWait = false;
    try {
      // Observe a real PostgreSQL lock wait, rather than racing against a timer.
      // Both implementations reach this barrier; the old order already owns
      // DatabaseInstance while waiting for the Volume held by beforeDataWrite.
      await until(
        () =>
          db.$queryRaw<{ pid: number }[]>(Prisma.sql`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND ${restorePid} = ANY(pg_blocking_pids(pid))
          `),
        (rows) => rows.length > 0,
        3000,
      );
      observedLockWait = true;
    } catch {
      // The tasks must still settle before the isolated schema is removed.
    } finally {
      releaseDataWrite();
    }
    const [restoreError, deletion] = await Promise.all([restoring, deleting]);
    expect({ observedLockWait, restore: restoreError?.code ?? null, deletion, writeError }).toEqual(
      {
        observedLockWait: true,
        restore: null,
        deletion: { status: 409, code: 'VOLUME_OPERATION_ACTIVE' },
        writeError: null,
      },
    );
    expect(await db.service.findUniqueOrThrow({ where: { id: service.id } })).toMatchObject({
      revision: service.revision,
      mutationRevision: 0,
    });
    const protectedData = await db.databaseInstance.findUniqueOrThrow({
      where: { id: database.id },
    });
    expect(protectedData.initializationFenceAt).not.toBeNull();
    expect(protectedData.initializationPvcUid).toBe(claims.get(database.dataVolumeId)!.uid);
    expect(protectedData.credentialRefId).toBe(database.credentialRefId);
    expect((await commands.get(database.dataVolumeId)).maintenance?.state).toBe('active');
    expect(
      await db.operation.count({ where: { serviceId: service.id, kind: 'service_delete' } }),
    ).toBe(0);
    expect(effects.filter((effect) => effect === 'pvc:create')).toHaveLength(1);
  });
  it('admits independent-volume deployments and cluster sync while keeping same-volume and connection changes fenced', async () => {
    const volumeA = await createdVolume();
    const volumeB = await createdVolume();
    const services = await Promise.all(
      [volumeA, volumeB].map(async (volume) => {
        const name = unique();
        const service = await serviceCommands.create({
          environmentId: context.environment.id,
          name,
          slug: name,
          configuration: { image: 'fixture/app:1' },
        });
        const mounted = await mount(service.id, volume);
        return { ...service, revision: mounted.serviceRevision };
      }),
    );
    const serviceA = services[0]!,
      serviceB = services[1]!;
    const syncing = await commands.action(
      volumeA.id,
      'volume_sync',
      { revision: volumeA.revision },
      actor,
      randomUUID(),
    );
    const volumeLease = await repository.claim(syncing.id, 'independent-volume-fixture');
    expect(volumeLease).not.toBeNull();
    const secondSync = await commands.action(
      volumeB.id,
      'volume_sync',
      { revision: volumeB.revision },
      actor,
      randomUUID(),
    );
    const secondLease = await repository.claim(secondSync.id, 'second-independent-volume-fixture');
    expect(secondLease).not.toBeNull();
    expect(
      await db.operation.count({
        where: { id: { in: [syncing.id, secondSync.id] }, status: 'running' },
      }),
    ).toBe(2);
    await repository.cancel(secondSync.id, actor);
    expect(await repository.complete(secondLease!)).toBe(true);
    const independent = await serviceCommands.deploy(
      serviceB.id,
      { revision: serviceB.revision },
      actor,
      randomUUID(),
    );
    expect(
      await db.volumeMutation.findUniqueOrThrow({ where: { volumeId: volumeA.id } }),
    ).toMatchObject({
      operationId: syncing.id,
      deploymentId: null,
    });
    expect(
      await db.volumeMutation.findUniqueOrThrow({ where: { volumeId: volumeB.id } }),
    ).toMatchObject({
      operationId: null,
      deploymentId: independent.id,
    });
    await expect(
      serviceCommands.deploy(serviceA.id, { revision: serviceA.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ status: 409, code: 'VOLUME_OPERATION_ACTIVE' });
    await expect(
      serviceCommands.action(
        serviceA.id,
        'stop',
        { revision: serviceA.revision },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'VOLUME_OPERATION_ACTIVE' });
    const clusterSync = await infrastructureCommands.synchronize(
      context.cluster.id,
      context.cluster.revision,
      actor,
      randomUUID(),
    );
    expect(clusterSync.kind).toBe('cluster_sync');
    await repository.cancel(clusterSync.id, actor);
    await expect(
      infrastructureCommands.connect(
        context.cluster.id,
        { revision: context.cluster.revision },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'RESOURCE_OPERATION_ACTIVE' });
    await repository.cancelDeployment(independent.id, actor);
    await repository.cancel(syncing.id, actor);
    expect(await repository.complete(volumeLease!)).toBe(true);
    const connecting = await infrastructureCommands.connect(
      context.cluster.id,
      { revision: context.cluster.revision },
      actor,
      randomUUID(),
    );
    await expect(
      serviceCommands.deploy(serviceA.id, { revision: serviceA.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ status: 409, code: 'CLUSTER_OPERATION_ACTIVE' });
    // Even below command admission, two connection-scoped tasks still share
    // one PostgreSQL slot after Volume operations leave that index.
    await expect(
      db.operation.create({
        data: {
          kind: 'cluster_sync',
          scope: 'cluster',
          clusterId: context.cluster.id,
          input: { targetId: context.cluster.id },
          idempotencyScope: 'storage-fixture-direct-sql',
          idempotencyKey: randomUUID(),
          requestHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await repository.cancel(connecting.id, actor);
  });
  it('keeps cluster observation claim and publication available during queued and running volume tasks', async () => {
    const created = await commands.create(volumeInput(), actor, randomUUID());
    let rejectInspection!: () => void;
    const inspector = {
      inspect: vi.fn<KubernetesConnectionInspector['inspect']>().mockImplementation(
        async (_connection, options) =>
          new Promise((_, reject) => {
            rejectInspection = () =>
              reject(new KubernetesAdapterError('KUBERNETES_API_UNAVAILABLE', true));
            options?.signal?.addEventListener('abort', rejectInspection, { once: true });
            if (options?.signal?.aborted) rejectInspection();
          }),
      ),
    };
    const observer = new ClusterObserver(repository, cipher, inspector);
    observers.add(observer);
    observer.start();
    await until(
      async () => inspector.inspect.mock.calls.length,
      (count) => count === 1,
    );
    const lease = await repository.claim(created.operation.id, 'observed-volume-fixture');
    expect(lease).not.toBeNull();
    rejectInspection();
    const observed = await until(
      () => db.cluster.findUniqueOrThrow({ where: { id: context.cluster.id } }),
      (cluster) => cluster.observationFailures === 1,
    );
    expect(observed.lastErrorCode).toBe('KUBERNETES_API_UNAVAILABLE');
    expect(observed.observationLeaseToken).toBeNull();
    expect((await repository.get(created.operation.id)).status).toBe('running');
    await observer.stop();
    observers.delete(observer);
    await repository.cancel(created.operation.id, actor);
    expect(await repository.complete(lease!)).toBe(true);
  });
  it('keeps maintenance after task failure and expiration, blocks new writers, and closes only after helpers disappear', async () => {
    const volume = await createdVolume();
    claims.get(volume.id)!.mounts = [pod(volume)];
    const enter = await commands.action(
      volume.id,
      'volume_maintenance_enter',
      { revision: volume.revision, purpose: 'backup' },
      actor,
      randomUUID(),
    );
    expect(await runOperation(enter.id)).toMatchObject({
      code: 'VOLUME_MAINTENANCE_NOT_QUIESCENT',
    });
    const failed = await commands.get(volume.id);
    expect(failed.activeTask).toBeNull();
    expect(failed.maintenance?.state).toBe('failed');
    await db.volumeMaintenance.update({
      where: { id: failed.maintenance!.id },
      data: { expiresAt: new Date(0) },
    });
    expect((await commands.get(volume.id)).maintenance?.overdue).toBe(true);
    await expect(
      mount((await newService()).id, await commands.get(volume.id)),
    ).rejects.toMatchObject({ code: 'VOLUME_MAINTENANCE_ACTIVE' });
    const exit = await commands.action(
      volume.id,
      'volume_maintenance_exit',
      { revision: failed.revision, maintenanceId: failed.maintenance!.id },
      actor,
      randomUUID(),
    );
    expect(await runOperation(exit.id)).toMatchObject({ code: 'VOLUME_MAINTENANCE_NOT_QUIESCENT' });
    claims.get(volume.id)!.mounts = [];
    const retry = await commands.retry(exit.id, actor, randomUUID());
    expect(await runOperation(retry.id)).toBeNull();
    expect((await commands.get(volume.id)).maintenance?.state).toBe('closed');
  });
  it('admits service stop after failed maintenance so its existing writer can drain without losing the maintenance fence', async () => {
    const volume = await createdVolume(),
      service = await newService();
    const mounted = await mount(service.id, volume);
    const published = await publish(service.id);
    claims.get(volume.id)!.mounts = [pod(volume, service.id)];
    const enter = await commands.action(
      volume.id,
      'volume_maintenance_enter',
      { revision: volume.revision, purpose: 'backup' },
      actor,
      randomUUID(),
    );
    expect(await runOperation(enter.id)).toMatchObject({
      code: 'VOLUME_MAINTENANCE_NOT_QUIESCENT',
    });
    const current = await db.service.findUniqueOrThrow({ where: { id: service.id } });
    const stop = await serviceCommands.action(
      service.id,
      'stop',
      { revision: current.revision },
      actor,
      randomUUID(),
    );
    const lease = await repository.claim(stop.id, 'storage-maintenance-stop-fixture');
    expect(lease).not.toBeNull();
    claims.get(volume.id)!.mounts = [];
    await runtime.afterWorkload(
      lease!,
      published.target,
      published.volumes,
      {},
      new AbortController().signal,
    );
    expect(await repository.complete(lease!, { result: { fixture: true } })).toBe(true);
    expect((await commands.get(volume.id)).maintenance?.state).toBe('failed');
    expect(
      await db.volumeMount.findUniqueOrThrow({ where: { id: mounted.data[0]!.id } }),
    ).toMatchObject({
      desired: true,
      detachedAt: null,
    });
    const retry = await commands.retry(enter.id, actor, randomUUID());
    expect(await runOperation(retry.id)).toBeNull();
    expect((await commands.get(volume.id)).maintenance?.state).toBe('active');
  });
  it('can exit a cancelled metadata-only restore maintenance without creating data', async () => {
    const volume = await db.$transaction((tx) => reserveVolume(tx, volumeInput()));
    const enter = await commands.action(
      volume.id,
      'volume_maintenance_enter',
      { revision: 1, purpose: 'restore' },
      actor,
      randomUUID(),
    );
    await repository.cancel(enter.id, actor);
    const current = await commands.get(volume.id);
    const exit = await commands.action(
      volume.id,
      'volume_maintenance_exit',
      { revision: current.revision, maintenanceId: current.maintenance!.id },
      actor,
      randomUUID(),
    );
    expect(await runOperation(exit.id)).toBeNull();
    expect((await commands.get(volume.id)).maintenance?.state).toBe('closed');
    expect(effects).toEqual([]);
  });
  it('binds destruction confirmation to the actual data identity and preserves the ledger tombstone', async () => {
    const volume = await createdVolume();
    const preview = await commands.deletionPreview(volume.id, { revision: volume.revision });
    expect(preview.blockers).toEqual([]);
    const confirmation = {
      volumeId: preview.volumeId,
      pvcUid: preview.pvcUid,
      reclaimPolicy: preview.reclaimPolicy,
      previewDigest: preview.previewDigest,
      volumeName: preview.volumeName,
    };
    await expect(
      commands.action(
        volume.id,
        'volume_destroy',
        { revision: volume.revision, confirmation: { ...confirmation, pvcUid: randomUUID() } },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VOLUME_DELETE_CONFIRMATION_CHANGED' });
    const destroy = await commands.action(
      volume.id,
      'volume_destroy',
      { revision: volume.revision, confirmation },
      actor,
      randomUUID(),
    );
    expect(await runOperation(destroy.id)).toBeNull();
    expect(await commands.get(volume.id)).toMatchObject({
      desiredState: 'destroyed',
      pvc: { uid: volume.pvc.uid },
    });
    expect(await db.managedResource.count({ where: { kind: 'Namespace' } })).toBe(1);
    expect(effects.filter((effect) => effect === 'pvc:delete')).toHaveLength(1);
  });
  it('rechecks real Pod references before DELETE and performs no PVC delete when a new Pod appeared after preview', async () => {
    const volume = await createdVolume();
    const preview = await commands.deletionPreview(volume.id, { revision: volume.revision });
    const task = await commands.action(
      volume.id,
      'volume_destroy',
      {
        revision: volume.revision,
        confirmation: {
          volumeId: volume.id,
          pvcUid: preview.pvcUid,
          reclaimPolicy: preview.reclaimPolicy,
          previewDigest: preview.previewDigest,
          volumeName: volume.name,
        },
      },
      actor,
      randomUUID(),
    );
    claims.get(volume.id)!.mounts = [pod(volume)];
    expect(await runOperation(task.id)).toMatchObject({ code: 'VOLUME_ACTUAL_MOUNTS' });
    expect(effects).not.toContain('pvc:delete');
    expect((await commands.get(volume.id)).pvc.uid).toBe(volume.pvc.uid);
  });
  it('refreshes A and B separately, marks failed A stale immediately and preserves its last useful PVC sample', async () => {
    const a = await createdVolume(),
      b = await createdVolume(await makeContext());
    const prior = (await db.volume.findUniqueOrThrow({ where: { id: a.id } })).observationJson;
    manager.observe.mockImplementation(async (_connection, plan) => {
      if (plan.target.volumeId === a.id)
        throw new StorageAdapterError('KUBERNETES_UNREACHABLE', 'Controlled A outage.');
      return observation(plan);
    });
    await db.volume.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { nextObservationAt: new Date(0) },
    });
    startObserver();
    const observed = await until(
      () => commands.get(a.id),
      (view) => view.observation.code === 'KUBERNETES_UNREACHABLE',
    );
    expect(observed.observation.stale).toBe(true);
    expect(observed.pvc.uid).toBe(a.pvc.uid);
    expect((await db.volume.findUniqueOrThrow({ where: { id: a.id } })).observationJson).toEqual(
      prior,
    );
    await until(
      () => commands.get(b.id),
      (view) => view.lastAttemptAt! > b.lastAttemptAt! && !view.observation.stale,
    );
    expect(manager.create).toHaveBeenCalledTimes(2);
    expect(manager.destroy).not.toHaveBeenCalled();
  });
  it('marks both capability and volume read deadlines stale immediately while retaining their prior samples', async () => {
    const volume = await createdVolume();
    const priorVolume = await db.volume.findUniqueOrThrow({ where: { id: volume.id } });
    const priorCluster = await db.cluster.findUniqueOrThrow({ where: { id: context.cluster.id } });
    manager.inspect.mockImplementation(async (_connection, _target, { signal } = {}) =>
      blockedRead(signal!),
    );
    manager.observe.mockImplementation(async (_connection, _plan, { signal } = {}) =>
      blockedRead(signal!),
    );
    await db.cluster.update({
      where: { id: context.cluster.id },
      data: { storageNextObservationAt: new Date(0) },
    });
    await db.volume.update({ where: { id: volume.id }, data: { nextObservationAt: new Date(0) } });
    startObserver({ readTimeoutMs: 150 });
    const [observedVolume, observedCluster] = await Promise.all([
      until(
        () => commands.get(volume.id),
        (view) => view.observation.code === 'STORAGE_OBSERVATION_TIMEOUT',
      ),
      until(
        () => commands.clusterStorage(context.cluster.id),
        (view) => view.errorCode === 'STORAGE_OBSERVATION_TIMEOUT',
      ),
    ]);
    expect(observedVolume.observation.stale).toBe(true);
    expect(observedCluster.stale).toBe(true);
    expect(
      (await db.volume.findUniqueOrThrow({ where: { id: volume.id } })).observationJson,
    ).toEqual(priorVolume.observationJson);
    expect(observedCluster.capabilities).toEqual(priorCluster.storageCapabilitiesJson);
    expect(manager.create).toHaveBeenCalledTimes(1);
    expect(manager.destroy).not.toHaveBeenCalled();
  });
  it('discards shutdown cancellation without publishing a server outage', async () => {
    const volume = await createdVolume();
    manager.observe.mockImplementation(async (_connection, _plan, { signal } = {}) =>
      blockedRead(signal!),
    );
    await db.volume.update({ where: { id: volume.id }, data: { nextObservationAt: new Date(0) } });
    const observer = startObserver();
    await until(
      async () => manager.observe.mock.calls.length,
      (count) => count > 0,
    );
    await observer.stop();
    observers.delete(observer);
    const observed = await commands.get(volume.id);
    expect(observed.observation.code).toBeNull();
    expect(observed.observation.stale).toBe(false);
    expect(observed.pvc.uid).toBe(volume.pvc.uid);
    expect(
      (await db.volume.findUniqueOrThrow({ where: { id: volume.id } })).observationLeaseToken,
    ).toBeNull();
  });
  it('discards a late observation after a newer write intent and does not replace a pinned PVC identity', async () => {
    const volume = await createdVolume();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.observe.mockImplementationOnce(async (_connection, plan) => {
      await gate;
      return { ...observation(plan), message: 'late-read-must-not-win' };
    });
    await db.volume.update({ where: { id: volume.id }, data: { nextObservationAt: new Date(0) } });
    const observer = startObserver();
    await until(
      () => db.volume.findUniqueOrThrow({ where: { id: volume.id } }),
      (row) => Boolean(row.observationLeaseToken),
    );
    const task = await commands.action(
      volume.id,
      'volume_sync',
      { revision: volume.revision },
      actor,
      randomUUID(),
    );
    release();
    await observer.stop();
    observers.delete(observer);
    expect((await commands.get(volume.id)).observation.message).not.toBe('late-read-must-not-win');
    expect(await runOperation(task.id)).toBeNull();
    const current = await db.volume.findUniqueOrThrow({ where: { id: volume.id } });
    expect(current.pvcUid).toBe(volume.pvc.uid);
  });
});

describe('S5 storage HTTP and manual record contract', () => {
  function backupRecordInput(source: VolumeView): CreateManualDataRecordInput {
    return {
      type: 'backup',
      backupId: randomUUID(),
      source: source.manualDataIdentity!,
      target: null,
      engine: 'files',
      engineVersion: 'n/a',
      dataLayout: 'posix-files-v1',
      format: 'tar',
      toolVersion: 'fixture-tool-1',
      sizeBytes: '1024',
      sha256: 'b'.repeat(64),
      startedAt: new Date(Date.now() - 2000).toISOString(),
      completedAt: new Date().toISOString(),
      dataTime: { from: null, to: null, description: 'Operator-reported quiescent snapshot.' },
      offHostLocationLabel: 'A guest → protected host directory',
      integrity: 'passed',
      verificationSteps: ['Compared file digest and mode.'],
      result: 'passed',
      evidenceReferences: ['fixture-manifest.json'],
    };
  }

  it('returns accepted identities, exact mount revisions and complete list filters through the authenticated HTTP API', async () => {
    const payload = volumeInput();
    const response = await app.inject({
      method: 'POST',
      url: '/api/volumes',
      headers: { ...session.headers, 'idempotency-key': randomUUID() },
      payload,
    });
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json<{
      data: { volumeId: string; operation: { id: string; kind: string; scope: string } };
    }>().data;
    expect(created.operation).toMatchObject({ kind: 'volume_create', scope: 'volume' });
    expect(await runOperation(created.operation.id)).toBeNull();
    const service = await newService();
    const mounted = await app.inject({
      method: 'POST',
      url: `/api/services/${service.id}/volume-mounts`,
      headers: session.headers,
      payload: {
        revision: service.revision,
        volumeId: created.volumeId,
        volumeRevision: 1,
        mountPath: '/data',
        readOnly: false,
      },
    });
    expect(mounted.statusCode, mounted.body).toBe(200);
    expect(mounted.json()).toMatchObject({
      serviceRevision: 2,
      configRevision: 2,
      data: [{ volumeId: created.volumeId, desired: true }],
    });
    const second = await createdVolume();
    const related = await app.inject({
      method: 'GET',
      url: `/api/volumes?serviceId=${service.id}&limit=1`,
      headers: session.headers,
    });
    expect(related.json()).toMatchObject({
      data: [{ id: created.volumeId }],
      page: { hasMore: false },
    });
    const retained = await app.inject({
      method: 'GET',
      url: '/api/volumes?retained=true',
      headers: session.headers,
    });
    expect(retained.json<{ data: VolumeView[] }>().data.map((row) => row.id)).toEqual([second.id]);
    expect(retained.body).not.toContain('synthetic-storage-fixture-token');
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/services/${service.id}/volume-mounts`,
      headers: session.headers,
      payload: {
        revision: 2,
        volumeId: second.id,
        volumeRevision: 1,
        mountPath: '/proc/escape',
        readOnly: true,
      },
    });
    expect(invalid.statusCode).toBe(422);
  });
  it('records operator evidence without claiming platform verification and preserves the original backup manifest on restore', async () => {
    const source = await createdVolume(),
      target = await createdVolume(await makeContext());
    const input = backupRecordInput(source);
    const response = await app.inject({
      method: 'POST',
      url: `/api/volumes/${source.id}/manual-data-records`,
      headers: session.headers,
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      data: { verificationSource: 'operator_reported', backupId: input.backupId },
    });
    const forged = await app.inject({
      method: 'POST',
      url: `/api/volumes/${source.id}/manual-data-records`,
      headers: session.headers,
      payload: { ...input, backupId: randomUUID(), platformVerified: true },
    });
    expect(forged.statusCode).toBe(422);
    await expect(
      commands.createManualRecord(
        source.id,
        { ...input, type: 'restore', target: target.manualDataIdentity, sha256: 'c'.repeat(64) },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'MANUAL_BACKUP_MANIFEST_MISMATCH' });
    const restored = await commands.createManualRecord(
      source.id,
      {
        ...input,
        type: 'restore',
        target: target.manualDataIdentity,
        toolVersion: 'fixture-restore-tool-2',
      },
      actor,
    );
    expect(restored.verificationSource).toBe('operator_reported');
    expect((await commands.manualRecords(source.id)).data).toHaveLength(2);
    expect((await commands.get(source.id)).lastManualBackupRecord?.id).toBe(
      response.json<{ data: { id: string } }>().data.id,
    );
    expect(manager.create).toHaveBeenCalledTimes(2);
    expect(manager.destroy).not.toHaveBeenCalled();
  });
  it('accepts reordered source and target identities after a real PostgreSQL JSONB round trip', async () => {
    const source = await createdVolume(),
      target = await createdVolume(await makeContext());
    const reverseKeys = (identity: ManualDataIdentity) =>
      Object.fromEntries(Object.entries(identity).reverse()) as ManualDataIdentity;
    const input = backupRecordInput(source);
    input.source = reverseKeys(input.source);
    expect(Object.keys(input.source)).not.toEqual(Object.keys(source.manualDataIdentity!));
    const backup = await app.inject({
      method: 'POST',
      url: `/api/volumes/${source.id}/manual-data-records`,
      headers: session.headers,
      payload: input,
    });
    expect(backup.statusCode, backup.body).toBe(201);
    const stored = await db.auditEvent.findUniqueOrThrow({
      where: { id: backup.json<{ data: { id: string } }>().data.id },
    });
    const persisted = stored.metadata as unknown as CreateManualDataRecordInput;
    expect(persisted.source).toEqual(source.manualDataIdentity);
    const restore = await app.inject({
      method: 'POST',
      url: `/api/volumes/${source.id}/manual-data-records`,
      headers: session.headers,
      payload: {
        ...persisted,
        type: 'restore',
        target: reverseKeys(target.manualDataIdentity!),
      },
    });
    expect(restore.statusCode, restore.body).toBe(201);
    expect(restore.json()).toMatchObject({
      data: {
        source: source.manualDataIdentity,
        target: target.manualDataIdentity,
        verificationSource: 'operator_reported',
      },
    });
    expect((await commands.manualRecords(source.id)).data).toHaveLength(2);
    expect(manager.destroy).not.toHaveBeenCalled();
  });
  it('rejects a change to any source or target identity field without appending a manual record', async () => {
    const source = await createdVolume(),
      target = await createdVolume(await makeContext()),
      other = await createdVolume();
    const input = backupRecordInput(source);
    await commands.createManualRecord(source.id, input, actor);
    for (const side of ['source', 'target'] as const) {
      const identity = side === 'source' ? source.manualDataIdentity! : target.manualDataIdentity!;
      for (const key of Object.keys(identity) as (keyof ManualDataIdentity)[]) {
        const changed = {
          ...identity,
          [key]: side === 'target' && key === 'volumeId' ? other.id : randomUUID(),
        };
        await expect(
          commands.createManualRecord(
            source.id,
            {
              ...input,
              type: 'restore',
              target: target.manualDataIdentity,
              [side]: changed,
            },
            actor,
          ),
          `${side}.${key}`,
        ).rejects.toMatchObject({
          code:
            side === 'source' ? 'MANUAL_RECORD_SOURCE_MISMATCH' : 'MANUAL_RECORD_TARGET_MISMATCH',
        });
      }
    }
    expect((await commands.manualRecords(source.id)).data).toHaveLength(1);
    expect(manager.destroy).not.toHaveBeenCalled();
  });
  it('rejects unbound source and target volumes without a registered PVC identity', async () => {
    const source = await createdVolume();
    const pending = await commands.create(volumeInput(), actor, randomUUID());
    expect((await commands.get(pending.volumeId)).manualDataIdentity).toBeNull();
    const input = backupRecordInput(source);
    const pendingIdentity = { ...input.source, volumeId: pending.volumeId, pvcUid: randomUUID() };
    await expect(
      commands.createManualRecord(pending.volumeId, { ...input, source: pendingIdentity }, actor),
    ).rejects.toMatchObject({ code: 'MANUAL_RECORD_SOURCE_MISMATCH' });
    await commands.createManualRecord(source.id, input, actor);
    await expect(
      commands.createManualRecord(
        source.id,
        { ...input, type: 'restore', target: pendingIdentity },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'MANUAL_RECORD_TARGET_MISMATCH' });
    expect((await commands.manualRecords(pending.volumeId)).data).toHaveLength(0);
    expect((await commands.manualRecords(source.id)).data).toHaveLength(1);
    expect(manager.destroy).not.toHaveBeenCalled();
  });
  it('keeps read endpoints available while recovery mode blocks every storage mutation', async () => {
    const volume = await createdVolume();
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true, generation: { increment: 1 } },
    });
    const read = await app.inject({
      method: 'GET',
      url: `/api/volumes/${volume.id}`,
      headers: session.headers,
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: '/api/volumes',
      headers: { ...session.headers, 'idempotency-key': randomUUID() },
      payload: volumeInput(),
    });
    expect(write.statusCode).toBe(503);
    expect(await db.volume.count()).toBe(1);
  });
});
