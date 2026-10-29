import { randomUUID } from 'node:crypto';
import { Prisma, type NetworkManagedResource } from '@ozz/database';
import type {
  DomainTarget,
  ManagedNetworkResource,
  NetworkClusterTarget,
  NetworkResourceDescriptor,
  NetworkResourceReceipt,
  NetworkWriteIntent,
} from '@ozz/infrastructure/networking';
import { TaskExecutionError } from '../tasks/contracts.js';
import { json } from '../services/persistence.js';
import type { NetworkingDatabase } from './persistence.js';

export type NetworkOwner = DomainTarget | NetworkClusterTarget;
export interface NetworkRevisionFence {
  domain: number;
  environment: number;
  cluster: number;
}

function invalid(message: string): never {
  throw new TaskExecutionError('NETWORK_RESOURCE_OWNERSHIP_MISMATCH', message);
}

function descriptor(resource: NetworkResourceDescriptor, owner: NetworkOwner): void {
  // Official RBAC names are path segments and commonly contain colons (for example,
  // cert-manager:leaderelection). Keep the existing DNS-like bounds for every other kind.
  const rbac =
    resource.apiVersion === 'rbac.authorization.k8s.io/v1' &&
    ['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'].includes(resource.kind);
  const name = rbac
    ? /^[a-z0-9](?:[a-z0-9.:-]{0,251}[a-z0-9])?$/u
    : /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
  if (
    !/^[a-z0-9./-]{1,100}$/u.test(resource.apiVersion) ||
    !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(resource.kind) ||
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(resource.role) ||
    !name.test(resource.name) ||
    (resource.namespace !== '' &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(resource.namespace)) ||
    !['domain', 'environment', 'cluster'].includes(resource.scope)
  )
    invalid('网络资源登记参数无效。');
  if ('domainId' in owner) {
    if (resource.scope === 'cluster' || resource.namespace !== owner.namespace)
      invalid('域名任务不能写入其他命名空间或集群级资源。');
  } else if (resource.scope !== 'cluster') invalid('集群安装不能登记应用资源。');
}

function key(owner: NetworkOwner, resource: NetworkResourceDescriptor) {
  return {
    clusterId: owner.clusterId,
    kind: resource.kind,
    namespace: resource.namespace,
    name: resource.name,
  };
}

async function lockResource(
  tx: Prisma.TransactionClient,
  owner: NetworkOwner,
  resource: NetworkResourceDescriptor,
): Promise<void> {
  const identity = JSON.stringify(key(owner, resource));
  // Also locks a not-yet-present row. Receipts for multiple resources acquire these in key order.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 657090115))`;
}

export function networkResourceKey(resource: NetworkResourceDescriptor): string {
  return `${resource.kind}/${resource.namespace}/${resource.name}`;
}

function verifyOwner(
  row: NetworkManagedResource,
  owner: NetworkOwner,
  resource: NetworkResourceDescriptor,
): void {
  descriptor(resource, owner);
  const stored = row.targetJson as unknown as Partial<DomainTarget>;
  const fields: Array<keyof DomainTarget> = ['installationId', 'clusterId', 'kubeSystemUid'];
  if (resource.scope !== 'cluster') fields.push('projectId', 'environmentId', 'namespace');
  if (resource.scope === 'domain')
    fields.push('domainId', 'serviceId', 'hostname', 'portId', 'portName');
  if (
    row.clusterId !== owner.clusterId ||
    row.apiVersion !== resource.apiVersion ||
    row.kind !== resource.kind ||
    row.namespace !== resource.namespace ||
    row.name !== resource.name ||
    row.scope !== resource.scope ||
    row.role !== resource.role ||
    fields.some((field) => stored[field] !== (owner as Partial<DomainTarget>)[field]) ||
    (resource.scope === 'domain' && (!('domainId' in owner) || row.domainId !== owner.domainId)) ||
    (resource.scope !== 'domain' && row.domainId !== null)
  )
    invalid('网络资源台账与原归属不匹配，已停止操作。');
}

