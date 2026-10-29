import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type WebhookDelivery, type WebhookTarget } from '@ozz/database';
import { gitBranchRef } from '@ozz/infrastructure/github';
import { workloadNames } from '@ozz/infrastructure/workload';
import { withWritableControlPlane } from '../recovery.js';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError, pageLimit } from '../tasks/contracts.js';
import { TaskRepository } from '../tasks/repository.js';
import { ServiceCommands } from '../services/commands.js';
import {
  assertServiceTarget,
  json,
  lockService,
  requireIdle,
  type ServiceRecord,
} from '../services/persistence.js';
import type { ServiceTarget } from '../services/contracts.js';
import { resourceId } from '../services/validation.js';
import { parseWebhookSecret } from '../integrations/persistence.js';
import { captureGitSnapshot } from './commands.js';
import { readGitSourceRevision, requireGitSource } from './persistence.js';
import type { WebhookDeliveryView, WebhookTargetView } from './contracts.js';

export const GITHUB_WEBHOOK_MAX_BYTES = 512 * 1024;
export interface GitHubWebhookRequest {
  repositoryId: string;
  callbackId: string;
  deliveryId: unknown;
  event: unknown;
  signature: unknown;
  contentEncoding?: unknown;
  body: Buffer;
}
function signatureMatches(body: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(
    createHmac('sha256', secret).update(body).digest(),
    Buffer.from(signature.slice(7), 'hex'),
  );
}
function safeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OperationRequestError(422, 'WEBHOOK_PAYLOAD_INVALID', 'Webhook JSON 结构无效。');
  return value as Record<string, unknown>;
}
async function receiptTarget(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
): Promise<ServiceTarget> {
  const state = await tx.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  const cluster = service.environment.project.cluster;
  if (!cluster.kubeSystemUid)
    throw new OperationRequestError(
      409,
      'SERVICE_TARGET_UNAVAILABLE',
      '收件时无法固定原集群身份。',
    );
  const names = workloadNames({ serviceId: service.id, environmentId: service.environmentId });
  return {
    installationId: state.installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid,
    projectId: service.environment.projectId,
    environmentId: service.environmentId,
    serviceId: service.id,
    namespace: names.namespace,
    serviceName: names.service,
  };
}

