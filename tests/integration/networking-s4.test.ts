import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient, type Prisma } from '../../packages/database/dist/index.js';
import { NetworkingCommands } from '../../packages/control-plane/src/networking/commands.js';
import { NETWORK_OBSERVATION_STALE_MS } from '../../packages/control-plane/src/networking/contracts.js';
import { NetworkingExecutor } from '../../packages/control-plane/src/networking/executor.js';
import { DomainObserver } from '../../packages/control-plane/src/networking/observer.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import { ServiceCommands } from '../../packages/control-plane/src/services/commands.js';
import { ServiceExecutor } from '../../packages/control-plane/src/services/executor.js';
import type {
  ServiceConfigurationInput,
  ServiceTarget,
} from '../../packages/control-plane/src/services/contracts.js';
import {
  TaskExecutionError,
  domainOperationInput,
} from '../../packages/control-plane/src/tasks/contracts.js';
import {
  TaskRepository,
  type OperationActor,
} from '../../packages/control-plane/src/tasks/repository.js';
import {
  parseKubeconfig,
  type KubernetesConnectionInspector,
} from '../../packages/infrastructure/dist/kubernetes.js';
import type { RegistryImageResolver } from '../../packages/infrastructure/dist/registry.js';
import type {
  KubernetesWorkloadManager,
  WorkloadResourceReceipt,
} from '../../packages/infrastructure/dist/workload.js';
import {
  NetworkingAdapterError,
  type DomainDnsInspector,
  type KubernetesNetworkingManager,
  type ManagedNetworkResource,
  type NetworkDomainObservation,
  type NetworkDomainPlan,
  type NetworkDomainReceipt,
  type NetworkResourceDescriptor,
  type NetworkResourceReceipt,
  type NetworkWriteHooks,
  type NetworkWriteIntent,
} from '../../packages/infrastructure/dist/networking.js';

// Production admission, task fencing, resource ledger and cleanup run against an
// isolated PostgreSQL schema. DNS and Kubernetes effects are controlled fixtures.
// Published S3 state is seeded from real deployment admission snapshots; these
// tests are neither S3 publication coverage nor real DNS/ACME/K3s acceptance.
const execute = promisify(execFile);
const schema = `s4networking_${randomUUID().replaceAll('-', '')}`;
if (!process.env.DATABASE_URL) throw new Error('S4 networking tests require PostgreSQL.');
const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-networking-integration-'));
const platformInput = { appsDomainSuffix: 'apps.example.test', acmeEmail: 'acme@example.test' };
const httpPort = { name: 'web', protocol: 'http' as const, containerPort: 8080, servicePort: 80 };
const remote = new Map<string, NetworkResourceReceipt>();
const remoteWrites: NetworkWriteIntent[] = [];
const effects: string[] = [];
const observers = new Set<DomainObserver>();
const manager = {
  inspect: vi.fn<KubernetesNetworkingManager['inspect']>(),
  installCertManager: vi.fn<KubernetesNetworkingManager['installCertManager']>(),
  apply: vi.fn<KubernetesNetworkingManager['apply']>(),
  observe: vi.fn<KubernetesNetworkingManager['observe']>(),
  remove: vi.fn<KubernetesNetworkingManager['remove']>(),
};
const dns = { inspect: vi.fn<DomainDnsInspector['inspect']>() };
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
const beforeServiceDelete = vi.fn<NetworkingExecutor['beforeServiceDelete']>();
let db: PrismaClient;
let cipher: SecretCipher;
let repository: TaskRepository;
let commands: NetworkingCommands;
let services: ServiceCommands;
let executor: NetworkingExecutor;
let serviceExecutor: ServiceExecutor;
let actor: OperationActor;
let certificate: string;
let fixture: Awaited<ReturnType<typeof createContext>>;
let sequence = 0;
let remoteVersion = 0;

function fixtureJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function startObserver() {
  const observer = new DomainObserver(repository, cipher, manager, dns);
  observers.add(observer);
  observer.start();
  return observer;
}

async function stopObserver(observer: DomainObserver) {
  await observer.stop();
  observers.delete(observer);
}

async function observeSoon(domainId: string) {
  await db.domain.update({
    where: { id: domainId },
    data: { nextObservationAt: new Date(0) },
  });
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
    users: [{ name: 'fixture', user: { token: 'synthetic-networking-fixture-token' } }],
    contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
    'current-context': 'fixture',
  });
  const connection = parseKubeconfig(kubeconfig);
  const credential = await db.secretReference.create({
    data: {
      name: `Network fixture connection ${suffix}`,
      kind: 'kubeconfig',
      ...cipher.encrypt('kubeconfig', { kubeconfig }),
    },
  });
  const cluster = await db.cluster.create({
    data: {
      name: `Network fixture ${suffix}`,
      slug: `network-fixture-${suffix}`,
      kubeSystemUid: randomUUID(),
      caFingerprint: connection.caFingerprint,
      apiEndpoint: endpoint,
      credentialRefId: credential.id,
      connectionStatus: 'connected',
      lastObservedAt: new Date(),
    },
  });
  const project = await db.project.create({
    data: {
      clusterId: cluster.id,
      name: 'Network application',
      slug: `network-application-${suffix}`,
    },
  });
  const environment = await db.environment.create({
    data: {
      projectId: project.id,
      name: 'Production',
      slug: 'production',
    },
  });
  return { cluster, project, environment, credential };
}

async function configure(context = fixture) {
  const settings = await commands.platformSettings();
  if (!settings.revision) await commands.updatePlatformSettings({ revision: 0, ...platformInput });
  return commands.updateClusterNetworking(context.cluster.id, {
    revision: 0,
    subdomain: context.cluster.slug,
    entryAddresses: ['192.0.2.42'],
    cnameTarget: null,
  });
}

function createService(
  configuration: ServiceConfigurationInput = {
    image: 'registry.example.test/team/app:fixture',
    ports: [httpPort],
  },
) {
  const suffix = ++sequence;
  return services.create({
    environmentId: fixture.environment.id,
    projectId: fixture.project.id,
    name: `Network service ${suffix}`,
    slug: `network-service-${suffix}`,
    configuration,
  });
}

async function publishFixtureService(serviceId: string) {
  const current = await services.get(serviceId);
  const publication = await services.deploy(
    serviceId,
    { revision: current.revision },
    actor,
    randomUUID(),
  );
  const stored = await db.deployment.findUniqueOrThrow({ where: { id: publication.id } });
  const target = stored.targetJson as unknown as ServiceTarget;
  const serviceUid = randomUUID();
  const lease = await repository.claimTask(
    { type: 'deployment', id: publication.id },
    'network-publication-fixture',
  );
  if (!lease) throw new Error('Expected claimable fixture publication');
  expect(
    await repository.complete(lease, {
      result: { fixture: 'published-s3-snapshot' },
      commit: async (tx) => {
        await tx.deployment.update({
          where: { id: publication.id },
          data: { appliedAt: new Date() },
        });
        await tx.service.update({
          where: { id: serviceId },
          data: {
            publishedDeploymentId: publication.id,
            lastSuccessfulDeploymentId: publication.id,
            configurationState: 'consistent',
            remoteCreatedAt: new Date(),
          },
        });
        const identity = {
          clusterId: target.clusterId,
          kind: 'Service',
          namespace: target.namespace,
          name: target.serviceName,
        };
        await tx.managedResource.upsert({
          where: { clusterId_kind_namespace_name: identity },
          create: {
            ...identity,
            environmentId: target.environmentId,
            serviceId,
            targetJson: stored.targetJson!,
            creationAttempted: true,
            uid: serviceUid,
            resourceVersion: '1',
            mutationRevision: stored.mutationRevision,
          },
          update: {
            uid: serviceUid,
            resourceVersion: '1',
            mutationRevision: stored.mutationRevision,
          },
        });
      },
    }),
  ).toBe(true);
  return services.get(serviceId);
}

