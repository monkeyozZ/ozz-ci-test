import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma } from '@ozz/database';
import {
  NodeDomainDnsInspector,
  type DomainDnsInspector,
  type KubernetesNetworkingManager,
  type ManagedNetworkResource,
} from '@ozz/infrastructure/networking';
import { workloadNames } from '@ozz/infrastructure/workload';
import { SecretCipher } from '../secrets.js';
import { TaskExecutionError, type DomainOperationInput } from '../tasks/contracts.js';
import { TaskRepository } from '../tasks/repository.js';
import {
  assertNetworkCredential,
  domainPlan,
  readNetworkAccess,
  saveDomainSample,
  storedDomainInput,
  type DomainObservationSample,
  type NetworkCredentialFence,
} from './execution-context.js';
import { networkingFailure } from './executor.js';
import {
  domainInclude,
  readClusterNetworking,
  readPlatformSettings,
  type DomainRecord,
} from './persistence.js';

interface ReadFence {
  generation: number;
  installationId: string;
  restoreLocked: boolean;
}
interface DomainReadLease {
  token: string;
  domain: DomainRecord;
  fence: ReadFence;
  readOnly: boolean;
  settings: Awaited<ReturnType<typeof readPlatformSettings>>;
  network: Awaited<ReturnType<typeof readClusterNetworking>>;
}

async function readFence(tx: Prisma.TransactionClient): Promise<ReadFence> {
  const [state] = await tx.$queryRaw<ReadFence[]>(Prisma.sql`
    SELECT "generation", "installationId", "restoreLocked"
    FROM "ControlPlaneState" WHERE "id" = 'control-plane' FOR SHARE
  `);
  if (!state) throw new Error('CONTROL_PLANE_STATE_MISSING');
  return state;
}

