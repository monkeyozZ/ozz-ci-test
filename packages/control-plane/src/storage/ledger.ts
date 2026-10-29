import type { Prisma } from '@ozz/database';
import type {
  StorageBindingIdentity,
  StorageResourceReceipt,
  StorageVolumeObservation,
  StorageWriteIntent,
} from '@ozz/infrastructure/storage';
import { json } from '../services/persistence.js';
import { TaskExecutionError } from '../tasks/contracts.js';
import { STORAGE_OBSERVATION_INTERVAL_MS } from './contracts.js';
import { knownBinding, lockVolume, type VolumeRecord } from './persistence.js';

export interface StorageDataProtection {
  beforeDataWrite?(
    tx: Prisma.TransactionClient,
    volumeId: string,
    pvcUid?: string | null,
  ): Promise<void>;
}
function mismatch(code = 'VOLUME_LEDGER_CHANGED'): never {
  throw new TaskExecutionError(code, '卷的 PVC 身份、数据位置或写入回执已变化，后续操作已停止。');
}
function bindingKey(binding: StorageBindingIdentity): string {
  return JSON.stringify({
    // PostgreSQL JSONB reorders object keys. Compare the data identity, not the
    // insertion order from either the database or the Kubernetes response.
    pvName: binding.pvName,
    pvUid: binding.pvUid,
    nodes: binding.nodes
      .map(({ name, uid }) => ({ name, uid }))
      .sort((a, b) => a.uid.localeCompare(b.uid)),
  });
}
function verifyBinding(
  row: VolumeRecord,
  binding: StorageBindingIdentity | null,
): StorageBindingIdentity | null {
  const stored = knownBinding(row);
  if (stored && binding && bindingKey(stored) !== bindingKey(binding))
    mismatch('VOLUME_DATA_IDENTITY_CHANGED');
  return stored ?? binding;
}
export async function protectVolumeData(
  tx: Prisma.TransactionClient,
  row: VolumeRecord,
  protection: StorageDataProtection,
  pvcUid = row.pvcUid,
): Promise<void> {
  if (!row.database) return;
  if (!protection.beforeDataWrite)
    throw new TaskExecutionError(
      'DATABASE_PROTECTION_UNAVAILABLE',
      '数据库写入保护未配置，不能创建或使用数据卷。',
    );
  await protection.beforeDataWrite(tx, row.id, pvcUid);
}
function matchReceipt(
  row: VolumeRecord,
  value: StorageWriteIntent | StorageResourceReceipt,
  expectedVersion: number,
): void {
  if (
    row.ledgerVersion !== expectedVersion ||
    value.name !== row.pvcName ||
    value.namespace !== row.namespace ||
    value.creationNonce !== row.creationNonce ||
    value.mutationRevision !== row.mutationRevision ||
    (row.storageClassUid && value.storageClassUid && row.storageClassUid !== value.storageClassUid)
  )
    mismatch();
}
export async function beforeStorageWrite(
  tx: Prisma.TransactionClient,
  volumeId: string,
  intent: StorageWriteIntent,
  expectedVersion: number,
  protection: StorageDataProtection,
): Promise<number> {
  const row = await lockVolume(tx, volumeId);
  matchReceipt(row, intent, expectedVersion);
  if (
    row.destroyedAt ||
    intent.expectedUid !== row.pvcUid ||
    (intent.action === 'create' && (row.pvcUid || row.deletionIntentJson)) ||
    (intent.action === 'delete' && !row.deletionIntentJson)
  )
    mismatch();
  if (intent.action === 'create') {
    if (!intent.storageClassUid) mismatch();
    await protectVolumeData(tx, row, protection);
  }
  const binding = verifyBinding(row, intent.binding);
  const changed = await tx.volume.updateMany({
    where: { id: row.id, ledgerVersion: expectedVersion },
    data: {
      ...(intent.action === 'create' ? { creationAttempted: true } : {}),
      ...(intent.storageClassUid ? { storageClassUid: intent.storageClassUid } : {}),
      ...(binding || intent.action === 'create'
        ? {
            receiptJson: json({
              ...(row.receiptJson as object | null),
              binding,
              ...(intent.action === 'create'
                ? {
                    creationMutationRevision:
                      (row.receiptJson as { creationMutationRevision?: number } | null)
                        ?.creationMutationRevision ?? intent.mutationRevision,
                  }
                : {}),
            }),
          }
        : {}),
      ledgerVersion: { increment: 1 },
    },
  });
  if (changed.count !== 1) mismatch();
  return expectedVersion + 1;
}
export async function saveStorageReceipt(
  tx: Prisma.TransactionClient,
  volumeId: string,
  receipt: StorageResourceReceipt,
  expectedVersion: number,
  protection: StorageDataProtection,
): Promise<number> {
  const row = await lockVolume(tx, volumeId);
  matchReceipt(row, receipt, expectedVersion);
  if (
    (row.pvcUid && receipt.uid !== row.pvcUid) ||
    (!row.pvcUid && receipt.uid && !row.creationAttempted) ||
    (receipt.action === 'deleted' && !row.deletionIntentJson) ||
    (receipt.action !== 'deleted' && (!receipt.uid || !receipt.storageClassUid)) ||
    (row.specFingerprint &&
      receipt.specFingerprint &&
      row.specFingerprint !== receipt.specFingerprint)
  )
    mismatch();
  const binding = verifyBinding(row, receipt.binding);
  if (receipt.action !== 'deleted') await protectVolumeData(tx, row, protection, receipt.uid);
  const updated = await tx.volume.updateMany({
    where: { id: row.id, ledgerVersion: expectedVersion },
    data: {
      pvcUid: receipt.uid ?? row.pvcUid,
      resourceVersion: receipt.resourceVersion,
      storageClassUid: receipt.storageClassUid ?? row.storageClassUid,
      specFingerprint: receipt.specFingerprint ?? row.specFingerprint,
      receiptJson: json({
        ...receipt,
        binding,
        creationMutationRevision:
          (row.receiptJson as { creationMutationRevision?: number } | null)
            ?.creationMutationRevision ?? receipt.mutationRevision,
      }),
      ledgerVersion: { increment: 1 },
    },
  });
  if (updated.count !== 1) mismatch();
  return expectedVersion + 1;
}

