import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, type Cluster } from '@ozz/database';
import {
  KubernetesStorageAdapter,
  type KubernetesStorageManager,
} from '@ozz/infrastructure/storage';
import { SecretCipher } from '../secrets.js';
import { json } from '../services/persistence.js';
import { TaskExecutionError } from '../tasks/contracts.js';
import { TaskRepository } from '../tasks/repository.js';
import { STORAGE_OBSERVATION_INTERVAL_MS } from './contracts.js';
import { storageFailure } from './executor.js';
import { saveVolumeObservation } from './ledger.js';
import {
  readStorageAccess,
  volumeInclude,
  volumePlan,
  volumeTarget,
  type StorageCredentialFence,
  type VolumeRecord,
} from './persistence.js';

interface Fence {
  generation: number;
  installationId: string;
  restoreLocked: boolean;
}
interface CommonLease {
  token: string;
  fence: Fence;
  readOnly: boolean;
}
type ReadLease = CommonLease &
  ({ type: 'volume'; row: VolumeRecord } | { type: 'cluster'; row: Cluster });
async function readFence(tx: Prisma.TransactionClient): Promise<Fence> {
  const [state] = await tx.$queryRaw<Fence[]>(Prisma.sql`
    SELECT "generation", "installationId", "restoreLocked" FROM "ControlPlaneState" WHERE "id" = 'control-plane' FOR SHARE
  `);
  if (!state) throw new Error('CONTROL_PLANE_STATE_MISSING');
  return state;
}
function clusterOf(lease: ReadLease): Cluster {
  return lease.type === 'cluster' ? lease.row : lease.row.cluster!;
}
function key(lease: ReadLease) {
  return `${lease.type}:${lease.row.id}`;
}

export interface StorageObserverOptions {
  /** The read deadline stays below the 90-second durable observation lease. */
  readTimeoutMs?: number;
}

