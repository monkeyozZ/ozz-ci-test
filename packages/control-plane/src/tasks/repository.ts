import { closeBuildsBeforeTransition, assertBuildsClosed } from './build-gate.js';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@ozz/database';
import { assertWritable, readRecoveryState } from '../recovery.js';
import {
  defaultTaskingOptions,
  diagnosticInput,
  deploymentInput,
  taskInput,
  infrastructureKinds,
  integrationOperationKinds,
  serviceOperationKinds,
  domainOperationKinds,
  clusterNetworkingKinds,
  volumeOperationKinds,
  OperationRequestError,
  pageLimit,
  validateIdempotencyKey,
  validateOperationId,
  type TaskInput,
  type TaskKind,
  type OperationLogPage,
  type OperationStatus,
  type OperationView,
  type Page,
  type TaskingOptions,
  type TaskRef,
  type OperationTaskRef,
  type DeploymentTaskRef,
  type DeploymentInput,
  type DeploymentTaskView,
  type DeploymentLogPage,
  type TaskLogPage,
  type ServiceOperationInput,
  type DomainOperationInput,
  type ClusterNetworkingOperationInput,
  type VolumeOperationInput,
} from './contracts.js';
import { appendOperationLog, readOperationLogs } from './logs.js';
import {
  lockTask,
  readTask,
  updateTask,
  ownsMutationSlot,
  releaseMutationSlot,
  outboxTaskRef,
  type OperationRow,
  type DeploymentRow,
  type OutboxRow,
  type StoredTask,
} from './records.js';
const terminalStatuses: OperationStatus[] = ['succeeded', 'failed', 'cancelled'];
const operationStatuses: OperationStatus[] = ['queued', 'running', ...terminalStatuses];

class TaskFenceLost extends Error {}

export interface OperationActor {
  id: string;
  requestId?: string;
}

export type DeploymentActor =
  OperationActor | { kind: 'webhook'; webhookDeliveryId: string; webhookTargetId: string };

export interface TaskLease {
  ref: OperationTaskRef;
  operationId: string;
  token: string;
  generation: number;
  kind: TaskKind;
  serverId: string | null;
  clusterId: string | null;
  serviceId: string | null;
  input: TaskInput;
  attempt: number;
}

export interface DeploymentLease {
  ref: DeploymentTaskRef;
  deploymentId: string;
  token: string;
  generation: number;
  kind: 'image_deploy' | 'git_deploy';
  serviceId: string;
  input: DeploymentInput;
  configRevision: number;
  mutationRevision: number;
  attempt: number;
}

export type ExecutionLease = TaskLease | DeploymentLease;

export interface TaskAdmissionContext {
  id: string;
  generation: number;
}

export interface PreparedOperation {
  input: TaskInput;
  serverId?: string;
  clusterId?: string;
  candidateCredentialRefId?: string;
  serviceId?: string;
  onAccepted?: (tx: Prisma.TransactionClient, ref: OperationTaskRef) => Promise<void>;
}

export interface PreparedDeployment {
  input: DeploymentInput;
  serviceId: string;
  configRevision: number;
  mutationRevision: number;
  snapshotJson: Prisma.InputJsonValue;
  targetJson: Prisma.InputJsonValue;
  resolvedImageJson?: Prisma.InputJsonValue;
  sourceRevisionId?: string;
  reuseArtifactId?: string;
  webhookDeliveryId?: string;
  webhookTargetId?: string;
  onAccepted?: (tx: Prisma.TransactionClient, ref: DeploymentTaskRef) => Promise<void>;
}

export interface TaskOutcome {
  result: Prisma.InputJsonValue;
  commit?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface DeliveryLease {
  id: string;
  ref: TaskRef;
  operationId: string | null;
  deploymentId: string | null;
  token: string;
  deliverySequence: number;
  jobId: string;
}

export interface TaskRecoveryCandidate {
  ref: TaskRef;
  id: string;
  generation: number;
  status: OperationStatus;
  outbox: OutboxRow | null;
  updatedAt: Date;
}

export function operationJobId(operationId: string, deliverySequence: number): string {
  return `${operationId}-${deliverySequence}`;
}

export function taskJobId(ref: TaskRef, deliverySequence: number): string {
  return ref.type === 'operation'
    ? operationJobId(ref.id, deliverySequence)
    : `deployment-${ref.id}-${deliverySequence}`;
}

function operationView(operation: OperationRow): OperationView {
  return {
    id: operation.id,
    kind: operation.kind,
    scope: operation.scope,
    status: operation.status,
    input: taskInput(operation.kind, operation.input),
    serverId: operation.serverId,
    clusterId: operation.clusterId,
    serviceId: operation.serviceId,
    result: operation.result,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    startedAt: operation.startedAt?.toISOString() ?? null,
    finishedAt: operation.finishedAt?.toISOString() ?? null,
    attempts: operation.attempts,
    maxAttempts: operation.maxAttempts,
    errorCode: operation.errorCode,
    errorMessage: operation.errorMessage,
    retryOfId: operation.retryOfId,
    cancelRequestedAt: operation.cancelRequestedAt?.toISOString() ?? null,
    pollUrl: `/api/operations/${operation.id}`,
  };
}

function deploymentView(deployment: DeploymentRow): DeploymentTaskView {
  const stored =
    deployment.result && typeof deployment.result === 'object' && !Array.isArray(deployment.result)
      ? deployment.result
      : {};
  const { failureObservation, ...applied } = stored;
  const complete =
    deployment.appliedAt !== null &&
    (applied.version === 1 || applied.version === 2 || applied.version === 3) &&
    typeof applied.appliedAt === 'string' &&
    applied.published &&
    typeof applied.published === 'object' &&
    !Array.isArray(applied.published) &&
    applied.image &&
    typeof applied.image === 'object' &&
    !Array.isArray(applied.image);
  return {
    id: deployment.id,
    kind: deployment.kind as 'image_deploy' | 'git_deploy',
    scope: 'service',
    status: deployment.status,
    phase: deployment.phase,
    input: deploymentInput(deployment.input),
    serviceId: deployment.serviceId,
    configRevision: deployment.configRevision,
    mutationRevision: deployment.mutationRevision,
    sourceRevisionId: deployment.sourceRevisionId,
    reuseArtifactId: deployment.reuseArtifactId,
    artifactId: deployment.artifactId,
    initiatorKind: deployment.initiatorKind,
    webhookDeliveryId: deployment.webhookDeliveryId,
    webhookTargetId: deployment.webhookTargetId,
    snapshotJson: deployment.snapshotJson,
    targetJson: deployment.targetJson,
    resolvedImageJson: deployment.resolvedImageJson,
    appliedAt: deployment.appliedAt?.toISOString() ?? null,
    result: complete ? applied : null,
    failureObservation: failureObservation ?? null,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString(),
    startedAt: deployment.startedAt?.toISOString() ?? null,
    finishedAt: deployment.finishedAt?.toISOString() ?? null,
    attempts: deployment.attempts,
    maxAttempts: deployment.maxAttempts,
    errorCode: deployment.errorCode,
    errorMessage: deployment.errorMessage,
    retryOfId: deployment.retryOfId,
    cancelRequestedAt: deployment.cancelRequestedAt?.toISOString() ?? null,
    pollUrl: `/api/deployments/${deployment.id}`,
  };
}

function operationScope(kind: string): string {
  return (integrationOperationKinds as readonly string[]).includes(kind)
    ? 'integration'
    : kind === 'diagnostic'
      ? 'control_plane'
      : kind.startsWith('volume_')
        ? 'volume'
        : kind.startsWith('cluster_')
          ? 'cluster'
          : kind.startsWith('service_') || kind.startsWith('domain_')
            ? 'service'
            : 'server';
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): Record<string, unknown> {
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid');
    const result: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid');
    return result as Record<string, unknown>;
  } catch {
    throw new OperationRequestError(422, 'INVALID_CURSOR', '分页游标无效，请从第一页重新读取。');
  }
}

