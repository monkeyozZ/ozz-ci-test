import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../packages/database/dist/index.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import { ServiceCommands } from '../../packages/control-plane/src/services/commands.js';
import { ServiceExecutor } from '../../packages/control-plane/src/services/executor.js';
import { ServiceObserver } from '../../packages/control-plane/src/services/observer.js';
import type {
  DeploymentResult,
  ServiceConfigurationInput,
  ServiceSnapshot,
} from '../../packages/control-plane/src/services/contracts.js';
import {
  TaskRepository,
  type OperationActor,
} from '../../packages/control-plane/src/tasks/repository.js';
import {
  TaskExecutionError,
  type TaskRef,
} from '../../packages/control-plane/src/tasks/contracts.js';
import {
  KubernetesAdapterError,
  parseKubeconfig,
  type KubernetesConnectionInspector,
  type KubernetesInspection,
  type ParsedKubernetesConnection,
} from '../../packages/infrastructure/dist/kubernetes.js';
import {
  parseImageReference,
  RegistryAdapterError,
  type RegistryImageResolver,
  type ResolvedImage,
} from '../../packages/infrastructure/dist/registry.js';
import {
  WorkloadAdapterError,
  workloadNames,
  type KubernetesWorkloadManager,
  type ManagedWorkloadResource,
  type WorkloadObservation,
  type WorkloadResourceReceipt,
  type WorkloadRolloutTarget,
  type WorkloadTarget,
  type WorkloadWriteHooks,
} from '../../packages/infrastructure/dist/workload.js';

// These tests run production commands, executor checkpoints and observation
// fences against an isolated PostgreSQL schema. External adapters are controlled
// fixtures; this is not Kubernetes/registry protocol or real K3s acceptance.
// Queue/lease recovery is covered separately by tasks-s3.test.ts.
const execute = promisify(execFile);
const schema = `s3services_${randomUUID().replaceAll('-', '')}`;
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl) throw new Error('S3 service tests require PostgreSQL.');
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-service-integration-'));
const marker = 'synthetic-runtime-secret-not-for-responses';
const originalImage = 'registry.example.test/team/app:moving';
const updatedImage = 'registry.example.test/team/app:next';
const observers: ServiceObserver[] = [];
const registry = {
  resolve: vi.fn<RegistryImageResolver['resolve']>(),
  verify: vi.fn<RegistryImageResolver['verify']>(),
};
const workloads = {
  apply: vi.fn<KubernetesWorkloadManager['apply']>(),
  observe: vi.fn<KubernetesWorkloadManager['observe']>(),
  waitHealthy: vi.fn<KubernetesWorkloadManager['waitHealthy']>(),
  operate: vi.fn<KubernetesWorkloadManager['operate']>(),
};
const kubernetes = { inspect: vi.fn<KubernetesConnectionInspector['inspect']>() };
let db: PrismaClient;
let cipher: SecretCipher;
let repository: TaskRepository;
let commands: ServiceCommands;
let executor: ServiceExecutor;
let actor: OperationActor;
let certificate: string;
let fixture: Awaited<ReturnType<typeof createContext>>;
let sequence = 0;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function until<T>(
  sample: () => Promise<T>,
  accepted: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await sample();
    if (accepted(value)) return value;
    await delay(20);
  }
  throw new Error('Service condition did not settle within its deadline.');
}

async function createContext() {
  const suffix = ++sequence;
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
    users: [{ name: 'fixture', user: { token: 'synthetic-fixture-kubernetes-token' } }],
    contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
    'current-context': 'fixture',
  });
  const connection = parseKubeconfig(kubeconfig);
  const credential = await db.secretReference.create({
    data: {
      name: `Service fixture connection ${suffix}`,
      kind: 'kubeconfig',
      ...cipher.encrypt('kubeconfig', { kubeconfig }),
    },
  });
  const cluster = await db.cluster.create({
    data: {
      name: `Service fixture ${suffix}`,
      slug: `service-fixture-${suffix}`,
      kubeSystemUid: randomUUID(),
      caFingerprint: connection.caFingerprint,
      apiEndpoint: endpoint,
      credentialRefId: credential.id,
      connectionStatus: 'connected',
      lastObservedAt: new Date(),
    },
  });
  const project = await db.project.create({
    data: { clusterId: cluster.id, name: 'Application', slug: `application-${suffix}` },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: 'Production', slug: 'production' },
  });
  const staging = await db.environment.create({
    data: { projectId: project.id, name: 'Staging', slug: 'staging' },
  });
  return { cluster, project, environment, staging, credential };
}

function createService(
  configuration: ServiceConfigurationInput = { image: originalImage },
  context = fixture,
) {
  const suffix = ++sequence;
  return commands.create({
    environmentId: context.environment.id,
    projectId: context.project.id,
    name: `Service ${suffix}`,
    slug: `service-${suffix}`,
    configuration,
  });
}

function resolvedImage(inputReference: string): ResolvedImage {
  const parsed = parseImageReference(inputReference);
  const digest = 'sha256:' + createHash('sha256').update(inputReference).digest('hex');
  return {
    version: 1,
    inputReference,
    registry: parsed.registry,
    repository: parsed.repository,
    tag: parsed.tag,
    requestedDigest: parsed.digest,
    manifestDigest: digest,
    manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
    indexDigest: null,
    deployReference: `${parsed.registry}/${parsed.repository}@${digest}`,
    platformManifests: [
      {
        os: 'linux',
        architecture: 'arm64',
        manifestDigest: digest,
        manifestMediaType: 'application/vnd.oci.image.manifest.v1+json',
        configDigest: 'sha256:' + 'a'.repeat(64),
      },
    ],
    resolvedAt: new Date().toISOString(),
  };
}

