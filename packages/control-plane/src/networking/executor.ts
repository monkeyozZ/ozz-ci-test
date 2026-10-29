import type { Prisma } from '@ozz/database';
import {
  NetworkingAdapterError,
  NodeDomainDnsInspector,
  type DomainDnsInspector,
  type KubernetesNetworkingManager,
  type NetworkWriteHooks,
  type ManagedNetworkResource,
} from '@ozz/infrastructure/networking';
import { infrastructureFailure } from '../infrastructure/executor.js';
import { lockCluster } from '../infrastructure/persistence.js';
import { SecretCipher } from '../secrets.js';
import {
  assertServiceTarget,
  json,
  lockService,
  type ServiceRecord,
} from '../services/persistence.js';
import {
  clusterNetworkingKinds,
  clusterNetworkingOperationInput,
  domainOperationKinds,
  domainOperationInput,
  serviceOperationInput,
  TaskExecutionError,
  type ClusterNetworkingOperationInput,
  type DomainOperationInput,
} from '../tasks/contracts.js';
import { TaskRepository, type TaskLease, type TaskOutcome } from '../tasks/repository.js';
import {
  assertNetworkCredential,
  domainPlan,
  networkClusterTarget,
  networkRevisions,
  readNetworkAccess,
  requireDomainIntent,
  saveDomainSample,
  storedDomainInput,
  type NetworkCredentialFence,
} from './execution-context.js';
import {
  beforeNetworkWrite,
  confirmDomainResourcesRemoved,
  reserveNetworkResource,
  saveNetworkReceipt,
  networkResourceKey,
  type NetworkOwner,
  type NetworkRevisionFence,
} from './ledger.js';
import { domainInclude, readClusterNetworking, readPlatformSettings } from './persistence.js';

export function networkingFailure(error: unknown): TaskExecutionError {
  if (error instanceof TaskExecutionError) return error;
  if (error instanceof NetworkingAdapterError)
    return new TaskExecutionError(error.code, error.message, error.retryable);
  return infrastructureFailure(error);
}

export function isNetworkingOperation(kind: string): boolean {
  return (
    (domainOperationKinds as readonly string[]).includes(kind) ||
    (clusterNetworkingKinds as readonly string[]).includes(kind)
  );
}

