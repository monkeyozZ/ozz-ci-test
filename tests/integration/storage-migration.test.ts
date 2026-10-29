import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaClient,
  type Prisma,
  type PrismaService,
} from '../../packages/database/dist/index.js';
import { ProjectsService } from '../../apps/api/src/modules/projects/projects.service.js';
import { EnvironmentsService } from '../../apps/api/src/modules/environments/environments.service.js';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';
import { establishDatabaseFence } from '../../packages/control-plane/src/databases/protection.js';
import { saveDatabaseVerification } from '../../packages/control-plane/src/databases/runtime.js';
import { serviceInclude } from '../../packages/control-plane/src/services/persistence.js';
import type { DatabaseVerification } from '../../packages/infrastructure/src/workload/contracts.js';

// Real S4 -> S5 migration, followed by retained data protections on the current
// schema. The intermediate upgrade is checked before any later migration runs.
// No Kubernetes calls, no writes to the shared public schema or application data.
const execute = promisify(execFile);
const schema = `s5integrity_${randomUUID().replaceAll('-', '')}`;
if (!process.env.DATABASE_URL) throw new Error('Storage migration tests require PostgreSQL.');
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', schema);
const directory = mkdtempSync(join(tmpdir(), 'ozz-s5-integrity-'));
const migrations = fileURLToPath(
  new URL('../../packages/database/prisma/migrations/', import.meta.url),
);
const s5 = '202610260003_s5_storage';
const db = new PrismaClient({ datasourceUrl: url.toString() });
const cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
const ids = {
  cluster: randomUUID(),
  project: randomUUID(),
  environment: randomUUID(),
  service: randomUUID(),
  resource: randomUUID(),
  domain: randomUUID(),
  port: randomUUID(),
  secret: randomUUID(),
};
let legacy: unknown;
let upgradedS5: unknown;
let installationId: string;

