import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient, type Service } from '../../packages/database/dist/index.js';
import {
  TaskRepository,
  TaskRuntime,
  type DeploymentLease,
  type DeploymentTaskView,
  type OperationActor,
  type ServiceOperationKind,
  type ServiceTaskTarget,
  type TaskRuntimeOptions,
} from '../../packages/control-plane/dist/tasks/index.js';

// Scheduler tests use real PostgreSQL constraints and real Redis/BullMQ. The
// handlers below intentionally have no Kubernetes side effects; S3 product
// deployment and protocol acceptance are separate from task durability.
const execute = promisify(execFile);
const taskRequire = createRequire(
  new URL('../../packages/control-plane/package.json', import.meta.url),
);
const { Queue } = taskRequire(
  'bullmq',
) as typeof import('../../packages/control-plane/node_modules/bullmq');
const { Redis } = taskRequire(
  'ioredis',
) as typeof import('../../packages/control-plane/node_modules/ioredis');
const schema = `s3tasks_${randomUUID().replaceAll('-', '')}`;
const queueName = `s3tasks-${randomUUID()}`;
const baseDatabaseUrl = process.env.DATABASE_URL;
const baseRedisUrl = process.env.REDIS_URL;
if (!baseDatabaseUrl || !baseRedisUrl)
  throw new Error('S3 task tests require PostgreSQL and Redis.');
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('schema', schema);
const runtimes: TaskRuntime[] = [];
const silentLogger = { info() {}, warn() {}, error() {} };
let db: PrismaClient;
let repository: TaskRepository;
let actor: OperationActor;
let redis: InstanceType<typeof Redis>;
let queue: InstanceType<typeof Queue>;
let target: Omit<ServiceTaskTarget, 'serviceName'>;
let sequence = 0;

async function until<T>(
  sample: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await sample();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error('Task condition was not reached before its deadline.');
}

function serviceTarget(service: Service): ServiceTaskTarget {
  return { ...target, serviceName: `ozz-s-${service.id.replaceAll('-', '')}` };
}

async function service(): Promise<Service> {
  return db.service.create({
    data: {
      environmentId: target.environmentId,
      name: `Task service ${++sequence}`,
      slug: `task-service-${sequence}`,
      configJson: { image: 'scheduler-fixture:fixed', replicas: 1 },
    },
  });
}

async function deployment(
  resource: Service,
  options: { key?: string; request?: unknown; retryOfId?: string; snapshot?: unknown } = {},
  repo = repository,
): Promise<DeploymentTaskView> {
  return repo.enqueueDeployment(
    actor,
    options.key ?? randomUUID(),
    {
      request: options.request ?? { serviceId: resource.id },
      retryOfId: options.retryOfId,
    },
    async (tx, { id }) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Service" WHERE "id" = ${resource.id}::uuid FOR UPDATE`,
      );
      const current = await tx.service.update({
        where: { id: resource.id },
        data: { mutationRevision: { increment: 1 } },
      });
      return {
        serviceId: current.id,
        input: { serviceId: current.id, mutationRevision: current.mutationRevision },
        mutationRevision: current.mutationRevision,
        configRevision: current.configRevision,
        snapshotJson: (options.snapshot ?? current.configJson) as Prisma.InputJsonValue,
        targetJson: serviceTarget(current) as unknown as Prisma.InputJsonValue,
        onAccepted: async () => {
          await tx.deploymentStage.createMany({
            data: ['resolving', 'deploying', 'waiting_healthy'].map((name) => ({
              deploymentId: id,
              name,
              attempt: 1,
              status: 'queued',
            })),
          });
        },
      };
    },
  );
}

