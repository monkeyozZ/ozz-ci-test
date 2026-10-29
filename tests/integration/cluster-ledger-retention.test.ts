import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClustersService } from '../../apps/api/src/modules/clusters/clusters.service.js';
import type { SecretsService } from '../../apps/api/src/modules/secrets/secrets.service.js';
import { requestAuditContext } from '../../packages/control-plane/dist/audit.js';
import { NetworkingCommands } from '../../packages/control-plane/src/networking/commands.js';
import {
  networkInventory,
  reserveNetworkResource,
} from '../../packages/control-plane/src/networking/ledger.js';
import type { ServiceTarget } from '../../packages/control-plane/src/services/contracts.js';
import { inventory } from '../../packages/control-plane/src/services/persistence.js';
import { TaskRepository } from '../../packages/control-plane/src/tasks/repository.js';
import {
  PrismaService,
  type Cluster,
  type ManagedResource,
  type Prisma,
} from '../../packages/database/dist/index.js';
import type {
  NetworkClusterTarget,
  NetworkResourceDescriptor,
} from '../../packages/infrastructure/dist/networking.js';

// This suite seeds S3 rows, upgrades through S4 and the current schema, and exercises registration metadata
// only. Kubernetes identities are fixtures; no connection or remote mutation runs.
const execute = promisify(execFile);
const schema = `clusterledger_${randomUUID().replaceAll('-', '')}`;
if (!process.env.DATABASE_URL) throw new Error('Cluster ledger tests require PostgreSQL.');
const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-cluster-ledger-'));
const copiedSchema = join(directory, 'schema.prisma');
const copiedMigrations = join(directory, 'migrations');
const sourceSchema = fileURLToPath(
  new URL('../../packages/database/prisma/schema.prisma', import.meta.url),
);
const sourceMigrations = fileURLToPath(
  new URL('../../packages/database/prisma/migrations/', import.meta.url),
);
const s4Migration = '202610260002_s4_networking';
const componentNamespace = {
  apiVersion: 'v1',
  kind: 'Namespace',
  namespace: '',
  name: 'cert-manager',
  role: 'component-namespace',
  scope: 'cluster',
} satisfies NetworkResourceDescriptor;
const db = new PrismaService({ datasourceUrl: databaseUrl.toString() });
// Registrations in this suite contain no credential. Encryption/validation is
// covered separately, and constructing that service would read the live key file.
const secrets = {
  assertUsableReference: vi
    .fn<SecretsService['assertUsableReference']>()
    .mockResolvedValue(undefined),
} as unknown as SecretsService;
const clusters = new ClustersService(db, secrets);
const repository = new TaskRepository(db);
let adminId: string;
let installationId: string;
let generation: number;
let legacy: { target: ServiceTarget; rows: ManagedResource[] };
let legacyDeleteRule: string;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function migrateCopiedSchema() {
  await execute(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../packages/database/node_modules/prisma/build/index.js', import.meta.url),
      ),
      'migrate',
      'deploy',
      '--schema',
      copiedSchema,
    ],
    { env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, timeout: 25_000 },
  );
}

async function registeredCluster(
  kubeSystemUid: string = randomUUID(),
  slug = `ledger-${randomUUID().slice(0, 8)}`,
) {
  const registered = await clusters.create({ name: 'Ledger retention fixture', slug });
  return db.cluster.update({
    where: { id: registered.data.id },
    data: {
      kubeSystemUid,
      caFingerprint: 'sha256:' + 'a'.repeat(64),
      apiEndpoint: 'https://127.0.0.1:65534',
      connectionStatus: 'connected',
    },
  });
}

function serviceTarget(cluster: Pick<Cluster, 'id' | 'kubeSystemUid'>): ServiceTarget {
  return {
    installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid!,
    projectId: randomUUID(),
    environmentId: randomUUID(),
    serviceId: randomUUID(),
    namespace: 'ozz-retained-environment',
    serviceName: 'ozz-retained-service',
  };
}

function clusterTarget(cluster: Cluster): NetworkClusterTarget {
  return {
    installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid!,
    caFingerprint: cluster.caFingerprint!,
  };
}

