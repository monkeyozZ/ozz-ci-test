import { Prisma, type Cluster, type Server } from '@ozz/database';
import { parseKubeconfig, type KubernetesInspection } from '@ozz/infrastructure/kubernetes';
import type { SshPreflight } from '@ozz/infrastructure/ssh';
import { SecretCipher } from '../secrets.js';
import {
  OperationRequestError,
  TaskExecutionError,
  type InfrastructureInput,
} from '../tasks/contracts.js';

export const activeOperationStatuses = ['queued', 'running'] as const;
export const OBSERVATION_INTERVAL_MS = 30_000;
export const OBSERVATION_STALE_MS = 90_000;

export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function requireRecord<T>(value: T | null, label: string): T {
  if (!value) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', `${label}不存在。`);
  return value;
}

export function requireRevision(value: { revision: number }, revision: number): void {
  if (value.revision !== revision)
    throw new OperationRequestError(409, 'REVISION_CONFLICT', '资源已修改，请刷新后核对最新内容。');
}

export async function lockServer(tx: Prisma.TransactionClient, id: string): Promise<Server> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Server" WHERE "id" = ${id}::uuid FOR UPDATE`);
  return requireRecord(await tx.server.findUnique({ where: { id } }), '服务器');
}

export async function lockCluster(tx: Prisma.TransactionClient, id: string): Promise<Cluster> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Cluster" WHERE "id" = ${id}::uuid FOR UPDATE`);
  return requireRecord(await tx.cluster.findUnique({ where: { id } }), '集群');
}

export async function assertResourceIdle(
  tx: Prisma.TransactionClient,
  target: { serverId?: string; clusterId?: string; credentialRefId?: string },
  options: { includeServiceMutations?: boolean } = {},
): Promise<void> {
  const references: Prisma.OperationWhereInput[] = [];
  if (target.serverId) references.push({ serverId: target.serverId });
  if (target.clusterId) references.push({ clusterId: target.clusterId });
  if (target.credentialRefId) references.push({ candidateCredentialRefId: target.credentialRefId });
  if (!references.length) return;
  if (
    await tx.operation.count({
      where: {
        status: { in: [...activeOperationStatuses] },
        OR: references,
        ...(options.includeServiceMutations === false
          ? { scope: { in: ['server', 'cluster'] } }
          : {}),
      },
    })
  ) {
    throw new OperationRequestError(
      409,
      'RESOURCE_OPERATION_ACTIVE',
      '该资源有在途任务，请等待完成或取消后再修改目标、移除登记。',
    );
  }
  if (
    target.clusterId &&
    options.includeServiceMutations !== false &&
    (await tx.deployment.count({
      where: {
        status: { in: [...activeOperationStatuses] },
        service: { environment: { project: { clusterId: target.clusterId } } },
      },
    }))
  ) {
    throw new OperationRequestError(
      409,
      'RESOURCE_OPERATION_ACTIVE',
      '该集群有在途发布，请待完成或取消后再修改连接、移除登记。',
    );
  }
}

export async function readCredential(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  id: string | null | undefined,
  kind: 'ssh' | 'kubeconfig',
) {
  if (!id)
    throw new OperationRequestError(422, 'CREDENTIAL_REQUIRED', '请先配置此资源的管理凭证。');
  const secret = requireRecord(await tx.secretReference.findUnique({ where: { id } }), '凭证引用');
  if (secret.kind !== kind)
    throw new OperationRequestError(422, 'CREDENTIAL_KIND_MISMATCH', '凭证类型与该资源不匹配。');
  if (secret.expiresAt && secret.expiresAt <= new Date())
    throw new OperationRequestError(422, 'CREDENTIAL_EXPIRED', '凭证已过期，请替换后重试。');
  return {
    id: secret.id,
    revision: secret.revision,
    keyVersion: secret.keyVersion,
    payload: cipher.decrypt(secret),
  };
}

export function serverInput(server: Server): InfrastructureInput {
  return {
    targetId: server.id,
    connectionRevision: server.connectionRevision,
    host: server.host,
    port: server.sshPort,
    username: server.sshUser,
    ...(server.hostKeyFingerprint ? { hostKeyFingerprint: server.hostKeyFingerprint } : {}),
    expectedMachineId: server.machineId,
  };
}

export function assertServerTarget(server: Server, input: InfrastructureInput): void {
  if (
    server.id !== input.targetId ||
    server.host !== input.host ||
    server.sshPort !== input.port ||
    server.sshUser !== input.username ||
    server.connectionRevision !== input.connectionRevision ||
    (input.hostKeyFingerprint && server.hostKeyFingerprint !== input.hostKeyFingerprint) ||
    (input.expectedMachineId && server.machineId !== input.expectedMachineId)
  ) {
    throw new TaskExecutionError(
      'SERVER_TARGET_CHANGED',
      '服务器连接或机器身份已变化，原任务不能改投另一目标。',
    );
  }
}

