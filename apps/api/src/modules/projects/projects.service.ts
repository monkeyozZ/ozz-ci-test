import { Injectable } from '@nestjs/common';
import { withWritableControlPlane } from '@ozz/control-plane/recovery';
import { Prisma, PrismaService } from '@ozz/database';
import { observedConnectionStatus } from '@ozz/control-plane/infrastructure';
import { Problem } from '../../common/problem.js';
import {
  CreateProjectDto,
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

  create(input: CreateProjectDto) {
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
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
        return { data: present(project) };
      }),
    );
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