async function publishedService() {
  const service = await createService();
  return publishFixtureService(service.id);
}

async function bind(serviceId: string) {
  const view = await commands.serviceNetworking(serviceId);
  const port = view.eligiblePorts[0];
  if (!port) throw new Error('Expected a published HTTP port');
  return commands.bind(
    serviceId,
    { revision: view.serviceRevision, portId: port.id },
    actor,
    randomUUID(),
  );
}

async function boundService() {
  await configure();
  const service = await publishedService();
  const task = await bind(service.id);
  expect(await runOperation(task.id)).toBeNull();
  return {
    service: await services.get(service.id),
    task,
    domain: await commands.get(domainOperationInput(task.input).domainId),
  };
}

function resourceKey(resource: NetworkResourceDescriptor) {
  return `${resource.kind}/${resource.namespace}/${resource.name}`;
}

function descriptors(plan: NetworkDomainPlan): NetworkResourceDescriptor[] {
  const namespace = plan.target.namespace;
  const suffix = plan.target.domainId.replaceAll('-', '').slice(0, 16);
  const environment = plan.certificateEnvironment;
  return [
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Issuer',
      namespace,
      name: `ozz-${environment}-issuer`,
      role: 'issuer',
      scope: 'environment',
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      namespace,
      name: `ozz-${environment}-account`,
      role: 'acme-account',
      scope: 'environment',
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      namespace,
      name: `route-${suffix}`,
      role: 'route',
      scope: 'domain',
    },
    {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      namespace,
      name: `certificate-${suffix}`,
      role: 'certificate',
      scope: 'domain',
    },
    {
      apiVersion: 'v1',
      kind: 'Secret',
      namespace,
      name: `tls-${suffix}`,
      role: 'tls-secret',
      scope: 'domain',
    },
  ];
}

function networkObservation(plan: NetworkDomainPlan, removed = false): NetworkDomainObservation {
  const resources = descriptors(plan);
  const route = resources.find((item) => item.kind === 'Ingress')!;
  const cert = resources.find((item) => item.kind === 'Certificate')!;
  const issuer = resources.find((item) => item.kind === 'Issuer')!;
  const routePresent = remote.has(resourceKey(route));
  const certificatePresent = remote.has(resourceKey(cert));
  const observedAt = new Date().toISOString();
  return {
    route: {
      state: removed ? 'removed' : routePresent ? 'ready' : 'missing',
      observedAt,
      ingressNames: routePresent ? [route.name] : [],
      backendServiceName: plan.target.serviceName,
      portName: plan.target.portName,
      readyEndpoints: routePresent ? 1 : 0,
      code: null,
      message: 'Controlled route observation.',
    },
    certificate: {
      state: removed
        ? 'removed'
        : !certificatePresent
          ? 'missing'
          : plan.certificateEnvironment === 'staging'
            ? 'staging_ready'
            : 'ready',
      observedAt,
      authority: 'local_test',
      environment: plan.certificateEnvironment,
      certificateName: cert.name,
      issuerName: issuer.name,
      notBefore: certificatePresent ? new Date(Date.now() - 60_000).toISOString() : null,
      notAfter: certificatePresent ? new Date(Date.now() + 86_400_000).toISOString() : null,
      renewalTime: null,
      code: null,
      message: 'Controlled certificate observation.',
    },
  };
}

function observedResources(plan: NetworkDomainPlan): NetworkDomainObservation {
  return {
    ...networkObservation(plan),
    verifiedResources: plan.inventory.flatMap((resource) => {
      const receipt = remote.get(resourceKey(resource));
      return receipt
        ? [{ ...receipt, action: 'verified' as const, observedAt: new Date().toISOString() }]
        : [];
    }),
  };
}

function domainReceipt(
  plan: NetworkDomainPlan,
  resources: NetworkResourceReceipt[],
  removed = false,
): NetworkDomainReceipt {
  return { ...networkObservation(plan, removed), resources, completedAt: new Date().toISOString() };
}

async function writeResource(
  plan: NetworkDomainPlan,
  descriptor: NetworkResourceDescriptor,
  hooks: NetworkWriteHooks,
  afterRemoteWrite?: (receipt: NetworkResourceReceipt) => Promise<void>,
) {
  let resource = await hooks.reserve(descriptor);
  const existing = remote.get(resourceKey(resource));
  if (
    existing &&
    (existing.creationNonce !== resource.creationNonce ||
      (resource.uid ? existing.uid !== resource.uid : !resource.creationAttempted))
  )
    throw new NetworkingAdapterError(
      'FIXTURE_REMOTE_IDENTITY_MISMATCH',
      'Controlled remote identity changed.',
    );
  if (!existing && resource.uid)
    throw new NetworkingAdapterError(
      'FIXTURE_REMOTE_RESOURCE_MISSING',
      'A previously confirmed fixture resource is missing.',
    );
  if (existing && !resource.uid) {
    // A named read can recover an attempted create whose response was lost.
    // The real ledger still decides whether the nonce, UID and revision are valid.
    await hooks.onReceipt({
      ...existing,
      action: 'verified',
      observedAt: new Date().toISOString(),
    });
    resource = { ...resource, ...existing };
  }
  const revision = resource.scope === 'environment' ? plan.platformRevision : plan.revision;
  const intent: NetworkWriteIntent = {
    ...descriptor,
    action: resource.uid ? 'replace' : 'create',
    creationNonce: resource.creationNonce,
    expectedUid: resource.uid,
    expectedResourceVersion: resource.resourceVersion,
    revision,
  };
  await hooks.beforeWrite(intent);
  remoteWrites.push(intent);
  effects.push(`network-${intent.action}`);
  const receipt: NetworkResourceReceipt = {
    ...descriptor,
    action: resource.uid ? 'replaced' : 'created',
    creationNonce: resource.creationNonce,
    uid: resource.uid ?? randomUUID(),
    resourceVersion: String(++remoteVersion),
    revision,
    specFingerprint: 'a'.repeat(64),
    observedAt: new Date().toISOString(),
  };
  remote.set(resourceKey(resource), receipt);
  await afterRemoteWrite?.(receipt);
  await hooks.onReceipt(receipt);
  return receipt;
}

async function deleteResource(
  plan: NetworkDomainPlan,
  resource: ManagedNetworkResource,
  hooks: NetworkWriteHooks,
  afterRemoteWrite?: (receipt: NetworkResourceReceipt) => Promise<void>,
) {
  const existing = remote.get(resourceKey(resource));
  if (!existing) {
    // The named read found no object after a possibly successful earlier DELETE.
    // It must not issue another DELETE or forget the original trusted identity.
    const receipt: NetworkResourceReceipt = {
      ...resource,
      action: 'deleted',
      revision: plan.revision,
      observedAt: new Date().toISOString(),
    };
    await hooks.onReceipt(receipt);
    return receipt;
  }
  if (existing.uid !== resource.uid || existing.creationNonce !== resource.creationNonce)
    throw new NetworkingAdapterError(
      'FIXTURE_REMOTE_IDENTITY_MISMATCH',
      'Controlled deletion identity changed.',
    );
  const intent: NetworkWriteIntent = {
    ...resource,
    action: 'delete',
    expectedUid: resource.uid,
    expectedResourceVersion: resource.resourceVersion,
    revision: plan.revision,
  };
  await hooks.beforeWrite(intent);
  remoteWrites.push(intent);
  effects.push('network-delete');
  remote.delete(resourceKey(resource));
  const receipt: NetworkResourceReceipt = {
    ...existing,
    action: 'deleted',
    revision: plan.revision,
    observedAt: new Date().toISOString(),
  };
  await afterRemoteWrite?.(receipt);
  await hooks.onReceipt(receipt);
  return receipt;
}

