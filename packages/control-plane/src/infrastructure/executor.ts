import { Prisma, type Cluster, type Server } from '@ozz/database';
import {
  KubernetesAdapter,
  KubernetesAdapterError,
  type KubernetesInspection,
} from '@ozz/infrastructure/kubernetes';
import {
  SshAdapter,
  SshAdapterError,
  parseSshCredential,
  type SshCredential,
  type SshPreflight,
  type SshProgressStage,
  type SshTarget,
} from '@ozz/infrastructure/ssh';
import { SecretAuthenticationError, SecretCipher } from '../secrets.js';
import {
  OperationRequestError,
  TaskExecutionError,
  taskInput,
  type InfrastructureInput,
} from '../tasks/contracts.js';
import { TaskRepository, type TaskLease, type TaskOutcome } from '../tasks/repository.js';
import type { TaskExecutor } from '../tasks/runtime.js';
import {
  assertClusterTarget,
  assertServerTarget,
  failureStatus,
  json,
  kubeConnection,
  lockCluster,
  lockServer,
  readCredential,
  storeInspection,
} from './persistence.js';

const stages: Record<SshProgressStage, string> = {
  connecting: '正在连接已确认指纹的服务器。',
  preflight: '正在重新核对机器身份、权限和资源。',
  downloading: '正在获取并校验固定版本安装资源。',
  installing: '正在配置同一初始化意图的 K3s 安装。',
  starting: '正在启动 K3s 系统服务。',
  waiting_ready: '正在等待 API 和节点就绪。',
  verifying_encryption: '正在验证 Kubernetes Secret 静态加密。',
  storing_credential: '正在加密保存初始集群凭证。',
  completed: '远端初始化已结束，正在由控制面验证集群身份。',
};

export function infrastructureFailure(error: unknown): TaskExecutionError {
  if (error instanceof TaskExecutionError) return error;
  if (error instanceof KubernetesAdapterError)
    return new TaskExecutionError(error.code, error.message, error.retryable);
  if (error instanceof SshAdapterError)
    return new TaskExecutionError(
      error.code,
      error.message,
      [
        'SSH_CONNECTION_FAILED',
        'SSH_TIMEOUT',
        'SSH_INSTALL_BUSY',
        'SSH_ASSET_DOWNLOAD_FAILED',
        'SSH_NOT_READY',
        'SSH_CANCELLED',
        'SSH_CREDENTIAL_STORE_FAILED',
        'SSH_PROGRESS_FAILED',
      ].includes(error.code),
    );
  if (error instanceof OperationRequestError)
    return new TaskExecutionError(error.code, error.message);
  if (error instanceof SecretAuthenticationError)
    return new TaskExecutionError(
      'CREDENTIAL_DECRYPTION_FAILED',
      '凭证无法使用当前主密钥解密，请核对恢复材料。',
    );
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    return new TaskExecutionError(
      'INFRASTRUCTURE_IDENTITY_REGISTERED',
      '机器或集群身份已经登记，请使用已有资源入口。',
    );
  return new TaskExecutionError(
    'INFRASTRUCTURE_INTERRUPTED',
    '基础设施检查中断，已有远端变更保留，请核对任务阶段后重试。',
    true,
  );
}

function targetOf(input: InfrastructureInput): SshTarget {
  return {
    host: input.host!,
    port: input.port!,
    username: input.username!,
    hostKeyFingerprint: input.hostKeyFingerprint!,
  };
}

