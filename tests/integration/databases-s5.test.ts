import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { createApp } from '../../apps/api/dist/app.js';
import { createTestSession } from './helpers.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import { ServiceCommands } from '../../packages/control-plane/src/services/commands.js';
import { DatabaseCommands } from '../../packages/control-plane/src/databases/commands.js';
import { StorageCommands } from '../../packages/control-plane/src/storage/commands.js';
import {
  TaskRepository,
  type OperationActor,
} from '../../packages/control-plane/src/tasks/repository.js';
import { json, lockService } from '../../packages/control-plane/src/services/persistence.js';
import type {
  ServiceSnapshotV2,
  ServiceTarget,
  ServiceView,
} from '../../packages/control-plane/src/services/contracts.js';
import {
  assertDatabaseBindingSnapshots,
  databaseConsumers,
} from '../../packages/control-plane/src/databases/persistence.js';
import {
  assertDatabaseSecretMutation,
  assertDatabaseSnapshot,
  databaseSnapshot,
  establishDatabaseFence,
} from '../../packages/control-plane/src/databases/protection.js';
import {
  augmentDatabaseRuntime,
  databaseBindingEnvironment,
  databaseLogSecrets,
  saveDatabaseVerification,
} from '../../packages/control-plane/src/databases/runtime.js';
import {
  beforeStorageWrite,
  saveStorageReceipt,
} from '../../packages/control-plane/src/storage/ledger.js';
import { lockVolume } from '../../packages/control-plane/src/storage/persistence.js';
import type {
  DatabaseBindingCollection,
  DatabaseBindingInput,
  DatabaseBindingPreview,
  DatabaseEngine,
  DatabaseView,
  TemplateId,
  TemplatePreview,
  TemplateView,
} from '../../packages/control-plane/src/databases/contracts.js';
import { TEMPLATE_VERSION } from '../../packages/control-plane/src/templates/catalog.js';
import {
  workloadNames,
  type DatabaseVerification,
  type WorkloadConfiguration,
  type WorkloadObservation,
} from '../../packages/infrastructure/dist/workload.js';
import type { StorageCapabilities } from '../../packages/infrastructure/dist/storage.js';

