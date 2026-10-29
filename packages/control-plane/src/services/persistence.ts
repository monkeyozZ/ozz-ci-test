import { Prisma, type Cluster, type Service } from '@ozz/database';
import { parseRegistryAccess, type RegistryAccess } from '@ozz/infrastructure/registry';
import {
  workloadNames,
  type ManagedWorkloadResource,
  type WorkloadTarget,
} from '@ozz/infrastructure/workload';
import { kubeConnection, readCredential } from '../infrastructure/persistence.js';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError, TaskExecutionError } from '../tasks/contracts.js';
import {
  SERVICE_RUNTIME_ENV_MAX_BYTES,
  ServiceOperationActiveError,
  type ServiceConfiguration,
  type RuntimeConfiguration,
  type ServiceSnapshot,
  type ServiceTarget,
} from './contracts.js';
import { validateRuntimeConfiguration, validateServiceConfiguration } from './validation.js';
import { currentRegistryCredential } from '../integrations/persistence.js';

export const serviceInclude = {
  environment: { include: { project: { include: { cluster: true } } } },
  activeMutation: { include: { operation: true, deployment: true } },
  publishedDeployment: true,
  lastSuccessfulDeployment: { select: { id: true, finishedAt: true } },
  ports: { orderBy: { name: 'asc' } },
  database: true,
  volumeMounts: { where: { desired: true, detachedAt: null }, select: { readOnly: true } },
  gitSource: { include: { currentRevision: true } },
} satisfies Prisma.ServiceInclude;
export type ServiceRecord = Prisma.ServiceGetPayload<{ include: typeof serviceInclude }>;

export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export async function lockService(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<ServiceRecord> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Service" WHERE "id" = ${id}::uuid FOR UPDATE`);
  const value = await tx.service.findUnique({ where: { id }, include: serviceInclude });
  if (!value) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '服务不存在。');
  return value;
}

export function requireServiceRevision(service: Service, revision: number): void {
  if (service.revision !== revision)
    throw new OperationRequestError(409, 'REVISION_CONFLICT', '服务已修改，请刷新后核对最新配置。');
}

export function requireIdle(service: ServiceRecord): void {
  if (service.activeMutation)
    throw new ServiceOperationActiveError(
      service.activeMutation.deploymentId
        ? { type: 'deployment', id: service.activeMutation.deploymentId }
        : { type: 'operation', id: service.activeMutation.operationId! },
    );
}

export async function currentTarget(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
): Promise<ServiceTarget> {
  const cluster = service.environment.project.cluster;
  if (
    !cluster.kubeSystemUid ||
    !cluster.caFingerprint ||
    !cluster.apiEndpoint ||
    !cluster.credentialRefId
  )
    throw new OperationRequestError(409, 'CLUSTER_NOT_CONNECTED', '请先为项目验证目标集群连接。');
  if (
    await tx.operation.count({
      where: {
        clusterId: cluster.id,
        scope: { in: ['server', 'cluster'] },
        status: { in: ['queued', 'running'] },
        kind: { not: 'cluster_sync' },
      },
    })
  )
    throw new OperationRequestError(
      409,
      'CLUSTER_OPERATION_ACTIVE',
      '集群连接正在变更，请待接入任务完成后发布。',
    );
  const state = await tx.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
  const names = workloadNames({ serviceId: service.id, environmentId: service.environmentId });
  return {
    installationId: state.installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid,
    projectId: service.environment.projectId,
    environmentId: service.environmentId,
    serviceId: service.id,
    namespace: names.namespace,
    serviceName: names.service,
  };
}

export async function assertServiceTarget(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
  target: ServiceTarget,
): Promise<void> {
  const current = await currentTarget(tx, service);
  if (
    Object.keys(current).some(
      (key) => current[key as keyof ServiceTarget] !== target[key as keyof ServiceTarget],
    )
  )
    throw new TaskExecutionError(
      'SERVICE_TARGET_CHANGED',
      '服务归属或集群身份已变化，原任务不能改投其他目标。',
    );
}

