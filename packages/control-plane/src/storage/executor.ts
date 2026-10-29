import type { Prisma } from '@ozz/database';
import {
  KubernetesStorageAdapter,
  StorageAdapterError,
  type KubernetesStorageManager,
  type StorageVolumeObservation,
  type StorageWriteHooks,
} from '@ozz/infrastructure/storage';
import { infrastructureFailure } from '../infrastructure/executor.js';
import { ControlPlaneReadOnlyError } from '../recovery.js';
import { SecretCipher } from '../secrets.js';
import type { ServiceTarget } from '../services/contracts.js';
import { json, lockService } from '../services/persistence.js';
import { TaskExecutionError } from '../tasks/contracts.js';
import {
  TaskRepository,
  type ExecutionLease,
  type TaskLease,
  type TaskOutcome,
} from '../tasks/repository.js';
import {
  parseVolumeOperationInput,
  volumeOperationKinds,
  type PreparedVolumeBindings,
  type VolumeOperationInput,
  type VolumeSnapshotReference,
} from './contracts.js';
import {
  beforeStorageWrite,
  protectVolumeData,
  saveStorageReceipt,
  saveVolumeObservation,
  type StorageDataProtection,
} from './ledger.js';
import { beforeNamespaceWrite, saveNamespaceReceipt } from './namespace.js';
import {
  assertStorageCredential,
  assertVolumeReference,
  assertVolumeTarget,
  conflict,
  lockVolume,
  readStorageAccess,
  requireVolumeUsable,
  volumePlan,
  volumeTarget,
  type StorageCredentialFence,
  type VolumeRecord,
} from './persistence.js';
import { deletionBlockers } from './views.js';

export function storageFailure(error: unknown): TaskExecutionError {
  if (error instanceof TaskExecutionError) return error;
  if (error instanceof ControlPlaneReadOnlyError)
    return new TaskExecutionError(
      'VOLUME_TASK_FENCE_LOST',
      '控制面正在恢复核对，原存储任务停止执行。',
    );
  if (error instanceof StorageAdapterError)
    return new TaskExecutionError(error.code, error.message, error.retryable);
  return infrastructureFailure(error);
}
export function isStorageOperation(kind: string): boolean {
  return (volumeOperationKinds as readonly string[]).includes(kind);
}

async function serviceUnmountConfirmed(
  tx: Prisma.TransactionClient,
  target: ServiceTarget,
  observation: StorageVolumeObservation,
): Promise<boolean> {
  if (observation.mountsTruncated || !['ready', 'pending'].includes(observation.state))
    return false;
  if (!observation.mounts.length) return true;
  // The adapter proves Pod ancestry. A label alone never permits releasing occupancy.
  if (
    observation.mounts.some(
      (mount) =>
        mount.namespace !== target.namespace ||
        !mount.serviceId ||
        mount.serviceId === target.serviceId ||
        !mount.controller ||
        !['Deployment', 'StatefulSet'].includes(mount.controller.kind),
    )
  )
    return false;
  const resources = await tx.managedResource.findMany({
    where: {
      clusterId: target.clusterId,
      environmentId: target.environmentId,
      namespace: target.namespace,
      serviceId: { in: observation.mounts.map((mount) => mount.serviceId!) },
      kind: { in: ['Deployment', 'StatefulSet'] },
      uid: { not: null },
      deletedAt: null,
    },
    select: { serviceId: true, kind: true, name: true, uid: true, targetJson: true },
  });
  const targetFields = [
    'installationId',
    'clusterId',
    'kubeSystemUid',
    'projectId',
    'environmentId',
    'namespace',
  ] as const;
  return observation.mounts.every((mount) =>
    resources.some((resource) => {
      const stored = resource.targetJson as Partial<ServiceTarget> | null;
      return (
        resource.serviceId === mount.serviceId &&
        resource.kind === mount.controller!.kind &&
        resource.name === mount.controller!.name &&
        resource.uid === mount.controller!.uid &&
        stored?.serviceId === resource.serviceId &&
        targetFields.every((field) => stored[field] === target[field])
      );
    }),
  );
}

