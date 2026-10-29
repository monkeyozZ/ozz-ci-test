import type {
  NetworkingCapabilities,
  DomainDnsObservation,
  DomainRouteObservation,
  DomainCertificateObservation,
} from '@ozz/infrastructure/networking';
export type {
  NetworkingCapabilities,
  DomainDnsObservation,
  DomainRouteObservation,
  DomainCertificateObservation,
  DomainTarget,
} from '@ozz/infrastructure/networking';
import { OperationRequestError, type OperationView, type TaskRef } from '../tasks/contracts.js';

export class NetworkingConflictError extends OperationRequestError {
  constructor(
    code: string,
    message: string,
    readonly affectedDomains: string[] = [],
  ) {
    super(409, code, message);
  }
}

export interface ResourceIdentity {
  id: string;
  name: string;
  slug: string;
}

export interface PlatformSettingsView {
  revision: number;
  appsDomainSuffix: string | null;
  acmeEmail: string | null;
  updatedAt: string | null;
}

export interface UpdatePlatformSettingsInput {
  revision: number;
  appsDomainSuffix: string | null;
  acmeEmail: string | null;
}

export interface ClusterNetworkingView {
  clusterId: string;
  revision: number;
  subdomain: string | null;
  entryAddresses: string[];
  cnameTarget: string | null;
  domainSuffix: string | null;
  ingressClassName: 'traefik';
  capabilities: NetworkingCapabilities | null;
  capabilitiesStale: boolean;
  updatedAt: string | null;
}

export interface UpdateClusterNetworkingInput {
  revision: number;
  subdomain: string;
  entryAddresses: string[];
  cnameTarget: string | null;
}

export interface EligibleHttpPort {
  id: string;
  name: string;
  protocol: 'http';
  containerPort: number;
  servicePort: number;
  publishedConfigRevision: number;
}

export interface DomainView {
  id: string;
  hostname: string;
  kind: 'default';
  serviceId: string;
  serviceName: string;
  servicePort: EligibleHttpPort;
  project: ResourceIdentity;
  environment: ResourceIdentity;
  cluster: ResourceIdentity;
  revision: number;
  desiredState: 'active' | 'deleting';
  certificateEnvironment: 'staging' | 'production';
  dns: DomainDnsObservation | null;
  route: DomainRouteObservation | null;
  certificate: DomainCertificateObservation | null;
  observationStale: boolean;
  activeTask: (TaskRef & { status: string; kind: string }) | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceNetworkingView {
  serviceId: string;
  serviceRevision: number;
  publishedConfigRevision: number | null;
  project: ResourceIdentity;
  environment: ResourceIdentity;
  cluster: ResourceIdentity;
  eligiblePorts: EligibleHttpPort[];
  blockers: { code: string; message: string }[];
  platformSettings: PlatformSettingsView;
  clusterNetworking: ClusterNetworkingView;
  domains: DomainView[];
}

export interface CreateDomainInput {
  revision: number;
  portId: string;
}

export interface DomainActionInput {
  revision: number;
}

export interface DomainListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  clusterId?: string;
}

export type DomainAction = 'sync' | 'reconcile' | 'unbind' | 'production';
export type DomainMutationResult = OperationView;

export const NETWORK_OBSERVATION_STALE_MS = 90_000;
export const NETWORK_OBSERVATION_INTERVAL_MS = 30_000;
