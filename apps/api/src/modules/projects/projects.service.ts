import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { withWritableControlPlane } from '@ozz/control-plane/recovery';
import { validateIdempotencyKey, type OperationActor } from '@ozz/control-plane/tasks';
import { Prisma, PrismaService } from '@ozz/database';
import { observedConnectionStatus } from '@ozz/control-plane/infrastructure';
import { Problem } from '../../common/problem.js';
import {
  CreateProjectDto,
  ProjectEnvelopeDto,
  ProjectQueryDto,
  ProjectResponseDto,
  UpdateProjectDto,
} from './project.dto.js';
import {
  cursorWhere,
  mappedPage,
  metadataMutation,
  NEWEST_FIRST,
  requireChanges,
  requireRecord,
  requireRevision,
  revisionConflict,
} from './metadata.persistence.js';

const INCLUDE_TARGET = { cluster: true } as const;
type ProjectWithTarget = Prisma.ProjectGetPayload<{ include: typeof INCLUDE_TARGET }>;

function present(project: ProjectWithTarget): ProjectResponseDto {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    clusterId: project.clusterId,
    revision: project.revision,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    cluster: {
      id: project.cluster.id,
      name: project.cluster.name,
      slug: project.cluster.slug,
      connectionStatus: observedConnectionStatus(project.cluster),
      lastObservedAt: project.cluster.lastObservedAt?.toISOString() ?? null,
    },
  };
}

@Injectable()
export class ProjectsService {
  constructor(private readonly db: PrismaService) {}

  async list(query: ProjectQueryDto) {
    const rows = await this.db.project.findMany({
      where: {
        ...(query.clusterId ? { clusterId: query.clusterId } : {}),
        AND: [
          cursorWhere(query.cursor),
          query.search
            ? {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' } },
                  { slug: { contains: query.search, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      include: INCLUDE_TARGET,
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return mappedPage(rows, query.limit, present);
  }

  async get(id: string) {
    const project = requireRecord(
      await this.db.project.findUnique({ where: { id }, include: INCLUDE_TARGET }),
      '项目',
    );
    return { data: present(project) };
  }

  create(input: CreateProjectDto, actor?: OperationActor, key?: unknown) {
    return metadataMutation(async () => {
      const idempotencyKey = key === undefined ? null : validateIdempotencyKey(key);
      if (idempotencyKey && !actor?.id)
        throw new Problem(401, 'AUTH_REQUIRED', '需要有效的管理员会话。');
      const scope = `project-create:${actor?.id ?? ''}`;
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            clusterId: input.clusterId,
          }),
        )
        .digest('hex');
      return withWritableControlPlane(this.db, async (tx) => {
        if (idempotencyKey) {
          await tx.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${scope}), hashtext(${idempotencyKey}))`,
          );
          const receipt = await tx.commandReceipt.findUnique({
            where: { idempotencyScope_idempotencyKey: { idempotencyScope: scope, idempotencyKey } },
          });
          if (receipt) {
            if (receipt.requestHash !== requestHash)
              throw new Problem(
                409,
                'IDEMPOTENCY_CONFLICT',
                '该幂等键已经用于另一份项目创建请求。',
              );
            return receipt.resultJson as unknown as ProjectEnvelopeDto;
          }
        }
        requireRecord(
          await tx.cluster.findUnique({ where: { id: input.clusterId }, select: { id: true } }),
          '目标集群',
        );
        const project = await tx.project.create({
          data: {
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            clusterId: input.clusterId,
            environments: { create: { name: 'Production', slug: 'production' } },
          },
          include: INCLUDE_TARGET,
        });
        const result = { data: present(project) };
        if (idempotencyKey)
          await tx.commandReceipt.create({
            data: {
              idempotencyScope: scope,
              idempotencyKey,
              requestHash,
              resultJson: result as unknown as Prisma.InputJsonValue,
            },
          });
        return result;
      });
    });
  }

  update(id: string, input: UpdateProjectDto) {
    requireChanges(input, ['name', 'description']);
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        const current = requireRecord(await tx.project.findUnique({ where: { id } }), '项目');
        requireRevision(current, input.revision);
        const changed = await tx.project.updateMany({
          where: { id, revision: input.revision },
          data: { name: input.name, description: input.description, revision: { increment: 1 } },
        });
        if (changed.count !== 1) revisionConflict();
        const project = requireRecord(
          await tx.project.findUnique({ where: { id }, include: INCLUDE_TARGET }),
          '项目',
        );
        return { data: present(project) };
      }),
    );
  }

  delete(id: string, revision: number) {
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        // Serialize environment creation with removal of an empty project.
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Project" WHERE "id" = ${id}::uuid FOR UPDATE`,
        );
        const current = requireRecord(await tx.project.findUnique({ where: { id } }), '项目');
        requireRevision(current, revision);
        if (
          await tx.volume.count({ where: { destroyedAt: null, environment: { projectId: id } } })
        ) {
          throw new Problem(
            409,
            'RESOURCE_IN_USE',
            '项目仍有保留的数据卷；请先核对备份并独立处理数据，不能通过删除项目清除数据记录。',
          );
        }
        await tx.environment.deleteMany({ where: { projectId: id } });
        const deleted = await tx.project.deleteMany({ where: { id, revision } });
        if (deleted.count !== 1) revisionConflict();
      }),
    );
  }
}