/** Owns PVC writes and data occupancy; the service engine only receives verified bindings. */
export class StorageExecutor {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly manager: KubernetesStorageManager = new KubernetesStorageAdapter(),
    private readonly protection: StorageDataProtection = {},
  ) {}
  private checkSignal(signal: AbortSignal): void {
    if (signal.aborted)
      throw new TaskExecutionError('VOLUME_TASK_FENCE_LOST', '存储任务已取消或租约失效。');
  }
  private async checkpoint<T>(
    lease: ExecutionLease,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let result: T | undefined;
    if (
      !(await this.repository.checkpoint(lease, async (tx) => {
        result = await work(tx);
      }))
    )
      throw new TaskExecutionError(
        'VOLUME_TASK_FENCE_LOST',
        '存储任务租约或恢复代次已变化，后续写入停止。',
      );
    return result as T;
  }
  private async withVolume<T>(
    lease: ExecutionLease,
    volumeId: string,
    signal: AbortSignal,
    work: (tx: Prisma.TransactionClient, row: VolumeRecord) => Promise<T>,
    credential?: StorageCredentialFence,
  ): Promise<T> {
    this.checkSignal(signal);
    return this.checkpoint(lease, async (tx) => {
      if (lease.serviceId) await lockService(tx, lease.serviceId);
      const row = await lockVolume(tx, volumeId);
      await assertVolumeTarget(tx, row);
      const slot = row.activeMutation;
      if (
        !slot ||
        (lease.ref.type === 'deployment'
          ? slot.deploymentId !== lease.ref.id
          : slot.operationId !== lease.ref.id)
      )
        throw new TaskExecutionError('VOLUME_TASK_FENCE_LOST', '原任务不再持有此卷的变更槽。');
      if (lease.ref.type === 'operation' && isStorageOperation(lease.kind)) {
        const input = parseVolumeOperationInput(lease.input);
        if (
          input.volumeId !== row.id ||
          input.volumeRevision !== row.revision ||
          input.mutationRevision !== row.mutationRevision
        )
          throw new TaskExecutionError('VOLUME_TASK_FENCE_LOST', '卷版本或任务固定目标已变化。');
        await assertVolumeTarget(tx, row, input.target);
      }
      if (credential) await assertStorageCredential(tx, row.cluster!, credential);
      this.checkSignal(signal);
      return work(tx, row);
    });
  }
  private async access(
    lease: ExecutionLease,
    volumeId: string,
    signal: AbortSignal,
    writable: boolean,
  ) {
    return this.withVolume(lease, volumeId, signal, async (tx, row) => {
      if (writable) requireVolumeUsable(row);
      const access = await readStorageAccess(tx, this.cipher, row.cluster!, volumeTarget(row));
      return { row, access, plan: await volumePlan(tx, row, access.caFingerprint) };
    });
  }
  private hooks(
    lease: ExecutionLease,
    context: Awaited<ReturnType<StorageExecutor['access']>>,
    signal: AbortSignal,
  ): StorageWriteHooks {
    let version = context.plan.claim.ledgerVersion;
    const run = <T>(work: (tx: Prisma.TransactionClient, row: VolumeRecord) => Promise<T>) =>
      this.withVolume(lease, context.row.id, signal, work, context.access.credential);
    return {
      signal,
      checkpoint: () => run(async () => {}),
      beforeWrite: async (intent) => {
        version = await run(async (tx, row) => {
          if (intent.action === 'delete') this.requireDestroyIntent(row, lease);
          else if (lease.ref.type === 'deployment' || !isStorageOperation(lease.kind))
            requireVolumeUsable(row);
          return beforeStorageWrite(tx, row.id, intent, version, this.protection);
        });
      },
      onReceipt: async (receipt) => {
        version = await run((tx, row) =>
          saveStorageReceipt(tx, row.id, receipt, version, this.protection),
        );
      },
      namespace: {
        signal,
        beforeWrite: (intent) => run((tx) => beforeNamespaceWrite(tx, context.plan.target, intent)),
        onReceipt: (receipt) => run((tx) => saveNamespaceReceipt(tx, context.plan.target, receipt)),
      },
    };
  }
  private requireDestroyIntent(row: VolumeRecord, lease: ExecutionLease): void {
    if (lease.ref.type !== 'operation' || lease.kind !== 'volume_destroy')
      throw new TaskExecutionError(
        'VOLUME_DESTROY_INTENT_REQUIRED',
        '只有明确受理的卷销毁任务可以删除 PVC。',
      );
    const input = parseVolumeOperationInput(lease.input);
    const confirmation = input.confirmation;
    const stored = row.deletionIntentJson as unknown as VolumeOperationInput['confirmation'];
    if (
      !confirmation ||
      !stored ||
      confirmation.previewDigest !== stored.previewDigest ||
      confirmation.volumeId !== row.id ||
      confirmation.pvcUid !== row.pvcUid ||
      confirmation.volumeName !== row.name
    )
      throw new TaskExecutionError(
        'VOLUME_DELETE_CONFIRMATION_CHANGED',
        '原销毁确认与当前数据身份不一致。',
      );
    const blockers = deletionBlockers({ ...row, activeMutation: null });
    if (blockers.length) throw new TaskExecutionError(blockers[0]!.code, blockers[0]!.message);
  }
  async execute(lease: TaskLease, signal: AbortSignal): Promise<TaskOutcome> {
    try {
      if (!isStorageOperation(lease.kind))
        throw new TaskExecutionError('INVALID_OPERATION_INPUT', '此任务不属于存储操作。');
      const input = parseVolumeOperationInput(lease.input);
      let context = await this.access(
        lease,
        input.volumeId,
        signal,
        lease.kind === 'volume_create',
      );
      const maintenance = context.row.maintenances.find((row) => row.id === input.maintenanceId);
      if (
        (lease.kind === 'volume_maintenance_enter' && maintenance?.state === 'active') ||
        (lease.kind === 'volume_maintenance_exit' && maintenance?.state === 'closed')
      )
        return {
          result: {
            volumeId: input.volumeId,
            maintenanceId: maintenance.id,
            state: maintenance.state,
          },
        };
      if (
        lease.kind === 'volume_maintenance_exit' &&
        !context.row.creationAttempted &&
        !context.row.pvcUid
      ) {
        await this.withVolume(lease, input.volumeId, signal, async (tx, row) => {
          const current = row.maintenances.find(
            (value) => value.id === input.maintenanceId && value.state !== 'closed',
          );
          if (!current)
            throw new TaskExecutionError('VOLUME_MAINTENANCE_CHANGED', '原维护记录已变化。');
          await tx.volumeMaintenance.update({
            where: { id: current.id },
            data: {
              state: 'closed',
              exitedAt: new Date(),
              revision: { increment: 1 },
              lastErrorCode: null,
            },
          });
        });
        return {
          result: {
            volumeId: input.volumeId,
            maintenanceId: input.maintenanceId!,
            state: 'closed',
            neverCreated: true,
          },
        };
      }
      let observation: StorageVolumeObservation;
      if (lease.kind === 'volume_create') {
        if (
          !(await this.repository.progress(
            lease,
            '核验固定存储目标并创建 PVC；等待首个消费者的卷可保持 Pending。',
          ))
        )
          throw new TaskExecutionError('VOLUME_TASK_FENCE_LOST', '存储任务已停止。');
        observation = (
          await this.manager.create(
            context.access.connection,
            context.plan,
            this.hooks(lease, context, signal),
          )
        ).observation;
      } else if (lease.kind === 'volume_destroy') {
        if (!context.row.creationAttempted && !context.row.pvcUid) {
          this.requireDestroyIntent(context.row, lease);
          return {
            result: { volumeId: context.row.id, state: 'destroyed', neverCreated: true },
            commit: async (tx) => {
              await tx.volume.update({
                where: { id: context.row.id },
                data: { destroyedAt: new Date() },
              });
            },
          };
        }
        observation = await this.manager.observe(context.access.connection, context.plan, {
          signal,
        });
        await this.withVolume(
          lease,
          input.volumeId,
          signal,
          async (tx, row) => {
            // Missing PVC after a prior DELETE is reconciled by destroy using its fixed PV identity.
            if (observation.state !== 'missing') await saveVolumeObservation(tx, row, observation);
          },
          context.access.credential,
        );
        context = await this.access(lease, input.volumeId, signal, false);
        if (observation.state !== 'missing') this.requireDestroyIntent(context.row, lease);
        else if (
          !input.confirmation ||
          input.confirmation.pvcUid !== context.row.pvcUid ||
          context.row.mounts.length ||
          context.row.deploymentReferences.length ||
          context.row.maintenances.some((item) => item.state !== 'closed')
        )
          throw new TaskExecutionError(
            'VOLUME_DELETE_CONFIRMATION_CHANGED',
            '不能确认原销毁意图与当前数据引用一致。',
          );
        observation = (
          await this.manager.destroy(
            context.access.connection,
            context.plan,
            this.hooks(lease, context, signal),
          )
        ).observation;
      } else if (lease.kind === 'volume_maintenance_enter' && !context.row.pvcUid) {
        const maintenance = context.row.maintenances.find(
          (item) => item.id === input.maintenanceId && item.state !== 'closed',
        );
        if (!maintenance || maintenance.purpose !== 'restore')
          throw new TaskExecutionError('VOLUME_NOT_CREATED', '备份维护要求原数据卷已经存在。');
        observation = (
          await this.manager.create(
            context.access.connection,
            context.plan,
            this.hooks(lease, context, signal),
          )
        ).observation;
      } else
        observation = await this.manager.observe(context.access.connection, context.plan, {
          signal,
        });

      await this.withVolume(
        lease,
        input.volumeId,
        signal,
        async (tx, row) => {
          if (lease.kind === 'volume_sync' && observation.verifiedReceipt && row.creationAttempted)
            await saveStorageReceipt(
              tx,
              row.id,
              observation.verifiedReceipt,
              row.ledgerVersion,
              this.protection,
            );
          await saveVolumeObservation(tx, await lockVolume(tx, row.id), observation);
        },
        context.access.credential,
      );
      if (lease.kind.startsWith('volume_maintenance_')) {
        const entering = lease.kind === 'volume_maintenance_enter';
        await this.withVolume(
          lease,
          input.volumeId,
          signal,
          async (tx, row) => {
            const maintenance = row.maintenances.find(
              (item) => item.id === input.maintenanceId && item.state !== 'closed',
            );
            if (!maintenance)
              throw new TaskExecutionError('VOLUME_MAINTENANCE_CHANGED', '原维护记录已变化。');
            if (
              observation.mountsTruncated ||
              observation.mounts.length ||
              !['ready', 'pending'].includes(observation.state)
            )
              throw new TaskExecutionError(
                'VOLUME_MAINTENANCE_NOT_QUIESCENT',
                '维护要求实际 PVC 身份完整、所有业务和维护 Pod 已退出；观察未知不能视为停写完成。',
              );
            await tx.volumeMaintenance.update({
              where: { id: maintenance.id },
              data: entering
                ? {
                    state: 'active',
                    enteredAt: maintenance.enteredAt ?? new Date(),
                    revision: { increment: 1 },
                    lastErrorCode: null,
                  }
                : {
                    state: 'closed',
                    exitedAt: new Date(),
                    revision: { increment: 1 },
                    lastErrorCode: null,
                  },
            });
          },
          context.access.credential,
        );
      }
      return {
        result: {
          volumeId: input.volumeId,
          state: observation.state,
          observedAt: observation.observedAt,
          ...(input.maintenanceId ? { maintenanceId: input.maintenanceId } : {}),
        },
        ...(lease.kind === 'volume_destroy'
          ? {
              commit: async (tx: Prisma.TransactionClient) => {
                await tx.volume.update({
                  where: { id: input.volumeId },
                  data: {
                    destroyedAt: new Date(),
                    observationErrorCode: null,
                    lastErrorCode: null,
                    lastErrorMessage: null,
                  },
                });
              },
            }
          : {}),
      };
    } catch (error) {
      throw storageFailure(error);
    }
  }
  async failed(
    lease: TaskLease,
    tx: Prisma.TransactionClient,
    code: string,
    message: string,
  ): Promise<void> {
    if (!isStorageOperation(lease.kind)) return;
    const input = parseVolumeOperationInput(lease.input);
    await tx.volume.updateMany({
      where: { id: input.volumeId, mutationRevision: input.mutationRevision },
      data: {
        observationErrorCode: code,
        lastErrorCode: code,
        lastErrorMessage: message,
        nextObservationAt: new Date(),
      },
    });
    if (input.maintenanceId)
      await tx.volumeMaintenance.updateMany({
        where: { id: input.maintenanceId, volumeId: input.volumeId, state: { not: 'closed' } },
        data: { state: 'failed', lastErrorCode: code, revision: { increment: 1 } },
      });
  }

  async prepareForWorkload(
    lease: ExecutionLease,
    target: ServiceTarget,
    refs: readonly VolumeSnapshotReference[],
    signal: AbortSignal,
  ): Promise<PreparedVolumeBindings> {
    try {
      if (!refs.length) return [];
      const prepared: Awaited<ReturnType<StorageExecutor['access']>>[] = [];
      for (const ref of [...refs].sort((a, b) => a.volumeId.localeCompare(b.volumeId))) {
        let context = await this.access(lease, ref.volumeId, signal, true);
        await this.withVolume(
          lease,
          ref.volumeId,
          signal,
          async (tx, row) => {
            assertVolumeReference(row, ref);
            if (
              row.environmentId !== target.environmentId ||
              row.clusterId !== target.clusterId ||
              volumeTarget(row).kubeSystemUid !== target.kubeSystemUid ||
              lease.serviceId !== target.serviceId
            )
              conflict('VOLUME_TARGET_MISMATCH', '卷与固定服务目标不属于同一环境和集群。');
            await protectVolumeData(tx, row, this.protection);
          },
          context.access.credential,
        );
        const result = await this.manager.create(
          context.access.connection,
          context.plan,
          this.hooks(lease, context, signal),
        );
        await this.withVolume(
          lease,
          ref.volumeId,
          signal,
          (tx, row) => saveVolumeObservation(tx, row, result.observation),
          context.access.credential,
        );
        context = await this.access(lease, ref.volumeId, signal, true);
        prepared.push(context);
      }
      const first = prepared[0]!;
      const bindings = await this.manager.prepareBindings(
        first.access.connection,
        { ...target, caFingerprint: first.access.caFingerprint },
        prepared.map((context) => {
          const ref = refs.find((item) => item.volumeId === context.row.id)!;
          return { plan: context.plan, path: ref.mountPath, readOnly: ref.readOnly };
        }),
        { signal },
      );
      for (const binding of bindings) {
        const context = prepared.find((item) => item.row.id === binding.volumeId)!;
        await this.withVolume(
          lease,
          binding.volumeId,
          signal,
          async (tx, row) => {
            const ref = refs.find((item) => item.volumeId === row.id)!;
            assertVolumeReference(row, ref);
            await protectVolumeData(tx, row, this.protection, binding.claimUid);
            if (row.pvcUid !== binding.claimUid || row.storageClassUid !== binding.storageClassUid)
              throw new TaskExecutionError('VOLUME_REFERENCE_CHANGED', '准备期间卷身份已经变化。');
            const snapshotId =
              lease.ref.type === 'deployment'
                ? lease.ref.id
                : (lease.input as { snapshotId?: string }).snapshotId;
            if (snapshotId) {
              const stored = await tx.deploymentVolumeReference.findUnique({
                where: { deploymentId_volumeId: { deploymentId: snapshotId, volumeId: row.id } },
              });
              if (!stored)
                throw new TaskExecutionError('VOLUME_REFERENCE_MISSING', '发布缺少持久卷引用。');
              const resolved = stored.resolutionJson as {
                claimUid?: string;
                storageClassUid?: string;
              } | null;
              if (
                resolved &&
                (resolved.claimUid !== binding.claimUid ||
                  resolved.storageClassUid !== binding.storageClassUid)
              )
                throw new TaskExecutionError(
                  'VOLUME_REFERENCE_CHANGED',
                  '原发布解析的存储身份不可替换。',
                );
              if (!resolved)
                await tx.deploymentVolumeReference.update({
                  where: { deploymentId_volumeId: { deploymentId: snapshotId, volumeId: row.id } },
                  data: { resolutionJson: json(binding) },
                });
            }
          },
          context.access.credential,
        );
      }
      return bindings;
    } catch (error) {
      throw storageFailure(error);
    }
  }

  /** Called after the workload adapter has confirmed the applied rollout or complete deletion. */
  async afterWorkload(
    lease: ExecutionLease,
    target: ServiceTarget,
    refs: readonly VolumeSnapshotReference[],
    options: { deleted?: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const slots = await this.repository.db.volumeMutation.findMany({
        where:
          lease.ref.type === 'deployment'
            ? { deploymentId: lease.ref.id }
            : { operationId: lease.ref.id },
        select: { volumeId: true },
      });
      for (const { volumeId } of slots.sort((a, b) => a.volumeId.localeCompare(b.volumeId))) {
        const context = await this.access(lease, volumeId, signal, false);
        if (!context.row.creationAttempted && !context.row.pvcUid) {
          await this.withVolume(lease, volumeId, signal, async (tx) => {
            await tx.volumeMount.updateMany({
              where: {
                serviceId: target.serviceId,
                volumeId,
                detachedAt: null,
                ...(options.deleted ? {} : { desired: false }),
              },
              data: { desired: false, detachedAt: new Date() },
            });
          });
          continue;
        }
        const observation = await this.manager.observe(context.access.connection, context.plan, {
          signal,
        });
        await this.withVolume(
          lease,
          volumeId,
          signal,
          async (tx, row) => {
            await saveVolumeObservation(tx, row, observation);
            const ref = refs.find((item) => item.volumeId === volumeId);
            const mounts = await tx.volumeMount.findMany({
              where: { serviceId: target.serviceId, volumeId, detachedAt: null },
            });
            for (const mount of mounts) {
              if (options.deleted || (!ref && !mount.desired)) {
                if (!(await serviceUnmountConfirmed(tx, target, observation)))
                  throw new TaskExecutionError(
                    'VOLUME_DETACH_UNCONFIRMED',
                    '当前服务仍占用卷，或其他 Pod 的归属与观察无法确认，保留原挂载占用。',
                  );
                await tx.volumeMount.update({
                  where: { id: mount.id },
                  data: { desired: false, detachedAt: new Date() },
                });
              } else if (ref && lease.ref.type === 'deployment')
                await tx.volumeMount.update({
                  where: { id: mount.id },
                  data: { lastPublishedDeploymentId: lease.ref.id },
                });
            }
          },
          context.access.credential,
        );
      }
    } catch (error) {
      throw storageFailure(error);
    }
  }
}
