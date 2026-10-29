import { BuilderError } from '@ozz/infrastructure/build';
import { fixedRegistryAccess } from '../builds/access.js';
import type { BuildCoordinator } from '../builds/coordinator.js';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@ozz/database';
import {
  KubernetesAdapter,
  KubernetesAdapterError,
  type KubernetesConnectionInspector,
} from '@ozz/infrastructure/kubernetes';
import {
  RegistryAdapter,
  RegistryAdapterError,
  registryDockerConfigJson,
  type RegistryImageResolver,
  type ResolvedImage,
} from '@ozz/infrastructure/registry';
import {
  KubernetesWorkloadAdapter,
  WorkloadAdapterError,
  workloadNames,
  type KubernetesWorkloadManager,
  type ManagedWorkloadResource,
  type WorkloadObservation,
  type WorkloadResourceReceipt,
  type WorkloadWriteHooks,
} from '@ozz/infrastructure/workload';
import { StorageAdapterError } from '@ozz/infrastructure/storage';
import { infrastructureFailure } from '../infrastructure/executor.js';
import { SecretCipher } from '../secrets.js';
import {
  OperationRequestError,
  TaskExecutionError,
  type ServiceOperationInput,
} from '../tasks/contracts.js';
import {
  TaskRepository,
  type DeploymentLease,
  type ExecutionLease,
  type TaskLease,
  type TaskOutcome,
} from '../tasks/repository.js';
import {
  SERVICE_OBSERVATION_INTERVAL_MS,
  type DeploymentResult,
  type ServiceAction,
  type ServiceSnapshot,
  type ServiceTarget,
} from './contracts.js';
import { workloadFailureObservation } from './diagnostics.js';
import {
  readServiceSnapshot,
  snapshotVolumes,
  snapshotController,
  snapshotDatabaseBindings,
} from './snapshots.js';
import { assertDatabaseSnapshot } from '../databases/protection.js';
import {
  augmentDatabaseRuntime,
  assertDatabaseConfiguration,
  saveDatabaseVerification,
} from '../databases/runtime.js';
import {
  assertDatabaseBindingSnapshots,
  assertDatabaseHasNoConsumers,
} from '../databases/persistence.js';
import type { StorageExecutor } from '../storage/executor.js';
import { captureVolumeReferences } from '../storage/persistence.js';
import {
  reserveEnvironmentNamespace,
  beforeNamespaceWrite,
  saveNamespaceReceipt,
} from '../storage/namespace.js';
import {
  assertServiceTarget,
  inventory,
  json,
  kubeAccess,
  lockService,
  registryAccess,
  runtimeConfiguration,
  type ServiceRecord,
} from './persistence.js';

const failureMessages: Record<string, string> = {
  WORKLOAD_OWNERSHIP_MISMATCH: '发现同名但不属于当前服务的资源，已停止写入。',
  WORKLOAD_RESOURCE_CONFLICT: '远端资源版本发生竞争，请核对当前状态后重试。',
  WORKLOAD_RESOURCE_MISSING: '已登记的远端资源不存在，请确认差异后完整重新发布。',
  WORKLOAD_REVISION_AHEAD: '集群中的版本比当前任务更新，不能由旧任务覆盖。',
  WORKLOAD_CONFIGURATION_DRIFT: '实际配置与已发布记录不一致，请核对差异。',
  WORKLOAD_ROLLOUT_TIMEOUT: '健康等待超时，已应用的配置保留，请查看 Pod 与探针状态。',
  WORKLOAD_ROLLOUT_FAILED: '新版本未能完成健康发布，请查看 Pod 与失败事件。',
  WORKLOAD_OPERATION_TIMEOUT: '远端操作超时，已发生的变更保留，请检查资源状态后重试。',
  WORKLOAD_CALLBACK_FAILED: '任务检查或资源回执未能完成，后续写入已停止。',
};

export function serviceFailure(error: unknown): TaskExecutionError {
  if (error instanceof TaskExecutionError) return error;
  if (error instanceof OperationRequestError)
    return new TaskExecutionError(error.code, error.message);
  if (error instanceof BuilderError)
    return new TaskExecutionError(
      error.code,
      '构建或产物核对未完成，请查看对应阶段与记录。',
      error.retryable,
    );
  if (error instanceof RegistryAdapterError)
    return new TaskExecutionError(error.code, error.message, error.retryable);
  if (error instanceof StorageAdapterError)
    return new TaskExecutionError(error.code, error.message, error.retryable);
  if (error instanceof WorkloadAdapterError)
    return new TaskExecutionError(
      error.code,
      failureMessages[error.code] ?? '工作负载操作未完成，请根据错误码检查集群、权限或配置。',
      error.retryable,
    );
  if (error instanceof KubernetesAdapterError)
    return new TaskExecutionError(error.code, error.message, error.retryable);
  return infrastructureFailure(error);
}