/** PostgreSQL owns acceptance, execution leases and outcomes; Redis is transport only. */
export class TaskRepository {
  readonly options: TaskingOptions;

  constructor(
    readonly db: PrismaClient,
    options: Partial<TaskingOptions> = {},
  ) {
    this.options = { ...defaultTaskingOptions, ...options };
    if (
      this.options.leaseRenewMs >= this.options.leaseMs ||
      Object.values(this.options).some((n) => n <= 0)
    ) {
      throw new Error('Task timeouts must be positive and lease renewal must precede expiry');
    }
  }

  async createDiagnostic(
    actor: OperationActor,
    key: unknown,
    value: unknown = {},
  ): Promise<OperationView> {
    const input = diagnosticInput(value);
    return this.enqueue(actor, key, { kind: 'diagnostic', request: input }, async () => ({
      input,
    }));
  }

  async retry(id: string, actor: OperationActor, key: unknown): Promise<OperationView> {
    const original = await this.requireOperation(id);
    if (original.kind !== 'diagnostic' || original.status !== 'failed') {
      throw new OperationRequestError(
        409,
        'OPERATION_NOT_RETRYABLE',
        '仅已失败的诊断任务可以创建重试。',
      );
    }
    const input = diagnosticInput(original.input);
    return this.enqueue(
      actor,
      key,
      { kind: 'diagnostic', request: input, retryOfId: original.id },
      async () => ({ input }),
    );
  }

