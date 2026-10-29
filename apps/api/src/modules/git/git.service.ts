import { Injectable } from '@nestjs/common';
import { GitWebhookQueries, GitWebhookReceiver } from '@ozz/control-plane/git';
import { SecretCipherService } from '../../common/secret-cipher.service.js';
import { ServicesService } from '../services/services.service.js';
import { OperationRequestError } from '@ozz/control-plane/tasks';

@Injectable()
export class GitService {
  readonly queries: GitWebhookQueries;
  readonly receiver: GitWebhookReceiver;
  constructor(
    readonly services: ServicesService,
    cipher: SecretCipherService,
  ) {
    this.queries = new GitWebhookQueries(services.repository);
    this.receiver = new GitWebhookReceiver(services.repository, cipher);
  }
  async delivery(id: string) {
    return this.services.request(async () => {
      const row = await this.services.repository.db.webhookDelivery.findUnique({ where: { id } });
      if (!row)
        throw new OperationRequestError(404, 'WEBHOOK_DELIVERY_NOT_FOUND', 'Webhook 投递不存在。');
      const targets = await this.queries.targets({ webhookDeliveryId: id });
      return {
        data: {
          id: row.id,
          provider: 'github' as const,
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
          targets: targets.data,
          targetsPage: targets.page,
        },
      };
    });
  }
  async rejections(repositoryId?: string) {
    return this.services.request(async () => {
      const rows = await this.services.repository.db.webhookRejection.findMany({
        where: {
          ...(repositoryId ? { repositoryId } : {}),
          bucket: { gte: new Date(Date.now() - 86_400_000) },
        },
        orderBy: [{ bucket: 'desc' }, { repositoryId: 'asc' }, { reason: 'asc' }],
        take: 201,
      });
      return {
        data: rows.slice(0, 200).map((row) => ({ ...row, bucket: row.bucket.toISOString() })),
        truncated: rows.length > 200,
        retentionHours: 24,
      };
    });
  }
}
