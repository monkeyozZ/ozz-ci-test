import type { ParsedKubernetesConnection } from '../kubernetes/contracts.js';

/** Explicit constructor-only fixture settings. Production processes must not load these. */
export interface LocalAcmeTestConfiguration {
  stagingUrl: string;
  productionUrl: string;
  caBundle: string;
  solverNameservers: string[];
}

export interface NetworkingCapabilities {
  observedAt: string;
  ingressClass: 'ready' | 'missing' | 'unknown';
  ingressClassName: string;
  traefikMiddleware: 'ready' | 'missing' | 'unknown';
  certManager: 'ready' | 'missing' | 'incompatible' | 'unknown';
  certManagerVersion: string | null;
  permissions: 'ready' | 'insufficient' | 'unknown';
  issues: { code: string; message: string }[];
}

export interface DomainDnsObservation {
  state: 'unconfigured' | 'matched' | 'mismatch' | 'not_found' | 'error';
  observedAt: string;
  addresses: string[];
  cnameChain: string[];
  expectedAddresses: string[];
  expectedCname: string | null;
  code: string | null;
  message: string;
}

export interface DomainRouteObservation {
  state: 'pending' | 'ready' | 'backend_pending' | 'missing' | 'drifted' | 'unknown' | 'removed';
  observedAt: string;
  ingressNames: string[];
  backendServiceName: string;
  portName: string;
  readyEndpoints: number | null;
  code: string | null;
  message: string;
}

export interface DomainCertificateObservation {
  /** Local ACME test roots must never be presented as publicly trusted certificates. */
  authority: 'letsencrypt' | 'local_test' | 'unknown';
  state:
    | 'pending'
    | 'issuing'
    | 'staging_ready'
    | 'ready'
    | 'renewing'
    | 'failed'
    | 'expired'
    | 'missing'
    | 'unknown'
    | 'removed';
  observedAt: string;
  environment: 'staging' | 'production';
  certificateName: string;
  issuerName: string;
  notBefore: string | null;
  notAfter: string | null;
  renewalTime: string | null;
  code: string | null;
  message: string;
}

export interface DomainTarget {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  namespace: string;
  serviceName: string;
  serviceUid: string;
  domainId: string;
  hostname: string;
  portId: string;
  portName: string;
}

export interface NetworkClusterTarget {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  caFingerprint: string;
}

export type NetworkResourceScope = 'domain' | 'environment' | 'cluster';
export interface NetworkResourceDescriptor {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  role: string;
  scope: NetworkResourceScope;
}
export interface ManagedNetworkResource extends NetworkResourceDescriptor {
  /** Internal ledger fence; it is never a Kubernetes annotation or a desired-resource revision. */
  ledgerVersion: number;
  creationNonce: string;
  creationAttempted: boolean;
  uid: string | null;
  resourceVersion: string | null;
  revision: number;
  specFingerprint: string | null;
}
export interface NetworkWriteIntent extends NetworkResourceDescriptor {
  action: 'create' | 'replace' | 'delete';
  creationNonce: string;
  expectedUid: string | null;
  expectedResourceVersion: string | null;
  revision: number;
}
export interface NetworkResourceReceipt extends NetworkResourceDescriptor {
  action: 'created' | 'replaced' | 'verified' | 'deleted';
  creationNonce: string;
  /** Null is permitted only after a named read confirmed an uncreated resource absent. */
  uid: string | null;
  resourceVersion: string | null;
  revision: number;
  specFingerprint: string | null;
  observedAt: string;
}
export interface NetworkWriteHooks {
  signal?: AbortSignal;
  checkpoint(): Promise<void>;
  /** Reserve a known resource identity before writing; a label alone grants no ownership. */
  reserve(resource: NetworkResourceDescriptor): Promise<ManagedNetworkResource>;
  beforeWrite(intent: NetworkWriteIntent): Promise<void>;
  onReceipt(receipt: NetworkResourceReceipt): Promise<void>;
}
export interface NetworkDomainPlan {
  target: DomainTarget & { caFingerprint: string };
  revision: number;
  platformRevision: number;
  taskId: string;
  acmeEmail: string;
  certificateEnvironment: 'staging' | 'production';
  /** Only a newly admitted explicit reconcile may recreate a known resource proven absent. */
  reconcileMissing: boolean;
  inventory: readonly ManagedNetworkResource[];
}
export interface NetworkDomainObservation {
  route: DomainRouteObservation;
  certificate: DomainCertificateObservation;
  /** Verified metadata can update the ledger; no observer can create or replace a resource. */
  verifiedResources?: NetworkResourceReceipt[];
}
export interface NetworkDomainReceipt extends NetworkDomainObservation {
  completedAt: string;
  resources: NetworkResourceReceipt[];
}
export interface KubernetesNetworkingManager {
  inspect(
    connection: ParsedKubernetesConnection,
    target: NetworkClusterTarget,
    options?: { signal?: AbortSignal },
  ): Promise<NetworkingCapabilities>;
  installCertManager(
    connection: ParsedKubernetesConnection,
    target: NetworkClusterTarget,
    hooks: NetworkWriteHooks,
  ): Promise<NetworkingCapabilities>;
  apply(
    connection: ParsedKubernetesConnection,
    plan: NetworkDomainPlan,
    hooks: NetworkWriteHooks,
  ): Promise<NetworkDomainReceipt>;
  observe(
    connection: ParsedKubernetesConnection,
    plan: NetworkDomainPlan,
    options?: { signal?: AbortSignal },
  ): Promise<NetworkDomainObservation>;
  remove(
    connection: ParsedKubernetesConnection,
    plan: NetworkDomainPlan,
    hooks: NetworkWriteHooks,
  ): Promise<NetworkDomainReceipt>;
}

/** This error carries controlled diagnostic data, never Kubernetes response bodies or keys. */
export class NetworkingAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'NetworkingAdapterError';
  }
}

export interface DomainDnsInspector {
  inspect(
    hostname: string,
    expected: { addresses: readonly string[]; cname: string | null },
    options?: { signal?: AbortSignal },
  ): Promise<DomainDnsObservation>;
}
