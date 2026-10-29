import { Injectable } from '@nestjs/common';
import { PrismaService } from '@ozz/database';
import { loadConfig } from '@ozz/config';
import {
  InfrastructureCommands,
  infrastructureFailure,
  observedConnectionStatus,
} from '@ozz/control-plane/infrastructure';
import { ControlPlaneReadOnlyError } from '@ozz/control-plane/recovery';
import {
  OperationRequestError,
  TaskExecutionError,
  TaskRepository,
} from '@ozz/control-plane/tasks';
import {
  KubernetesAdapterError,
  type KubernetesNodeSnapshot,
} from '@ozz/infrastructure/kubernetes';
import { SshAdapterError } from '@ozz/infrastructure/ssh';
import { Problem } from '../../common/problem.js';
import { SecretCipherService } from '../../common/secret-cipher.service.js';
import { PageQueryDto } from '../../common/pagination.js';
import {
  cursorWhere,
  mappedPage,
  metadataMutation,
  NEWEST_FIRST,
  requireRecord,
} from '../projects/metadata.persistence.js';
import type { NodeListDto } from './observation.dto.js';

@Injectable()
export class InfrastructureService {
  readonly commands: InfrastructureCommands;

  constructor(
    private readonly database: PrismaService,
    cipher: SecretCipherService,
  ) {
    const config = loadConfig();
    this.commands = new InfrastructureCommands(
      new TaskRepository(database, {
        logRetentionMs: config.taskLogRetentionDays * 86_400_000,
        logMaxBytes: config.taskLogMaxBytes,
      }),
      cipher,
    );
  }

  async request<T>(work: (commands: InfrastructureCommands) => Promise<T>): Promise<T> {
    try {
      return await metadataMutation(() => work(this.commands));
    } catch (error) {
      if (error instanceof OperationRequestError)
        throw new Problem(error.status, error.code, error.message);
      if (error instanceof ControlPlaneReadOnlyError)
        throw new Problem(503, error.code, error.message);
      if (error instanceof TaskExecutionError) throw new Problem(409, error.code, error.message);
      if (error instanceof KubernetesAdapterError || error instanceof SshAdapterError) {
        const failure = infrastructureFailure(error);
        throw new Problem(422, failure.code, failure.message);
      }
      throw error;
    }
  }

  async nodes(
    target: { serverId: string } | { clusterId: string },
    query: PageQueryDto,
  ): Promise<NodeListDto> {
    if ('serverId' in target)
      requireRecord(
        await this.database.server.findUnique({
          where: { id: target.serverId },
          select: { id: true },
        }),
        '服务器',
      );
    else
      requireRecord(
        await this.database.cluster.findUnique({
          where: { id: target.clusterId },
          select: { id: true },
        }),
        '集群',
      );
    const rows = await this.database.node.findMany({
      where: {
        ...target,
        AND: [
          cursorWhere(query.cursor),
          query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {},
        ],
      },
      include: {
        cluster: {
          select: {
            id: true,
            name: true,
            slug: true,
            connectionStatus: true,
            lastObservedAt: true,
          },
        },
      },
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return mappedPage(rows, query.limit, (row) => ({
      ...(row.snapshotJson as unknown as KubernetesNodeSnapshot),
      id: row.id,
      clusterId: row.clusterId,
      serverId: row.serverId,
      present: row.present,
      lastObservedAt: row.lastObservedAt.toISOString(),
      cluster: {
        ...row.cluster,
        connectionStatus: observedConnectionStatus(row.cluster),
        lastObservedAt: row.cluster.lastObservedAt?.toISOString() ?? null,
      },
    }));
  }
}