async function managedRows(cluster: Pick<Cluster, 'id'>, target: ServiceTarget) {
  const rows: ManagedResource[] = [];
  for (const resource of [
    { kind: 'Namespace', namespace: '', name: target.namespace, removed: false },
    { kind: 'Service', namespace: target.namespace, name: target.serviceName, removed: true },
  ]) {
    const { removed, ...identity } = resource;
    const uid = randomUUID();
    const creationNonce = randomUUID();
    const observedAt = new Date(Date.now() - 60_000);
    rows.push(
      await db.managedResource.create({
        data: {
          clusterId: cluster.id,
          ...identity,
          targetJson: json(target),
          creationNonce,
          creationAttempted: true,
          uid,
          resourceVersion: '31',
          mutationRevision: 3,
          deletedAt: removed ? observedAt : null,
          receiptJson: json({
            ...identity,
            action: removed ? 'deleted' : 'created',
            uid,
            creationNonce,
            resourceVersion: '31',
            mutationRevision: 3,
            generation: 1,
            specFingerprint: 'b'.repeat(64),
            observedAt: observedAt.toISOString(),
          }),
        },
      }),
    );
  }
  return rows;
}

async function networkRows(cluster: Cluster, target: ServiceTarget) {
  const domainTarget = {
    ...target,
    serviceUid: randomUUID(),
    domainId: randomUUID(),
    hostname: 'retained.apps.example.test',
    portId: randomUUID(),
    portName: 'http',
  };
  const resources: Array<{
    descriptor: NetworkResourceDescriptor;
    owner: object;
    removed: boolean;
  }> = [
    { descriptor: componentNamespace, owner: clusterTarget(cluster), removed: false },
    {
      descriptor: {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Issuer',
        namespace: target.namespace,
        name: 'ozz-staging-issuer',
        role: 'issuer',
        scope: 'environment',
      },
      owner: domainTarget,
      removed: false,
    },
    {
      descriptor: {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        namespace: target.namespace,
        name: 'ozz-retained-route',
        role: 'route',
        scope: 'domain',
      },
      owner: domainTarget,
      removed: true,
    },
  ];
  const rows = [];
  for (const { descriptor, owner, removed } of resources) {
    const uid = randomUUID();
    const creationNonce = randomUUID();
    const observedAt = new Date(Date.now() - 60_000);
    rows.push(
      await db.networkManagedResource.create({
        data: {
          clusterId: cluster.id,
          ...descriptor,
          targetJson: json(owner),
          creationNonce,
          creationAttempted: true,
          uid,
          resourceVersion: '71',
          revision: 1,
          ledgerVersion: 3,
          deletedAt: removed ? observedAt : null,
          receiptJson: json({
            ...descriptor,
            action: removed ? 'deleted' : 'created',
            uid,
            creationNonce,
            resourceVersion: '71',
            revision: 1,
            specFingerprint: 'c'.repeat(64),
            observedAt: observedAt.toISOString(),
          }),
        },
      }),
    );
  }
  return rows;
}

async function ledgerFixture() {
  const cluster = await registeredCluster();
  const target = serviceTarget(cluster);
  return {
    cluster,
    target,
    managed: await managedRows(cluster, target),
    network: await networkRows(cluster, target),
  };
}

async function operation(cluster: Cluster, status: 'queued' | 'failed' = 'failed') {
  return db.operation.create({
    data: {
      kind: 'cluster_network_check',
      scope: 'cluster',
      status,
      clusterId: cluster.id,
      input: {
        clusterId: cluster.id,
        installationId,
        kubeSystemUid: cluster.kubeSystemUid!,
        clusterConnectionRevision: cluster.connectionRevision,
        networkRevision: 1,
      },
      result: status === 'failed' ? { diagnostic: 'retained-history' } : undefined,
      finishedAt: status === 'failed' ? new Date() : null,
      generation,
      createdById: adminId,
      idempotencyScope: 'cluster-ledger-fixture',
      idempotencyKey: randomUUID(),
      requestHash: 'd'.repeat(64),
    },
  });
}

async function deleteWithAudit(cluster: Cluster) {
  const requestId = randomUUID();
  await requestAuditContext.run(
    {
      actorId: adminId,
      requestId,
      action: 'delete:/api/clusters/:id',
      resourceType: 'clusters',
      resourceId: cluster.id,
    },
    () => clusters.delete(cluster.id, cluster.revision),
  );
  return requestId;
}

