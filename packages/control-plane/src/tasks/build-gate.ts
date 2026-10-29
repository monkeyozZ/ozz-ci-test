import type { Prisma } from '@ozz/database';
import type { TaskRef } from './contracts.js';

/** Caller holds the Deployment row lock. Both retry and terminal transitions use this gate. */
export async function closeBuildsBeforeTransition(
  tx: Prisma.TransactionClient,
  ref: TaskRef,
  reason:
    'cancelled_before_submission' | 'rejected_before_submission' = 'rejected_before_submission',
): Promise<boolean> {
  if (ref.type !== 'deployment') return true;
  await tx.$queryRaw`SELECT id FROM "BuildRun" WHERE "deploymentId" = ${ref.id}::uuid AND "executionClosedAt" IS NULL ORDER BY id FOR UPDATE`;
  const now = new Date();
  await tx.buildRun.updateMany({
    where: {
      deploymentId: ref.id,
      executionClosedAt: null,
      executionState: 'prepared',
      submissionAttemptedAt: null,
    },
    data: { executionState: 'never_submitted', executionClosedAt: now, closureReason: reason },
  });
  const open = await tx.buildRun.updateMany({
    where: { deploymentId: ref.id, executionClosedAt: null },
    data: { cancelRequestedAt: now, nextReconcileAt: now },
  });
  if (!open.count) return true;
  await tx.deployment.update({
    where: { id: ref.id },
    data: {
      errorCode: 'BUILD_TERMINATION_PENDING',
      errorMessage: '构建仍可能执行，正在等待 Builder 的可信结束证明。',
    },
  });
  return false;
}

/** Last line of application defence; deferred SQL constraints also protect raw SQL callers. */
export async function assertBuildsClosed(
  tx: Prisma.TransactionClient,
  ref: TaskRef,
): Promise<void> {
  if (
    ref.type === 'deployment' &&
    (await tx.buildRun.count({ where: { deploymentId: ref.id, executionClosedAt: null } }))
  )
    throw new Error('BUILD_TERMINATION_PENDING');
}
