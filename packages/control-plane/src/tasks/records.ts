import { assertBuildsClosed } from './build-gate.js';
import { Prisma, type PrismaClient } from '@ozz/database';
import type { OperationStatus, TaskRef } from './contracts.js';

export type OperationRow = Prisma.OperationGetPayload<Record<string, never>>;
export type DeploymentRow = Prisma.DeploymentGetPayload<Record<string, never>>;
export type OutboxRow = Prisma.OutboxGetPayload<Record<string, never>>;
export type TaskDatabase = Prisma.TransactionClient | PrismaClient;
export type StoredTask =
  | { type: 'operation'; ref: Extract<TaskRef, { type: 'operation' }>; data: OperationRow }
  | { type: 'deployment'; ref: Extract<TaskRef, { type: 'deployment' }>; data: DeploymentRow };

// Only execution columns cross this boundary. Each task's domain record stays
// in its own table and typed admission path; there is no dynamic table input.
export interface TaskCondition {
  id?: string;
  status?: OperationStatus | { in: OperationStatus[] };
  attempts?: number;
  generation?: number;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null | { gt?: Date; lte?: Date };
  cancelRequestedAt?: Date | null;
  OR?: TaskCondition[];
}

export type TaskChanges = Pick<
  Prisma.OperationUpdateManyMutationInput,
  | 'status'
  | 'attempts'
  | 'nextAttemptAt'
  | 'startedAt'
  | 'finishedAt'
  | 'leaseOwner'
  | 'leaseToken'
  | 'leaseExpiresAt'
  | 'cancelRequestedAt'
  | 'errorCode'
  | 'errorMessage'
  | 'logsJson'
  | 'result'
>;

export function taskTable(ref: TaskRef): Prisma.Sql {
  return ref.type === 'operation' ? Prisma.sql`"Operation"` : Prisma.sql`"Deployment"`;
}

export async function readTask(db: TaskDatabase, ref: TaskRef): Promise<StoredTask | null> {
  if (ref.type === 'operation') {
    const data = await db.operation.findUnique({ where: { id: ref.id } });
    return data ? { type: 'operation', ref, data } : null;
  }
  const data = await db.deployment.findUnique({ where: { id: ref.id } });
  return data ? { type: 'deployment', ref, data } : null;
}

/** Service admission and execution always lock Service before its task. */
export async function lockTask(
  tx: Prisma.TransactionClient,
  ref: TaskRef,
): Promise<StoredTask | null> {
  const candidate = await readTask(tx, ref);
  if (!candidate) return null;
  if (candidate.data.serviceId) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Service" WHERE "id" = ${candidate.data.serviceId}::uuid FOR UPDATE`,
    );
  }
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM ${taskTable(ref)} WHERE "id" = ${ref.id}::uuid FOR UPDATE`,
  );
  return readTask(tx, ref);
}

export function updateTask(
  tx: Prisma.TransactionClient,
  ref: TaskRef,
  where: TaskCondition,
  data: TaskChanges,
): Promise<{ count: number }> {
  if (ref.type === 'operation')
    return tx.operation.updateMany({ where: { ...where, id: ref.id }, data });
  return tx.deployment.updateMany({ where: { ...where, id: ref.id }, data });
}

export async function ownsMutationSlot(tx: TaskDatabase, task: StoredTask): Promise<boolean> {
  const input = task.data.input as Record<string, unknown>;
  let volumeIds: string[] = [];
  if (task.type === 'operation' && task.data.kind.startsWith('volume_')) {
    if (typeof input.volumeId !== 'string') return false;
    volumeIds = [input.volumeId];
  } else if (task.type === 'operation' && Array.isArray(input.volumeIds)) {
    volumeIds = input.volumeIds as string[];
  } else if (task.type === 'deployment') {
    volumeIds = (
      await tx.deploymentVolumeReference.findMany({
        where: { deploymentId: task.ref.id },
        select: { volumeId: true },
      })
    ).map((row) => row.volumeId);
  }
  if (
    volumeIds.length &&
    (await tx.volumeMutation.count({
      where: {
        volumeId: { in: volumeIds },
        ...(task.type === 'operation'
          ? { operationId: task.ref.id }
          : { deploymentId: task.ref.id }),
      },
    })) !== volumeIds.length
  )
    return false;
  const serviceId = task.data.serviceId;
  if (!serviceId)
    return (
      task.type === 'operation' &&
      !task.data.kind.startsWith('service_') &&
      !task.data.kind.startsWith('domain_')
    );
  const slot = await tx.serviceMutation.findUnique({ where: { serviceId } });
  return Boolean(
    slot &&
    (task.type === 'operation'
      ? slot.operationId === task.ref.id && slot.deploymentId === null
      : slot.deploymentId === task.ref.id && slot.operationId === null),
  );
}

export async function releaseMutationSlot(
  tx: Prisma.TransactionClient,
  ref: TaskRef,
): Promise<void> {
  await assertBuildsClosed(tx, ref);
  await tx.serviceMutation.deleteMany({
    where: ref.type === 'operation' ? { operationId: ref.id } : { deploymentId: ref.id },
  });
  await tx.volumeMutation.deleteMany({
    where: ref.type === 'operation' ? { operationId: ref.id } : { deploymentId: ref.id },
  });
}

export function outboxTaskRef(
  row: Pick<OutboxRow, 'operationId' | 'deploymentId'>,
): TaskRef | null {
  if (row.operationId && row.deploymentId === null)
    return { type: 'operation', id: row.operationId };
  if (row.deploymentId && row.operationId === null)
    return { type: 'deployment', id: row.deploymentId };
  return null;
}
