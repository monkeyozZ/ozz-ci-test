import { Prisma, type PrismaClient } from '@ozz/database';
import { requestAuditContext } from './audit';

export class ControlPlaneReadOnlyError extends Error {
  readonly code = 'RESTORE_READ_ONLY';
  constructor() {
    super('控制面正在恢复核对，暂时只允许读取。');
  }
}

export interface RecoveryState {
  restoreLocked: boolean;
  generation: number;
}

export async function readRecoveryState(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<RecoveryState> {
  const state = await db.controlPlaneState.findUnique({ where: { id: 'control-plane' } });
  if (!state) throw new Error('Control plane state has not been initialized');
  return state;
}

/** Hold a shared row lock through the whole mutation, serializing with restore-lock changes. */
export async function assertWritable(tx: Prisma.TransactionClient): Promise<RecoveryState> {
  const [state] = await tx.$queryRaw<RecoveryState[]>(Prisma.sql`
    SELECT "restoreLocked", "generation" FROM "ControlPlaneState"
    WHERE "id" = 'control-plane' FOR SHARE
  `);
  if (!state || state.restoreLocked || process.env.RESTORE_MODE === 'true') {
    throw new ControlPlaneReadOnlyError();
  }
  return state;
}

export function withWritableControlPlane<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await assertWritable(tx);
    const result = await work(tx);
    const audit = requestAuditContext.getStore();
    if (audit) {
      const resource =
        result && typeof result === 'object' && 'data' in result ? result.data : result;
      const createdId =
        resource &&
        typeof resource === 'object' &&
        'id' in resource &&
        typeof resource.id === 'string'
          ? resource.id
          : undefined;
      await tx.auditEvent.create({
        data: { ...audit, resourceId: audit.resourceId ?? createdId, outcome: 'succeeded' },
      });
    }
    return result;
  });
}
