import type {
  KubernetesAdapterOptions,
  KubernetesErrorCode,
  ParsedKubernetesConnection,
} from '../kubernetes/contracts.js';

export type ManagedWorkloadKind = 'Namespace' | 'Deployment' | 'StatefulSet' | 'Service' | 'Secret';

export type WorkloadControllerConfiguration =
  | { kind: 'Deployment'; strategy: 'RollingUpdate' | 'Recreate' }
  | { kind: 'StatefulSet'; strategy: 'RollingUpdate' | 'OnDelete' };
export interface WorkloadControllerIdentity {
  kind: 'Deployment' | 'StatefulSet';
  uid: string;
}
export interface WorkloadVolumeBinding {
  volumeId: string;
  claimName: string;
  /** Fixed by storage preparation before the Pod controller may be written. */
  claimUid: string;
  path: string;
  readOnly: boolean;
}
/** Internal template files only; S5 permits the fixed /run/ozz/database directory. */
export interface WorkloadSecretFile {
  key: string;
  path: string;
  value: string;
  mode?: 256 | 288 | 292;
}
export interface WorkloadDatabaseConfiguration {
  engine: 'postgresql' | 'redis';
  expectedMajor: number;
  username: string;
  databaseName: string | null;
}

/** Fixed ownership; namespace must equal the stable name derived from environmentId. */
export interface WorkloadTarget {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  caFingerprint: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  namespace: string;
}

/** Persist before creating resources. A label without this record never grants ownership. */
export interface ManagedWorkloadResource {
  kind: ManagedWorkloadKind;
  name: string;
  namespace: string | null;
  creationNonce: string;
  creationAttempted: boolean;
  uid: string | null;
  resourceVersion: string | null;
  /** Namespace ownership is shared by the environment and always uses zero here. */
  mutationRevision: number;
  /** An internal fingerprint of the observed non-secret spec; never of Secret data. */
  specFingerprint: string | null;
}

export interface WorkloadPort {
  name: string;
  protocol: 'http' | 'tcp';
  containerPort: number;
  servicePort: number;
}

export interface WorkloadResources {
  requests: { cpuMillis: number; memoryMiB: number };
  limits: { cpuMillis: number; memoryMiB: number };
}

export interface WorkloadProbe {
  type: 'http' | 'tcp';
  /** A declared container port name, never a second arbitrary target. */
  port: string;
  path?: string;
  initialDelaySeconds: number;
  periodSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
}

/** Decrypted runtime values only exist for this call; no result repeats them. */
export interface WorkloadConfiguration {
  image: string;
  replicas: number;
  command: string[];
  args: string[];
  ports: WorkloadPort[];
  resources: WorkloadResources;
  environment: { name: string; value: string }[];
  readiness: WorkloadProbe | null;
  startup: WorkloadProbe | null;
  /** Omission is the v1 Deployment/RollingUpdate behavior. */
  controller?: WorkloadControllerConfiguration;
  volumes?: WorkloadVolumeBinding[];
  secretFiles?: WorkloadSecretFile[];
  database?: WorkloadDatabaseConfiguration;
}

/** Current registry pull authentication, independent of immutable runtime secrets. */
export interface WorkloadPullSecret {
  dockerConfigJson: string;
}

export interface WorkloadApplyPlan {
  target: WorkloadTarget;
  snapshotId: string;
  configRevision: number;
  mutationRevision: number;
  taskId: string;
  configuration: WorkloadConfiguration;
  pullSecret: WorkloadPullSecret | null;
  inventory: readonly ManagedWorkloadResource[];
  /** Explicit full republish confirmation; never relaxes ownership or revision checks. */
  allowConfigurationRepair?: boolean;
}

export interface WorkloadWriteIntent {
  action: 'create' | 'replace' | 'delete';
  kind: ManagedWorkloadKind;
  name: string;
  namespace: string | null;
  creationNonce: string;
  expectedUid: string | null;
  expectedResourceVersion: string | null;
  mutationRevision: number;
}

export interface WorkloadResourceReceipt {
  action: 'created' | 'replaced' | 'verified' | 'deleted';
  kind: ManagedWorkloadKind;
  name: string;
  namespace: string | null;
  creationNonce: string;
  uid: string;
  resourceVersion: string | null;
  generation: number | null;
  mutationRevision: number;
  specFingerprint: string | null;
  observedAt: string;
}

export interface WorkloadWriteHooks {
  signal?: AbortSignal;
  /** Fences the write and persists creationAttempted before a create request is sent. */
  beforeWrite(intent: WorkloadWriteIntent): Promise<void>;
  /** Receipts are returned after each resource, including a recoverable prior create. */
  onReceipt(receipt: WorkloadResourceReceipt): Promise<void>;
}

