import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, type Cluster } from '@ozz/database';
import {
  KubernetesAdapter,
  type KubernetesConnectionInspector,
} from '@ozz/infrastructure/kubernetes';
import { assertWritable, readRecoveryState } from '../recovery.js';
import { SecretCipher } from '../secrets.js';
import { TaskRepository } from '../tasks/repository.js';
import { infrastructureFailure } from './executor.js';
import {
  failureStatus,
  kubeConnection,
  lockCluster,
  readCredential,
  storeInspection,
} from './persistence.js';

interface ObservationLease {
  cluster: Cluster;
  token: string;
  generation: number;
}

/** Independent observation slots keep a slow install or a failed API from blocking other clusters. */
export class ClusterObserver {
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly kubernetes: KubernetesConnectionInspector = new KubernetesAdapter(),
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const state = await readRecoveryState(this.repository.db);
        if (state.restoreLocked || process.env.RESTORE_MODE === 'true') {
          for (const entry of this.active.values()) entry.abort.abort('recovery');
        } else {
          while (this.active.size < 2 && !this.stopping) {
            const lease = await this.claim();
            if (!lease) break;
            if (this.stopping) {
              await this.release(lease);
              break;
            }
            const abort = new AbortController();
            const promise = this.observe(lease, abort.signal).finally(() => {
              if (this.active.get(lease.cluster.id)?.abort === abort)
                this.active.delete(lease.cluster.id);
            });
            this.active.set(lease.cluster.id, { abort, promise });
          }
        }
      } catch {
        // A lost DB/recovery fence cancels in-flight reads. No stale result is published.
        for (const entry of this.active.values()) entry.abort.abort('database_unavailable');
      }
      try {
        await delay(1_000, undefined, { signal: this.abort.signal });
      } catch {
        /* stop */
      }
    }
  }

  private async claim(): Promise<ObservationLease | null> {
    return this.repository.db.$transaction(async (tx) => {
      const state = await assertWritable(tx);
      const excluded = [...this.active.keys()];
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT c."id" FROM "Cluster" c
        WHERE c."kubeSystemUid" IS NOT NULL AND c."credentialRefId" IS NOT NULL
          AND c."apiEndpoint" IS NOT NULL AND c."nextObservationAt" <= CURRENT_TIMESTAMP
          AND (c."observationLeaseExpiresAt" IS NULL OR c."observationLeaseExpiresAt" <= CURRENT_TIMESTAMP)
          AND NOT EXISTS (SELECT 1 FROM "Operation" o WHERE o."clusterId" = c."id" AND o."scope" IN ('server', 'cluster') AND o."status" IN ('queued', 'running'))
          ${excluded.length ? Prisma.sql`AND c."id" NOT IN (${Prisma.join(excluded.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
        ORDER BY c."nextObservationAt" ASC, c."id" ASC
        LIMIT 1 FOR UPDATE OF c SKIP LOCKED
      `);
      if (!rows[0]) return null;
      const token = randomUUID();
      const cluster = await tx.cluster.update({
        where: { id: rows[0].id },
        data: {
          observationLeaseToken: token,
          observationLeaseExpiresAt: new Date(Date.now() + 90_000),
          lastAttemptAt: new Date(),
        },
      });
      return { cluster, token, generation: state.generation };
    });
  }

  private async eligible(
    tx: Prisma.TransactionClient,
    lease: ObservationLease,
  ): Promise<Cluster | null> {
    const state = await assertWritable(tx);
    if (state.generation !== lease.generation) return null;
    const cluster = await lockCluster(tx, lease.cluster.id);
    if (
      cluster.connectionRevision !== lease.cluster.connectionRevision ||
      cluster.credentialRefId !== lease.cluster.credentialRefId ||
      cluster.observationLeaseToken !== lease.token ||
      !cluster.observationLeaseExpiresAt ||
      cluster.observationLeaseExpiresAt <= new Date()
    )
      return null;
    if (
      await tx.operation.count({
        where: {
          clusterId: cluster.id,
          scope: { in: ['server', 'cluster'] },
          status: { in: ['queued', 'running'] },
        },
      })
    )
      return null;
    return cluster;
  }

  private async observe(lease: ObservationLease, signal: AbortSignal): Promise<void> {
    try {
      const credential = await readCredential(
        this.repository.db,
        this.cipher,
        lease.cluster.credentialRefId,
        'kubeconfig',
      );
      const connection = kubeConnection(credential.payload, lease.cluster.apiEndpoint);
      const observation = await this.kubernetes.inspect(connection, {
        signal,
        expectedIdentity: {
          kubeSystemUid: lease.cluster.kubeSystemUid!,
          caFingerprint: lease.cluster.caFingerprint!,
        },
      });
      await this.repository.db.$transaction(async (tx) => {
        const cluster = await this.eligible(tx, lease);
        if (!cluster || signal.aborted) return;
        await readCredential(tx, this.cipher, cluster.credentialRefId, 'kubeconfig');
        await storeInspection(tx, cluster.id, observation);
        await tx.cluster.update({
          where: { id: cluster.id },
          data: { observationLeaseToken: null, observationLeaseExpiresAt: null },
        });
      });
    } catch (error) {
      const failure = infrastructureFailure(error);
      try {
        await this.repository.db.$transaction(async (tx) => {
          const cluster = await this.eligible(tx, lease);
          if (!cluster || signal.aborted) return;
          const failures = cluster.observationFailures + 1;
          const retryMs = Math.min(120_000, 5_000 * 2 ** Math.min(failures - 1, 5));
          await tx.cluster.update({
            where: { id: cluster.id },
            data: {
              connectionStatus: failureStatus(failure.code),
              lastErrorCode: failure.code,
              lastErrorMessage: failure.message,
              observationFailures: failures,
              nextObservationAt: new Date(Date.now() + retryMs + Math.floor(Math.random() * 1_000)),
              observationLeaseToken: null,
              observationLeaseExpiresAt: null,
            },
          });
        });
      } catch {
        /* Lease expiry/recovery reconciles a failed publication. */
      }
    } finally {
      await this.release(lease);
    }
  }

  private async release(lease: ObservationLease): Promise<void> {
    // A new connection or observer may already have replaced this lease.
    try {
      await this.repository.db.$transaction(async (tx) => {
        const state = await assertWritable(tx);
        if (state.generation !== lease.generation) return;
        await tx.cluster.updateMany({
          where: { id: lease.cluster.id, observationLeaseToken: lease.token },
          data: { observationLeaseToken: null, observationLeaseExpiresAt: null },
        });
      });
    } catch {
      /* A recovery lock leaves the bounded lease to expire. */
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort('shutdown');
    for (const entry of this.active.values()) entry.abort.abort('shutdown');
    await this.loop;
    await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
  }
}
