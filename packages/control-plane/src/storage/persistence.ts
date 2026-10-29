import { randomUUID } from 'node:crypto';
import { Prisma, type Cluster, type Volume } from '@ozz/database';
import type { StorageBindingIdentity, StorageVolumePlan } from '@ozz/infrastructure/storage';
import { kubeConnection, readCredential } from '../infrastructure/persistence.js';
import { SecretCipher } from '../secrets.js';
import { json, type ServiceRecord } from '../services/persistence.js';
import { OperationRequestError, TaskExecutionError, type TaskRef } from '../tasks/contracts.js';
import {
  SERVICE_VOLUME_LIMIT,
  type CreateVolumeInput,
  type VolumeSnapshotReference,
  type VolumeTarget,
} from './contracts.js';
import { environmentNamespaceInventory, reserveEnvironmentNamespace } from './namespace.js';
import { assertDistinctPaths, createVolumeInput, mountPath } from './validation.js';

export const volumeInclude = {
  environment: { include: { project: true } },
  cluster: true,
  mounts: {
    where: { detachedAt: null },
    take: 101,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      service: { select: { id: true, name: true, slug: true, publishedDeploymentId: true } },
    },
  },
  deploymentReferences: {
    where: { deployment: { publishedBy: { isNot: null } } },
    take: 101,
    include: { deployment: { select: { id: true, serviceId: true } } },
  },
  activeMutation: { include: { operation: true, deployment: true } },
  maintenances: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
  database: {
    select: {
      id: true,
      serviceId: true,
      engine: true,
      majorVersion: true,
      initializedAt: true,
      initializationFenceAt: true,
    },
  },
} satisfies Prisma.VolumeInclude;
export type VolumeRecord = Prisma.VolumeGetPayload<{ include: typeof volumeInclude }>;

export function conflict(code: string, message: string): never {
  throw new OperationRequestError(409, code, message);
}
export async function requireVolume(
  db: Prisma.TransactionClient,
  id: string,
): Promise<VolumeRecord> {
  const value = await db.volume.findUnique({ where: { id }, include: volumeInclude });
  if (!value) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '数据卷不存在。');
  return value;
}
export async function lockVolume(tx: Prisma.TransactionClient, id: string): Promise<VolumeRecord> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Volume" WHERE "id" = ${id}::uuid FOR UPDATE`);
  return requireVolume(tx, id);
}
export async function lockVolumes(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
): Promise<VolumeRecord[]> {
  const values: VolumeRecord[] = [];
  for (const id of [...new Set(ids)].sort()) values.push(await lockVolume(tx, id));
  return values;
}
export function volumeTarget(value: Pick<Volume, 'targetJson' | 'id' | 'namespace'>): VolumeTarget {
  const target = value.targetJson as unknown as VolumeTarget;
  if (!target || target.volumeId !== value.id || target.namespace !== value.namespace)
    throw new TaskExecutionError('VOLUME_TARGET_CHANGED', '卷的原始目标记录无效。');
  return target;
}
export async function assertVolumeTarget(
  tx: Prisma.TransactionClient,
  row: VolumeRecord,
  target = volumeTarget(row),
): Promise<void> {
  const state = await tx.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  if (
    !row.environment ||
    !row.cluster ||
    row.destroyedAt ||
    state.installationId !== target.installationId ||
    row.id !== target.volumeId ||
    row.environmentId !== target.environmentId ||
    row.clusterId !== target.clusterId ||
    row.environment.projectId !== target.projectId ||
    row.environment.project.clusterId !== row.clusterId ||
    row.cluster.kubeSystemUid !== target.kubeSystemUid ||
    row.namespace !== target.namespace
  )
    throw new TaskExecutionError(
      'VOLUME_TARGET_CHANGED',
      '卷的原环境或集群身份已变化，不能改投其他目标。',
    );
}
export function requireVolumeIdle(row: VolumeRecord): void {
  if (row.activeMutation)
    conflict('VOLUME_OPERATION_ACTIVE', '该卷有正在执行的任务，请先查看原任务。');
}
export function requireVolumeUsable(row: VolumeRecord): void {
  if (row.destroyedAt || row.deletionIntentJson)
    conflict('VOLUME_DESTROYING', '该卷正在销毁或已经销毁，不能新增挂载或发布。');
  if (row.maintenances.some((item) => item.state !== 'closed'))
    conflict(
      'VOLUME_MAINTENANCE_ACTIVE',
      '该卷处于持久维护状态；任务结束或时间到期不会自动解除维护。',
    );
}
export function requireVolumeRevision(row: Volume, expected: number): void {
  if (row.revision !== expected) conflict('REVISION_CONFLICT', '卷已修改，请刷新后核对。');
}