/** Separate read leases update observed facts. This observer has no remote mutation methods. */
export class StorageObserver {
  private readonly active = new Map<
    string,
    { clusterId: string; abort: AbortController; promise: Promise<void> }
  >();
  private readonly abort = new AbortController();
  private stopping = false;
  private loop?: Promise<void>;
  private preferVolume = false;
  private readonly readTimeoutMs: number;
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly manager: Pick<
      KubernetesStorageManager,
      'inspect' | 'observe'
    > = new KubernetesStorageAdapter(),
    options: StorageObserverOptions = {},
  ) {
    this.readTimeoutMs = options.readTimeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.readTimeoutMs) ||
      this.readTimeoutMs < 1 ||
      this.readTimeoutMs > 60_000
    )
      throw new RangeError('Storage observation readTimeoutMs must be between 1 and 60000.');
  }
  start(): void {
    this.loop ??= this.run();
  }
  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        while (this.active.size < 2 && !this.stopping) {
          const lease = await this.claim();
          if (!lease) break;
          if (this.stopping) {
            await this.release(lease);
            break;
          }
          const abort = new AbortController();
          const promise = this.observe(lease, abort.signal).finally(() => {
            if (this.active.get(key(lease))?.abort === abort) this.active.delete(key(lease));
          });
          this.active.set(key(lease), { clusterId: clusterOf(lease).id, abort, promise });
        }
      } catch {
        for (const entry of this.active.values()) entry.abort.abort('database_unavailable');
      }
      try {
        await delay(1_000, undefined, { signal: this.abort.signal });
      } catch {
        /* shutdown */
      }
    }
  }
  private async claim(): Promise<ReadLease | null> {
    const preferred = this.preferVolume ? 'volume' : 'cluster';
    this.preferVolume = !this.preferVolume;
    return this.repository.db.$transaction(async (tx) => {
      const fence = await readFence(tx);
      const readOnly = fence.restoreLocked || process.env.RESTORE_MODE === 'true';
      const busy = [...new Set([...this.active.values()].map((entry) => entry.clusterId))];
      const candidate = async (
        type: 'volume' | 'cluster',
        avoidBusy: boolean,
      ): Promise<ReadLease | null> => {
        const rows =
          type === 'cluster'
            ? await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
            SELECT c."id" FROM "Cluster" c WHERE c."kubeSystemUid" IS NOT NULL AND c."credentialRefId" IS NOT NULL
              AND c."storageNextObservationAt" <= CURRENT_TIMESTAMP
              AND (c."storageLeaseExpiresAt" IS NULL OR c."storageLeaseExpiresAt" <= CURRENT_TIMESTAMP)
              ${avoidBusy && busy.length ? Prisma.sql`AND c."id" NOT IN (${Prisma.join(busy.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
            ORDER BY c."storageNextObservationAt", c."id" LIMIT 1 FOR UPDATE OF c SKIP LOCKED
          `)
            : await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
            SELECT v."id" FROM "Volume" v JOIN "Cluster" c ON c."id" = v."clusterId"
            WHERE v."destroyedAt" IS NULL AND v."creationAttempted"
              AND c."kubeSystemUid" IS NOT NULL AND c."credentialRefId" IS NOT NULL
              AND v."nextObservationAt" <= CURRENT_TIMESTAMP
              AND (v."observationLeaseExpiresAt" IS NULL OR v."observationLeaseExpiresAt" <= CURRENT_TIMESTAMP)
              ${readOnly ? Prisma.empty : Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "VolumeMutation" m WHERE m."volumeId" = v."id")`}
              ${avoidBusy && busy.length ? Prisma.sql`AND c."id" NOT IN (${Prisma.join(busy.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
            ORDER BY v."nextObservationAt", v."id" LIMIT 1 FOR UPDATE OF v SKIP LOCKED
          `);
        if (!rows[0]) return null;
        const token = randomUUID();
        if (type === 'cluster')
          return {
            type,
            token,
            fence,
            readOnly,
            row: await tx.cluster.update({
              where: { id: rows[0].id },
              data: {
                storageLeaseToken: token,
                storageLeaseExpiresAt: new Date(Date.now() + 90_000),
                storageLastAttemptAt: new Date(),
              },
            }),
          };
        return {
          type,
          token,
          fence,
          readOnly,
          row: await tx.volume.update({
            where: { id: rows[0].id },
            data: {
              observationLeaseToken: token,
              observationLeaseExpiresAt: new Date(Date.now() + 90_000),
              lastAttemptAt: new Date(),
            },
            include: volumeInclude,
          }),
        };
      };
      for (const avoidBusy of busy.length ? [true, false] : [false])
        for (const type of [preferred, preferred === 'volume' ? 'cluster' : 'volume'] as const) {
          const lease = await candidate(type, avoidBusy);
          if (lease) return lease;
        }
      return null;
    });
  }
  private async eligible(
    tx: Prisma.TransactionClient,
    lease: ReadLease,
    credential?: StorageCredentialFence,
  ): Promise<ReadLease | null> {
    const fence = await readFence(tx);
    if (
      fence.generation !== lease.fence.generation ||
      fence.installationId !== lease.fence.installationId ||
      (fence.restoreLocked || process.env.RESTORE_MODE === 'true') !== lease.readOnly
    )
      return null;
    let current: ReadLease;
    if (lease.type === 'volume') {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Volume" WHERE "id" = ${lease.row.id}::uuid FOR UPDATE`,
      );
      const row = await tx.volume.findUnique({
        where: { id: lease.row.id },
        include: volumeInclude,
      });
      if (
        !row ||
        row.destroyedAt ||
        !row.cluster ||
        row.observationLeaseToken !== lease.token ||
        !row.observationLeaseExpiresAt ||
        row.observationLeaseExpiresAt <= new Date() ||
        row.mutationRevision !== lease.row.mutationRevision ||
        row.ledgerVersion !== lease.row.ledgerVersion ||
        row.pvcUid !== lease.row.pvcUid ||
        row.environmentId !== lease.row.environmentId ||
        (!lease.readOnly && row.activeMutation)
      )
        return null;
      current = { ...lease, row };
    } else {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Cluster" WHERE "id" = ${lease.row.id}::uuid FOR UPDATE`,
      );
      const row = await tx.cluster.findUnique({ where: { id: lease.row.id } });
      if (
        !row ||
        row.storageLeaseToken !== lease.token ||
        !row.storageLeaseExpiresAt ||
        row.storageLeaseExpiresAt <= new Date()
      )
        return null;
      current = { ...lease, row };
    }
    const cluster = clusterOf(current),
      original = clusterOf(lease);
    if (
      cluster.id !== original.id ||
      cluster.kubeSystemUid !== original.kubeSystemUid ||
      cluster.connectionRevision !== original.connectionRevision ||
      cluster.caFingerprint !== original.caFingerprint ||
      cluster.credentialRefId !== original.credentialRefId
    )
      return null;
    if (credential) {
      const secret = await tx.secretReference.findUnique({
        where: { id: credential.credentialRefId },
        select: { revision: true, keyVersion: true },
      });
      if (
        !secret ||
        secret.revision !== credential.credentialRevision ||
        secret.keyVersion !== credential.keyVersion
      )
        return null;
    }
    return current;
  }
  private async observe(lease: ReadLease, cancellation: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(this.readTimeoutMs);
    const signal = AbortSignal.any([cancellation, deadline]);
    let credential: StorageCredentialFence | undefined;
    try {
      const cluster = clusterOf(lease);
      const target = {
        installationId: lease.fence.installationId,
        clusterId: cluster.id,
        kubeSystemUid: cluster.kubeSystemUid!,
      };
      const access = await readStorageAccess(this.repository.db, this.cipher, cluster, target);
      credential = access.credential;
      if (lease.type === 'cluster') {
        const observed = await this.manager.inspect(
          access.connection,
          { ...target, caFingerprint: access.caFingerprint },
          { signal },
        );
        await this.repository.db.$transaction(async (tx) => {
          const current = await this.eligible(tx, lease, credential);
          if (!current) return;
          signal.throwIfAborted();
          await tx.cluster.update({
            where: { id: lease.row.id },
            data: {
              storageCapabilitiesJson: json(observed),
              storageCapabilitiesAt: new Date(observed.observedAt),
              storageErrorCode: null,
              storageNextObservationAt: new Date(Date.now() + STORAGE_OBSERVATION_INTERVAL_MS),
              storageLeaseToken: null,
              storageLeaseExpiresAt: null,
            },
          });
        });
      } else {
        const plan = await volumePlan(this.repository.db, lease.row, access.caFingerprint);
        const observed = await this.manager.observe(access.connection, plan, { signal });
        await this.repository.db.$transaction(async (tx) => {
          const current = await this.eligible(tx, lease, credential);
          if (!current || current.type !== 'volume') return;
          signal.throwIfAborted();
          if (volumeTarget(current.row).installationId !== lease.fence.installationId) return;
          await saveVolumeObservation(tx, current.row, observed);
          await tx.volume.update({
            where: { id: lease.row.id },
            data: { observationLeaseToken: null, observationLeaseExpiresAt: null },
          });
        });
      }
    } catch (error) {
      if (cancellation.aborted) return;
      const failure = deadline.aborted
        ? new TaskExecutionError(
            'STORAGE_OBSERVATION_TIMEOUT',
            '存储观察超时，保留上次样本并等待下次检查。',
            true,
          )
        : storageFailure(error);
      try {
        await this.repository.db.$transaction(async (tx) => {
          const current = await this.eligible(tx, lease, credential);
          if (!current || cancellation.aborted) return;
          if (current.type === 'cluster')
            await tx.cluster.update({
              where: { id: current.row.id },
              data: {
                storageErrorCode: failure.code,
                storageNextObservationAt: new Date(Date.now() + STORAGE_OBSERVATION_INTERVAL_MS),
              },
            });
          else
            await tx.volume.update({
              where: { id: current.row.id },
              data: {
                observationErrorCode: failure.code,
                lastErrorCode: failure.code,
                lastErrorMessage: failure.message,
                nextObservationAt: new Date(Date.now() + STORAGE_OBSERVATION_INTERVAL_MS),
              },
            });
        });
      } catch {
        /* A newer target, generation or observation owns publication. */
      }
    } finally {
      await this.release(lease);
    }
  }
  private async release(lease: ReadLease): Promise<void> {
    try {
      await this.repository.db.$transaction(async (tx) => {
        if ((await readFence(tx)).generation !== lease.fence.generation) return;
        if (lease.type === 'cluster')
          await tx.cluster.updateMany({
            where: { id: lease.row.id, storageLeaseToken: lease.token },
            data: { storageLeaseToken: null, storageLeaseExpiresAt: null },
          });
        else
          await tx.volume.updateMany({
            where: { id: lease.row.id, observationLeaseToken: lease.token },
            data: { observationLeaseToken: null, observationLeaseExpiresAt: null },
          });
      });
    } catch {
      /* Expiry permits recovery after an interrupted read. */
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
