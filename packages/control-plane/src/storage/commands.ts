import { Prisma } from '@ozz/database';
import type { StorageCapabilities } from '@ozz/infrastructure/storage';
import { withWritableControlPlane } from '../recovery.js';
import { json, lockService, requireIdle, requireServiceRevision } from '../services/persistence.js';
import { OperationRequestError, pageLimit, type OperationView } from '../tasks/contracts.js';
import { TaskRepository, type OperationActor } from '../tasks/repository.js';
import {
  SERVICE_VOLUME_LIMIT,
  STORAGE_OBSERVATION_STALE_MS,
  parseVolumeOperationInput,
  type ClusterStorageView,
  type ManualDataIdentity,
  type VolumeCreateResult,
  type VolumeListQuery,
  type VolumeMountCollection,
  type VolumeOperationInput,
  type VolumeOperationKind,
} from './contracts.js';
import {
  assertMountPermitted,
  assertVolumeTarget,
  conflict,
  insertInitialVolumeMount,
  lockVolume,
  requireVolume,
  requireVolumeIdle,
  requireVolumeRevision,
  requireVolumeUsable,
  reserveVolume,
  volumeInclude,
  volumeTarget,
} from './persistence.js';
import {
  confirmationInput,
  createVolumeInput,
  decodeCursor,
  encodeCursor,
  inputRecord,
  manualRecordInput,
  resourceId,
  revision,
  saveMountInput,
  text,
} from './validation.js';
import {
  deletionPreview,
  latestBackupRecords,
  manualDataIdentity,
  presentManualRecord,
  presentMount,
  presentVolume,
} from './views.js';

function sameManualDataIdentity(expected: ManualDataIdentity, actual: ManualDataIdentity | null) {
  return (
    actual !== null &&
    expected.installationId === actual.installationId &&
    expected.clusterId === actual.clusterId &&
    expected.kubeSystemUid === actual.kubeSystemUid &&
    expected.environmentId === actual.environmentId &&
    expected.volumeId === actual.volumeId &&
    expected.pvcUid === actual.pvcUid
  );
}

/** HTTP admission only. Every Kubernetes read/write belongs to the Worker. */
export class StorageCommands {
  constructor(readonly repository: TaskRepository) {}