/** Metadata-only reservation, also used inside the atomic template command. */
export async function reserveVolume(
  tx: Prisma.TransactionClient,
  raw: CreateVolumeInput,
): Promise<Volume> {
  const input = createVolumeInput(raw);
  const environment = await tx.environment.findUnique({
    where: { id: input.environmentId },
    include: { project: { include: { cluster: true } } },
  });
  if (!environment) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '目标环境不存在。');
  const cluster = environment.project.cluster;
  if (
    !cluster.kubeSystemUid ||
    !cluster.caFingerprint ||
    !cluster.apiEndpoint ||
    !cluster.credentialRefId
  )
    conflict('CLUSTER_NOT_CONNECTED', '请先验证项目所属集群的连接。');
  const state = await tx.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  const id = randomUUID();
  const target: VolumeTarget = {
    installationId: state.installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid,
    projectId: environment.projectId,
    environmentId: environment.id,
    namespace: `ozz-e-${environment.id.replaceAll('-', '')}`,
    volumeId: id,
  };
  await reserveEnvironmentNamespace(tx, target);
  return tx.volume.create({
    data: {
      id,
      name: input.name,
      slug: input.slug,
      environmentId: environment.id,
      clusterId: cluster.id,
      targetJson: json(target),
      namespace: target.namespace,
      requestedBytes: BigInt(input.requestedBytes),
      storageClassName: input.storageClassName,
      pvcName: `ozz-v-${id.replaceAll('-', '')}`,
    },
  });
}

type MountService = Pick<ServiceRecord, 'id' | 'name' | 'slug' | 'environmentId'>;
export async function assertMountPermitted(
  tx: Prisma.TransactionClient,
  service: MountService,
  volume: VolumeRecord,
  readOnly: boolean,
): Promise<void> {
  requireVolumeUsable(volume);
  await assertVolumeTarget(tx, volume);
  if (volume.environmentId !== service.environmentId)
    conflict('VOLUME_ENVIRONMENT_MISMATCH', '卷和服务必须属于同一项目、环境和集群。');
  if (volume.database && volume.database.serviceId !== service.id)
    conflict(
      'VOLUME_DATABASE_PROTECTED',
      '数据库数据卷只能由原数据库身份使用，不能作为普通卷接回。',
    );
  if (
    !readOnly &&
    (await tx.volumeMount.count({
      where: {
        volumeId: volume.id,
        detachedAt: null,
        readOnly: false,
        serviceId: { not: service.id },
      },
    }))
  )
    conflict(
      'VOLUME_WRITER_CONFLICT',
      '另一服务仍保留此卷的可写占用；保存卸载草稿不会释放实际占用。',
    );
}
export async function insertInitialVolumeMount(
  tx: Prisma.TransactionClient,
  service: MountService,
  value: Pick<Volume, 'id'>,
  input: { mountPath: string; readOnly: boolean },
) {
  const volume = await lockVolume(tx, value.id);
  requireVolumeIdle(volume);
  await assertMountPermitted(tx, service, volume, input.readOnly);
  const mounts = await tx.volumeMount.findMany({
    where: { serviceId: service.id, detachedAt: null },
    take: SERVICE_VOLUME_LIMIT + 1,
  });
  if (mounts.length >= SERVICE_VOLUME_LIMIT)
    conflict('VOLUME_MOUNT_LIMIT', '一个服务最多保留 8 个活动挂载。');
  assertDistinctPaths([...mounts.map((item) => item.mountPath), input.mountPath]);
  return tx.volumeMount.create({
    data: {
      serviceId: service.id,
      volumeId: volume.id,
      mountPath: mountPath(input.mountPath),
      readOnly: input.readOnly,
      originalServiceJson: json({
        id: service.id,
        name: service.name,
        slug: service.slug,
        environmentId: service.environmentId,
      }),
    },
  });
}

export async function serviceVolumeIds(
  tx: Prisma.TransactionClient,
  serviceId: string,
): Promise<string[]> {
  return (
    await tx.volumeMount.findMany({
      where: { serviceId, detachedAt: null },
      select: { volumeId: true },
    })
  )
    .map((row) => row.volumeId)
    .sort();
}

