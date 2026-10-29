import type { Cluster, Prisma } from '@ozz/database';
import type {
  DomainDnsObservation,
  DomainTarget,
  NetworkClusterTarget,
  NetworkDomainObservation,
  NetworkDomainPlan,
  ManagedNetworkResource,
} from '@ozz/infrastructure/networking';
import { kubeConnection, readCredential } from '../infrastructure/persistence.js';
import { SecretCipher } from '../secrets.js';
import { assertServiceTarget, json, type ServiceRecord } from '../services/persistence.js';
import {
  domainOperationInput,
  TaskExecutionError,
  type DomainOperationInput,
} from '../tasks/contracts.js';
import { NETWORK_OBSERVATION_INTERVAL_MS } from './contracts.js';
import {
  networkInventory,
  networkResourceKey,
  saveNetworkReceipt,
  type NetworkRevisionFence,
} from './ledger.js';
import {
  readClusterNetworking,
  readPlatformSettings,
  requireDomain,
  type DomainRecord,
  type NetworkingDatabase,
} from './persistence.js';

export interface NetworkCredentialFence {
  clusterConnectionRevision: number;
  credentialRefId: string;
  credentialRevision: number;
  keyVersion: number;
}

export async function readNetworkAccess(
  db: NetworkingDatabase,
  cipher: SecretCipher,
  cluster: Cluster,
  target: Pick<DomainTarget, 'clusterId' | 'kubeSystemUid'>,
) {
  if (
    cluster.id !== target.clusterId ||
    cluster.kubeSystemUid !== target.kubeSystemUid ||
    !cluster.apiEndpoint ||
    !cluster.caFingerprint ||
    !cluster.credentialRefId
  )
    throw new TaskExecutionError(
      'NETWORK_TARGET_CHANGED',
      '集群身份或连接已经变化，不能改投原网络任务。',
    );
  const credential = await readCredential(db, cipher, cluster.credentialRefId, 'kubeconfig');
  const connection = kubeConnection(credential.payload, cluster.apiEndpoint);
  if (connection.caFingerprint !== cluster.caFingerprint)
    throw new TaskExecutionError(
      'NETWORK_TARGET_CHANGED',
      '当前凭证的 CA 与已经验证的集群不一致。',
    );
  return {
    connection,
    caFingerprint: cluster.caFingerprint,
    credential: {
      clusterConnectionRevision: cluster.connectionRevision,
      credentialRefId: credential.id,
      credentialRevision: credential.revision,
      keyVersion: credential.keyVersion,
    } satisfies NetworkCredentialFence,
  };
}

export async function assertNetworkCredential(
  db: NetworkingDatabase,
  cluster: Cluster,
  credential: NetworkCredentialFence,
): Promise<void> {
  const row = await db.secretReference.findUnique({
    where: { id: credential.credentialRefId },
    select: { kind: true, revision: true, keyVersion: true, expiresAt: true },
  });
  if (
    cluster.connectionRevision !== credential.clusterConnectionRevision ||
    cluster.credentialRefId !== credential.credentialRefId ||
    !row ||
    row.kind !== 'kubeconfig' ||
    row.revision !== credential.credentialRevision ||
    row.keyVersion !== credential.keyVersion ||
    (row.expiresAt && row.expiresAt <= new Date())
  )
    throw new TaskExecutionError(
      'NETWORK_CREDENTIAL_CHANGED',
      '执行期间管理凭证已经变化；后续写入停止，重试将读取当前凭证。',
      true,
    );
}

export function storedDomainInput(
  domain: DomainRecord,
  platformRevision: number,
  networkRevision: number,
): DomainOperationInput {
  return domainOperationInput({
    domainId: domain.id,
    hostname: domain.hostname,
    serviceId: domain.serviceId,
    serviceMutationRevision: domain.service.mutationRevision,
    domainRevision: domain.revision,
    platformRevision,
    networkRevision,
    certificateEnvironment: domain.certificateEnvironment,
    target: domain.targetJson,
  });
}