/** The only JSON.parse below is strictly after HMAC over the original Buffer. */
export class GitWebhookReceiver {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
  ) {}
  private async rejection(repositoryId: string, reason: string) {
    await withWritableControlPlane(this.repository.db, async (tx) => {
      const bucket = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      await tx.webhookRejection.upsert({
        where: { repositoryId_bucket_reason: { repositoryId, bucket, reason } },
        create: { repositoryId, bucket, reason },
        update: { count: { increment: 1 } },
      });
      await tx.webhookRejection.deleteMany({
        where: { repositoryId, bucket: { lt: new Date(Date.now() - 86_400_000) } },
      });
    });
  }
  async receive(
    input: GitHubWebhookRequest,
  ): Promise<{ deliveryId: string; duplicate: boolean; targetCount: number }> {
    resourceId(input.repositoryId);
    resourceId(input.callbackId);
    if (!Buffer.isBuffer(input.body))
      throw new OperationRequestError(
        415,
        'WEBHOOK_BODY_REQUIRED',
        'Webhook 需要原始 JSON 请求体。',
      );
    if (input.body.length > GITHUB_WEBHOOK_MAX_BYTES)
      throw new OperationRequestError(
        413,
        'WEBHOOK_BODY_TOO_LARGE',
        'Webhook 请求体超过 512 KiB。',
      );
    if (input.contentEncoding !== undefined && input.contentEncoding !== 'identity')
      throw new OperationRequestError(
        415,
        'WEBHOOK_ENCODING_UNSUPPORTED',
        'Webhook 不接受压缩的请求体。',
      );
    try {
      return await withWritableControlPlane(this.repository.db, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "GitRepository" WHERE "id"=${input.repositoryId}::uuid FOR SHARE`;
        const repo = await tx.gitRepository.findUnique({ where: { id: input.repositoryId } });
        if (
          !repo ||
          repo.hookCallbackId !== input.callbackId ||
          (!repo.hookSecretRefId && !repo.candidateHookSecretRefId)
        )
          throw new OperationRequestError(
            404,
            'WEBHOOK_ENDPOINT_NOT_FOUND',
            'Webhook 接收端不存在。',
          );
        const ids = [
          ...(repo.hookSecretRefId ? [repo.hookSecretRefId] : []),
          ...(repo.previousHookSecretRefId &&
          repo.previousHookSecretUntil &&
          repo.previousHookSecretUntil > new Date()
            ? [repo.previousHookSecretRefId]
            : []),
          ...(repo.candidateHookSecretRefId &&
          repo.candidateHookSecretUntil &&
          repo.candidateHookSecretUntil > new Date()
            ? [repo.candidateHookSecretRefId]
            : []),
        ];
        const secrets = await tx.secretReference.findMany({
          where: {
            id: { in: ids },
            kind: 'webhook',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        });
        if (
          !secrets.some((secret) =>
            signatureMatches(
              input.body,
              input.signature,
              parseWebhookSecret(this.cipher.decrypt(secret)),
            ),
          )
        )
          throw new OperationRequestError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook 签名无效。');
        if (
          typeof input.deliveryId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(input.deliveryId) ||
          typeof input.event !== 'string' ||
          !/^[a-z_]{1,64}$/.test(input.event)
        )
          throw new OperationRequestError(
            422,
            'WEBHOOK_HEADERS_INVALID',
            'Webhook 投递标识或事件类型无效。',
          );
        let payload: Record<string, unknown>;
        try {
          payload = safeObject(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.body)),
          );
        } catch {
          throw new OperationRequestError(
            422,
            'WEBHOOK_PAYLOAD_INVALID',
            '已验签 Webhook 的 JSON 无效。',
          );
        }
        const externalRepository = safeObject(payload.repository);
        const numericId =
          typeof externalRepository.id === 'number' &&
          Number.isSafeInteger(externalRepository.id) &&
          externalRepository.id > 0
            ? String(externalRepository.id)
            : null;
        if (numericId !== repo.githubRepositoryId)
          throw new OperationRequestError(
            403,
            'WEBHOOK_REPOSITORY_MISMATCH',
            'Webhook 的仓库身份与此接收端不一致。',
          );
        let ref: string | null = null,
          afterSha: string | null = null,
          deleted = false;
        if (input.event === 'push') {
          if (
            typeof payload.ref !== 'string' ||
            payload.ref.length > 270 ||
            !/^refs\/(?:heads|tags)\//.test(payload.ref) ||
            typeof payload.after !== 'string' ||
            !/^[0-9a-f]{40}$/.test(payload.after) ||
            typeof payload.deleted !== 'boolean'
          )
            throw new OperationRequestError(
              422,
              'WEBHOOK_PAYLOAD_INVALID',
              'Push 事件缺少有效 ref、完整 SHA 或删除标记。',
            );
          ref = payload.ref;
          afterSha = payload.after;
          deleted = payload.deleted;
          if (ref.startsWith('refs/heads/')) gitBranchRef(ref);
          if ((afterSha === '0'.repeat(40)) !== deleted)
            throw new OperationRequestError(
              422,
              'WEBHOOK_PAYLOAD_INVALID',
              'Push 删除标记与提交身份不匹配。',
            );
        }
        const payloadHash = createHash('sha256').update(input.body).digest('hex');
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('github-delivery'),hashtext(${input.deliveryId}))`,
        );
        const existing = await tx.webhookDelivery.findUnique({
          where: {
            provider_externalDeliveryId: {
              provider: 'github',
              externalDeliveryId: input.deliveryId,
            },
          },
        });
        if (existing) {
          if (
            existing.payloadHash !== payloadHash ||
            existing.repositoryId !== repo.id ||
            existing.event !== input.event
          )
            throw new OperationRequestError(
              409,
              'WEBHOOK_DELIVERY_CONFLICT',
              '同一投递标识已经对应另一份有效内容。',
            );
          await tx.webhookDelivery.update({
            where: { id: existing.id },
            data: {
              duplicateCount: Math.min(existing.duplicateCount + 1, 2147483647),
              lastReceivedAt: new Date(),
            },
          });
          return {
            deliveryId: existing.id,
            duplicate: true,
            targetCount: await tx.webhookTarget.count({
              where: { webhookDeliveryId: existing.id },
            }),
          };
        }
        const delivery = await tx.webhookDelivery.create({
          data: {
            provider: 'github',
            externalDeliveryId: input.deliveryId,
            repositoryId: repo.id,
            githubRepositoryId: numericId,
            payloadHash,
            event: input.event,
            ref,
            afterSha,
            deleted,
            state: input.event === 'push' ? 'received' : 'ignored',
            reason: input.event === 'push' ? null : 'unsupported_event',
          },
        });
        let targetCount = 0;
        // Stable service order agrees with command/slot locks. Each target is a durable row.
        const sources = await tx.gitSource.findMany({
          where: { serviceId: { not: null }, currentRevision: { repositoryId: repo.id } },
          orderBy: { serviceId: 'asc' },
          select: { serviceId: true },
        });
        for (const sourceRow of sources) {
          const exists = await tx.service.findUnique({
            where: { id: sourceRow.serviceId! },
            select: { id: true },
          });
          if (!exists) continue;
          const service = await lockService(tx, exists.id);
          if (
            service.sourceKind !== 'github' ||
            !service.gitSource?.currentRevision ||
            service.gitSource.currentRevision.repositoryId !== repo.id
          )
            continue;
          const { source, revision } = requireGitSource(service);
          let state = 'waiting',
            reason = service.activeMutation ? 'service_busy' : 'ready',
            manualRequired = false;
          if (input.event !== 'push') {
            state = 'ignored';
            reason = 'unsupported_event';
          } else if (deleted) {
            state = 'ignored';
            reason = 'branch_deleted';
          } else if (ref !== revision.branchRef) {
            state = 'ignored';
            reason = 'branch_mismatch';
          } else if (!source.autoDeploy) {
            state = 'ignored';
            reason = 'auto_deploy_disabled';
          } else if (service.desiredState === 'stopped') {
            state = 'pending';
            reason = 'service_stopped';
            manualRequired = true;
          } else if (['partial', 'drifted', 'unknown'].includes(service.configurationState)) {
            state = 'pending';
            reason = 'publication_confirmation_required';
            manualRequired = true;
          }
          await tx.webhookTarget.create({
            data: {
              webhookDeliveryId: delivery.id,
              serviceId: service.id,
              currentServiceId: service.id,
              sourceRevisionId: revision.id,
              commitSha: afterSha ?? '0'.repeat(40),
              configRevisionAtReceipt: service.configRevision,
              policyRevisionAtReceipt: source.policyRevision,
              targetJson: json(await receiptTarget(tx, service)),
              state,
              reason,
              manualRequired,
            },
          });
          targetCount++;
        }
        await tx.auditEvent.create({
          data: {
            action: 'github.webhook_received',
            resourceType: 'webhook_delivery',
            resourceId: delivery.id,
            outcome: 'accepted',
            metadata: { repositoryId: repo.id, event: input.event, targetCount },
          },
        });
        return { deliveryId: delivery.id, duplicate: false, targetCount };
      });
    } catch (error) {
      if (
        error instanceof OperationRequestError &&
        [
          'WEBHOOK_SIGNATURE_INVALID',
          'WEBHOOK_HEADERS_INVALID',
          'WEBHOOK_PAYLOAD_INVALID',
          'WEBHOOK_REPOSITORY_MISMATCH',
          'WEBHOOK_DELIVERY_CONFLICT',
        ].includes(error.code)
      )
        await this.rejection(input.repositoryId, error.code);
      throw error;
    }
  }
}