beforeAll(async () => {
  mkdirSync(copiedMigrations);
  copyFileSync(sourceSchema, copiedSchema);
  copyFileSync(
    join(sourceMigrations, 'migration_lock.toml'),
    join(copiedMigrations, 'migration_lock.toml'),
  );
  const migrations = readdirSync(sourceMigrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of migrations.filter((name) => name < s4Migration))
    cpSync(join(sourceMigrations, name), join(copiedMigrations, name), { recursive: true });
  await migrateCopiedSchema();
  await db.onModuleInit();
  const state = await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  installationId = state.installationId;
  generation = state.generation;
  adminId = (
    await db.admin.create({
      data: { username: 'cluster-ledger-fixture', passwordHash: 'fixture-login-disabled' },
    })
  ).id;
  // Do not use the current Prisma Cluster model against the intentionally old
  // S3 schema: later stages add columns that did not exist in retained installs.
  const cluster = { id: randomUUID(), kubeSystemUid: randomUUID() };
  await db.$executeRaw`INSERT INTO "Cluster" ("id", "name", "slug", "kubeSystemUid", "updatedAt") VALUES (${cluster.id}::uuid, 'Retained S3 cluster', 'retained-s3', ${cluster.kubeSystemUid}, CURRENT_TIMESTAMP)`;
  const target = serviceTarget(cluster);
  legacy = { target, rows: await managedRows(cluster, target) };
  const [constraint] = await db.$queryRaw<Array<{ deletion: string }>>`
    SELECT c.confdeltype::text AS deletion FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = ${schema} AND c.conname = 'ManagedResource_clusterId_fkey'
  `;
  legacyDeleteRule = constraint!.deletion;
  for (const name of migrations.filter((name) => name >= s4Migration))
    cpSync(join(sourceMigrations, name), join(copiedMigrations, name), { recursive: true });
  await migrateCopiedSchema();
});

afterEach(async () => {
  await db.controlPlaneState.update({
    where: { id: 'control-plane' },
    data: { restoreLocked: false },
  });
});