async function serviceOperation(
  resource: Service,
  kind: ServiceOperationKind = 'service_stop',
  repo = repository,
) {
  return repo.enqueue(
    actor,
    randomUUID(),
    { kind, request: { serviceId: resource.id } },
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Service" WHERE "id" = ${resource.id}::uuid FOR UPDATE`,
      );
      const current = await tx.service.update({
        where: { id: resource.id },
        data: { mutationRevision: { increment: 1 } },
      });
      return {
        serviceId: current.id,
        input: {
          serviceId: current.id,
          mutationRevision: current.mutationRevision,
          snapshotId: ['service_restart', 'service_resume'].includes(kind) ? randomUUID() : null,
          target: serviceTarget(current),
        },
      };
    },
  );
}

async function beginStage(lease: DeploymentLease, name = 'resolving', repo = repository) {
  expect(
    await repo.checkpoint(lease, async (tx) => {
      await tx.deploymentStage.upsert({
        where: {
          deploymentId_attempt_name: {
            deploymentId: lease.deploymentId,
            attempt: lease.attempt,
            name,
          },
        },
        create: {
          deploymentId: lease.deploymentId,
          attempt: lease.attempt,
          name,
          status: 'running',
          startedAt: new Date(),
        },
        update: { status: 'running', startedAt: new Date() },
      });
    }),
  ).toBe(true);
}

function startRuntime(options: Partial<TaskRuntimeOptions> = {}) {
  const runtime = new TaskRuntime(repository, {
    redisUrl: baseRedisUrl!,
    queueName,
    logger: silentLogger,
    relayIntervalMs: 25,
    recoveryIntervalMs: 100,
    heartbeatIntervalMs: 100,
    ...options,
  });
  runtimes.push(runtime);
  runtime.start();
  return runtime;
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
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  const admin = await db.admin.create({
    data: { username: 'task-fixture', passwordHash: 'not-used-for-authentication' },
  });
  actor = { id: admin.id };
  const cluster = await db.cluster.create({ data: { name: 'Task fixture', slug: 'task-fixture' } });
  const project = await db.project.create({
    data: { clusterId: cluster.id, name: 'Task fixture', slug: 'task-fixture' },
  });
  const environment = await db.environment.create({
    data: { projectId: project.id, name: 'Production', slug: 'production' },
  });
  const state = await db.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  target = {
    installationId: state.installationId,
    clusterId: cluster.id,
    kubeSystemUid: randomUUID(),
    projectId: project.id,
    environmentId: environment.id,
    namespace: `ozz-e-${environment.id.replaceAll('-', '')}`,
  };
  repository = new TaskRepository(db, {
    leaseMs: 1500,
    leaseRenewMs: 200,
    retryBaseMs: 80,
    retryMaxMs: 160,
    recoveryAfterMs: 100,
    heartbeatTtlMs: 1000,
  });
  redis = new Redis(baseRedisUrl!, {
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    commandTimeout: 2000,
  });
  redis.on('error', () => {});
  await redis.ping();
  queue = new Queue(queueName, { connection: redis });
  queue.on('error', () => {});
  await queue.waitUntilReady();
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  if (queue) await queue.obliterate({ force: true });
  if (db)
    await db.$transaction(async (tx) => {
      await tx.controlPlaneState.update({
        where: { id: 'control-plane' },
        data: { restoreLocked: false },
      });
      await tx.operation.updateMany({
        where: { status: { in: ['queued', 'running'] } },
        data: { status: 'cancelled' },
      });
      await tx.deployment.updateMany({
        where: { status: { in: ['queued', 'running'] } },
        data: { status: 'cancelled' },
      });
      await tx.serviceMutation.deleteMany();
      await tx.outbox.deleteMany();
      await tx.service.deleteMany();
      await tx.operation.deleteMany();
      await tx.deployment.deleteMany();
      await tx.auditEvent.deleteMany();
      await tx.workerHeartbeat.deleteMany();
    });
});

afterAll(async () => {
  try {
    await queue?.close();
    redis?.disconnect();
    await db?.$disconnect();
  } finally {
    const cleanup = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
    try {
      await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.$disconnect();
    }
  }
});

