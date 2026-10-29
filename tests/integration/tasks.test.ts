import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/dist/app.js';
import { PrismaClient } from '../../packages/database/dist/index.js';
import {
  TaskRepository,
  TaskRuntime,
  type OperationActor,
  type OperationView,
  type TaskRuntimeOptions,
} from '../../packages/control-plane/dist/tasks/index.js';
import { createTestSession } from './helpers.js';

// Resolve transport dependencies from their owning workspace, keeping the root
// test runner independent of implementation-specific runtime dependencies.
const taskRequire = createRequire(
  new URL('../../packages/control-plane/package.json', import.meta.url),
);
const { Queue } = taskRequire(
  'bullmq',
) as typeof import('../../packages/control-plane/node_modules/bullmq');
const { Redis } = taskRequire(
  'ioredis',
) as typeof import('../../packages/control-plane/node_modules/ioredis');
const execute = promisify(execFile);
const schema = `tasks_${randomUUID().replaceAll('-', '')}`;
const queueName = `tasks-${randomUUID()}`;
const baseDatabaseUrl = process.env.DATABASE_URL;
const baseRedisUrl = process.env.REDIS_URL;
if (!baseDatabaseUrl || !baseRedisUrl)
  throw new Error('Task integration tests require DATABASE_URL and REDIS_URL');
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set('schema', schema);

let app: Awaited<ReturnType<typeof createApp>>;
let session: Awaited<ReturnType<typeof createTestSession>>;
let db: PrismaClient;
let repository: TaskRepository;
let actor: OperationActor;
let queue: InstanceType<typeof Queue>;
let redis: InstanceType<typeof Redis>;
const runtimes: TaskRuntime[] = [];
const proxies: RedisFaultProxy[] = [];
const children: ChildProcess[] = [];
const silentLogger = { info() {}, warn() {}, error() {} };

/** Cut only this test's connections, never shut down the shared Redis server. */
class RedisFaultProxy {
  private enabled = false;
  private readonly sockets = new Set<Socket>();
  private readonly target = new URL(baseRedisUrl!);
  private readonly server: Server;
  url = '';

  constructor() {
    this.server = createServer((source) => {
      if (!this.enabled) {
        source.destroy();
        return;
      }
      const destination = connect({
        host: this.target.hostname,
        port: Number(this.target.port || 6379),
      });
      this.sockets.add(source);
      this.sockets.add(destination);
      source.on('error', () => destination.destroy());
      destination.on('error', () => source.destroy());
      source.once('close', () => {
        this.sockets.delete(source);
        destination.destroy();
      });
      destination.once('close', () => {
        this.sockets.delete(destination);
        source.destroy();
      });
      source.pipe(destination).pipe(source);
    });
  }

  async start(enabled = false): Promise<this> {
    this.enabled = enabled;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy port was not assigned');
    const url = new URL(this.target);
    url.hostname = '127.0.0.1';
    url.port = String(address.port);
    this.url = url.toString();
    proxies.push(this);
    return this;
  }