afterAll(async () => {
  try {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('cluster registration removal retains resource ledgers', () => {
  it('upgrades existing S3 rows without rewriting identity or receipt fields', async () => {
    expect(legacyDeleteRule).toBe('r');
    for (const row of legacy.rows)
      expect(await db.managedResource.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    const constraints = await db.$queryRaw<Array<{ name: string; deletion: string }>>`
      SELECT c.conname AS name, c.confdeltype::text AS deletion FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = ${schema}
      AND c.conname IN ('ManagedResource_clusterId_fkey', 'NetworkManagedResource_clusterId_fkey')
      ORDER BY c.conname
    `;
    expect(constraints).toEqual([
      { name: 'ManagedResource_clusterId_fkey', deletion: 'n' },
      { name: 'NetworkManagedResource_clusterId_fkey', deletion: 'n' },
    ]);
    const columns = await db.$queryRaw<Array<{ table_name: string; is_nullable: string }>>`
      SELECT table_name, is_nullable FROM information_schema.columns
      WHERE table_schema = ${schema} AND column_name = 'clusterId'
      AND table_name IN ('ManagedResource', 'NetworkManagedResource') ORDER BY table_name
    `;
    expect(columns).toEqual([
      { table_name: 'ManagedResource', is_nullable: 'YES' },
      { table_name: 'NetworkManagedResource', is_nullable: 'YES' },
    ]);
  });

  it('detaches both live and deleted ledger rows, keeps terminal tasks and audits their original owner', async () => {
    const fixture = await ledgerFixture();
    const history = await operation(fixture.cluster);
    const requestId = await deleteWithAudit(fixture.cluster);
    expect(await db.cluster.findUnique({ where: { id: fixture.cluster.id } })).toBeNull();
    for (const row of fixture.managed)
      expect(await db.managedResource.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
        ...row,
        clusterId: null,
      });
    for (const row of fixture.network)
      expect(await db.networkManagedResource.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
        ...row,
        clusterId: null,
      });
    expect(await db.operation.findUniqueOrThrow({ where: { id: history.id } })).toEqual({
      ...history,
      clusterId: null,
    });
    const audits = await db.auditEvent.findMany({
      where: { action: 'cluster.unregister', resourceId: fixture.cluster.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: adminId,
      requestId,
      resourceType: 'cluster',
      outcome: 'succeeded',
      metadata: {
        clusterId: fixture.cluster.id,
        kubeSystemUid: fixture.cluster.kubeSystemUid,
        retainedManagedResources: 2,
        retainedNetworkResources: 3,
      },
    });
  });

  it('does not adopt detached ledgers or replay old tasks when the same physical cluster is registered again', async () => {
    const fixture = await ledgerFixture();
    const history = await operation(fixture.cluster);
    await deleteWithAudit(fixture.cluster);
    const replacement = await registeredCluster(
      fixture.cluster.kubeSystemUid!,
      fixture.cluster.slug,
    );
    expect(replacement.id).not.toBe(fixture.cluster.id);
    const owner = clusterTarget(replacement);
    expect(await networkInventory(db, owner)).toEqual([]);
    expect(
      await db.$transaction((tx) =>
        inventory(tx, { ...fixture.target, clusterId: replacement.id }),
      ),
    ).toEqual([]);
    expect(await db.managedResource.count({ where: { clusterId: replacement.id } })).toBe(0);
    const reserved = await db.$transaction((tx) =>
      reserveNetworkResource(tx, owner, componentNamespace, true),
    );
    const original = fixture.network.find((row) => row.kind === 'Namespace')!;
    expect(reserved).toMatchObject({
      uid: null,
      creationAttempted: false,
      revision: 0,
      ledgerVersion: 0,
    });
    expect(reserved.creationNonce).not.toBe(original.creationNonce);
    const current = await db.networkManagedResource.findUniqueOrThrow({
      where: {
        clusterId_kind_namespace_name: {
          clusterId: replacement.id,
          kind: componentNamespace.kind,
          namespace: componentNamespace.namespace,
          name: componentNamespace.name,
        },
      },
    });
    expect(current.id).not.toBe(original.id);
    expect(current.targetJson).toEqual(owner);
    expect(
      await db.networkManagedResource.findUniqueOrThrow({ where: { id: original.id } }),
    ).toEqual({ ...original, clusterId: null });
    const commands = new NetworkingCommands(repository);
    await expect(
      commands.retryOperation(history.id, { id: adminId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'CLUSTER_NOT_CONNECTED' });
    expect(await db.operation.count({ where: { retryOfId: history.id } })).toBe(0);
    expect((await db.operation.findUniqueOrThrow({ where: { id: history.id } })).input).toEqual(
      history.input,
    );
    await deleteWithAudit(replacement);
    expect(
      await db.networkManagedResource.count({
        where: { id: { in: [original.id, current.id] }, clusterId: null },
      }),
    ).toBe(2);
  });

  it('still rejects removal of an empty project target without detaching its ledgers', async () => {
    const fixture = await ledgerFixture();
    await db.project.create({
      data: {
        clusterId: fixture.cluster.id,
        name: 'Empty fixture project',
        slug: `empty-${randomUUID().slice(0, 8)}`,
      },
    });
    await expect(
      clusters.delete(fixture.cluster.id, fixture.cluster.revision),
    ).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' });
    expect(await db.cluster.findUniqueOrThrow({ where: { id: fixture.cluster.id } })).toEqual(
      fixture.cluster,
    );
    expect(await db.managedResource.count({ where: { clusterId: fixture.cluster.id } })).toBe(2);
    expect(
      await db.networkManagedResource.count({ where: { clusterId: fixture.cluster.id } }),
    ).toBe(3);
    expect(
      await db.auditEvent.count({
        where: { action: 'cluster.unregister', resourceId: fixture.cluster.id },
      }),
    ).toBe(0);
  });

  it.each(['queued', 'running'] as const)(
    'still rejects removal while a %s operation owns the cluster',
    async (status) => {
      const fixture = await ledgerFixture();
      const task = await operation(fixture.cluster, 'queued');
      if (status === 'running')
        expect(await repository.claim(task.id, 'cluster-ledger-worker')).not.toBeNull();
      await expect(
        clusters.delete(fixture.cluster.id, fixture.cluster.revision),
      ).rejects.toMatchObject({ code: 'RESOURCE_OPERATION_ACTIVE' });
      expect((await db.operation.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
        status,
      );
      expect(await db.managedResource.count({ where: { clusterId: fixture.cluster.id } })).toBe(2);
      expect(
        await db.networkManagedResource.count({ where: { clusterId: fixture.cluster.id } }),
      ).toBe(3);
      expect(
        await db.auditEvent.count({
          where: { action: 'cluster.unregister', resourceId: fixture.cluster.id },
        }),
      ).toBe(0);
    },
  );

  it.each(['stale revision', 'restore lock'] as const)(
    'keeps the registration and ledger association after %s rejection',
    async (reason) => {
      const fixture = await ledgerFixture();
      if (reason === 'restore lock')
        await db.controlPlaneState.update({
          where: { id: 'control-plane' },
          data: { restoreLocked: true },
        });
      await expect(
        clusters.delete(
          fixture.cluster.id,
          fixture.cluster.revision + (reason === 'stale revision' ? 1 : 0),
        ),
      ).rejects.toMatchObject({
        code: reason === 'stale revision' ? 'REVISION_CONFLICT' : 'RESTORE_READ_ONLY',
      });
      expect(await db.cluster.findUniqueOrThrow({ where: { id: fixture.cluster.id } })).toEqual(
        fixture.cluster,
      );
      for (const row of fixture.managed)
        expect(await db.managedResource.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
      for (const row of fixture.network)
        expect(
          await db.networkManagedResource.findUniqueOrThrow({ where: { id: row.id } }),
        ).toEqual(row);
      expect(
        await db.auditEvent.count({
          where: { action: 'cluster.unregister', resourceId: fixture.cluster.id },
        }),
      ).toBe(0);
    },
  );
});
