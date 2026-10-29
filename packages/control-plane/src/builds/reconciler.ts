import { setTimeout as delay } from 'node:timers/promises';
import {
  BuilderError,
  parseBuildRunSpec,
  type BuilderClient,
  type BuilderTlsConnection,
} from '@ozz/infrastructure/build';
import type { SecretCipher } from '../secrets.js';
import { assertWritable, readRecoveryState } from '../recovery.js';
import { currentBuilderAccess } from './access.js';
import { BuildRepository } from './repository.js';
import type { TaskRepository } from '../tasks/repository.js';

/** Reconciliation can only observe/cancel an existing run; it cannot submit, grant, or start work. */
export class BuildReconciler {
  readonly records: BuildRepository;
  private loop: Promise<void> | undefined;
  private readonly abort = new AbortController();
  constructor(
    readonly tasks: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly clientFactory?: (connection: BuilderTlsConnection) => BuilderClient,
  ) {
    this.records = new BuildRepository(tasks);
  }
  start(): void {
    if (!this.loop) this.loop = this.run();
  }
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }
  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.tick();
      } catch {
        /* Durable open state and slots survive a dependency outage. */
      }
      try {
        await delay(1000, undefined, { signal: this.abort.signal });
      } catch {
        break;
      }
    }
  }
  async tick(): Promise<void> {
    const state = await readRecoveryState(this.tasks.db);
    if (state.restoreLocked || process.env.RESTORE_MODE === 'true') return;
    const now = new Date();
    const rows = await this.tasks.db.buildRun.findMany({
      where: {
        executionClosedAt: null,
        nextReconcileAt: { lte: now },
        OR: [
          { cancelRequestedAt: { not: null } },
          { deployment: { cancelRequestedAt: { not: null } } },
          { deployment: { generation: { not: state.generation } } },
          { deployment: { leaseExpiresAt: { lte: now } } },
          { deployment: { leaseExpiresAt: null } },
        ],
      },
      orderBy: [{ nextReconcileAt: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    for (const row of rows) {
      if (this.abort.signal.aborted) return;
      const lease = await this.records.acquire(row.id);
      if (!lease) continue;
      try {
        if (await this.records.closeUnsubmitted(lease)) {
          await this.tasks.recoverTask({ type: 'deployment', id: row.deploymentId });
          continue;
        }
        const access = await this.tasks.db.$transaction(async (tx) => {
          await assertWritable(tx);
          return currentBuilderAccess(
            tx,
            this.cipher,
            row.builderId,
            row.builderInstanceId,
            this.clientFactory,
          );
        });
        const spec = parseBuildRunSpec(row.specJson);
        let observation = await access.client.get(row.id, this.abort.signal);
        if (
          observation &&
          (observation.specHash !== row.specHash ||
            observation.builderInstanceId !== row.builderInstanceId ||
            observation.installationId !== spec.installationId)
        )
          throw new BuilderError('BUILD_IDENTITY_MISMATCH');
        if (!observation?.proof) {
          const epoch = await this.records.cancellationEpoch(lease, observation);
          // An unknown GET is not proof of non-submission; a durable cancel tombstone closes that race.
          observation = await access.client.cancel(
            row.id,
            { specHash: row.specHash, epoch, reason: 'cancelled' },
            this.abort.signal,
          );
        }
        const events = await access.client
          .events(row.id, row.afterSequence.toString(), this.abort.signal)
          .catch(() => undefined);
        await this.records.save(lease, observation, events);
        if (observation.proof)
          await this.tasks.recoverTask({ type: 'deployment', id: row.deploymentId });
      } catch (error) {
        await this.records.unknown(
          lease,
          error instanceof BuilderError ? error.code : 'BUILD_OBSERVATION_UNKNOWN',
        );
      }
    }
    await this.tasks.db.$transaction(async (tx) => {
      await assertWritable(tx);
      await tx.buildLogChunk.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    });
  }
}