/** A trustworthy, completely applied configuration; health may still have failed. */
export interface PublishedWorkloadFields {
  snapshotId: string;
  configRevision: number;
  image: string;
  replicas: number;
  /** Ignores only the adapter-owned restart token; unchanged by stop/resume/restart. */
  templateFingerprint: string;
  /** Complete Deployment spec excluding replica count and the controlled restart token. */
  workloadFingerprint: string;
  usesPullSecret: boolean;
}

/** Old persisted publications keep their v1 field; new receipts use an explicit controller. */
export type PublishedWorkload = PublishedWorkloadFields &
  (
    | { controller: WorkloadControllerIdentity; deploymentUid?: never }
    | { controller?: undefined; deploymentUid: string }
  );

export type WorkloadRolloutTarget = PublishedWorkload & {
  generation: number;
  rolloutId: string;
};

export interface WorkloadApplyReceipt {
  state: 'complete';
  mutationRevision: number;
  resources: WorkloadResourceReceipt[];
  published: WorkloadRolloutTarget;
  serviceDns: string | null;
  appliedAt: string;
}

export interface WorkloadOperation {
  target: WorkloadTarget;
  action: 'stop' | 'resume' | 'restart' | 'delete';
  taskId: string;
  mutationRevision: number;
  inventory: readonly ManagedWorkloadResource[];
  /** Complete ledger for read checks; resources outside inventory are never mutation targets. */
  knownInventory?: readonly ManagedWorkloadResource[];
  /** Required for resume/restart. The adapter preserves its existing template. */
  published?: PublishedWorkload;
  /** Required when resume/restart uses private images; never restores old auth. */
  pullSecret?: WorkloadPullSecret | null;
}

export interface WorkloadOperationReceipt {
  action: WorkloadOperation['action'];
  mutationRevision: number;
  resources: WorkloadResourceReceipt[];
  rollout: WorkloadRolloutTarget | null;
  /** stop waits for zero active Pods; delete waits for managed resource 404s. */
  completedAt: string;
}

export interface WorkloadContainerObservation {
  name: string;
  /** Declared Pod image; imageId separately records the container runtime's image identity. */
  image: string;
  imageId: string | null;
  ready: boolean | null;
  restartCount: number | null;
  state: 'waiting' | 'running' | 'terminated' | 'unknown';
  reason: string | null;
  lastTerminationReason: string | null;
  oomKilled: boolean;
  exitCode: number | null;
  requests: { cpuCores: number | null; memoryBytes: number | null };
  limits: { cpuCores: number | null; memoryBytes: number | null };
  metrics: WorkloadMetrics;
}

export interface WorkloadMetrics {
  state: 'available' | 'unknown';
  cpuCores: number | null;
  memoryBytes: number | null;
  observedAt: string | null;
  windowSeconds: number | null;
}

export interface WorkloadPodObservation {
  uid: string;
  name: string;
  namespace: string;
  nodeName: string | null;
  createdAt: string | null;
  deletionTimestamp: string | null;
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  ready: boolean | null;
  snapshotId: string | null;
  configRevision: number | null;
  rolloutId: string | null;
  replicaSetUid: string | null;
  /** Absent only on retained v1 observations. */
  owner?: { kind: 'ReplicaSet' | 'StatefulSet'; uid: string };
  matchesControllerTemplate?: boolean;
  /** Owning ReplicaSet template matches the current Deployment, including the rollout token. */
  matchesDeploymentTemplate: boolean;
  containers: WorkloadContainerObservation[];
}

export interface WorkloadEventObservation {
  uid: string;
  reason: string;
  type: 'Normal' | 'Warning' | 'Unknown';
  objectUid: string;
  objectKind: string;
  objectName: string;
  count: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  /** Controlled reason text. Raw Kubernetes messages may contain runtime secrets. */
  message: string;
}

export interface WorkloadDeploymentObservation {
  uid: string;
  resourceVersion: string;
  generation: number;
  observedGeneration: number | null;
  replicas: number;
  currentReplicas: number | null;
  updatedReplicas: number | null;
  readyReplicas: number | null;
  availableReplicas: number | null;
  snapshotId: string | null;
  configRevision: number | null;
  mutationRevision: number | null;
  rolloutId: string | null;
  image: string | null;
  templateFingerprint: string;
  workloadFingerprint: string;
  progressDeadlineExceeded: boolean;
  deleting: boolean;
}

export interface WorkloadControllerObservation extends WorkloadDeploymentObservation {
  kind: 'Deployment' | 'StatefulSet';
  strategy: 'RollingUpdate' | 'Recreate' | 'OnDelete';
  currentRevision: string | null;
  updateRevision: string | null;
}