function inspection(
  connection: ParsedKubernetesConnection,
  kubeSystemUid: string,
): KubernetesInspection {
  const metrics = { state: 'unknown' as const, errorCode: null, observedAt: null };
  const resources = {
    cpuCores: 2,
    memoryBytes: 4 * 1024 ** 3,
    ephemeralStorageBytes: null,
    pods: 110,
  };
  return {
    endpoint: connection.endpoint,
    version: 'v1.34.3+k3s1',
    identity: { kubeSystemUid, caFingerprint: connection.caFingerprint },
    credential: connection.credential,
    permissions: { clusterWideAdmin: false, checks: [] },
    nodes: [
      {
        uid: randomUUID(),
        name: 'fixture-node',
        resourceVersion: '1',
        createdAt: null,
        architecture: 'arm64',
        operatingSystem: 'linux',
        osImage: 'Fixture Linux',
        kubeletVersion: 'v1.34.3',
        containerRuntimeVersion: 'containerd://2',
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
    nodesResourceVersion: '1',
    metrics,
    capabilities: {
      ingress: { state: 'unknown', classes: [], errorCode: null },
      traefik: {
        state: 'unknown',
        namespace: 'kube-system',
        deployment: 'traefik',
        ready: null,
        desiredReplicas: null,
        readyReplicas: null,
        availableReplicas: null,
        errorCode: null,
      },
      storage: { state: 'unknown', classes: [], errorCode: null },
      metrics,
    },
    workloads: {
      state: 'unknown',
      items: [],
      collections: [],
      observedAt: new Date().toISOString(),
    },
    secretsEncryption: { state: 'unknown', evidence: 'not_available_via_standard_api' },
    observedAt: new Date().toISOString(),
  };
}

function observation(
  target: WorkloadTarget,
  published: WorkloadRolloutTarget | null,
  inventory: readonly ManagedWorkloadResource[] = [],
  replicas = published?.replicas ?? 0,
): WorkloadObservation {
  const metrics = {
    state: 'unknown' as const,
    cpuCores: null,
    memoryBytes: null,
    observedAt: null,
    windowSeconds: null,
  };
  return {
    observedAt: new Date().toISOString(),
    configurationState: 'consistent',
    drift: [],
    resources: inventory.map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      expectedUid: resource.uid,
      observedUid: resource.uid,
      resourceVersion: resource.resourceVersion,
      state: 'verified',
      reason: null,
    })),
    deployment: published
      ? {
          uid: published.deploymentUid,
          resourceVersion: '2',
          generation: published.generation,
          observedGeneration: published.generation,
          replicas,
          currentReplicas: replicas,
          updatedReplicas: replicas,
          readyReplicas: replicas,
          availableReplicas: replicas,
          snapshotId: published.snapshotId,
          configRevision: published.configRevision,
          mutationRevision: null,
          rolloutId: published.rolloutId,
          image: published.image,
          templateFingerprint: published.templateFingerprint,
          workloadFingerprint: published.workloadFingerprint,
          progressDeadlineExceeded: false,
          deleting: false,
        }
      : null,
    pods: published
      ? Array.from({ length: replicas }, (_, index) => ({
          uid: `fixture-pod-${index}`,
          name: `fixture-pod-${index}`,
          namespace: target.namespace,
          nodeName: 'fixture-node',
          createdAt: null,
          deletionTimestamp: null,
          phase: 'Running' as const,
          ready: true,
          snapshotId: published.snapshotId,
          configRevision: published.configRevision,
          rolloutId: published.rolloutId,
          replicaSetUid: 'fixture-replica-set',
          matchesDeploymentTemplate: true,
          containers: [
            {
              name: 'app',
              image: published.image,
              imageId: published.image,
              ready: true,
              restartCount: 0,
              state: 'running' as const,
              reason: null,
              lastTerminationReason: null,
              oomKilled: false,
              exitCode: null,
              requests: { cpuCores: 0.1, memoryBytes: 128 * 1024 ** 2 },
              limits: { cpuCores: 0.5, memoryBytes: 512 * 1024 ** 2 },
              metrics,
            },
          ],
        }))
      : [],
    podsTruncated: false,
    events: [],
    eventsState: 'available',
    eventsTruncated: false,
    metrics,
    metricsErrorCode: null,
    serviceDns: `${workloadNames(target).service}.${target.namespace}.svc.cluster.local`,
  };
}

async function writeReceipt(
  resource: ManagedWorkloadResource,
  mutationRevision: number,
  hooks: WorkloadWriteHooks,
): Promise<WorkloadResourceReceipt> {
  const namespaceUnchanged = resource.kind === 'Namespace' && Boolean(resource.uid);
  if (!namespaceUnchanged)
    await hooks.beforeWrite({
      action: resource.uid ? 'replace' : 'create',
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      creationNonce: resource.creationNonce,
      expectedUid: resource.uid,
      expectedResourceVersion: resource.resourceVersion,
      mutationRevision: resource.kind === 'Namespace' ? 0 : mutationRevision,
    });
  const receipt: WorkloadResourceReceipt = {
    action: namespaceUnchanged ? 'verified' : resource.uid ? 'replaced' : 'created',
    kind: resource.kind,
    name: resource.name,
    namespace: resource.namespace,
    creationNonce: resource.creationNonce,
    uid: resource.uid ?? randomUUID(),
    resourceVersion: String(mutationRevision + 1),
    generation: resource.kind === 'Deployment' ? mutationRevision : null,
    mutationRevision: resource.kind === 'Namespace' ? 0 : mutationRevision,
    specFingerprint: resource.kind === 'Secret' ? null : 'b'.repeat(64),
    observedAt: new Date().toISOString(),
  };
  await hooks.onReceipt(receipt);
  return receipt;
}