export function assertClusterTarget(cluster: Cluster, input: InfrastructureInput): void {
  if (
    cluster.id !== (input.clusterId ?? input.targetId) ||
    cluster.connectionRevision !== (input.clusterConnectionRevision ?? input.connectionRevision) ||
    (input.expectedKubeSystemUid && cluster.kubeSystemUid !== input.expectedKubeSystemUid)
  ) {
    throw new TaskExecutionError(
      'CLUSTER_TARGET_CHANGED',
      '集群连接或身份已变化，原任务不能改投另一目标。',
    );
  }
}

export function preflightOf(server: Server): SshPreflight | null {
  return server.preflightJson ? (server.preflightJson as unknown as SshPreflight) : null;
}

export function observationOf(cluster: Cluster): KubernetesInspection | null {
  return cluster.observationJson
    ? (cluster.observationJson as unknown as KubernetesInspection)
    : null;
}

export function observationStale(cluster: Cluster): boolean {
  return (
    !cluster.lastObservedAt ||
    cluster.connectionStatus !== 'connected' ||
    Date.now() - cluster.lastObservedAt.getTime() > OBSERVATION_STALE_MS
  );
}

export function observedConnectionStatus(cluster: {
  connectionStatus: 'unverified' | 'connected' | 'unreachable' | 'unknown';
  lastObservedAt: Date | null;
}) {
  return cluster.connectionStatus === 'connected' &&
    (!cluster.lastObservedAt ||
      Date.now() - cluster.lastObservedAt.getTime() > OBSERVATION_STALE_MS)
    ? 'unknown'
    : cluster.connectionStatus;
}

export function kubeConnection(payload: Record<string, unknown>, endpoint?: string | null) {
  if (
    typeof payload.kubeconfig !== 'string' ||
    Object.keys(payload).some((key) => key !== 'kubeconfig')
  ) {
    throw new OperationRequestError(
      422,
      'KUBECONFIG_INVALID',
      '集群凭证内容必须为 { kubeconfig: 文本 }。',
    );
  }
  return parseKubeconfig(payload.kubeconfig, endpoint ? { endpointOverride: endpoint } : {});
}

/** Called in a fenced transaction only after a complete, validated API inspection. */
export async function storeInspection(
  tx: Prisma.TransactionClient,
  clusterId: string,
  observation: KubernetesInspection,
): Promise<void> {
  const duplicate = await tx.cluster.findUnique({
    where: { kubeSystemUid: observation.identity.kubeSystemUid },
    select: { id: true },
  });
  if (duplicate && duplicate.id !== clusterId)
    throw new TaskExecutionError(
      'CLUSTER_ALREADY_REGISTERED',
      '这个 Kubernetes 集群已经登记，请使用原集群入口。',
    );
  const observedAt = new Date(observation.observedAt);
  const machineIds = observation.nodes
    .map((node) => node.machineId)
    .filter((value): value is string => Boolean(value));
  const servers = await tx.server.findMany({
    where: { machineId: { in: machineIds } },
    select: { id: true, machineId: true },
  });
  const byMachineId = new Map(servers.map((server) => [server.machineId, server.id]));
  // Node names can repeat across clusters or be reused after a rebuild. Only UID is identity.
  for (const node of observation.nodes) {
    const serverId = node.machineId ? (byMachineId.get(node.machineId) ?? null) : null;
    const data = {
      name: node.name,
      serverId,
      snapshotJson: json(node),
      present: true,
      lastObservedAt: observedAt,
    };
    await tx.node.upsert({
      where: { clusterId_uid: { clusterId, uid: node.uid } },
      create: { clusterId, uid: node.uid, ...data },
      update: data,
    });
  }
  await tx.node.updateMany({
    where: { clusterId, uid: { notIn: observation.nodes.map((node) => node.uid) }, present: true },
    data: { present: false, lastObservedAt: observedAt },
  });
  await tx.cluster.update({
    where: { id: clusterId },
    data: {
      kubeSystemUid: observation.identity.kubeSystemUid,
      caFingerprint: observation.identity.caFingerprint,
      observationJson: json(observation),
      connectionStatus: 'connected',
      lastObservedAt: observedAt,
      lastErrorCode: null,
      lastErrorMessage: null,
      observationFailures: 0,
      nextObservationAt: new Date(Date.now() + OBSERVATION_INTERVAL_MS),
    },
  });
}

export function failureStatus(code: string): 'unknown' | 'unreachable' {
  return /UNREACHABLE|CONNECTION_FAILED|TIMEOUT|API_UNAVAILABLE/.test(code)
    ? 'unreachable'
    : 'unknown';
}