function present(row: NetworkManagedResource): ManagedNetworkResource {
  return {
    apiVersion: row.apiVersion,
    kind: row.kind,
    namespace: row.namespace,
    name: row.name,
    role: row.role,
    scope: row.scope as ManagedNetworkResource['scope'],
    ledgerVersion: row.ledgerVersion,
    creationNonce: row.creationNonce,
    creationAttempted: row.creationAttempted,
    uid: row.uid,
    resourceVersion: row.resourceVersion,
    revision: row.revision,
    specFingerprint:
      (row.receiptJson as { specFingerprint?: string | null } | null)?.specFingerprint ?? null,
  };
}

/** Resource reservation is durable before any create, including controller-created child Secrets. */
export async function reserveNetworkResource(
  tx: Prisma.TransactionClient,
  owner: NetworkOwner,
  resource: NetworkResourceDescriptor,
  allowCreate: boolean,
): Promise<ManagedNetworkResource> {
  descriptor(resource, owner);
  await lockResource(tx, owner, resource);
  const unique = key(owner, resource);
  let row = await tx.networkManagedResource.findUnique({
    where: { clusterId_kind_namespace_name: unique },
  });
  if (!row) {
    if (!allowCreate) invalid('清理不能为未知资源补建归属记录。');
    row = await tx.networkManagedResource.create({
      data: {
        ...unique,
        apiVersion: resource.apiVersion,
        role: resource.role,
        scope: resource.scope,
        domainId: resource.scope === 'domain' && 'domainId' in owner ? owner.domainId : null,
        targetJson: json(owner),
      },
    });
  }
  verifyOwner(row, owner, resource);
  if (row.deletedAt) {
    if (!allowCreate) invalid('该资源已经确认清理，不能由删除任务重新登记。');
    row = await tx.networkManagedResource.update({
      where: { id: row.id },
      data: {
        creationNonce: randomUUID(),
        creationAttempted: false,
        uid: null,
        resourceVersion: null,
        revision: 0,
        receiptJson: Prisma.DbNull,
        deletedAt: null,
        ledgerVersion: { increment: 1 },
      },
    });
  }
  return present(row);
}

export async function beforeNetworkWrite(
  tx: Prisma.TransactionClient,
  owner: NetworkOwner,
  intent: NetworkWriteIntent,
  revisions: NetworkRevisionFence,
  deleting: boolean,
  expectedLedgerVersion: number | undefined,
): Promise<number> {
  await lockResource(tx, owner, intent);
  const row = await tx.networkManagedResource.findUnique({
    where: { clusterId_kind_namespace_name: key(owner, intent) },
  });
  if (!row) invalid('网络资源尚未登记，不能写入。');
  verifyOwner(row, owner, intent);
  if (row.ledgerVersion !== expectedLedgerVersion)
    throw new TaskExecutionError(
      'NETWORK_OBSERVATION_SUPERSEDED',
      '资源台账已有更新，写入尚未开始，请重新核对后重试。',
      true,
    );
  if (
    row.deletedAt ||
    row.creationNonce !== intent.creationNonce ||
    row.uid !== intent.expectedUid ||
    !Number.isSafeInteger(intent.revision) ||
    intent.revision < row.revision ||
    intent.revision !== revisions[intent.scope] ||
    (deleting
      ? intent.action !== 'delete' || intent.scope !== 'domain'
      : intent.action === 'delete') ||
    (intent.action === 'create' && row.uid !== null) ||
    (intent.action !== 'create' && (!row.uid || !intent.expectedResourceVersion))
  )
    invalid('资源写入身份、版本或动作已失效，已停止后续操作。');
  const updated = await tx.networkManagedResource.update({
    where: { id: row.id },
    data: {
      ...(intent.action === 'create' ? { creationAttempted: true } : {}),
      ledgerVersion: { increment: 1 },
    },
  });
  return updated.ledgerVersion;
}