export function webhookTargetView(row: WebhookTarget): WebhookTargetView {
  const canPreview =
    row.currentServiceId !== null &&
    !row.deploymentId &&
    ['waiting', 'pending'].includes(row.state) &&
    row.commitSha !== '0'.repeat(40);
  return {
    id: row.id,
    webhookDeliveryId: row.webhookDeliveryId,
    serviceId: row.serviceId,
    currentServiceId: row.currentServiceId,
    sourceRevisionId: row.sourceRevisionId,
    commitSha: row.commitSha,
    configRevisionAtReceipt: row.configRevisionAtReceipt,
    policyRevisionAtReceipt: row.policyRevisionAtReceipt,
    target: row.targetJson as unknown as ServiceTarget,
    receiptSequence: row.receiptSequence.toString(),
    manualRequired: row.manualRequired,
    state: row.state as WebhookTargetView['state'],
    reason: row.reason,
    deploymentId: row.deploymentId,
    admittedAt: row.admittedAt?.toISOString() ?? null,
    canPreview,
    blockedReason: canPreview ? null : row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}
export function webhookDeliveryView(row: WebhookDelivery): WebhookDeliveryView {
  return {
    id: row.id,
    provider: 'github',
    externalDeliveryId: row.externalDeliveryId,
    repositoryId: row.repositoryId,
    githubRepositoryId: row.githubRepositoryId,
    event: row.event,
    ref: row.ref,
    afterSha: row.afterSha,
    state: row.state,
    reason: row.reason,
    duplicateCount: row.duplicateCount,
    createdAt: row.createdAt.toISOString(),
    lastReceivedAt: row.lastReceivedAt.toISOString(),
  };
}
export class GitWebhookQueries {
  constructor(readonly repository: TaskRepository) {}
  async targets(
    query: { serviceId?: string; webhookDeliveryId?: string; cursor?: string; limit?: number } = {},
  ) {
    const limit = pageLimit(query.limit);
    if (
      query.cursor &&
      (!/^[1-9][0-9]{0,18}$/.test(query.cursor) || BigInt(query.cursor) > 9223372036854775807n)
    )
      throw new OperationRequestError(422, 'INVALID_CURSOR', '投递分页游标无效。');
    const rows = await this.repository.db.webhookTarget.findMany({
      where: {
        ...(query.serviceId ? { serviceId: resourceId(query.serviceId) } : {}),
        ...(query.webhookDeliveryId
          ? { webhookDeliveryId: resourceId(query.webhookDeliveryId) }
          : {}),
        ...(query.cursor ? { receiptSequence: { lt: BigInt(query.cursor) } } : {}),
      },
      orderBy: { receiptSequence: 'desc' },
      take: limit + 1,
    });
    const data = rows.slice(0, limit);
    return {
      data: data.map(webhookTargetView),
      page: {
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit ? data.at(-1)!.receiptSequence.toString() : null,
      },
    };
  }
  async deliveries(query: { repositoryId?: string; cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(query.limit);
    let cursor: Prisma.WebhookDeliveryWhereInput = {};
    if (query.cursor) {
      try {
        if (query.cursor.length > 256) throw new Error();
        const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
          id: string;
          createdAt: string;
        };
        const id = resourceId(value.id),
          date = new Date(value.createdAt);
        if (!Number.isFinite(date.getTime())) throw new Error();
        cursor = { OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: id } }] };
      } catch {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '投递分页游标无效。');
      }
    }
    const rows = await this.repository.db.webhookDelivery.findMany({
      where: {
        AND: [cursor, query.repositoryId ? { repositoryId: resourceId(query.repositoryId) } : {}],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const data = rows.slice(0, limit),
      last = data.at(-1);
    return {
      data: data.map(webhookDeliveryView),
      page: {
        hasMore: rows.length > limit,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() }),
              ).toString('base64url')
            : null,
      },
    };
  }
}