  setAvailable(available: boolean): void {
    this.enabled = available;
    if (!available) for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.setAvailable(false);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function until<T>(
  read: () => Promise<T> | T,
  ready: (value: T) => boolean,
  label: string,
  timeout = 12000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (ready(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  return app.inject({
    method,
    url: `/api${path}`,
    headers: { ...session.headers, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function createOperation(durationMs = 250, key = randomUUID()): Promise<OperationView> {
  const response = await request('POST', '/operations/diagnostics', { durationMs }, key);
  expect(response.statusCode, response.body).toBe(202);
  return response.json<{ data: OperationView }>().data;
}

function startRuntime(options: Partial<TaskRuntimeOptions> = {}): TaskRuntime {
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

async function operationWithStatus(id: string, status: string): Promise<OperationView> {
  return until(
    () => repository.get(id),
    (operation) => operation.status === status,
    `operation ${status}`,
  );
}

beforeAll(async () => {
  // Apply the real versioned schema in an isolated PostgreSQL namespace. The
  // recovery singleton and every fixture are independent of the development UI.
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
  process.env.DATABASE_URL = databaseUrl.toString();
  db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  await db.$connect();
  app = await createApp({ silent: true });
  session = await createTestSession(app, db);
  actor = { id: session.adminId };
  repository = new TaskRepository(db, {
    leaseMs: 1500,
    leaseRenewMs: 200,
    retryBaseMs: 100,
    retryMaxMs: 400,
    recoveryAfterMs: 200,
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
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const proxy of proxies.splice(0)) await proxy.close();
  if (queue) await queue.obliterate({ force: true });
  if (db) {
    await db.outbox.deleteMany();
    await db.operation.deleteMany();
    await db.auditEvent.deleteMany();
    await db.workerHeartbeat.deleteMany();
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: false },
    });
  }
});

afterAll(async () => {
  try {
    await queue?.close();
    redis?.disconnect();
    await session?.cleanup();
    await app?.close();
    await db?.$disconnect();
  } finally {
    process.env.DATABASE_URL = baseDatabaseUrl;
    const cleanup = new PrismaClient({ datasourceUrl: baseDatabaseUrl });
    try {
      // schema is generated locally from a UUID, never from request input.
      await cleanup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await cleanup.$disconnect();
    }
  }
});

describe('S1 durable operations with PostgreSQL and Redis', () => {
  it('accepts one durable command for concurrent idempotent requests and rejects different input', async () => {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request('POST', '/operations/diagnostics', { durationMs: 400 }, key),
      ),
    );
    for (const response of responses) expect(response.statusCode, response.body).toBe(202);
    const operations = responses.map((response) => response.json<{ data: OperationView }>().data);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(1);
    expect(operations[0]).toMatchObject({
      status: 'queued',
      attempts: 0,
      result: null,
      input: { durationMs: 400 },
    });
    expect(await db.operation.count()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'operation.create' } })).toBe(1);
    expect(
      (await request('POST', '/operations/diagnostics', { durationMs: 401 }, key)).statusCode,
    ).toBe(409);
    expect((await request('POST', '/operations/diagnostics', {})).statusCode).toBe(422);
    expect(
      (await request('POST', '/operations/diagnostics', { durationMs: 5001 }, randomUUID()))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await request(
          'POST',
          '/operations/diagnostics',
          { command: 'never-execute-user-code' },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(422);
    const response = await request('GET', `/operations/${operations[0]!.id}`);
    expect(response.statusCode).toBe(200);
    for (const internal of ['leaseToken', 'leaseOwner', 'idempotencyKey', 'requestHash'])
      expect(response.body).not.toContain(internal);
    expect((await app.inject({ method: 'GET', url: '/api/operations' })).statusCode).toBe(401);
    const invalidCursor = Buffer.from(
      JSON.stringify({
        type: 'operations',
        id: 'invalid-id',
        createdAt: new Date().toISOString(),
      }),
    ).toString('base64url');
    const invalidPage = await request('GET', `/operations?cursor=${invalidCursor}`);
    expect(invalidPage.statusCode).toBe(422);
    expect(invalidPage.json()).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('rolls back operation and audit creation when PostgreSQL cannot persist the outbox', async () => {
    await db.$executeRawUnsafe(
      'ALTER TABLE "Outbox" ADD CONSTRAINT "test_reject_outbox" CHECK (false) NOT VALID',
    );
    try {
      const response = await request('POST', '/operations/diagnostics', {}, randomUUID());
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(response.body).not.toContain('test_reject_outbox');
      expect(await db.operation.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
      expect(await db.auditEvent.count({ where: { action: 'operation.create' } })).toBe(0);
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE "Outbox" DROP CONSTRAINT "test_reject_outbox"');
    }
  });

  it('accepts 202 while Redis starts unavailable, then executes once after reconnection and duplicate delivery', async () => {
    const proxy = await new RedisFaultProxy().start();
    const runtime = startRuntime({ redisUrl: proxy.url });
    await until(
      () => runtime.health(),
      (health) => health.status === 'degraded',
      'degraded worker',
    );
    const before = Date.now();
    const operation = await createOperation(300);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(await repository.get(operation.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await db.outbox.findUnique({ where: { operationId: operation.id } })).toMatchObject({
      publishedAt: null,
    });
    expect(await repository.workerStatus()).toMatchObject({
      status: 'degraded',
      queue: 'disconnected',
      unpublishedCount: 1,
    });
    const readiness = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(readiness.statusCode, readiness.body).toBe(200);
    proxy.setAvailable(true);
    await until(
      () => runtime.health(),
      (health) => health.status === 'ready',
      'reconnected worker',
    );
    const succeeded = await operationWithStatus(operation.id, 'succeeded');
    expect(succeeded).toMatchObject({
      attempts: 1,
      result: { database: 'ok', operationId: operation.id },
    });
    const duplicateId = `duplicate-${randomUUID()}`;
    await queue.add('diagnostic', { operationId: operation.id }, { jobId: duplicateId });
    await until(
      () => queue.getJobState(duplicateId),
      (state) => state === 'completed',
      'duplicate delivery acknowledgement',
    );
    expect(await repository.get(operation.id)).toEqual(succeeded);
    const logs = await repository.logs(operation.id);
    expect(logs.data.filter((line) => line.message.includes('持久任务结果提交成功'))).toHaveLength(
      1,
    );
    expect(logs.data.every((line) => !line.message.includes(baseRedisUrl!))).toBe(true);
  });

  it('recovers from Redis interruption during execution without changing an already committed result', async () => {
    const proxy = await new RedisFaultProxy().start(true);
    const runtime = startRuntime({ redisUrl: proxy.url });
    await until(
      () => runtime.health(),
      (health) => health.status === 'ready',
      'ready worker',
    );
    const first = await createOperation(800);
    await operationWithStatus(first.id, 'running');
    proxy.setAvailable(false);
    const second = await createOperation(50);
    const succeeded = await operationWithStatus(first.id, 'succeeded');
    expect(succeeded.attempts).toBe(1);
    expect(await repository.get(second.id)).toMatchObject({ status: 'queued', attempts: 0 });
    proxy.setAvailable(true);
    await operationWithStatus(second.id, 'succeeded');
    expect(await repository.get(first.id)).toEqual(succeeded);
  });

  it('re-enqueues a lost Redis job from an already published durable outbox', async () => {
    const operation = await createOperation(10);
    const delivery = await repository.claimDelivery();
    expect(delivery).not.toBeNull();
    expect(
      await repository.publishDelivery(delivery!, async (jobId, operationId) => {
        await queue.add('diagnostic', { operationId }, { jobId });
      }),
    ).toBe(true);
    const job = await queue.getJob(delivery!.jobId);
    await job!.remove();
    await db.outbox.update({
      where: { operationId: operation.id },
      data: { publishedAt: new Date(Date.now() - 1000) },
    });
    startRuntime();
    expect(await operationWithStatus(operation.id, 'succeeded')).toMatchObject({ attempts: 1 });
    expect(await db.outbox.findUnique({ where: { operationId: operation.id } })).toMatchObject({
      deliverySequence: 1,
    });
  });

  it('does not amplify a legitimately waiting job while the transport queue is paused', async () => {
    await queue.pause();
    const operation = await createOperation(10);
    const delivery = await repository.claimDelivery();
    await repository.publishDelivery(delivery!, async (jobId, operationId) => {
      await queue.add('diagnostic', { operationId }, { jobId });
    });
    await db.outbox.update({
      where: { operationId: operation.id },
      data: { publishedAt: new Date(Date.now() - 1000) },
    });
    const runtime = startRuntime();
    await until(
      () => runtime.health(),
      (health) => health.status === 'ready',
      'worker queue connection',
    );
    await delay(400); // Several reconciliation passes must keep the same waiting delivery.
    expect(await db.outbox.findUnique({ where: { operationId: operation.id } })).toMatchObject({
      deliverySequence: 0,
    });
    expect(await repository.get(operation.id)).toMatchObject({ status: 'queued', attempts: 0 });
    await queue.resume();
    await operationWithStatus(operation.id, 'succeeded');
  });

  it('uses execution leases to fence duplicate claimers, crashed workers and stale completions', async () => {
    const operation = await createOperation(0);
    const claims = await Promise.all([
      repository.claim(operation.id, 'worker-a'),
      repository.claim(operation.id, 'worker-b'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const original = claims.find((lease) => lease !== null)!;
    expect(await repository.renew(original)).toBe('renewed');
    await db.operation.update({
      where: { id: operation.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    expect(await repository.complete(original)).toBe(false);
    expect(await repository.recoverOperation(operation.id)).toBe(true);
    const replacement = await repository.claim(operation.id, 'replacement-worker');
    expect(replacement).not.toBeNull();
    expect(replacement!.token).not.toBe(original.token);
    expect(await repository.renew(original)).toBe('lost');
    expect(await repository.complete(original)).toBe(false);
    expect(await repository.fail(original, 'STALE_WORKER', '旧 Worker 不得覆盖。', true)).toBe(
      false,
    );
    const commits = await Promise.all([
      repository.complete(replacement!),
      repository.complete(replacement!),
    ]);
    expect(commits.sort()).toEqual([false, true]);
    expect(await repository.get(operation.id)).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      errorCode: null,
    });
  });

  it('retains cancellation when a queued task is concurrently claimed', async () => {
    const operation = await createOperation(5000);
    let announceLock!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => {
      announceLock = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Operation" WHERE "id" = ${operation.id}::uuid FOR UPDATE`;
        announceLock();
        await release;
      },
      { timeout: 15000 },
    );
    const waiting = async () => {
      const [row] = await db.$queryRaw<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%Operation%'`;
      return row?.count ?? 0;
    };
    await locked;
    try {
      const claim = repository.claim(operation.id, 'claim-racing-cancel');
      await until(waiting, (count) => count >= 1, 'claim waiting on the database row');
      const cancel = repository.cancel(operation.id, actor);
      const outcomes = Promise.allSettled([claim, cancel]);
      await until(waiting, (count) => count >= 2, 'cancel queued behind the claim');
      releaseLock();
      await blocker;
      const [claimed, cancelled] = await outcomes;
      expect(claimed.status).toBe('fulfilled');
      expect(cancelled.status).toBe('fulfilled');
      if (claimed.status !== 'fulfilled' || cancelled.status !== 'fulfilled')
        throw new Error('Concurrent cancellation failed');
      expect(cancelled.value).toMatchObject({ status: 'running' });
      expect((cancelled.value as OperationView).cancelRequestedAt).not.toBeNull();
      if (!claimed.value || !('token' in claimed.value))
        throw new Error('Expected the claimed lease');
      expect(await repository.complete(claimed.value)).toBe(true);
      expect(await repository.get(operation.id)).toMatchObject({
        status: 'cancelled',
        result: null,
      });
    } finally {
      releaseLock();
      await blocker;
    }
  });

  it('cancels queued commands and waits for a running worker to confirm cancellation', async () => {
    const queued = await createOperation(0);
    const cancelled = await request('POST', `/operations/${queued.id}/cancel`);
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json<{ data: OperationView }>().data).toMatchObject({
      status: 'cancelled',
      attempts: 0,
      result: null,
    });
    expect(await repository.claim(queued.id, 'late-worker')).toBeNull();
    const running = await createOperation(5000);
    startRuntime();
    await operationWithStatus(running.id, 'running');
    const response = await request('POST', `/operations/${running.id}/cancel`);
    expect(response.statusCode).toBe(202);
    expect(response.json<{ data: OperationView }>().data).toMatchObject({ status: 'running' });
    expect(response.json<{ data: OperationView }>().data.cancelRequestedAt).not.toBeNull();
    expect(await operationWithStatus(running.id, 'cancelled')).toMatchObject({
      attempts: 1,
      result: null,
      errorCode: null,
    });
    expect(
      (await request('POST', `/operations/${running.id}/retry`, undefined, randomUUID()))
        .statusCode,
    ).toBe(409);
  });

  it('bounds automatic retry attempts and creates an idempotent manual retry with unchanged input', async () => {
    const operation = await createOperation(37);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = await repository.claim(operation.id, 'retry-worker');
      expect(lease?.attempt).toBe(attempt);
      expect(await repository.fail(lease!, 'DIAGNOSTIC_INTERRUPTED', '受控中断。', true)).toBe(
        true,
      );
      expect(await repository.get(operation.id)).toMatchObject({
        status: attempt < 3 ? 'queued' : 'failed',
        attempts: attempt,
      });
      if (attempt < 3) {
        expect(await repository.claim(operation.id, 'too-early')).toBeNull();
        await db.operation.update({
          where: { id: operation.id },
          data: { nextAttemptAt: new Date(Date.now() - 1) },
        });
      }
    }
    const failed = await repository.get(operation.id);
    const key = randomUUID();
    const response = await request('POST', `/operations/${operation.id}/retry`, undefined, key);
    expect(response.statusCode).toBe(202);
    const retry = response.json<{ data: OperationView }>().data;
    expect(retry).toMatchObject({
      status: 'queued',
      attempts: 0,
      retryOfId: operation.id,
      input: { durationMs: 37 },
    });
    expect(retry.id).not.toBe(operation.id);
    const repeated = await request('POST', `/operations/${operation.id}/retry`, undefined, key);
    expect(repeated.json<{ data: OperationView }>().data.id).toBe(retry.id);
    expect(await repository.get(operation.id)).toEqual(failed);
  });

  it('blocks creation, publication and execution in recovery and fences every old generation after unlock', async () => {
    const queued = await createOperation(0);
    const running = await createOperation(0);
    const lease = await repository.claim(running.id, 'pre-recovery-worker');
    const delivery = await repository.claimDelivery();
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: true, generation: { increment: 1 } },
    });
    const blocked = await request('POST', '/operations/diagnostics', {}, randomUUID());
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({ code: 'RESTORE_READ_ONLY' });
    expect((await request('GET', `/operations/${running.id}`)).statusCode).toBe(200);
    const rejection = { code: 'RESTORE_READ_ONLY' };
    await expect(repository.claim(queued.id, 'blocked-worker')).rejects.toMatchObject(rejection);
    await expect(repository.renew(lease!)).rejects.toMatchObject(rejection);
    await expect(repository.complete(lease!)).rejects.toMatchObject(rejection);
    await expect(repository.fail(lease!, 'BLOCKED', '不能提交。', true)).rejects.toMatchObject(
      rejection,
    );
    await expect(repository.cancel(queued.id, actor)).rejects.toMatchObject(rejection);
    await expect(repository.claimDelivery()).rejects.toMatchObject(rejection);
    let publications = 0;
    await expect(
      repository.publishDelivery(delivery!, async () => {
        publications += 1;
      }),
    ).rejects.toMatchObject(rejection);
    expect(publications).toBe(0);
    const runtime = startRuntime();
    await until(
      () => runtime.health(),
      (health) => health.status === 'paused',
      'paused worker',
    );
    expect(await repository.workerStatus()).toMatchObject({
      status: 'paused',
      restoreLocked: true,
    });
    await db.controlPlaneState.update({
      where: { id: 'control-plane' },
      data: { restoreLocked: false },
    });
    for (const operation of [queued, running]) {
      expect(await operationWithStatus(operation.id, 'failed')).toMatchObject({
        errorCode: 'RECOVERY_GENERATION_CHANGED',
        result: null,
      });
    }
    expect(await repository.complete(lease!)).toBe(false);
    const current = await createOperation(10);
    expect(await operationWithStatus(current.id, 'succeeded')).toMatchObject({ attempts: 1 });
    await until(
      () => runtime.health(),
      (health) => health.status === 'ready',
      'healthy worker after recovery unlock',
    );
  });

  it('serializes recovery-lock acquisition with an in-flight outbox publication', async () => {
    await createOperation(0);
    const delivery = await repository.claimDelivery();
    let releasePublication!: () => void;
    let publicationStarted!: () => void;
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const publication = repository.publishDelivery(delivery!, async (jobId, operationId) => {
      publicationStarted();
      await publicationGate;
      await queue.add('diagnostic', { operationId }, { jobId });
    });
    await started;
    let locked = false;
    const lock = db.controlPlaneState
      .update({
        where: { id: 'control-plane' },
        data: { restoreLocked: true, generation: { increment: 1 } },
      })
      .then(() => {
        locked = true;
      });
    try {
      await delay(50);
      expect(locked).toBe(false);
    } finally {
      releasePublication();
    }
    expect(await publication).toBe(true);
    await lock;
    expect(locked).toBe(true);
    expect(await queue.getJobState(delivery!.jobId)).toBe('waiting');
  });

  it('returns bounded cursor logs and expires logs without removing historical outcomes', async () => {
    const bounded = new TaskRepository(db, { logMaxBytes: 1024, logRetentionMs: 1000 });
    const operation = await bounded.createDiagnostic(actor, randomUUID(), {});
    expect(await bounded.logs(operation.id)).toMatchObject({
      available: false,
      unavailableReason: 'not_started',
    });
    for (let count = 0; count < 12; count += 1) await bounded.recoverOperation(operation.id);
    const lease = await bounded.claim(operation.id, 'log-worker');
    await bounded.complete(lease!);
    const stored = await db.operation.findUniqueOrThrow({ where: { id: operation.id } });
    expect(Buffer.byteLength(JSON.stringify(stored.logsJson), 'utf8')).toBeLessThanOrEqual(1024);
    const first = await bounded.logs(operation.id, { limit: 1 });
    expect(first).toMatchObject({ available: true, truncated: true, page: { hasMore: true } });
    const next = await bounded.logs(operation.id, { limit: 100, cursor: first.page.nextCursor! });
    expect(next.data.every((line) => line.sequence > first.data[0]!.sequence)).toBe(true);
    const other = await createOperation(0);
    await expect(bounded.logs(other.id, { cursor: first.page.nextCursor! })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    await db.operation.update({
      where: { id: operation.id },
      data: { finishedAt: new Date(Date.now() - 2000) },
    });
    expect(await bounded.logs(operation.id)).toMatchObject({
      available: false,
      unavailableReason: 'expired',
      data: [],
    });
    expect(await bounded.clearExpiredLogs()).toBe(1);
    expect(await db.operation.findUniqueOrThrow({ where: { id: operation.id } })).toMatchObject({
      status: 'succeeded',
      logsJson: null,
      result: stored.result,
    });
  });

  it('reports independent fresh, degraded, stopped and stale worker heartbeats', async () => {
    expect(await repository.workerStatus()).toMatchObject({ status: 'offline', queue: 'unknown' });
    const id = `heartbeat-${randomUUID()}`;
    await db.workerHeartbeat.create({ data: { id, queueConnected: false } });
    expect(await repository.workerStatus()).toMatchObject({
      status: 'degraded',
      queue: 'disconnected',
    });
    await db.workerHeartbeat.update({ where: { id }, data: { queueConnected: true } });
    expect(await repository.workerStatus()).toMatchObject({ status: 'ready', queue: 'connected' });
    await db.workerHeartbeat.update({
      where: { id },
      data: { queueConnected: false, errorCode: 'WORKER_STOPPED' },
    });
    expect(await repository.workerStatus()).toMatchObject({ status: 'offline' });
    await db.workerHeartbeat.update({
      where: { id },
      data: { queueConnected: true, errorCode: null, lastSeenAt: new Date(Date.now() - 2000) },
    });
    expect(await repository.workerStatus()).toMatchObject({
      status: 'offline',
      workers: [{ id, stale: true }],
    });
  });

  it('enforces a durable pending-task cap during concurrent submissions and preserves idempotent reads', async () => {
    const capped = new TaskRepository(db, { maxPendingOperations: 2 });
    const requests = Array.from({ length: 5 }, () => ({ key: randomUUID() }));
    const results = await Promise.allSettled(
      requests.map(({ key }) => capped.createDiagnostic(actor, key, {})),
    );
    const accepted = results.filter((result) => result.status === 'fulfilled');
    expect(accepted).toHaveLength(2);
    expect(await db.operation.count()).toBe(2);
    expect(await db.outbox.count()).toBe(2);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ status: 429, code: 'OPERATION_QUEUE_FULL' });
    const firstIndex = results.findIndex((result) => result.status === 'fulfilled');
    const first = accepted[0]!.value;
    expect((await capped.createDiagnostic(actor, requests[firstIndex]!.key, {})).id).toBe(first.id);
    await capped.cancel(first.id, actor);
    expect(await capped.createDiagnostic(actor, randomUUID(), {})).toMatchObject({
      status: 'queued',
    });
  });

  it('stops promptly even when Redis has never been available', async () => {
    const proxy = await new RedisFaultProxy().start();
    const runtime = startRuntime({ redisUrl: proxy.url });
    await until(
      () => runtime.health(),
      (health) => health.status === 'degraded',
      'degraded worker',
    );
    const stopped = runtime.stop().then(() => 'stopped');
    expect(await Promise.race([stopped, delay(2500).then(() => 'timeout')])).toBe('stopped');
    expect(await repository.workerStatus()).toMatchObject({ status: 'offline' });
  });

  it('runs a separate worker health endpoint and shuts down cleanly during a Redis outage', async () => {
    const proxy = await new RedisFaultProxy().start();
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Health port was not assigned');
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../apps/worker/dist/main.js', import.meta.url))],
      {
        env: {
          ...process.env,
          REDIS_URL: proxy.url,
          HOST: '127.0.0.1',
          WORKER_HEALTH_PORT: String(address.port),
          LOG_LEVEL: 'silent',
        },
        stdio: 'ignore',
      },
    );
    children.push(child);
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await until(
      async () => {
        try {
          const response = await fetch(`${origin}/health/live`);
          return {
            code: response.status,
            data: (await response.json()) as {
              status: string;
              database: boolean;
              queueConnected: boolean;
            },
          };
        } catch {
          return null;
        }
      },
      (value) => value?.data.status === 'degraded',
      'independent worker liveness',
    );
    expect(health).toMatchObject({ code: 200, data: { database: true, queueConnected: false } });
    expect((await fetch(`${origin}/health/ready`)).status).toBe(503);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited,
      delay(5000, undefined, { ref: false }).then(() => 'timeout' as const),
    ]);
    expect(result).not.toBe('timeout');
    expect(result === 'timeout' ? false : result.code === 0 || result.signal === 'SIGTERM').toBe(
      true,
    );
  });

  it('exits with failure when its health port cannot bind, releasing startup resources', async () => {
    const proxy = await new RedisFaultProxy().start();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Health port was not assigned');
    try {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../../apps/worker/dist/main.js', import.meta.url))],
        {
          env: {
            ...process.env,
            REDIS_URL: proxy.url,
            HOST: '127.0.0.1',
            WORKER_HEALTH_PORT: String(address.port),
            LOG_LEVEL: 'silent',
          },
          stdio: 'ignore',
        },
      );
      children.push(child);
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(
        await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => 'timeout')]),
      ).toBe(1);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