// Real PostgreSQL transactions, production commands and authenticated HTTP contracts.
// Kubernetes controller/PVC/authentication facts below are explicitly controlled fixtures;
// this suite does not certify a real PostgreSQL/Redis process, K3s, backup or restore.
const execute = promisify(execFile);
const schema = `s5databases_${randomUUID().replaceAll('-', '')}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalMasterKeyFile = process.env.MASTER_KEY_FILE;
if (!originalDatabaseUrl) throw new Error('S5 database integration requires PostgreSQL.');
const url = new URL(originalDatabaseUrl);
url.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-database-integration-'));
const masterKeyFile = join(directory, 'fixture-master-key.json');
const initialKey = randomBytes(32);
const keys = new Map([[1, initialKey]]);
const cipher = new SecretCipher({ activeVersion: 1, keys });
const db = new PrismaClient({ datasourceUrl: url.toString() });
const repository = new TaskRepository(db, { leaseMs: 30_000 });
const services = new ServiceCommands(repository, cipher);
const databases = new DatabaseCommands(repository);
const storage = new StorageCommands(repository);
let app: Awaited<ReturnType<typeof createApp>>;
let session: Awaited<ReturnType<typeof createTestSession>>;
let actor: OperationActor;
let context: Awaited<ReturnType<typeof makeContext>>;
let sequence = 0;
const unique = () => `database-fixture-${++sequence}`;

function capabilities(): StorageCapabilities {
  return {
    observedAt: new Date().toISOString(),
    truncated: false,
    permissions: 'ready',
    provisioner: { state: 'ready', version: 'fixture-local-path' },
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
        message: 'Controlled storage capabilities.',
        hardQuotaSupport: 'unsupported',
        allowVolumeExpansion: false,
      },
    ],
  };
}
async function makeContext() {
  const name = unique();
  const credential = await db.secretReference.create({
    data: {
      name,
      kind: 'kubeconfig',
      ...cipher.encrypt('kubeconfig', { fixture: 'never used for a network call' }),
    },
  });
  const observed = capabilities();
  const cluster = await db.cluster.create({
    data: {
      name,
      slug: name,
      apiEndpoint: 'https://127.0.0.1:65534',
      kubeSystemUid: randomUUID(),
      caFingerprint: 'a'.repeat(64),
      credentialRefId: credential.id,
      connectionStatus: 'connected',
      lastObservedAt: new Date(),
      storageCapabilitiesJson: json(observed),
      storageCapabilitiesAt: new Date(),
      storageNextObservationAt: new Date(Date.now() + 3600_000),
    },
  });
  const project = await db.project.create({ data: { name, slug: name, clusterId: cluster.id } });
  const environment = await db.environment.create({
    data: { name: 'Production', slug: 'production', projectId: project.id },
  });
  const staging = await db.environment.create({
    data: { name: 'Staging', slug: 'staging', projectId: project.id },
  });
  return {
    cluster,
    project,
    environment,
    staging,
    storageClassUid: observed.storageClasses[0]!.uid,
  };
}
function templateInput(id: TemplateId = 'postgresql', environmentId = context.environment.id) {
  const name = unique();
  return {
    environmentId,
    projectId: context.project.id,
    name,
    slug: name,
    template: { id, version: TEMPLATE_VERSION, parameters: {} },
  };
}
async function createProvider(engine: DatabaseEngine = 'postgresql') {
  return services.create(templateInput(engine), actor, randomUUID());
}
async function createConsumer(
  environmentId = context.environment.id,
  environment: { name: string; value: string; secret?: boolean }[] = [],
) {
  const name = unique();
  return services.create({
    environmentId,
    name,
    slug: name,
    configuration: { image: 'example.test/fixture/application:1', environment },
  });
}
async function acceptedPublication(serviceId: string) {
  const current = await services.get(serviceId);
  const task = await services.deploy(
    serviceId,
    { revision: current.revision, deployAndStart: true, allowConfigurationRepair: true },
    actor,
    randomUUID(),
  );
  const lease = await repository.claimDeployment(task.id, 'database-integration-fixture');
  if (!lease) throw new Error('Expected a claimable fixture publication.');
  return {
    task,
    lease,
    snapshot: task.snapshotJson as ServiceSnapshotV2,
    target: task.targetJson as ServiceTarget,
  };
}
async function firstDataIntent(
  started: Awaited<ReturnType<typeof acceptedPublication>>,
  withReceipt = false,
) {
  const identity = started.snapshot.database!;
  expect(identity).not.toBeNull();
  let claimUid: string | null = null;
  expect(
    await repository.checkpoint(started.lease, async (tx) => {
      const row = await lockVolume(tx, identity.dataVolumeId);
      let version = await beforeStorageWrite(
        tx,
        row.id,
        {
          action: 'create',
          name: row.pvcName,
          namespace: row.namespace,
          creationNonce: row.creationNonce,
          expectedUid: null,
          expectedResourceVersion: null,
          mutationRevision: row.mutationRevision,
          storageClassUid: context.storageClassUid,
          binding: null,
        },
        row.ledgerVersion,
        { beforeDataWrite: establishDatabaseFence },
      );
      if (withReceipt) {
        claimUid = randomUUID();
        version = await saveStorageReceipt(
          tx,
          row.id,
          {
            action: 'created',
            name: row.pvcName,
            namespace: row.namespace,
            creationNonce: row.creationNonce,
            uid: claimUid,
            resourceVersion: '10',
            mutationRevision: row.mutationRevision,
            storageClassUid: context.storageClassUid,
            specFingerprint: 'b'.repeat(64),
            binding: null,
            observedAt: new Date().toISOString(),
          },
          version,
          { beforeDataWrite: establishDatabaseFence },
        );
      }
      expect(version).toBe(withReceipt ? 2 : 1);
    }),
  ).toBe(true);
  return claimUid;
}
function workloadObservation(
  started: Awaited<ReturnType<typeof acceptedPublication>>,
  controllerUid: string,
  podUid: string,
  observedAt: string,
): WorkloadObservation {
  const metrics = {
    state: 'unknown' as const,
    cpuCores: null,
    memoryBytes: null,
    observedAt: null,
    windowSeconds: null,
  };
  return {
    observedAt,
    configurationState: 'consistent',
    drift: [],
    resources: [],
    deployment: null,
    controller: {
      kind: 'StatefulSet',
      strategy: 'RollingUpdate',
      uid: controllerUid,
      resourceVersion: '20',
      generation: 1,
      observedGeneration: 1,
      replicas: 1,
      currentReplicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      snapshotId: started.task.id,
      configRevision: started.snapshot.configRevision,
      mutationRevision: started.task.mutationRevision,
      rolloutId: started.task.id,
      image: started.snapshot.configuration.image,
      templateFingerprint: 'c'.repeat(64),
      workloadFingerprint: 'd'.repeat(64),
      progressDeadlineExceeded: false,
      deleting: false,
      currentRevision: 'fixture-revision',
      updateRevision: 'fixture-revision',
    },
    pods: [
      {
        name: `ozz-s-${started.target.serviceId.replaceAll('-', '')}-0`,
        uid: podUid,
        namespace: started.target.namespace,
        nodeName: 'fixture-node',
        createdAt: observedAt,
        deletionTimestamp: null,
        phase: 'Running',
        ready: true,
        snapshotId: started.task.id,
        configRevision: started.snapshot.configRevision,
        rolloutId: started.task.id,
        replicaSetUid: null,
        owner: { kind: 'StatefulSet', uid: controllerUid },
        matchesControllerTemplate: true,
        matchesDeploymentTemplate: false,
        containers: [],
      },
    ],
    podsTruncated: false,
    events: [],
    eventsState: 'available',
    eventsTruncated: false,
    metrics,
    metricsErrorCode: null,
    serviceDns: `${started.target.serviceName}.${started.target.namespace}.svc.cluster.local`,
  };
}
async function readyProvider(engine: DatabaseEngine = 'postgresql') {
  const service = await createProvider(engine);
  const started = await acceptedPublication(service.id);
  const pvcUid = await firstDataIntent(started, true);
  const controllerUid = randomUUID(),
    serviceUid = randomUUID(),
    podUid = randomUUID(),
    now = new Date();
  const identity = started.snapshot.database!;
  const names = workloadNames(started.target);
  const verification: DatabaseVerification = {
    observedAt: now.toISOString(),
    state: 'ready',
    engine,
    authenticated: true,
    expectedMajor: identity.majorVersion,
    observedMajor: identity.majorVersion,
    version: identity.exactVersion,
    username: identity.username,
    databaseName: identity.databaseName,
    pod: {
      name: `${names.statefulSet}-0`,
      uid: podUid,
      controller: { kind: 'StatefulSet', uid: controllerUid },
    },
    redis:
      engine === 'redis'
        ? { aofEnabled: true, appendfsync: 'everysec', lastWriteStatus: 'ok' }
        : null,
    code: null,
    message: 'Controlled authenticated fixture result.',
  };
  expect(
    await repository.complete(started.lease, {
      result: { fixture: 'controller and authentication facts' },
      commit: async (tx) => {
        for (const resource of [
          { kind: 'Service', name: names.service, uid: serviceUid },
          { kind: 'StatefulSet', name: names.statefulSet, uid: controllerUid },
        ])
          await tx.managedResource.create({
            data: {
              ...resource,
              clusterId: started.target.clusterId,
              environmentId: started.target.environmentId,
              serviceId: service.id,
              namespace: started.target.namespace,
              targetJson: json(started.target),
              creationAttempted: true,
              resourceVersion: '20',
            },
          });
        await tx.deployment.update({ where: { id: started.task.id }, data: { appliedAt: now } });
        await tx.service.update({
          where: { id: service.id },
          data: {
            publishedDeploymentId: started.task.id,
            lastSuccessfulDeploymentId: started.task.id,
            remoteCreatedAt: now,
            configurationState: 'consistent',
            observationJson: json(
              workloadObservation(started, controllerUid, podUid, now.toISOString()),
            ),
            lastObservedAt: now,
            observationErrorCode: null,
          },
        });
        await saveDatabaseVerification(tx, await lockService(tx, service.id), verification);
      },
    }),
  ).toBe(true);
  const database = await databases.forService(service.id);
  expect(database.databaseReady).toBe(true);
  return { service, database, ...started, pvcUid: pvcUid!, verification, serviceUid };
}
function bindingInput(
  consumer: Pick<ServiceView, 'revision'>,
  database: Pick<DatabaseView, 'id'>,
  mapping: DatabaseBindingInput['mapping'] = { url: 'DATABASE_URL' },
): DatabaseBindingInput {
  return {
    revision: consumer.revision,
    databaseInstanceId: database.id,
    profile: mapping.url ? 'url' : 'fields',
    mapping,
  };
}
async function publishConsumer(serviceId: string) {
  const started = await acceptedPublication(serviceId);
  expect(
    await repository.complete(started.lease, {
      result: { fixture: 'accepted snapshot publication pointer only' },
      commit: async (tx) => {
        await tx.deployment.update({
          where: { id: started.task.id },
          data: { appliedAt: new Date() },
        });
        await tx.service.update({
          where: { id: serviceId },
          data: { publishedDeploymentId: started.task.id, configurationState: 'consistent' },
        });
      },
    }),
  ).toBe(true);
  return started;
}
async function counts() {
  const [
    service,
    database,
    volume,
    secret,
    receipt,
    deployment,
    operation,
    outbox,
    resource,
    audit,
  ] = await Promise.all([
    db.service.count(),
    db.databaseInstance.count(),
    db.volume.count(),
    db.secretReference.count(),
    db.commandReceipt.count(),
    db.deployment.count(),
    db.operation.count(),
    db.outbox.count(),
    db.managedResource.count(),
    db.auditEvent.count(),
  ]);
  return {
    service,
    database,
    volume,
    secret,
    receipt,
    deployment,
    operation,
    outbox,
    resource,
    audit,
  };
}
async function publicPersistedBytes() {
  return JSON.stringify(
    await Promise.all([
      db.service.findMany({ select: { configJson: true, observationJson: true } }),
      db.commandReceipt.findMany({ select: { resultJson: true } }),
      db.deployment.findMany({ select: { snapshotJson: true, result: true, logsJson: true } }),
      db.operation.findMany({ select: { input: true, result: true, logsJson: true } }),
      db.auditEvent.findMany({ select: { metadata: true } }),
    ]),
  );
}
function secretAbsent(bytes: string, value: string) {
  expect(bytes.includes(value), 'Generated fixture password must not appear in public bytes.').toBe(
    false,
  );
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
  writeFileSync(
    masterKeyFile,
    JSON.stringify({ activeVersion: 1, keys: { '1': initialKey.toString('base64') } }),
    { mode: 0o600 },
  );
  process.env.DATABASE_URL = url.toString();
  process.env.MASTER_KEY_FILE = masterKeyFile;
  await db.$connect();
  app = await createApp({ silent: true });
  session = await createTestSession(app, db);
  actor = { id: session.adminId };
});
beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "${schema}"."Cluster", "${schema}"."SecretReference", "${schema}"."CommandReceipt", "${schema}"."AuditEvent" CASCADE`,
  );
  context = await makeContext();
});
afterEach(async () => {
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
    if (originalMasterKeyFile === undefined) delete process.env.MASTER_KEY_FILE;
    else process.env.MASTER_KEY_FILE = originalMasterKeyFile;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('S5 template drafts and generated database identities', () => {
  it('lists fixed template versions and renders previews without allocating any service, credential, task or volume', async () => {
    const initial = await counts();
    const catalog = await app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: session.headers,
    });
    expect(catalog.statusCode).toBe(200);
    const templates = catalog.json<{ data: TemplateView[] }>().data;
    expect(templates.map((item) => item.id).sort()).toEqual([
      'docker',
      'node-example',
      'postgresql',
      'redis',
      'static-example',
    ]);
    for (const item of templates.filter((item) => item.image)) {
      expect(item.image!.reference).toContain('@sha256:');
      expect([...item.image!.platforms].sort()).toEqual(['amd64', 'arm64']);
    }
    for (const id of ['postgresql', 'redis', 'node-example', 'static-example']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/templates/${id}/preview`,
        headers: session.headers,
        payload: {
          environmentId: context.environment.id,
          projectId: context.project.id,
          version: TEMPLATE_VERSION,
          parameters: {},
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const preview = response.json<{ data: TemplatePreview }>().data;
      expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(preview.clusterId).toBe(context.cluster.id);
      expect(preview.issues).toEqual([]);
      expect(preview.plannedCredentials.length).toBe(id === 'postgresql' || id === 'redis' ? 1 : 0);
    }
    expect(await counts()).toEqual(initial);
  });
  it.each(['postgresql', 'redis'] as const)(
    'creates exactly one %s template draft for concurrent HTTP retries and never returns its generated password',
    async (engine) => {
      const input = templateInput(engine),
        key = randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          app.inject({
            method: 'POST',
            url: '/api/services',
            headers: { ...session.headers, 'idempotency-key': key },
            payload: input,
          }),
        ),
      );
      for (const response of responses) expect(response.statusCode, response.body).toBe(201);
      const created = responses[0]!.json<{ data: ServiceView }>().data;
      expect(
        responses.every(
          (response) => response.json<{ data: ServiceView }>().data.id === created.id,
        ),
      ).toBe(true);
      expect(created).toMatchObject({
        kind: 'database',
        controller: { kind: 'StatefulSet' },
        template: { id: engine, version: TEMPLATE_VERSION },
        runtimeState: 'unpublished',
        activeTask: null,
      });
      expect(await counts()).toMatchObject({
        service: 1,
        database: 1,
        volume: 1,
        secret: 2,
        receipt: 1,
        deployment: 0,
        operation: 0,
        outbox: 0,
      });
      const row = await db.databaseInstance.findUniqueOrThrow({ where: { serviceId: created.id } });
      const credential = await db.secretReference.findUniqueOrThrow({
        where: { id: row.credentialRefId },
      });
      const value = cipher.decrypt(credential).password;
      expect(typeof value).toBe('string');
      expect(String(value)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const mounts = await db.volumeMount.findMany({ where: { serviceId: created.id } });
      expect(mounts).toHaveLength(1);
      expect(mounts[0]).toMatchObject({
        volumeId: row.dataVolumeId,
        readOnly: false,
        mountPath: engine === 'postgresql' ? '/var/lib/postgresql/data' : '/data',
      });
      for (const path of [
        `/api/services/${created.id}`,
        `/api/services/${created.id}/database`,
        `/api/databases/${row.id}`,
        `/api/secrets/${row.credentialRefId}`,
        '/api/secrets',
      ]) {
        const read = await app.inject({ method: 'GET', url: path, headers: session.headers });
        expect(read.statusCode, read.body).toBe(200);
        secretAbsent(read.body, String(value));
        expect(read.body).not.toContain('encryptedPayload');
      }
      for (const response of responses) secretAbsent(response.body, String(value));
      secretAbsent(await publicPersistedBytes(), String(value));
      const conflict = await app.inject({
        method: 'POST',
        url: '/api/services',
        headers: { ...session.headers, 'idempotency-key': key },
        payload: { ...input, name: 'Changed request' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');
      const changedSource = await app.inject({
        method: 'POST',
        url: '/api/services',
        headers: { ...session.headers, 'idempotency-key': key },
        payload: {
          environmentId: input.environmentId,
          name: 'Image instead of the original database',
          slug: 'another-image-service',
          configuration: { image: 'nginx:1.27' },
        },
      });
      expect(changedSource.statusCode, changedSource.body).toBe(409);
      expect(changedSource.json().code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await db.service.count()).toBe(1);
      expect(await db.databaseInstance.count()).toBe(1);
    },
  );
  it('rejects unknown versions, password injection and mixed configuration/template sources without allocating identities', async () => {
    const initial = await counts();
    for (const payload of [
      { ...templateInput(), template: { id: 'postgresql', version: 'missing', parameters: {} } },
      {
        ...templateInput(),
        template: {
          id: 'postgresql',
          version: TEMPLATE_VERSION,
          parameters: { password: 'must-never-be-accepted' },
        },
      },
      {
        ...templateInput(),
        template: { id: 'postgresql', version: TEMPLATE_VERSION, parameters: { port: 5432 } },
      },
      {
        ...templateInput(),
        template: { id: 'postgresql', version: TEMPLATE_VERSION, parameters: { username: null } },
      },
      { ...templateInput(), configuration: { image: 'example.test/app:1' } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/services',
        headers: { ...session.headers, 'idempotency-key': randomUUID() },
        payload,
      });
      expect([404, 422]).toContain(response.statusCode);
    }
    expect(await counts()).toMatchObject({ ...initial, audit: expect.any(Number) });
  });
  it('permits a template draft when storage observations are stale, while its preview clearly marks publication as blocked', async () => {
    await db.cluster.update({
      where: { id: context.cluster.id },
      data: { storageCapabilitiesAt: new Date(0), storageErrorCode: 'KUBERNETES_UNREACHABLE' },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/templates/postgresql/preview',
      headers: session.headers,
      payload: { environmentId: context.environment.id, version: TEMPLATE_VERSION, parameters: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: TemplatePreview }>().data.issues).toContainEqual(
      expect.objectContaining({ code: 'VOLUME_OBSERVATION_REQUIRED', blocks: 'deploy' }),
    );
    const service = await createProvider();
    expect(service.runtimeState).toBe('unpublished');
    expect(await db.operation.count()).toBe(0);
    expect(await db.deployment.count()).toBe(0);
  });
});

describe('S5 database credential and first-data protection', () => {
  it('rejects a changed exact engine version in the original database snapshot even when its image and major version match', async () => {
    const provider = await createProvider();
    const row = await db.databaseInstance.findUniqueOrThrow({ where: { serviceId: provider.id } });
    const original = databaseSnapshot(row);
    await expect(
      db.$transaction((tx) =>
        assertDatabaseSnapshot(tx, provider.id, { ...original, exactVersion: '17.different' }),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DATA_PROTECTED' });
  });
  it('rejects database initialization credentials as generic environment secrets and forbids ordinary credential deletion', async () => {
    const provider = await createProvider();
    const identity = await databases.forService(provider.id);
    const consumer = await createConsumer();
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/services/${consumer.id}`,
      headers: session.headers,
      payload: {
        revision: consumer.revision,
        configuration: {
          image: consumer.configuration.image,
          environment: [
            {
              name: 'STOLEN_PASSWORD',
              secretRefId: identity.credential.refId,
              secretKey: 'password',
            },
          ],
        },
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().code).toBe('SERVICE_SECRET_INVALID');
    expect((await services.get(consumer.id)).revision).toBe(consumer.revision);
    const credential = await db.secretReference.findUniqueOrThrow({
      where: { id: identity.credential.refId },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/secrets/${credential.id}?revision=${credential.revision}`,
      headers: session.headers,
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json().code).toBe('DATABASE_DATA_PROTECTED');
    expect(await db.secretReference.count({ where: { id: credential.id } })).toBe(1);
    await expect(
      db.$transaction((tx) => assertDatabaseSecretMutation(tx, credential.id, 'payload')),
    ).rejects.toMatchObject({ code: 'DATABASE_DATA_PROTECTED' });
  });
  it.each(['postgresql', 'redis'] as const)(
    'persists the original %s credential fence before a PVC response or successful initialization and permits equivalent master-key rewrapping',
    async (engine) => {
      const service = await createProvider(engine);
      const started = await acceptedPublication(service.id);
      const original = started.snapshot.database!;
      await firstDataIntent(started);
      const fenced = await db.databaseInstance.findUniqueOrThrow({
        where: { id: original.databaseInstanceId },
      });
      expect(fenced.initializationFenceAt).not.toBeNull();
      expect(fenced.initializedAt).toBeNull();
      expect(fenced.initializationPvcUid).toBeNull();
      expect(fenced.initializationIntentJson).toMatchObject({
        volumeId: original.dataVolumeId,
        credentialRefId: original.credentialRefId,
        credentialContentRevision: original.credentialContentRevision,
      });
      const secret = await db.secretReference.findUniqueOrThrow({
        where: { id: original.credentialRefId },
      });
      const payload = cipher.decrypt(secret);
      keys.set(2, randomBytes(32));
      const rotated = new SecretCipher({ activeVersion: 2, keys });
      await db.$transaction(async (tx) => {
        await assertDatabaseSecretMutation(tx, secret.id, 'rewrap');
        await tx.secretReference.update({
          where: { id: secret.id },
          data: { ...rotated.encrypt('database', payload), revision: { increment: 1 } },
        });
      });
      const rewrapped = await db.secretReference.findUniqueOrThrow({ where: { id: secret.id } });
      expect(rotated.decrypt(rewrapped)).toEqual(payload);
      expect(rewrapped.contentRevision).toBe(secret.contentRevision);
      expect(rewrapped.keyVersion).toBe(2);
      await expect(
        db.$transaction((tx) => assertDatabaseSnapshot(tx, service.id, original)),
      ).resolves.toHaveProperty('id', original.databaseInstanceId);
      expect(
        databaseSnapshot(await db.databaseInstance.findUniqueOrThrow({ where: { id: fenced.id } })),
      ).toEqual(databaseSnapshot(fenced));
      const runtime = await db.$transaction((tx) =>
        augmentDatabaseRuntime(tx, rotated, started.snapshot, {
          ...started.snapshot.configuration,
          environment: [],
          volumes: [],
        } as WorkloadConfiguration),
      );
      expect(runtime.environment.some((entry) => entry.value === payload.password)).toBe(true);
      if (engine === 'redis') {
        expect(
          runtime.secretFiles?.some((file) =>
            file.value.includes('appendonly yes\nappendfsync everysec'),
          ),
        ).toBe(true);
        expect(runtime.args).toEqual(['redis-server', '/run/ozz/database/redis.conf']);
      }
      await expect(
        db.secretReference.update({
          where: { id: secret.id },
          data: {
            ...rotated.encrypt('database', { password: 'synthetic-replacement-password' }),
            contentRevision: { increment: 1 },
          },
        }),
      ).rejects.toThrow();
      secretAbsent(await publicPersistedBytes(), String(payload.password));
      expect(
        await repository.fail(
          started.lease,
          'CONTROLLED_INITIALIZATION_FAILURE',
          'Fixture stopped before initialization.',
          false,
        ),
      ).toBe(true);
      expect((await databases.get(fenced.id)).protection.active).toBe(true);
      expect((await databases.get(fenced.id)).initialization.initializedAt).toBeNull();
    },
  );
  it('keeps database command, image, replica and data-mount changes out of ordinary configuration updates while allowing resource tuning', async () => {
    const provider = await readyProvider();
    const current = await services.get(provider.service.id);
    for (const patch of [
      { image: 'example.test/unrelated/postgresql:18' },
      { replicas: 2 },
      { command: ['sh', '-c', 'sleep infinity'] },
      { environment: [{ name: 'POSTGRES_PASSWORD', value: 'synthetic-password-change' }] },
    ])
      await expect(
        services.update(current.id, {
          revision: current.revision,
          configuration: { ...current.configuration, ...patch },
        }),
      ).rejects.toMatchObject({ code: 'DATABASE_DATA_PROTECTED' });
    const mount = (await storage.mounts(current.id)).data[0]!;
    await expect(
      storage.removeMount(current.id, mount.id, { revision: current.revision }),
    ).rejects.toMatchObject({ code: 'DATABASE_DATA_PROTECTED' });
    const tuned = await services.update(current.id, {
      revision: current.revision,
      configuration: {
        ...current.configuration,
        resources: {
          requests: { cpuMillis: 200, memoryMiB: 256 },
          limits: { cpuMillis: 1000, memoryMiB: 1024 },
        },
      },
    });
    expect(tuned.configuration.resources.limits.memoryMiB).toBe(1024);
    expect(tuned.published?.deploymentId).toBe(provider.task.id);
    expect(tuned.hasUnpublishedChanges).toBe(true);
  });
});

describe('S5 database bindings, immutable publications and provider retention', () => {
  it('previews and saves same-environment bindings as drafts without deploying, rejecting foreign targets and variable conflicts', async () => {
    const provider = await readyProvider();
    const consumer = await createConsumer();
    const input = bindingInput(consumer, provider.database);
    const before = await counts();
    const preview = await app.inject({
      method: 'POST',
      url: `/api/services/${consumer.id}/database-bindings/preview`,
      headers: session.headers,
      payload: input,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<{ data: DatabaseBindingPreview }>().data).toMatchObject({
      variables: [{ name: 'DATABASE_URL', output: 'url', secret: true, change: 'add' }],
      issues: [],
    });
    expect(await counts()).toEqual(before);
    for (const mapping of [
      {},
      { url: null },
      { unexpected: 'BAD_OUTPUT' },
      { url: 'DATABASE_URL', host: 'PGHOST' },
    ]) {
      const invalid = await app.inject({
        method: 'POST',
        url: `/api/services/${consumer.id}/database-bindings`,
        headers: session.headers,
        payload: { ...input, mapping },
      });
      expect(invalid.statusCode, invalid.body).toBe(422);
      expect(await db.databaseBinding.count()).toBe(0);
    }
    const saved = await app.inject({
      method: 'POST',
      url: `/api/services/${consumer.id}/database-bindings`,
      headers: session.headers,
      payload: input,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<DatabaseBindingCollection>()).toMatchObject({
      serviceRevision: consumer.revision + 1,
      configRevision: consumer.configRevision + 1,
      data: [{ desired: true, published: false }],
    });
    expect(await db.deployment.count({ where: { serviceId: consumer.id } })).toBe(0);
    expect((await services.get(consumer.id)).configuration.environment).toEqual([]);
    const foreign = await createConsumer(context.staging.id);
    await expect(
      databases.save(foreign.id, bindingInput(foreign, provider.database)),
    ).rejects.toMatchObject({ code: 'DATABASE_TARGET_MISMATCH' });
    const conflict = await createConsumer(context.environment.id, [
      { name: 'DATABASE_URL', value: 'manual-value' },
    ]);
    const conflictInput = bindingInput(conflict, provider.database);
    expect((await databases.preview(conflict.id, conflictInput)).issues).toContainEqual(
      expect.objectContaining({ code: 'DATABASE_VARIABLE_CONFLICT', blocks: 'both' }),
    );
    await expect(databases.save(conflict.id, conflictInput)).rejects.toMatchObject({
      code: 'DATABASE_VARIABLE_CONFLICT',
    });
    const current = await services.get(consumer.id);
    await expect(
      services.update(current.id, {
        revision: current.revision,
        configuration: {
          ...current.configuration,
          environment: [{ name: 'DATABASE_URL', value: 'manual-overwrite', secret: true }],
        },
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_VARIABLE_CONFLICT' });
    expect(await db.secretReference.count({ where: { kind: 'generic' } })).toBe(0);
  });
  it('pins private Service UID, credential content revision and output mapping in a publication instead of reading the later binding draft', async () => {
    const provider = await readyProvider();
    const consumer = await createConsumer();
    await databases.save(
      consumer.id,
      bindingInput(consumer, provider.database, { host: 'PGHOST', password: 'PGPASSWORD' }),
    );
    const first = await acceptedPublication(consumer.id);
    const binding = first.snapshot.databaseBindings[0]!;
    expect(binding).toMatchObject({
      providerServiceId: provider.service.id,
      providerDeploymentId: provider.task.id,
      providerServiceUid: provider.serviceUid,
      credentialRefId: provider.database.credential.refId,
      credentialContentRevision: provider.database.credential.contentRevision,
      mapping: { host: 'PGHOST', password: 'PGPASSWORD' },
    });
    expect(
      await db.deploymentDatabaseReference.findUniqueOrThrow({
        where: {
          deploymentId_databaseInstanceId: {
            deploymentId: first.task.id,
            databaseInstanceId: provider.database.id,
          },
        },
      }),
    ).toMatchObject({ referenceJson: binding });
    expect((await databaseConsumers(db, provider.database.id)).consumers).toContainEqual(
      expect.objectContaining({ serviceId: consumer.id, inFlight: true }),
    );
    expect(
      await repository.fail(
        first.lease,
        'CONTROLLED_DEPLOYMENT_FAILURE',
        'Fixture failed before remote writes.',
        false,
      ),
    ).toBe(true);
    await databases.save(
      consumer.id,
      bindingInput(await services.get(consumer.id), provider.database, { url: 'NEW_DATABASE_URL' }),
    );
    const current = await services.get(consumer.id);
    const retry = await services.retryDeployment(
      first.task.id,
      { revision: current.revision, deployAndStart: true, allowConfigurationRepair: true },
      actor,
      randomUUID(),
    );
    expect((retry.snapshotJson as ServiceSnapshotV2).databaseBindings).toEqual(
      first.snapshot.databaseBindings,
    );
    const credential = await db.secretReference.findUniqueOrThrow({
      where: { id: binding.credentialRefId },
    });
    const password = String(cipher.decrypt(credential).password);
    const runtime = await db.$transaction((tx) =>
      databaseBindingEnvironment(tx, cipher, first.snapshot.databaseBindings),
    );
    expect(runtime).toContainEqual({ name: 'PGPASSWORD', value: password });
    expect(await db.$transaction((tx) => databaseLogSecrets(tx, cipher, first.snapshot))).toContain(
      password,
    );
    expect(runtime.some((entry) => entry.name === 'NEW_DATABASE_URL')).toBe(false);
    secretAbsent(await publicPersistedBytes(), password);
    const resource = await db.managedResource.findFirstOrThrow({
      where: { uid: provider.serviceUid },
    });
    await db.managedResource.update({ where: { id: resource.id }, data: { uid: randomUUID() } });
    await expect(
      db.$transaction(async (tx) =>
        assertDatabaseBindingSnapshots(
          tx,
          await lockService(tx, consumer.id),
          first.snapshot.databaseBindings,
        ),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DEPENDENCY_CHANGED' });
  });
  it('blocks provider removal for an unpublished detach until a new consumer publication replaces the original reference', async () => {
    const provider = await readyProvider();
    const consumer = await createConsumer();
    const saved = await databases.save(consumer.id, bindingInput(consumer, provider.database));
    const original = await publishConsumer(consumer.id);
    const removed = await databases.remove(
      consumer.id,
      saved.data[0]!.id,
      (await services.get(consumer.id)).revision,
    );
    expect(removed.data).toContainEqual(
      expect.objectContaining({ desired: false, published: true }),
    );
    const providerCurrent = await services.get(provider.service.id);
    await expect(
      services.action(
        provider.service.id,
        'delete',
        { revision: providerCurrent.revision },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'DATABASE_DEPENDENCY_IN_USE' });
    await expect(
      db.databaseInstance.update({
        where: { id: provider.database.id },
        data: { serviceId: null },
      }),
    ).rejects.toThrow();
    const unbound = await publishConsumer(consumer.id);
    expect(unbound.snapshot.databaseBindings).toEqual([]);
    expect(
      await db.deploymentDatabaseReference.count({ where: { deploymentId: original.task.id } }),
    ).toBe(1);
    expect((await databaseConsumers(db, provider.database.id)).consumers).toEqual([]);
    const deletion = await services.action(
      provider.service.id,
      'delete',
      { revision: providerCurrent.revision },
      actor,
      randomUUID(),
    );
    expect(deletion.kind).toBe('service_delete');
    expect(await db.volume.count({ where: { id: provider.database.dataVolume.id } })).toBe(1);
  });
  it.each(['overlap', 'binding_first', 'deletion_first'] as const)(
    'serializes provider deletion against binding admission (%s) so both cannot be accepted',
    async (schedule) => {
      const provider = await readyProvider();
      const consumer = await createConsumer();
      const bind = () => databases.save(consumer.id, bindingInput(consumer, provider.database));
      const providerCurrent = await services.get(provider.service.id);
      const remove = () =>
        services.action(
          provider.service.id,
          'delete',
          { revision: providerCurrent.revision },
          actor,
          randomUUID(),
        );
      let outcomes: PromiseSettledResult<unknown>[];
      if (schedule === 'overlap') outcomes = await Promise.allSettled([bind(), remove()]);
      else if (schedule === 'binding_first') {
        outcomes = [
          ...(await Promise.allSettled([bind()])),
          ...(await Promise.allSettled([remove()])),
        ];
      } else {
        const removed = await Promise.allSettled([remove()]);
        outcomes = [...(await Promise.allSettled([bind()])), ...removed];
      }
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const bindingWon = outcomes[0]!.status === 'fulfilled';
      expect(
        await db.databaseBinding.count({
          where: { databaseInstanceId: provider.database.id, desired: true },
        }),
      ).toBe(bindingWon ? 1 : 0);
      expect(
        await db.operation.count({
          where: { serviceId: provider.service.id, kind: 'service_delete' },
        }),
      ).toBe(bindingWon ? 0 : 1);
      const rejected = outcomes.find(
        (outcome) => outcome.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({
        code: bindingWon ? 'DATABASE_DEPENDENCY_IN_USE' : 'DATABASE_DEPENDENCY_NOT_READY',
      });
    },
  );
  it('retains the original database, volume, PVC and credential identity after its provider is deleted at the metadata boundary, and forbids reassigning it', async () => {
    const provider = await readyProvider();
    const before = await databases.get(provider.database.id);
    // Controlled facts represent a completed workload drain. Real K3s deletion is separate.
    await db.$transaction(async (tx) => {
      await lockVolume(tx, provider.database.dataVolume.id);
      await tx.volumeMount.updateMany({
        where: { serviceId: provider.service.id },
        data: { desired: false, detachedAt: new Date() },
      });
      await tx.service.delete({ where: { id: provider.service.id } });
    });
    const retained = await databases.get(provider.database.id);
    expect(retained.service).toBeNull();
    expect(retained.originalService).toEqual(before.originalService);
    expect(retained.dataVolume).toEqual(before.dataVolume);
    expect(retained.credential).toEqual(before.credential);
    expect(retained.initialization).toEqual(before.initialization);
    expect(retained.protection.active).toBe(true);
    expect(retained.databaseReady).toBe(false);
    const name = unique();
    const replacement = await db.service.create({
      data: {
        name,
        slug: name,
        environmentId: context.environment.id,
        kind: 'database',
        configJson: json(provider.service.configuration),
      },
    });
    await expect(
      db.databaseInstance.update({
        where: { id: retained.id },
        data: { serviceId: replacement.id },
      }),
    ).rejects.toThrow();
    expect((await databases.get(retained.id)).service).toBeNull();
    expect((await storage.get(before.dataVolume.id)).retainedDatabase).toMatchObject({
      id: retained.id,
    });
  });
  it('keeps a TCP-ready provider unavailable to consumers when authentication or Redis persistence evidence fails', async () => {
    const provider = await readyProvider('redis');
    const consumer = await createConsumer();
    await db.$transaction(async (tx) => {
      await lockVolume(tx, provider.database.dataVolume.id);
      await saveDatabaseVerification(tx, await lockService(tx, provider.service.id), {
        ...provider.verification,
        observedAt: new Date().toISOString(),
        redis: { aofEnabled: false, appendfsync: 'no', lastWriteStatus: 'ok' },
      });
    });
    expect((await services.get(provider.service.id)).runtimeState).toBe('running');
    expect((await databases.get(provider.database.id)).databaseReady).toBe(false);
    await expect(
      databases.save(consumer.id, bindingInput(consumer, provider.database)),
    ).rejects.toMatchObject({ code: 'DATABASE_DEPENDENCY_NOT_READY' });
    expect((await databases.get(provider.database.id)).protection.active).toBe(true);
  });
});
