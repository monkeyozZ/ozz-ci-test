import { Prisma, type PrismaClient } from '@ozz/database';
import { serviceInclude, type ServiceRecord } from '../services/persistence.js';
import type { RuntimeConfiguration } from '../services/contracts.js';
import { readServiceSnapshot, snapshotRuntime } from '../services/snapshots.js';
import { presentService } from '../services/views.js';
import { OperationRequestError } from '../tasks/contracts.js';
import {
  NETWORK_OBSERVATION_STALE_MS,
  type ClusterNetworkingView,
  type DomainView,
  type EligibleHttpPort,
  type PlatformSettingsView,
  type ResourceIdentity,
} from './contracts.js';
import { clusterDomainSuffix } from './validation.js';

export type NetworkingDatabase = PrismaClient | Prisma.TransactionClient;
export const domainInclude = {
  service: { include: serviceInclude },
} satisfies Prisma.DomainInclude;
export type DomainRecord = Prisma.DomainGetPayload<{ include: typeof domainInclude }>;

export function identity(value: ResourceIdentity): ResourceIdentity {
  return { id: value.id, name: value.name, slug: value.slug };
}

export async function lockNetworkingConfiguration(tx: Prisma.TransactionClient): Promise<void> {
  // Serializes settings and allocation, without holding this lock over network IO.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(657090114)`;
}

export async function readPlatformSettings(db: NetworkingDatabase): Promise<PlatformSettingsView> {
  const row = await db.platformSettings.findUnique({ where: { id: 1 } });
  return {
    revision: row?.revision ?? 0,
    appsDomainSuffix: row?.appsDomainSuffix ?? null,
    acmeEmail: row?.acmeEmail ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function readClusterNetworking(
  db: NetworkingDatabase,
  clusterId: string,
  platform?: PlatformSettingsView,
): Promise<ClusterNetworkingView> {
  const row = await db.clusterNetworking.findUnique({ where: { clusterId } });
  const settings = platform ?? (await readPlatformSettings(db));
  return {
    clusterId,
    revision: row?.revision ?? 0,
    subdomain: row?.subdomain ?? null,
    entryAddresses: row?.entryAddresses ?? [],
    cnameTarget: row?.cnameTarget ?? null,
    domainSuffix:
      row && settings.appsDomainSuffix
        ? clusterDomainSuffix(settings.appsDomainSuffix, row.subdomain)
        : null,
    ingressClassName: 'traefik',
    capabilities:
      (row?.capabilitiesJson as unknown as ClusterNetworkingView['capabilities']) ?? null,
    capabilitiesStale:
      !row?.capabilitiesAt ||
      Date.now() - row.capabilitiesAt.getTime() > NETWORK_OBSERVATION_STALE_MS,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** Returned numbers come from the applied snapshot, while IDs come from the stable relation. */
export function eligibleHttpPorts(service: ServiceRecord): EligibleHttpPort[] {
  const published = service.publishedDeployment;
  if (!published?.appliedAt || service.configurationState !== 'consistent') return [];
  let runtime: RuntimeConfiguration;
  try {
    runtime = snapshotRuntime(readServiceSnapshot(published.snapshotJson));
  } catch {
    return [];
  }
  return runtime.ports.flatMap((port) => {
    const relation = service.ports.find(
      (item) => item.name === port.name && item.protocol === 'http',
    );
    return port.protocol === 'http' && relation
      ? [
          {
            id: relation.id,
            name: port.name,
            protocol: 'http' as const,
            containerPort: port.containerPort,
            servicePort: port.servicePort,
            publishedConfigRevision: published.configRevision,
          },
        ]
      : [];
  });
}

export function presentDomain(domain: DomainRecord): DomainView {
  const { service } = domain;
  const environment = service.environment;
  const project = environment.project;
  const current = presentService(service);
  return {
    id: domain.id,
    hostname: domain.hostname,
    kind: 'default',
    serviceId: domain.serviceId,
    serviceName: service.name,
    servicePort:
      eligibleHttpPorts(service).find((port) => port.id === domain.servicePortId) ??
      (domain.portJson as unknown as EligibleHttpPort),
    project: identity(project),
    environment: identity(environment),
    cluster: identity(project.cluster),
    revision: domain.revision,
    desiredState: domain.desiredState as DomainView['desiredState'],
    certificateEnvironment: domain.certificateEnvironment as DomainView['certificateEnvironment'],
    dns: domain.dnsJson as unknown as DomainView['dns'],
    route: domain.routeJson as unknown as DomainView['route'],
    certificate: domain.certificateJson as unknown as DomainView['certificate'],
    observationStale:
      !domain.lastObservedAt ||
      Date.now() - domain.lastObservedAt.getTime() > NETWORK_OBSERVATION_STALE_MS ||
      Boolean(domain.observationErrorCode),
    activeTask: current.activeTask,
    lastAttemptAt: domain.lastAttemptAt?.toISOString() ?? null,
    lastErrorCode: domain.lastErrorCode,
    lastErrorMessage: domain.lastErrorMessage,
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
  };
}

export async function requireDomain(db: NetworkingDatabase, id: string): Promise<DomainRecord> {
  const row = await db.domain.findUnique({ where: { id }, include: domainInclude });
  if (!row) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '域名不存在或已完成解绑。');
  return row;
}
