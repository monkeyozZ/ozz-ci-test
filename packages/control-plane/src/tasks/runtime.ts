import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Prisma } from '@ozz/database';
import { ControlPlaneReadOnlyError, readRecoveryState } from '../recovery.js';
import {
  TaskRepository,
  taskJobId,
  type TaskLease,
  type DeploymentLease,
  type ExecutionLease,
  type TaskOutcome,
} from './repository.js';
import {
  diagnosticInput,
  TaskExecutionError,
  validateOperationId,
  type TaskRef,
} from './contracts.js';

interface TaskLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export type TaskJobPayload = { task: TaskRef } | { operationId: string };

function jobReference(value: unknown): TaskRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  let ref: TaskRef;
  if ('task' in payload) {
    if (
      'operationId' in payload ||
      !payload.task ||
      typeof payload.task !== 'object' ||
      Array.isArray(payload.task)
    )
      return null;
    const task = payload.task as Record<string, unknown>;
    if (!['operation', 'deployment'].includes(String(task.type)) || typeof task.id !== 'string')
      return null;
    ref = { type: task.type as TaskRef['type'], id: task.id };
  } else {
    if (typeof payload.operationId !== 'string') return null;
    ref = { type: 'operation', id: payload.operationId };
  }
  try {
    validateOperationId(ref.id);
  } catch {
    return null;
  }
  return ref;
}

export interface TaskRuntimeOptions {
  redisUrl: string;
  logger: TaskLogger;
  queueName?: string;
  instanceId?: string;
  relayIntervalMs?: number;
  heartbeatIntervalMs?: number;
  recoveryIntervalMs?: number;
  cleanupIntervalMs?: number;
  executor?: TaskExecutor;
  deploymentExecutor?: DeploymentExecutor;
}

export interface TaskExecutor {
  execute(lease: TaskLease, signal: AbortSignal): Promise<TaskOutcome>;
  failed?(
    lease: TaskLease,
    tx: Prisma.TransactionClient,
    code: string,
    message: string,
  ): Promise<void>;
}

export interface DeploymentExecutor {
  execute(lease: DeploymentLease, signal: AbortSignal): Promise<TaskOutcome>;
  failed?(
    lease: DeploymentLease,
    tx: Prisma.TransactionClient,
    code: string,
    message: string,
  ): Promise<void>;
}

export interface WorkerHealth {
  status: 'ready' | 'degraded' | 'paused' | 'starting' | 'stopping';
  database: boolean;
  queueConnected: boolean;
  recoveryMode: boolean;
  activeOperations: number;
  lastHeartbeatAt: string | null;
  errorCode: string | null;
}

/** A separate process consumes durable commands; remote effects use fixed, reviewed Adapters. */
export class TaskRuntime {
  readonly instanceId: string;
  readonly queueName: string;
  private readonly startedAt = new Date();
  private producer: Redis | undefined;
  private consumer: Redis | undefined;
  private queue: Queue<TaskJobPayload> | undefined;
  private worker: Worker<TaskJobPayload> | undefined;
  private loop: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  private readonly loopAbort = new AbortController();
  private stopping = false;
  private concurrencyConfigured = false;
  private databaseAvailable = false;
  private recoveryMode = false;
  private errorCode: string | null = null;
  private lastHeartbeatAt: Date | null = null;
  private lastRecoveryAt = 0;
  private lastCleanupAt = 0;
  private lastWarningAt = 0;
  private active = new Map<string, AbortController>();
  private inFlight = new Set<Promise<void>>();

