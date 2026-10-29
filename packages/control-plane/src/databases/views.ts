import type { Prisma } from '@ozz/database';
import { workloadNames } from '@ozz/infrastructure/workload';
import type { DatabaseView } from './contracts.js';
import { databaseProtectedFields } from './protection.js';
import { databaseConsumers, databaseObservation, type DatabaseRecord } from './persistence.js';

export async function presentDatabase(
  tx: Prisma.TransactionClient,
  database: DatabaseRecord,
): Promise<DatabaseView> {
  const { observation, stale, ready } = databaseObservation(database);
  const references = await databaseConsumers(tx, database.id);
  const volume = database.dataVolume;
  const target = volume.targetJson as {
    projectId: string;
    environmentId: string;
    clusterId: string;
  };
  const service = database.service;
  const names = service
    ? workloadNames({ serviceId: service.id, environmentId: service.environmentId })
    : null;
  return {
    id: database.id,
    revision: database.revision,
    engine: database.engine as 'postgresql' | 'redis',
    majorVersion: database.majorVersion,
    exactVersion: database.exactVersion,
    template: { id: database.templateId, version: database.templateVersion },
    service: service ? { id: service.id, name: service.name, slug: service.slug } : null,
    originalService: database.originalServiceJson as DatabaseView['originalService'],
    projectId: target.projectId,
    environmentId: target.environmentId,
    clusterId: target.clusterId,
    dataVolume: {
      id: volume.id,
      name: volume.name,
      namespace: volume.namespace,
      pvcName: volume.pvcName,
      pvcUid: volume.pvcUid,
      requestedBytes: volume.requestedBytes.toString(),
      destroyedAt: volume.destroyedAt?.toISOString() ?? null,
    },
    protection: {
      active: Boolean(database.initializationFenceAt),
      revision: database.protectionRevision,
      fencedAt: database.initializationFenceAt?.toISOString() ?? null,
      lockedFields: [...databaseProtectedFields],
      reason: database.initializationFenceAt
        ? '该卷可能已包含数据库数据；密码、主版本和数据布局只能通过独立维护流程变更。'
        : '固定数据库模板生成初始化配置；首次创建数据卷前会锁定数据身份。',
    },
    initialization: {
      state: database.initializationState,
      initializedAt: database.initializedAt?.toISOString() ?? null,
      pvcUid: database.initializationPvcUid,
    },
    credential: {
      refId: database.credentialRefId,
      contentRevision: database.credentialContentRevision,
    },
    connection: {
      host: names ? `${names.service}.${names.namespace}.svc.cluster.local` : null,
      port: database.engine === 'postgresql' ? 5432 : 6379,
      username: database.username,
      database: database.databaseName,
      redisDatabase: database.redisDatabase,
      visibility: 'cluster_private',
    },
    databaseReady: ready,
    observation,
    observationStale: Boolean(stale),
    consumers: references.consumers,
    consumersTruncated: references.truncated,
    createdAt: database.createdAt.toISOString(),
    updatedAt: database.updatedAt.toISOString(),
  };
}