async function runTask(ref: TaskRef): Promise<TaskExecutionError | null> {
  const lease = await repository.claimTask(ref, 'service-integration-fixture');
  expect(lease).not.toBeNull();
  if (!lease) throw new Error('Expected a claimable service task');
  try {
    const outcome = await executor.execute(lease, new AbortController().signal);
    expect(await repository.complete(lease, outcome)).toBe(true);
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

async function publishService(serviceId: string) {
  const current = await commands.get(serviceId);
  const task = await commands.deploy(
    serviceId,
    { revision: current.revision },
    actor,
    randomUUID(),
  );
  expect(await runTask({ type: 'deployment', id: task.id })).toBeNull();
  return repository.getDeployment(task.id);
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
    { env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, timeout: 25000 },
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
      '/CN=ozz-service-fixture-ca',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { cwd: directory, timeout: 10000 },
  );
  chmodSync(join(directory, 'ca.key'), 0o600);
  certificate = readFileSync(join(directory, 'ca.pem'), 'utf8');
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
  const admin = await db.admin.create({
    data: { username: 'service-fixture', passwordHash: 'fixture-login-disabled' },
  });
  actor = { id: admin.id };
  repository = new TaskRepository(db, { leaseMs: 30_000 });
  commands = new ServiceCommands(repository, cipher);
  executor = new ServiceExecutor(repository, cipher, registry, workloads, kubernetes);
});

beforeEach(async () => {
  for (const call of [
    registry.resolve,
    registry.verify,
    workloads.apply,
    workloads.observe,
    workloads.waitHealthy,
    workloads.operate,
    kubernetes.inspect,
  ])
    call.mockReset();
  fixture = await createContext();
  registry.resolve.mockImplementation(async (image) => resolvedImage(image));
  registry.verify.mockImplementation(async (image) => ({
    ...image,
    verifiedAt: new Date().toISOString(),
  }));
  kubernetes.inspect.mockImplementation(async (connection, options) =>
    inspection(
      connection,
      options?.expectedIdentity?.kubeSystemUid ?? fixture.cluster.kubeSystemUid!,
    ),
  );
  workloads.apply.mockImplementation(async (_connection, plan, hooks) => {
    const resources: WorkloadResourceReceipt[] = [];
    for (const resource of plan.inventory)
      resources.push(await writeReceipt(resource, plan.mutationRevision, hooks));
    const deployment = resources.find((resource) => resource.kind === 'Deployment')!;
    return {
      state: 'complete',
      mutationRevision: plan.mutationRevision,
      resources,
      published: {
        snapshotId: plan.snapshotId,
        configRevision: plan.configRevision,
        image: plan.configuration.image,
        replicas: plan.configuration.replicas,
        deploymentUid: deployment.uid,
        templateFingerprint: 'c'.repeat(64),
        workloadFingerprint: 'd'.repeat(64),
        usesPullSecret: Boolean(plan.pullSecret),
        generation: plan.mutationRevision,
        rolloutId: plan.taskId,
      },
      serviceDns: `${workloadNames(plan.target).service}.${plan.target.namespace}.svc.cluster.local`,
      appliedAt: new Date().toISOString(),
    };
  });
  workloads.observe.mockImplementation(async (_connection, target, inventory) => {
    const service = await db.service.findUniqueOrThrow({
      where: { id: target.serviceId },
      include: { publishedDeployment: true },
    });
    const published =
      (service.publishedDeployment?.result as unknown as DeploymentResult | null)?.published ??
      null;
    return observation(
      target,
      published,
      inventory,
      service.desiredState === 'stopped' ? 0 : published?.replicas,
    );
  });
  workloads.waitHealthy.mockImplementation(async (_connection, target, expected, options) => {
    await options.checkpoint?.();
    const result = observation(target, expected, options.inventory);
    await options.onObservation?.(result);
    return result;
  });
  workloads.operate.mockImplementation(async (_connection, operation, hooks) => {
    const resources: WorkloadResourceReceipt[] = [];
    const deployment = operation.inventory.find((resource) => resource.kind === 'Deployment');
    if (deployment)
      resources.push(await writeReceipt(deployment, operation.mutationRevision, hooks));
    return {
      action: operation.action,
      mutationRevision: operation.mutationRevision,
      resources,
      rollout:
        (operation.action === 'restart' || operation.action === 'resume') && operation.published
          ? {
              ...operation.published,
              generation: operation.mutationRevision,
              rolloutId: operation.taskId,
            }
          : null,
      completedAt: new Date().toISOString(),
    };
  });
});

afterEach(async () => {
  for (const observer of observers.splice(0)) await observer.stop();
});