/** Separate read leases refresh DNS/route/certificate caches; this object has no remote write capability. */
export class DomainObserver {
  private readonly active = new Map<
    string,
    { clusterId: string; abort: AbortController; promise: Promise<void> }
  >();
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly manager: Pick<KubernetesNetworkingManager, 'observe'>,
    private readonly dns: DomainDnsInspector = new NodeDomainDnsInspector(),
  ) {}

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
            if (this.active.get(lease.domain.id)?.abort === abort)
              this.active.delete(lease.domain.id);
          });
          this.active.set(lease.domain.id, {
            clusterId: lease.domain.service.environment.project.clusterId,
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

  private claim(): Promise<DomainReadLease | null> {
    return this.repository.db.$transaction(async (tx) => {
      const fence = await readFence(tx);
      const readOnly = fence.restoreLocked || process.env.RESTORE_MODE === 'true';
      const excluded = [...this.active.keys()];
      const activeClusters = [
        ...new Set([...this.active.values()].map((entry) => entry.clusterId)),
      ];
      const candidates = (otherClusters: boolean) =>
        tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT d."id" FROM "Domain" d
        JOIN "Service" s ON s."id" = d."serviceId"
        JOIN "Environment" e ON e."id" = s."environmentId"
        JOIN "Project" p ON p."id" = e."projectId"
        JOIN "Cluster" c ON c."id" = p."clusterId"
        WHERE d."desiredState" = 'active'
          AND c."kubeSystemUid" IS NOT NULL AND c."credentialRefId" IS NOT NULL
          AND d."nextObservationAt" <= CURRENT_TIMESTAMP
          AND (d."observationLeaseExpiresAt" IS NULL OR d."observationLeaseExpiresAt" <= CURRENT_TIMESTAMP)
          ${readOnly ? Prisma.empty : Prisma.sql`AND NOT EXISTS (SELECT 1 FROM "ServiceMutation" m WHERE m."serviceId" = s."id")`}
          ${excluded.length ? Prisma.sql`AND d."id" NOT IN (${Prisma.join(excluded.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
          ${otherClusters && activeClusters.length ? Prisma.sql`AND c."id" NOT IN (${Prisma.join(activeClusters.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
        ORDER BY d."nextObservationAt" ASC, d."id" ASC LIMIT 1 FOR UPDATE OF d SKIP LOCKED
      `);
      let rows = await candidates(true);
      if (!rows.length && activeClusters.length) rows = await candidates(false);
      if (!rows[0]) return null;
      const token = randomUUID();
      const domain = await tx.domain.update({
        where: { id: rows[0].id },
        data: {
          observationLeaseToken: token,
          observationLeaseExpiresAt: new Date(Date.now() + 90_000),
          lastAttemptAt: new Date(),
        },
        include: domainInclude,
      });
      const settings = await readPlatformSettings(tx);
      const network = await readClusterNetworking(
        tx,
        domain.service.environment.project.clusterId,
        settings,
      );
      return { token, domain, fence, readOnly, settings, network };
    });
  }

  private async eligible(
    tx: Prisma.TransactionClient,
    lease: DomainReadLease,
  ): Promise<DomainRecord | null> {
    const state = await readFence(tx);
    if (
      state.generation !== lease.fence.generation ||
      state.installationId !== lease.fence.installationId ||
      (state.restoreLocked || process.env.RESTORE_MODE === 'true') !== lease.readOnly
    )
      return null;
    // Match command lock order: Service, then Domain. An older observation cannot publish over a new intent.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Service" WHERE "id" = ${lease.domain.serviceId}::uuid FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Domain" WHERE "id" = ${lease.domain.id}::uuid FOR UPDATE`,
    );
    const current = await tx.domain.findUnique({
      where: { id: lease.domain.id },
      include: domainInclude,
    });
    if (
      !current ||
      current.observationLeaseToken !== lease.token ||
      !current.observationLeaseExpiresAt ||
      current.observationLeaseExpiresAt <= new Date() ||
      current.desiredState !== 'active' ||
      current.revision !== lease.domain.revision ||
      current.hostname !== lease.domain.hostname ||
      current.serviceId !== lease.domain.serviceId ||
      current.service.mutationRevision !== lease.domain.service.mutationRevision ||
      current.service.environmentId !== lease.domain.service.environmentId ||
      (!lease.readOnly && current.service.activeMutation)
    )
      return null;
    const cluster = current.service.environment.project.cluster;
    const previous = lease.domain.service.environment.project.cluster;
    const settings = await readPlatformSettings(tx);
    const network = await readClusterNetworking(tx, cluster.id, settings);
    if (
      cluster.id !== previous.id ||
      cluster.kubeSystemUid !== previous.kubeSystemUid ||
      cluster.connectionRevision !== previous.connectionRevision ||
      cluster.credentialRefId !== previous.credentialRefId ||
      settings.revision !== lease.settings.revision ||
      network.revision !== lease.network.revision
    )
      return null;
    return current;
  }

  private input(lease: DomainReadLease): DomainOperationInput {
    const input = storedDomainInput(lease.domain, lease.settings.revision, lease.network.revision);
    const service = lease.domain.service;
    const project = service.environment.project;
    const names = workloadNames({ serviceId: service.id, environmentId: service.environmentId });
    if (
      input.target.installationId !== lease.fence.installationId ||
      input.target.clusterId !== project.clusterId ||
      input.target.kubeSystemUid !== project.cluster.kubeSystemUid ||
      input.target.projectId !== project.id ||
      input.target.environmentId !== service.environmentId ||
      input.target.serviceId !== service.id ||
      input.target.namespace !== names.namespace ||
      input.target.serviceName !== names.service ||
      input.target.portId !== lease.domain.servicePortId
    )
      throw new TaskExecutionError(
        'NETWORK_TARGET_CHANGED',
        '域名原归属与当前集群不一致；观察不能改投其他目标。',
      );
    return input;
  }

  private async observe(lease: DomainReadLease, cancellation: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(60_000);
    const signal = AbortSignal.any([cancellation, deadline]);
    const timedOut = () =>
      new TaskExecutionError(
        'NETWORK_OBSERVATION_TIMEOUT',
        '本次域名观察超时，保留上次结果并标记为旧观察。',
        true,
      );
    try {
      const input = this.input(lease);
      let credential: NetworkCredentialFence | undefined;
      let inventory: readonly ManagedNetworkResource[] | undefined;
      const [dns, network] = await Promise.allSettled([
        this.dns.inspect(
          input.hostname,
          { addresses: lease.network.entryAddresses, cname: lease.network.cnameTarget },
          { signal },
        ),
        (async () => {
          if (!lease.settings.acmeEmail)
            throw new TaskExecutionError('ACME_EMAIL_REQUIRED', '原域名的 ACME 联系配置不可用。');
          const access = await readNetworkAccess(
            this.repository.db,
            this.cipher,
            lease.domain.service.environment.project.cluster,
            input.target,
          );
          credential = access.credential;
          const plan = await domainPlan(
            this.repository.db,
            input,
            lease.token,
            access.caFingerprint,
            lease.settings.acmeEmail,
          );
          inventory = plan.inventory;
          return this.manager.observe(access.connection, plan, { signal });
        })(),
      ]);
      if (cancellation.aborted) return;
      if (deadline.aborted) throw timedOut();
      const sample: DomainObservationSample = {
        inventory,
        ...(dns.status === 'fulfilled' ? { dns: dns.value } : {}),
        ...(network.status === 'fulfilled'
          ? { network: network.value }
          : { failure: networkingFailure(network.reason) }),
        ...(dns.status === 'rejected' && network.status === 'fulfilled'
          ? { failure: networkingFailure(dns.reason) }
          : {}),
      };
      await this.repository.db.$transaction(async (tx) => {
        const domain = await this.eligible(tx, lease);
        if (!domain || cancellation.aborted) return;
        if (deadline.aborted) throw timedOut();
        if (credential && network.status === 'fulfilled')
          await assertNetworkCredential(tx, domain.service.environment.project.cluster, credential);
        await saveDomainSample(tx, domain, input, sample);
      });
    } catch (error) {
      const failure = deadline.aborted ? timedOut() : networkingFailure(error);
      try {
        await this.repository.db.$transaction(async (tx) => {
          const domain = await this.eligible(tx, lease);
          if (!domain || cancellation.aborted) return;
          await tx.domain.update({
            where: { id: domain.id },
            data: {
              observationErrorCode: failure.code,
              lastErrorCode: failure.code,
              lastErrorMessage: failure.message,
              nextObservationAt: new Date(Date.now() + 60_000),
              observationLeaseToken: null,
              observationLeaseExpiresAt: null,
            },
          });
        });
      } catch {
        /* A new lease, recovery generation or deleted domain owns subsequent publication. */
      }
    } finally {
      await this.release(lease);
    }
  }

  private async release(lease: DomainReadLease): Promise<void> {
    try {
      await this.repository.db.$transaction(async (tx) => {
        const state = await readFence(tx);
        if (state.generation !== lease.fence.generation) return;
        await tx.domain.updateMany({
          where: { id: lease.domain.id, observationLeaseToken: lease.token },
          data: {
            observationLeaseToken: null,
            observationLeaseExpiresAt: null,
            nextObservationAt: new Date(Date.now() + 5_000),
          },
        });
      });
    } catch {
      /* Expiry releases a stopped observer. */
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