describe('one durable task pipeline for deployments and service operations', () => {
  it('rolls back the entire deployment admission when its outbox cannot be persisted', async () => {
    const resource = await service();
    await db.$executeRawUnsafe(
      'ALTER TABLE "Outbox" ADD CONSTRAINT "s3_reject_outbox" CHECK (false) NOT VALID',
    );
    try {
      await expect(deployment(resource)).rejects.toThrow();
      expect(await db.deployment.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
      expect(await db.serviceMutation.count()).toBe(0);
      expect(await db.deploymentStage.count()).toBe(0);
      expect(await db.auditEvent.count()).toBe(0);
      expect(await db.service.findUnique({ where: { id: resource.id } })).toMatchObject({
        mutationRevision: 0,
      });
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "Outbox" DROP CONSTRAINT "s3_reject_outbox"');
    }
  });

  it('atomically admits one immutable deployment, slot, stages and outbox under concurrent idempotency', async () => {
    const resource = await service();
    const key = randomUUID();
    const accepted = await Promise.all(
      Array.from({ length: 5 }, () => deployment(resource, { key })),
    );
    expect(new Set(accepted.map((row) => row.id)).size).toBe(1);
    expect(await db.deployment.count()).toBe(1);
    expect(
      await db.serviceMutation.findUnique({ where: { serviceId: resource.id } }),
    ).toMatchObject({ deploymentId: accepted[0]!.id, operationId: null });
    expect(await db.outbox.findUnique({ where: { deploymentId: accepted[0]!.id } })).toMatchObject({
      operationId: null,
      publishedAt: null,
    });
    expect(await db.deploymentStage.count()).toBe(3);
    expect(await db.service.findUnique({ where: { id: resource.id } })).toMatchObject({
      mutationRevision: 1,
    });
    expect(await db.auditEvent.count({ where: { action: 'deployment.create' } })).toBe(1);
    await expect(
      deployment(resource, { key, request: { serviceId: resource.id, changed: true } }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      db.deployment.update({
        where: { id: accepted[0]!.id },
        data: { snapshotJson: { changed: true } },
      }),
    ).rejects.toThrow();
    expect((await repository.getDeployment(accepted[0]!.id)).snapshotJson).toEqual(
      resource.configJson,
    );
  });

  it('enforces one shared slot across a deployment and an operation, then releases it on queued cancellation', async () => {
    const resource = await service();
    const attempts = await Promise.allSettled([deployment(resource), serviceOperation(resource)]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    for (const result of attempts)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 409 });
    const slot = await db.serviceMutation.findUniqueOrThrow({ where: { serviceId: resource.id } });
    if (slot.deploymentId) await repository.cancelDeployment(slot.deploymentId, actor);
    else await repository.cancel(slot.operationId!, actor);
    expect(await db.serviceMutation.count()).toBe(0);
    const next = await serviceOperation(resource);
    expect(next).toMatchObject({
      serviceId: resource.id,
      clusterId: target.clusterId,
      status: 'queued',
    });
    expect(await db.serviceMutation.count()).toBe(1);
  });

  it('allows different services in one cluster while enforcing the combined queue capacity', async () => {
    const first = await service();
    const second = await service();
    const third = await service();
    const bounded = new TaskRepository(db, { maxPendingOperations: 2 });
    const one = await serviceOperation(first, 'service_stop', bounded);
    const two = await serviceOperation(second, 'service_stop', bounded);
    expect(one.clusterId).toBe(two.clusterId);
    await expect(deployment(third, {}, bounded)).rejects.toMatchObject({
      code: 'OPERATION_QUEUE_FULL',
    });
    await bounded.cancel(one.id, actor);
    const published = await deployment(third, {}, bounded);
    await expect(bounded.createDiagnostic(actor, randomUUID())).rejects.toMatchObject({
      code: 'OPERATION_QUEUE_FULL',
    });
    expect(await bounded.workerStatus()).toMatchObject({ queuedCount: 2, unpublishedCount: 2 });
    expect(published.status).toBe('queued');
  });

  it('rejects malformed outboxes and orphaned or reassigned active service slots in PostgreSQL', async () => {
    const resource = await service();
    const task = await deployment(resource);
    await expect(db.outbox.create({ data: {} })).rejects.toThrow();
    await expect(
      db.serviceMutation.delete({ where: { serviceId: resource.id } }),
    ).rejects.toThrow();
    expect(
      await db.serviceMutation.findUnique({ where: { serviceId: resource.id } }),
    ).toMatchObject({ deploymentId: task.id });
    const other = await service();
    await expect(
      db.serviceMutation.update({
        where: { serviceId: resource.id },
        data: { serviceId: other.id },
      }),
    ).rejects.toThrow();
    await expect(
      db.operation.create({
        data: {
          kind: 'service_stop',
          scope: 'service',
          input: {},
          idempotencyScope: 'malformed-operation',
          idempotencyKey: randomUUID(),
          requestHash: '0'.repeat(64),
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.deployment.create({
        data: {
          serviceId: other.id,
          input: { serviceId: other.id, mutationRevision: 1 },
          configRevision: 1,
          mutationRevision: 1,
          snapshotJson: {},
          targetJson: {},
          idempotencyScope: 'missing-slot',
          idempotencyKey: randomUUID(),
          requestHash: '0'.repeat(64),
        },
      }),
    ).rejects.toThrow();
    expect(await db.deployment.count()).toBe(1);
    const operation = await serviceOperation(other);
    await expect(
      db.$transaction(async (tx) => {
        // Remove the other Outbox inside this rolled-back transaction so the
        // exactly-one-owner CHECK, rather than its unique index, decides this case.
        await tx.outbox.delete({ where: { operationId: operation.id } });
        await tx.outbox.update({
          where: { deploymentId: task.id },
          data: { operationId: operation.id },
        });
      }),
    ).rejects.toThrow();
    expect(await db.outbox.count()).toBe(2);
  });

  it('fences duplicate deployment claims and stale workers while retaining a resolved artifact during recovery', async () => {
    const resource = await service();
    const task = await deployment(resource);
    const claims = await Promise.all([
      repository.claimDeployment(task.id, 'first'),
      repository.claimDeployment(task.id, 'duplicate'),
    ]);
    const lease = claims.find((value) => value !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect('operationId' in lease).toBe(false);
    await beginStage(lease);
    const artifact = { deployReference: `registry.invalid/app@sha256:${'a'.repeat(64)}` };
    expect(
      await repository.checkpoint(lease, async (tx) => {
        await tx.deployment.update({
          where: { id: task.id },
          data: { resolvedImageJson: artifact },
        });
      }),
    ).toBe(true);
    await db.deployment.update({
      where: { id: task.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    expect(await repository.recoverTask(lease.ref)).toBe(true);
    expect(await repository.complete(lease)).toBe(false);
    expect(await repository.progress(lease, 'stale worker')).toBe(false);
    const replacement = (await repository.claimDeployment(task.id, 'replacement'))!;
    expect(replacement.attempt).toBe(2);
    expect((await repository.getDeployment(task.id)).resolvedImageJson).toEqual(artifact);
    expect(await repository.complete(replacement, { result: artifact })).toBe(true);
    expect(await db.serviceMutation.count()).toBe(0);
    expect(
      await db.deploymentStage.findFirst({
        where: { deploymentId: task.id, attempt: 1, name: 'resolving' },
      }),
    ).toMatchObject({ status: 'failed', errorCode: 'EXECUTION_LEASE_EXPIRED' });
  });

  it('rolls back domain commits and slot release on errors or lease expiry, including late checkpoints', async () => {
    const resource = await service();
    const bounded = new TaskRepository(db, { leaseMs: 100, leaseRenewMs: 25 });
    const task = await deployment(resource, {}, bounded);
    const lease = (await bounded.claimDeployment(task.id, 'short-lease'))!;
    expect(
      await bounded.checkpoint(lease, async (tx) => {
        await tx.service.update({
          where: { id: resource.id },
          data: { description: 'must-roll-back' },
        });
        await delay(130);
      }),
    ).toBe(false);
    expect(await db.service.findUnique({ where: { id: resource.id } })).toMatchObject({
      description: null,
    });
    expect(await bounded.recoverTask(lease.ref)).toBe(true);
    const expiring = (await bounded.claimDeployment(task.id, 'expiring-commit'))!;
    expect(
      await bounded.complete(expiring, {
        result: { mustNotCommit: true },
        commit: async (tx) => {
          await tx.service.update({
            where: { id: resource.id },
            data: { description: 'late-completion' },
          });
          await delay(130);
        },
      }),
    ).toBe(false);
    expect(await db.serviceMutation.count()).toBe(1);
    expect(await bounded.getDeployment(task.id)).toMatchObject({ status: 'running', result: null });
    expect(await db.service.findUnique({ where: { id: resource.id } })).toMatchObject({
      description: null,
    });
    expect(await bounded.recoverTask(expiring.ref)).toBe(true);
    const current = (await repository.claimDeployment(task.id, 'valid-lease'))!;
    await expect(
      repository.complete(current, {
        result: { done: true },
        commit: async (tx) => {
          await tx.service.update({
            where: { id: resource.id },
            data: { description: 'rollback-with-task' },
          });
          throw new Error('SIMULATED_COMMIT_FAILURE');
        },
      }),
    ).rejects.toThrow('SIMULATED_COMMIT_FAILURE');
    expect(await db.serviceMutation.count()).toBe(1);
    expect(await repository.getDeployment(task.id)).toMatchObject({
      status: 'running',
      result: null,
    });
    expect(await db.service.findUnique({ where: { id: resource.id } })).toMatchObject({
      description: null,
    });
  });

  it('commits service deletion atomically after its operation is terminal and retains the target history', async () => {
    const resource = await service();
    const operation = await serviceOperation(resource, 'service_delete');
    const lease = (await repository.claim(operation.id, 'delete-worker'))!;
    expect(
      await repository.complete(lease, {
        result: { deleted: true },
        commit: async (tx) => {
          await tx.service.delete({ where: { id: resource.id } });
        },
      }),
    ).toBe(true);
    expect(await db.service.findUnique({ where: { id: resource.id } })).toBeNull();
    expect(await repository.get(operation.id)).toMatchObject({
      status: 'succeeded',
      serviceId: null,
      input: { serviceId: resource.id, target: serviceTarget(resource) },
    });
    expect(await db.serviceMutation.count()).toBe(0);
  });

  it('makes cancellation monotonic, closes stages and keeps already recorded side effects', async () => {
    const resource = await service();
    const queued = await deployment(resource);
    await repository.cancelDeployment(queued.id, actor);
    expect(await repository.claimDeployment(queued.id, 'late-worker')).toBeNull();
    expect(
      await db.deploymentStage.count({ where: { deploymentId: queued.id, status: 'skipped' } }),
    ).toBe(3);
    const task = await deployment(resource);
    const lease = (await repository.claimDeployment(task.id, 'running-worker'))!;
    await beginStage(lease);
    const appliedAt = new Date();
    expect(
      await repository.checkpoint(lease, async (tx) => {
        await tx.deployment.update({ where: { id: task.id }, data: { appliedAt } });
      }),
    ).toBe(true);
    expect(await repository.cancelDeployment(task.id, actor)).toMatchObject({ status: 'running' });
    expect(await db.serviceMutation.count()).toBe(1);
    expect(await repository.renew(lease)).toBe('cancel');
    let committed = false;
    expect(
      await repository.complete(lease, {
        result: {},
        commit: async () => {
          committed = true;
        },
      }),
    ).toBe(true);
    expect(committed).toBe(false);
    expect(await repository.getDeployment(task.id)).toMatchObject({
      status: 'cancelled',
      appliedAt: appliedAt.toISOString(),
    });
    expect(
      await db.deploymentStage.findFirst({ where: { deploymentId: task.id, name: 'resolving' } }),
    ).toMatchObject({ status: 'cancelled' });
    expect(await db.serviceMutation.count()).toBe(0);
  });

  it('blocks both task types during recovery and ends every old generation without replay', async () => {
    const deployed = await deployment(await service());
    const operation = await serviceOperation(await service());
    const lease = (await repository.claimDeployment(deployed.id, 'old-worker'))!;
    await beginStage(lease);
    const delivery = (await repository.claimDelivery())!;
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true, generation: { increment: 1 } },
    });
    await expect(repository.renew(lease)).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    await expect(repository.cancelDeployment(deployed.id, actor)).rejects.toMatchObject({
      code: 'RESTORE_READ_ONLY',
    });
    await expect(
      repository.publishDelivery(delivery, async () => {
        throw new Error('Publication must not run');
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_READ_ONLY' });
    expect(await repository.getDeployment(deployed.id)).toMatchObject({ status: 'running' });
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: false },
    });
    expect(await repository.recoverTask(lease.ref)).toBe(true);
    expect(await repository.recoverOperation(operation.id)).toBe(true);
    expect(await repository.getDeployment(deployed.id)).toMatchObject({
      status: 'failed',
      errorCode: 'RECOVERY_GENERATION_CHANGED',
    });
    expect(await repository.get(operation.id)).toMatchObject({
      status: 'failed',
      errorCode: 'RECOVERY_GENERATION_CHANGED',
    });
    expect(await repository.complete(lease)).toBe(false);
    expect(await db.serviceMutation.count()).toBe(0);
  });

  it('retains the shared slot on retryable requeue and releases it after attempts are exhausted', async () => {
    const resource = await service();
    const task = await deployment(resource);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = (await until(
        () => repository.claimDeployment(task.id, `attempt-${attempt}`),
        (value) => value !== null,
      ))!;
      await beginStage(lease);
      expect(await repository.fail(lease, 'TRANSIENT_FIXTURE', '受控暂时失败。', true)).toBe(true);
      const current = await repository.getDeployment(task.id);
      expect(current.status).toBe(attempt === 3 ? 'failed' : 'queued');
      expect(await db.serviceMutation.count()).toBe(attempt === 3 ? 0 : 1);
      expect(current.snapshotJson).toEqual(task.snapshotJson);
    }
    const history = await repository.getDeployment(task.id);
    const retried = await deployment(resource, {
      retryOfId: history.id,
      snapshot: history.snapshotJson,
    });
    expect(retried).toMatchObject({
      status: 'queued',
      attempts: 0,
      retryOfId: history.id,
      snapshotJson: history.snapshotJson,
    });
    expect(await repository.getDeployment(task.id)).toEqual(history);
  });

  it('runs deployments, service operations and legacy diagnostic payloads through one real BullMQ runtime', async () => {
    const deployed = await deployment(await service());
    const operation = await serviceOperation(await service());
    const diagnostic = await repository.createDiagnostic(actor, randomUUID(), { durationMs: 10 });
    const calls: string[] = [];
    const runtime = startRuntime({
      deploymentExecutor: {
        execute: async (lease) => {
          calls.push(`deployment:${lease.deploymentId}`);
          expect('operationId' in lease).toBe(false);
          await beginStage(lease);
          return { result: { executor: 'deployment', deploymentId: lease.deploymentId } };
        },
      },
      executor: {
        execute: async (lease) => {
          calls.push(`operation:${lease.operationId}`);
          return { result: { executor: 'operation', operationId: lease.operationId } };
        },
      },
    });
    await until(
      () => repository.getDeployment(deployed.id),
      (value) => value.status === 'succeeded',
    );
    await until(
      () => repository.get(operation.id),
      (value) => value.status === 'succeeded',
    );
    await until(
      () => repository.get(diagnostic.id),
      (value) => value.status === 'succeeded',
    );
    expect(runtime.health().status).toBe('ready');
    const duplicate = `legacy-${randomUUID()}`;
    await queue.add('diagnostic', { operationId: diagnostic.id }, { jobId: duplicate });
    await until(
      () => queue.getJobState(duplicate),
      (value) => value === 'completed',
    );
    expect(calls.sort()).toEqual([`deployment:${deployed.id}`, `operation:${operation.id}`].sort());
    expect(await db.serviceMutation.count()).toBe(0);
    expect((await repository.get(diagnostic.id)).attempts).toBe(1);
    expect(await repository.deploymentLogs(deployed.id)).toMatchObject({
      source: 'deployment',
      available: true,
    });
    expect(await repository.workerStatus()).toMatchObject({ queuedCount: 0, unpublishedCount: 0 });
  });

  it('recovers a deployment whose published Redis job disappeared and preserves explicit task routing', async () => {
    const task = await deployment(await service());
    const delivery = (await repository.claimDelivery())!;
    expect(delivery).toMatchObject({
      ref: { type: 'deployment', id: task.id },
      operationId: null,
      deploymentId: task.id,
    });
    expect(
      await repository.publishDelivery(delivery, async (jobId, id, ref) => {
        expect(id).toBe(task.id);
        await queue.add(ref.type, { task: ref }, { jobId });
      }),
    ).toBe(true);
    const job = await queue.getJob(delivery.jobId);
    expect(job!.data).toEqual({ task: { type: 'deployment', id: task.id } });
    await job!.remove();
    await db.outbox.update({
      where: { deploymentId: task.id },
      data: { publishedAt: new Date(Date.now() - 1000) },
    });
    startRuntime({
      deploymentExecutor: { execute: async () => ({ result: { recovered: true } }) },
    });
    const completed = await until(
      () => repository.getDeployment(task.id),
      (value) => value.status === 'succeeded',
    );
    expect(completed).toMatchObject({
      attempts: 1,
      snapshotJson: task.snapshotJson,
      result: null,
    });
    // This routing fixture never applies Kubernetes resources. Its durable
    // executor output is preserved without becoming an applied publication.
    expect(await db.deployment.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      result: { recovered: true },
      appliedAt: null,
    });
    expect(await db.outbox.findUnique({ where: { deploymentId: task.id } })).toMatchObject({
      deliverySequence: 1,
    });
  });

  it('bounds log retention across both tables while preserving historical outcomes and cursor ownership', async () => {
    const bounded = new TaskRepository(db, { retainedLogOperations: 1, logMaxBytes: 2048 });
    const first = await bounded.createDiagnostic(actor, randomUUID(), { durationMs: 0 });
    await bounded.complete((await bounded.claim(first.id, 'diagnostic'))!);
    const task = await deployment(await service(), {}, bounded);
    const lease = (await bounded.claimDeployment(task.id, 'logs'))!;
    for (let index = 0; index < 15; index += 1)
      await bounded.progress(lease, `Event ${index}: ${'x'.repeat(400)}`);
    await bounded.complete(lease, { result: { preserved: true } });
    const logs = await bounded.deploymentLogs(task.id, { limit: 1 });
    expect(logs).toMatchObject({ source: 'deployment', truncated: true, page: { hasMore: true } });
    await expect(bounded.logs(first.id, { cursor: logs.page.nextCursor! })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    expect(await bounded.clearExpiredLogs()).toBe(1);
    expect(await bounded.logs(first.id)).toMatchObject({
      available: false,
      unavailableReason: 'expired',
    });
    expect(await bounded.getDeployment(task.id)).toMatchObject({ result: null, appliedAt: null });
    expect(await db.deployment.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      result: { preserved: true },
    });
    expect(await bounded.deploymentLogs(task.id)).toMatchObject({ available: true });
    const bytes = Buffer.byteLength(
      JSON.stringify((await db.deployment.findUniqueOrThrow({ where: { id: task.id } })).logsJson),
    );
    expect(bytes).toBeLessThanOrEqual(2048);
  });
});