function taskId(lease: ExecutionLease): string {
  return lease.ref.id;
}
function serviceId(lease: ExecutionLease): string {
  if (!lease.serviceId)
    throw new TaskExecutionError('SERVICE_TARGET_CHANGED', '原服务不存在，任务不能重新选择目标。');
  return lease.serviceId;
}
function mutationRevision(lease: ExecutionLease): number {
  return (lease.input as { mutationRevision: number }).mutationRevision;
}
function selectedInventory(
  values: ManagedWorkloadResource[],
  target: Pick<ServiceTarget, 'serviceId' | 'environmentId'>,
  snapshotId: string | null,
  usePullSecret: boolean,
): ManagedWorkloadResource[] {
  const names = workloadNames(target, snapshotId ?? undefined);
  return values.filter(
    (value) =>
      value.kind !== 'Secret' ||
      value.name === names.runtimeSecret ||
      (usePullSecret && value.name === names.pullSecret),
  );
}

/** One executor dispatches immutable publication and runtime intents through the same task fences. */
export class ServiceExecutor {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly registry: RegistryImageResolver = new RegistryAdapter(),
    private readonly workloads: KubernetesWorkloadManager = new KubernetesWorkloadAdapter({
      rolloutTimeoutMs: 900_000,
    }),
    private readonly kubernetes: KubernetesConnectionInspector = new KubernetesAdapter(),
    private readonly networking?: {
      beforeServiceDelete(lease: TaskLease, signal: AbortSignal): Promise<void>;
    },
    private readonly storage?: Pick<StorageExecutor, 'prepareForWorkload' | 'afterWorkload'>,
    private readonly builds?: Pick<BuildCoordinator, 'ensureArtifact'>,
  ) {}

  async execute(lease: ExecutionLease, signal: AbortSignal): Promise<TaskOutcome> {
    try {
      if ('deploymentId' in lease) return await this.deploy(lease, signal);
      return await this.operate(lease, signal);
    } catch (error) {
      if (error instanceof WorkloadAdapterError && error.observation) {
        try {
          await this.checkpoint(lease, async (tx) => {
            await this.saveObservation(tx, serviceId(lease), error.observation!);
            if ('deploymentId' in lease) {
              const stored = await tx.deployment.findUniqueOrThrow({
                where: { id: lease.deploymentId },
                select: { result: true },
              });
              const prior =
                stored.result && typeof stored.result === 'object' && !Array.isArray(stored.result)
                  ? stored.result
                  : {};
              // A later observer may replace the Service cache; the failed task
              // keeps the bounded evidence from this fenced attempt.
              await tx.deployment.update({
                where: { id: lease.deploymentId },
                data: {
                  result: json({
                    ...prior,
                    failureObservation: workloadFailureObservation(error.observation!, {
                      attempt: lease.attempt,
                      errorCode: error.code,
                      capturedAt: new Date().toISOString(),
                    }),
                  }),
                },
              });
            }
          });
        } catch {
          /* An expired fence cannot publish. */
        }
      }
      throw serviceFailure(error);
    }
  }

  async failed(
    lease: ExecutionLease,
    tx: Prisma.TransactionClient,
    code: string,
    message: string,
  ): Promise<void> {
    if (!lease.serviceId) return;
    await tx.service.updateMany({
      where: { id: lease.serviceId, mutationRevision: mutationRevision(lease) },
      data: {
        lastErrorCode: code,
        lastErrorMessage: message,
        ...(code === 'WORKLOAD_CONFIGURATION_DRIFT' ? { configurationState: 'drifted' } : {}),
      },
    });
  }

  private async checkpoint<T>(
    lease: ExecutionLease,
    work: (tx: Prisma.TransactionClient, service: ServiceRecord) => Promise<T>,
  ): Promise<T> {
    let result: T | undefined;
    const accepted = await this.repository.checkpoint(lease, async (tx) => {
      const service = await lockService(tx, serviceId(lease));
      if (service.mutationRevision !== mutationRevision(lease))
        throw new TaskExecutionError('SERVICE_TASK_SUPERSEDED', '任务已被后续服务变更取代。');
      result = await work(tx, service);
    });
    if (!accepted)
      throw new TaskExecutionError(
        'SERVICE_TASK_FENCE_LOST',
        '任务租约或恢复状态已变化，已停止执行。',
      );
    return result as T;
  }

  private async stage(lease: DeploymentLease, name: string, message: string) {
    await this.checkpoint(lease, async (tx) => {
      await tx.deploymentStage.updateMany({
        where: {
          deploymentId: lease.deploymentId,
          attempt: lease.attempt,
          status: 'running',
          name: { not: name },
        },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
      await tx.deploymentStage.upsert({
        where: {
          deploymentId_attempt_name: {
            deploymentId: lease.deploymentId,
            attempt: lease.attempt,
            name,
          },
        },
        create: {
          deploymentId: lease.deploymentId,
          attempt: lease.attempt,
          name,
          status: 'running',
          startedAt: new Date(),
        },
        update: { status: 'running', startedAt: new Date(), finishedAt: null, errorCode: null },
      });
      await tx.deployment.update({ where: { id: lease.deploymentId }, data: { phase: name } });
    });
    if (!(await this.repository.progress(lease, message)))
      throw new TaskExecutionError('SERVICE_TASK_FENCE_LOST', '任务检查已失效。');
  }

  private async context(
    lease: ExecutionLease,
    target: ServiceTarget,
    needsRegistry: boolean,
    snapshot?: ServiceSnapshot,
  ) {
    return this.checkpoint(lease, async (tx, service) => {
      await assertServiceTarget(tx, service, target);
      const access = await kubeAccess(tx, this.cipher, service.environment.project.cluster, target);
      const registry = needsRegistry
        ? snapshot?.version === 3
          ? await fixedRegistryAccess(tx, this.cipher, snapshot.source.revision.destination)
          : await registryAccess(tx, this.cipher, service.registryCredentialRefId)
        : undefined;
      const references = [
        service.environment.project.cluster.credentialRefId,
        ...(needsRegistry && snapshot?.version !== 3 ? [service.registryCredentialRefId] : []),
      ].filter((id): id is string => Boolean(id));
      const versions = await tx.secretReference.findMany({
        where: { id: { in: references } },
        select: { id: true, kind: true, revision: true, keyVersion: true },
      });
      await tx.auditEvent.create({
        data: {
          action: 'service.task.credentials',
          resourceType: lease.ref.type,
          resourceId: taskId(lease),
          outcome: 'resolved',
          metadata: json({ serviceId: service.id, versions }),
        },
      });
      return { ...access, registry, service };
    });
  }

  private async reserve(
    lease: ExecutionLease,
    target: ServiceTarget,
    snapshotId: string,
    ports: boolean,
    pull: boolean,
    controller: 'Deployment' | 'StatefulSet' = 'Deployment',
  ) {
    await this.checkpoint(lease, async (tx) => {
      const names = workloadNames(target, snapshotId);
      await reserveEnvironmentNamespace(tx, target);
      const resources: Array<{
        kind: ManagedWorkloadResource['kind'];
        name: string;
        namespace: string;
      }> = [
        { kind: 'Secret', name: names.runtimeSecret!, namespace: target.namespace },
        {
          kind: controller,
          name: controller === 'StatefulSet' ? names.statefulSet : names.deployment,
          namespace: target.namespace,
        },
        ...(controller === 'StatefulSet'
          ? [{ kind: 'Service' as const, name: names.headlessService, namespace: target.namespace }]
          : []),
        ...(ports
          ? [{ kind: 'Service' as const, name: names.service, namespace: target.namespace }]
          : []),
        ...(pull
          ? [{ kind: 'Secret' as const, name: names.pullSecret, namespace: target.namespace }]
          : []),
      ];
      for (const value of resources) {
        const unique = { clusterId: target.clusterId, ...value };
        const row = await tx.managedResource.upsert({
          where: { clusterId_kind_namespace_name: unique },
          create: {
            ...unique,
            environmentId: target.environmentId,
            serviceId: value.kind === 'Namespace' ? null : target.serviceId,
            targetJson: json(target),
          },
          update: {},
        });
        const stored = row.targetJson as unknown as ServiceTarget;
        if (
          stored.installationId !== target.installationId ||
          stored.kubeSystemUid !== target.kubeSystemUid ||
          stored.projectId !== target.projectId ||
          stored.environmentId !== target.environmentId ||
          (value.kind !== 'Namespace' && stored.serviceId !== target.serviceId)
        )
          throw new TaskExecutionError('WORKLOAD_OWNERSHIP_MISMATCH', '资源登记的执行目标不匹配。');
        if (row.deletedAt) {
          // A previous task confirmed this exact UID absent before marking deleted.
          await tx.managedResource.update({
            where: { id: row.id },
            data: {
              creationNonce: randomUUID(),
              creationAttempted: false,
              uid: null,
              resourceVersion: null,
              receiptJson: Prisma.DbNull,
              mutationRevision: 0,
              deletedAt: null,
            },
          });
        }
      }
    });
  }

  private hooks(
    lease: ExecutionLease,
    target: ServiceTarget,
    signal: AbortSignal,
    snapshot?: ServiceSnapshot,
  ): WorkloadWriteHooks {
    return {
      signal,
      beforeWrite: (intent) =>
        this.checkpoint(lease, async (tx, service) => {
          await assertServiceTarget(tx, service, target);
          if (
            snapshot &&
            (lease.ref.type === 'deployment' ||
              ['service_resume', 'service_restart'].includes(lease.kind))
          ) {
            await assertDatabaseSnapshot(
              tx,
              service.id,
              snapshot.version === 2 ? snapshot.database : null,
            );
            if (snapshot.version !== 3)
              await assertDatabaseConfiguration(tx, service, snapshot.configuration);
            if (snapshot.version !== 1) {
              await captureVolumeReferences(tx, service, snapshotVolumes(snapshot));
              await assertDatabaseBindingSnapshots(tx, service, snapshotDatabaseBindings(snapshot));
            }
          }
          if (intent.kind === 'Namespace') {
            await beforeNamespaceWrite(tx, target, intent);
            return;
          }
          const row = await tx.managedResource.findUnique({
            where: {
              clusterId_kind_namespace_name: {
                clusterId: target.clusterId,
                kind: intent.kind,
                namespace: intent.namespace ?? '',
                name: intent.name,
              },
            },
          });
          if (!row || row.creationNonce !== intent.creationNonce || row.uid !== intent.expectedUid)
            throw new TaskExecutionError(
              'WORKLOAD_OWNERSHIP_MISMATCH',
              '资源写入凭据已变化，已停止后续操作。',
            );
          if (intent.action === 'create')
            await tx.managedResource.update({
              where: { id: row.id },
              data: { creationAttempted: true },
            });
          await tx.service.update({
            where: { id: service.id },
            data: {
              remoteCreatedAt: service.remoteCreatedAt ?? new Date(),
              ...(['Deployment', 'StatefulSet', 'Service'].includes(intent.kind) &&
              !['partial', 'drifted'].includes(service.configurationState)
                ? { configurationState: 'unknown' }
                : {}),
            },
          });
        }),
      onReceipt: (receipt) => this.checkpoint(lease, (tx) => this.saveReceipt(tx, target, receipt)),
    };
  }

  private async saveReceipt(
    tx: Prisma.TransactionClient,
    target: ServiceTarget,
    receipt: WorkloadResourceReceipt,
  ): Promise<void> {
    if (receipt.kind === 'Namespace') {
      await saveNamespaceReceipt(tx, target, receipt);
      return;
    }
    const row = await tx.managedResource.findUnique({
      where: {
        clusterId_kind_namespace_name: {
          clusterId: target.clusterId,
          kind: receipt.kind,
          namespace: receipt.namespace ?? '',
          name: receipt.name,
        },
      },
    });
    if (!row || row.creationNonce !== receipt.creationNonce || (row.uid && row.uid !== receipt.uid))
      throw new TaskExecutionError('WORKLOAD_OWNERSHIP_MISMATCH', '资源回执与原登记身份不匹配。');
    await tx.managedResource.update({
      where: { id: row.id },
      data: {
        uid: receipt.uid,
        resourceVersion: receipt.resourceVersion,
        mutationRevision: receipt.mutationRevision,
        receiptJson: json(receipt),
        deletedAt: receipt.action === 'deleted' ? new Date(receipt.observedAt) : null,
      },
    });
    if (
      ['created', 'replaced', 'deleted'].includes(receipt.action) &&
      ['Deployment', 'StatefulSet', 'Service'].includes(receipt.kind)
    )
      await tx.service.update({
        where: { id: target.serviceId },
        data: { configurationState: 'partial' },
      });
  }

  private async saveObservation(
    tx: Prisma.TransactionClient,
    id: string,
    observation: WorkloadObservation,
  ): Promise<void> {
    await tx.service.update({
      where: { id },
      data: {
        observationJson: json(observation),
        lastObservedAt: new Date(observation.observedAt),
        lastAttemptAt: new Date(),
        nextObservationAt: new Date(Date.now() + SERVICE_OBSERVATION_INTERVAL_MS),
        observationFailures: 0,
        observationErrorCode: null,
        ...(observation.configurationState === 'drifted' ? { configurationState: 'drifted' } : {}),
      },
    });
  }

  private async repairMissing(
    lease: DeploymentLease,
    target: ServiceTarget,
    access: Awaited<ReturnType<ServiceExecutor['context']>>,
    values: ManagedWorkloadResource[],
    knownInventory: ManagedWorkloadResource[],
    signal: AbortSignal,
  ) {
    const observation = await this.workloads.observe(access.connection, access.target, values, {
      signal,
      knownInventory,
    });
    const missing = observation.resources.filter(
      (resource) => resource.state === 'missing' && resource.expectedUid,
    );
    if (!missing.length) return;
    await this.checkpoint(lease, async (tx) => {
      for (const resource of missing) {
        const row = await tx.managedResource.findUniqueOrThrow({
          where: {
            clusterId_kind_namespace_name: {
              clusterId: target.clusterId,
              kind: resource.kind,
              namespace: resource.namespace ?? '',
              name: resource.name,
            },
          },
        });
        if (row.uid !== resource.expectedUid)
          throw new TaskExecutionError(
            'WORKLOAD_RESOURCE_CONFLICT',
            '核对过程中资源身份变化，请重新读取状态。',
          );
        await tx.auditEvent.create({
          data: {
            action: 'service.resource.recreate',
            resourceType: resource.kind,
            resourceId: row.id,
            outcome: 'confirmed_missing',
            metadata: json({
              taskId: lease.deploymentId,
              oldUid: row.uid,
              oldReceipt: row.receiptJson,
            }),
          },
        });
        await tx.managedResource.update({
          where: { id: row.id },
          data: {
            creationNonce: randomUUID(),
            creationAttempted: false,
            uid: null,
            resourceVersion: null,
            receiptJson: Prisma.DbNull,
            mutationRevision: 0,
          },
        });
      }
    });
  }

  private async deploy(lease: DeploymentLease, signal: AbortSignal): Promise<TaskOutcome> {
    const stored = await this.checkpoint(lease, async (tx) =>
      tx.deployment.findUniqueOrThrow({ where: { id: lease.deploymentId } }),
    );
    const snapshot = readServiceSnapshot(stored.snapshotJson);
    const target = stored.targetJson as unknown as ServiceTarget;
    if (
      snapshot.serviceId !== lease.serviceId ||
      snapshot.configRevision !== lease.configRevision ||
      target.serviceId !== lease.serviceId
    )
      throw new TaskExecutionError('DEPLOYMENT_SNAPSHOT_INVALID', '固定发布快照与任务不匹配。');
    await this.stage(lease, 'resolving', '正在核对目标集群架构和固定镜像产物。');
    let access = await this.context(lease, target, true, snapshot);
    const cluster = await this.kubernetes.inspect(access.connection, {
      signal,
      expectedIdentity: {
        kubeSystemUid: target.kubeSystemUid,
        caFingerprint: access.target.caFingerprint,
      },
    });
    const architectures = [
      ...new Set(
        cluster.nodes
          .filter(
            (node) =>
              node.operatingSystem === 'linux' &&
              !node.unschedulable &&
              node.conditions.ready === 'true',
          )
          .map((node) => node.architecture),
      ),
    ];
    if (
      !architectures.length ||
      architectures.some(
        (architecture) =>
          typeof architecture !== 'string' || !['amd64', 'arm64'].includes(architecture),
      )
    )
      throw new TaskExecutionError(
        'TARGET_PLATFORM_UNAVAILABLE',
        '目标集群没有可确认架构的就绪 Linux 节点。',
      );
    const options = {
      signal,
      access: access.registry,
      platforms: architectures.map((architecture) => ({
        os: 'linux' as const,
        architecture: architecture as 'amd64' | 'arm64',
      })),
    };
    if (snapshot.version === 3 && !this.builds)
      throw new TaskExecutionError(
        'BUILD_COORDINATOR_REQUIRED',
        '当前 Worker 未配置 Git 构建执行器。',
      );
    const image =
      snapshot.version === 3
        ? (await this.builds!.ensureArtifact(lease, snapshot.source, options.platforms, signal))
            .image
        : stored.resolvedImageJson
          ? await this.registry.verify(
              stored.resolvedImageJson as unknown as ResolvedImage,
              options,
            )
          : await this.registry.resolve(snapshot.configuration.image, options);
    await this.checkpoint(lease, async (tx, service) => {
      await assertDatabaseSnapshot(
        tx,
        service.id,
        snapshot.version === 2 ? snapshot.database : null,
      );
      if (snapshot.version !== 3)
        await assertDatabaseConfiguration(tx, service, snapshot.configuration);
      if (
        snapshot.version === 2 &&
        snapshot.database &&
        image.deployReference !== snapshot.database.image
      )
        throw new TaskExecutionError(
          'DATABASE_IMAGE_PROTECTED',
          '数据库镜像产物与固定模板不一致。',
        );
      if (snapshot.version !== 1)
        await assertDatabaseBindingSnapshots(tx, service, snapshotDatabaseBindings(snapshot));
    });
    await this.checkpoint(lease, async (tx) => {
      await tx.deployment.update({
        where: { id: lease.deploymentId },
        data: { resolvedImageJson: json(image) },
      });
    });
    const volumeRefs = snapshotVolumes(snapshot);
    if (volumeRefs.length && !this.storage)
      throw new TaskExecutionError('STORAGE_EXECUTOR_REQUIRED', '包含数据卷的服务需要存储执行器。');
    if (volumeRefs.length)
      await this.stage(lease, 'preparing_storage', '正在确认原数据卷身份与本地节点约束。');
    const volumes = this.storage
      ? await this.storage.prepareForWorkload(lease, target, volumeRefs, signal)
      : [];
    await this.stage(lease, 'deploying', '镜像摘要已固定，正在应用当前项目环境中的资源。');
    access = await this.context(lease, target, true, snapshot);
    const config = await this.checkpoint(lease, async (tx) => {
      const basic = await runtimeConfiguration(tx, this.cipher, snapshot);
      return augmentDatabaseRuntime(tx, this.cipher, snapshot, {
        ...basic,
        image: image.deployReference,
      });
    });
    const dockerConfigJson = access.registry ? registryDockerConfigJson(access.registry) : null;
    const pullSecret = dockerConfigJson ? { dockerConfigJson } : null;
    await this.reserve(
      lease,
      target,
      lease.deploymentId,
      config.ports.length > 0,
      Boolean(pullSecret),
      snapshotController(snapshot).kind,
    );
    let knownInventory = await this.checkpoint(lease, (tx) => inventory(tx, target));
    let values = selectedInventory(knownInventory, target, lease.deploymentId, Boolean(pullSecret));
    if (snapshot.allowConfigurationRepair) {
      await this.repairMissing(lease, target, access, values, knownInventory, signal);
      knownInventory = await this.checkpoint(lease, (tx) => inventory(tx, target));
      values = selectedInventory(knownInventory, target, lease.deploymentId, Boolean(pullSecret));
    }
    const applied = await this.workloads.apply(
      access.connection,
      {
        target: access.target,
        snapshotId: lease.deploymentId,
        configRevision: snapshot.configRevision,
        mutationRevision: lease.mutationRevision,
        taskId: lease.deploymentId,
        allowConfigurationRepair: snapshot.allowConfigurationRepair,
        configuration: {
          image: image.deployReference,
          replicas: config.replicas,
          command: config.command,
          args: config.args,
          ports: config.ports,
          resources: config.resources,
          environment: config.environment,
          readiness: config.readiness,
          startup: config.startup,
          ...(snapshot.version !== 1
            ? {
                controller: snapshot.controller,
                volumes: volumes.map(({ volumeId, claimName, claimUid, path, readOnly }) => ({
                  volumeId,
                  claimName,
                  claimUid,
                  path,
                  readOnly,
                })),
                secretFiles: config.secretFiles,
                database: config.database,
              }
            : {}),
        },
        pullSecret,
        inventory: values,
      },
      this.hooks(lease, target, signal, snapshot),
    );
    const result: DeploymentResult = {
      version: snapshot.version,
      published: applied.published,
      image,
      serviceDns: applied.serviceDns,
      appliedAt: applied.appliedAt,
    };
    // Full application is durable before health waiting. A failed health check
    // must never make the previous successful version masquerade as published.
    await this.checkpoint(lease, async (tx, service) => {
      await tx.deployment.update({
        where: { id: lease.deploymentId },
        data: { appliedAt: new Date(applied.appliedAt), result: json(result) },
      });
      await tx.service.update({
        where: { id: lease.serviceId },
        data: {
          publishedDeploymentId: lease.deploymentId,
          configurationState: 'consistent',
          remoteCreatedAt: service.remoteCreatedAt ?? new Date(applied.appliedAt),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    });
    await this.stage(lease, 'waiting_healthy', '资源已完整应用，正在等待此版本的 Pod 与探针就绪。');
    const readyInventory = await this.checkpoint(lease, (tx) => inventory(tx, target));
    const observation = await this.waitHealthy(
      lease,
      access,
      applied.published,
      readyInventory,
      snapshot.configuration.healthTimeoutSeconds,
      signal,
    );
    result.observation = observation;
    if (this.storage) await this.storage.afterWorkload(lease, target, volumeRefs, {}, signal);
    if (snapshot.version === 2 && snapshot.database) {
      await this.stage(lease, 'verifying_database', '正在核对数据库认证、引擎版本与持久化配置。');
      await this.verifyDatabase(lease, access, snapshot, applied.published, signal);
    }
    return {
      result: json(result),
      commit: async (tx) => {
        await tx.service.update({
          where: { id: lease.serviceId },
          data: {
            lastSuccessfulDeploymentId: lease.deploymentId,
            configurationState: 'consistent',
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
        await this.saveObservation(tx, lease.serviceId, observation);
      },
    };
  }

  private async verifyDatabase(
    lease: ExecutionLease,
    access: Awaited<ReturnType<ServiceExecutor['context']>>,
    snapshot: ServiceSnapshot,
    published: DeploymentResult['published'],
    signal: AbortSignal,
  ): Promise<void> {
    if (snapshot.version !== 2 || !snapshot.database) return;
    if (!this.workloads.verifyDatabase)
      throw new TaskExecutionError(
        'DATABASE_VERIFIER_REQUIRED',
        '当前执行器缺少真实数据库认证检查能力。',
      );
    const database = snapshot.database;
    const values = await this.checkpoint(lease, (tx) => inventory(tx, access.target));
    const verification = await this.workloads.verifyDatabase(
      access.connection,
      access.target,
      values,
      published,
      {
        engine: database.engine,
        expectedMajor: database.majorVersion,
        username: database.username,
        databaseName: database.databaseName,
      },
      { signal },
    );
    const observation = await this.checkpoint(lease, (tx, service) =>
      saveDatabaseVerification(tx, service, verification),
    );
    if (observation.state !== 'ready')
      throw new TaskExecutionError(
        observation.code ?? 'DATABASE_AUTHENTICATION_FAILED',
        observation.message ?? '数据库认证或持久化检查未通过。',
      );
  }

  private async waitHealthy(
    lease: ExecutionLease,
    access: Awaited<ReturnType<ServiceExecutor['context']>>,
    expected: DeploymentResult['published'],
    values: ManagedWorkloadResource[],
    seconds: number,
    signal: AbortSignal,
  ) {
    const timeout = AbortSignal.timeout(seconds * 1000);
    try {
      return await this.workloads.waitHealthy(access.connection, access.target, expected, {
        signal: AbortSignal.any([signal, timeout]),
        inventory: selectedInventory(
          values,
          access.target,
          expected.snapshotId,
          expected.usesPullSecret,
        ),
        knownInventory: values,
        checkpoint: () => this.checkpoint(lease, async () => {}),
        onObservation: (observation) =>
          this.checkpoint(lease, async (tx) => {
            await this.saveObservation(tx, serviceId(lease), observation);
          }),
      });
    } catch (error) {
      if (timeout.aborted && !signal.aborted)
        throw new WorkloadAdapterError(
          'WORKLOAD_ROLLOUT_TIMEOUT',
          false,
          'none',
          [],
          error instanceof WorkloadAdapterError ? error.observation : null,
        );
      throw error;
    }
  }

  private async operate(lease: TaskLease, signal: AbortSignal): Promise<TaskOutcome> {
    const input = lease.input as ServiceOperationInput;
    const action = lease.kind.slice('service_'.length) as ServiceAction;
    if (!['stop', 'resume', 'restart', 'delete'].includes(action))
      throw new TaskExecutionError('INVALID_OPERATION_INPUT', '服务操作类型无效。');
    const target: ServiceTarget = { ...input.target, serviceId: input.serviceId };
    const initial = await this.checkpoint(lease, async (tx, service) => {
      await assertServiceTarget(tx, service, target);
      if (action === 'delete') await assertDatabaseHasNoConsumers(tx, service.id);
      return {
        service,
        values: await inventory(tx, target),
        hasDomains:
          action === 'delete' && (await tx.domain.count({ where: { serviceId: service.id } })) > 0,
      };
    });
    if (initial.hasDomains) {
      if (!this.networking)
        throw new TaskExecutionError(
          'NETWORKING_EXECUTOR_REQUIRED',
          '服务仍有关联域名，需要完成受管路由清理后再删除。',
        );
      await this.networking.beforeServiceDelete(lease, signal);
    }
    const published = initial.service.publishedDeployment
      ?.result as unknown as DeploymentResult | null;
    const snapshot = initial.service.publishedDeployment?.snapshotJson
      ? readServiceSnapshot(initial.service.publishedDeployment.snapshotJson)
      : null;
    const volumeRefs = snapshot ? snapshotVolumes(snapshot) : [];
    const hasVolumes =
      (await this.repository.db.volumeMutation.count({
        where: { operationId: lease.operationId },
      })) > 0;
    if (hasVolumes && !this.storage)
      throw new TaskExecutionError('STORAGE_EXECUTOR_REQUIRED', '包含数据卷的操作需要存储执行器。');
    if (action === 'resume' || action === 'restart') {
      await this.checkpoint(lease, async (tx, service) => {
        await assertDatabaseSnapshot(
          tx,
          service.id,
          snapshot?.version === 2 ? snapshot.database : null,
        );
        if (snapshot && snapshot.version !== 3)
          await assertDatabaseConfiguration(tx, service, snapshot.configuration);
        if (snapshot && snapshot.version !== 1)
          await assertDatabaseBindingSnapshots(tx, service, snapshotDatabaseBindings(snapshot));
      });
      if (this.storage) await this.storage.prepareForWorkload(lease, target, volumeRefs, signal);
    }
    if (
      (action === 'resume' || action === 'restart') &&
      (!published?.published ||
        input.snapshotId !== initial.service.publishedDeploymentId ||
        initial.service.configurationState !== 'consistent')
    )
      throw new TaskExecutionError(
        'PUBLISHED_CONFIGURATION_REQUIRED',
        '当前没有可信的完整已发布配置，不能恢复或重启。',
      );
    const owned = initial.values.filter((value) => value.kind !== 'Namespace');
    if (
      !initial.service.remoteCreatedAt &&
      owned.length === 0 &&
      (action === 'stop' || action === 'delete')
    ) {
      if (action === 'delete' && this.storage)
        await this.storage.afterWorkload(lease, target, volumeRefs, { deleted: true }, signal);
      return {
        result: json({ action, serviceId: input.serviceId, remoteEffects: 'none' }),
        commit: async (tx) => {
          if (action === 'delete') await tx.service.delete({ where: { id: input.serviceId } });
        },
      };
    }
    const access = await this.context(
      lease,
      target,
      action === 'resume' || action === 'restart',
      snapshot ?? undefined,
    );
    const dockerConfigJson = access.registry ? registryDockerConfigJson(access.registry) : null;
    const pullSecret = dockerConfigJson ? { dockerConfigJson } : null;
    if (
      (action === 'resume' || action === 'restart') &&
      published!.published.usesPullSecret &&
      !pullSecret
    )
      throw new TaskExecutionError('REGISTRY_AUTH_REQUIRED', '已发布镜像需要当前有效的拉取凭证。');
    const values =
      action === 'delete'
        ? initial.values
        : selectedInventory(
            initial.values,
            target,
            input.snapshotId,
            Boolean(published?.published.usesPullSecret),
          );
    const result = await this.workloads.operate(
      access.connection,
      {
        target: access.target,
        action,
        taskId: lease.operationId,
        mutationRevision: input.mutationRevision,
        inventory: values,
        knownInventory: initial.values,
        ...(published?.published ? { published: published.published } : {}),
        pullSecret,
      },
      this.hooks(lease, target, signal, snapshot ?? undefined),
    );
    if (action === 'delete') {
      if (this.storage)
        await this.storage.afterWorkload(lease, target, volumeRefs, { deleted: true }, signal);
      return {
        result: json(result),
        commit: async (tx) => {
          await tx.service.delete({ where: { id: input.serviceId } });
        },
      };
    }
    await this.checkpoint(lease, async (tx) => {
      await tx.service.update({
        where: { id: input.serviceId },
        data: { configurationState: initial.service.configurationState },
      });
    });
    const after = await this.checkpoint(lease, (tx) => inventory(tx, target));
    const observation = result.rollout
      ? await this.waitHealthy(
          lease,
          access,
          result.rollout,
          after,
          snapshot?.configuration.healthTimeoutSeconds ?? 300,
          signal,
        )
      : await this.workloads.observe(
          access.connection,
          access.target,
          selectedInventory(
            after,
            target,
            input.snapshotId,
            Boolean(published?.published.usesPullSecret),
          ),
          { signal, knownInventory: after },
        );
    if (this.storage) await this.storage.afterWorkload(lease, target, volumeRefs, {}, signal);
    if (snapshot && result.rollout)
      await this.verifyDatabase(lease, access, snapshot, result.rollout, signal);
    return {
      result: json({ ...result, observation }),
      commit: async (tx) => {
        await this.saveObservation(tx, input.serviceId, observation);
        await tx.service.update({
          where: { id: input.serviceId },
          data: { lastErrorCode: null, lastErrorMessage: null },
        });
      },
    };
  }
}