  constructor(
    readonly repository: TaskRepository,
    private readonly options: TaskRuntimeOptions,
  ) {
    this.instanceId = options.instanceId ?? `worker-${randomUUID()}`;
    this.queueName = options.queueName ?? 'ozz-operations';
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(this.queueName))
      throw new Error('Invalid operation queue name');
  }

  start(): void {
    if (this.loop) return;
    const reconnect = (attempt: number) => Math.min(5_000, 250 * 2 ** Math.min(attempt, 4));
    this.producer = new Redis(this.options.redisUrl, {
      // Start connecting before BullMQ attaches. Its lazy-connect initialization
      // rejects permanently on the first failed connection, preventing recovery.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      commandTimeout: 1_500,
      retryStrategy: reconnect,
    });
    this.consumer = new Redis(this.options.redisUrl, {
      maxRetriesPerRequest: null,
      connectTimeout: 1_000,
      retryStrategy: reconnect,
    });
    this.producer.on('error', () => this.queueWarning());
    this.consumer.on('error', () => this.queueWarning());
    this.producer.on('reconnecting', () => {
      this.concurrencyConfigured = false;
    });
    this.queue = new Queue<TaskJobPayload>(this.queueName, {
      connection: this.producer,
      defaultJobOptions: {
        attempts: 1, // Application retries are recorded and scheduled in PostgreSQL.
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 24 * 3_600, count: 1_000 },
      },
    });
    this.queue.on('error', () => this.queueWarning());
    this.worker = new Worker<TaskJobPayload>(
      this.queueName,
      (job) => {
        const work = this.process(job);
        this.inFlight.add(work);
        return work.finally(() => {
          this.inFlight.delete(work);
        });
      },
      {
        connection: this.consumer,
        concurrency: 1,
        autorun: false,
        lockDuration: 30_000,
        maxStalledCount: 1,
        drainDelay: 1,
      },
    );
    this.worker.on('error', () => this.queueWarning());
    this.worker.on('failed', (job) => {
      const ref = jobReference(job?.data);
      this.options.logger.warn(
        { taskId: ref?.id, taskType: ref?.type, code: 'QUEUE_JOB_FAILED' },
        'Queue job failed; durable recovery will inspect its task',
      );
    });
    this.loop = this.runLoop();
    this.options.logger.info({ workerId: this.instanceId }, 'Operation worker started');
  }

  health(): WorkerHealth {
    const queueConnected = Boolean(
      this.producer?.status === 'ready' &&
      this.consumer?.status === 'ready' &&
      this.worker?.isRunning() &&
      !this.worker.isPaused() &&
      this.concurrencyConfigured,
    );
    const database =
      this.databaseAvailable &&
      Boolean(
        this.lastHeartbeatAt &&
        Date.now() - this.lastHeartbeatAt.getTime() < this.repository.options.heartbeatTtlMs,
      );
    return {
      status: this.stopping
        ? 'stopping'
        : this.recoveryMode
          ? 'paused'
          : !this.lastHeartbeatAt
            ? 'starting'
            : database && queueConnected
              ? 'ready'
              : 'degraded',
      database,
      queueConnected,
      recoveryMode: this.recoveryMode,
      activeOperations: this.active.size,
      lastHeartbeatAt: this.lastHeartbeatAt?.toISOString() ?? null,
      errorCode: this.recoveryMode ? 'RESTORE_READ_ONLY' : this.errorCode,
    };
  }

  private startConsumer(): void {
    if (!this.worker || this.stopping) return;
    if (this.worker.isPaused()) {
      this.worker.resume();
      return;
    }
    if (this.worker.isRunning()) return;
    void this.worker.run().catch(() => {
      this.errorCode = 'WORKER_CONSUMER_STOPPED';
      this.queueWarning();
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const state = await readRecoveryState(this.repository.db);
        this.databaseAvailable = true;
        this.recoveryMode = state.restoreLocked || process.env.RESTORE_MODE === 'true';
        if (this.recoveryMode) {
          if (this.worker && !this.worker.isPaused()) await this.worker.pause(true);
          for (const abort of this.active.values()) abort.abort('recovery');
        } else {
          if (this.producer?.status === 'ready' && this.queue) {
            if (!this.concurrencyConfigured) {
              await this.queue.setGlobalConcurrency(1);
              this.concurrencyConfigured = true;
            }
            this.startConsumer();
            await this.relayBatch();
            if (Date.now() - this.lastRecoveryAt >= (this.options.recoveryIntervalMs ?? 5_000)) {
              await this.recover(state.generation);
              this.lastRecoveryAt = Date.now();
            }
            if (Date.now() - this.lastCleanupAt >= (this.options.cleanupIntervalMs ?? 60_000)) {
              await this.repository.clearExpiredLogs();
              this.lastCleanupAt = Date.now();
            }
          }
        }
        if (
          !this.lastHeartbeatAt ||
          Date.now() - this.lastHeartbeatAt.getTime() >= (this.options.heartbeatIntervalMs ?? 2_000)
        ) {
          await this.writeHeartbeat();
        }
      } catch (error) {
        if (error instanceof ControlPlaneReadOnlyError) {
          this.recoveryMode = true;
          for (const abort of this.active.values()) abort.abort('recovery');
        } else {
          this.errorCode = 'WORKER_DEPENDENCY_UNAVAILABLE';
          this.warnThrottled(
            'WORKER_DEPENDENCY_UNAVAILABLE',
            'Worker dependencies are unavailable; persisted operations remain recoverable',
          );
          // A failed database heartbeat must not continue advertising a healthy worker.
          try {
            await this.repository.db.$queryRaw`SELECT 1`;
          } catch {
            this.databaseAvailable = false;
          }
        }
      }
      try {
        await delay(this.options.relayIntervalMs ?? 250, undefined, {
          signal: this.loopAbort.signal,
        });
      } catch {
        break;
      }
    }
  }

  private async relayBatch(): Promise<void> {
    if (!this.queue || this.producer?.status !== 'ready') return;
    for (let index = 0; index < 10 && !this.stopping; index += 1) {
      const lease = await this.repository.claimDelivery();
      if (!lease) return;
      try {
        await this.repository.publishDelivery(lease, async (jobId, _taskId, ref) => {
          if (this.producer?.status !== 'ready') throw new Error('QUEUE_UNAVAILABLE');
          await this.queue!.add(ref.type, { task: ref }, { jobId });
        });
      } catch (error) {
        if (error instanceof ControlPlaneReadOnlyError) throw error;
        await this.repository.releaseDelivery(lease);
        this.queueWarning();
        return;
      }
    }
  }

  private async recover(generation: number): Promise<void> {
    if (!this.queue) return;
    const candidates = await this.repository.recoveryCandidates();
    for (const candidate of candidates) {
      if (this.stopping) return;
      // A legitimately waiting BullMQ job is not missing; do not amplify a long queue.
      if (
        candidate.generation === generation &&
        candidate.status === 'queued' &&
        candidate.outbox
      ) {
        const state = await this.queue.getJobState(
          taskJobId(candidate.ref, candidate.outbox.deliverySequence),
        );
        if (!['unknown', 'completed', 'failed'].includes(state)) continue;
      }
      await this.repository.recoverTask(candidate.ref, candidate.outbox?.deliverySequence);
    }
  }

  private async process(job: Job<TaskJobPayload>): Promise<void> {
    const ref = jobReference(job.data);
    if (this.stopping || !ref) return;
    let claimed: ExecutionLease | null;
    try {
      claimed = await this.repository.claimTask(ref, this.instanceId);
    } catch (error) {
      if (error instanceof ControlPlaneReadOnlyError) return;
      throw error;
    }
    if (!claimed) return;
    const lease = claimed;
    const abort = new AbortController();
    const activeKey = `${lease.ref.type}:${lease.ref.id}`;
    this.active.set(activeKey, abort);
    if (this.stopping || this.recoveryMode) abort.abort('execution_paused');
    let renewing = false;
    const renew = setInterval(() => {
      if (renewing || abort.signal.aborted) return;
      renewing = true;
      void this.repository
        .renew(lease)
        .then((result) => {
          if (result !== 'renewed') abort.abort(result);
        })
        .catch(() => {
          abort.abort('lease_unavailable');
        })
        .finally(() => {
          renewing = false;
        });
    }, this.repository.options.leaseRenewMs);
    renew.unref();
    try {
      let outcome: TaskOutcome | undefined;
      if (lease.kind === 'diagnostic') {
        await delay(diagnosticInput(lease.input).durationMs, undefined, { signal: abort.signal });
        if (abort.signal.aborted || this.stopping) throw new Error('EXECUTION_INTERRUPTED');
        await this.repository.db.$queryRaw`SELECT 1`;
      } else if ('deploymentId' in lease) {
        if (!this.options.deploymentExecutor)
          throw new TaskExecutionError('UNSUPPORTED_DEPLOYMENT', '当前 Worker 未配置发布执行器。');
        outcome = await this.options.deploymentExecutor.execute(lease, abort.signal);
      } else if (this.options.executor) {
        outcome = await this.options.executor.execute(lease, abort.signal);
      } else {
        throw new TaskExecutionError('UNSUPPORTED_OPERATION', '当前 Worker 未配置基础设施执行器。');
      }
      await this.repository.complete(lease, outcome);
    } catch (error) {
      if (!(error instanceof ControlPlaneReadOnlyError)) {
        try {
          const failure =
            error instanceof TaskExecutionError
              ? error
              : {
                  code:
                    lease.kind === 'diagnostic'
                      ? 'DIAGNOSTIC_INTERRUPTED'
                      : 'deploymentId' in lease
                        ? 'DEPLOYMENT_INTERRUPTED'
                        : 'INFRASTRUCTURE_INTERRUPTED',
                  message: '操作执行中断，将按持久任务策略恢复或保留失败原因。',
                  retryable: true,
                };
          await this.repository.fail(
            lease,
            failure.code,
            failure.message,
            failure.retryable,
            'deploymentId' in lease
              ? this.options.deploymentExecutor?.failed
                ? (tx) =>
                    this.options.deploymentExecutor!.failed!(
                      lease,
                      tx,
                      failure.code,
                      failure.message,
                    )
                : undefined
              : this.options.executor?.failed
                ? (tx) => this.options.executor!.failed!(lease, tx, failure.code, failure.message)
                : undefined,
          );
        } catch {
          // The database lease is left to expire. Reconciliation observes this durable
          // record on recovery; queue completion alone never marks it succeeded.
          this.warnThrottled(
            'TASK_LEASE_RECOVERY_REQUIRED',
            'Interrupted operation requires durable lease recovery',
          );
        }
      }
    } finally {
      clearInterval(renew);
      if (this.active.get(activeKey) === abort) this.active.delete(activeKey);
    }
  }

  private async writeHeartbeat(): Promise<void> {
    const health = this.health();
    const now = new Date();
    const errorCode = this.recoveryMode
      ? 'RESTORE_READ_ONLY'
      : !health.queueConnected
        ? 'QUEUE_UNAVAILABLE'
        : null;
    await this.repository.db.workerHeartbeat.upsert({
      where: { id: this.instanceId },
      create: {
        id: this.instanceId,
        startedAt: this.startedAt,
        lastSeenAt: now,
        queueConnected: health.queueConnected,
        recoveryMode: this.recoveryMode,
        activeOperations: this.active.size,
        errorCode,
      },
      update: {
        lastSeenAt: now,
        queueConnected: health.queueConnected,
        recoveryMode: this.recoveryMode,
        activeOperations: this.active.size,
        errorCode,
      },
    });
    this.lastHeartbeatAt = now;
    this.errorCode = errorCode;
  }

  private queueWarning(): void {
    this.errorCode = 'QUEUE_UNAVAILABLE';
    this.warnThrottled(
      'QUEUE_UNAVAILABLE',
      'Queue connection is unavailable; commands stay in PostgreSQL',
    );
  }

  private warnThrottled(code: string, message: string): void {
    if (Date.now() - this.lastWarningAt < 30_000) return;
    this.lastWarningAt = Date.now();
    this.options.logger.warn({ workerId: this.instanceId, code }, message);
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.loopAbort.abort();
    for (const abort of this.active.values()) abort.abort('shutdown');
    this.shutdown = this.finishStop();
    return this.shutdown;
  }

  private async finishStop(): Promise<void> {
    await this.loop;
    await this.worker?.close(true);
    await Promise.allSettled([...this.inFlight]);
    await this.queue?.close();
    this.producer?.disconnect();
    this.consumer?.disconnect();
    try {
      await this.repository.db.workerHeartbeat.updateMany({
        where: { id: this.instanceId },
        data: {
          queueConnected: false,
          activeOperations: 0,
          errorCode: 'WORKER_STOPPED',
          lastSeenAt: new Date(),
        },
      });
    } catch {
      /* The stale heartbeat remains visibly expired when the database is unavailable. */
    }
    this.options.logger.info({ workerId: this.instanceId }, 'Operation worker stopped');
  }
}