afterAll(async () => {
  for (const observer of observers.splice(0)) await observer.stop();
  if (db) {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('S3 service admission and business execution', () => {
  it('inherits the project cluster, rejects forged ownership, and only moves an unpublished service within its project', async () => {
    const other = await createContext();
    const base = {
      name: 'Ownership test',
      slug: 'ownership-test',
      environmentId: fixture.environment.id,
      configuration: { image: originalImage },
    };
    await expect(commands.create({ ...base, projectId: other.project.id })).rejects.toMatchObject({
      code: 'SERVICE_ENVIRONMENT_MISMATCH',
    });
    await expect(
      commands.create({ ...base, clusterId: other.cluster.id } as Parameters<
        ServiceCommands['create']
      >[0]),
    ).rejects.toMatchObject({ code: 'SERVICE_CONFIGURATION_INVALID' });
    const service = await createService();
    expect(service).toMatchObject({
      clusterId: fixture.cluster.id,
      projectId: fixture.project.id,
      environmentId: fixture.environment.id,
      runtimeState: 'unpublished',
    });
    await expect(
      commands.update(service.id, {
        revision: service.revision,
        environmentId: other.environment.id,
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_ENVIRONMENT_MISMATCH' });
    const moved = await commands.update(service.id, {
      revision: service.revision,
      environmentId: fixture.staging.id,
    });
    expect(moved.environmentId).toBe(fixture.staging.id);
    expect(moved.clusterId).toBe(fixture.cluster.id);
    await publishService(service.id);
    const published = await commands.get(service.id);
    await expect(
      commands.update(service.id, {
        revision: published.revision,
        environmentId: fixture.environment.id,
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_TARGET_LOCKED' });
    expect(workloads.apply.mock.calls[0]?.[1].target.namespace).toBe(
      workloadNames({ serviceId: service.id, environmentId: fixture.staging.id }).namespace,
    );
  });

  it('saves drafts without jobs or network and keeps an accepted deployment snapshot unchanged by later edits', async () => {
    const service = await createService();
    const edited = await commands.update(service.id, {
      revision: service.revision,
      configuration: { image: originalImage, replicas: 2 },
    });
    expect(edited).toMatchObject({
      configRevision: 2,
      mutationRevision: 0,
      hasUnpublishedChanges: true,
      published: null,
    });
    expect(await db.deployment.count({ where: { serviceId: service.id } })).toBe(0);
    expect(await db.operation.count({ where: { serviceId: service.id } })).toBe(0);
    expect(registry.resolve).not.toHaveBeenCalled();
    expect(workloads.apply).not.toHaveBeenCalled();
    const task = await commands.deploy(
      service.id,
      { revision: edited.revision },
      actor,
      randomUUID(),
    );
    const queued = await commands.get(service.id);
    const changedAgain = await commands.update(service.id, {
      revision: queued.revision,
      configuration: { image: updatedImage, replicas: 3 },
    });
    expect(changedAgain.configRevision).toBe(3);
    const stored = await repository.getDeployment(task.id);
    expect((stored.snapshotJson as unknown as ServiceSnapshot).configuration).toMatchObject({
      image: originalImage,
      replicas: 2,
    });
    expect(await runTask({ type: 'deployment', id: task.id })).toBeNull();
    expect(workloads.apply.mock.calls[0]?.[1].configuration).toMatchObject({
      image: resolvedImage(originalImage).deployReference,
      replicas: 2,
    });
    const view = await commands.get(service.id);
    expect(view.hasUnpublishedChanges).toBe(true);
    expect(view.published?.configRevision).toBe(2);
    expect(view.configuration.image).toBe(updatedImage);
  });

  it('shares one durable mutation slot per service while accepting other services in the same cluster', async () => {
    const one = await createService();
    const two = await createService();
    const key = randomUUID();
    const first = await commands.deploy(one.id, { revision: one.revision }, actor, key);
    expect((await commands.deploy(one.id, { revision: one.revision }, actor, key)).id).toBe(
      first.id,
    );
    const busy = await commands.get(one.id);
    expect(busy.activeTask).toMatchObject({ type: 'deployment', id: first.id });
    await expect(
      commands.action(one.id, 'stop', { revision: busy.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ status: 409, code: 'SERVICE_OPERATION_ACTIVE' });
    await expect(
      commands.deploy(one.id, { revision: busy.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ status: 409, code: 'SERVICE_OPERATION_ACTIVE' });
    const second = await commands.action(
      two.id,
      'stop',
      { revision: two.revision },
      actor,
      randomUUID(),
    );
    expect(await db.serviceMutation.count({ where: { serviceId: { in: [one.id, two.id] } } })).toBe(
      2,
    );
    expect((await db.operation.findUniqueOrThrow({ where: { id: second.id } })).clusterId).toBe(
      fixture.cluster.id,
    );
    expect(await runTask({ type: 'operation', id: second.id })).toBeNull();
    expect(workloads.operate).not.toHaveBeenCalled();
    expect((await commands.get(two.id)).desiredState).toBe('stopped');
  });

  it('rejects unverified targets at admission and prevents effects when live cluster inspection fails', async () => {
    const unverified = await createContext();
    await db.cluster.update({
      where: { id: unverified.cluster.id },
      data: { kubeSystemUid: null },
    });
    await expect(createService({ image: originalImage }, unverified)).rejects.toMatchObject({
      code: 'CLUSTER_NOT_CONNECTED',
    });
    const service = await createService();
    await db.cluster.update({ where: { id: fixture.cluster.id }, data: { apiEndpoint: null } });
    await expect(
      commands.deploy(service.id, { revision: service.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ code: 'CLUSTER_NOT_CONNECTED' });
    expect(await db.deployment.count({ where: { serviceId: service.id } })).toBe(0);
    await db.cluster.update({
      where: { id: fixture.cluster.id },
      data: { apiEndpoint: fixture.cluster.apiEndpoint },
    });
    kubernetes.inspect.mockRejectedValueOnce(new KubernetesAdapterError('KUBERNETES_UNREACHABLE'));
    const task = await commands.deploy(
      service.id,
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: task.id })).toMatchObject({
      code: 'KUBERNETES_UNREACHABLE',
    });
    expect(registry.resolve).not.toHaveBeenCalled();
    expect(workloads.apply).not.toHaveBeenCalled();
    expect((await commands.get(service.id)).published).toBeNull();
    expect(await db.managedResource.count({ where: { serviceId: service.id } })).toBe(0);
  });

  it('encrypts runtime secrets, pins their historical references, and only decrypts the accepted snapshot for the adapter', async () => {
    const service = await createService({
      image: originalImage,
      environment: [
        { name: 'API_TOKEN', value: marker, secret: true },
        { name: 'PUBLIC', value: 'visible' },
      ],
    });
    const secretId = service.configuration.environment[0]!.secretRefId!;
    expect(service.configuration.environment[0]).toEqual({
      name: 'API_TOKEN',
      secretRefId: secretId,
      secretKey: 'value',
    });
    expect(JSON.stringify(service)).not.toContain(marker);
    const encrypted = await db.secretReference.findUniqueOrThrow({ where: { id: secretId } });
    expect(Buffer.from(encrypted.encryptedPayload).toString('utf8')).not.toContain(marker);
    const task = await commands.deploy(
      service.id,
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    const accepted = await commands.get(service.id);
    const edited = await commands.update(service.id, {
      revision: accepted.revision,
      configuration: {
        image: updatedImage,
        environment: [{ name: 'API_TOKEN', value: marker + '-new', secret: true }],
      },
    });
    expect(edited.configuration.environment[0]?.secretRefId).not.toBe(secretId);
    expect(
      await db.serviceSecretReference.count({
        where: { serviceId: service.id, secretRefId: secretId },
      }),
    ).toBe(0);
    expect(
      await db.deploymentSecretReference.count({
        where: { deploymentId: task.id, secretRefId: secretId },
      }),
    ).toBe(1);
    await expect(db.secretReference.delete({ where: { id: secretId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await runTask({ type: 'deployment', id: task.id })).toBeNull();
    expect(workloads.apply.mock.calls[0]?.[1].configuration.environment).toContainEqual({
      name: 'API_TOKEN',
      value: marker,
    });
    const surfaces = [
      await commands.get(service.id),
      await commands.list({ projectId: fixture.project.id }),
      await repository.getDeployment(task.id),
      await repository.deploymentLogs(task.id),
      await db.deployment.findUniqueOrThrow({ where: { id: task.id } }),
      await db.outbox.findUnique({ where: { deploymentId: task.id } }),
      await db.auditEvent.findMany({ where: { resourceId: task.id } }),
    ];
    expect(JSON.stringify(surfaces)).not.toContain(marker);
    expect(cipher.decrypt(encrypted)).toEqual({ value: marker });
  });

  it('rejects a Windows-only target before resolving or applying a Linux image', async () => {
    const service = await createService();
    kubernetes.inspect.mockImplementationOnce(async (connection, options) => {
      const result = inspection(connection, options!.expectedIdentity!.kubeSystemUid);
      result.nodes = result.nodes.map((node) => ({
        ...node,
        operatingSystem: 'windows',
        architecture: 'amd64',
      }));
      return result;
    });
    const task = await commands.deploy(
      service.id,
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: task.id })).toMatchObject({
      code: 'TARGET_PLATFORM_UNAVAILABLE',
    });
    expect(registry.resolve).not.toHaveBeenCalled();
    expect(workloads.apply).not.toHaveBeenCalled();
    expect((await commands.get(service.id)).published).toBeNull();
  });

  it('rolls back newly encrypted secrets if reference expansion makes the stored configuration exceed 24 KiB', async () => {
    const longestName = 'V'.repeat(128);
    const valid = await createService({
      image: originalImage,
      environment: [{ name: longestName, value: marker, secret: true }],
    });
    expect(valid.configuration.environment[0]?.name).toBe(longestName);
    expect(valid.configuration.environment[0]?.secretRefId).toEqual(expect.any(String));
    expect(JSON.stringify(valid)).not.toContain(marker);
    const environment = Array.from({ length: 128 }, (_, index) => ({
      name: `KEY_${index}_`.padEnd(128, 'X'),
      value: '',
      secret: true,
    }));
    expect(jsonBytes({ image: originalImage, environment })).toBeLessThan(24 * 1024);
    const secretsBefore = await db.secretReference.count();
    await expect(createService({ image: originalImage, environment })).rejects.toMatchObject({
      code: 'SERVICE_CONFIGURATION_TOO_LARGE',
    });
    expect(await db.secretReference.count()).toBe(secretsBefore);
    expect(await db.service.count({ where: { environmentId: fixture.environment.id } })).toBe(1);
  });

  it('persists complete application before health failure and keeps the previous success separate', async () => {
    const service = await createService();
    const first = await publishService(service.id);
    const current = await commands.get(service.id);
    const edited = await commands.update(service.id, {
      revision: current.revision,
      configuration: { image: updatedImage },
    });
    workloads.waitHealthy.mockRejectedValueOnce(
      new WorkloadAdapterError('WORKLOAD_ROLLOUT_FAILED'),
    );
    const second = await commands.deploy(
      service.id,
      { revision: edited.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: second.id })).toMatchObject({
      code: 'WORKLOAD_ROLLOUT_FAILED',
    });
    const view = await commands.get(service.id);
    expect(view.published?.deploymentId).toBe(second.id);
    expect(view.published?.configuration.image).toBe(updatedImage);
    expect(view.lastSuccessfulDeploymentId).toBe(first.id);
    expect(view.hasUnpublishedChanges).toBe(false);
    expect(view.observation?.deployment?.snapshotId).toBe(first.id);
    expect(view.observationStale).toBe(true);
    expect(view.runtimeState).toBe('unknown');
    const failed = await db.deployment.findUniqueOrThrow({
      where: { id: second.id },
      include: { stages: true },
    });
    expect(failed.status).toBe('failed');
    expect(failed.appliedAt).not.toBeNull();
    expect(failed.stages.map(({ name, status }) => ({ name, status }))).toEqual(
      expect.arrayContaining([
        { name: 'resolving', status: 'succeeded' },
        { name: 'deploying', status: 'succeeded' },
        { name: 'waiting_healthy', status: 'failed' },
      ]),
    );
  });

  it('retains failed-attempt evidence after a later observer refreshes the live service cache', async () => {
    const service = await createService();
    const first = await publishService(service.id);
    const current = await commands.get(service.id);
    const edited = await commands.update(service.id, {
      revision: current.revision,
      configuration: { image: updatedImage },
    });
    workloads.waitHealthy.mockImplementationOnce(async (_connection, target, expected, options) => {
      const failed = observation(target, expected, options.inventory);
      failed.configurationState = 'drifted';
      Object.assign(failed.pods[0]!.containers[0]!, {
        ready: false,
        restartCount: 2,
        state: 'waiting',
        reason: 'CrashLoopBackOff',
        lastTerminationReason: 'OOMKilled',
        oomKilled: true,
        image: marker,
        imageId: marker,
      });
      failed.drift = [
        { kind: 'Deployment', name: workloadNames(target).deployment, reason: 'template_changed' },
      ];
      throw new WorkloadAdapterError(
        'WORKLOAD_CONFIGURATION_DRIFT',
        false,
        'may_have_changed',
        [],
        failed,
      );
    });
    const task = await commands.deploy(
      service.id,
      { revision: edited.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: task.id })).toMatchObject({
      code: 'WORKLOAD_CONFIGURATION_DRIFT',
    });
    const failed = await db.deployment.findUniqueOrThrow({ where: { id: task.id } });
    const recorded = failed.result as unknown as DeploymentResult;
    expect(recorded.failureObservation).toMatchObject({
      attempt: 1,
      errorCode: 'WORKLOAD_CONFIGURATION_DRIFT',
      configurationState: 'drifted',
      drift: [{ kind: 'Deployment', reason: 'template_changed' }],
      deployment: { snapshotId: task.id },
      truncated: { drift: false, resources: false, pods: false },
    });
    expect(recorded.published.snapshotId).toBe(task.id);
    expect(recorded.failureObservation?.pods[0]?.containers).toEqual([
      expect.objectContaining({
        oomKilled: true,
        lastTerminationReason: 'OOMKilled',
        restartCount: 2,
      }),
    ]);
    expect(recorded.failureObservation?.pods[0]?.containers?.[0]).not.toHaveProperty('image');
    expect(JSON.stringify(recorded.failureObservation)).not.toContain(marker);
    expect(recorded.failureObservation).not.toHaveProperty('events');
    const published = await commands.get(service.id);
    expect(published.published?.deploymentId).toBe(task.id);
    expect(published.lastSuccessfulDeploymentId).toBe(first.id);
    expect(published.observation?.configurationState).toBe('drifted');

    await db.service.updateMany({ data: { nextObservationAt: new Date(Date.now() + 3_600_000) } });
    await db.service.update({
      where: { id: service.id },
      data: { nextObservationAt: new Date(0) },
    });
    const observer = new ServiceObserver(repository, cipher, workloads);
    observers.push(observer);
    observer.start();
    await until(
      () => commands.get(service.id),
      (value) => value.observation?.configurationState === 'consistent',
    );
    await observer.stop();
    const after = await db.deployment.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('failed');
    expect(after.result).toEqual(failed.result);
    expect((await commands.get(service.id)).observation?.drift).toEqual([]);
    const publicTask = await repository.getDeployment(task.id);
    expect(publicTask.failureObservation).toEqual(recorded.failureObservation);
    expect(publicTask.result).not.toHaveProperty('failureObservation');
    expect(publicTask.result).toMatchObject({ published: { snapshotId: task.id } });
  });

  it('exposes failure evidence without inventing an applied result when resource application never completed', async () => {
    const service = await createService();
    workloads.apply.mockImplementationOnce(async (_connection, plan) => {
      const failed = observation(plan.target, null, plan.inventory);
      failed.configurationState = 'drifted';
      failed.drift = [
        { kind: 'Service', name: workloadNames(plan.target).service, reason: 'untracked_resource' },
      ];
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT', false, 'none', [], failed);
    });
    const task = await commands.deploy(
      service.id,
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: task.id })).toMatchObject({
      code: 'WORKLOAD_CONFIGURATION_DRIFT',
    });
    const publicTask = await repository.getDeployment(task.id);
    expect(publicTask.result).toBeNull();
    expect(publicTask.appliedAt).toBeNull();
    expect(publicTask.failureObservation).toMatchObject({
      attempt: 1,
      errorCode: 'WORKLOAD_CONFIGURATION_DRIFT',
      deployment: null,
      drift: [{ kind: 'Service', reason: 'untracked_resource' }],
    });
    const after = await commands.get(service.id);
    expect(after.published).toBeNull();
    expect(after.lastSuccessfulDeploymentId).toBeNull();
  });

  it('stops without changing configured replicas and resumes the published version while leaving draft changes unpublished', async () => {
    const service = await createService({ image: originalImage, replicas: 2 });
    const published = await publishService(service.id);
    const prior = await commands.get(service.id);
    const draft = await commands.update(service.id, {
      revision: prior.revision,
      configuration: { image: updatedImage, replicas: 4 },
    });
    const stop = await commands.action(
      service.id,
      'stop',
      { revision: draft.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'operation', id: stop.id })).toBeNull();
    const stopped = await commands.get(service.id);
    expect(stopped).toMatchObject({
      desiredState: 'stopped',
      runtimeState: 'stopped',
      hasUnpublishedChanges: true,
    });
    expect(stopped.configuration.replicas).toBe(4);
    expect(stopped.published?.configuration.replicas).toBe(2);
    await expect(
      commands.deploy(service.id, { revision: stopped.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ code: 'DEPLOY_AND_START_REQUIRED' });
    const resume = await commands.action(
      service.id,
      'resume',
      { revision: stopped.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'operation', id: resume.id })).toBeNull();
    const resumedInput = workloads.operate.mock.calls.find(
      ([, operation]) => operation.action === 'resume',
    )?.[1];
    expect(resumedInput?.published).toMatchObject({
      snapshotId: published.id,
      replicas: 2,
      image: resolvedImage(originalImage).deployReference,
    });
    expect(resumedInput).not.toHaveProperty('configuration');
    expect(registry.resolve).toHaveBeenCalledTimes(1);
    const resumed = await commands.get(service.id);
    expect(resumed).toMatchObject({ desiredState: 'running', hasUnpublishedChanges: true });
    expect(resumed.published?.deploymentId).toBe(published.id);
    const stopAgain = await commands.action(
      service.id,
      'stop',
      { revision: resumed.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'operation', id: stopAgain.id })).toBeNull();
    const latest = await commands.get(service.id);
    const explicitlyStarted = await commands.deploy(
      service.id,
      { revision: latest.revision, deployAndStart: true },
      actor,
      randomUUID(),
    );
    expect(
      (explicitlyStarted.snapshotJson as unknown as ServiceSnapshot).configuration,
    ).toMatchObject({ image: updatedImage, replicas: 4 });
    expect((await commands.get(service.id)).desiredState).toBe('running');
  });

  it('requires a full repair confirmation for partial state, rejects resume/restart, and still permits stop', async () => {
    const ports = [
      { name: 'http', protocol: 'http' as const, containerPort: 8080, servicePort: 80 },
    ];
    const service = await createService({ image: originalImage, ports });
    const baseline = await publishService(service.id);
    const draft = await commands.update(service.id, {
      revision: (await commands.get(service.id)).revision,
      configuration: { image: updatedImage, ports },
    });
    let afterServiceReceipt: string | undefined;
    workloads.apply.mockImplementationOnce(async (_connection, plan, hooks) => {
      const receipts: WorkloadResourceReceipt[] = [];
      for (const resource of plan.inventory.filter((item) => item.kind !== 'Deployment'))
        receipts.push(await writeReceipt(resource, plan.mutationRevision, hooks));
      afterServiceReceipt = (await commands.get(service.id)).configurationState;
      const controller = plan.inventory.find((item) => item.kind === 'Deployment')!;
      await hooks.beforeWrite({
        action: 'replace',
        kind: controller.kind,
        name: controller.name,
        namespace: controller.namespace,
        creationNonce: controller.creationNonce,
        expectedUid: controller.uid,
        expectedResourceVersion: controller.resourceVersion,
        mutationRevision: plan.mutationRevision,
      });
      // Admission denies this UPDATE after earlier Secret/Service receipts.
      // The last unresolved write must not erase those confirmed partial effects.
      throw new WorkloadAdapterError('KUBERNETES_FORBIDDEN', false, 'may_have_changed', receipts);
    });
    const partial = await commands.deploy(
      service.id,
      { revision: draft.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: partial.id })).toMatchObject({
      code: 'KUBERNETES_FORBIDDEN',
    });
    expect(afterServiceReceipt).toBe('partial');
    const current = await commands.get(service.id);
    expect(current.configurationState).toBe('partial');
    expect(current.published?.deploymentId).toBe(baseline.id);
    expect((await repository.getDeployment(partial.id)).appliedAt).toBeNull();
    for (const action of ['resume', 'restart'] as const)
      await expect(
        commands.action(service.id, action, { revision: current.revision }, actor, randomUUID()),
      ).rejects.toMatchObject({ code: 'PUBLISHED_CONFIGURATION_REQUIRED' });
    await expect(
      commands.deploy(service.id, { revision: current.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_REPAIR_REQUIRED' });
    const stop = await commands.action(
      service.id,
      'stop',
      { revision: current.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'operation', id: stop.id })).toBeNull();
    const stopped = await commands.get(service.id);
    expect(stopped.configurationState).toBe('partial');
    const repair = await commands.deploy(
      service.id,
      { revision: stopped.revision, deployAndStart: true, allowConfigurationRepair: true },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: repair.id })).toBeNull();
    expect((await commands.get(service.id)).configurationState).toBe('consistent');
  });

  it('retries the original immutable image and configuration instead of re-resolving a moving tag or the current draft', async () => {
    const service = await createService();
    workloads.waitHealthy.mockRejectedValueOnce(
      new WorkloadAdapterError('WORKLOAD_ROLLOUT_FAILED'),
    );
    const original = await commands.deploy(
      service.id,
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: original.id })).toMatchObject({
      code: 'WORKLOAD_ROLLOUT_FAILED',
    });
    const failed = await repository.getDeployment(original.id);
    const view = await commands.get(service.id);
    const draft = await commands.update(service.id, {
      revision: view.revision,
      configuration: { image: updatedImage, replicas: 3 },
    });
    registry.resolve.mockImplementation(async () => resolvedImage(updatedImage));
    const retry = await commands.retryDeployment(
      original.id,
      { revision: draft.revision },
      actor,
      randomUUID(),
    );
    expect(retry.retryOfId).toBe(original.id);
    expect(retry.resolvedImageJson).toEqual(failed.resolvedImageJson);
    expect((retry.snapshotJson as unknown as ServiceSnapshot).configuration.image).toBe(
      originalImage,
    );
    expect(await runTask({ type: 'deployment', id: retry.id })).toBeNull();
    expect(registry.resolve).toHaveBeenCalledTimes(1);
    expect(registry.verify).toHaveBeenCalledTimes(1);
    expect(registry.verify.mock.calls[0]?.[0]).toEqual(failed.resolvedImageJson);
    expect(workloads.apply.mock.calls.at(-1)?.[1].configuration).toMatchObject({
      image: resolvedImage(originalImage).deployReference,
      replicas: 1,
    });
    expect((await commands.get(service.id)).hasUnpublishedChanges).toBe(true);
  });

  it('rejects an old retry after a later mutation and can delete a never-published service without contacting adapters', async () => {
    const service = await createService();
    registry.resolve.mockRejectedValueOnce(new RegistryAdapterError('REGISTRY_IMAGE_NOT_FOUND'));
    const failed = await commands.deploy(
      service.id,
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'deployment', id: failed.id })).toMatchObject({
      code: 'REGISTRY_IMAGE_NOT_FOUND',
    });
    const current = await commands.get(service.id);
    const stop = await commands.action(
      service.id,
      'stop',
      { revision: current.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'operation', id: stop.id })).toBeNull();
    const stopped = await commands.get(service.id);
    await expect(
      commands.retryDeployment(
        failed.id,
        { revision: stopped.revision, deployAndStart: true },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_TASK_SUPERSEDED' });
    const remove = await commands.action(
      service.id,
      'delete',
      { revision: stopped.revision },
      actor,
      randomUUID(),
    );
    expect(await runTask({ type: 'operation', id: remove.id })).toBeNull();
    expect(await db.service.findUnique({ where: { id: service.id } })).toBeNull();
    expect(await db.serviceMutation.count({ where: { serviceId: service.id } })).toBe(0);
    expect((await repository.get(remove.id)).status).toBe('succeeded');
    expect(workloads.apply).not.toHaveBeenCalled();
    expect(workloads.operate).not.toHaveBeenCalled();
  });

  it('does not redirect an accepted task after the registered cluster identity changes', async () => {
    const service = await createService();
    const task = await commands.deploy(
      service.id,
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    await db.cluster.update({
      where: { id: fixture.cluster.id },
      data: { kubeSystemUid: randomUUID() },
    });
    expect(await runTask({ type: 'deployment', id: task.id })).toMatchObject({
      code: 'SERVICE_TARGET_CHANGED',
    });
    expect(kubernetes.inspect).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();
    expect(workloads.apply).not.toHaveBeenCalled();
    expect((await commands.get(service.id)).published).toBeNull();
  });
});

describe('S3 service observation boundaries', () => {
  it('bounds a stalled read, retains its prior evidence and frees the observation lease', async () => {
    const service = await createService();
    const published = await publishService(service.id);
    const before = await commands.get(service.id);
    await db.service.update({
      where: { id: service.id },
      data: { nextObservationAt: new Date(0) },
    });
    workloads.observe.mockImplementationOnce(
      async (_connection, _target, _inventory, options) =>
        new Promise<WorkloadObservation>((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => reject(new WorkloadAdapterError('KUBERNETES_CANCELLED')),
            { once: true },
          );
        }),
    );
    const observer = new ServiceObserver(repository, cipher, workloads, { readTimeoutMs: 100 });
    observers.push(observer);
    observer.start();
    const failed = await until(
      () => db.service.findUniqueOrThrow({ where: { id: service.id } }),
      (row) => row.observationErrorCode === 'SERVICE_OBSERVATION_TIMEOUT',
    );
    await observer.stop();
    expect(failed).toMatchObject({
      observationLeaseToken: null,
      observationLeaseExpiresAt: null,
      observationFailures: 1,
    });
    const after = await commands.get(service.id);
    expect(after.observation).toEqual(before.observation);
    expect(after).toMatchObject({
      observationStale: true,
      runtimeState: 'unknown',
      desiredState: before.desiredState,
    });
    expect(after.published?.deploymentId).toBe(published.id);
    expect((await repository.getDeployment(published.id)).status).toBe('succeeded');
  });

  it('releases shutdown reads without manufacturing a resource or database failure', async () => {
    const service = await createService();
    await publishService(service.id);
    const before = await commands.get(service.id);
    await db.service.update({
      where: { id: service.id },
      data: { nextObservationAt: new Date(0) },
    });
    let reading = false;
    workloads.observe.mockImplementationOnce(
      async (_connection, _target, _inventory, options) =>
        new Promise<WorkloadObservation>((_resolve, reject) => {
          reading = true;
          options!.signal!.addEventListener(
            'abort',
            () => reject(new WorkloadAdapterError('KUBERNETES_CANCELLED')),
            { once: true },
          );
        }),
    );
    const observer = new ServiceObserver(repository, cipher, workloads);
    observers.push(observer);
    observer.start();
    await until(async () => reading, Boolean);
    await observer.stop();
    expect(await db.service.findUniqueOrThrow({ where: { id: service.id } })).toMatchObject({
      observationErrorCode: null,
      observationFailures: 0,
      observationLeaseToken: null,
      observationLeaseExpiresAt: null,
    });
    expect((await commands.get(service.id)).observation).toEqual(before.observation);
  });

  it('preserves the last observation on failure, reports unknown metrics and recovers without rewriting deployment history', async () => {
    const service = await createService();
    const published = await publishService(service.id);
    const before = await commands.get(service.id);
    await db.service.updateMany({ data: { nextObservationAt: new Date(Date.now() + 3_600_000) } });
    await db.service.update({
      where: { id: service.id },
      data: { nextObservationAt: new Date(0) },
    });
    workloads.observe.mockRejectedValueOnce(new WorkloadAdapterError('KUBERNETES_UNREACHABLE'));
    const observer = new ServiceObserver(repository, cipher, workloads);
    observers.push(observer);
    observer.start();
    await until(
      () => db.service.findUniqueOrThrow({ where: { id: service.id } }),
      (row) => row.observationErrorCode === 'KUBERNETES_UNREACHABLE',
    );
    const failed = await commands.get(service.id);
    expect(failed.observation).toEqual(before.observation);
    expect(failed).toMatchObject({ observationStale: true, runtimeState: 'unknown' });
    expect(failed.observation?.metrics).toMatchObject({
      state: 'unknown',
      cpuCores: null,
      memoryBytes: null,
    });
    await db.service.update({
      where: { id: service.id },
      data: { nextObservationAt: new Date(0) },
    });
    await until(
      () => commands.get(service.id),
      (view) => !view.observationStale && view.runtimeState === 'running',
    );
    const recovered = await commands.get(service.id);
    expect(recovered.published?.deploymentId).toBe(published.id);
    expect(recovered.lastSuccessfulDeploymentId).toBe(published.id);
    expect(recovered.desiredState).toBe(before.desiredState);
    expect((await repository.getDeployment(published.id)).status).toBe('succeeded');
  });

  it('discards a delayed observation when a new service mutation takes ownership', async () => {
    const service = await createService();
    await publishService(service.id);
    const before = await commands.get(service.id);
    await db.service.updateMany({ data: { nextObservationAt: new Date(Date.now() + 3_600_000) } });
    await db.service.update({
      where: { id: service.id },
      data: { nextObservationAt: new Date(0) },
    });
    let deliver: ((value: WorkloadObservation) => void) | undefined;
    workloads.observe.mockImplementationOnce(
      async () =>
        new Promise<WorkloadObservation>((resolve) => {
          deliver = resolve;
        }),
    );
    const observer = new ServiceObserver(repository, cipher, workloads);
    // Await the entire background read, not just the adapter promise, so shutdown
    // cancellation cannot accidentally make a missing mutation fence pass.
    const completedRead = vi.spyOn(
      observer as unknown as { observe(...args: unknown[]): Promise<void> },
      'observe',
    );
    observers.push(observer);
    observer.start();
    await until(async () => Boolean(deliver), Boolean);
    try {
      const stop = await commands.action(
        service.id,
        'stop',
        { revision: before.revision },
        actor,
        randomUUID(),
      );
      deliver!({
        ...before.observation!,
        observedAt: new Date().toISOString(),
        configurationState: 'drifted',
      });
      await completedRead.mock.results[0]!.value;
      await observer.stop();
      const after = await commands.get(service.id);
      expect(after.observation).toEqual(before.observation);
      expect(after.configurationState).toBe('consistent');
      expect(after.activeTask?.id).toBe(stop.id);
      expect(after.desiredState).toBe('stopped');
    } finally {
      deliver?.(before.observation!);
      completedRead.mockRestore();
    }
  });
});