async function partiallyRemove(
  _connection: unknown,
  plan: NetworkDomainPlan,
  hooks: NetworkWriteHooks,
) {
  const first = plan.inventory.find((resource) => resource.scope === 'domain');
  if (!first) throw new Error('Expected domain resources for partial cleanup');
  const receipt = await deleteResource(plan, first, hooks);
  // The adapter reports completion early. The production ledger must still
  // prevent deleting the binding while other registered resources remain.
  return domainReceipt(plan, [receipt], true);
}

async function runOperation(id: string, runtime: NetworkingExecutor | ServiceExecutor = executor) {
  // A persisted one-attempt budget reaches terminal failures for manual retry
  // assertions. Automatic backoff/recovery is covered by the task integration suite.
  await db.operation.update({ where: { id }, data: { maxAttempts: 1 } });
  const lease = await repository.claimTask(
    { type: 'operation', id },
    'network-integration-fixture',
  );
  if (!lease || !('operationId' in lease))
    throw new Error('Expected claimable networking operation');
  try {
    const result = await runtime.execute(lease, new AbortController().signal);
    expect(await repository.complete(lease, result)).toBe(true);
    return null;
  } catch (error) {
    if (!(error instanceof TaskExecutionError)) throw error;
    expect(
      await repository.fail(lease, error.code, error.message, error.retryable, (tx) =>
        runtime.failed(lease, tx, error.code, error.message),
      ),
    ).toBe(true);
    expect((await repository.get(id)).status).toBe('failed');
    return error;
  }
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
      '/CN=ozz-networking-fixture-ca',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { cwd: directory, timeout: 10_000 },
  );
  chmodSync(join(directory, 'ca.key'), 0o600);
  certificate = readFileSync(join(directory, 'ca.pem'), 'utf8');
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
  const admin = await db.admin.create({
    data: { username: 'network-fixture', passwordHash: 'fixture-login-disabled' },
  });
  actor = { id: admin.id };
  repository = new TaskRepository(db, { leaseMs: 30_000 });
  commands = new NetworkingCommands(repository);
  services = new ServiceCommands(repository, cipher);
  executor = new NetworkingExecutor(repository, cipher, manager, dns);
  serviceExecutor = new ServiceExecutor(repository, cipher, registry, workloads, kubernetes, {
    beforeServiceDelete,
  });
});