/** A read never adopts a new PVC UID. It may pin the first verified PV/Node association. */
export async function saveVolumeObservation(
  tx: Prisma.TransactionClient,
  row: VolumeRecord,
  observation: StorageVolumeObservation,
): Promise<void> {
  if (row.pvcUid && observation.pvc.uid && row.pvcUid !== observation.pvc.uid)
    mismatch('VOLUME_DATA_IDENTITY_CHANGED');
  let binding: StorageBindingIdentity | null = null;
  if (
    row.pvcUid &&
    observation.pvc.uid === row.pvcUid &&
    observation.pv &&
    observation.locality === 'verified'
  ) {
    if (observation.pv.claimUid !== row.pvcUid) mismatch('VOLUME_DATA_IDENTITY_CHANGED');
    binding = verifyBinding(row, {
      pvName: observation.pv.name,
      pvUid: observation.pv.uid,
      nodes: observation.nodes.map(({ name, uid }) => ({ name, uid })),
    });
  }
  const stale = observation.state === 'unknown';
  await tx.volume.update({
    where: { id: row.id },
    data: {
      observationJson: json(observation),
      lastObservedAt: new Date(observation.observedAt),
      lastAttemptAt: new Date(),
      observationErrorCode: stale ? (observation.code ?? 'VOLUME_OBSERVATION_UNCERTAIN') : null,
      lastErrorCode: observation.code,
      lastErrorMessage: observation.code ? observation.message : null,
      nextObservationAt: new Date(Date.now() + STORAGE_OBSERVATION_INTERVAL_MS),
      ...(binding && !knownBinding(row)
        ? {
            receiptJson: json({ ...(row.receiptJson as object | null), binding }),
            ledgerVersion: { increment: 1 },
          }
        : {}),
    },
  });
}