/** Owns secrets only while calling an Adapter; outcomes carry safe summaries and a fenced commit. */
export class InfrastructureExecutor implements TaskExecutor {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly ssh = new SshAdapter(),
    private readonly kubernetes = new KubernetesAdapter(),
  ) {}

  async execute(lease: TaskLease, signal: AbortSignal): Promise<TaskOutcome> {
    try {
      const input = taskInput(lease.kind, lease.input) as InfrastructureInput;
      if (signal.aborted)
        throw new TaskExecutionError('EXECUTION_INTERRUPTED', '任务已被取消或执行租约失效。', true);
      if (lease.kind.startsWith('cluster_')) return await this.cluster(lease, input, signal);
      return await this.server(lease, input, signal);
    } catch (error) {
      throw infrastructureFailure(error);
    }
  }

  private async startServer(lease: TaskLease, input: InfrastructureInput) {
    let credential: SshCredential | undefined;
    let credentialRefId: string | null = null;
    const valid = await this.repository.checkpoint(lease, async (tx) => {
      const server = await lockServer(tx, input.targetId);
      assertServerTarget(server, input);
      if (lease.kind !== 'ssh_discover') {
        const current = await readCredential(tx, this.cipher, server.credentialRefId, 'ssh');
        credential = parseSshCredential(current.payload);
        credentialRefId = current.id;
      }
      if (input.clusterId) {
        const cluster = await lockCluster(tx, input.clusterId);
        assertClusterTarget(cluster, input);
        if (
          cluster.bootstrapServerId !== server.id ||
          (cluster.bootstrapConfig as unknown as InfrastructureInput)?.installationId !==
            input.installationId
        )
          throw new TaskExecutionError(
            'INITIALIZATION_INTENT_CHANGED',
            '服务器与原初始化意图不一致。',
          );
        await tx.cluster.update({
          where: { id: cluster.id },
          data: {
            lastAttemptAt: new Date(),
            observationLeaseToken: null,
            observationLeaseExpiresAt: null,
          },
        });
      }
      await tx.server.update({ where: { id: server.id }, data: { lastAttemptAt: new Date() } });
    });
    if (!valid)
      throw new TaskExecutionError(
        'EXECUTION_LEASE_LOST',
        '执行租约或恢复代次已变化，操作已停止。',
        true,
      );
    return { credential, credentialRefId };
  }

  private async server(
    lease: TaskLease,
    input: InfrastructureInput,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    const authentication = await this.startServer(lease, input);
    if (lease.kind === 'ssh_discover') {
      const key = await this.ssh.discoverHostKey(
        { host: input.host!, port: input.port! },
        { signal },
      );
      return {
        result: {
          check: 'ssh-host-key',
          host: input.host!,
          port: input.port!,
          fingerprint: key.fingerprint,
          algorithm: key.algorithm,
          observedAt: key.observedAt,
        },
        commit: async (tx) => {
          assertServerTarget(await lockServer(tx, input.targetId), input);
          await tx.server.update({
            where: { id: input.targetId },
            data: {
              observedHostKeyFingerprint: key.fingerprint,
              observedHostKeyAlgorithm: key.algorithm,
              observedHostKeyAt: new Date(key.observedAt),
              hostKeyDiscoveryOperationId: lease.operationId,
              lastErrorCode: null,
              lastErrorMessage: null,
            },
          });
        },
      };
    }
    if (lease.kind === 'server_preflight') {
      const preflight = await this.ssh.preflight(targetOf(input), authentication.credential!, {
        signal,
      });
      if (input.expectedMachineId && preflight.machineId !== input.expectedMachineId)
        throw new TaskExecutionError(
          'SSH_IDENTITY_CHANGED',
          '机器身份与原服务器不同，请另行登记。',
        );
      return {
        result: {
          check: 'server-preflight',
          serverId: input.targetId,
          observedAt: preflight.observedAt,
          blockers: preflight.blockers,
          warnings: preflight.warnings,
        },
        commit: (tx) => this.storePreflight(tx, input, preflight, authentication.credentialRefId),
      };
    }
    if (lease.kind !== 'server_initialize')
      throw new TaskExecutionError('UNSUPPORTED_OPERATION', '当前 Worker 不支持此任务类型。');
    const installed = await this.ssh.initialize(targetOf(input), authentication.credential!, {
      signal,
      installationId: input.installationId!,
      expectedMachineId: input.expectedMachineId!,
      nodeName: input.nodeName!,
      apiEndpoint: input.apiEndpoint!,
      onProgress: async ({ stage }) => {
        if (
          !(await this.repository.progress(
            lease,
            stages[stage],
            `INITIALIZE_${stage.toUpperCase()}`,
          ))
        )
          throw new TaskExecutionError(
            'EXECUTION_LEASE_LOST',
            '初始化租约失效，远端已发生的变更保留。',
            true,
          );
      },
      onCredential: async (kubeconfig) => {
        const connection = kubeConnection({ kubeconfig }, input.apiEndpoint);
        const protectedPayload = this.cipher.encrypt('kubeconfig', { kubeconfig });
        const valid = await this.repository.checkpoint(lease, async (tx) => {
          const server = await lockServer(tx, input.targetId);
          assertServerTarget(server, input);
          const cluster = await lockCluster(tx, input.clusterId!);
          assertClusterTarget(cluster, input);
          if (cluster.caFingerprint && cluster.caFingerprint !== connection.caFingerprint)
            throw new TaskExecutionError(
              'KUBERNETES_CA_MISMATCH',
              '初始化返回的 CA 与此前保存的同一安装不同。',
            );
          if (
            cluster.credentialRefId &&
            cluster.credentialRefId !== input.bootstrapCredentialRefId
          ) {
            if (cluster.kubeSystemUid) return; // Preserve a later, verified credential rotation.
            throw new TaskExecutionError(
              'CLUSTER_CREDENTIAL_CHANGED',
              '集群已使用另一凭证，原初始化不能覆盖它。',
            );
          }
          await tx.secretReference.upsert({
            where: { id: input.bootstrapCredentialRefId! },
            create: {
              id: input.bootstrapCredentialRefId!,
              kind: 'kubeconfig',
              name: `K3s · ${cluster.name}`.slice(0, 120),
              ...protectedPayload,
              expiresAt: connection.credential.expiresAt
                ? new Date(connection.credential.expiresAt)
                : null,
            },
            update: {
              ...protectedPayload,
              revision: { increment: 1 },
              expiresAt: connection.credential.expiresAt
                ? new Date(connection.credential.expiresAt)
                : null,
            },
          });
          await tx.cluster.update({
            where: { id: cluster.id },
            data: {
              credentialRefId: input.bootstrapCredentialRefId!,
              apiEndpoint: input.apiEndpoint!,
              caFingerprint: connection.caFingerprint,
            },
          });
        });
        if (!valid)
          throw new TaskExecutionError(
            'EXECUTION_LEASE_LOST',
            '初始化凭证尚未保存，重试同一任务可继续核对。',
            true,
          );
      },
    });
    const cluster = await this.repository.db.cluster.findUniqueOrThrow({
      where: { id: input.clusterId! },
    });
    assertClusterTarget(cluster, input);
    const credential = await readCredential(
      this.repository.db,
      this.cipher,
      cluster.credentialRefId,
      'kubeconfig',
    );
    const connection = kubeConnection(credential.payload, input.apiEndpoint);
    const observation = await this.kubernetes.inspect(connection, {
      signal,
      ...(cluster.kubeSystemUid
        ? {
            expectedIdentity: {
              kubeSystemUid: cluster.kubeSystemUid,
              caFingerprint: cluster.caFingerprint!,
            },
          }
        : {}),
    });
    const preflight = await this.ssh.preflight(targetOf(input), authentication.credential!, {
      signal,
    });
    return {
      result: {
        check: 'server-initialize',
        serverId: input.targetId,
        clusterId: cluster.id,
        installationId: installed.installationId,
        version: installed.version,
        observedAt: installed.observedAt,
        secretsEncryption: installed.secretsEncryption,
        resumed: installed.resumed,
      },
      commit: async (tx) => {
        await this.storePreflight(tx, input, preflight, authentication.credentialRefId);
        const current = await lockCluster(tx, cluster.id);
        assertClusterTarget(current, input);
        if (current.credentialRefId !== credential.id)
          throw new TaskExecutionError(
            'CLUSTER_CREDENTIAL_CHANGED',
            '验证期间集群凭证已变化，请重新核对。',
            true,
          );
        await this.bindInspection(tx, current, credential.id, observation);
      },
    };
  }

  private async storePreflight(
    tx: Prisma.TransactionClient,
    input: InfrastructureInput,
    preflight: SshPreflight,
    credentialRefId: string | null,
  ): Promise<void> {
    const server = await lockServer(tx, input.targetId);
    assertServerTarget(server, input);
    this.assertSameCredential(server, credentialRefId);
    if (server.machineId && server.machineId !== preflight.machineId)
      throw new TaskExecutionError(
        'SSH_IDENTITY_CHANGED',
        '预检发现机器身份已变化，未覆盖原服务器。',
      );
    const duplicate = await tx.server.findUnique({
      where: { machineId: preflight.machineId },
      select: { id: true },
    });
    if (duplicate && duplicate.id !== server.id)
      throw new TaskExecutionError(
        'SERVER_ALREADY_REGISTERED',
        '这台机器已登记，请使用原服务器入口。',
      );
    await tx.server.update({
      where: { id: server.id },
      data: {
        machineId: preflight.machineId,
        preflightJson: json(preflight),
        preflightAt: new Date(preflight.observedAt),
        connectionStatus: 'connected',
        lastObservedAt: new Date(preflight.observedAt),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    // A previously imported cluster can acquire a Server link after its SSH identity is verified.
    await tx.node.updateMany({
      where: {
        serverId: null,
        present: true,
        snapshotJson: { path: ['machineId'], equals: preflight.machineId },
      },
      data: { serverId: server.id },
    });
  }

  private assertSameCredential(server: Server, reference: string | null): void {
    if (server.credentialRefId !== reference)
      throw new TaskExecutionError(
        'SSH_CREDENTIAL_CHANGED',
        '执行期间 SSH 凭证已更新，将使用当前凭证重新核对。',
        true,
      );
  }

  private async cluster(
    lease: TaskLease,
    input: InfrastructureInput,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    let credentialRefId: string | undefined;
    let payload: Record<string, unknown> | undefined;
    const valid = await this.repository.checkpoint(lease, async (tx) => {
      const cluster = await lockCluster(tx, input.targetId);
      assertClusterTarget(cluster, input);
      const credential = await readCredential(
        tx,
        this.cipher,
        input.candidateCredentialRefId ?? cluster.credentialRefId,
        'kubeconfig',
      );
      credentialRefId = credential.id;
      payload = credential.payload;
      await tx.cluster.update({
        where: { id: cluster.id },
        data: {
          lastAttemptAt: new Date(),
          observationLeaseToken: null,
          observationLeaseExpiresAt: null,
        },
      });
    });
    if (!valid) throw new TaskExecutionError('EXECUTION_LEASE_LOST', '任务租约已失效。', true);
    const connection = kubeConnection(payload!, input.apiEndpoint);
    if (input.acceptedCaFingerprint && connection.caFingerprint !== input.acceptedCaFingerprint)
      throw new TaskExecutionError('KUBERNETES_CA_MISMATCH', '候选 CA 与已确认摘要不一致。');
    if (
      input.expectedCaFingerprint &&
      !input.acceptedCaFingerprint &&
      connection.caFingerprint !== input.expectedCaFingerprint
    )
      throw new TaskExecutionError('KUBERNETES_CA_MISMATCH', '目标 CA 与已绑定指纹不同。');
    const observation = await this.kubernetes.inspect(connection, {
      signal,
      ...(input.expectedKubeSystemUid
        ? {
            expectedIdentity: {
              kubeSystemUid: input.expectedKubeSystemUid,
              ...(!input.acceptedCaFingerprint && input.expectedCaFingerprint
                ? { caFingerprint: input.expectedCaFingerprint }
                : {}),
            },
          }
        : {}),
    });
    return {
      result: {
        check: lease.kind === 'cluster_connect' ? 'cluster-connect' : 'cluster-sync',
        clusterId: input.targetId,
        version: observation.version,
        nodeCount: observation.nodes.length,
        observedAt: observation.observedAt,
      },
      commit: async (tx) => {
        const cluster = await lockCluster(tx, input.targetId);
        assertClusterTarget(cluster, input);
        await readCredential(tx, this.cipher, credentialRefId, 'kubeconfig');
        if (lease.kind === 'cluster_connect')
          await this.bindInspection(tx, cluster, credentialRefId!, observation);
        else {
          if (cluster.credentialRefId !== credentialRefId)
            throw new TaskExecutionError(
              'CLUSTER_CREDENTIAL_CHANGED',
              '凭证已更新，将用当前凭证重新同步。',
              true,
            );
          await storeInspection(tx, cluster.id, observation);
        }
      },
    };
  }

  private async bindInspection(
    tx: Prisma.TransactionClient,
    cluster: Cluster,
    credentialRefId: string,
    observation: KubernetesInspection,
  ): Promise<void> {
    if (cluster.kubeSystemUid && cluster.kubeSystemUid !== observation.identity.kubeSystemUid)
      throw new TaskExecutionError(
        'KUBERNETES_CLUSTER_IDENTITY_MISMATCH',
        '原集群身份不匹配，不能改绑。',
      );
    await tx.cluster.update({
      where: { id: cluster.id },
      data: {
        apiEndpoint: observation.endpoint,
        credentialRefId,
        connectionRevision: { increment: 1 },
        revision: { increment: 1 },
        observationLeaseToken: null,
        observationLeaseExpiresAt: null,
      },
    });
    await storeInspection(tx, cluster.id, observation);
  }

  async failed(
    lease: TaskLease,
    tx: Prisma.TransactionClient,
    code: string,
    message: string,
  ): Promise<void> {
    if (lease.kind === 'diagnostic') return;
    const input = lease.input as InfrastructureInput;
    if (lease.serverId) {
      const server = await tx.server.findUnique({ where: { id: lease.serverId } });
      if (server?.connectionRevision === input.connectionRevision)
        await tx.server.update({
          where: { id: server.id },
          data: {
            lastErrorCode: code,
            lastErrorMessage: message,
            connectionStatus: failureStatus(code),
          },
        });
    }
    if (lease.clusterId) {
      const cluster = await tx.cluster.findUnique({ where: { id: lease.clusterId } });
      if (
        cluster?.connectionRevision ===
        (input.clusterConnectionRevision ?? input.connectionRevision)
      )
        await tx.cluster.update({
          where: { id: cluster.id },
          data: {
            lastErrorCode: code,
            lastErrorMessage: message,
            ...(lease.kind !== 'cluster_connect' || !cluster.kubeSystemUid
              ? { connectionStatus: failureStatus(code) }
              : {}),
          },
        });
    }
  }
}