export async function assertServiceVolumeConfiguration(
  tx: Prisma.TransactionClient,
  serviceId: string,
  configuration: { replicas: number },
): Promise<void> {
  if (
    configuration.replicas !== 1 &&
    (await tx.volumeMount.count({
      where: { serviceId, detachedAt: null, readOnly: false },
    }))
  )
    conflict('VOLUME_SINGLE_WRITER_REQUIRED', '可写本地卷服务必须保持单副本，使用 Recreate 更新。');
}
export async function captureVolumeReferences(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
  snapshotRefs?: readonly VolumeSnapshotReference[],
): Promise<VolumeSnapshotReference[]> {
  const mounts = await tx.volumeMount.findMany({
    where: {
      serviceId: service.id,
      detachedAt: null,
      ...(snapshotRefs ? {} : { desired: true }),
    },
    take: SERVICE_VOLUME_LIMIT + 1,
    orderBy: { id: 'asc' },
  });
  if (mounts.length > SERVICE_VOLUME_LIMIT || (snapshotRefs?.length ?? 0) > SERVICE_VOLUME_LIMIT)
    conflict('VOLUME_MOUNT_LIMIT', '一个服务最多保留 8 个活动挂载。');
  const selected =
    snapshotRefs ?? mounts.map((item) => ({ volumeId: item.volumeId, mountId: item.id }));
  if (new Set(selected.map((item) => item.volumeId)).size !== selected.length)
    conflict('VOLUME_REFERENCE_INVALID', '发布快照重复引用同一卷。');
  const volumes = await lockVolumes(
    tx,
    selected.map((item) => item.volumeId),
  );
  const references: VolumeSnapshotReference[] = [];
  for (const selectedRef of selected) {
    const volume = volumes.find((item) => item.id === selectedRef.volumeId)!;
    const mount = mounts.find(
      (item) => item.id === selectedRef.mountId && item.volumeId === volume.id,
    );
    if (!mount) conflict('VOLUME_REFERENCE_DETACHED', '原发布引用已解除，不能把它解释为当前卷。');
    await assertMountPermitted(tx, service, volume, mount.readOnly);
    const ref: VolumeSnapshotReference = {
      volumeId: volume.id,
      mountId: mount.id,
      volumeRevision: volume.revision,
      target: volumeTarget(volume),
      pvcName: volume.pvcName,
      pvcUid: volume.pvcUid,
      creationNonce: volume.creationNonce,
      storageClassName: volume.storageClassName,
      storageClassUid: volume.storageClassUid,
      requestedBytes: volume.requestedBytes.toString(),
      mountPath: mount.mountPath,
      readOnly: mount.readOnly,
    };
    if (snapshotRefs) {
      const original = selectedRef as VolumeSnapshotReference;
      assertVolumeReference(volume, original);
      if (original.mountPath !== mount.mountPath || original.readOnly !== mount.readOnly)
        conflict('VOLUME_REFERENCE_CHANGED', '原快照的挂载方式已变化，请核对后重新发布。');
      references.push(original);
    } else references.push(ref);
  }
  assertDistinctPaths(references.map((item) => item.mountPath));
  return references;
}
export function assertVolumeReference(
  volume: VolumeRecord,
  ref: VolumeSnapshotReference,
  allowMaintenance = false,
): void {
  if (
    ref.volumeId !== volume.id ||
    ref.pvcName !== volume.pvcName ||
    ref.creationNonce !== volume.creationNonce ||
    ref.requestedBytes !== volume.requestedBytes.toString() ||
    ref.storageClassName !== volume.storageClassName ||
    (ref.pvcUid !== null && ref.pvcUid !== volume.pvcUid) ||
    (ref.storageClassUid !== null && ref.storageClassUid !== volume.storageClassUid) ||
    Object.entries(volumeTarget(volume)).some(
      ([key, value]) => ref.target[key as keyof VolumeTarget] !== value,
    )
  )
    conflict('VOLUME_REFERENCE_CHANGED', '原发布引用的 PVC 或存储身份发生变化。');
  if (!allowMaintenance) requireVolumeUsable(volume);
}
/** Lock both the next snapshot and pending detachments; the task owns all of them until terminal. */
export async function admitVolumeMutation(
  tx: Prisma.TransactionClient,
  refs: readonly VolumeSnapshotReference[],
  task: TaskRef,
): Promise<void> {
  const taskRow =
    task.type === 'deployment'
      ? await tx.deployment.findUniqueOrThrow({
          where: { id: task.id },
          select: { serviceId: true, kind: true },
        })
      : await tx.operation.findUniqueOrThrow({
          where: { id: task.id },
          select: { serviceId: true, kind: true },
        });
  const ids = [
    ...refs.map((item) => item.volumeId),
    ...(taskRow.serviceId ? await serviceVolumeIds(tx, taskRow.serviceId) : []),
  ];
  const volumes = await lockVolumes(tx, ids);
  const draining =
    task.type === 'operation' && ['service_stop', 'service_delete'].includes(taskRow.kind);
  for (const volume of volumes) {
    requireVolumeIdle(volume);
    if (!draining) requireVolumeUsable(volume);
    await assertVolumeTarget(tx, volume);
    const ref = refs.find((item) => item.volumeId === volume.id);
    if (ref) assertVolumeReference(volume, ref, draining);
    await tx.volume.update({
      where: { id: volume.id },
      data: {
        mutationRevision: { increment: 1 },
        observationLeaseToken: null,
        observationLeaseExpiresAt: null,
      },
    });
    await tx.volumeMutation.create({
      data: {
        volumeId: volume.id,
        ...(task.type === 'deployment' ? { deploymentId: task.id } : { operationId: task.id }),
      },
    });
  }
  if (task.type === 'deployment')
    for (const ref of refs)
      await tx.deploymentVolumeReference.create({
        data: {
          deploymentId: task.id,
          volumeId: ref.volumeId,
          referenceJson: json(ref),
        },
      });
}

