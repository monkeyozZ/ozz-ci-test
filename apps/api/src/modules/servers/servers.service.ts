import { Injectable } from '@nestjs/common';
import { withWritableControlPlane } from '@ozz/control-plane/recovery';
import { Prisma, PrismaService } from '@ozz/database';
import { assertResourceIdle, lockServer, preflightOf } from '@ozz/control-plane/infrastructure';
import { K3S_VERSION } from '@ozz/infrastructure/ssh';
import { PageQueryDto } from '../../common/pagination.js';
import { Problem } from '../../common/problem.js';
import {
  cursorWhere,
  mappedPage,
  metadataMutation,
  NEWEST_FIRST,
  requireChanges,
  requireRecord,
  requireRevision,
  revisionConflict,
  validateHost,
} from '../projects/metadata.persistence.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { CreateServerDto, ServerResponseDto, UpdateServerDto } from './server.dto.js';

const INCLUDE_TASK = {
  operations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
} satisfies Prisma.ServerInclude;
type ServerWithTask = Prisma.ServerGetPayload<{ include: typeof INCLUDE_TASK }>;

function present(server: ServerWithTask): ServerResponseDto {
  return {
    initializationVersion: K3S_VERSION,
    hostKey: {
      trustedFingerprint: server.hostKeyFingerprint,
      trustedAt: server.hostKeyTrustedAt?.toISOString() ?? null,
      trustSource: server.hostKeyTrustSource,
      observedFingerprint: server.observedHostKeyFingerprint,
      observedAlgorithm: server.observedHostKeyAlgorithm,
      observedAt: server.observedHostKeyAt?.toISOString() ?? null,
      discoveryOperationId: server.hostKeyDiscoveryOperationId,
    },
    machineId: server.machineId,
    preflight: preflightOf(server),
    preflightAt: server.preflightAt?.toISOString() ?? null,
    lastAttemptAt: server.lastAttemptAt?.toISOString() ?? null,
    lastErrorCode: server.lastErrorCode,
    lastErrorMessage: server.lastErrorMessage,
    lastOperationId: server.operations[0]?.id ?? null,
    id: server.id,
    name: server.name,
    host: server.host,
    sshPort: server.sshPort,
    sshUser: server.sshUser,
    region: server.region,
    tags: server.tags,
    credentialRefId: server.credentialRefId,
    connectionStatus: server.connectionStatus,
    lastObservedAt: server.lastObservedAt?.toISOString() ?? null,
    revision: server.revision,
    createdAt: server.createdAt.toISOString(),
    updatedAt: server.updatedAt.toISOString(),
  };
}

@Injectable()
export class ServersService {
  constructor(
    private readonly db: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  async list(query: PageQueryDto) {
    const rows = await this.db.server.findMany({
      where: {
        AND: [
          cursorWhere(query.cursor),
          query.search
            ? {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' } },
                  { host: { contains: query.search, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      orderBy: NEWEST_FIRST,
      include: INCLUDE_TASK,
      take: query.limit + 1,
    });
    return mappedPage(rows, query.limit, present);
  }

  async get(id: string) {
    return {
      data: present(
        requireRecord(
          await this.db.server.findUnique({ where: { id }, include: INCLUDE_TASK }),
          '服务器',
        ),
      ),
    };
  }

  create(input: CreateServerDto) {
    validateHost(input.host);
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        await this.secrets.assertUsableReference(tx, input.credentialRefId, 'ssh');
        const server = await tx.server.create({
          data: {
            name: input.name,
            host: input.host,
            sshPort: input.sshPort ?? 22,
            sshUser: input.sshUser,
            region: input.region ?? null,
            tags: input.tags ?? [],
            credentialRefId: input.credentialRefId ?? null,
          },
          include: INCLUDE_TASK,
        });
        return { data: present(server) };
      }),
    );
  }

  update(id: string, input: UpdateServerDto) {
    requireChanges(input, [
      'name',
      'host',
      'sshPort',
      'sshUser',
      'region',
      'tags',
      'credentialRefId',
    ]);
    if (input.host !== undefined) validateHost(input.host);
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        const current = await lockServer(tx, id);
        requireRevision(current, input.revision);
        await this.secrets.assertUsableReference(tx, input.credentialRefId, 'ssh');
        const connectionChanged = (['host', 'sshPort', 'sshUser', 'credentialRefId'] as const).some(
          (key) => input[key] !== undefined && input[key] !== current[key],
        );
        const targetChanged = (['host', 'sshPort', 'sshUser'] as const).some(
          (key) => input[key] !== undefined && input[key] !== current[key],
        );
        if (targetChanged) await assertResourceIdle(tx, { serverId: id });
        const changed = await tx.server.updateMany({
          where: { id, revision: input.revision },
          data: {
            name: input.name,
            host: input.host,
            sshPort: input.sshPort,
            sshUser: input.sshUser,
            region: input.region,
            tags: input.tags,
            credentialRefId: input.credentialRefId,
            ...(connectionChanged ? { connectionStatus: 'unverified' } : {}),
            ...(targetChanged
              ? {
                  connectionRevision: { increment: 1 },
                  hostKeyFingerprint: null,
                  hostKeyAlgorithm: null,
                  hostKeyTrustedAt: null,
                  hostKeyTrustSource: null,
                  observedHostKeyFingerprint: null,
                  observedHostKeyAlgorithm: null,
                  observedHostKeyAt: null,
                  hostKeyDiscoveryOperationId: null,
                  preflightJson: Prisma.DbNull,
                  preflightAt: null,
                }
              : {}),
            revision: { increment: 1 },
          },
        });
        if (changed.count !== 1) revisionConflict();
        return {
          data: present(
            requireRecord(
              await tx.server.findUnique({ where: { id }, include: INCLUDE_TASK }),
              '服务器',
            ),
          ),
        };
      }),
    );
  }

  delete(id: string, revision: number) {
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        const current = await lockServer(tx, id);
        requireRevision(current, revision);
        await assertResourceIdle(tx, { serverId: id });
        if (
          (await tx.node.count({ where: { serverId: id, present: true } })) ||
          (await tx.cluster.count({ where: { bootstrapServerId: id } }))
        )
          throw new Problem(
            409,
            'RESOURCE_IN_USE',
            '服务器仍关联集群节点或初始化登记，请先处理关联资源。移除登记不会卸载远端软件。',
          );
        const deleted = await tx.server.deleteMany({ where: { id, revision } });
        if (deleted.count !== 1) revisionConflict();
      }),
    );
  }
}
