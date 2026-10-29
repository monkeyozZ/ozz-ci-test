import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma } from '@ozz/database';
import {
  KubernetesWorkloadAdapter,
  workloadNames,
  type KubernetesWorkloadManager,
  type WorkloadObservation,
  type DatabaseVerification,
} from '@ozz/infrastructure/workload';
import { SecretCipher } from '../secrets.js';
import { TaskRepository } from '../tasks/repository.js';
import {
  SERVICE_OBSERVATION_INTERVAL_MS,
  type ServiceTarget,
  type DeploymentResult,
} from './contracts.js';
import { serviceFailure } from './executor.js';
import { readServiceSnapshot } from './snapshots.js';
import { saveDatabaseVerification } from '../databases/runtime.js';
import { TaskExecutionError } from '../tasks/contracts.js';
import { inventory, json, kubeAccess, serviceInclude, type ServiceRecord } from './persistence.js';

interface ReadFence {
  generation: number;
  installationId: string;
  restoreLocked: boolean;
}
interface Lease {
  service: ServiceRecord;
  token: string;
  fence: ReadFence;
  readOnly: boolean;
}

/** Observation writes only cache real reads. It cannot update intent, resources or publication pointers. */
async function readFence(tx: Prisma.TransactionClient): Promise<ReadFence> {
  const [state] = await tx.$queryRaw<ReadFence[]>(
    Prisma.sql`SELECT "generation", "installationId", "restoreLocked" FROM "ControlPlaneState" WHERE "id" = 'control-plane' FOR SHARE`,
  );
  if (!state) throw new Error('CONTROL_PLANE_STATE_MISSING');
  return state;
}

function targetFor(lease: Lease): ServiceTarget {
  const service = lease.service;
  const cluster = service.environment.project.cluster;
  if (!cluster.kubeSystemUid) throw new Error('CLUSTER_IDENTITY_MISSING');
  const names = workloadNames({ serviceId: service.id, environmentId: service.environmentId });
  return {
    installationId: lease.fence.installationId,
    clusterId: cluster.id,
    kubeSystemUid: cluster.kubeSystemUid,
    projectId: service.environment.projectId,
    environmentId: service.environmentId,
    serviceId: service.id,
    namespace: names.namespace,
    serviceName: names.service,
  };
}

export interface ServiceObserverOptions {
  /** Workload and database reads share a deadline below the 90-second lease. */
  readTimeoutMs?: number;
}