export interface WorkloadObservation {
  observedAt: string;
  configurationState: 'consistent' | 'drifted' | 'missing' | 'unknown';
  drift: { kind: ManagedWorkloadKind | 'Pod'; name: string; reason: string }[];
  resources: {
    kind: ManagedWorkloadKind;
    name: string;
    namespace: string | null;
    expectedUid: string | null;
    observedUid: string | null;
    resourceVersion: string | null;
    state: 'verified' | 'missing' | 'drifted' | 'unknown';
    reason: string | null;
  }[];
  deployment: WorkloadDeploymentObservation | null;
  /** New observations always supply this; legacy persisted Deployment views may omit it. */
  controller?: WorkloadControllerObservation | null;
  pods: WorkloadPodObservation[];
  podsTruncated: boolean;
  events: WorkloadEventObservation[];
  eventsState: 'available' | 'unknown';
  eventsTruncated: boolean;
  metrics: WorkloadMetrics;
  metricsErrorCode: KubernetesErrorCode | null;
  serviceDns: string | null;
}

export interface WorkloadReadOptions {
  signal?: AbortSignal;
  /**
   * Complete ledger, including historical Secrets no longer required by this observation.
   * Existing records still require ownership verification; only their confirmed absence is optional.
   * The current inventory takes precedence for resources updated by this operation's receipts.
   */
  knownInventory?: readonly ManagedWorkloadResource[];
}

export interface WorkloadWaitOptions extends WorkloadReadOptions {
  inventory: readonly ManagedWorkloadResource[];
  /** A task lease check during each wait iteration; it never performs remote writes. */
  checkpoint?(): Promise<void>;
  onObservation?(observation: WorkloadObservation): Promise<void>;
}

export interface KubernetesWorkloadAdapterOptions extends KubernetesAdapterOptions {
  operationTimeoutMs?: number;
  rolloutTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPods?: number;
  maxEvents?: number;
}

export interface KubernetesWorkloadManager {
  apply(
    connection: ParsedKubernetesConnection,
    plan: WorkloadApplyPlan,
    hooks: WorkloadWriteHooks,
  ): Promise<WorkloadApplyReceipt>;
  observe(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    inventory: readonly ManagedWorkloadResource[],
    options?: WorkloadReadOptions,
  ): Promise<WorkloadObservation>;
  waitHealthy(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    expected: WorkloadRolloutTarget,
    options: WorkloadWaitOptions,
  ): Promise<WorkloadObservation>;
  operate(
    connection: ParsedKubernetesConnection,
    operation: WorkloadOperation,
    hooks: WorkloadWriteHooks,
  ): Promise<WorkloadOperationReceipt>;
  verifyDatabase?(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    inventory: readonly ManagedWorkloadResource[],
    published: PublishedWorkload,
    database: WorkloadDatabaseConfiguration,
    options?: { signal?: AbortSignal },
  ): Promise<DatabaseVerification>;
}

/** Engine authentication is verified with fixed commands inside the already owned Pod. */
export interface DatabaseVerification {
  observedAt: string;
  state: 'ready' | 'failed' | 'unknown';
  engine: 'postgresql' | 'redis';
  authenticated: boolean | null;
  expectedMajor: number;
  observedMajor: number | null;
  version: string | null;
  username: string;
  databaseName: string | null;
  pod: { name: string; uid: string; controller: WorkloadControllerIdentity } | null;
  redis: {
    aofEnabled: boolean | null;
    appendfsync: 'everysec' | 'always' | 'no' | null;
    lastWriteStatus: 'ok' | 'error' | null;
  } | null;
  code: string | null;
  message: string;
}

export type WorkloadErrorCode =
  | KubernetesErrorCode
  | 'WORKLOAD_INPUT_INVALID'
  | 'WORKLOAD_INVENTORY_REQUIRED'
  | 'WORKLOAD_OWNERSHIP_MISMATCH'
  | 'WORKLOAD_RESOURCE_CONFLICT'
  | 'WORKLOAD_RESOURCE_MISSING'
  | 'WORKLOAD_REVISION_AHEAD'
  | 'WORKLOAD_CONFIGURATION_DRIFT'
  | 'WORKLOAD_PUBLISHED_REQUIRED'
  | 'WORKLOAD_CALLBACK_FAILED'
  | 'WORKLOAD_ROLLOUT_TIMEOUT'
  | 'WORKLOAD_ROLLOUT_FAILED'
  | 'WORKLOAD_OPERATION_TIMEOUT';

/** No raw Kubernetes response, configuration or credential is retained in errors. */
export class WorkloadAdapterError extends Error {
  readonly name = 'WorkloadAdapterError';

  constructor(
    public readonly code: WorkloadErrorCode,
    public readonly retryable = false,
    public readonly sideEffects: 'none' | 'may_have_changed' = 'none',
    public readonly receipts: readonly WorkloadResourceReceipt[] = [],
    public readonly observation: WorkloadObservation | null = null,
  ) {
    super(code);
  }
}
