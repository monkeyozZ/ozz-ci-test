import { Prisma } from '@ozz/database';
import type {
  ManagedWorkloadResource,
  WorkloadResourceReceipt,
  WorkloadWriteIntent,
} from '@ozz/infrastructure/workload';
import { TaskExecutionError } from '../tasks/contracts.js';
import { json } from '../services/persistence.js';
import type { VolumeTarget } from './contracts.js';

export type EnvironmentNamespaceTarget = Omit<VolumeTarget, 'volumeId'>;

function mismatch(): never {
  throw new TaskExecutionError(
    'WORKLOAD_OWNERSHIP_MISMATCH',
    '环境 Namespace 与原登记身份不匹配。',
  );
}
function namespaceTarget(value: unknown, target: EnvironmentNamespaceTarget): void {
  const stored = value as EnvironmentNamespaceTarget | null;
  if (
    !stored ||
    Object.keys(target).some(
      (field) =>
        field !== 'serviceId' &&
        field !== 'serviceName' &&
        field !== 'volumeId' &&
        field !== 'caFingerprint' &&
        stored[field as keyof EnvironmentNamespaceTarget] !==
          target[field as keyof EnvironmentNamespaceTarget],
    )
  )
    mismatch();
}
function resource(row: {
  name: string;
  creationNonce: string;
  creationAttempted: boolean;
  uid: string | null;
  resourceVersion: string | null;
  receiptJson: unknown;
}): ManagedWorkloadResource {
  return {
    kind: 'Namespace',
    name: row.name,
    namespace: null,
    creationNonce: row.creationNonce,
    creationAttempted: row.creationAttempted,
    uid: row.uid,
    resourceVersion: row.resourceVersion,
    mutationRevision: 0,
    specFingerprint: (row.receiptJson as WorkloadResourceReceipt | null)?.specFingerprint ?? null,
  };
}
async function read(tx: Prisma.TransactionClient, target: EnvironmentNamespaceTarget) {
  const row = await tx.managedResource.findUnique({
    where: {
      clusterId_kind_namespace_name: {
        clusterId: target.clusterId,
        kind: 'Namespace',
        namespace: '',
        name: target.namespace,
      },
    },
  });
  if (!row || row.deletedAt || row.environmentId !== target.environmentId || row.serviceId)
    mismatch();
  namespaceTarget(row.targetJson, target);
  return row;
}
/** Both independent volume creation and service publication reuse the environment's one nonce. */
export async function reserveEnvironmentNamespace(
  tx: Prisma.TransactionClient,
  target: EnvironmentNamespaceTarget,
): Promise<ManagedWorkloadResource> {
  await tx.managedResource.upsert({
    where: {
      clusterId_kind_namespace_name: {
        clusterId: target.clusterId,
        kind: 'Namespace',
        namespace: '',
        name: target.namespace,
      },
    },
    create: {
      clusterId: target.clusterId,
      environmentId: target.environmentId,
      serviceId: null,
      kind: 'Namespace',
      namespace: '',
      name: target.namespace,
      targetJson: json({
        installationId: target.installationId,
        clusterId: target.clusterId,
        kubeSystemUid: target.kubeSystemUid,
        projectId: target.projectId,
        environmentId: target.environmentId,
        namespace: target.namespace,
      }),
    },
    update: {},
  });
  return resource(await read(tx, target));
}
export async function environmentNamespaceInventory(
  tx: Prisma.TransactionClient,
  target: EnvironmentNamespaceTarget,
): Promise<ManagedWorkloadResource | null> {
  const exists = await tx.managedResource.count({
    where: {
      clusterId: target.clusterId,
      kind: 'Namespace',
      namespace: '',
      name: target.namespace,
    },
  });
  return exists ? resource(await read(tx, target)) : null;
}
export async function beforeNamespaceWrite(
  tx: Prisma.TransactionClient,
  target: EnvironmentNamespaceTarget,
  intent: WorkloadWriteIntent,
): Promise<void> {
  const row = await read(tx, target);
  if (
    intent.kind !== 'Namespace' ||
    intent.name !== row.name ||
    intent.namespace !== null ||
    intent.mutationRevision !== 0 ||
    intent.creationNonce !== row.creationNonce ||
    intent.expectedUid !== row.uid ||
    intent.action !== 'create'
  )
    mismatch();
  await tx.managedResource.update({ where: { id: row.id }, data: { creationAttempted: true } });
}
export async function saveNamespaceReceipt(
  tx: Prisma.TransactionClient,
  target: EnvironmentNamespaceTarget,
  receipt: WorkloadResourceReceipt,
): Promise<void> {
  const row = await read(tx, target);
  if (
    receipt.kind !== 'Namespace' ||
    receipt.name !== row.name ||
    receipt.namespace !== null ||
    receipt.mutationRevision !== 0 ||
    receipt.creationNonce !== row.creationNonce ||
    !['created', 'verified'].includes(receipt.action) ||
    !receipt.uid ||
    (row.uid ? row.uid !== receipt.uid : !row.creationAttempted)
  )
    mismatch();
  await tx.managedResource.update({
    where: { id: row.id },
    data: {
      uid: receipt.uid,
      resourceVersion: receipt.resourceVersion,
      mutationRevision: 0,
      receiptJson: json(receipt),
    },
  });
}