  async enqueue(
    actor: OperationActor,
    rawKey: unknown,
    definition: { kind: TaskKind; request: unknown; retryOfId?: string },
    prepare: (
      tx: Prisma.TransactionClient,
      context: TaskAdmissionContext,
    ) => Promise<PreparedOperation>,
  ): Promise<OperationView> {
    const key = validateIdempotencyKey(rawKey);
    const { kind, retryOfId } = definition;
    const scope = operationScope(kind);
    const idempotencyScope = `admin:${actor.id}:operations`;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify(
          kind === 'diagnostic'
            ? { kind, input: definition.request, retryOfId: retryOfId ?? null }
            : { kind, request: definition.request, retryOfId: retryOfId ?? null },
        ),
      )
      .digest('hex');
    const unique = { idempotencyScope, idempotencyKey: key };
    const checkExisting = (operation: OperationRow): OperationView => {
      if (operation.requestHash !== requestHash) {
        throw new OperationRequestError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '此幂等键已用于不同的任务请求。',
        );
      }
      return operationView(operation);
    };

    try {
      return await this.db.$transaction(async (tx) => {
        const state = await assertWritable(tx);
        // Serialize admission only, so the durable queue has a real upper bound during outages.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(657090112)`;
        const existing = await tx.operation.findUnique({
          where: { idempotencyScope_idempotencyKey: unique },
        });
        if (existing) return checkExisting(existing);
        await this.requireQueueCapacity(tx);
        const id = randomUUID();
        const prepared = await prepare(tx, { id, generation: state.generation });
        const input = taskInput(kind, prepared.input);
        if (
          (kind.startsWith('service_') || kind.startsWith('domain_')) &&
          prepared.serviceId !== (input as ServiceOperationInput).serviceId
        )
          throw new OperationRequestError(
            422,
            'INVALID_OPERATION_INPUT',
            '服务操作与固定目标不一致。',
          );
        const operation = await tx.operation.create({
          data: {
            id,
            kind,
            scope,
            input: json(input),
            serverId: prepared.serverId,
            clusterId:
              kind.startsWith('service_') || kind.startsWith('domain_')
                ? (input as ServiceOperationInput).target.clusterId
                : prepared.clusterId,
            candidateCredentialRefId: prepared.candidateCredentialRefId,
            serviceId: prepared.serviceId,
            logsJson: [],
            generation: state.generation,
            createdById: actor.id,
            requestId: actor.requestId?.slice(0, 128),
            ...unique,
            requestHash,
            retryOfId,
            outbox: { create: {} },
          },
        });
        if (prepared.serviceId)
          await tx.serviceMutation.create({
            data: { serviceId: prepared.serviceId, operationId: operation.id },
          });
        await prepared.onAccepted?.(tx, { type: 'operation', id: operation.id });
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            requestId: actor.requestId?.slice(0, 128),
            action: retryOfId ? 'operation.retry' : 'operation.create',
            resourceType: 'operation',
            resourceId: operation.id,
            outcome: 'accepted',
            metadata: { kind, ...(retryOfId ? { retryOfId } : {}) },
          },
        });
        return operationView(operation);
      });
    } catch (error) {
      // Concurrent submissions can both miss the read; the unique constraint decides the winner.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.db.operation.findUnique({
          where: { idempotencyScope_idempotencyKey: unique },
        });
        if (existing) return checkExisting(existing);
        throw new OperationRequestError(
          409,
          'RESOURCE_OPERATION_ACTIVE',
          '该资源已有在途任务，或其身份已被登记，请核对后重试。',
        );
      }
      throw error;
    }
  }

  async enqueueDeployment(
    actor: DeploymentActor,
    rawKey: unknown,
    definition: { kind?: 'image_deploy' | 'git_deploy'; request: unknown; retryOfId?: string },
    prepare: (
      tx: Prisma.TransactionClient,
      context: TaskAdmissionContext,
    ) => Promise<PreparedDeployment>,
  ): Promise<DeploymentTaskView> {
    const key = validateIdempotencyKey(rawKey);
    const webhook = 'kind' in actor && actor.kind === 'webhook' ? actor : null;
    const admin = 'id' in actor ? actor : null;
    const kind = definition.kind ?? 'image_deploy';
    const unique = {
      idempotencyScope: webhook
        ? `webhook-target:${webhook.webhookTargetId}:deployments`
        : `admin:${admin!.id}:deployments`,
      idempotencyKey: key,
    };
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          kind,
          request: definition.request,
          retryOfId: definition.retryOfId ?? null,
        }),
      )
      .digest('hex');
    const checkExisting = (record: DeploymentRow) => {
      if (record.requestHash !== requestHash)
        throw new OperationRequestError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '此幂等键已用于不同的发布请求。',
        );
      return deploymentView(record);
    };
    try {
      return await this.db.$transaction(async (tx) => {
        const state = await assertWritable(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(657090112)`;
        const existing = await tx.deployment.findUnique({
          where: { idempotencyScope_idempotencyKey: unique },
        });
        if (existing) return checkExisting(existing);
        await this.requireQueueCapacity(tx);
        const id = randomUUID();
        const prepared = await prepare(tx, { id, generation: state.generation });
        const input = deploymentInput(prepared.input);
        const webhookDeliveryId = webhook?.webhookDeliveryId ?? prepared.webhookDeliveryId;
        const webhookTargetId = webhook?.webhookTargetId ?? prepared.webhookTargetId;
        if (
          Boolean(webhookDeliveryId) !== Boolean(webhookTargetId) ||
          (webhook &&
            ((prepared.webhookDeliveryId &&
              prepared.webhookDeliveryId !== webhook.webhookDeliveryId) ||
              (prepared.webhookTargetId &&
                prepared.webhookTargetId !== webhook.webhookTargetId))) ||
          (webhookTargetId && (kind !== 'git_deploy' || definition.retryOfId))
        )
          throw new OperationRequestError(
            422,
            'INVALID_DEPLOYMENT_INPUT',
            'Webhook 投递与发布目标必须成对且只关联原始发布。',
          );
        if (webhookTargetId) {
          const target = await tx.webhookTarget.findUnique({ where: { id: webhookTargetId } });
          const snapshot = prepared.snapshotJson as unknown as {
            version?: unknown;
            source?: { revision?: { id?: unknown }; commitSha?: unknown };
          };
          if (
            !target ||
            target.webhookDeliveryId !== webhookDeliveryId ||
            target.serviceId !== prepared.serviceId ||
            target.sourceRevisionId !== prepared.sourceRevisionId ||
            target.deploymentId ||
            !['waiting', 'pending'].includes(target.state) ||
            snapshot.version !== 3 ||
            snapshot.source?.revision?.id !== target.sourceRevisionId ||
            snapshot.source.commitSha !== target.commitSha
          )
            throw new OperationRequestError(
              422,
              'INVALID_DEPLOYMENT_INPUT',
              'Webhook 投递的固定源码与发布快照不一致。',
            );
        }
        if (
          (kind === 'git_deploy'
            ? !prepared.sourceRevisionId
            : Boolean(prepared.sourceRevisionId || prepared.reuseArtifactId)) ||
          input.serviceId !== prepared.serviceId ||
          input.mutationRevision !== prepared.mutationRevision ||
          !Number.isSafeInteger(prepared.configRevision) ||
          prepared.configRevision < 1
        )
          throw new OperationRequestError(
            422,
            'INVALID_DEPLOYMENT_INPUT',
            '发布配置与固定目标不一致。',
          );
        const deployment = await tx.deployment.create({
          data: {
            id,
            kind,
            scope: 'service',
            input: json(input),
            logsJson: [],
            generation: state.generation,
            createdById: admin?.id ?? null,
            initiatorKind: webhook ? 'webhook' : 'admin',
            webhookDeliveryId,
            webhookTargetId,
            requestId: admin?.requestId?.slice(0, 128),
            ...unique,
            requestHash,
            retryOfId: definition.retryOfId,
            serviceId: prepared.serviceId,
            configRevision: prepared.configRevision,
            mutationRevision: prepared.mutationRevision,
            snapshotJson: prepared.snapshotJson,
            targetJson: prepared.targetJson,
            resolvedImageJson: prepared.resolvedImageJson,
            sourceRevisionId: prepared.sourceRevisionId,
            reuseArtifactId: prepared.reuseArtifactId,
            artifactId: prepared.reuseArtifactId,
            outbox: { create: {} },
          },
        });
        await tx.serviceMutation.create({
          data: { serviceId: prepared.serviceId, deploymentId: id },
        });
        await prepared.onAccepted?.(tx, { type: 'deployment', id });
        await tx.auditEvent.create({
          data: {
            actorId: admin?.id ?? null,
            requestId: admin?.requestId?.slice(0, 128),
            action: definition.retryOfId ? 'deployment.retry' : 'deployment.create',
            resourceType: 'deployment',
            resourceId: id,
            outcome: 'accepted',
            metadata: {
              kind,
              ...(webhook
                ? {
                    initiatorKind: 'webhook',
                    webhookTargetId: webhook.webhookTargetId,
                    webhookDeliveryId: webhook.webhookDeliveryId,
                  }
                : {}),
              ...(definition.retryOfId ? { retryOfId: definition.retryOfId } : {}),
            },
          },
        });
        return deploymentView(deployment);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.db.deployment.findUnique({
          where: { idempotencyScope_idempotencyKey: unique },
        });
        if (existing) return checkExisting(existing);
        throw new OperationRequestError(
          409,
          'SERVICE_MUTATION_ACTIVE',
          '该服务已有在途发布或操作，请等待完成后再提交。',
        );
      }
      throw error;
    }
  }

  private async requireQueueCapacity(tx: Prisma.TransactionClient): Promise<void> {
    const where = { status: { in: ['queued', 'running'] as OperationStatus[] } };
    const pending = (await tx.operation.count({ where })) + (await tx.deployment.count({ where }));
    if (pending >= this.options.maxPendingOperations)
      throw new OperationRequestError(
        429,
        'OPERATION_QUEUE_FULL',
        '待执行任务已达到上限，请待已有任务完成后再提交。',
      );
  }

  async list(
    query: {
      limit?: unknown;
      cursor?: string;
      status?: string;
      serverId?: string;
      clusterId?: string;
      serviceId?: string;
    } = {},
  ): Promise<Page<OperationView>> {
    const limit = pageLimit(query.limit);
    const where: Prisma.OperationWhereInput = {};
    for (const key of ['serverId', 'clusterId', 'serviceId'] as const) {
      if (query[key]) {
        validateOperationId(query[key]);
        where[key] = query[key];
      }
    }
    if (query.status) {
      if (!operationStatuses.includes(query.status as OperationStatus)) {
        throw new OperationRequestError(422, 'INVALID_OPERATION_STATUS', '任务状态筛选无效。');
      }
      where.status = query.status as OperationStatus;
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (
        cursor.type !== 'operations' ||
        typeof cursor.id !== 'string' ||
        typeof cursor.createdAt !== 'string'
      ) {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '任务分页游标无效。');
      }
      try {
        validateOperationId(cursor.id);
      } catch {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '任务分页游标无效。');
      }
      const createdAt = new Date(cursor.createdAt);
      if (Number.isNaN(createdAt.getTime()))
        throw new OperationRequestError(422, 'INVALID_CURSOR', '游标时间无效。');
      where.OR = [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }];
    }
    const rows = await this.db.operation.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(operationView),
      page: {
        nextCursor:
          hasMore && last
            ? encodeCursor({
                type: 'operations',
                id: last.id,
                createdAt: last.createdAt.toISOString(),
              })
            : null,
        hasMore,
      },
    };
  }

  async get(id: string): Promise<OperationView> {
    return operationView(await this.requireOperation(id));
  }

  private async requireOperation(id: string): Promise<OperationRow> {
    validateOperationId(id);
    const operation = await this.db.operation.findUnique({ where: { id } });
    if (!operation) throw new OperationRequestError(404, 'OPERATION_NOT_FOUND', '操作记录不存在。');
    return operation;
  }

  async listDeployments(
    query: {
      limit?: unknown;
      cursor?: string;
      status?: string;
      phase?: string;
      serviceId?: string;
      projectId?: string;
      environmentId?: string;
      clusterId?: string;
    } = {},
  ): Promise<Page<DeploymentTaskView>> {
    const limit = pageLimit(query.limit);
    const where: Prisma.DeploymentWhereInput = {};
    if (query.status) {
      if (!operationStatuses.includes(query.status as OperationStatus))
        throw new OperationRequestError(422, 'INVALID_DEPLOYMENT_STATUS', '发布执行状态筛选无效。');
      where.status = query.status as OperationStatus;
    }
    if (query.phase) {
      if (!/^[a-z_]{1,64}$/.test(query.phase))
        throw new OperationRequestError(422, 'INVALID_DEPLOYMENT_PHASE', '发布阶段筛选无效。');
      where.phase = query.phase;
    }
    if (query.serviceId) {
      validateOperationId(query.serviceId);
      where.serviceId = query.serviceId;
    }
    const targets: Prisma.DeploymentWhereInput[] = [];
    for (const key of ['projectId', 'environmentId', 'clusterId'] as const) {
      const id = query[key];
      if (!id) continue;
      validateOperationId(id);
      targets.push({ targetJson: { path: [key], equals: id } });
    }
    if (targets.length) where.AND = targets;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (
        cursor.type !== 'deployments' ||
        typeof cursor.id !== 'string' ||
        typeof cursor.createdAt !== 'string'
      )
        throw new OperationRequestError(422, 'INVALID_CURSOR', '发布分页游标无效。');
      try {
        validateOperationId(cursor.id);
      } catch {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '发布分页游标无效。');
      }
      const createdAt = new Date(cursor.createdAt);
      if (Number.isNaN(createdAt.getTime()))
        throw new OperationRequestError(422, 'INVALID_CURSOR', '游标时间无效。');
      where.OR = [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }];
    }
    const rows = await this.db.deployment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);
    const last = data.at(-1);
    return {
      data: data.map(deploymentView),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                type: 'deployments',
                id: last.id,
                createdAt: last.createdAt.toISOString(),
              })
            : null,
      },
    };
  }

  async getDeployment(id: string): Promise<DeploymentTaskView> {
    validateOperationId(id);
    const row = await this.db.deployment.findUnique({ where: { id } });
    if (!row) throw new OperationRequestError(404, 'DEPLOYMENT_NOT_FOUND', '发布记录不存在。');
    return deploymentView(row);
  }

  async logs(
    id: string,
    query: { limit?: unknown; cursor?: string } = {},
  ): Promise<OperationLogPage> {
    return this.taskLogs({ type: 'operation', id }, query) as Promise<OperationLogPage>;
  }

  async deploymentLogs(
    id: string,
    query: { limit?: unknown; cursor?: string } = {},
  ): Promise<DeploymentLogPage> {
    return this.taskLogs({ type: 'deployment', id }, query) as Promise<DeploymentLogPage>;
  }

  private async taskLogs(
    ref: TaskRef,
    query: { limit?: unknown; cursor?: string },
  ): Promise<TaskLogPage> {
    validateOperationId(ref.id);
    const stored = await readTask(this.db, ref);
    if (!stored)
      throw new OperationRequestError(
        404,
        ref.type === 'operation' ? 'OPERATION_NOT_FOUND' : 'DEPLOYMENT_NOT_FOUND',
        '任务记录不存在。',
      );
    const task = stored.data;
    const limit = pageLimit(query.limit, 100);
    let after = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (
        cursor.type !== `${ref.type}-logs` ||
        cursor.id !== ref.id ||
        !Number.isInteger(cursor.after) ||
        (cursor.after as number) < 0
      )
        throw new OperationRequestError(422, 'INVALID_CURSOR', '此日志游标不属于当前任务。');
      after = cursor.after as number;
    }
    const expired =
      task.finishedAt !== null &&
      (task.logsJson === null ||
        task.finishedAt.getTime() < Date.now() - this.options.logRetentionMs);
    const all = expired ? [] : readOperationLogs(task.logsJson);
    const matching = all.filter((line) => line.sequence > after);
    const data = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    const last = data.at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({ type: `${ref.type}-logs`, id: ref.id, after: last.sequence })
            : null,
      },
      source: ref.type,
      available: all.length > 0,
      unavailableReason: all.length
        ? null
        : expired
          ? 'expired'
          : task.attempts === 0
            ? 'not_started'
            : 'not_available',
      truncated: all.some((line) => line.code === 'LOG_LIMIT_REACHED'),
    };
  }

  async cancel(id: string, actor: OperationActor): Promise<OperationView> {
    const record = await this.cancelTask({ type: 'operation', id }, actor);
    if (record.type !== 'operation') throw new Error('TASK_TYPE_MISMATCH');
    return operationView(record.data);
  }

  async cancelDeployment(id: string, actor: OperationActor): Promise<DeploymentTaskView> {
    const record = await this.cancelTask({ type: 'deployment', id }, actor);
    if (record.type !== 'deployment') throw new Error('TASK_TYPE_MISMATCH');
    return deploymentView(record.data);
  }

  private async cancelTask(ref: TaskRef, actor: OperationActor): Promise<StoredTask> {
    validateOperationId(ref.id);
    return this.db.$transaction(async (tx) => {
      await assertWritable(tx);
      const stored = await lockTask(tx, ref);
      if (!stored)
        throw new OperationRequestError(
          404,
          ref.type === 'operation' ? 'OPERATION_NOT_FOUND' : 'DEPLOYMENT_NOT_FOUND',
          '任务记录不存在。',
        );
      const task = stored.data;
      if (terminalStatuses.includes(task.status)) return stored;
      const canEnd =
        task.status === 'queued' &&
        (await closeBuildsBeforeTransition(tx, ref, 'cancelled_before_submission'));
      if (ref.type === 'deployment')
        await tx.buildRun.updateMany({
          where: { deploymentId: ref.id, executionClosedAt: null },
          data: { cancelRequestedAt: new Date(), nextReconcileAt: new Date() },
        });
      const now = new Date();
      const changed = await updateTask(
        tx,
        ref,
        { status: task.status, attempts: task.attempts },
        {
          cancelRequestedAt: task.cancelRequestedAt ?? now,
          ...(canEnd
            ? {
                status: 'cancelled',
                finishedAt: now,
                logsJson: json(
                  this.appendLog(task.logsJson, 'info', '任务在执行前取消。', task.attempts),
                ),
              }
            : {}),
        },
      );
      if (!changed.count)
        throw new OperationRequestError(
          409,
          'OPERATION_CHANGED',
          '任务状态已改变，请刷新后重试取消。',
        );
      if (canEnd) {
        await releaseMutationSlot(tx, ref);
        await this.finishDeploymentAttempt(tx, stored, 'cancelled');
      }
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          requestId: actor.requestId?.slice(0, 128),
          action: `${ref.type}.cancel`,
          resourceType: ref.type,
          resourceId: ref.id,
          outcome: 'accepted',
        },
      });
      return (await readTask(tx, ref))!;
    });
  }

  async claim(operationId: string, workerId: string): Promise<TaskLease | null> {
    const lease = await this.claimTask({ type: 'operation', id: operationId }, workerId);
    return lease?.ref.type === 'operation' ? (lease as TaskLease) : null;
  }

  async claimDeployment(deploymentId: string, workerId: string): Promise<DeploymentLease | null> {
    const lease = await this.claimTask({ type: 'deployment', id: deploymentId }, workerId);
    return lease?.ref.type === 'deployment' ? (lease as DeploymentLease) : null;
  }

  async claimTask(ref: TaskRef, workerId: string): Promise<ExecutionLease | null> {
    validateOperationId(ref.id);
    return this.db.$transaction(async (tx) => {
      const state = await assertWritable(tx);
      const stored = await lockTask(tx, ref);
      if (!stored || terminalStatuses.includes(stored.data.status)) return null;
      const task = stored.data;
      if (task.generation !== state.generation) {
        await this.rejectOldGeneration(tx, stored);
        return null;
      }
      const now = new Date();
      if (task.leaseExpiresAt && task.leaseExpiresAt > now) return null;
      if (task.nextAttemptAt > now) return null;
      if (task.attempts >= task.maxAttempts) {
        await this.endUnclaimed(
          tx,
          stored,
          'failed',
          'ATTEMPTS_EXHAUSTED',
          '任务达到最大尝试次数。',
        );
        return null;
      }
      if (task.cancelRequestedAt) {
        await this.endUnclaimed(tx, stored, 'cancelled', null, '任务已取消。');
        return null;
      }
      if (!(await ownsMutationSlot(tx, stored))) {
        await this.endUnclaimed(
          tx,
          stored,
          'failed',
          'SERVICE_MUTATION_LOST',
          '服务不存在或其变更槽位已不属于此任务，已阻止执行。',
        );
        return null;
      }
      if (!(await closeBuildsBeforeTransition(tx, ref))) return null;
      let input: TaskInput | DeploymentInput;
      try {
        if (stored.type === 'deployment') {
          const row = stored.data;
          if (!['image_deploy', 'git_deploy'].includes(row.kind) || row.scope !== 'service')
            throw new Error('Unsupported deployment');
          input = deploymentInput(row.input);
          if (
            input.serviceId !== row.serviceId ||
            input.mutationRevision !== row.mutationRevision ||
            row.configRevision < 1
          )
            throw new Error('Mismatched deployment target');
        } else {
          const row = stored.data;
          if (
            (row.kind !== 'diagnostic' &&
              !(infrastructureKinds as readonly string[]).includes(row.kind) &&
              !(serviceOperationKinds as readonly string[]).includes(row.kind) &&
              !(domainOperationKinds as readonly string[]).includes(row.kind) &&
              !(clusterNetworkingKinds as readonly string[]).includes(row.kind) &&
              !(volumeOperationKinds as readonly string[]).includes(row.kind) &&
              !(integrationOperationKinds as readonly string[]).includes(row.kind)) ||
            row.scope !== operationScope(row.kind)
          ) {
            await this.endUnclaimed(
              tx,
              stored,
              'failed',
              'UNSUPPORTED_OPERATION',
              '当前 Worker 不支持此任务类型或目标。',
            );
            return null;
          }
          input = taskInput(row.kind, row.input);
          if (row.kind.startsWith('service_') || row.kind.startsWith('domain_')) {
            const target = input as ServiceOperationInput | DomainOperationInput;
            if (
              row.serviceId !== target.serviceId ||
              row.clusterId !== target.target.clusterId ||
              row.serverId !== null
            )
              throw new Error('Mismatched service target');
          } else if ((volumeOperationKinds as readonly string[]).includes(row.kind)) {
            const target = input as VolumeOperationInput;
            if (
              row.clusterId !== target.target.clusterId ||
              row.serviceId !== null ||
              row.serverId !== null
            )
              throw new Error('Mismatched storage target');
          } else if ((clusterNetworkingKinds as readonly string[]).includes(row.kind)) {
            const target = input as ClusterNetworkingOperationInput;
            if (
              row.clusterId !== target.clusterId ||
              row.serviceId !== null ||
              row.serverId !== null
            )
              throw new Error('Mismatched networking target');
          } else if ((integrationOperationKinds as readonly string[]).includes(row.kind)) {
            if (row.serviceId || row.serverId || row.clusterId)
              throw new Error('Mismatched integration target');
          } else if (row.kind !== 'diagnostic') {
            const target = input as import('./contracts.js').InfrastructureInput;
            if (
              (row.kind.startsWith('cluster_') ? row.clusterId : row.serverId) !==
                target.targetId ||
              (target.clusterId && row.clusterId !== target.clusterId)
            )
              throw new Error('Mismatched infrastructure target');
          } else if (row.serviceId !== null) throw new Error('Diagnostic cannot own a service');
        }
      } catch {
        await this.endUnclaimed(
          tx,
          stored,
          'failed',
          stored.type === 'operation' ? 'INVALID_OPERATION_INPUT' : 'INVALID_DEPLOYMENT_INPUT',
          '持久化的任务参数无效。',
        );
        return null;
      }
      const token = randomUUID();
      const changed = await updateTask(
        tx,
        ref,
        {
          status: task.status,
          attempts: task.attempts,
          generation: state.generation,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        {
          status: 'running',
          attempts: { increment: 1 },
          startedAt: task.startedAt ?? now,
          leaseOwner: workerId,
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs),
          errorCode: null,
          errorMessage: null,
          logsJson: json(
            this.appendLog(task.logsJson, 'info', 'Worker 已领取任务。', task.attempts + 1),
          ),
        },
      );
      if (!changed.count) return null;
      const common = { token, generation: state.generation, attempt: task.attempts + 1 };
      if (stored.type === 'operation')
        return {
          ...common,
          ref: stored.ref,
          operationId: stored.ref.id,
          kind: stored.data.kind as TaskKind,
          serverId: stored.data.serverId,
          clusterId: stored.data.clusterId,
          serviceId: stored.data.serviceId,
          input: input as TaskInput,
        };
      return {
        ...common,
        ref: stored.ref,
        deploymentId: stored.ref.id,
        kind: stored.data.kind as 'image_deploy' | 'git_deploy',
        serviceId: stored.data.serviceId!,
        input: input as DeploymentInput,
        configRevision: stored.data.configRevision,
        mutationRevision: stored.data.mutationRevision,
      };
    });
  }

  private async currentLease(
    tx: Prisma.TransactionClient,
    lease: ExecutionLease,
    allowCancellation = false,
  ): Promise<StoredTask | null> {
    const state = await assertWritable(tx);
    if (state.generation !== lease.generation) return null;
    const stored = await lockTask(tx, lease.ref);
    if (
      !stored ||
      stored.data.generation !== lease.generation ||
      stored.data.status !== 'running' ||
      stored.data.leaseToken !== lease.token ||
      !stored.data.leaseExpiresAt ||
      stored.data.leaseExpiresAt <= new Date() ||
      (!allowCancellation && stored.data.cancelRequestedAt) ||
      !(await ownsMutationSlot(tx, stored))
    )
      return null;
    return stored;
  }

  async renew(lease: ExecutionLease): Promise<'renewed' | 'cancel' | 'lost'> {
    return this.db.$transaction(async (tx) => {
      const stored = await this.currentLease(tx, lease, true);
      if (!stored) return 'lost';
      if (stored.data.cancelRequestedAt) return 'cancel';
      const now = new Date();
      const changed = await updateTask(
        tx,
        lease.ref,
        {
          status: 'running',
          leaseToken: lease.token,
          generation: lease.generation,
          leaseExpiresAt: { gt: now },
        },
        { leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs) },
      );
      return changed.count ? 'renewed' : 'lost';
    });
  }

  async complete(lease: ExecutionLease, outcome?: TaskOutcome): Promise<boolean> {
    try {
      return await this.db.$transaction(async (tx) => {
        const stored = await this.currentLease(tx, lease, true);
        if (!stored) return false;
        if (
          !(await closeBuildsBeforeTransition(
            tx,
            lease.ref,
            stored.data.cancelRequestedAt
              ? 'cancelled_before_submission'
              : 'rejected_before_submission',
          ))
        )
          return false;
        const task = stored.data;
        const cancelled = Boolean(task.cancelRequestedAt);
        const now = new Date();
        const result =
          outcome?.result ??
          (lease.kind === 'diagnostic'
            ? {
                check: 'database-roundtrip',
                database: 'ok',
                operationId: lease.ref.id,
                completedAt: now.toISOString(),
              }
            : { taskId: lease.ref.id, completedAt: now.toISOString() });
        const changed = await updateTask(
          tx,
          lease.ref,
          {
            status: 'running',
            leaseToken: lease.token,
            generation: lease.generation,
            leaseExpiresAt: { gt: now },
          },
          {
            status: cancelled ? 'cancelled' : 'succeeded',
            finishedAt: now,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            ...(cancelled ? {} : { result }),
            logsJson: json(
              this.appendLog(
                task.logsJson,
                'info',
                cancelled
                  ? '任务执行已停止，取消完成；已发生的远端变更保留。'
                  : lease.kind === 'diagnostic'
                    ? '数据库往返与持久任务结果提交成功。'
                    : '操作完成，验证后的观察结果已保存。',
                task.attempts,
              ),
            ),
          },
        );
        if (!changed.count) throw new TaskFenceLost();
        // Terminal status and slot release precede a domain deletion of Service;
        // its SET NULL FKs must never orphan an active task. Failure rolls back all.
        await releaseMutationSlot(tx, lease.ref);
        if (!cancelled) await outcome?.commit?.(tx);
        if (!task.leaseExpiresAt || task.leaseExpiresAt <= new Date()) throw new TaskFenceLost();
        await this.finishDeploymentAttempt(tx, stored, cancelled ? 'cancelled' : 'succeeded');
        return true;
      });
    } catch (error) {
      if (error instanceof TaskFenceLost) return false;
      throw error;
    }
  }

  /** Domain checkpoints, progress and completion share the same durable fence. */
  async checkpoint(
    lease: ExecutionLease,
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    try {
      return await this.db.$transaction(async (tx) => {
        const stored = await this.currentLease(tx, lease);
        if (!stored) return false;
        await work(tx);
        const current = await readTask(tx, lease.ref);
        if (
          !current ||
          current.data.leaseToken !== lease.token ||
          current.data.status !== 'running' ||
          current.data.generation !== lease.generation ||
          current.data.cancelRequestedAt ||
          !current.data.leaseExpiresAt ||
          current.data.leaseExpiresAt <= new Date() ||
          !(await ownsMutationSlot(tx, current))
        )
          throw new TaskFenceLost();
        return true;
      });
    } catch (error) {
      if (error instanceof TaskFenceLost) return false;
      throw error;
    }
  }

  async progress(lease: ExecutionLease, message: string, code?: string): Promise<boolean> {
    return this.checkpoint(lease, async (tx) => {
      const stored = (await readTask(tx, lease.ref))!;
      await updateTask(
        tx,
        lease.ref,
        {},
        {
          logsJson: json(
            this.appendLog(stored.data.logsJson, 'info', message, stored.data.attempts, code),
          ),
        },
      );
    });
  }

  async fail(
    lease: ExecutionLease,
    code: string,
    message: string,
    retryable: boolean,
    commit?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<boolean> {
    try {
      return await this.db.$transaction(async (tx) => {
        const stored = await this.currentLease(tx, lease, true);
        if (!stored) return false;
        if (
          !(await closeBuildsBeforeTransition(
            tx,
            lease.ref,
            stored.data.cancelRequestedAt
              ? 'cancelled_before_submission'
              : 'rejected_before_submission',
          ))
        )
          return false;
        const task = stored.data;
        const cancelled = Boolean(task.cancelRequestedAt);
        const retry = !cancelled && retryable && task.attempts < task.maxAttempts;
        const now = new Date();
        const nextAttemptAt = new Date(now.getTime() + this.retryDelay(task.attempts));
        const changed = await updateTask(
          tx,
          lease.ref,
          {
            status: 'running',
            leaseToken: lease.token,
            generation: lease.generation,
            leaseExpiresAt: { gt: now },
          },
          {
            status: cancelled ? 'cancelled' : retry ? 'queued' : 'failed',
            finishedAt: retry ? null : now,
            nextAttemptAt: retry ? nextAttemptAt : task.nextAttemptAt,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            errorCode: cancelled ? null : code.slice(0, 80),
            errorMessage: cancelled ? null : message.slice(0, 1000),
            logsJson: json(
              this.appendLog(
                task.logsJson,
                cancelled ? 'info' : retry ? 'warn' : 'error',
                cancelled ? '任务执行已停止，取消完成。' : message,
                task.attempts,
                cancelled ? undefined : code,
              ),
            ),
          },
        );
        if (!changed.count) throw new TaskFenceLost();
        if (!retry) await releaseMutationSlot(tx, lease.ref);
        if (!cancelled) await commit?.(tx);
        if (!task.leaseExpiresAt || task.leaseExpiresAt <= new Date()) throw new TaskFenceLost();
        await this.finishDeploymentAttempt(
          tx,
          stored,
          cancelled ? 'cancelled' : 'failed',
          cancelled ? null : code.slice(0, 80),
        );
        if (retry) await this.resetOutbox(tx, lease.ref, nextAttemptAt);
        return true;
      });
    } catch (error) {
      if (error instanceof TaskFenceLost) return false;
      throw error;
    }
  }

  private retryDelay(attempts: number): number {
    return Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.min(attempts - 1, 8),
    );
  }

  async claimDelivery(): Promise<DeliveryLease | null> {
    return this.db.$transaction(async (tx) => {
      const state = await assertWritable(tx);
      const now = new Date();
      const outbox = await tx.outbox.findFirst({
        where: {
          publishedAt: null,
          availableAt: { lte: now },
          AND: [
            { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
            {
              OR: [
                { operation: { status: 'queued', generation: state.generation } },
                { deployment: { status: 'queued', generation: state.generation } },
              ],
            },
          ],
        },
        orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      });
      if (!outbox) return null;
      const ref = outboxTaskRef(outbox);
      if (!ref) throw new Error('OUTBOX_TASK_MISMATCH');
      const token = randomUUID();
      const claimed = await tx.outbox.updateMany({
        where: {
          id: outbox.id,
          publishedAt: null,
          deliverySequence: outbox.deliverySequence,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + this.options.relayLeaseMs),
          attempts: { increment: 1 },
        },
      });
      return claimed.count
        ? {
            id: outbox.id,
            ref,
            operationId: outbox.operationId,
            deploymentId: outbox.deploymentId,
            token,
            deliverySequence: outbox.deliverySequence,
            jobId: taskJobId(ref, outbox.deliverySequence),
          }
        : null;
    });
  }

  async publishDelivery(
    lease: DeliveryLease,
    publish: (jobId: string, taskId: string, ref: TaskRef) => Promise<void>,
  ): Promise<boolean> {
    // A bounded publication owns the recovery shared lock until Redis has
    // acknowledged it. Both task types enforce generation again at execution.
    return this.db.$transaction(
      async (tx) => {
        const state = await assertWritable(tx);
        const outbox = await tx.outbox.findUnique({
          where: { id: lease.id },
          include: { operation: true, deployment: true },
        });
        if (
          !outbox ||
          outbox.leaseToken !== lease.token ||
          outbox.publishedAt ||
          outbox.deliverySequence !== lease.deliverySequence ||
          !outbox.leaseExpiresAt ||
          outbox.leaseExpiresAt <= new Date()
        )
          return false;
        const ref = outboxTaskRef(outbox);
        if (!ref || ref.type !== lease.ref.type || ref.id !== lease.ref.id) return false;
        const task = ref.type === 'operation' ? outbox.operation : outbox.deployment;
        if (!task || task.generation !== state.generation || task.status !== 'queued') return false;
        await publish(lease.jobId, ref.id, ref);
        const changed = await tx.outbox.updateMany({
          where: {
            id: lease.id,
            leaseToken: lease.token,
            deliverySequence: lease.deliverySequence,
          },
          data: {
            publishedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
            lastErrorCode: null,
          },
        });
        return changed.count === 1;
      },
      { timeout: 5000, maxWait: 2000 },
    );
  }

  async releaseDelivery(lease: DeliveryLease): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await assertWritable(tx);
      const outbox = await tx.outbox.findUnique({ where: { id: lease.id } });
      if (!outbox || outbox.leaseToken !== lease.token) return;
      await tx.outbox.updateMany({
        where: { id: lease.id, leaseToken: lease.token },
        data: {
          availableAt: new Date(Date.now() + this.retryDelay(outbox.attempts)),
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCode: 'QUEUE_UNAVAILABLE',
        },
      });
    });
  }

  async recoveryCandidates(limit = 50): Promise<TaskRecoveryCandidate[]> {
    const state = await readRecoveryState(this.db);
    const now = new Date();
    const where = {
      status: { in: ['queued', 'running'] as OperationStatus[] },
      OR: [
        { generation: { not: state.generation } },
        {
          status: 'running' as const,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        {
          status: 'queued' as const,
          outbox: { publishedAt: { lte: new Date(now.getTime() - this.options.recoveryAfterMs) } },
        },
        { status: 'queued' as const, outbox: { is: null } },
      ],
    };
    const select = {
      id: true,
      generation: true,
      status: true,
      outbox: true,
      updatedAt: true,
    } as const;
    const [operations, deployments] = await Promise.all([
      this.db.operation.findMany({
        where,
        select,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
      this.db.deployment.findMany({
        where,
        select,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    ]);
    return [
      ...operations.map((row) => ({ ...row, ref: { type: 'operation' as const, id: row.id } })),
      ...deployments.map((row) => ({ ...row, ref: { type: 'deployment' as const, id: row.id } })),
    ]
      .sort(
        (left, right) =>
          left.updatedAt.getTime() - right.updatedAt.getTime() ||
          left.id.localeCompare(right.id) ||
          left.ref.type.localeCompare(right.ref.type),
      )
      .slice(0, limit);
  }

  async recoverOperation(id: string, expectedDeliverySequence?: number): Promise<boolean> {
    return this.recoverTask({ type: 'operation', id }, expectedDeliverySequence);
  }

  async recoverTask(ref: TaskRef, expectedDeliverySequence?: number): Promise<boolean> {
    validateOperationId(ref.id);
    return this.db.$transaction(async (tx) => {
      const state = await assertWritable(tx);
      const stored = await lockTask(tx, ref);
      if (!stored || terminalStatuses.includes(stored.data.status)) return false;
      const task = stored.data;
      if (task.generation !== state.generation) {
        await this.rejectOldGeneration(tx, stored);
        return true;
      }
      const now = new Date();
      if (task.leaseExpiresAt && task.leaseExpiresAt > now) return false;
      const outbox = await tx.outbox.findUnique({
        where: ref.type === 'operation' ? { operationId: ref.id } : { deploymentId: ref.id },
      });
      if (
        expectedDeliverySequence !== undefined &&
        outbox?.deliverySequence !== expectedDeliverySequence
      )
        return false;
      if (task.cancelRequestedAt) {
        await this.endUnclaimed(
          tx,
          stored,
          'cancelled',
          null,
          '取消请求已确认，任务不会重新执行。',
        );
        return true;
      }
      if (task.attempts >= task.maxAttempts) {
        await this.endUnclaimed(
          tx,
          stored,
          'failed',
          'ATTEMPTS_EXHAUSTED',
          '执行租约失效且任务已达到最大尝试次数。',
        );
        return true;
      }
      if (!(await ownsMutationSlot(tx, stored))) {
        await this.endUnclaimed(
          tx,
          stored,
          'failed',
          'SERVICE_MUTATION_LOST',
          '服务不存在或变更槽位已不属于此任务，已阻止重放。',
        );
        return true;
      }
      if (!(await closeBuildsBeforeTransition(tx, ref))) return false;
      const changed = await updateTask(
        tx,
        ref,
        {
          status: task.status,
          attempts: task.attempts,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        {
          status: 'queued',
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: task.nextAttemptAt > now ? task.nextAttemptAt : now,
          logsJson: json(
            this.appendLog(
              task.logsJson,
              'warn',
              '正在从持久任务记录恢复丢失或中断的队列投递。',
              task.attempts,
              'DELIVERY_RECOVERED',
            ),
          ),
        },
      );
      if (changed.count) {
        if (task.status === 'running')
          await this.finishDeploymentAttempt(tx, stored, 'failed', 'EXECUTION_LEASE_EXPIRED');
        await this.resetOutbox(tx, ref, task.nextAttemptAt > now ? task.nextAttemptAt : now);
      }
      return changed.count === 1;
    });
  }

  private async resetOutbox(
    tx: Prisma.TransactionClient,
    ref: TaskRef,
    availableAt: Date,
  ): Promise<void> {
    await assertBuildsClosed(tx, ref);
    const target = ref.type === 'operation' ? { operationId: ref.id } : { deploymentId: ref.id };
    await tx.outbox.upsert({
      where: target,
      create: { ...target, availableAt },
      update: {
        publishedAt: null,
        availableAt,
        deliverySequence: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }

  private async rejectOldGeneration(
    tx: Prisma.TransactionClient,
    stored: StoredTask,
  ): Promise<void> {
    await this.endUnclaimed(
      tx,
      stored,
      'failed',
      'RECOVERY_GENERATION_CHANGED',
      '任务属于恢复前的执行代次，已阻止自动重放。请核对后创建新任务。',
    );
  }

  private async endUnclaimed(
    tx: Prisma.TransactionClient,
    stored: StoredTask,
    status: 'failed' | 'cancelled',
    code: string | null,
    message: string,
  ): Promise<void> {
    if (
      !(await closeBuildsBeforeTransition(
        tx,
        stored.ref,
        status === 'cancelled' ? 'cancelled_before_submission' : 'rejected_before_submission',
      ))
    )
      return;
    const task = stored.data;
    const changed = await updateTask(
      tx,
      stored.ref,
      {
        status: task.status,
        attempts: task.attempts,
        leaseToken: task.leaseToken,
      },
      {
        status,
        errorCode: code,
        errorMessage: status === 'failed' ? message : null,
        finishedAt: new Date(),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        logsJson: json(
          this.appendLog(
            task.logsJson,
            status === 'failed' ? 'error' : 'info',
            message,
            task.attempts,
            code ?? undefined,
          ),
        ),
      },
    );
    if (changed.count) {
      await releaseMutationSlot(tx, stored.ref);
      await this.finishDeploymentAttempt(tx, stored, status, code);
    }
  }

  private async finishDeploymentAttempt(
    tx: Prisma.TransactionClient,
    stored: StoredTask,
    status: 'succeeded' | 'failed' | 'cancelled',
    code: string | null = null,
  ): Promise<void> {
    if (stored.type !== 'deployment') return;
    const where = {
      deploymentId: stored.ref.id,
      attempt: { lte: Math.max(1, stored.data.attempts) },
    };
    const finishedAt = new Date();
    await tx.deploymentStage.updateMany({
      where: { ...where, status: 'running' },
      data: { status, finishedAt, errorCode: code },
    });
    if (status !== 'succeeded')
      await tx.deploymentStage.updateMany({
        where: { ...where, status: 'queued' },
        data: { status: 'skipped', finishedAt, errorCode: null },
      });
  }

  private appendLog(...args: Parameters<typeof appendOperationLog>) {
    return appendOperationLog(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
      this.options.logMaxBytes,
    );
  }

  async workerStatus(): Promise<Record<string, unknown>> {
    const [
      recovery,
      workers,
      queuedOperations,
      queuedDeployments,
      unpublishedCount,
      oldestOperation,
      oldestDeployment,
    ] = await Promise.all([
      readRecoveryState(this.db),
      this.db.workerHeartbeat.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 10 }),
      this.db.operation.count({ where: { status: 'queued' } }),
      this.db.deployment.count({ where: { status: 'queued' } }),
      this.db.outbox.count({
        where: {
          publishedAt: null,
          OR: [{ operation: { status: 'queued' } }, { deployment: { status: 'queued' } }],
        },
      }),
      this.db.operation.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.db.deployment.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const oldest = [oldestOperation, oldestDeployment]
      .filter((value): value is { createdAt: Date } => value !== null)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
    const fresh = workers.filter(
      (worker) => worker.lastSeenAt.getTime() > Date.now() - this.options.heartbeatTtlMs,
    );
    const live = fresh.filter((worker) => worker.errorCode !== 'WORKER_STOPPED');
    const restoreLocked = recovery.restoreLocked || process.env.RESTORE_MODE === 'true';
    const connected = live.some((worker) => worker.queueConnected && !worker.recoveryMode);
    return {
      status: restoreLocked
        ? 'paused'
        : !live.length
          ? 'offline'
          : connected
            ? 'ready'
            : 'degraded',
      restoreLocked,
      queue: !live.length ? 'unknown' : connected ? 'connected' : 'disconnected',
      queuedCount: queuedOperations + queuedDeployments,
      unpublishedCount,
      oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
      workers: workers.map((worker) => ({
        id: worker.id,
        startedAt: worker.startedAt.toISOString(),
        lastSeenAt: worker.lastSeenAt.toISOString(),
        queueConnected: worker.queueConnected,
        recoveryMode: worker.recoveryMode,
        activeOperations: worker.activeOperations,
        errorCode: worker.errorCode,
        stale: !fresh.some((active) => active.id === worker.id),
      })),
    };
  }

  async clearExpiredLogs(): Promise<number> {
    return this.db.$transaction(async (tx) => {
      await assertWritable(tx);
      const where = {
        status: { in: terminalStatuses },
        finishedAt: { lt: new Date(Date.now() - this.options.logRetentionMs) },
        logsJson: { not: Prisma.DbNull },
      };
      const operations = await tx.operation.updateMany({
        where,
        data: { logsJson: Prisma.DbNull },
      });
      const deployments = await tx.deployment.updateMany({
        where,
        data: { logsJson: Prisma.DbNull },
      });
      // Bound retained event logs across both task types, not once per table.
      const excess = await tx.$queryRaw<
        Array<{ type: 'operation' | 'deployment'; id: string }>
      >(Prisma.sql`
        SELECT t."type", t."id" FROM (
          SELECT 'operation' AS "type", "id", "createdAt" FROM "Operation"
            WHERE "status" IN ('succeeded', 'failed', 'cancelled') AND "logsJson" IS NOT NULL
          UNION ALL
          SELECT 'deployment' AS "type", "id", "createdAt" FROM "Deployment"
            WHERE "status" IN ('succeeded', 'failed', 'cancelled') AND "logsJson" IS NOT NULL
        ) t ORDER BY t."createdAt" DESC, t."id" DESC, t."type" ASC
        OFFSET ${this.options.retainedLogOperations} LIMIT 1000
      `);
      for (const type of ['operation', 'deployment'] as const) {
        const ids = excess.filter((row) => row.type === type).map((row) => row.id);
        if (!ids.length) continue;
        if (type === 'operation')
          await tx.operation.updateMany({
            where: { id: { in: ids } },
            data: { logsJson: Prisma.DbNull },
          });
        else
          await tx.deployment.updateMany({
            where: { id: { in: ids } },
            data: { logsJson: Prisma.DbNull },
          });
      }
      await tx.workerHeartbeat.deleteMany({
        where: { lastSeenAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
      });
      return operations.count + deployments.count + excess.length;
    });
  }
}