async function migrate() {
  await execute(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../packages/database/node_modules/prisma/build/index.js', import.meta.url),
      ),
      'migrate',
      'deploy',
      '--schema',
      join(directory, 'schema.prisma'),
    ],
    { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 25_000 },
  );
}
async function legacyRows() {
  return db.$queryRaw`SELECT s."id",s."configJson",s."revision",r."uid",r."creationNonce",r."targetJson",d."hostname",d."revision" AS "domainRevision",sec."encryptedPayload",sec."nonce",sec."tag" FROM "Service" s JOIN "ManagedResource" r ON r."id"=${ids.resource}::uuid JOIN "Domain" d ON d."id"=${ids.domain}::uuid JOIN "SecretReference" sec ON sec."id"=${ids.secret}::uuid WHERE s."id"=${ids.service}::uuid`;
}
beforeAll(async () => {
  mkdirSync(join(directory, 'migrations'));
  cpSync(
    fileURLToPath(new URL('../../packages/database/prisma/schema.prisma', import.meta.url)),
    join(directory, 'schema.prisma'),
  );
  const entries = readdirSync(migrations).sort();
  const versioned = (entry: string) => /^\d{12}_/.test(entry);
  for (const entry of entries) {
    if (entry !== 'migration_lock.toml' && !(versioned(entry) && entry < s5)) continue;
    cpSync(join(migrations, entry), join(directory, 'migrations', entry), { recursive: true });
  }
  await migrate();
  const encrypted = cipher.encrypt('generic', { value: 'migration-fixture-only' });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO "Cluster" ("id","name","slug","kubeSystemUid","updatedAt") VALUES (${ids.cluster}::uuid,'Retained S4 cluster','retained-s4',${randomUUID()},CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "Project" ("id","name","slug","clusterId","updatedAt") VALUES (${ids.project}::uuid,'Retained S4 project','retained-s4',${ids.cluster}::uuid,CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "Environment" ("id","projectId","name","slug","updatedAt") VALUES (${ids.environment}::uuid,${ids.project}::uuid,'Production','production',CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "Service" ("id","environmentId","name","slug","configJson","updatedAt") VALUES (${ids.service}::uuid,${ids.environment}::uuid,'Retained application','retained-app','{"image":"fixture/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb,CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "ManagedResource" ("id","clusterId","environmentId","serviceId","kind","namespace","name","targetJson","creationNonce","uid","creationAttempted","updatedAt") VALUES (${ids.resource}::uuid,${ids.cluster}::uuid,${ids.environment}::uuid,${ids.service}::uuid,'Deployment','retained-namespace','retained-workload','{"version":1}'::jsonb,${randomUUID()}::uuid,${randomUUID()},true,CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "ServicePort" ("id","serviceId","name","protocol","containerPort","servicePort") VALUES (${ids.port}::uuid,${ids.service}::uuid,'http','http',8080,80)`;
    await tx.$executeRaw`INSERT INTO "Domain" ("id","serviceId","servicePortId","hostname","targetJson","portJson","updatedAt") VALUES (${ids.domain}::uuid,${ids.service}::uuid,${ids.port}::uuid,'retained.example.test','{"version":1}'::jsonb,'{"name":"http"}'::jsonb,CURRENT_TIMESTAMP)`;
    await tx.$executeRaw`INSERT INTO "SecretReference" ("id","name","kind","encryptedPayload","nonce","tag","keyVersion","updatedAt") VALUES (${ids.secret}::uuid,'Retained fixture','generic',${encrypted.encryptedPayload},${encrypted.nonce},${encrypted.tag},1,CURRENT_TIMESTAMP)`;
  });
  legacy = await legacyRows();
  cpSync(join(migrations, s5), join(directory, 'migrations', s5), { recursive: true });
  await migrate();
  upgradedS5 = await legacyRows();
  expect(upgradedS5).toEqual(legacy);
  expect(await db.volume.count({ where: { environmentId: ids.environment } })).toBe(0);
  expect(
    (await db.secretReference.findUniqueOrThrow({ where: { id: ids.secret } })).contentRevision,
  ).toBe(1);
  // New Prisma clients select new scalar fields even in old test helpers.
  // Apply later migrations only after proving the original S4 -> S5 behavior;
  // the remaining tests verify that current code still preserves S5 rules.
  const later = entries.filter((entry) => versioned(entry) && entry > s5);
  for (const entry of later)
    cpSync(join(migrations, entry), join(directory, 'migrations', entry), { recursive: true });
  if (later.length) await migrate();
  installationId = (
    await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } })
  ).installationId;
});
afterAll(async () => {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

async function context() {
  const suffix = randomUUID().slice(0, 8);
  const cluster = await db.cluster.create({
    data: { name: 'Data fixture', slug: `data-${suffix}`, kubeSystemUid: randomUUID() },
  });
  const project = await db.project.create({
    data: { name: 'Data fixture', slug: `data-${suffix}`, clusterId: cluster.id },
  });
  const environment = await db.environment.create({
    data: { name: 'Production', slug: 'production', projectId: project.id },
  });
  const volumeId = randomUUID();
  const namespace = `ozz-e-${environment.id.replaceAll('-', '')}`;
  const target = {
    installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid,
    projectId: project.id,
    environmentId: environment.id,
    namespace,
    volumeId,
  };
  const volume = await db.volume.create({
    data: {
      id: volumeId,
      name: 'Fixture data',
      slug: 'fixture-data',
      environmentId: environment.id,
      clusterId: cluster.id,
      namespace,
      targetJson: target,
      pvcName: `ozz-v-${volumeId.replaceAll('-', '')}`,
      requestedBytes: 1073741824n,
      storageClassName: 'local-path',
    },
  });
  return { cluster, project, environment, volume, target };
}
async function service(ctx: Awaited<ReturnType<typeof context>>, kind = 'application') {
  return db.service.create({
    data: {
      name: 'Fixture writer',
      slug: `writer-${randomUUID().slice(0, 8)}`,
      environmentId: ctx.environment.id,
      kind,
      configJson: { image: 'fixture/image:1' },
    },
  });
}
async function database(ctx: Awaited<ReturnType<typeof context>>) {
  const writer = await service(ctx, 'database');
  const secret = await db.secretReference.create({
    data: {
      name: 'Database fixture',
      kind: 'database',
      ...cipher.encrypt('database', { password: 'synthetic-database-password-only-for-tests' }),
    },
  });
  const database = await db.databaseInstance.create({
    data: {
      serviceId: writer.id,
      dataVolumeId: ctx.volume.id,
      originalServiceJson: { id: writer.id, name: writer.name, slug: writer.slug },
      engine: 'postgresql',
      majorVersion: 17,
      exactVersion: '17.fixture',
      templateId: 'postgresql',
      templateVersion: '1.0.0',
      image: 'fixture/postgres:17',
      dataLayout: 'postgresql-17-pgdata-v1',
      credentialRefId: secret.id,
      username: 'app',
      databaseName: 'app',
    },
  });
  return { writer, secret, database };
}

describe('S5 additive migration and durable data protections', () => {
  it('reports a clear retained-data conflict when deleting an otherwise empty project or environment', async () => {
    const ctx = await context();
    const projects = new ProjectsService(db as PrismaService);
    const environments = new EnvironmentsService(db as PrismaService);
    await expect(projects.delete(ctx.project.id, ctx.project.revision)).rejects.toMatchObject({
      code: 'RESOURCE_IN_USE',
    });
    const nonDefault = await db.environment.update({
      where: { id: ctx.environment.id },
      data: { slug: 'retained-data' },
    });
    await expect(environments.delete(nonDefault.id, nonDefault.revision)).rejects.toMatchObject({
      code: 'RESOURCE_IN_USE',
    });
    expect(
      (await db.volume.findUniqueOrThrow({ where: { id: ctx.volume.id } })).environmentId,
    ).toBe(ctx.environment.id);
  });
  it('caches database authentication during recovery without creating initialization intent or changing protection', async () => {
    const ctx = await context();
    const data = await database(ctx);
    const uid = randomUUID();
    await db.$transaction(async (tx) => {
      await establishDatabaseFence(tx, ctx.volume.id);
      await tx.volume.update({
        where: { id: ctx.volume.id },
        data: { creationAttempted: true, pvcUid: uid },
      });
    });
    const before = await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } });
    const verification: DatabaseVerification = {
      observedAt: new Date().toISOString(),
      state: 'ready',
      engine: 'postgresql',
      authenticated: true,
      expectedMajor: 17,
      observedMajor: 17,
      version: '17.fixture',
      username: 'app',
      databaseName: 'app',
      pod: {
        uid: randomUUID(),
        name: 'postgres-0',
        controller: { kind: 'StatefulSet', uid: randomUUID() },
      },
      redis: null,
      code: null,
      message: 'Verified fixture database.',
    };
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true },
    });
    try {
      await db.$transaction(async (tx) => {
        const currentService = await tx.service.findUniqueOrThrow({
          where: { id: data.writer.id },
          include: serviceInclude,
        });
        await saveDatabaseVerification(tx, currentService, verification, 'observation');
      });
      const after = await db.databaseInstance.findUniqueOrThrow({
        where: { id: data.database.id },
      });
      expect(after.observationJson).toMatchObject({
        state: 'ready',
        authenticated: true,
        pvcUid: uid,
      });
      expect(after.initializedAt).toBeNull();
      expect(after.initializationPvcUid).toEqual(before.initializationPvcUid);
      expect(after.initializationState).toEqual(before.initializationState);
      expect(after.initializationIntentJson).toEqual(before.initializationIntentJson);
      expect(after.initializationFenceAt).toEqual(before.initializationFenceAt);
      expect(after.protectionRevision).toBe(before.protectionRevision);
    } finally {
      await db.controlPlaneState.update({
        where: { id: 'control-plane' },
        data: { restoreLocked: false },
      });
    }
  });

  it('keeps an established data identity when later authentication fails and rejects another engine observation', async () => {
    const ctx = await context();
    const data = await database(ctx);
    const uid = randomUUID();
    const verification: DatabaseVerification = {
      observedAt: new Date().toISOString(),
      state: 'ready',
      engine: 'postgresql',
      authenticated: true,
      expectedMajor: 17,
      observedMajor: 17,
      version: '17.fixture',
      username: 'app',
      databaseName: 'app',
      pod: {
        uid: randomUUID(),
        name: 'postgres-0',
        controller: { kind: 'StatefulSet', uid: randomUUID() },
      },
      redis: null,
      code: null,
      message: 'Verified fixture database.',
    };
    await db.$transaction(async (tx) => {
      await establishDatabaseFence(tx, ctx.volume.id);
      await tx.volume.update({
        where: { id: ctx.volume.id },
        data: { creationAttempted: true, pvcUid: uid },
      });
      const currentService = await tx.service.findUniqueOrThrow({
        where: { id: data.writer.id },
        include: serviceInclude,
      });
      await saveDatabaseVerification(tx, currentService, verification);
    });
    const before = await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } });
    expect(before.initializedAt).not.toBeNull();
    await db.$transaction(async (tx) => {
      const currentService = await tx.service.findUniqueOrThrow({
        where: { id: data.writer.id },
        include: serviceInclude,
      });
      await saveDatabaseVerification(
        tx,
        currentService,
        {
          ...verification,
          state: 'failed',
          authenticated: false,
          code: 'DATABASE_AUTHENTICATION_FAILED',
          message: 'Authentication failed.',
        },
        'observation',
      );
    });
    const after = await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } });
    expect(after.observationJson).toMatchObject({ state: 'failed', authenticated: false });
    expect(after.initializedAt).toEqual(before.initializedAt);
    expect(after.initializationPvcUid).toBe(uid);
    expect(after.protectionRevision).toBe(before.protectionRevision);
    await expect(
      db.$transaction(async (tx) => {
        const currentService = await tx.service.findUniqueOrThrow({
          where: { id: data.writer.id },
          include: serviceInclude,
        });
        await saveDatabaseVerification(
          tx,
          currentService,
          { ...verification, engine: 'redis' },
          'observation',
        );
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_IDENTITY_INVALID' });
    expect(
      (await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } }))
        .observationJson,
    ).toEqual(after.observationJson);
  });
  it('preserves S4 service/domain/ledger identities and ciphertext without inventing Volumes', async () => {
    expect(upgradedS5).toEqual(legacy);
    expect(await legacyRows()).toEqual(legacy);
    expect(await db.volume.count({ where: { environmentId: ids.environment } })).toBe(0);
    expect(
      (await db.secretReference.findUniqueOrThrow({ where: { id: ids.secret } })).contentRevision,
    ).toBe(1);
  });
  it('blocks parent removal while a Volume is live and retains target/UID after confirmed destruction', async () => {
    const ctx = await context();
    await expect(db.environment.delete({ where: { id: ctx.environment.id } })).rejects.toThrow();
    const uid = randomUUID();
    await db.volume.update({
      where: { id: ctx.volume.id },
      data: {
        creationAttempted: true,
        pvcUid: uid,
        destroyedAt: new Date(),
        receiptJson: { action: 'deleted', uid },
      },
    });
    await db.environment.delete({ where: { id: ctx.environment.id } });
    await db.project.delete({ where: { id: ctx.project.id } });
    await db.cluster.delete({ where: { id: ctx.cluster.id } });
    const kept = await db.volume.findUniqueOrThrow({ where: { id: ctx.volume.id } });
    expect(kept.environmentId).toBeNull();
    expect(kept.clusterId).toBeNull();
    expect(kept.pvcUid).toBe(uid);
    expect(kept.targetJson).toEqual(ctx.target);
    await expect(db.volume.delete({ where: { id: kept.id } })).rejects.toThrow();
  });
  it('rejects a forged project/cluster target and a same-name replacement PVC UID', async () => {
    const ctx = await context();
    await expect(
      db.volume.update({
        where: { id: ctx.volume.id },
        data: { targetJson: { ...ctx.target, clusterId: randomUUID() } },
      }),
    ).rejects.toThrow();
    await db.volume.update({
      where: { id: ctx.volume.id },
      data: { creationAttempted: true, pvcUid: randomUUID() },
    });
    await expect(
      db.volume.update({ where: { id: ctx.volume.id }, data: { pvcUid: randomUUID() } }),
    ).rejects.toThrow();
  });
  it('enforces one writer and keeps its slot after draft removal until actual detachment', async () => {
    const ctx = await context();
    const a = await service(ctx),
      b = await service(ctx);
    const data = { volumeId: ctx.volume.id, mountPath: '/data', originalServiceJson: {} };
    const mount = await db.volumeMount.create({ data: { ...data, serviceId: a.id } });
    await db.volumeMount.update({ where: { id: mount.id }, data: { desired: false } });
    await expect(db.volumeMount.create({ data: { ...data, serviceId: b.id } })).rejects.toThrow();
    await db.volumeMount.update({ where: { id: mount.id }, data: { detachedAt: new Date() } });
    await expect(
      db.volumeMount.create({ data: { ...data, serviceId: b.id } }),
    ).resolves.toHaveProperty('serviceId', b.id);
  });
  it('rejects cross-environment mounts and target changes after references exist', async () => {
    const ctx = await context(),
      other = await context();
    const writer = await service(other);
    await expect(
      db.volumeMount.create({
        data: {
          volumeId: ctx.volume.id,
          serviceId: writer.id,
          mountPath: '/data',
          originalServiceJson: {},
        },
      }),
    ).rejects.toThrow();
    await db.volumeMount.create({
      data: {
        volumeId: other.volume.id,
        serviceId: writer.id,
        mountPath: '/data',
        originalServiceJson: {},
      },
    });
    await expect(
      db.service.update({ where: { id: writer.id }, data: { environmentId: ctx.environment.id } }),
    ).rejects.toThrow();
  });
  it('requires a data fence before the first possibly successful PVC write', async () => {
    const ctx = await context();
    const data = await database(ctx);
    await expect(
      db.volume.update({ where: { id: ctx.volume.id }, data: { creationAttempted: true } }),
    ).rejects.toThrow();
    await db.$transaction(async (tx) => {
      await establishDatabaseFence(tx, ctx.volume.id);
      await tx.volume.update({ where: { id: ctx.volume.id }, data: { creationAttempted: true } });
    });
    const kept = await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } });
    expect(kept.initializationFenceAt).not.toBeNull();
    expect(kept.initializedAt).toBeNull();
    await expect(
      db.databaseInstance.update({
        where: { id: kept.id },
        data: { initializationFenceAt: null, protectionRevision: 0 },
      }),
    ).rejects.toThrow();
  });
  it('preserves orphan database protection and credentials after deleting its Service', async () => {
    const ctx = await context();
    const data = await database(ctx);
    await db.$transaction((tx) => establishDatabaseFence(tx, ctx.volume.id));
    await db.service.delete({ where: { id: data.writer.id } });
    const kept = await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } });
    expect(kept.serviceId).toBeNull();
    expect(kept.credentialRefId).toBe(data.secret.id);
    await expect(
      db.databaseInstance.update({ where: { id: kept.id }, data: { majorVersion: 18 } }),
    ).rejects.toThrow();
    await expect(
      db.secretReference.delete({ where: { id: kept.credentialRefId } }),
    ).rejects.toThrow();
    const generic = await service(ctx);
    await expect(
      db.volumeMount.create({
        data: {
          serviceId: generic.id,
          volumeId: ctx.volume.id,
          mountPath: '/data',
          originalServiceJson: {},
        },
      }),
    ).rejects.toThrow();
  });
  it('blocks provider deletion at the SQL boundary while a consumer still has a desired connection', async () => {
    const ctx = await context();
    const data = await database(ctx);
    const consumer = await service(ctx);
    const binding = await db.databaseBinding.create({
      data: {
        consumerServiceId: consumer.id,
        databaseInstanceId: data.database.id,
        profile: 'url',
        mappingJson: { url: 'DATABASE_URL' },
      },
    });
    await expect(db.service.delete({ where: { id: data.writer.id } })).rejects.toThrow();
    expect(
      (await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } })).serviceId,
    ).toBe(data.writer.id);
    await db.databaseBinding.update({ where: { id: binding.id }, data: { desired: false } });
    await db.service.delete({ where: { id: data.writer.id } });
    expect(
      (await db.databaseInstance.findUniqueOrThrow({ where: { id: data.database.id } })).serviceId,
    ).toBeNull();
  });
  it('rejects credential payload revision changes but permits metadata rename and equivalent master-key rewrap', async () => {
    const ctx = await context();
    const data = await database(ctx);
    await db.$transaction((tx) => establishDatabaseFence(tx, ctx.volume.id));
    await expect(
      db.secretReference.update({
        where: { id: data.secret.id },
        data: { contentRevision: { increment: 1 } },
      }),
    ).rejects.toThrow();
    const replacementCipher = new SecretCipher({
      activeVersion: 2,
      keys: new Map([[2, randomBytes(32)]]),
    });
    const payload = cipher.decrypt(data.secret);
    const wrapped = await db.secretReference.update({
      where: { id: data.secret.id },
      data: {
        name: 'Renamed database credential',
        ...replacementCipher.encrypt('database', payload),
      },
    });
    expect(wrapped.contentRevision).toBe(data.secret.contentRevision);
    expect(replacementCipher.decrypt(wrapped)).toEqual(payload);
  });
  it('requires a durable Volume mutation slot and releases it with the same task terminal transaction', async () => {
    const ctx = await context();
    const input = {
      volumeId: ctx.volume.id,
      volumeRevision: 1,
      mutationRevision: 1,
      target: ctx.target,
    };
    const operation = (tx: Prisma.TransactionClient) =>
      tx.operation.create({
        data: {
          kind: 'volume_sync',
          scope: 'volume',
          clusterId: ctx.cluster.id,
          input,
          idempotencyScope: 'test-volume',
          idempotencyKey: randomUUID(),
          requestHash: 'a'.repeat(64),
          outbox: { create: {} },
        },
      });
    await expect(db.$transaction((tx) => operation(tx))).rejects.toThrow();
    const accepted = await db.$transaction(async (tx) => {
      const accepted = await operation(tx);
      await tx.volumeMutation.create({
        data: { volumeId: ctx.volume.id, operationId: accepted.id },
      });
      return accepted;
    });
    await expect(
      db.volumeMutation.delete({ where: { volumeId: ctx.volume.id } }),
    ).rejects.toThrow();
    await expect(
      db.operation.update({ where: { id: accepted.id }, data: { status: 'succeeded' } }),
    ).rejects.toThrow();
    await db.$transaction(async (tx) => {
      await tx.operation.update({
        where: { id: accepted.id },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
      await tx.volumeMutation.delete({ where: { volumeId: ctx.volume.id } });
    });
    expect(await db.volumeMutation.findUnique({ where: { volumeId: ctx.volume.id } })).toBeNull();
  });
  it('keeps maintenance independent of task completion and forbids two active records', async () => {
    const ctx = await context();
    const maintenance = await db.volumeMaintenance.create({
      data: {
        volumeId: ctx.volume.id,
        purpose: 'restore',
        state: 'active',
        intentJson: {},
        enteredAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(
      db.volumeMaintenance.create({
        data: {
          volumeId: ctx.volume.id,
          purpose: 'backup',
          intentJson: {},
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    expect(
      (await db.volumeMaintenance.findUniqueOrThrow({ where: { id: maintenance.id } })).state,
    ).toBe('active');
    await expect(
      db.volumeMaintenance.update({ where: { id: maintenance.id }, data: { state: 'closed' } }),
    ).rejects.toThrow();
    await db.volumeMaintenance.update({
      where: { id: maintenance.id },
      data: { state: 'closed', exitedAt: new Date() },
    });
  });
});