beforeEach(async () => {
  for (const call of [
    ...Object.values(manager),
    dns.inspect,
    ...Object.values(registry),
    ...Object.values(workloads),
    kubernetes.inspect,
    beforeServiceDelete,
  ])
    call.mockReset();
  remote.clear();
  remoteWrites.length = 0;
  effects.length = 0;
  remoteVersion = 0;
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE "${schema}"."Cluster", "${schema}"."PlatformSettings", "${schema}"."SecretReference" CASCADE`,
  );
  fixture = await createContext();
  beforeServiceDelete.mockImplementation((lease, signal) =>
    executor.beforeServiceDelete(lease, signal),
  );
  dns.inspect.mockImplementation(async (_hostname, expected) => ({
    state: 'matched',
    observedAt: new Date().toISOString(),
    addresses: [...expected.addresses],
    cnameChain: expected.cname ? [expected.cname] : [],
    expectedAddresses: [...expected.addresses],
    expectedCname: expected.cname,
    code: null,
    message: 'Controlled DNS answer matches the configured entry.',
  }));
  manager.apply.mockImplementation(async (_connection, plan, hooks) => {
    const receipts: NetworkResourceReceipt[] = [];
    for (const resource of descriptors(plan))
      receipts.push(await writeResource(plan, resource, hooks));
    return domainReceipt(plan, receipts);
  });
  manager.observe.mockImplementation(async (_connection, plan) => observedResources(plan));
  manager.remove.mockImplementation(async (_connection, plan, hooks) => {
    const receipts: NetworkResourceReceipt[] = [];
    for (const resource of plan.inventory.filter((value) => value.scope === 'domain'))
      receipts.push(await deleteResource(plan, resource, hooks));
    return domainReceipt(plan, receipts, true);
  });
  workloads.operate.mockImplementation(async (_connection, operation, hooks) => {
    expect(operation.action).toBe('delete');
    expect(await db.domain.count({ where: { serviceId: operation.target.serviceId } })).toBe(0);
    effects.push('workload-delete');
    const resources: WorkloadResourceReceipt[] = [];
    for (const resource of operation.inventory.filter((value) => value.kind !== 'Namespace')) {
      await hooks.beforeWrite({
        ...resource,
        action: 'delete',
        expectedUid: resource.uid,
        expectedResourceVersion: resource.resourceVersion,
        mutationRevision: operation.mutationRevision,
      });
      const receipt: WorkloadResourceReceipt = {
        ...resource,
        action: 'deleted',
        uid: resource.uid!,
        resourceVersion: resource.resourceVersion,
        generation: null,
        mutationRevision: operation.mutationRevision,
        specFingerprint: null,
        observedAt: new Date().toISOString(),
      };
      await hooks.onReceipt(receipt);
      resources.push(receipt);
    }
    return {
      action: operation.action,
      mutationRevision: operation.mutationRevision,
      resources,
      rollout: null,
      completedAt: new Date().toISOString(),
    };
  });
});

afterEach(async () => {
  for (const observer of observers) await stopObserver(observer);
  if (db)
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: false },
    });
});

afterAll(async () => {
  if (db) {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('S4 networking admission and business execution', () => {
  it('starts settings at revision zero and reserves unique normalized cluster subdomains', async () => {
    expect(await commands.platformSettings()).toEqual({
      revision: 0,
      appsDomainSuffix: null,
      acmeEmail: null,
      updatedAt: null,
    });
    expect(await commands.clusterNetworking(fixture.cluster.id)).toMatchObject({
      revision: 0,
      subdomain: null,
      entryAddresses: [],
    });
    await expect(
      commands.updatePlatformSettings({ revision: 1, ...platformInput }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const settings = await commands.updatePlatformSettings({ revision: 0, ...platformInput });
    expect(settings).toMatchObject({ revision: 1, ...platformInput });
    await expect(
      commands.updatePlatformSettings({ revision: 0, ...platformInput }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const entry = {
      subdomain: 'EAST.',
      entryAddresses: ['192.0.2.42', '192.0.2.42'],
      cnameTarget: null,
    };
    const network = await commands.updateClusterNetworking(fixture.cluster.id, {
      revision: 0,
      ...entry,
    });
    expect(network).toMatchObject({
      revision: 1,
      subdomain: 'east',
      domainSuffix: 'east.apps.example.test',
      entryAddresses: ['192.0.2.42'],
    });
    const other = await createContext();
    await expect(
      commands.updateClusterNetworking(other.cluster.id, { revision: 0, ...entry }),
    ).rejects.toMatchObject({ code: 'CLUSTER_SUBDOMAIN_CONFLICT' });
    expect((await commands.clusterNetworking(other.cluster.id)).revision).toBe(0);
    expect(await db.operation.count()).toBe(0);
    expect(manager.apply).not.toHaveBeenCalled();
  });

  it('locks suffix, ACME account and cluster entry changes once a domain exists', async () => {
    const network = await configure();
    const service = await publishedService();
    const task = await bind(service.id);
    const input = domainOperationInput(task.input);
    for (const update of [
      { ...platformInput, appsDomainSuffix: 'other.example.test' },
      { ...platformInput, acmeEmail: 'another@example.test' },
    ])
      await expect(
        commands.updatePlatformSettings({ revision: 1, ...update }),
      ).rejects.toMatchObject({ code: 'DOMAIN_SETTINGS_IN_USE' });
    for (const update of [
      { subdomain: network.subdomain, entryAddresses: ['192.0.2.43'] },
      { subdomain: 'another', entryAddresses: network.entryAddresses },
    ])
      await expect(
        commands.updateClusterNetworking(fixture.cluster.id, {
          revision: 1,
          ...update,
          cnameTarget: null,
        }),
      ).rejects.toMatchObject({ code: 'CLUSTER_NETWORKING_IN_USE' });
    expect(
      (await commands.updatePlatformSettings({ revision: 1, ...platformInput })).revision,
    ).toBe(1);
    expect((await commands.get(input.domainId)).hostname).toBe(input.hostname);
    const other = await createContext();
    expect((await configure(other)).revision).toBe(1);
    expect(manager.apply).not.toHaveBeenCalled();
    expect(remoteWrites).toHaveLength(0);
  });

  it('rejects unpublished, foreign-service and draft-only ports and binds the applied port numbers', async () => {
    await configure();
    const unpublished = await createService();
    const unpublishedPort = await db.servicePort.findFirstOrThrow({
      where: { serviceId: unpublished.id },
    });
    expect((await commands.serviceNetworking(unpublished.id)).eligiblePorts).toEqual([]);
    await expect(
      commands.bind(
        unpublished.id,
        { revision: unpublished.revision, portId: unpublishedPort.id },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISHED_HTTP_PORT_REQUIRED' });
    const service = await publishedService();
    const foreign = await publishedService();
    const port = (await commands.serviceNetworking(service.id)).eligiblePorts[0]!;
    const foreignPort = (await commands.serviceNetworking(foreign.id)).eligiblePorts[0]!;
    await expect(
      commands.bind(
        service.id,
        { revision: service.revision, portId: foreignPort.id },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISHED_HTTP_PORT_REQUIRED' });
    const changed = await services.update(service.id, {
      revision: service.revision,
      configuration: {
        image: service.configuration.image,
        ports: [
          { ...httpPort, containerPort: 9090, servicePort: 9090 },
          { name: 'draft-admin', protocol: 'http', containerPort: 9001, servicePort: 9001 },
        ],
      },
    });
    const draftPort = await db.servicePort.findUniqueOrThrow({
      where: { serviceId_name: { serviceId: service.id, name: 'draft-admin' } },
    });
    const view = await commands.serviceNetworking(service.id);
    expect(view.eligiblePorts).toEqual([{ ...httpPort, id: port.id, publishedConfigRevision: 1 }]);
    await expect(
      commands.bind(
        service.id,
        { revision: changed.revision, portId: draftPort.id },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PUBLISHED_HTTP_PORT_REQUIRED' });
    expect(await db.domain.count()).toBe(0);
    expect(await db.serviceMutation.count()).toBe(0);
    const task = await commands.bind(
      service.id,
      { revision: changed.revision, portId: port.id },
      actor,
      randomUUID(),
    );
    expect((await commands.get(domainOperationInput(task.input).domainId)).servicePort).toEqual({
      ...httpPort,
      id: port.id,
      publishedConfigRevision: 1,
    });
    expect(remoteWrites).toHaveLength(0);
  });

  it('deduplicates one idempotency key and shares the service mutation slot with publication and runtime actions', async () => {
    await configure();
    const service = await publishedService();
    const other = await publishedService();
    const port = (await commands.serviceNetworking(service.id)).eligiblePorts[0]!;
    const key = randomUUID();
    const request = { revision: service.revision, portId: port.id };
    const accepted = await Promise.all([
      commands.bind(service.id, request, actor, key),
      commands.bind(service.id, request, actor, key),
    ]);
    expect(accepted[0]!.id).toBe(accepted[1]!.id);
    const task = accepted[0]!;
    expect(await db.domain.count({ where: { serviceId: service.id } })).toBe(1);
    expect(await db.operation.count({ where: { serviceId: service.id } })).toBe(1);
    expect(await db.outbox.count({ where: { operationId: task.id } })).toBe(1);
    const busy = await services.get(service.id);
    const conflict = {
      code: 'SERVICE_OPERATION_ACTIVE',
      activeTask: { type: 'operation', id: task.id },
    };
    await expect(
      commands.bind(service.id, { ...request, revision: busy.revision }, actor, randomUUID()),
    ).rejects.toMatchObject(conflict);
    await expect(
      services.deploy(service.id, { revision: busy.revision }, actor, randomUUID()),
    ).rejects.toMatchObject(conflict);
    await expect(
      services.action(service.id, 'stop', { revision: busy.revision }, actor, randomUUID()),
    ).rejects.toMatchObject(conflict);
    await expect(
      commands.bind(service.id, { ...request, portId: randomUUID() }, actor, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const otherTask = await bind(other.id);
    expect(await db.serviceMutation.count()).toBe(2);
    expect(await runOperation(task.id)).toBeNull();
    expect(await runOperation(otherTask.id)).toBeNull();
    const idle = await services.get(service.id);
    const stop = await services.action(
      service.id,
      'stop',
      { revision: idle.revision },
      actor,
      randomUUID(),
    );
    const domain = await commands.get(domainOperationInput(task.input).domainId);
    await expect(
      commands.action(domain.id, 'sync', { revision: domain.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({
      code: 'SERVICE_OPERATION_ACTIVE',
      activeTask: { type: 'operation', id: stop.id },
    });
  });

  it.each(['stale DNS', 'expired certificate', 'not-yet-valid certificate', 'unknown authority'])(
    'rejects production admission with %s even when the cached observation is recent',
    async (invalidEvidence) => {
      const { domain } = await boundService();
      const now = new Date();
      const certificate = { ...domain.certificate!, observedAt: now.toISOString() };
      const dnsSample = { ...domain.dns!, observedAt: now.toISOString() };
      if (invalidEvidence === 'stale DNS')
        dnsSample.observedAt = new Date(
          now.getTime() - NETWORK_OBSERVATION_STALE_MS - 1000,
        ).toISOString();
      else if (invalidEvidence === 'expired certificate')
        certificate.notAfter = new Date(now.getTime() - 1000).toISOString();
      else if (invalidEvidence === 'not-yet-valid certificate')
        certificate.notBefore = new Date(now.getTime() + 60_000).toISOString();
      else certificate.authority = 'unknown';
      await db.domain.update({
        where: { id: domain.id },
        data: {
          dnsJson: fixtureJson(dnsSample),
          certificateJson: fixtureJson(certificate),
          lastObservedAt: now,
        },
      });
      expect((await commands.get(domain.id)).observationStale).toBe(false);
      const operations = await db.operation.count();
      const writes = structuredClone(remoteWrites);
      await expect(
        commands.action(
          domain.id,
          'production',
          { revision: domain.revision },
          actor,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'STAGING_CERTIFICATE_REQUIRED' });
      expect(await commands.get(domain.id)).toMatchObject({
        revision: domain.revision,
        certificateEnvironment: 'staging',
      });
      expect(await db.operation.count()).toBe(operations);
      expect(await db.serviceMutation.count()).toBe(0);
      expect(remoteWrites).toEqual(writes);
      expect(manager.apply).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the accepted staging evidence when production retries after a later production observation', async () => {
    const { domain } = await boundService();
    const production = await commands.action(
      domain.id,
      'production',
      { revision: domain.revision },
      actor,
      randomUUID(),
    );
    const original = domainOperationInput(production.input);
    expect(original).toMatchObject({
      certificateEnvironment: 'production',
      stagingVerification: {
        authority: 'local_test',
        certificateObservedAt: domain.certificate!.observedAt,
        certificateNotAfter: domain.certificate!.notAfter,
        dnsObservedAt: domain.dns!.observedAt,
      },
    });
    manager.apply.mockRejectedValueOnce(
      new NetworkingAdapterError(
        'NETWORK_PRODUCTION_INTERRUPTED',
        'Controlled production interruption.',
        true,
      ),
    );
    expect(await runOperation(production.id)).toMatchObject({
      code: 'NETWORK_PRODUCTION_INTERRUPTED',
      retryable: true,
    });
    manager.observe.mockImplementationOnce(async (_connection, plan) => {
      const sample = observedResources(plan);
      return {
        ...sample,
        certificate: {
          ...sample.certificate,
          state: 'issuing',
          environment: 'production',
          notBefore: null,
          notAfter: null,
        },
      };
    });
    const failed = await commands.get(domain.id);
    const sync = await commands.action(
      domain.id,
      'sync',
      { revision: failed.revision },
      actor,
      randomUUID(),
    );
    expect(await runOperation(sync.id)).toBeNull();
    expect(await commands.get(domain.id)).toMatchObject({
      certificateEnvironment: 'production',
      certificate: { state: 'issuing', environment: 'production', notAfter: null },
      observationStale: false,
    });
    const retry = await commands.retryOperation(production.id, actor, randomUUID());
    const repeated = domainOperationInput(retry.input);
    expect(repeated.stagingVerification).toEqual(original.stagingVerification);
    expect(repeated.target).toEqual(original.target);
    expect(repeated.domainRevision).toBe(original.domainRevision + 1);
    expect(retry.retryOfId).toBe(production.id);
    expect(await runOperation(retry.id)).toBeNull();
    expect(await commands.get(domain.id)).toMatchObject({
      hostname: domain.hostname,
      certificateEnvironment: 'production',
      certificate: { state: 'ready', environment: 'production', authority: 'local_test' },
    });
    expect(
      domainOperationInput((await repository.get(production.id)).input).stagingVerification,
    ).toEqual(original.stagingVerification);
    expect((await repository.get(production.id)).status).toBe('failed');
  });

  it.each(['production', 'reconcile'] as const)(
    'refuses changed DNS before a %s task for production certificates emits a remote write',
    async (action) => {
      const bound = await boundService();
      let domain = bound.domain;
      if (action === 'reconcile') {
        const initial = await commands.action(
          domain.id,
          'production',
          { revision: domain.revision },
          actor,
          randomUUID(),
        );
        expect(await runOperation(initial.id)).toBeNull();
        domain = await commands.get(domain.id);
      }
      const task = await commands.action(
        domain.id,
        action,
        { revision: domain.revision },
        actor,
        randomUUID(),
      );
      dns.inspect.mockResolvedValueOnce({
        ...domain.dns!,
        state: 'mismatch',
        addresses: ['192.0.2.43'],
        observedAt: new Date().toISOString(),
        code: 'DNS_ENTRY_MISMATCH',
        message: 'Controlled DNS points to a different entry.',
      });
      const applyCalls = manager.apply.mock.calls.length;
      const writes = structuredClone(remoteWrites);
      const resources = structuredClone([...remote]);
      expect(await runOperation(task.id)).toMatchObject({ code: 'PRODUCTION_DNS_REQUIRED' });
      expect(manager.apply).toHaveBeenCalledTimes(applyCalls);
      expect(remoteWrites).toEqual(writes);
      expect([...remote]).toEqual(resources);
      expect(await commands.get(domain.id)).toMatchObject({
        desiredState: 'active',
        certificateEnvironment: 'production',
        dns: { state: 'mismatch' },
        lastErrorCode: 'PRODUCTION_DNS_REQUIRED',
      });
    },
  );

  it('keeps sync read-only and preserves a partially failed bind for an explicit retry', async () => {
    await configure();
    const service = await publishedService();
    manager.apply.mockImplementationOnce(async (_connection, plan, hooks) => {
      await writeResource(
        plan,
        descriptors(plan).find((resource) => resource.kind === 'Ingress')!,
        hooks,
      );
      throw new NetworkingAdapterError(
        'NETWORK_APPLY_PARTIAL',
        'Controlled bind interruption.',
        true,
      );
    });
    const failed = await bind(service.id);
    expect(await runOperation(failed.id)).toMatchObject({
      code: 'NETWORK_APPLY_PARTIAL',
      retryable: true,
    });
    const initial = domainOperationInput(failed.input);
    const before = await commands.get(initial.domainId);
    const serviceBefore = await services.get(service.id);
    const remoteBefore = structuredClone([...remote]);
    const writesBefore = remoteWrites.length;
    const sync = await commands.action(
      before.id,
      'sync',
      { revision: before.revision },
      actor,
      randomUUID(),
    );
    expect(await runOperation(sync.id)).toBeNull();
    const after = await commands.get(before.id);
    expect(after.revision).toBe(before.revision);
    expect((await services.get(service.id)).revision).toBe(serviceBefore.revision);
    expect([...remote]).toEqual(remoteBefore);
    expect(remoteWrites).toHaveLength(writesBefore);
    expect(manager.apply).toHaveBeenCalledTimes(1);
    expect(manager.observe).toHaveBeenCalledTimes(1);
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.installCertManager).not.toHaveBeenCalled();
    const retry = await commands.retryOperation(failed.id, actor, randomUUID());
    expect(retry.retryOfId).toBe(failed.id);
    expect(domainOperationInput(retry.input).target).toEqual(initial.target);
    expect(await runOperation(retry.id)).toBeNull();
    expect(await commands.get(before.id)).toMatchObject({
      hostname: before.hostname,
      dns: { state: 'matched' },
      route: { state: 'ready' },
      certificate: { state: 'staging_ready', environment: 'staging' },
    });
    expect((await repository.get(failed.id)).status).toBe('failed');
  });

  it('marks retained route data stale immediately on a failed observation and accepts a fresh drift diagnosis', async () => {
    const { domain } = await boundService();
    const observedAt = new Date(Date.now() - 10_000).toISOString();
    const previousRoute = { ...domain.route!, observedAt };
    const previousCertificate = { ...domain.certificate!, observedAt };
    await db.domain.update({
      where: { id: domain.id },
      data: {
        dnsJson: fixtureJson({ ...domain.dns!, observedAt }),
        routeJson: fixtureJson(previousRoute),
        certificateJson: fixtureJson(previousCertificate),
        lastObservedAt: new Date(observedAt),
      },
    });
    expect((await commands.get(domain.id)).observationStale).toBe(false);
    const writes = structuredClone(remoteWrites);
    manager.observe.mockRejectedValueOnce(
      new NetworkingAdapterError(
        'KUBERNETES_UNREACHABLE',
        'Controlled cluster disconnection.',
        true,
      ),
    );
    await observeSoon(domain.id);
    const failedObserver = startObserver();
    await vi.waitFor(
      async () => {
        expect(await commands.get(domain.id)).toMatchObject({
          observationStale: true,
          lastErrorCode: 'KUBERNETES_UNREACHABLE',
        });
      },
      { timeout: 5000, interval: 25 },
    );
    await stopObserver(failedObserver);
    const failed = await db.domain.findUniqueOrThrow({ where: { id: domain.id } });
    expect(failed).toMatchObject({
      routeJson: previousRoute,
      certificateJson: previousCertificate,
      lastObservedAt: new Date(observedAt),
      observationErrorCode: 'KUBERNETES_UNREACHABLE',
    });
    const failedView = await commands.get(domain.id);
    expect(failedView.dns?.state).toBe('matched');
    expect(Date.parse(failedView.dns!.observedAt)).toBeGreaterThan(Date.parse(observedAt));
    expect(Date.now() - failed.lastObservedAt!.getTime()).toBeLessThan(
      NETWORK_OBSERVATION_STALE_MS,
    );

    manager.observe.mockImplementationOnce(async (_connection, plan) => {
      const sample = observedResources(plan);
      return {
        ...sample,
        route: {
          ...sample.route,
          state: 'drifted',
          code: 'NETWORK_ROUTE_DRIFTED',
          message: 'Controlled route drift needs explicit repair.',
        },
      };
    });
    await observeSoon(domain.id);
    const recoveredObserver = startObserver();
    await vi.waitFor(
      async () => {
        expect(await commands.get(domain.id)).toMatchObject({
          observationStale: false,
          route: { state: 'drifted' },
          lastErrorCode: 'NETWORK_ROUTE_DRIFTED',
        });
      },
      { timeout: 5000, interval: 25 },
    );
    await stopObserver(recoveredObserver);
    const recovered = await db.domain.findUniqueOrThrow({ where: { id: domain.id } });
    expect(recovered.observationErrorCode).toBeNull();
    expect(recovered.lastObservedAt!.getTime()).toBeGreaterThan(failed.lastObservedAt!.getTime());
    expect(manager.observe).toHaveBeenCalledTimes(2);
    expect(remoteWrites).toEqual(writes);
    expect(manager.apply).toHaveBeenCalledTimes(1);
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it.each(['deadline', 'shutdown'] as const)(
    'distinguishes %s from healthy cached networking facts',
    async (mode) => {
      const { domain } = await boundService();
      const prior = await db.domain.findUniqueOrThrow({ where: { id: domain.id } });
      const writes = structuredClone(remoteWrites);
      const entered = gate();
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => nativeTimeout(mode === 'deadline' && ms === 60_000 ? 300 : ms));
      manager.observe.mockImplementationOnce(async (_connection, _plan, options) => {
        entered.release();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error('controlled aborted network read'));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
        throw new Error('unreachable');
      });
      let observer: DomainObserver | undefined;
      try {
        await observeSoon(domain.id);
        observer = startObserver();
        await entered.promise;
        if (mode === 'deadline')
          await vi.waitFor(
            async () => {
              expect(await commands.get(domain.id)).toMatchObject({
                observationStale: true,
                lastErrorCode: 'NETWORK_OBSERVATION_TIMEOUT',
              });
            },
            { timeout: 5000, interval: 25 },
          );
        await stopObserver(observer);
        observer = undefined;
        const after = await db.domain.findUniqueOrThrow({ where: { id: domain.id } });
        expect(after.routeJson).toEqual(prior.routeJson);
        expect(after.certificateJson).toEqual(prior.certificateJson);
        expect(after.lastObservedAt).toEqual(prior.lastObservedAt);
        expect(after.observationErrorCode).toBe(
          mode === 'deadline' ? 'NETWORK_OBSERVATION_TIMEOUT' : prior.observationErrorCode,
        );
        expect(remoteWrites).toEqual(writes);
      } finally {
        if (observer) await stopObserver(observer);
        timeout.mockRestore();
      }
    },
  );

  it.each(['before receipt', 'after receipt'] as const)(
    'rejects a delayed observation of a shared Issuer when another service has written %s',
    async (delivery) => {
      const first = await boundService();
      const secondService = await publishedService();
      const secondBind = await bind(secondService.id);
      expect(await runOperation(secondBind.id)).toBeNull();
      const second = await commands.get(domainOperationInput(secondBind.input).domainId);
      const issuer = await db.networkManagedResource.findFirstOrThrow({
        where: { clusterId: fixture.cluster.id, kind: 'Issuer', scope: 'environment' },
      });
      const ownRoute = await db.networkManagedResource.findFirstOrThrow({
        where: { domainId: first.domain.id, kind: 'Ingress' },
      });
      const allowObservation = gate();
      const allowReceipt = gate();
      let captured: NetworkDomainPlan | undefined;
      let remoteReceipt: NetworkResourceReceipt | undefined;
      let execution: ReturnType<typeof runOperation> | undefined;
      manager.observe.mockImplementationOnce(async (_connection, plan) => {
        captured = plan;
        const sample = structuredClone(observedResources(plan));
        await allowObservation.promise;
        return sample;
      });
      manager.apply.mockImplementationOnce(async (_connection, plan, hooks) => {
        const shared = descriptors(plan).find((resource) => resource.kind === 'Issuer')!;
        const receipt = await writeResource(plan, shared, hooks, async (written) => {
          remoteReceipt = written;
          await allowReceipt.promise;
        });
        return domainReceipt(plan, [receipt]);
      });
      await db.domain.update({
        where: { id: second.id },
        data: { nextObservationAt: new Date(Date.now() + 60_000) },
      });
      await observeSoon(first.domain.id);
      const observer = startObserver();
      try {
        await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: 5000, interval: 25 });
        expect(captured!.target.domainId).toBe(first.domain.id);
        expect(captured!.inventory.find((resource) => resource.kind === 'Issuer')).toMatchObject({
          uid: issuer.uid,
          ledgerVersion: issuer.ledgerVersion,
          resourceVersion: issuer.resourceVersion,
        });
        const reconcile = await commands.action(
          second.id,
          'reconcile',
          { revision: second.revision },
          actor,
          randomUUID(),
        );
        execution = runOperation(reconcile.id);
        await vi.waitFor(() => expect(remoteReceipt).toBeDefined(), {
          timeout: 5000,
          interval: 25,
        });
        if (delivery === 'after receipt') {
          allowReceipt.release();
          expect(await execution).toBeNull();
        }
        const advanced = await db.networkManagedResource.findUniqueOrThrow({
          where: { id: issuer.id },
        });
        expect(advanced.ledgerVersion).toBeGreaterThan(issuer.ledgerVersion);
        expect(advanced.resourceVersion).toBe(
          delivery === 'after receipt' ? remoteReceipt!.resourceVersion : issuer.resourceVersion,
        );
        allowObservation.release();
        await vi.waitFor(
          async () => {
            expect(await commands.get(first.domain.id)).toMatchObject({
              observationStale: true,
              lastErrorCode: 'NETWORK_OBSERVATION_SUPERSEDED',
            });
          },
          { timeout: 5000, interval: 25 },
        );
        await stopObserver(observer);
        expect(
          await db.networkManagedResource.findUniqueOrThrow({ where: { id: issuer.id } }),
        ).toEqual(advanced);
        // Earlier receipts in this sample must roll back with the shared-Issuer CAS failure.
        expect(
          await db.networkManagedResource.findUniqueOrThrow({ where: { id: ownRoute.id } }),
        ).toEqual(ownRoute);
        allowReceipt.release();
        expect(await execution).toBeNull();
        expect(
          await db.networkManagedResource.findUniqueOrThrow({ where: { id: issuer.id } }),
        ).toMatchObject({
          uid: issuer.uid,
          resourceVersion: remoteReceipt!.resourceVersion,
          creationNonce: issuer.creationNonce,
          receiptJson: remoteReceipt,
        });
        expect(manager.observe).toHaveBeenCalledTimes(1);
        expect((await repository.get(reconcile.id)).status).toBe('succeeded');
      } finally {
        allowReceipt.release();
        allowObservation.release();
        await execution?.catch(() => undefined);
        await stopObserver(observer);
      }
    },
  );

  it.each(['creationNonce', 'uid'] as const)(
    'rejects a forged %s receipt without replacing the trusted resource identity',
    async (field) => {
      await configure();
      const service = await publishedService();
      let accepted: NetworkResourceReceipt | undefined;
      manager.apply.mockImplementationOnce(async (_connection, plan, hooks) => {
        accepted = await writeResource(
          plan,
          descriptors(plan).find((resource) => resource.kind === 'Ingress')!,
          hooks,
        );
        await hooks.onReceipt({ ...accepted, action: 'replaced', [field]: randomUUID() });
        return domainReceipt(plan, [accepted]);
      });
      const task = await bind(service.id);
      expect(await runOperation(task.id)).toMatchObject({
        code: 'NETWORK_RESOURCE_OWNERSHIP_MISMATCH',
      });
      if (!accepted) throw new Error('Expected trusted receipt before tampering');
      const record = await db.networkManagedResource.findFirstOrThrow({
        where: { domainId: domainOperationInput(task.input).domainId },
      });
      expect(record).toMatchObject({
        uid: accepted.uid,
        creationNonce: accepted.creationNonce,
        creationAttempted: true,
        deletedAt: null,
        receiptJson: accepted,
      });
      expect(remote.get(resourceKey(accepted))).toEqual(accepted);
      expect(remoteWrites).toHaveLength(1);
      expect((await commands.get(domainOperationInput(task.input).domainId)).lastErrorCode).toBe(
        'NETWORK_RESOURCE_OWNERSHIP_MISMATCH',
      );
    },
  );

  it('recovers the original UID after CREATE succeeded but its receipt was lost', async () => {
    await configure();
    const service = await publishedService();
    let created: NetworkResourceReceipt | undefined;
    manager.apply.mockImplementationOnce(async (_connection, plan, hooks) => {
      const ingress = descriptors(plan).find((resource) => resource.kind === 'Ingress')!;
      await writeResource(plan, ingress, hooks, async (receipt) => {
        created = receipt;
        throw new NetworkingAdapterError(
          'NETWORK_RECEIPT_LOST',
          'Controlled response loss after CREATE.',
          true,
        );
      });
      throw new Error('The lost CREATE response must stop this attempt.');
    });
    const failed = await bind(service.id);
    expect(await runOperation(failed.id)).toMatchObject({
      code: 'NETWORK_RECEIPT_LOST',
      retryable: true,
    });
    if (!created) throw new Error('Expected the remote CREATE to complete.');
    const input = domainOperationInput(failed.input);
    const pending = await db.networkManagedResource.findFirstOrThrow({
      where: { domainId: input.domainId, kind: 'Ingress' },
    });
    expect(pending).toMatchObject({
      creationAttempted: true,
      creationNonce: created.creationNonce,
      uid: null,
      resourceVersion: null,
      deletedAt: null,
    });
    expect(remote.get(resourceKey(created))).toEqual(created);
    const retry = await commands.retryOperation(failed.id, actor, randomUUID());
    expect(await runOperation(retry.id)).toBeNull();
    const recovered = await db.networkManagedResource.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(recovered).toMatchObject({
      uid: created.uid,
      creationNonce: created.creationNonce,
      creationAttempted: true,
      deletedAt: null,
      revision: domainOperationInput(retry.input).domainRevision,
    });
    const writes = remoteWrites.filter(
      (resource) => resourceKey(resource) === resourceKey(created!),
    );
    expect(writes.map((intent) => intent.action)).toEqual(['create', 'replace']);
    expect(writes[1]).toMatchObject({
      expectedUid: created.uid,
      expectedResourceVersion: created.resourceVersion,
    });
    expect(remote.get(resourceKey(created))?.uid).toBe(created.uid);
    expect(await commands.get(input.domainId)).toMatchObject({
      hostname: input.hostname,
      route: { state: 'ready' },
      certificate: { state: 'staging_ready' },
    });
    expect((await repository.get(failed.id)).status).toBe('failed');
  });

  it('confirms named absence after DELETE succeeded but its receipt was lost', async () => {
    const { domain } = await boundService();
    const issuerRows = await db.networkManagedResource.findMany({
      where: { scope: 'environment' },
      orderBy: { name: 'asc' },
    });
    const trusted = await db.networkManagedResource.findFirstOrThrow({
      where: { domainId: domain.id, kind: 'Ingress' },
    });
    manager.remove.mockImplementationOnce(async (_connection, plan, hooks) => {
      const ingress = plan.inventory.find((resource) => resource.kind === 'Ingress')!;
      await deleteResource(plan, ingress, hooks, async () => {
        throw new NetworkingAdapterError(
          'NETWORK_RECEIPT_LOST',
          'Controlled response loss after DELETE.',
          true,
        );
      });
      throw new Error('The lost DELETE response must stop this attempt.');
    });
    const unbind = await commands.action(
      domain.id,
      'unbind',
      { revision: domain.revision },
      actor,
      randomUUID(),
    );
    expect(await runOperation(unbind.id)).toMatchObject({
      code: 'NETWORK_RECEIPT_LOST',
      retryable: true,
    });
    expect(await commands.get(domain.id)).toMatchObject({ desiredState: 'deleting' });
    const pending = await db.networkManagedResource.findUniqueOrThrow({
      where: { id: trusted.id },
    });
    expect(pending).toMatchObject({
      uid: trusted.uid,
      creationNonce: trusted.creationNonce,
      deletedAt: null,
    });
    expect(remote.has(resourceKey({ ...trusted, scope: 'domain' }))).toBe(false);
    const retry = await commands.retryOperation(unbind.id, actor, randomUUID());
    expect(await runOperation(retry.id)).toBeNull();
    expect(await db.domain.count({ where: { id: domain.id } })).toBe(0);
    const removed = await db.networkManagedResource.findUniqueOrThrow({
      where: { id: trusted.id },
    });
    expect(removed).toMatchObject({
      uid: trusted.uid,
      creationNonce: trusted.creationNonce,
      domainId: null,
    });
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.receiptJson).toMatchObject({
      action: 'deleted',
      uid: trusted.uid,
      creationNonce: trusted.creationNonce,
    });
    expect(
      remoteWrites.filter((intent) => intent.name === trusted.name && intent.action === 'delete'),
    ).toHaveLength(1);
    expect(
      await db.networkManagedResource.findMany({
        where: { scope: 'environment' },
        orderBy: { name: 'asc' },
      }),
    ).toEqual(issuerRows);
    expect([...remote.values()].every((resource) => resource.scope === 'environment')).toBe(true);
    expect((await repository.get(unbind.id)).status).toBe('failed');
  });

  it('preserves the binding on partial unbind and retries only remaining domain resources', async () => {
    const { service, domain } = await boundService();
    const sharedBefore = await db.networkManagedResource.findMany({
      where: { scope: 'environment' },
      orderBy: { name: 'asc' },
    });
    const dnsCalls = dns.inspect.mock.calls.length;
    manager.remove.mockImplementationOnce(partiallyRemove);
    const unbind = await commands.action(
      domain.id,
      'unbind',
      { revision: domain.revision },
      actor,
      randomUUID(),
    );
    expect(await runOperation(unbind.id)).toMatchObject({
      code: 'NETWORK_CLEANUP_INCOMPLETE',
      retryable: true,
    });
    const remaining = await db.networkManagedResource.findMany({ where: { domainId: domain.id } });
    expect(remaining).toHaveLength(3);
    expect(remaining.filter((row) => row.deletedAt)).toHaveLength(1);
    const kept = await commands.get(domain.id);
    expect(kept).toMatchObject({
      desiredState: 'deleting',
      lastErrorCode: 'NETWORK_CLEANUP_INCOMPLETE',
    });
    expect(await services.get(service.id)).toMatchObject({ id: service.id });
    await expect(
      commands.action(domain.id, 'sync', { revision: kept.revision }, actor, randomUUID()),
    ).rejects.toMatchObject({ code: 'DOMAIN_DELETING' });
    const retry = await commands.retryOperation(unbind.id, actor, randomUUID());
    expect(await runOperation(retry.id)).toBeNull();
    await expect(commands.get(domain.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(await db.service.count({ where: { id: service.id } })).toBe(1);
    expect(
      manager.remove.mock.calls[1]![1].inventory.filter((row) => row.scope === 'domain'),
    ).toHaveLength(2);
    expect(
      await db.networkManagedResource.findMany({
        where: { scope: 'environment' },
        orderBy: { name: 'asc' },
      }),
    ).toEqual(sharedBefore);
    const tombstones = await db.networkManagedResource.findMany({ where: { scope: 'domain' } });
    expect(tombstones).toHaveLength(3);
    expect(tombstones.every((row) => row.deletedAt && row.domainId === null)).toBe(true);
    expect([...remote.values()].every((row) => row.scope === 'environment')).toBe(true);
    expect(remote.size).toBe(2);
    expect(dns.inspect).toHaveBeenCalledTimes(dnsCalls);
  });

  it('reuses the networking cleanup inside service deletion and blocks workload deletion until cleanup succeeds', async () => {
    const { service, domain } = await boundService();
    effects.length = 0;
    manager.remove.mockImplementationOnce(partiallyRemove);
    const deletion = await services.action(
      service.id,
      'delete',
      { revision: service.revision },
      actor,
      randomUUID(),
    );
    expect(await runOperation(deletion.id, serviceExecutor)).toMatchObject({
      code: 'NETWORK_CLEANUP_INCOMPLETE',
      retryable: true,
    });
    expect(beforeServiceDelete).toHaveBeenCalledTimes(1);
    expect(workloads.operate).not.toHaveBeenCalled();
    expect(await commands.get(domain.id)).toMatchObject({ desiredState: 'deleting' });
    expect(await services.get(service.id)).toMatchObject({
      lastErrorCode: 'NETWORK_CLEANUP_INCOMPLETE',
    });
    expect(await db.operation.count({ where: { kind: 'domain_unbind' } })).toBe(0);
    const retry = await services.retryOperation(deletion.id, actor, randomUUID());
    expect(await runOperation(retry.id, serviceExecutor)).toBeNull();
    expect(beforeServiceDelete).toHaveBeenCalledTimes(2);
    expect(workloads.operate).toHaveBeenCalledTimes(1);
    expect(effects).toEqual([
      'network-delete',
      'network-delete',
      'network-delete',
      'workload-delete',
    ]);
    expect(manager.remove.mock.calls[1]![1].taskId).toBe(retry.id);
    expect(await db.domain.count({ where: { id: domain.id } })).toBe(0);
    expect(await db.service.count({ where: { id: service.id } })).toBe(0);
    expect(await db.serviceMutation.count()).toBe(0);
    expect(await db.operation.count({ where: { kind: 'domain_unbind' } })).toBe(0);
    expect(
      await db.networkManagedResource.count({ where: { scope: 'environment', deletedAt: null } }),
    ).toBe(2);
    expect(
      await db.managedResource.count({ where: { kind: 'Service', deletedAt: { not: null } } }),
    ).toBe(1);
    expect(await repository.get(retry.id)).toMatchObject({ status: 'succeeded', serviceId: null });
  });

  it('reconciles a failed binding after republication without changing its hostname or stable port identity', async () => {
    await configure();
    const service = await publishedService();
    manager.apply.mockImplementationOnce(async (_connection, plan, hooks) => {
      await writeResource(
        plan,
        descriptors(plan).find((resource) => resource.kind === 'Ingress')!,
        hooks,
      );
      throw new NetworkingAdapterError(
        'NETWORK_APPLY_PARTIAL',
        'Controlled bind interruption.',
        true,
      );
    });
    const failed = await bind(service.id);
    expect(await runOperation(failed.id)).toMatchObject({ code: 'NETWORK_APPLY_PARTIAL' });
    const original = domainOperationInput(failed.input);
    const ingress = await db.networkManagedResource.findFirstOrThrow({
      where: { domainId: original.domainId, kind: 'Ingress' },
    });
    expect(ingress.uid).not.toBeNull();
    const current = await services.get(service.id);
    await services.update(service.id, {
      revision: current.revision,
      configuration: {
        image: current.configuration.image,
        ports: [{ ...httpPort, containerPort: 9090, servicePort: 9090 }],
      },
    });
    const published = await publishFixtureService(service.id);
    await expect(commands.retryOperation(failed.id, actor, randomUUID())).rejects.toMatchObject({
      code: 'DOMAIN_TASK_SUPERSEDED',
    });
    const domain = await commands.get(original.domainId);
    const reconcile = await commands.action(
      domain.id,
      'reconcile',
      { revision: domain.revision },
      actor,
      randomUUID(),
    );
    const input = domainOperationInput(reconcile.input);
    expect(input).toMatchObject({
      domainId: original.domainId,
      hostname: original.hostname,
      serviceMutationRevision: published.mutationRevision,
      certificateEnvironment: 'staging',
      target: { portId: original.target.portId, portName: original.target.portName },
    });
    expect(input.domainRevision).toBe(original.domainRevision + 1);
    expect(input.target.serviceUid).not.toBe(original.target.serviceUid);
    expect(await runOperation(reconcile.id)).toBeNull();
    expect(await commands.get(domain.id)).toMatchObject({
      id: original.domainId,
      hostname: original.hostname,
      servicePort: {
        id: original.target.portId,
        containerPort: 9090,
        servicePort: 9090,
        publishedConfigRevision: 2,
      },
      certificateEnvironment: 'staging',
      route: { state: 'ready' },
    });
    expect(await db.domain.count({ where: { serviceId: service.id } })).toBe(1);
    expect(manager.apply.mock.calls[1]![1]).toMatchObject({
      reconcileMissing: true,
      target: { serviceUid: input.target.serviceUid },
    });
    expect(
      await db.networkManagedResource.findUniqueOrThrow({ where: { id: ingress.id } }),
    ).toMatchObject({
      uid: ingress.uid,
      creationNonce: ingress.creationNonce,
      revision: input.domainRevision,
      deletedAt: null,
    });
    expect(
      remoteWrites.filter((intent) => intent.name === ingress.name).map((intent) => intent.action),
    ).toEqual(['create', 'replace']);
  });

  it('allows reads during restore lock while rejecting settings, domain admission and execution writes', async () => {
    await configure();
    const service = await publishedService();
    const other = await publishedService();
    const task = await bind(service.id);
    const input = domainOperationInput(task.input);
    const lease = await repository.claim(task.id, 'network-restore-fixture');
    if (!lease) throw new Error('Expected claimable operation before restore lock');
    const otherPort = (await commands.serviceNetworking(other.id)).eligiblePorts[0]!;
    const operationsBefore = await db.operation.count();
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true },
    });
    expect((await commands.get(input.domainId)).hostname).toBe(input.hostname);
    expect((await commands.platformSettings()).revision).toBe(1);
    expect((await commands.list()).data).toHaveLength(1);
    await expect(
      commands.updatePlatformSettings({ revision: 1, ...platformInput }),
    ).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    await expect(
      commands.updateClusterNetworking(fixture.cluster.id, {
        revision: 1,
        subdomain: fixture.cluster.slug,
        entryAddresses: ['192.0.2.43'],
        cnameTarget: null,
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    await expect(
      commands.bind(
        other.id,
        { revision: other.revision, portId: otherPort.id },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    for (const action of ['sync', 'unbind', 'production', 'reconcile'] as const)
      await expect(
        commands.action(
          input.domainId,
          action,
          { revision: input.domainRevision },
          actor,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    await expect(
      commands.clusterAction(
        fixture.cluster.id,
        'cluster_cert_manager_install',
        { revision: 1 },
        actor,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    await expect(executor.execute(lease, new AbortController().signal)).rejects.toBeInstanceOf(
      TaskExecutionError,
    );
    expect(await db.operation.count()).toBe(operationsBefore);
    expect(await db.networkManagedResource.count()).toBe(0);
    expect(remoteWrites).toHaveLength(0);
    expect(dns.inspect).not.toHaveBeenCalled();
    expect(manager.apply).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.installCertManager).not.toHaveBeenCalled();
  });
});
