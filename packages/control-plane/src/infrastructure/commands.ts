import { randomUUID } from 'node:crypto';
import { Prisma } from '@ozz/database';
import { parseSshCredential } from '@ozz/infrastructure/ssh';
import { assertWritable } from '../recovery.js';
import { SecretCipher } from '../secrets.js';
import {
  OperationRequestError,
  taskInput,
  type InfrastructureInput,
  type InfrastructureKind,
} from '../tasks/contracts.js';
import {
  TaskRepository,
  type OperationActor,
  type PreparedOperation,
} from '../tasks/repository.js';
import {
  assertClusterTarget,
  assertResourceIdle,
  assertServerTarget,
  json,
  kubeConnection,
  lockCluster,
  lockServer,
  preflightOf,
  readCredential,
  requireRecord,
  requireRevision,
  serverInput,
} from './persistence.js';

export interface ConnectionRequest {
  revision: number;
  credentialRefId?: string;
  apiEndpoint?: string;
  acceptedCaFingerprint?: string;
}

export interface InitializationRequest {
  revision: number;
  clusterId: string;
  nodeName: string;
  apiEndpoint: string;
}

/** Admission commits an immutable intent and its Outbox without doing network I/O. */
export class InfrastructureCommands {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
  ) {}

  serverOperation(
    kind: 'ssh_discover' | 'server_preflight',
    id: string,
    revision: number,
    actor: OperationActor,
    key: unknown,
  ) {
    return this.repository.enqueue(actor, key, { kind, request: { id, revision } }, async (tx) => {
      const server = await lockServer(tx, id);
      requireRevision(server, revision);
      await assertResourceIdle(tx, { serverId: id });
      if (kind !== 'ssh_discover') {
        if (!server.hostKeyFingerprint)
          throw new OperationRequestError(
            409,
            'SSH_TRUST_REQUIRED',
            '请通过独立来源核对并确认 SSH 主机指纹。',
          );
        parseSshCredential(
          (await readCredential(tx, this.cipher, server.credentialRefId, 'ssh')).payload,
        );
      }
      return { input: serverInput(server), serverId: id };
    });
  }

  async trustHostKey(
    id: string,
    input: { revision: number; discoveryOperationId: string; fingerprint: string; source: string },
    actor: OperationActor,
  ): Promise<void> {
    await this.repository.db.$transaction(async (tx) => {
      await assertWritable(tx);
      const server = await lockServer(tx, id);
      requireRevision(server, input.revision);
      await assertResourceIdle(tx, { serverId: id });
      const discovery = requireRecord(
        await tx.operation.findUnique({ where: { id: input.discoveryOperationId } }),
        '指纹发现任务',
      );
      const intent = taskInput(discovery.kind, discovery.input) as InfrastructureInput;
      if (
        discovery.kind !== 'ssh_discover' ||
        discovery.status !== 'succeeded' ||
        discovery.serverId !== id ||
        server.hostKeyDiscoveryOperationId !== discovery.id ||
        intent.connectionRevision !== server.connectionRevision ||
        input.fingerprint !== server.observedHostKeyFingerprint ||
        Date.now() - (server.observedHostKeyAt?.getTime() ?? 0) > 15 * 60_000
      ) {
        throw new OperationRequestError(
          409,
          'SSH_DISCOVERY_CHANGED',
          '指纹发现已过期或目标已变化，请重新发现后核对。',
        );
      }
      if (input.source.trim().length < 5 || input.source.length > 500)
        throw new OperationRequestError(
          422,
          'SSH_TRUST_SOURCE_REQUIRED',
          '请记录核对指纹的独立可信来源，例如 VPS 控制台。',
        );
      await tx.server.update({
        where: { id },
        data: {
          hostKeyFingerprint: input.fingerprint,
          hostKeyAlgorithm: server.observedHostKeyAlgorithm,
          hostKeyTrustedAt: new Date(),
          hostKeyTrustSource: input.source.trim(),
          connectionRevision: { increment: 1 },
          revision: { increment: 1 },
          connectionStatus: 'unverified',
          preflightJson: Prisma.DbNull,
          preflightAt: null,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          requestId: actor.requestId,
          action: 'server.trust_host_key',
          resourceType: 'server',
          resourceId: id,
          outcome: 'succeeded',
          metadata: {
            fingerprint: input.fingerprint,
            previousFingerprint: server.hostKeyFingerprint,
            discoveryOperationId: discovery.id,
            source: input.source.trim(),
          },
        },
      });
    });
  }

  initialize(id: string, request: InitializationRequest, actor: OperationActor, key: unknown) {
    try {
      const endpoint = new URL(request.apiEndpoint);
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== '/'
      )
        throw new Error('invalid');
    } catch {
      throw new OperationRequestError(
        422,
        'INVALID_API_ENDPOINT',
        '初始化 API 地址须使用不含凭证、路径、查询参数或片段的 HTTPS 地址。',
      );
    }
    return this.repository.enqueue(
      actor,
      key,
      { kind: 'server_initialize', request: { id, ...request } },
      async (tx) => {
        const server = await lockServer(tx, id);
        requireRevision(server, request.revision);
        const cluster = await lockCluster(tx, request.clusterId);
        await assertResourceIdle(tx, { serverId: id, clusterId: cluster.id });
        if (!server.hostKeyFingerprint)
          throw new OperationRequestError(
            409,
            'SSH_TRUST_REQUIRED',
            '请先核对并确认 SSH 主机指纹。',
          );
        const preflight = preflightOf(server);
        if (
          !preflight ||
          !server.machineId ||
          !server.preflightAt ||
          Date.now() - server.preflightAt.getTime() > 10 * 60_000 ||
          preflight.machineId !== server.machineId
        ) {
          throw new OperationRequestError(
            409,
            'FRESH_PREFLIGHT_REQUIRED',
            '初始化前需要最近 10 分钟内成功完成的预检。',
          );
        }
        if (preflight.blockers.length)
          throw new OperationRequestError(409, 'SSH_PREFLIGHT_BLOCKED', '请先解决预检中的阻断项。');
        parseSshCredential(
          (await readCredential(tx, this.cipher, server.credentialRefId, 'ssh')).payload,
        );
        if (
          (await tx.project.count({ where: { clusterId: cluster.id } })) ||
          (cluster.kubeSystemUid && cluster.bootstrapServerId !== id)
        ) {
          throw new OperationRequestError(
            409,
            'CLUSTER_NOT_EMPTY',
            '初始化需要无关联项目的空白登记；已有集群请通过凭证接入。',
          );
        }
        let input: InfrastructureInput;
        if (cluster.bootstrapConfig) {
          const original = taskInput(
            'server_initialize',
            cluster.bootstrapConfig,
          ) as InfrastructureInput;
          if (
            cluster.bootstrapServerId !== id ||
            original.expectedMachineId !== server.machineId ||
            original.nodeName !== request.nodeName ||
            original.apiEndpoint !== request.apiEndpoint ||
            (cluster.kubeSystemUid &&
              new URL(cluster.apiEndpoint!).origin !== new URL(request.apiEndpoint).origin)
          )
            throw new OperationRequestError(
              409,
              'INITIALIZATION_INTENT_CHANGED',
              '此集群已有初始化意图，请沿用原机器身份、节点名和 API 地址。',
            );
          // This is a new command, not a retry of an old lease. Keep the installation
          // identity while taking the current connection snapshot; old inputs stay immutable.
          input = {
            ...original,
            ...serverInput(server),
            clusterConnectionRevision: cluster.connectionRevision,
            expectedKubeSystemUid: cluster.kubeSystemUid,
            expectedCaFingerprint: cluster.caFingerprint,
          };
        } else {
          if (preflight.k3s.installed)
            throw new OperationRequestError(
              409,
              'SSH_K3S_ALREADY_INSTALLED',
              '服务器已有 K3s，请使用已有集群接入。',
            );
          if (cluster.credentialRefId || cluster.apiEndpoint)
            throw new OperationRequestError(
              409,
              'CLUSTER_NOT_EMPTY',
              '请选择尚未配置连接信息的空白集群登记。',
            );
          input = {
            ...serverInput(server),
            clusterId: cluster.id,
            clusterConnectionRevision: cluster.connectionRevision,
            installationId: randomUUID(),
            bootstrapCredentialRefId: randomUUID(),
            nodeName: request.nodeName,
            apiEndpoint: request.apiEndpoint,
          };
          await tx.cluster.update({
            where: { id: cluster.id },
            data: {
              bootstrapServerId: id,
              bootstrapConfig: json(input),
              revision: { increment: 1 },
            },
          });
        }
        return { input, serverId: id, clusterId: cluster.id };
      },
    );
  }

  async previewConnection(id: string, request: ConnectionRequest) {
    return this.repository.db.$transaction(async (tx) => {
      const cluster = requireRecord(await tx.cluster.findUnique({ where: { id } }), '集群');
      requireRevision(cluster, request.revision);
      const credential = await readCredential(
        tx,
        this.cipher,
        request.credentialRefId ?? cluster.credentialRefId,
        'kubeconfig',
      );
      const connection = kubeConnection(
        credential.payload,
        request.apiEndpoint ?? cluster.apiEndpoint,
      );
      return {
        apiEndpoint: connection.endpoint,
        caFingerprint: connection.caFingerprint,
        currentCaFingerprint: cluster.caFingerprint,
        requiresCaConfirmation: Boolean(
          cluster.caFingerprint && cluster.caFingerprint !== connection.caFingerprint,
        ),
        credential: connection.credential,
      };
    });
  }

  connect(id: string, request: ConnectionRequest, actor: OperationActor, key: unknown) {
    return this.repository.enqueue(
      actor,
      key,
      { kind: 'cluster_connect', request: { id, ...request } },
      async (tx) => {
        const cluster = await lockCluster(tx, id);
        requireRevision(cluster, request.revision);
        await assertResourceIdle(tx, { clusterId: id });
        if (cluster.bootstrapServerId && !cluster.kubeSystemUid)
          throw new OperationRequestError(
            409,
            'INITIALIZATION_INCOMPLETE',
            '该集群的初始化尚未完成，请继续同一初始化意图后再替换连接。',
          );
        const credential = await readCredential(
          tx,
          this.cipher,
          request.credentialRefId ?? cluster.credentialRefId,
          'kubeconfig',
        );
        const connection = kubeConnection(
          credential.payload,
          request.apiEndpoint ?? cluster.apiEndpoint,
        );
        const caChanged = Boolean(
          cluster.caFingerprint && cluster.caFingerprint !== connection.caFingerprint,
        );
        if (
          (caChanged && request.acceptedCaFingerprint !== connection.caFingerprint) ||
          (request.acceptedCaFingerprint &&
            request.acceptedCaFingerprint !== connection.caFingerprint)
        ) {
          throw new OperationRequestError(
            409,
            'CA_CONFIRMATION_REQUIRED',
            '候选 CA 与已绑定 CA 不同，请先预览并明确确认新的 CA 摘要。',
          );
        }
        const input: InfrastructureInput = {
          targetId: id,
          connectionRevision: cluster.connectionRevision,
          apiEndpoint: connection.endpoint,
          candidateCredentialRefId: credential.id,
          expectedKubeSystemUid: cluster.kubeSystemUid,
          expectedCaFingerprint: cluster.caFingerprint,
          ...(caChanged ? { acceptedCaFingerprint: connection.caFingerprint } : {}),
        };
        return { input, clusterId: id, candidateCredentialRefId: credential.id };
      },
    );
  }

  synchronize(id: string, revision: number, actor: OperationActor, key: unknown) {
    return this.repository.enqueue(
      actor,
      key,
      { kind: 'cluster_sync', request: { id, revision } },
      async (tx) => {
        const cluster = await lockCluster(tx, id);
        requireRevision(cluster, revision);
        await assertResourceIdle(tx, { clusterId: id }, { includeServiceMutations: false });
        if (!cluster.kubeSystemUid || !cluster.caFingerprint || !cluster.apiEndpoint)
          throw new OperationRequestError(409, 'CLUSTER_NOT_CONNECTED', '请先验证集群连接。');
        await readCredential(tx, this.cipher, cluster.credentialRefId, 'kubeconfig');
        return {
          clusterId: id,
          input: {
            targetId: id,
            connectionRevision: cluster.connectionRevision,
            apiEndpoint: cluster.apiEndpoint,
            expectedKubeSystemUid: cluster.kubeSystemUid,
            expectedCaFingerprint: cluster.caFingerprint,
          },
        };
      },
    );
  }

  async retry(id: string, actor: OperationActor, key: unknown) {
    const original = await this.repository.get(id);
    if (original.kind === 'diagnostic') return this.repository.retry(id, actor, key);
    if (original.status !== 'failed')
      throw new OperationRequestError(
        409,
        'OPERATION_NOT_RETRYABLE',
        '仅已失败的任务可以创建重试。',
      );
    const kind = original.kind as InfrastructureKind;
    const input = taskInput(kind, original.input) as InfrastructureInput;
    return this.repository.enqueue(
      actor,
      key,
      { kind, request: { retryOfId: id }, retryOfId: id },
      async (tx) => this.prepareRetry(tx, kind, input),
    );
  }

  private async prepareRetry(
    tx: Prisma.TransactionClient,
    kind: InfrastructureKind,
    input: InfrastructureInput,
  ): Promise<PreparedOperation> {
    if (!kind.startsWith('cluster_')) {
      const server = await lockServer(tx, input.targetId);
      assertServerTarget(server, input);
      await assertResourceIdle(tx, { serverId: server.id, clusterId: input.clusterId });
      if (kind !== 'ssh_discover')
        parseSshCredential(
          (await readCredential(tx, this.cipher, server.credentialRefId, 'ssh')).payload,
        );
      if (input.clusterId) assertClusterTarget(await lockCluster(tx, input.clusterId), input);
      return {
        input,
        serverId: server.id,
        ...(input.clusterId ? { clusterId: input.clusterId } : {}),
      };
    }
    const cluster = await lockCluster(tx, input.targetId);
    assertClusterTarget(cluster, input);
    await assertResourceIdle(
      tx,
      { clusterId: cluster.id },
      { includeServiceMutations: kind !== 'cluster_sync' },
    );
    await readCredential(
      tx,
      this.cipher,
      input.candidateCredentialRefId ?? cluster.credentialRefId,
      'kubeconfig',
    );
    return {
      input,
      clusterId: cluster.id,
      ...(input.candidateCredentialRefId
        ? { candidateCredentialRefId: input.candidateCredentialRefId }
        : {}),
    };
  }
}