/** Observers may verify an already attempted create; they cannot adopt a label-only resource. */
export async function saveNetworkReceipt(
  tx: Prisma.TransactionClient,
  owner: NetworkOwner,
  receipt: NetworkResourceReceipt,
  revisions: NetworkRevisionFence,
  expectedLedgerVersion: number | undefined,
  observing = false,
): Promise<number> {
  await lockResource(tx, owner, receipt);
  const row = await tx.networkManagedResource.findUnique({
    where: { clusterId_kind_namespace_name: key(owner, receipt) },
  });
  if (!row) invalid('网络资源回执没有对应的创建前登记。');
  verifyOwner(row, owner, receipt);
  if (row.ledgerVersion !== expectedLedgerVersion)
    throw new TaskExecutionError(
      'NETWORK_OBSERVATION_SUPERSEDED',
      '资源台账已有更新，本次旧回执未保存，请重新观察。',
      true,
    );
  const observedAt = new Date(receipt.observedAt);
  if (
    row.creationNonce !== receipt.creationNonce ||
    (row.uid !== null && row.uid !== receipt.uid) ||
    (!row.creationAttempted && receipt.action !== 'deleted') ||
    (observing && (receipt.action !== 'verified' || row.deletedAt !== null)) ||
    !['created', 'replaced', 'verified', 'deleted'].includes(receipt.action) ||
    (receipt.action !== 'deleted' && (!receipt.uid || !receipt.resourceVersion)) ||
    (receipt.uid !== null && !/^[A-Za-z0-9_-]{1,128}$/u.test(receipt.uid)) ||
    (receipt.resourceVersion !== null &&
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(receipt.resourceVersion)) ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < row.revision ||
    receipt.revision > revisions[receipt.scope] ||
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() > Date.now() + 30_000 ||
    (receipt.specFingerprint !== null && !/^[a-f0-9]{64}$/u.test(receipt.specFingerprint))
  )
    invalid('网络资源回执与原登记身份或版本不匹配。');
  if (row.deletedAt && receipt.action !== 'deleted') invalid('观察不能恢复已经确认删除的资源。');
  const updated = await tx.networkManagedResource.update({
    where: { id: row.id },
    data: {
      uid: receipt.uid,
      resourceVersion: receipt.resourceVersion,
      revision: receipt.revision,
      receiptJson: json(receipt),
      deletedAt: receipt.action === 'deleted' ? observedAt : null,
      ledgerVersion: { increment: 1 },
    },
  });
  return updated.ledgerVersion;
}

export async function networkInventory(
  db: NetworkingDatabase,
  owner: NetworkOwner,
): Promise<ManagedNetworkResource[]> {
  const rows = await db.networkManagedResource.findMany({
    where: {
      clusterId: owner.clusterId,
      deletedAt: null,
      ...('domainId' in owner
        ? {
            OR: [
              { domainId: owner.domainId, scope: 'domain' },
              { scope: 'environment', namespace: owner.namespace },
            ],
          }
        : { scope: 'cluster' }),
    },
    orderBy: [{ kind: 'asc' }, { namespace: 'asc' }, { name: 'asc' }],
    take: 257,
  });
  if (rows.length > 256)
    throw new TaskExecutionError('NETWORK_RESOURCE_LIMIT', '网络资源台账超过本次操作上限。');
  return rows.map((row) => {
    const value = present(row);
    verifyOwner(row, owner, value);
    return value;
  });
}

export async function confirmDomainResourcesRemoved(
  tx: Prisma.TransactionClient,
  domainId: string,
): Promise<void> {
  if (
    await tx.networkManagedResource.count({ where: { domainId, scope: 'domain', deletedAt: null } })
  )
    throw new TaskExecutionError(
      'NETWORK_CLEANUP_INCOMPLETE',
      '仍有未确认删除的域名资源；绑定保留，可继续原清理任务。',
      true,
    );
}