/** Persistent FIFO targets precede Task admission; no Target owns an Outbox. */
export class GitWebhookDispatcher {
  private readonly services: ServiceCommands;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(
    readonly repository: TaskRepository,
    cipher: SecretCipher,
    services?: ServiceCommands,
  ) {
    this.services = services ?? new ServiceCommands(repository, cipher);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.tick()
          .catch(() => undefined)
          .finally(() => {
            this.running = null;
          });
    }, 2000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
  private async inspect(
    tx: Prisma.TransactionClient,
    id: string,
    queueFull = false,
  ): Promise<{ target: WebhookTarget; service: ServiceRecord } | null> {
    const initial = await tx.webhookTarget.findUnique({ where: { id } });
    if (!initial || initial.state !== 'waiting') return null;
    if (!initial.currentServiceId) {
      await tx.webhookTarget.update({
        where: { id },
        data: { state: 'orphaned', reason: 'service_deleted', manualRequired: true },
      });
      return null;
    }
    const service = await lockService(tx, initial.currentServiceId);
    await tx.$queryRaw`SELECT "id" FROM "WebhookTarget" WHERE "id"=${id}::uuid FOR UPDATE`;
    const target = await tx.webhookTarget.findUniqueOrThrow({ where: { id } });
    if (target.state !== 'waiting') return null;
    const source = service.gitSource;
    let state = 'waiting',
      reason = 'ready',
      manualRequired = target.manualRequired;
    if (target.currentServiceId !== service.id) {
      state = 'orphaned';
      reason = 'service_deleted';
      manualRequired = true;
    } else if (service.desiredState === 'stopped' || target.manualRequired) {
      state = 'pending';
      reason = 'service_stopped';
      manualRequired = true;
    } else if (source?.currentRevisionId !== target.sourceRevisionId) {
      state = 'pending';
      reason = 'source_changed';
      manualRequired = true;
    } else if (service.configRevision !== target.configRevisionAtReceipt) {
      state = 'pending';
      reason = 'configuration_changed';
      manualRequired = true;
    } else if (!source.autoDeploy || source.policyRevision !== target.policyRevisionAtReceipt) {
      state = 'pending';
      reason = 'policy_changed';
      manualRequired = true;
    } else if (['partial', 'drifted', 'unknown'].includes(service.configurationState)) {
      state = 'pending';
      reason = 'publication_confirmation_required';
      manualRequired = true;
    } else {
      try {
        await assertServiceTarget(tx, service, target.targetJson as unknown as ServiceTarget);
      } catch (error) {
        if (error instanceof OperationRequestError && error.code === 'CLUSTER_OPERATION_ACTIVE')
          reason = 'service_busy';
        else {
          state = 'orphaned';
          reason = 'target_changed';
          manualRequired = true;
        }
      }
      if (
        reason === 'ready' &&
        (service.activeMutation ||
          (await tx.webhookTarget.count({
            where: {
              currentServiceId: service.id,
              state: 'waiting',
              receiptSequence: { lt: target.receiptSequence },
            },
          })))
      )
        reason = 'service_busy';
      if (reason === 'ready' && queueFull) reason = 'queue_capacity';
    }
    if (state !== 'waiting' || reason !== 'ready') {
      await tx.webhookTarget.update({
        where: { id },
        data: { state, reason, manualRequired, nextAttemptAt: new Date(Date.now() + 2000) },
      });
      return null;
    }
    return { target, service };
  }
  async dispatch(id: string): Promise<boolean> {
    resourceId(id);
    const ready = await withWritableControlPlane(this.repository.db, (tx) => this.inspect(tx, id));
    if (!ready) return false;
    try {
      await this.repository.enqueueDeployment(
        { kind: 'webhook', webhookDeliveryId: ready.target.webhookDeliveryId, webhookTargetId: id },
        id,
        { kind: 'git_deploy', request: { webhookTargetId: id } },
        async (tx) => {
          const checked = await this.inspect(tx, id);
          // A changed disposition is committed by the following reconciliation, since
          // throwing here correctly rolls the entire admission transaction back.
          if (!checked)
            throw new OperationRequestError(409, 'WEBHOOK_TARGET_NOT_READY', '投递需重新核对。');
          const { service, target } = checked;
          requireIdle(service);
          const revision = readGitSourceRevision(service.gitSource!.currentRevision!.snapshotJson);
          const snapshot = await captureGitSnapshot(tx, service, revision, target.commitSha);
          const prepared = await this.services.prepareDeployment(
            tx,
            service,
            target.targetJson as unknown as ServiceTarget,
            snapshot,
          );
          const onAccepted = prepared.onAccepted;
          prepared.onAccepted = async (db, ref) => {
            await onAccepted?.(db, ref);
            await db.webhookTarget.update({
              where: { id },
              data: {
                state: 'enqueued',
                reason: 'automatic_publication',
                deploymentId: ref.id,
                admittedAt: new Date(),
              },
            });
          };
          return prepared;
        },
      );
      return true;
    } catch (error) {
      if (error instanceof OperationRequestError) {
        await withWritableControlPlane(this.repository.db, (tx) =>
          this.inspect(tx, id, error.code === 'OPERATION_QUEUE_FULL'),
        );
        return false;
      }
      throw error;
    }
  }
  async tick(): Promise<void> {
    const rows = await this.repository.db.webhookTarget.findMany({
      where: { state: 'waiting', nextAttemptAt: { lte: new Date() } },
      orderBy: { receiptSequence: 'asc' },
      take: 25,
      select: { id: true },
    });
    for (const row of rows) await this.dispatch(row.id);
  }
}