export interface StorageCredentialFence {
  connectionRevision: number;
  credentialRefId: string;
  credentialRevision: number;
  keyVersion: number;
}
export async function readStorageAccess(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  cluster: Cluster,
  target: Pick<VolumeTarget, 'clusterId' | 'kubeSystemUid'>,
) {
  if (
    cluster.id !== target.clusterId ||
    cluster.kubeSystemUid !== target.kubeSystemUid ||
    !cluster.apiEndpoint ||
    !cluster.caFingerprint ||
    !cluster.credentialRefId
  )
    throw new TaskExecutionError('VOLUME_TARGET_CHANGED', '原存储集群身份或已验证连接不可用。');
  const credential = await readCredential(tx, cipher, cluster.credentialRefId, 'kubeconfig');
  const connection = kubeConnection(credential.payload, cluster.apiEndpoint);
  if (connection.caFingerprint !== cluster.caFingerprint)
    throw new TaskExecutionError(
      'VOLUME_CREDENTIAL_CHANGED',
      '当前凭证 CA 与已验证的存储集群不匹配。',
    );
  return {
    connection,
    caFingerprint: cluster.caFingerprint,
    credential: {
      connectionRevision: cluster.connectionRevision,
      credentialRefId: credential.id,
      credentialRevision: credential.revision,
      keyVersion: credential.keyVersion,
    } satisfies StorageCredentialFence,
  };
}
export async function assertStorageCredential(
  tx: Prisma.TransactionClient,
  cluster: Cluster,
  fence: StorageCredentialFence,
): Promise<void> {
  const secret = await tx.secretReference.findUnique({
    where: { id: fence.credentialRefId },
    select: { kind: true, revision: true, keyVersion: true, expiresAt: true },
  });
  if (
    !secret ||
    secret.kind !== 'kubeconfig' ||
    cluster.credentialRefId !== fence.credentialRefId ||
    cluster.connectionRevision !== fence.connectionRevision ||
    secret.revision !== fence.credentialRevision ||
    secret.keyVersion !== fence.keyVersion ||
    (secret.expiresAt && secret.expiresAt <= new Date())
  )
    throw new TaskExecutionError(
      'VOLUME_CREDENTIAL_CHANGED',
      '任务期间管理凭证已变化；后续写入停止，重试会读取当前凭证。',
      true,
    );
}
export function knownBinding(volume: Pick<Volume, 'receiptJson'>): StorageBindingIdentity | null {
  const binding = (volume.receiptJson as { binding?: StorageBindingIdentity | null } | null)
    ?.binding;
  return binding ?? null;
}
export async function volumePlan(
  tx: Prisma.TransactionClient,
  volume: VolumeRecord,
  caFingerprint: string,
  reserveNamespace = false,
): Promise<StorageVolumePlan> {
  const target = volumeTarget(volume);
  const namespace = reserveNamespace
    ? await reserveEnvironmentNamespace(tx, target)
    : await environmentNamespaceInventory(tx, target);
  if (!namespace)
    throw new TaskExecutionError(
      'VOLUME_NAMESPACE_UNREGISTERED',
      '该卷的环境 Namespace 尚未登记。',
    );
  return {
    target: { ...target, caFingerprint },
    mutationRevision: volume.mutationRevision,
    requestedBytes: Number(volume.requestedBytes),
    storageClassName: volume.storageClassName,
    storageClassUid: volume.storageClassUid,
    namespace,
    knownBinding: knownBinding(volume),
    claim: {
      name: volume.pvcName,
      namespace: volume.namespace,
      creationNonce: volume.creationNonce,
      creationAttempted: volume.creationAttempted,
      uid: volume.pvcUid,
      resourceVersion: volume.resourceVersion,
      mutationRevision:
        (volume.receiptJson as { creationMutationRevision?: number } | null)
          ?.creationMutationRevision ?? 0,
      ledgerVersion: volume.ledgerVersion,
      specFingerprint: volume.specFingerprint,
    },
  };
}
