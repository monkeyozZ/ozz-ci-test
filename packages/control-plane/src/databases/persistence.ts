import { Prisma } from '@ozz/database';
import { isDeepStrictEqual } from 'node:util';
import { workloadNames } from '@ozz/infrastructure/workload';
import { OperationRequestError } from '../tasks/contracts.js';
import { json, serviceInclude, type ServiceRecord } from '../services/persistence.js';
import { presentService } from '../services/views.js';
import {
  DATABASE_OBSERVATION_STALE_MS,
  type DatabaseAuthenticationObservation,
  type DatabaseBindingSnapshot,
  type DatabaseOutputMapping,
  type DatabaseView,
} from './contracts.js';

export const databaseInclude = {
  service: { include: serviceInclude },
  dataVolume: true,
} satisfies Prisma.DatabaseInstanceInclude;
export type DatabaseRecord = Prisma.DatabaseInstanceGetPayload<{ include: typeof databaseInclude }>;
export async function requireDatabase(
  tx: Prisma.TransactionClient,
  id: string,
  lock = false,
): Promise<DatabaseRecord> {
  if (lock)
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "DatabaseInstance" WHERE "id"=${id}::uuid FOR UPDATE`,
    );
  const database = await tx.databaseInstance.findUnique({
    where: { id },
    include: databaseInclude,
  });
  if (!database) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '数据库实例不存在。');
  return database;
}
export function databaseObservation(database: DatabaseRecord) {
  const observation =
    database.observationJson as unknown as DatabaseAuthenticationObservation | null;
  const service = database.service;
  const view = service ? presentService(service) : null;
  const stale =
    !database.lastObservedAt ||
    Date.now() - database.lastObservedAt.getTime() > DATABASE_OBSERVATION_STALE_MS ||
    Boolean(database.observationErrorCode) ||
    !service ||
    !view ||
    view.observationStale ||
    !service.publishedDeployment?.appliedAt ||
    database.lastObservedAt < service.publishedDeployment.appliedAt;
  const ready = Boolean(
    !stale &&
    !database.dataVolume.destroyedAt &&
    observation?.state === 'ready' &&
    observation.authenticated &&
    database.initializedAt &&
    observation.pvcUid &&
    observation.pvcUid === database.dataVolume.pvcUid &&
    view?.runtimeState === 'running' &&
    view.observation?.pods.some(
      (pod) => pod.uid === observation.podUid && pod.ready && !pod.deletionTimestamp,
    ),
  );
  return { observation, stale, ready };
}
export async function databaseConsumers(tx: Prisma.TransactionClient, id: string) {
  const [drafts, publications] = await Promise.all([
    tx.databaseBinding.findMany({
      where: { databaseInstanceId: id, desired: true },
      take: 101,
      include: { consumer: { select: { id: true, name: true } } },
      orderBy: { id: 'asc' },
    }),
    tx.deploymentDatabaseReference.findMany({
      where: {
        databaseInstanceId: id,
        deployment: {
          OR: [{ status: { in: ['queued', 'running'] } }, { publishedBy: { isNot: null } }],
        },
      },
      take: 201,
      include: {
        deployment: {
          select: {
            status: true,
            service: { select: { id: true, name: true, publishedDeploymentId: true } },
          },
        },
      },
      orderBy: { deploymentId: 'asc' },
    }),
  ]);
  const byService = new Map<string, DatabaseView['consumers'][number]>();
  for (const draft of drafts)
    byService.set(draft.consumerServiceId, {
      serviceId: draft.consumer.id,
      name: draft.consumer.name,
      desired: true,
      published: false,
      inFlight: false,
    });
  for (const publication of publications) {
    const consumer = publication.deployment.service;
    if (!consumer) continue;
    const entry = byService.get(consumer.id) ?? {
      serviceId: consumer.id,
      name: consumer.name,
      desired: false,
      published: false,
      inFlight: false,
    };
    entry.published ||= consumer.publishedDeploymentId === publication.deploymentId;
    entry.inFlight ||= ['queued', 'running'].includes(publication.deployment.status);
    byService.set(consumer.id, entry);
  }
  return {
    consumers: [...byService.values()].slice(0, 100),
    truncated: drafts.length > 100 || publications.length > 200 || byService.size > 100,
  };
}
export async function assertDatabaseHasNoConsumers(
  tx: Prisma.TransactionClient,
  serviceId: string,
): Promise<void> {
  const database = await tx.databaseInstance.findUnique({
    where: { serviceId },
    select: { id: true },
  });
  if (!database) return;
  // Serializes provider deletion against binding/deployment admission. A consumer
  // takes provider locks in sorted ID order and never locks the provider Service.
  await requireDatabase(tx, database.id, true);
  const [draftCount, publishedCount] = await Promise.all([
    tx.databaseBinding.count({ where: { databaseInstanceId: database.id, desired: true } }),
    tx.deploymentDatabaseReference.count({
      where: {
        databaseInstanceId: database.id,
        deployment: {
          OR: [{ status: { in: ['queued', 'running'] } }, { publishedBy: { isNot: null } }],
        },
      },
    }),
  ]);
  if (draftCount || publishedCount)
    throw new OperationRequestError(
      409,
      'DATABASE_DEPENDENCY_IN_USE',
      '其他服务仍在草稿、已发布配置或在途任务中依赖此数据库，请先解除并发布消费者配置。',
    );
}
export async function captureDatabaseBinding(
  tx: Prisma.TransactionClient,
  consumer: ServiceRecord,
  binding: {
    id: string;
    databaseInstanceId: string;
    profile: string;
    mappingJson: Prisma.JsonValue;
  },
): Promise<DatabaseBindingSnapshot> {
  const database = await requireDatabase(tx, binding.databaseInstanceId, true);
  const provider = database.service;
  const target = database.dataVolume.targetJson as {
    environmentId: string;
    projectId: string;
    clusterId: string;
  };
  if (
    !provider ||
    consumer.kind !== 'application' ||
    provider.id === consumer.id ||
    consumer.environmentId !== target.environmentId ||
    consumer.environment.projectId !== target.projectId ||
    consumer.environment.project.clusterId !== target.clusterId
  )
    throw new OperationRequestError(
      422,
      'DATABASE_TARGET_MISMATCH',
      '仅普通应用可以引用同项目、同环境、同集群中的数据库服务。',
    );
  if (
    provider.activeMutation ||
    !databaseObservation(database).ready ||
    !provider.publishedDeploymentId
  )
    throw new OperationRequestError(
      409,
      'DATABASE_DEPENDENCY_NOT_READY',
      '数据库提供方缺少新鲜的发布和认证就绪证明，请等待当前任务及观察完成。',
    );
  const secret = await tx.secretReference.findUnique({
    where: { id: database.credentialRefId },
    select: { kind: true, contentRevision: true, expiresAt: true },
  });
  if (
    !secret ||
    secret.kind !== 'database' ||
    secret.contentRevision !== database.credentialContentRevision ||
    (secret.expiresAt && secret.expiresAt <= new Date())
  )
    throw new OperationRequestError(
      409,
      'DATABASE_CREDENTIAL_CHANGED',
      '数据库的固定初始化凭证不可用。',
    );
  const names = workloadNames({ serviceId: provider.id, environmentId: provider.environmentId });
  const resource = await tx.managedResource.findUnique({
    where: {
      clusterId_kind_namespace_name: {
        clusterId: target.clusterId,
        kind: 'Service',
        namespace: names.namespace,
        name: names.service,
      },
    },
  });
  if (!resource?.uid || resource.deletedAt || resource.serviceId !== provider.id)
    throw new OperationRequestError(
      409,
      'DATABASE_DEPENDENCY_NOT_READY',
      '数据库的私有 Service 身份尚未确认。',
    );
  return {
    version: 1,
    bindingId: binding.id,
    databaseInstanceId: database.id,
    providerServiceId: provider.id,
    providerDeploymentId: provider.publishedDeploymentId,
    providerServiceUid: resource.uid,
    clusterId: target.clusterId,
    environmentId: target.environmentId,
    namespace: names.namespace,
    host: `${names.service}.${names.namespace}.svc.cluster.local`,
    port: database.engine === 'postgresql' ? 5432 : 6379,
    engine: database.engine as 'postgresql' | 'redis',
    databaseName: database.databaseName,
    redisDatabase: database.redisDatabase,
    username: database.username,
    credentialRefId: database.credentialRefId,
    credentialContentRevision: database.credentialContentRevision,
    profile: binding.profile as 'fields' | 'url',
    mapping: binding.mappingJson as DatabaseOutputMapping,
  };
}
export async function captureDatabaseBindings(
  tx: Prisma.TransactionClient,
  consumer: ServiceRecord,
): Promise<DatabaseBindingSnapshot[]> {
  const bindings = await tx.databaseBinding.findMany({
    where: { consumerServiceId: consumer.id, desired: true },
    orderBy: { databaseInstanceId: 'asc' },
  });
  if (bindings.length > 8)
    throw new OperationRequestError(422, 'DATABASE_BINDING_LIMIT', '单服务最多引用 8 个数据库。');
  const captured: DatabaseBindingSnapshot[] = [];
  for (const binding of bindings)
    captured.push(await captureDatabaseBinding(tx, consumer, binding));
  return captured;
}
export async function assertDatabaseBindingSnapshots(
  tx: Prisma.TransactionClient,
  consumer: ServiceRecord,
  snapshots: readonly DatabaseBindingSnapshot[],
): Promise<void> {
  for (const snapshot of [...snapshots].sort((a, b) =>
    a.databaseInstanceId.localeCompare(b.databaseInstanceId),
  )) {
    const current = await captureDatabaseBinding(tx, consumer, {
      id: snapshot.bindingId,
      databaseInstanceId: snapshot.databaseInstanceId,
      profile: snapshot.profile,
      mappingJson: json(snapshot.mapping) as Prisma.JsonValue,
    });
    if (!isDeepStrictEqual(current, snapshot))
      throw new OperationRequestError(
        409,
        'DATABASE_DEPENDENCY_CHANGED',
        '数据库提供方的固定发布或数据身份已变化，原任务不能改用新的同名实例。',
      );
  }
}
export async function saveDatabaseDeploymentReferences(
  tx: Prisma.TransactionClient,
  deploymentId: string,
  snapshots: readonly DatabaseBindingSnapshot[],
): Promise<void> {
  if (snapshots.length)
    await tx.deploymentDatabaseReference.createMany({
      data: snapshots.map((snapshot) => ({
        deploymentId,
        databaseInstanceId: snapshot.databaseInstanceId,
        bindingId: snapshot.bindingId,
        referenceJson: json(snapshot),
      })),
    });
}
