import { createHash } from 'node:crypto';
import { Prisma, type AuditEvent, type Volume, type VolumeMount } from '@ozz/database';
import type { StorageVolumeObservation } from '@ozz/infrastructure/storage';
import {
  STORAGE_OBSERVATION_STALE_MS,
  type CreateManualDataRecordInput,
  type ManualDataIdentity,
  type ManualDataRecordView,
  type StorageIdentity,
  type StorageIssue,
  type VolumeDeletionPreview,
  type VolumeMountView,
  type VolumeSnapshotReference,
  type VolumeView,
} from './contracts.js';
import { volumeTarget, type VolumeRecord } from './persistence.js';

export function identity(row: StorageIdentity): StorageIdentity {
  return { id: row.id, name: row.name, slug: row.slug };
}
export function presentMount(
  row: VolumeMount & { service?: StorageIdentity | null },
  volume: Pick<Volume, 'id' | 'name' | 'slug' | 'revision' | 'destroyedAt'>,
): VolumeMountView {
  return {
    id: row.id,
    serviceId: row.serviceId,
    service: row.service ? identity(row.service) : null,
    volumeId: row.volumeId,
    volume: {
      ...identity(volume),
      revision: volume.revision,
      destroyedAt: volume.destroyedAt?.toISOString() ?? null,
    },
    mountPath: row.mountPath,
    readOnly: row.readOnly,
    desired: row.desired,
    lastPublishedDeploymentId: row.lastPublishedDeploymentId,
    detachedAt: row.detachedAt?.toISOString() ?? null,
  };
}
export function observationOf(row: VolumeRecord): StorageVolumeObservation | null {
  return row.observationJson as unknown as StorageVolumeObservation | null;
}
export function observationStale(row: VolumeRecord): boolean {
  return (
    !row.lastObservedAt ||
    Boolean(row.observationErrorCode) ||
    Date.now() - row.lastObservedAt.getTime() > STORAGE_OBSERVATION_STALE_MS
  );
}
export function manualDataIdentity(row: Volume): ManualDataIdentity | null {
  if (!row.pvcUid) return null;
  const target = volumeTarget(row);
  return {
    installationId: target.installationId,
    clusterId: target.clusterId,
    kubeSystemUid: target.kubeSystemUid,
    environmentId: target.environmentId,
    volumeId: row.id,
    pvcUid: row.pvcUid,
  };
}
export function deletionBlockers(row: VolumeRecord): StorageIssue[] {
  const blockers: StorageIssue[] = [];
  const add = (code: string, message: string) => {
    if (!blockers.some((issue) => issue.code === code)) blockers.push({ code, message });
  };
  if (row.destroyedAt) add('VOLUME_DESTROYED', '该卷已经完成销毁确认。');
  if (row.activeMutation) add('VOLUME_OPERATION_ACTIVE', '该卷仍有在途任务。');
  if (row.mounts.length) add('VOLUME_MOUNT_REFERENCED', '卷仍有草稿或待实际卸载的服务占用。');
  if (row.deploymentReferences.length)
    add('VOLUME_PUBLISHED_REFERENCE', '当前已发布快照仍引用此卷，停止服务不会删除引用。');
  if (row.database?.serviceId)
    add('VOLUME_DATABASE_SERVICE_EXISTS', '数据库服务仍持有此数据身份；请先完成服务删除审查。');
  if (row.maintenances.some((item) => item.state !== 'closed'))
    add('VOLUME_MAINTENANCE_ACTIVE', '维护记录尚未明确关闭。');
  if (row.creationAttempted || row.pvcUid) {
    const observed = observationOf(row);
    if (observationStale(row))
      add('VOLUME_OBSERVATION_STALE', '请先刷新实际卷与挂载观察，不能依据过期缓存销毁数据。');
    if (!observed || !['pending', 'ready'].includes(observed.state))
      add('VOLUME_STATE_UNCERTAIN', '实际 PVC、数据位置或资源身份尚未核实。');
    if (observed?.mountsTruncated) add('VOLUME_MOUNTS_INCOMPLETE', '实际 Pod 引用未完整读取。');
    if (observed?.mounts.length)
      add('VOLUME_ACTUAL_MOUNTS', '实际 Pod 仍引用此 PVC，请先完整卸载并移除维护 Pod。');
    if (!observed?.storageClass?.supported || observed.storageClass.uid !== row.storageClassUid)
      add('VOLUME_STORAGE_CLASS_UNVERIFIED', '存储类或 provisioner 不在已经核验的支持范围。');
    const policy = observed?.pv?.reclaimPolicy ?? observed?.storageClass?.reclaimPolicy ?? null;
    if (policy !== 'Delete')
      add(
        'VOLUME_RECLAIM_POLICY_UNSUPPORTED',
        '自动销毁只支持实际核验的 Delete 策略；Retain 或未知策略需要单独处理。',
      );
    for (const issue of observed?.destructionBlockers ?? []) add(issue.code, issue.message);
  }
  return blockers;
}
export function presentVolume(
  row: VolumeRecord,
  lastManualBackupRecord: ManualDataRecordView | null = null,
): VolumeView {
  const observed = observationOf(row);
  const stale = observationStale(row);
  const mounts = row.mounts.slice(0, 100).map((item) => presentMount(item, row));
  const published = row.deploymentReferences.slice(0, 100).map((reference) => {
    const ref = reference.referenceJson as unknown as VolumeSnapshotReference;
    const mount = mounts.find((item) => item.id === ref.mountId);
    return {
      id: ref.mountId,
      serviceId: reference.deployment.serviceId,
      service: mount?.service ?? null,
      volumeId: row.id,
      volume: {
        ...identity(row),
        revision: row.revision,
        destroyedAt: row.destroyedAt?.toISOString() ?? null,
      },
      mountPath: ref.mountPath,
      readOnly: ref.readOnly,
      desired: mount?.desired ?? false,
      lastPublishedDeploymentId: reference.deploymentId,
      detachedAt: null,
    } satisfies VolumeMountView;
  });
  const maintenance = row.maintenances[0];
  const exitBlockers: StorageIssue[] = [];
  if (maintenance && maintenance.state !== 'closed') {
    if ((row.creationAttempted || row.pvcUid) && stale)
      exitBlockers.push({
        code: 'VOLUME_OBSERVATION_STALE',
        message: '需要新的实际占用观察后才能退出维护。',
      });
    if (observed?.mountsTruncated || observed?.mounts.length)
      exitBlockers.push({
        code: 'VOLUME_MAINTENANCE_PODS_REMAIN',
        message: '维护 Pod 或其他 Pod 引用仍存在，或实际引用列表不完整。',
      });
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    revision: row.revision,
    project: row.environment ? identity(row.environment.project) : null,
    environment: row.environment ? identity(row.environment) : null,
    cluster: row.cluster ? identity(row.cluster) : null,
    namespace: row.namespace,
    requestedBytes: row.requestedBytes.toString(),
    storageClassName: row.storageClassName,
    storageClassUid: row.storageClassUid,
    storageClass: observed?.storageClass ?? null,
    hardQuotaSupport: observed?.hardQuotaSupport ?? 'unknown',
    desiredState: row.destroyedAt ? 'destroyed' : row.deletionIntentJson ? 'destroying' : 'active',
    retained: row.mounts.length === 0 && row.deploymentReferences.length === 0,
    destroyedAt: row.destroyedAt?.toISOString() ?? null,
    pvc: observed
      ? { ...observed.pvc, uid: row.pvcUid }
      : {
          name: row.pvcName,
          uid: row.pvcUid,
          resourceVersion: row.resourceVersion,
          phase: 'Unknown',
          deleting: false,
        },
    pv: observed?.pv
      ? { ...observed.pv, capacityBytes: observed.pv.capacityBytes?.toString() ?? null }
      : null,
    locality: observed?.locality ?? 'unknown',
    nodes: observed?.nodes ?? [],
    usage: { usedBytes: null, nodeAvailableBytes: null, observedAt: null },
    mounts: {
      desired: mounts.filter((item) => item.desired),
      published,
      actual: observed?.mounts ?? [],
      truncated:
        Boolean(observed?.mountsTruncated) ||
        row.mounts.length > 100 ||
        row.deploymentReferences.length > 100,
    },
    observation: {
      state: row.destroyedAt ? 'destroyed' : (observed?.state ?? 'unknown'),
      observedAt: row.lastObservedAt?.toISOString() ?? null,
      stale: row.destroyedAt ? false : stale,
      code: row.observationErrorCode ?? observed?.code ?? null,
      message: row.destroyedAt
        ? '已核实原 PVC 与需回收的 PV 对象消失；此记录不证明物理介质安全擦除。'
        : row.observationErrorCode
          ? (row.lastErrorMessage ?? '暂时无法核实实际数据位置，保留上次观察。')
          : (observed?.message ?? '尚未完成实际卷观察。'),
    },
    maintenance: maintenance
      ? {
          id: maintenance.id,
          purpose: maintenance.purpose as 'backup' | 'restore',
          state: maintenance.state as NonNullable<VolumeView['maintenance']>['state'],
          revision: maintenance.revision,
          enteredAt: maintenance.enteredAt?.toISOString() ?? null,
          expiresAt: maintenance.expiresAt.toISOString(),
          releasedAt: maintenance.exitedAt?.toISOString() ?? null,
          overdue: maintenance.state !== 'closed' && maintenance.expiresAt <= new Date(),
          lastErrorCode: maintenance.lastErrorCode,
          exitBlockers,
        }
      : null,
    activeTask: row.activeMutation
      ? row.activeMutation.operation
        ? {
            type: 'operation',
            id: row.activeMutation.operation.id,
            kind: row.activeMutation.operation.kind,
            status: row.activeMutation.operation.status,
          }
        : row.activeMutation.deployment
          ? {
              type: 'deployment',
              id: row.activeMutation.deployment.id,
              kind: row.activeMutation.deployment.kind,
              status: row.activeMutation.deployment.status,
            }
          : null
      : null,
    deletionBlockers: deletionBlockers(row),
    retainedDatabase: row.database
      ? {
          id: row.database.id,
          serviceId: row.database.serviceId,
          engine: row.database.engine,
          majorVersion: row.database.majorVersion,
          initializedAt: row.database.initializedAt?.toISOString() ?? null,
          initializationFenceAt: row.database.initializationFenceAt?.toISOString() ?? null,
        }
      : null,
    manualDataIdentity: manualDataIdentity(row),
    lastManualBackupRecord,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function deletionPreview(
  row: VolumeRecord,
  backup: ManualDataRecordView | null = null,
): VolumeDeletionPreview {
  const view = presentVolume(row, backup);
  const facts = {
    volumeId: row.id,
    revision: row.revision,
    volumeName: row.name,
    pvcUid: row.pvcUid,
    pvcName: row.pvcName,
    pvName: view.pv?.name ?? null,
    reclaimPolicy: view.pv?.reclaimPolicy ?? view.storageClass?.reclaimPolicy ?? null,
    storageClassUid: row.storageClassUid,
    creationNonce: row.creationNonce,
    blockers: view.deletionBlockers.map((item) => item.code).sort(),
    mounts: row.mounts.map((item) => item.id).sort(),
    published: row.deploymentReferences.map((item) => item.deploymentId).sort(),
    actual: view.mounts.actual.map((item) => item.podUid).sort(),
    maintenance: view.maintenance?.state === 'closed' ? null : (view.maintenance?.id ?? null),
  };
  return {
    volumeId: row.id,
    revision: row.revision,
    volumeName: row.name,
    pvcUid: row.pvcUid,
    pvcName: row.pvcName,
    pvName: view.pv?.name ?? null,
    reclaimPolicy: facts.reclaimPolicy,
    observedAt: view.observation.observedAt,
    previewDigest: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
    blockers: view.deletionBlockers,
    retained: view.retained,
    retainedDatabase: view.retainedDatabase,
    lastManualBackupRecord: backup,
  };
}
export function presentManualRecord(row: AuditEvent): ManualDataRecordView {
  const value = row.metadata as unknown as CreateManualDataRecordInput;
  return {
    ...value,
    id: row.id,
    volumeId: row.resourceId!,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
    verificationSource: 'operator_reported',
    durationMs: Date.parse(value.completedAt) - Date.parse(value.startedAt),
  };
}
export async function latestBackupRecords(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
): Promise<Map<string, ManualDataRecordView>> {
  if (!ids.length) return new Map();
  const rows = await tx.$queryRaw<AuditEvent[]>(Prisma.sql`
    SELECT DISTINCT ON ("resourceId") * FROM "AuditEvent"
    WHERE "action" = 'volume.manual_data_record' AND "resourceType" = 'volume'
      AND "resourceId" IN (${Prisma.join([...ids])}) AND "metadata"->>'type' = 'backup'
    ORDER BY "resourceId", "createdAt" DESC, "id" DESC
  `);
  return new Map(rows.map((row) => [row.resourceId!, presentManualRecord(row)]));
}