async function runtimeSecret(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  id: string,
  key: string,
): Promise<string> {
  const secret = await tx.secretReference.findUnique({ where: { id } });
  if (!secret || secret.kind !== 'generic')
    throw new OperationRequestError(
      422,
      'SERVICE_SECRET_INVALID',
      '环境变量须引用有效的运行期秘密。',
    );
  if (secret.expiresAt && secret.expiresAt <= new Date())
    throw new OperationRequestError(
      422,
      'CREDENTIAL_EXPIRED',
      '运行期秘密已过期，请更新配置后发布。',
    );
  const value = cipher.decrypt(secret)[key];
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 16 * 1024
  )
    throw new OperationRequestError(422, 'SERVICE_SECRET_INVALID', '秘密引用的字段不是有效文本。');
  return value;
}

export function storeConfiguration(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  value: unknown,
  sourceKind?: 'image',
): Promise<ServiceConfiguration>;
export function storeConfiguration(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  value: unknown,
  sourceKind: 'github',
): Promise<RuntimeConfiguration>;
export function storeConfiguration(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  value: unknown,
  sourceKind: 'image' | 'github',
): Promise<ServiceConfiguration | RuntimeConfiguration>;
export async function storeConfiguration(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  value: unknown,
  sourceKind: 'image' | 'github' = 'image',
): Promise<ServiceConfiguration | RuntimeConfiguration> {
  const input =
    sourceKind === 'github'
      ? validateRuntimeConfiguration(value)
      : validateServiceConfiguration(value);
  const environment: ServiceConfiguration['environment'] = [];
  let runtimeBytes = 0;
  for (const variable of input.environment) {
    if (variable.secretRefId) {
      const secretKey = variable.secretKey ?? 'value';
      const plaintext = await runtimeSecret(tx, cipher, variable.secretRefId, secretKey);
      runtimeBytes += Buffer.byteLength(variable.name + plaintext, 'utf8');
      environment.push({ name: variable.name, secretRefId: variable.secretRefId, secretKey });
    } else if (variable.secret) {
      runtimeBytes += Buffer.byteLength(variable.name + variable.value!, 'utf8');
      const secret = await tx.secretReference.create({
        data: {
          name: `服务变量 ${variable.name}`.slice(0, 120),
          kind: 'generic',
          ...cipher.encrypt('generic', { value: variable.value! }),
        },
        select: { id: true },
      });
      environment.push({ name: variable.name, secretRefId: secret.id, secretKey: 'value' });
    } else {
      runtimeBytes += Buffer.byteLength(variable.name + variable.value!, 'utf8');
      environment.push({ name: variable.name, value: variable.value! });
    }
  }
  if (runtimeBytes > SERVICE_RUNTIME_ENV_MAX_BYTES)
    throw new OperationRequestError(
      422,
      'SERVICE_VARIABLES_TOO_LARGE',
      '解密后的环境变量总量最多 24 KiB。',
    );
  return sourceKind === 'github'
    ? validateRuntimeConfiguration({ ...input, environment })
    : validateServiceConfiguration({ ...input, environment });
}

export async function saveConfigurationRelations(
  tx: Prisma.TransactionClient,
  serviceId: string,
  config: RuntimeConfiguration,
): Promise<void> {
  const bound = await tx.domain.findUnique({
    where: { serviceId },
    select: { hostname: true, servicePort: { select: { name: true } } },
  });
  if (
    bound &&
    !config.ports.some((port) => port.name === bound.servicePort.name && port.protocol === 'http')
  )
    throw new OperationRequestError(
      409,
      'DOMAIN_PORT_IN_USE',
      `端口仍绑定域名 ${bound.hostname}，请先完成解绑再删除或修改端口类型。`,
    );
  const refs = [
    ...new Set(
      config.environment.flatMap((variable) =>
        variable.secretRefId ? [variable.secretRefId] : [],
      ),
    ),
  ];
  await tx.serviceSecretReference.deleteMany({
    where: { serviceId, secretRefId: { notIn: refs } },
  });
  if (refs.length)
    await tx.serviceSecretReference.createMany({
      data: refs.map((secretRefId) => ({ serviceId, secretRefId })),
      skipDuplicates: true,
    });
  await tx.servicePort.deleteMany({
    where: { serviceId, name: { notIn: config.ports.map((port) => port.name) } },
  });
  // The deferred numeric-port constraint permits atomic swaps while the
  // service/name key keeps downstream domain references stable.
  for (const port of config.ports)
    await tx.servicePort.upsert({
      where: { serviceId_name: { serviceId, name: port.name } },
      create: { serviceId, ...port },
      update: port,
    });
}

