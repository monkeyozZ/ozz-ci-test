import { Injectable } from '@nestjs/common';
import { requestAuditContext } from '@ozz/control-plane/audit';
import { withWritableControlPlane } from '@ozz/control-plane/recovery';
import { Prisma, PrismaService } from '@ozz/database';
import {
  assertResourceIdle,
  lockCluster,
  observationOf,
  observationStale,
  observedConnectionStatus,
} from '@ozz/control-plane/infrastructure';
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
  validateApiEndpoint,
} from '../projects/metadata.persistence.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { ClusterResponseDto, CreateClusterDto, UpdateClusterDto } from './cluster.dto.js';

const INCLUDE_USAGE = {
  _count: { select: { projects: true, nodes: { where: { present: true } } } },
  operations: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
} satisfies Prisma.ClusterInclude;
type ClusterWithUsage = Prisma.ClusterGetPayload<{ include: typeof INCLUDE_USAGE }>;

function present(cluster: ClusterWithUsage): ClusterResponseDto {
  return {
    identity:
      cluster.kubeSystemUid && cluster.caFingerprint
        ? { kubeSystemUid: cluster.kubeSystemUid, caFingerprint: cluster.caFingerprint }
        : null,
    observation: observationOf(cluster),
    observationStale: observationStale(cluster),
    nodeCount: cluster._count.nodes,
    lastAttemptAt: cluster.lastAttemptAt?.toISOString() ?? null,
    lastErrorCode: cluster.lastErrorCode,
    lastErrorMessage: cluster.lastErrorMessage,
    lastOperationId: cluster.operations[0]?.id ?? null,
    id: cluster.id,
    name: cluster.name,
    slug: cluster.slug,
    description: cluster.description,
    region: cluster.region,
    apiEndpoint: cluster.apiEndpoint,
    credentialRefId: cluster.credentialRefId,
    connectionStatus: observedConnectionStatus(cluster),
    lastObservedAt: cluster.lastObservedAt?.toISOString() ?? null,
    projectCount: cluster._count.projects,
    revision: cluster.revision,
    createdAt: cluster.createdAt.toISOString(),
    updatedAt: cluster.updatedAt.toISOString(),
  };
}

@Injectable()
export class ClustersService {
  constructor(
    private readonly db: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  async list(query: PageQueryDto) {
    const rows = await this.db.cluster.findMany({
      where: {
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
      include: INCLUDE_USAGE,
      orderBy: NEWEST_FIRST,
      take: query.limit + 1,
    });
    return mappedPage(rows, query.limit, present);
  }

  async get(id: string) {
    return {
      data: present(
        requireRecord(
          await this.db.cluster.findUnique({ where: { id }, include: INCLUDE_USAGE }),
          '集群',
        ),
      ),
    };
  }

  create(input: CreateClusterDto) {
    validateApiEndpoint(input.apiEndpoint);
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        await this.secrets.assertUsableReference(tx, input.credentialRefId, 'kubeconfig');
        const cluster = await tx.cluster.create({
          data: {
            name: input.name,
            slug: input.slug,
            description: input.description ?? null,
            region: input.region ?? null,
            apiEndpoint: input.apiEndpoint ?? null,
            credentialRefId: input.credentialRefId ?? null,
          },
          include: INCLUDE_USAGE,
        });
        return { data: present(cluster) };
      }),
    );
  }

  update(id: string, input: UpdateClusterDto) {
    requireChanges(input, ['name', 'description', 'region', 'apiEndpoint', 'credentialRefId']);
    validateApiEndpoint(input.apiEndpoint);
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        // A project FK takes a key-share lock, so this lock closes the bind/edit race.
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "Cluster" WHERE "id" = ${id}::uuid FOR UPDATE`,
        );
        const current = requireRecord(
          await tx.cluster.findUnique({ where: { id }, include: INCLUDE_USAGE }),
          '集群',
        );
        requireRevision(current, input.revision);
        const connectionChanged = (['apiEndpoint', 'credentialRefId'] as const).some(
          (key) => input[key] !== undefined && input[key] !== current[key],
        );
        if (connectionChanged) await assertResourceIdle(tx, { clusterId: id });
        if (
          connectionChanged &&
          (current._count.projects > 0 ||
            current.connectionStatus !== 'unverified' ||
            current.bootstrapServerId !== null ||
            current.kubeSystemUid !== null)
        ) {
          throw new Problem(
            409,
            'CLUSTER_IDENTITY_VERIFICATION_REQUIRED',
            '该集群已有项目引用或连接观察记录。更换连接信息前必须验证仍为同一集群，当前不能直接修改。',
          );
        }
        await this.secrets.assertUsableReference(tx, input.credentialRefId, 'kubeconfig');
        const changed = await tx.cluster.updateMany({
          where: { id, revision: input.revision },
          data: {
            name: input.name,
            description: input.description,
            region: input.region,
            apiEndpoint: input.apiEndpoint,
            credentialRefId: input.credentialRefId,
            ...(connectionChanged ? { connectionRevision: { increment: 1 } } : {}),
            revision: { increment: 1 },
          },
        });
        if (changed.count !== 1) revisionConflict();
        return {
          data: present(
            requireRecord(
              await tx.cluster.findUnique({ where: { id }, include: INCLUDE_USAGE }),
              '集群',
            ),
          ),
        };
      }),
    );
  }

  delete(id: string, revision: number) {
    return metadataMutation(() =>
      withWritableControlPlane(this.db, async (tx) => {
        await lockCluster(tx, id);
        const current = requireRecord(
          await tx.cluster.findUnique({ where: { id }, include: INCLUDE_USAGE }),
          '集群',
        );
        requireRevision(current, revision);
        await assertResourceIdle(tx, { clusterId: id });
        if (current._count.projects > 0) {
          throw new Problem(
            409,
            'RESOURCE_IN_USE',
            '该集群仍有关联项目，即使项目为空也不能移除登记。',
          );
        }
        const [managedResources, networkResources] = await Promise.all([
          tx.managedResource.count({ where: { clusterId: id } }),
          tx.networkManagedResource.count({ where: { clusterId: id } }),
        ]);
        // FK SET NULL detaches the registration only. Original targets, UIDs,
        // nonces and receipts remain available without granting a new owner.
        const deleted = await tx.cluster.deleteMany({ where: { id, revision } });
        if (deleted.count !== 1) revisionConflict();
        const audit = requestAuditContext.getStore();
        await tx.auditEvent.create({
          data: {
            actorId: audit?.actorId,
            requestId: audit?.requestId,
            action: 'cluster.unregister',
            resourceType: 'cluster',
            resourceId: id,
            outcome: 'succeeded',
            metadata: {
              clusterId: id,
              kubeSystemUid: current.kubeSystemUid,
              retainedManagedResources: managedResources,
              retainedNetworkResources: networkResources,
            },
          },
        });
      }),
    );
  }
}