export async function requireDomainIntent(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
  input: DomainOperationInput,
  deleting: boolean,
) {
  const domain = await requireDomain(tx, input.domainId);
  const stored = domain.targetJson as unknown as DomainTarget;
  if (
    service.id !== input.serviceId ||
    domain.serviceId !== service.id ||
    service.mutationRevision !== input.serviceMutationRevision ||
    domain.revision !== input.domainRevision ||
    domain.hostname !== input.hostname ||
    domain.servicePortId !== input.target.portId ||
    domain.desiredState !== (deleting ? 'deleting' : 'active') ||
    domain.certificateEnvironment !== input.certificateEnvironment ||
    Object.keys(input.target).some(
      (key) => input.target[key as keyof DomainTarget] !== stored?.[key as keyof DomainTarget],
    )
  )
    throw new TaskExecutionError(
      'DOMAIN_TASK_SUPERSEDED',
      '服务或域名已有后续变更，原任务不能覆盖当前意图。',
    );
  await assertServiceTarget(tx, service, input.target);
  const settings = await readPlatformSettings(tx);
  const network = await readClusterNetworking(tx, input.target.clusterId, settings);
  if (
    settings.revision !== input.platformRevision ||
    network.revision !== input.networkRevision ||
    !settings.acmeEmail
  )
    throw new TaskExecutionError(
      'NETWORK_SETTINGS_CHANGED',
      '原任务的入口或签发设置已经变化，请核对当前配置。',
    );
  return { domain, settings, network };
}

export async function domainPlan(
  db: NetworkingDatabase,
  input: DomainOperationInput,
  taskId: string,
  caFingerprint: string,
  acmeEmail: string,
): Promise<NetworkDomainPlan> {
  return {
    target: { ...input.target, caFingerprint },
    revision: input.domainRevision,
    platformRevision: input.platformRevision,
    taskId,
    acmeEmail,
    certificateEnvironment: input.certificateEnvironment,
    reconcileMissing: false,
    inventory: await networkInventory(db, input.target),
  };
}

export function networkRevisions(input: DomainOperationInput): NetworkRevisionFence {
  return { domain: input.domainRevision, environment: input.platformRevision, cluster: 1 };
}

export interface DomainObservationSample {
  dns?: DomainDnsObservation;
  network?: NetworkDomainObservation;
  failure?: { code: string; message: string };
  inventory?: readonly ManagedNetworkResource[];
}

/** DNS can be cached independently when the cluster is unavailable; stale route data is retained. */
export async function saveDomainSample(
  tx: Prisma.TransactionClient,
  domain: DomainRecord,
  input: DomainOperationInput,
  sample: DomainObservationSample,
): Promise<void> {
  const receipts = [...(sample.network?.verifiedResources ?? [])].sort((a, b) =>
    networkResourceKey(a).localeCompare(networkResourceKey(b)),
  );
  const versions = new Map(
    sample.inventory?.map((row) => [networkResourceKey(row), row.ledgerVersion]),
  );
  for (const receipt of receipts)
    await saveNetworkReceipt(
      tx,
      input.target,
      receipt,
      networkRevisions(input),
      versions.get(networkResourceKey(receipt)),
      true,
    );
  const route = sample.network?.route;
  const certificate = sample.network?.certificate;
  const diagnostic =
    sample.failure ??
    (route && ['drifted', 'missing', 'unknown'].includes(route.state) && route.code
      ? { code: route.code, message: route.message }
      : certificate &&
          ['failed', 'expired', 'unknown'].includes(certificate.state) &&
          certificate.code
        ? { code: certificate.code, message: certificate.message }
        : null);
  const times = [sample.dns?.observedAt, route?.observedAt, certificate?.observedAt].map((value) =>
    value ? Date.parse(value) : NaN,
  );
  const complete = times.every((time) => Number.isFinite(time) && time <= Date.now() + 30_000);
  await tx.domain.update({
    where: { id: domain.id },
    data: {
      ...(sample.dns ? { dnsJson: json(sample.dns) } : {}),
      ...(route ? { routeJson: json(route) } : {}),
      ...(certificate ? { certificateJson: json(certificate) } : {}),
      ...(sample.failure
        ? { observationErrorCode: sample.failure.code }
        : sample.network
          ? { observationErrorCode: null }
          : {}),
      ...(complete ? { lastObservedAt: new Date(Math.min(...times)) } : {}),
      lastAttemptAt: new Date(),
      lastErrorCode: diagnostic?.code ?? null,
      lastErrorMessage: diagnostic?.message ?? null,
      nextObservationAt: new Date(
        Date.now() + (sample.failure ? 60_000 : NETWORK_OBSERVATION_INTERVAL_MS),
      ),
      observationLeaseToken: null,
      observationLeaseExpiresAt: null,
    },
  });
}

export function networkClusterTarget(
  cluster: Cluster,
  installationId: string,
): NetworkClusterTarget {
  if (!cluster.kubeSystemUid || !cluster.caFingerprint)
    throw new TaskExecutionError('NETWORK_TARGET_CHANGED', '集群尚未完成身份验证。');
  return {
    installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid,
    caFingerprint: cluster.caFingerprint,
  };
}