/** Network operations use the same durable service slot and task fencing as publication. */
export class NetworkingExecutor {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly manager: KubernetesNetworkingManager,
    private readonly dns: DomainDnsInspector = new NodeDomainDnsInspector(),
  ) {}

  async execute(lease: TaskLease, signal: AbortSignal): Promise<TaskOutcome> {
    try {
      this.checkSignal(signal);
      if ((domainOperationKinds as readonly string[]).includes(lease.kind))
        return await this.domain(lease, domainOperationInput(lease.input), signal);
      if ((clusterNetworkingKinds as readonly string[]).includes(lease.kind))
        return await this.cluster(lease, clusterNetworkingOperationInput(lease.input), signal);
      throw new TaskExecutionError('INVALID_OPERATION_INPUT', '此任务不属于网络操作。');
    } catch (error) {
      throw networkingFailure(error);
    }
  }

  async failed(
    lease: TaskLease,
    tx: Prisma.TransactionClient,
    code: string,
    message: string,
  ): Promise<void> {
    if (!(domainOperationKinds as readonly string[]).includes(lease.kind)) return;
    const input = domainOperationInput(lease.input);
    await tx.domain.updateMany({
      where: {
        id: input.domainId,
        serviceId: input.serviceId,
        revision: input.domainRevision,
      },
      data: {
        observationErrorCode: code,
        lastErrorCode: code,
        lastErrorMessage: message,
        nextObservationAt: new Date(),
      },
    });
  }

  private checkSignal(signal: AbortSignal): void {
    if (signal.aborted)
      throw new TaskExecutionError('NETWORK_TASK_FENCE_LOST', '网络任务已经取消或执行租约失效。');
  }

  private async checkpoint<T>(
    lease: TaskLease,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let result: T | undefined;
    const accepted = await this.repository.checkpoint(lease, async (tx) => {
      result = await work(tx);
    });
    if (!accepted)
      throw new TaskExecutionError(
        'NETWORK_TASK_FENCE_LOST',
        '网络任务租约或恢复代次已变化，后续写入已停止。',
      );
    return result as T;
  }

  private async domainCheckpoint<T>(
    lease: TaskLease,
    input: DomainOperationInput,
    deleting: boolean,
    work: (
      tx: Prisma.TransactionClient,
      context: Awaited<ReturnType<typeof requireDomainIntent>>,
      service: ServiceRecord,
    ) => Promise<T>,
    credential?: NetworkCredentialFence,
  ): Promise<T> {
    return this.checkpoint(lease, async (tx) => {
      if (lease.serviceId !== input.serviceId || lease.clusterId !== input.target.clusterId)
        throw new TaskExecutionError('NETWORK_TARGET_CHANGED', '任务关联与固定域名目标不一致。');
      const service = await lockService(tx, input.serviceId);
      const context = await requireDomainIntent(tx, service, input, deleting);
      if (credential)
        await assertNetworkCredential(tx, service.environment.project.cluster, credential);
      return work(tx, context, service);
    });
  }

  private async progress(lease: TaskLease, message: string) {
    if (!(await this.repository.progress(lease, message)))
      throw new TaskExecutionError('NETWORK_TASK_FENCE_LOST', '任务已停止，不能继续网络操作。');
  }

  private hooks(
    owner: NetworkOwner,
    revisions: NetworkRevisionFence,
    deleting: boolean,
    checkpoint: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>,
    signal: AbortSignal,
    inventory: readonly ManagedNetworkResource[] = [],
  ): NetworkWriteHooks {
    const versions = new Map(inventory.map((row) => [networkResourceKey(row), row.ledgerVersion]));
    const fenced = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => {
      this.checkSignal(signal);
      return checkpoint(work);
    };
    return {
      signal,
      checkpoint: () => fenced(async () => {}),
      reserve: async (resource) => {
        const value = await fenced((tx) => reserveNetworkResource(tx, owner, resource, !deleting));
        versions.set(networkResourceKey(resource), value.ledgerVersion);
        return value;
      },
      beforeWrite: async (intent) => {
        const key = networkResourceKey(intent);
        const version = await fenced((tx) =>
          beforeNetworkWrite(tx, owner, intent, revisions, deleting, versions.get(key)),
        );
        versions.set(key, version);
      },
      onReceipt: async (receipt) => {
        const key = networkResourceKey(receipt);
        const version = await fenced((tx) =>
          saveNetworkReceipt(tx, owner, receipt, revisions, versions.get(key)),
        );
        versions.set(key, version);
      },
    };
  }

  private async domain(
    lease: TaskLease,
    input: DomainOperationInput,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    if (lease.kind === 'domain_production' && !input.stagingVerification)
      throw new TaskExecutionError(
        'STAGING_CERTIFICATE_REQUIRED',
        '生产签发任务缺少原 staging 验证记录。',
      );
    const deleting = lease.kind === 'domain_unbind';
    const initial = await this.domainCheckpoint(
      lease,
      input,
      deleting,
      async (tx, context, service) => {
        const access = await readNetworkAccess(
          tx,
          this.cipher,
          service.environment.project.cluster,
          input.target,
        );
        const plan = await domainPlan(
          tx,
          input,
          lease.operationId,
          access.caFingerprint,
          context.settings.acmeEmail!,
        );
        plan.reconcileMissing = lease.kind === 'domain_reconcile';
        await tx.domain.update({
          where: { id: input.domainId },
          data: {
            lastAttemptAt: new Date(),
            observationLeaseToken: null,
            observationLeaseExpiresAt: null,
          },
        });
        await tx.auditEvent.create({
          data: {
            action: 'network.task.credentials',
            resourceType: 'operation',
            resourceId: lease.operationId,
            outcome: 'resolved',
            metadata: json({ domainId: input.domainId, ...access.credential }),
          },
        });
        return { ...access, plan, network: context.network };
      },
    );
    const checkpoint = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
      this.domainCheckpoint(lease, input, deleting, (tx) => work(tx), initial.credential);
    const hooks = this.hooks(
      input.target,
      networkRevisions(input),
      deleting,
      checkpoint,
      signal,
      initial.plan.inventory,
    );
    let dns = null;
    if (!deleting) {
      await this.progress(lease, '正在检查固定域名的 DNS；路由与证书分别观察。');
      dns = await this.dns.inspect(
        input.hostname,
        { addresses: initial.network.entryAddresses, cname: initial.network.cnameTarget },
        { signal },
      );
      this.checkSignal(signal);
      await this.domainCheckpoint(
        lease,
        input,
        false,
        (tx, context) => saveDomainSample(tx, context.domain, input, { dns: dns! }),
        initial.credential,
      );
      if (
        input.certificateEnvironment === 'production' &&
        lease.kind !== 'domain_sync' &&
        dns.state !== 'matched'
      )
        throw new TaskExecutionError(
          'PRODUCTION_DNS_REQUIRED',
          '当前 DNS 与预期入口不一致，生产签发尚未开始。',
        );
    }
    await this.progress(
      lease,
      deleting
        ? '正在按原 UID 清理域名资源，共享 Issuer 与账户保留。'
        : lease.kind === 'domain_sync'
          ? '正在只读核对已有 Ingress 与证书，不重建或覆盖远端对象。'
          : '正在应用域名路由和证书请求；签发结果由独立观察更新。',
    );
    const observed = deleting
      ? await this.manager.remove(initial.connection, initial.plan, hooks)
      : lease.kind === 'domain_sync'
        ? await this.manager.observe(initial.connection, initial.plan, { signal })
        : await this.manager.apply(initial.connection, initial.plan, hooks);
    this.checkSignal(signal);
    await checkpoint(async (tx) => {
      if (deleting) await confirmDomainResourcesRemoved(tx, input.domainId);
    });
    const result = json({
      domainId: input.domainId,
      hostname: input.hostname,
      action: lease.kind.slice('domain_'.length),
      completedAt: new Date().toISOString(),
      dns,
      route: observed.route,
      certificate: observed.certificate,
    });
    return {
      result,
      commit: async (tx) => {
        const service = await lockService(tx, input.serviceId);
        const context = await requireDomainIntent(tx, service, input, deleting);
        await assertNetworkCredential(tx, service.environment.project.cluster, initial.credential);
        if (deleting) {
          await confirmDomainResourcesRemoved(tx, input.domainId);
          await tx.domain.delete({ where: { id: input.domainId } });
        } else
          await saveDomainSample(tx, context.domain, input, {
            dns: dns!,
            network:
              lease.kind === 'domain_sync'
                ? observed
                : { route: observed.route, certificate: observed.certificate },
            // Apply receipts were already fenced by hooks. Only an explicit read publishes metadata here.
            inventory: lease.kind === 'domain_sync' ? initial.plan.inventory : undefined,
          });
      },
    };
  }

  private async clusterCheckpoint<T>(
    lease: TaskLease,
    input: ClusterNetworkingOperationInput,
    work: (
      tx: Prisma.TransactionClient,
      cluster: Awaited<ReturnType<typeof lockCluster>>,
    ) => Promise<T>,
    credential?: NetworkCredentialFence,
  ): Promise<T> {
    return this.checkpoint(lease, async (tx) => {
      const cluster = await lockCluster(tx, input.clusterId);
      const state = await tx.controlPlaneState.findUniqueOrThrow({
        where: { id: 'control-plane' },
      });
      const network = await readClusterNetworking(tx, cluster.id);
      if (
        lease.clusterId !== cluster.id ||
        state.installationId !== input.installationId ||
        cluster.kubeSystemUid !== input.kubeSystemUid ||
        cluster.connectionRevision !== input.clusterConnectionRevision ||
        network.revision !== input.networkRevision
      )
        throw new TaskExecutionError(
          'NETWORK_TARGET_CHANGED',
          '集群网络任务的固定身份或配置已经变化。',
        );
      if (credential) await assertNetworkCredential(tx, cluster, credential);
      return work(tx, cluster);
    });
  }

  private async cluster(
    lease: TaskLease,
    input: ClusterNetworkingOperationInput,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    const initial = await this.clusterCheckpoint(lease, input, async (tx, cluster) => {
      const target = networkClusterTarget(cluster, input.installationId);
      const access = await readNetworkAccess(tx, this.cipher, cluster, target);
      await tx.auditEvent.create({
        data: {
          action: 'network.task.credentials',
          resourceType: 'operation',
          resourceId: lease.operationId,
          outcome: 'resolved',
          metadata: json({ clusterId: cluster.id, ...access.credential }),
        },
      });
      return { ...access, target };
    });
    const checkpoint = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
      this.clusterCheckpoint(lease, input, (tx) => work(tx), initial.credential);
    await this.progress(
      lease,
      lease.kind === 'cluster_network_check'
        ? '正在检查 Ingress、Traefik、cert-manager 与相关权限。'
        : '正在核对现有组件并安装固定版本 cert-manager；已有外部安装不会被覆盖。',
    );
    const capabilities =
      lease.kind === 'cluster_network_check'
        ? await this.manager.inspect(initial.connection, initial.target, { signal })
        : await this.manager.installCertManager(
            initial.connection,
            initial.target,
            this.hooks(
              initial.target,
              { domain: 0, environment: 0, cluster: 1 },
              false,
              checkpoint,
              signal,
            ),
          );
    await checkpoint(async () => {});
    return {
      result: json({ clusterId: input.clusterId, capabilities }),
      commit: async (tx) => {
        const cluster = await lockCluster(tx, input.clusterId);
        await assertNetworkCredential(tx, cluster, initial.credential);
        const network = await readClusterNetworking(tx, input.clusterId);
        if (
          network.revision !== input.networkRevision ||
          cluster.kubeSystemUid !== input.kubeSystemUid
        )
          throw new TaskExecutionError('NETWORK_TARGET_CHANGED', '结果返回时集群目标已变化。');
        await tx.clusterNetworking.update({
          where: { clusterId: input.clusterId },
          data: {
            capabilitiesJson: json(capabilities),
            capabilitiesAt: new Date(capabilities.observedAt),
          },
        });
      },
    };
  }

  /** Service deletion cleans networking under its existing mutation slot; it enqueues no nested task. */
  async beforeServiceDelete(lease: TaskLease, signal: AbortSignal): Promise<void> {
    try {
      if (lease.kind !== 'service_delete')
        throw new TaskExecutionError(
          'INVALID_OPERATION_INPUT',
          '只有服务删除任务可以使用关联网络清理。',
        );
      const original = serviceOperationInput('service_delete', lease.input);
      const initial = await this.checkpoint(lease, async (tx) => {
        const service = await lockService(tx, original.serviceId);
        await assertServiceTarget(tx, service, {
          ...original.target,
          serviceId: original.serviceId,
        });
        if (
          lease.serviceId !== service.id ||
          service.mutationRevision !== original.mutationRevision
        )
          throw new TaskExecutionError('SERVICE_TASK_SUPERSEDED', '服务删除意图已经变化。');
        const settings = await readPlatformSettings(tx);
        const network = await readClusterNetworking(tx, lease.clusterId!, settings);
        const domains = await tx.domain.findMany({
          where: { serviceId: service.id },
          include: domainInclude,
        });
        return domains.map((domain) =>
          storedDomainInput(domain, settings.revision, network.revision),
        );
      });
      for (const input of initial) {
        this.checkSignal(signal);
        const context = await this.domainCheckpoint(
          lease,
          input,
          true,
          async (tx, value, service) => {
            const access = await readNetworkAccess(
              tx,
              this.cipher,
              service.environment.project.cluster,
              input.target,
            );
            const plan = await domainPlan(
              tx,
              input,
              lease.operationId,
              access.caFingerprint,
              value.settings.acmeEmail!,
            );
            return { ...access, plan };
          },
        );
        const checkpoint = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
          this.domainCheckpoint(lease, input, true, (tx) => work(tx), context.credential);
        await this.progress(lease, `正在清理服务关联域名 ${input.hostname}。`);
        await this.manager.remove(
          context.connection,
          context.plan,
          this.hooks(
            input.target,
            networkRevisions(input),
            true,
            checkpoint,
            signal,
            context.plan.inventory,
          ),
        );
        await checkpoint(async (tx) => {
          await confirmDomainResourcesRemoved(tx, input.domainId);
          await tx.domain.delete({ where: { id: input.domainId } });
        });
      }
    } catch (error) {
      const failure = networkingFailure(error);
      try {
        await this.checkpoint(lease, async (tx) => {
          await tx.domain.updateMany({
            where: { serviceId: lease.serviceId ?? '', desiredState: 'deleting' },
            data: {
              observationErrorCode: failure.code,
              lastErrorCode: failure.code,
              lastErrorMessage: failure.message,
            },
          });
        });
      } catch {
        /* A cancelled or replaced task cannot publish a cleanup error. */
      }
      throw failure;
    }
  }
}
