import { Injectable } from '@nestjs/common';
import { withWritableControlPlane } from '@ozz/control-plane/recovery';
import { Prisma, PrismaService } from '@ozz/database';
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
} from '../projects/metadata.persistence.js';
import {
  CreateEnvironmentDto,
  EnvironmentQueryDto,
  EnvironmentResponseDto,
  UpdateEnvironmentDto,
} from './environment.dto.js';

const INCLUDE_PROJECT = { project: { select: { clusterId: true } } } as const;
type EnvironmentWithProject = Prisma.EnvironmentGetPayload<{ include: typeof INCLUDE_PROJECT }>;

function present(environment: EnvironmentWithProject): EnvironmentResponseDto {
  return {
    id: environment.id,
    name: environment.name,
    slug: environment.slug,
    description: environment.description,
    projectId: environment.projectId,
    clusterId: environment.project.clusterId,
    isDefault: environment.slug === 'production',
    revision: environment.revision,
    createdAt: environment.createdAt.toISOString(),
    updatedAt: environment.updatedAt.toISOString(),
  };
}

@Injectable()
export class EnvironmentsService {
  constructor(private readonly db: PrismaService) {}

  async list(query: EnvironmentQueryDto) {
    const rows = await this.db.environment.findMany({
      where: {
        ...(query.projectId ? { projectId: query.projectId } : {}),
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
      include: INCLUDE_PROJECT,
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return mappedPage(rows, query.limit, present);
  }

  async get(id: string) {
    const environment = requireRecord(
      await this.db.environment.findUnique({ where: { id }, include: INCLUDE_PROJECT }),
      '环境',
    );
    return { data: present(environment) };
  }

  create(input: CreateEnvironmentDto) {
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        requireRecord(
          await tx.project.findUnique({ where: { id: input.projectId }, select: { id: true } }),
          '项目',
        );
        const environment = await tx.environment.create({
          data: {
            name: input.name,
            slug: input.slug,
            projectId: input.projectId,
            description: input.description ?? null,
          },
          include: INCLUDE_PROJECT,
        });
        return { data: present(environment) };
      }),
    );
  }

  update(id: string, input: UpdateEnvironmentDto) {
    requireChanges(input, ['name', 'description']);
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        const current = requireRecord(await tx.environment.findUnique({ where: { id } }), '环境');
        requireRevision(current, input.revision);
        const changed = await tx.environment.updateMany({
          where: { id, revision: input.revision },
          data: { name: input.name, description: input.description, revision: { increment: 1 } },
        });
        if (changed.count !== 1) revisionConflict();
        const environment = requireRecord(
          await tx.environment.findUnique({ where: { id }, include: INCLUDE_PROJECT }),
          '环境',
        );
        return { data: present(environment) };
      }),
    );
  }

  delete(id: string, revision: number) {
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        const current = requireRecord(await tx.environment.findUnique({ where: { id } }), '环境');
        requireRevision(current, revision);
        if (current.slug === 'production') {
          throw new Problem(
            409,
            'DEFAULT_ENVIRONMENT_REQUIRED',
            '默认 production 环境不能单独删除；空项目删除时会一并移除。',
          );
        }
        if (await tx.volume.count({ where: { environmentId: id, destroyedAt: null } })) {
          throw new Problem(
            409,
            'RESOURCE_IN_USE',
            '环境仍有保留的数据卷；请先核对备份并独立处理数据，不能通过删除环境清除数据记录。',
          );
        }
        const deleted = await tx.environment.deleteMany({ where: { id, revision } });
        if (deleted.count !== 1) revisionConflict();
      }),
    );
  }
}