/** Separate read slots keep deployments from blocking runtime health or restore reconciliation. */
export class ServiceObserver {
  private readonly active = new Map<
    string,
    { clusterId: string; abort: AbortController; promise: Promise<void> }
  >();
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopping = false;
  private readonly readTimeoutMs: number;

  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly workload: Pick<
      KubernetesWorkloadManager,
      'observe' | 'verifyDatabase'
    > = new KubernetesWorkloadAdapter(),
    options: ServiceObserverOptions = {},
  ) {
    this.readTimeoutMs = options.readTimeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.readTimeoutMs) ||
      this.readTimeoutMs < 1 ||
      this.readTimeoutMs > 60_000
    )
      throw new RangeError('Service observation readTimeoutMs must be between 1 and 60000.');
  }

  start(): void {
    this.loop ??= this.run();
  }

  private async run() {
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
            if (this.active.get(lease.service.id)?.abort === abort)
              this.active.delete(lease.service.id);
          });
          this.active.set(lease.service.id, {
            clusterId: lease.service.environment.project.cluster.id,
            abort,
            promise,
          });
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

  private claim(): Promise<Lease | null> {
    return this.repository.db.$transaction(async (tx) => {
      const fence = await readFence(tx);
      const readOnly = fence.restoreLocked || process.env.RESTORE_MODE === 'true';
      const excluded = [...this.active.keys()];
      const activeClusters = [
        ...new Set([...this.active.values()].map((entry) => entry.clusterId)),
      ];
      const candidates = (otherClusters: boolean) =>
        tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s."id" FROM "Service" s
        JOIN "Environment" e ON e."id" = s."environmentId"
        JOIN "Project" p ON p."id" = e."projectId"
        JOIN "Cluster" c ON c."id" = p."clusterId"
        WHERE (s."remoteCreatedAt" IS NOT NULL OR s."publishedDeploymentId" IS NOT NULL)
          AND c."kubeSystemUid" IS NOT NULL AND c."credentialRefId" IS NOT NULL
          AND s."nextObservationAt" <= CURRENT_TIMESTAMP
          AND (s."observationLeaseExpiresAt" IS NULL OR s."observationLeaseExpiresAt" <= CURRENT_TIMESTAMP)
          ${readOnly ? Prisma.empty : Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "ServiceMutation" m WHERE m."serviceId" = s."id")`}
          ${excluded.length ? Prisma.sql`AND s."id" NOT IN (${Prisma.join(excluded.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
          ${otherClusters && activeClusters.length ? Prisma.sql`AND c."id" NOT IN (${Prisma.join(activeClusters.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
        ORDER BY s."nextObservationAt" ASC, s."id" ASC LIMIT 1 FOR UPDATE OF s SKIP LOCKED
      `);
      // Prefer a different cluster so many services on a failed API cannot
      // monopolize both read slots. A single cluster can still use both slots.
      let rows = await candidates(true);
      if (!rows.length && activeClusters.length) rows = await candidates(false);
      if (!rows[0]) return null;
      const token = randomUUID();
      const service = await tx.service.update({
        where: { id: rows[0].id },
        data: {
          observationLeaseToken: token,
          observationLeaseExpiresAt: new Date(Date.now() + 90_000),
          lastAttemptAt: new Date(),
        },
        include: serviceInclude,
      });
      return { service, token, fence, readOnly };
    });
  }

  private async eligible(
    tx: Prisma.TransactionClient,
    lease: Lease,
  ): Promise<ServiceRecord | null> {
    const state = await readFence(tx);
    if (
      state.generation !== lease.fence.generation ||
      (state.restoreLocked || process.env.RESTORE_MODE === 'true') !== lease.readOnly
    )
      return null;
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Service" WHERE "id" = ${lease.service.id}::uuid FOR UPDATE`,
    );
    const service = await tx.service.findUnique({
      where: { id: lease.service.id },
      include: serviceInclude,
    });
    if (
      !service ||
      service.observationLeaseToken !== lease.token ||
      !service.observationLeaseExpiresAt ||
      service.observationLeaseExpiresAt <= new Date() ||
      service.mutationRevision !== lease.service.mutationRevision ||
      service.publishedDeploymentId !== lease.service.publishedDeploymentId ||
      service.environmentId !== lease.service.environmentId ||
      (!lease.readOnly && service.activeMutation)
    )
      return null;
    const cluster = service.environment.project.cluster;
    const prior = lease.service.environment.project.cluster;
    if (
      cluster.id !== prior.id ||
      cluster.kubeSystemUid !== prior.kubeSystemUid ||
      cluster.connectionRevision !== prior.connectionRevision ||
      cluster.credentialRefId !== prior.credentialRefId
    )
      return null;
    return service;
  }

  private async observe(lease: Lease, cancellation: AbortSignal) {
    const deadline = AbortSignal.timeout(this.readTimeoutMs);
    const signal = AbortSignal.any([cancellation, deadline]);
    try {
      const target = targetFor(lease);
      const access = await kubeAccess(
        this.repository.db,
        this.cipher,
        lease.service.environment.project.cluster,
        target,
      );
      const snapshotId = lease.service.publishedDeploymentId;
      const names = workloadNames(target, snapshotId ?? undefined);
      const published = lease.service.publishedDeployment
        ?.result as unknown as DeploymentResult | null;
      const knownInventory = await inventory(this.repository.db, target);
      const values = knownInventory.filter(
        (value) =>
          value.kind !== 'Secret' ||
          value.name === names.runtimeSecret ||
          (published?.published?.usesPullSecret && value.name === names.pullSecret),
      );
      const observation = await this.workload.observe(access.connection, access.target, values, {
        signal,
        knownInventory,
      });
      let verification: DatabaseVerification | undefined;
      let databaseError: string | undefined;
      if (lease.service.database && lease.service.desiredState === 'running') {
        try {
          const snapshot = lease.service.publishedDeployment?.snapshotJson
            ? readServiceSnapshot(lease.service.publishedDeployment.snapshotJson)
            : null;
          if (
            snapshot?.version !== 2 ||
            !snapshot.database ||
            !published?.published ||
            !this.workload.verifyDatabase
          ) {
            databaseError = 'DATABASE_AUTHENTICATION_UNAVAILABLE';
          } else {
            const database = snapshot.database;
            verification = await this.workload.verifyDatabase(
              access.connection,
              access.target,
              knownInventory,
              published.published,
              {
                engine: database.engine,
                expectedMajor: database.majorVersion,
                username: database.username,
                databaseName: database.databaseName,
              },
              { signal },
            );
          }
        } catch (error) {
          if (signal.aborted) throw error;
          databaseError = serviceFailure(error).code;
        }
      }
      await this.repository.db.$transaction(async (tx) => {
        const service = await this.eligible(tx, lease);
        if (!service) return;
        signal.throwIfAborted();
        // The latest approved connection must still be usable when publishing a read.
        await kubeAccess(tx, this.cipher, service.environment.project.cluster, target);
        if (verification) await saveDatabaseVerification(tx, service, verification, 'observation');
        else if (databaseError)
          await tx.databaseInstance.updateMany({
            where: { serviceId: service.id },
            data: { observationErrorCode: databaseError },
          });
        await this.save(tx, service, observation);
      });
    } catch (error) {
      if (cancellation.aborted) return;
      const failure = deadline.aborted
        ? new TaskExecutionError(
            'SERVICE_OBSERVATION_TIMEOUT',
            '服务观察超时，保留上次样本并等待下次检查。',
            true,
          )
        : serviceFailure(error);
      try {
        await this.repository.db.$transaction(async (tx) => {
          const service = await this.eligible(tx, lease);
          if (!service || cancellation.aborted) return;
          const failures = service.observationFailures + 1;
          if (service.database)
            await tx.databaseInstance.updateMany({
              where: { serviceId: service.id },
              data: { observationErrorCode: failure.code },
            });
          await tx.service.update({
            where: { id: service.id },
            data: {
              observationErrorCode: failure.code,
              lastErrorCode: failure.code,
              lastErrorMessage: failure.message,
              observationFailures: failures,
              nextObservationAt: new Date(
                Date.now() + Math.min(120_000, 5_000 * 2 ** Math.min(failures - 1, 5)),
              ),
              observationLeaseToken: null,
              observationLeaseExpiresAt: null,
            },
          });
        });
      } catch {
        /* A new target, generation or lease owns subsequent publication. */
      }
    } finally {
      await this.release(lease);
    }
  }

  private async save(
    tx: Prisma.TransactionClient,
    service: ServiceRecord,
    observation: WorkloadObservation,
  ) {
    const drifted = ['missing', 'drifted'].includes(observation.configurationState);
    await tx.service.update({
      where: { id: service.id },
      data: {
        observationJson: json(observation),
        lastObservedAt: new Date(observation.observedAt),
        observationErrorCode: null,
        lastErrorCode: drifted ? 'WORKLOAD_CONFIGURATION_DRIFT' : null,
        lastErrorMessage: drifted ? '实际资源与已发布记录不一致，请核对差异后操作。' : null,
        ...(drifted && service.configurationState === 'consistent'
          ? { configurationState: 'drifted' }
          : {}),
        nextObservationAt: new Date(Date.now() + SERVICE_OBSERVATION_INTERVAL_MS),
        observationFailures: 0,
        observationLeaseToken: null,
        observationLeaseExpiresAt: null,
      },
    });
  }

  private async release(lease: Lease) {
    try {
      await this.repository.db.$transaction(async (tx) => {
        const state = await readFence(tx);
        if (state.generation !== lease.fence.generation) return;
        await tx.service.updateMany({
          where: { id: lease.service.id, observationLeaseToken: lease.token },
          data: { observationLeaseToken: null, observationLeaseExpiresAt: null },
        });
      });
    } catch {
      /* Lease expiry releases an interrupted observation. */
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