export async function registryAccess(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  referenceId: string | null,
): Promise<RegistryAccess | undefined> {
  if (!referenceId) return undefined;
  const row = await tx.secretReference.findUnique({ where: { id: referenceId } });
  if (!row || row.kind !== 'registry')
    throw new OperationRequestError(422, 'CREDENTIAL_KIND_MISMATCH', '请选择镜像仓库拉取凭证。');
  if (row.expiresAt && row.expiresAt <= new Date())
    throw new OperationRequestError(
      422,
      'CREDENTIAL_EXPIRED',
      '镜像仓库凭证已过期，请替换后重试。',
    );
  return parseRegistryAccess(cipher.decrypt(row));
}

export async function runtimeConfiguration(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  snapshot: ServiceSnapshot,
) {
  const config =
    snapshot.version === 3
      ? validateRuntimeConfiguration(snapshot.configuration)
      : validateServiceConfiguration(snapshot.configuration);
  const environment = await Promise.all(
    config.environment.map(async (variable) => ({
      name: variable.name,
      value: variable.secretRefId
        ? await runtimeSecret(tx, cipher, variable.secretRefId, variable.secretKey ?? 'value')
        : variable.value!,
    })),
  );
  if (Buffer.byteLength(JSON.stringify(environment), 'utf8') > 32 * 1024)
    throw new TaskExecutionError('SERVICE_VARIABLES_TOO_LARGE', '运行期变量超过允许大小。');
  return { ...config, environment };
}

/** Git stop/resume/retry uses the original publication's registry connection. */
export async function snapshotRegistryAccess(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  snapshot: ServiceSnapshot,
  legacyReferenceId: string | null,
) {
  if (snapshot.version !== 3) return registryAccess(tx, cipher, legacyReferenceId);
  const fixed = snapshot.source.revision.destination;
  const current = await currentRegistryCredential(tx, cipher, fixed.registryConnectionId, 'pull');
  if (
    current.connection.authority !== fixed.authority ||
    !fixed.repository.startsWith(`${current.connection.namespace}/`)
  )
    throw new TaskExecutionError('REGISTRY_DESTINATION_CHANGED', '原发布的镜像仓库身份不一致。');
  return current.access;
}

export async function kubeAccess(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  cluster: Cluster,
  target: ServiceTarget,
) {
  if (
    cluster.id !== target.clusterId ||
    cluster.kubeSystemUid !== target.kubeSystemUid ||
    !cluster.caFingerprint ||
    !cluster.apiEndpoint
  )
    throw new TaskExecutionError(
      'SERVICE_TARGET_CHANGED',
      '目标集群身份变化，请重新核对项目归属。',
    );
  const secret = await readCredential(tx, cipher, cluster.credentialRefId, 'kubeconfig');
  const connection = kubeConnection(secret.payload, cluster.apiEndpoint);
  return {
    connection,
    target: { ...target, caFingerprint: cluster.caFingerprint } satisfies WorkloadTarget,
  };
}

export async function inventory(
  tx: Prisma.TransactionClient,
  target: ServiceTarget,
): Promise<ManagedWorkloadResource[]> {
  const rows = await tx.managedResource.findMany({
    where: {
      clusterId: target.clusterId,
      deletedAt: null,
      OR: [
        { serviceId: target.serviceId },
        { kind: 'Namespace', environmentId: target.environmentId },
      ],
    },
  });
  return rows.map((row) => ({
    kind: row.kind as ManagedWorkloadResource['kind'],
    name: row.name,
    namespace: row.namespace || null,
    creationNonce: row.creationNonce,
    creationAttempted: row.creationAttempted,
    uid: row.uid,
    resourceVersion: row.resourceVersion,
    mutationRevision: row.mutationRevision,
    specFingerprint:
      (row.receiptJson as { specFingerprint?: string | null } | null)?.specFingerprint ?? null,
  }));
}
