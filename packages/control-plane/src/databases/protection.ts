import { Prisma, type DatabaseInstance } from '@ozz/database';
import { OperationRequestError, TaskExecutionError } from '../tasks/contracts.js';
import type { DatabaseSnapshot } from './contracts.js';

export const databaseProtectedFields = [
  'configuration.image',
  'configuration.replicas',
  'configuration.command',
  'configuration.args',
  'configuration.ports',
  'configuration.environment',
  'volumeMounts',
  'credential',
];

export function databaseSnapshot(database: DatabaseInstance): DatabaseSnapshot {
  if (database.engine !== 'postgresql' && database.engine !== 'redis')
    throw new TaskExecutionError('DATABASE_IDENTITY_INVALID', '数据库引擎身份无效。');
  if (database.templateId !== database.engine)
    throw new TaskExecutionError('DATABASE_IDENTITY_INVALID', '数据库模板身份无效。');
  return {
    version: 1,
    databaseInstanceId: database.id,
    dataVolumeId: database.dataVolumeId,
    engine: database.engine,
    majorVersion: database.majorVersion,
    exactVersion: database.exactVersion,
    image: database.image,
    templateId: database.templateId,
    templateVersion: database.templateVersion,
    dataLayout: database.dataLayout,
    credentialRefId: database.credentialRefId,
    credentialContentRevision: database.credentialContentRevision,
    username: database.username,
    databaseName: database.databaseName,
    redisDatabase: database.redisDatabase,
    protectionRevision: database.protectionRevision,
  };
}

/** Called inside the storage write fence, before any first PVC create request. */
export async function establishDatabaseFence(
  tx: Prisma.TransactionClient,
  volumeId: string,
  pvcUid?: string | null,
): Promise<void> {
  // Storage holds Volume locks first; use this same order at every data boundary.
  const database = await tx.databaseInstance.findUnique({ where: { dataVolumeId: volumeId } });
  if (!database) return;
  const volume = await tx.volume.findUniqueOrThrow({ where: { id: volumeId } });
  const secret = await tx.secretReference.findUnique({ where: { id: database.credentialRefId } });
  if (
    !secret ||
    secret.kind !== 'database' ||
    secret.contentRevision !== database.credentialContentRevision ||
    (secret.expiresAt !== null && secret.expiresAt <= new Date())
  )
    throw new TaskExecutionError(
      'DATABASE_CREDENTIAL_CHANGED',
      '数据库的原初始化凭证不可用，请通过数据维护处理。',
    );
  if (
    (pvcUid && volume.pvcUid && pvcUid !== volume.pvcUid) ||
    (pvcUid && database.initializationPvcUid && pvcUid !== database.initializationPvcUid)
  )
    throw new TaskExecutionError(
      'DATABASE_DATA_PROTECTED',
      '数据库数据卷身份已变化，不能继续初始化。',
    );
  if (!database.initializationFenceAt) {
    await tx.databaseInstance.update({
      where: { id: database.id },
      data: {
        initializationFenceAt: new Date(),
        protectionRevision: { increment: 1 },
        initializationState: 'pending',
        initializationIntentJson: {
          version: 1,
          volumeId,
          pvcName: volume.pvcName,
          engine: database.engine,
          majorVersion: database.majorVersion,
          dataLayout: database.dataLayout,
          credentialRefId: database.credentialRefId,
          credentialContentRevision: database.credentialContentRevision,
        },
        ...(pvcUid ? { initializationPvcUid: pvcUid } : {}),
      },
    });
  } else if (pvcUid && !database.initializationPvcUid) {
    await tx.databaseInstance.update({
      where: { id: database.id },
      data: { initializationPvcUid: pvcUid },
    });
  }
}

/** Same identity check for admission, execution, retries, resume and restart. */
export async function assertDatabaseSnapshot(
  tx: Prisma.TransactionClient,
  serviceId: string,
  candidate: DatabaseSnapshot | null,
): Promise<DatabaseInstance | null> {
  const database = await tx.databaseInstance.findUnique({ where: { serviceId } });
  if (!database && !candidate) return null;
  if (!database || !candidate)
    throw new OperationRequestError(
      409,
      'DATABASE_DATA_PROTECTED',
      '原发布没有当前数据库的数据身份，请重新审阅完整配置。',
    );
  const current = databaseSnapshot(database);
  const protectedKeys: (keyof DatabaseSnapshot)[] = [
    'version',
    'databaseInstanceId',
    'dataVolumeId',
    'engine',
    'majorVersion',
    'exactVersion',
    'image',
    'templateId',
    'templateVersion',
    'dataLayout',
    'credentialRefId',
    'credentialContentRevision',
    'username',
    'databaseName',
    'redisDatabase',
  ];
  if (
    protectedKeys.some((key) => candidate[key] !== current[key]) ||
    candidate.protectionRevision > current.protectionRevision
  )
    throw new OperationRequestError(
      409,
      'DATABASE_DATA_PROTECTED',
      '数据库的密码、引擎版本或数据布局受保护，原配置不能覆盖当前数据身份。',
    );
  const secret = await tx.secretReference.findUnique({ where: { id: database.credentialRefId } });
  if (
    !secret ||
    secret.kind !== 'database' ||
    secret.contentRevision !== database.credentialContentRevision ||
    (secret.expiresAt !== null && secret.expiresAt <= new Date())
  )
    throw new OperationRequestError(
      409,
      'DATABASE_CREDENTIAL_CHANGED',
      '数据库初始化凭证发生变化或不可用，需要独立维护。',
    );
  return database;
}

/** Metadata rename and equivalent encryption under a new master key are allowed. */
export async function assertDatabaseSecretMutation(
  tx: Prisma.TransactionClient,
  secretId: string,
  change: 'delete' | 'payload' | 'metadata' | 'rewrap',
): Promise<void> {
  if (change === 'metadata' || change === 'rewrap') return;
  if (await tx.databaseInstance.count({ where: { credentialRefId: secretId } }))
    throw new OperationRequestError(
      409,
      'DATABASE_DATA_PROTECTED',
      '该凭证仍属于数据库数据身份，不能通过普通凭证操作修改或删除。',
    );
}