  async get(id: string) {
    const row = await requireVolume(this.repository.db, resourceId(id));
    const backups = await latestBackupRecords(this.repository.db, [row.id]);
    return presentVolume(row, backups.get(row.id) ?? null);
  }
  async list(query: VolumeListQuery = {}) {
    const limit = pageLimit(query.limit);
    for (const field of ['projectId', 'environmentId', 'clusterId', 'serviceId'] as const)
      if (query[field]) resourceId(query[field]);
    if (query.retained !== undefined && typeof query.retained !== 'boolean')
      throw new OperationRequestError(422, 'STORAGE_INPUT_INVALID', '保留卷筛选必须是布尔值。');
    const cursor = decodeCursor(query.cursor);
    const retained: Prisma.VolumeWhereInput = {
      mounts: { none: { detachedAt: null } },
      deploymentReferences: { none: { deployment: { publishedBy: { isNot: null } } } },
    };
    const rows = await this.repository.db.volume.findMany({
      where: {
        AND: [
          cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {},
          query.environmentId ? { environmentId: query.environmentId } : {},
          query.clusterId ? { clusterId: query.clusterId } : {},
          query.projectId ? { environment: { projectId: query.projectId } } : {},
          query.serviceId
            ? { mounts: { some: { serviceId: query.serviceId, detachedAt: null } } }
            : {},
          query.retained === true ? retained : query.retained === false ? { NOT: retained } : {},
          query.search
            ? {
                OR: ['name', 'slug'].map((field) => ({
                  [field]: { contains: text(query.search, 120, '搜索词'), mode: 'insensitive' },
                })),
              }
            : {},
        ],
      },
      include: volumeInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const data = rows.slice(0, limit);
    const backups = await latestBackupRecords(
      this.repository.db,
      data.map((row) => row.id),
    );
    return {
      data: data.map((row) => presentVolume(row, backups.get(row.id) ?? null)),
      page: {
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit && data.at(-1) ? encodeCursor(data.at(-1)!) : null,
      },
    };
  }
  async clusterStorage(id: string): Promise<ClusterStorageView> {
    resourceId(id);
    const cluster = await this.repository.db.cluster.findUnique({ where: { id } });
    if (!cluster) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '集群不存在。');
    const capabilities = cluster.storageCapabilitiesJson as unknown as StorageCapabilities | null;
    return {
      clusterId: id,
      capabilities,
      storageClasses: capabilities?.storageClasses ?? [],
      observedAt: cluster.storageCapabilitiesAt?.toISOString() ?? null,
      stale:
        Boolean(cluster.storageErrorCode) ||
        !cluster.storageCapabilitiesAt ||
        Date.now() - cluster.storageCapabilitiesAt.getTime() > STORAGE_OBSERVATION_STALE_MS,
      lastAttemptAt: cluster.storageLastAttemptAt?.toISOString() ?? null,
      errorCode: cluster.storageErrorCode,
    };
  }
  async create(raw: unknown, actor: OperationActor, key: unknown): Promise<VolumeCreateResult> {
    const input = createVolumeInput(raw);
    const operation = await this.repository.enqueue(
      actor,
      key,
      { kind: 'volume_create', request: input },
      async (tx) => {
        const volume = await reserveVolume(tx, input);
        const row = await requireVolume(tx, volume.id);
        const cluster = row.cluster!;
        const capability = cluster.storageCapabilitiesJson as unknown as StorageCapabilities | null;
        if (
          !cluster.storageCapabilitiesAt ||
          cluster.storageErrorCode ||
          Date.now() - cluster.storageCapabilitiesAt.getTime() > STORAGE_OBSERVATION_STALE_MS ||
          !capability ||
          capability.truncated ||
          capability.provisioner.state !== 'ready' ||
          capability.permissions !== 'ready' ||
          !capability.storageClasses.some(
            (value) => value.name === input.storageClassName && value.supported,
          )
        )
          conflict(
            'STORAGE_CAPABILITIES_REQUIRED',
            '目标集群尚无新的已核验存储能力；请等待存储观察后再创建卷。',
          );
        const updated = await tx.volume.update({
          where: { id: volume.id },
          data: { mutationRevision: { increment: 1 } },
        });
        const taskInput: VolumeOperationInput = {
          volumeId: volume.id,
          volumeRevision: updated.revision,
          mutationRevision: updated.mutationRevision,
          target: volumeTarget(updated),
        };
        return {
          input: taskInput,
          clusterId: updated.clusterId!,
          onAccepted: async (tx, ref) => {
            await tx.volumeMutation.create({ data: { volumeId: volume.id, operationId: ref.id } });
          },
        };
      },
    );
    return { volumeId: parseVolumeOperationInput(operation.input).volumeId, operation };
  }
  async deletionPreview(id: string, raw: unknown) {
    resourceId(id);
    const input = inputRecord(raw, ['revision']);
    const row = await requireVolume(this.repository.db, id);
    requireVolumeRevision(row, revision(input.revision));
    const backups = await latestBackupRecords(this.repository.db, [id]);
    return deletionPreview(row, backups.get(id) ?? null);
  }
  async action(
    id: string,
    kind: Exclude<VolumeOperationKind, 'volume_create'>,
    raw: unknown,
    actor: OperationActor,
    key: unknown,
  ): Promise<OperationView> {
    resourceId(id);
    const input = inputRecord(raw, [
      'revision',
      ...(kind === 'volume_destroy' ? ['confirmation'] : []),
      ...(kind === 'volume_maintenance_enter' ? ['purpose'] : []),
      ...(kind === 'volume_maintenance_exit' ? ['maintenanceId'] : []),
    ]);
    const expectedRevision = revision(input.revision);
    const confirmation =
      kind === 'volume_destroy' ? confirmationInput(input.confirmation) : undefined;
    const purpose =
      kind === 'volume_maintenance_enter' ? text(input.purpose, 16, '维护目的') : undefined;
    if (purpose && !['backup', 'restore'].includes(purpose))
      throw new OperationRequestError(
        422,
        'STORAGE_INPUT_INVALID',
        '维护目的须为 backup 或 restore。',
      );
    const maintenanceId =
      kind === 'volume_maintenance_exit' ? resourceId(input.maintenanceId) : undefined;
    return this.repository.enqueue(actor, key, { kind, request: { id, ...input } }, async (tx) => {
      const row = await lockVolume(tx, id);
      requireVolumeRevision(row, expectedRevision);
      requireVolumeIdle(row);
      await assertVolumeTarget(tx, row);
      let selectedMaintenanceId = maintenanceId;
      if (kind === 'volume_destroy') {
        const preview = deletionPreview(row);
        if (preview.blockers.length)
          conflict(preview.blockers[0]!.code, preview.blockers[0]!.message);
        if (
          confirmation!.volumeId !== id ||
          confirmation!.pvcUid !== preview.pvcUid ||
          confirmation!.reclaimPolicy !== preview.reclaimPolicy ||
          confirmation!.previewDigest !== preview.previewDigest ||
          confirmation!.volumeName !== row.name
        )
          conflict(
            'VOLUME_DELETE_CONFIRMATION_CHANGED',
            '卷身份、回收策略或占用已经变化，请重新审阅销毁预览。',
          );
      }
      if (kind === 'volume_maintenance_enter') {
        requireVolumeUsable(row);
        const maintenance = await tx.volumeMaintenance.create({
          data: {
            volumeId: id,
            purpose: purpose!,
            expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
            intentJson: json({
              purpose,
              actorId: actor.id,
              volumeId: id,
              pvcUid: row.pvcUid,
              requestedAt: new Date().toISOString(),
            }),
          },
        });
        selectedMaintenanceId = maintenance.id;
      }
      if (kind === 'volume_maintenance_exit') {
        const maintenance = row.maintenances.find(
          (value) => value.id === maintenanceId && value.state !== 'closed',
        );
        if (!maintenance) conflict('VOLUME_MAINTENANCE_CHANGED', '原维护记录不存在或已经关闭。');
        await tx.volumeMaintenance.update({
          where: { id: maintenanceId },
          data: { state: 'exiting', revision: { increment: 1 } },
        });
      }
      const updated = await tx.volume.update({
        where: { id },
        data: {
          mutationRevision: { increment: 1 },
          ...(kind !== 'volume_sync' ? { revision: { increment: 1 } } : {}),
          ...(confirmation ? { deletionIntentJson: json(confirmation) } : {}),
          observationLeaseToken: null,
          observationLeaseExpiresAt: null,
        },
      });
      const taskInput: VolumeOperationInput = {
        volumeId: id,
        volumeRevision: updated.revision,
        mutationRevision: updated.mutationRevision,
        target: volumeTarget(updated),
        ...(selectedMaintenanceId ? { maintenanceId: selectedMaintenanceId } : {}),
        ...(confirmation ? { confirmation } : {}),
      };
      return {
        input: taskInput,
        clusterId: row.clusterId!,
        onAccepted: async (tx, ref) => {
          await tx.volumeMutation.create({ data: { volumeId: id, operationId: ref.id } });
        },
      };
    });
  }
  async retry(operationId: string, actor: OperationActor, key: unknown): Promise<OperationView> {
    const original = await this.repository.db.operation.findUnique({
      where: { id: resourceId(operationId) },
    });
    if (!original || !original.kind.startsWith('volume_'))
      throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '存储任务不存在。');
    if (!['failed', 'cancelled'].includes(original.status))
      conflict('OPERATION_NOT_RETRYABLE', '只有失败或取消的任务可以重新受理。');
    const previous = parseVolumeOperationInput(original.input);
    return this.repository.enqueue(
      actor,
      key,
      { kind: original.kind as VolumeOperationKind, request: previous, retryOfId: original.id },
      async (tx) => {
        const row = await lockVolume(tx, previous.volumeId);
        requireVolumeIdle(row);
        await assertVolumeTarget(tx, row, previous.target);
        if (row.revision !== previous.volumeRevision)
          conflict('REVISION_CONFLICT', '卷在原任务后已有新意图，请审阅当前状态后操作。');
        if (
          previous.maintenanceId &&
          !row.maintenances.some(
            (item) => item.id === previous.maintenanceId && item.state !== 'closed',
          )
        )
          conflict('VOLUME_MAINTENANCE_CHANGED', '原维护记录已变化，不能重放任务。');
        const updated = await tx.volume.update({
          where: { id: row.id },
          data: {
            mutationRevision: { increment: 1 },
            observationLeaseToken: null,
            observationLeaseExpiresAt: null,
          },
        });
        return {
          input: { ...previous, mutationRevision: updated.mutationRevision },
          clusterId: row.clusterId!,
          onAccepted: async (tx, ref) => {
            await tx.volumeMutation.create({ data: { volumeId: row.id, operationId: ref.id } });
          },
        };
      },
    );
  }
  private async readMounts(
    tx: Prisma.TransactionClient,
    serviceId: string,
  ): Promise<VolumeMountCollection> {
    const service = await tx.service.findUnique({
      where: { id: serviceId },
      select: { revision: true, configRevision: true },
    });
    if (!service) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '服务不存在。');
    const mounts = await tx.volumeMount.findMany({
      where: { serviceId, detachedAt: null },
      include: { volume: true, service: { select: { id: true, name: true, slug: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SERVICE_VOLUME_LIMIT + 1,
    });
    if (mounts.length > SERVICE_VOLUME_LIMIT)
      conflict('VOLUME_MOUNT_LIMIT', '服务挂载集合超过支持上限。');
    return {
      data: mounts.map((row) => presentMount(row, row.volume)),
      serviceRevision: service.revision,
      configRevision: service.configRevision,
    };
  }
  mounts(serviceId: string) {
    return this.readMounts(this.repository.db, resourceId(serviceId));
  }
  async saveMount(serviceId: string, raw: unknown): Promise<VolumeMountCollection> {
    resourceId(serviceId);
    const input = saveMountInput(raw);
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, serviceId);
      requireServiceRevision(service, input.revision);
      requireIdle(service);
      if (service.kind === 'database')
        conflict(
          'DATABASE_DATA_PROTECTED',
          '数据库的数据挂载由固定模板管理，不能通过普通挂载表单修改。',
        );
      if (!input.readOnly && (service.configJson as { replicas?: number }).replicas !== 1)
        conflict('VOLUME_SINGLE_WRITER_REQUIRED', '可写卷服务须先将草稿副本数调整为 1。');
      const volume = await lockVolume(tx, input.volumeId);
      requireVolumeRevision(volume, input.volumeRevision);
      requireVolumeIdle(volume);
      await assertMountPermitted(tx, service, volume, input.readOnly);
      const existing = await tx.volumeMount.findFirst({
        where: { serviceId, volumeId: volume.id, detachedAt: null },
      });
      if (existing) {
        if (existing.mountPath !== input.mountPath || existing.readOnly !== input.readOnly)
          conflict(
            'VOLUME_MOUNT_ALREADY_EXISTS',
            '该卷已有活动挂载；请先解除并发布，再改变路径或读写方式。',
          );
        if (existing.desired) return this.readMounts(tx, serviceId);
        await tx.volumeMount.update({ where: { id: existing.id }, data: { desired: true } });
      } else await insertInitialVolumeMount(tx, service, volume, input);
      await tx.service.update({
        where: { id: serviceId },
        data: { revision: { increment: 1 }, configRevision: { increment: 1 } },
      });
      return this.readMounts(tx, serviceId);
    });
  }
  async removeMount(
    serviceId: string,
    mountId: string,
    raw: unknown,
  ): Promise<VolumeMountCollection> {
    resourceId(serviceId);
    resourceId(mountId);
    const input = inputRecord(raw, ['revision']);
    const expected = revision(input.revision);
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, serviceId);
      requireServiceRevision(service, expected);
      requireIdle(service);
      if (service.kind === 'database')
        conflict('DATABASE_DATA_PROTECTED', '数据库的固定数据挂载受保护；删除服务时会保留数据卷。');
      const mount = await tx.volumeMount.findFirst({
        where: { id: mountId, serviceId, detachedAt: null },
      });
      if (!mount) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '活动挂载不存在。');
      const volume = await lockVolume(tx, mount.volumeId);
      requireVolumeIdle(volume);
      if (!mount.desired) return this.readMounts(tx, serviceId);
      const used = await tx.deploymentVolumeReference.count({
        where: { volumeId: mount.volumeId, referenceJson: { path: ['mountId'], equals: mount.id } },
      });
      await tx.volumeMount.update({
        where: { id: mount.id },
        data: { desired: false, ...(!used ? { detachedAt: new Date() } : {}) },
      });
      await tx.service.update({
        where: { id: serviceId },
        data: { revision: { increment: 1 }, configRevision: { increment: 1 } },
      });
      return this.readMounts(tx, serviceId);
    });
  }
  async manualRecords(
    id: string,
    query: { limit?: number; cursor?: string; type?: 'backup' | 'restore' } = {},
  ) {
    await requireVolume(this.repository.db, resourceId(id));
    const limit = pageLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    if (query.type && !['backup', 'restore'].includes(query.type))
      throw new OperationRequestError(422, 'STORAGE_INPUT_INVALID', '记录类型无效。');
    const rows = await this.repository.db.auditEvent.findMany({
      where: {
        action: 'volume.manual_data_record',
        resourceType: 'volume',
        resourceId: id,
        ...(query.type ? { metadata: { path: ['type'], equals: query.type } } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const data = rows.slice(0, limit);
    return {
      data: data.map(presentManualRecord),
      page: {
        hasMore: rows.length > limit,
        nextCursor: rows.length > limit && data.at(-1) ? encodeCursor(data.at(-1)!) : null,
      },
    };
  }
  async createManualRecord(id: string, raw: unknown, actor: OperationActor) {
    resourceId(id);
    const input = manualRecordInput(raw);
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const row = await lockVolume(tx, id);
      if (!sameManualDataIdentity(input.source, manualDataIdentity(row)))
        conflict('MANUAL_RECORD_SOURCE_MISMATCH', '记录的源卷/PVC/集群身份与此记录簿不一致。');
      if (input.target) {
        const target = await requireVolume(tx, input.target.volumeId);
        if (!sameManualDataIdentity(input.target, manualDataIdentity(target)))
          conflict('MANUAL_RECORD_TARGET_MISMATCH', '恢复记录的新目标身份未登记或不匹配。');
        const backup = await tx.auditEvent.findFirst({
          where: {
            action: 'volume.manual_data_record',
            resourceId: id,
            metadata: { path: ['backupId'], equals: input.backupId },
            outcome: 'backup',
          },
        });
        if (!backup)
          conflict('MANUAL_BACKUP_RECORD_REQUIRED', '请先登记该源卷的原备份清单，再记录恢复关系。');
        const manifest = presentManualRecord(backup);
        for (const key of [
          'engine',
          'engineVersion',
          'dataLayout',
          'format',
          'sizeBytes',
          'sha256',
        ] as const)
          if (manifest[key] !== input[key])
            conflict('MANUAL_BACKUP_MANIFEST_MISMATCH', '恢复记录与原备份清单不一致。');
      }
      if (
        input.type === 'backup' &&
        (await tx.auditEvent.count({
          where: {
            action: 'volume.manual_data_record',
            resourceId: id,
            outcome: 'backup',
            metadata: { path: ['backupId'], equals: input.backupId },
          },
        }))
      )
        conflict('MANUAL_BACKUP_RECORD_EXISTS', '此备份 ID 已登记，历史记录不能覆盖。');
      return presentManualRecord(
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            requestId: actor.requestId?.slice(0, 128),
            action: 'volume.manual_data_record',
            resourceType: 'volume',
            resourceId: id,
            outcome: input.type,
            metadata: json(input),
          },
        }),
      );
    });
  }
}
