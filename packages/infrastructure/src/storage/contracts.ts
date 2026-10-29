import type {
  KubernetesAdapterOptions,
  ParsedKubernetesConnection,
} from '../kubernetes/contracts.js';
import type {
  ManagedWorkloadResource,
  WorkloadTarget,
  WorkloadWriteHooks,
} from '../workload/contracts.js';

export interface StorageClusterTarget {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  caFingerprint: string;
}
export interface StorageTarget extends StorageClusterTarget {
  projectId: string;
  environmentId: string;
  namespace: string;
  volumeId: string;
}
export interface ManagedStorageClaim {
  name: string;
  namespace: string;
  creationNonce: string;
  creationAttempted: boolean;
  uid: string | null;
  resourceVersion: string | null;
  /** Durable original PVC creation/write revision, distinct from the current task fence. */
  mutationRevision: number;
  /** Internal CAS fence; never sent to Kubernetes. */
  ledgerVersion: number;
  specFingerprint: string | null;
}
export interface StorageBindingIdentity {
  pvName: string;
  pvUid: string;
  /** A same-name node with another UID cannot silently inherit local data identity. */
  nodes: { name: string; uid: string }[];
}
export interface StorageVolumePlan {
  target: StorageTarget;
  mutationRevision: number;
  requestedBytes: number;
  storageClassName: string;
  /** First creation may establish this in beforeWrite; any known UID is immutable. */
  storageClassUid: string | null;
  claim: ManagedStorageClaim;
  /** The existing environment ManagedResource row; Storage never invents another nonce. */
  namespace: ManagedWorkloadResource;
  knownBinding?: StorageBindingIdentity | null;
}
export interface StorageWriteIntent {
  action: 'create' | 'delete';
  name: string;
  namespace: string;
  creationNonce: string;
  expectedUid: string | null;
  expectedResourceVersion: string | null;
  mutationRevision: number;
  storageClassUid: string | null;
  binding: StorageBindingIdentity | null;
}
export interface StorageResourceReceipt {
  action: 'created' | 'verified' | 'deleted';
  name: string;
  namespace: string;
  creationNonce: string;
  /** Null only for a deleted receipt after a named read proved an uncreated claim absent. */
  uid: string | null;
  resourceVersion: string | null;
  mutationRevision: number;
  storageClassUid: string | null;
  specFingerprint: string | null;
  binding: StorageBindingIdentity | null;
  observedAt: string;
}
export interface StorageWriteHooks {
  signal?: AbortSignal;
  checkpoint(): Promise<void>;
  beforeWrite(intent: StorageWriteIntent): Promise<void>;
  onReceipt(receipt: StorageResourceReceipt): Promise<void>;
  namespace: WorkloadWriteHooks;
}
export interface StorageClassObservation {
  name: string;
  uid: string;
  provisioner: string;
  bindingMode: 'Immediate' | 'WaitForFirstConsumer' | null;
  reclaimPolicy: 'Delete' | 'Retain' | null;
  default: boolean;
  supported: boolean;
  code: string | null;
  message: string;
  hardQuotaSupport: 'unsupported' | 'unknown';
  allowVolumeExpansion: boolean;
}
export interface StorageCapabilities {
  observedAt: string;
  storageClasses: StorageClassObservation[];
  truncated: boolean;
  provisioner: { state: 'ready' | 'missing' | 'unknown'; version: string | null };
  permissions: 'ready' | 'insufficient' | 'unknown';
  issues: { code: string; message: string }[];
}
export interface StoragePodMount {
  podName: string;
  podUid: string;
  namespace: string;
  nodeName: string | null;
  phase: string;
  deleting: boolean;
  readOnly: boolean;
  paths: string[];
  serviceId: string | null;
  /** Actual root controller after Pod/ReplicaSet ancestry checks; callers also match its durable ledger UID. */
  controller: { kind: string; name: string; uid: string } | null;
}
export interface StorageVolumeObservation {
  observedAt: string;
  state: 'pending' | 'ready' | 'missing' | 'drifted' | 'unknown' | 'destroyed';
  code: string | null;
  message: string;
  requestedBytes: number;
  hardQuotaSupport: 'unsupported' | 'unknown';
  pvc: {
    name: string;
    uid: string | null;
    resourceVersion: string | null;
    phase: 'Pending' | 'Bound' | 'Lost' | 'Unknown' | 'Missing';
    deleting: boolean;
  };
  pv: {
    name: string;
    uid: string;
    claimUid: string;
    capacityBytes: number | null;
    reclaimPolicy: 'Delete' | 'Retain' | null;
    storageClassName: string;
    provisioner: string;
    nodeAffinity: unknown;
  } | null;
  storageClass: StorageClassObservation | null;
  locality: 'waiting_for_consumer' | 'verified' | 'unavailable' | 'unknown';
  nodes: { name: string; uid: string; ready: boolean | null }[];
  usage: { usedBytes: null; nodeAvailableBytes: null; observedAt: null };
  mounts: StoragePodMount[];
  mountsTruncated: boolean;
  destructionBlockers: { code: string; message: string }[];
  verifiedReceipt?: StorageResourceReceipt;
}
export interface StorageMutationReceipt {
  completedAt: string;
  resources: StorageResourceReceipt[];
  observation: StorageVolumeObservation;
}
export interface PreparedVolumeBinding {
  volumeId: string;
  namespace: string;
  claimName: string;
  claimUid: string;
  path: string;
  readOnly: boolean;
  storageClassUid: string;
  binding: StorageBindingIdentity | null;
  observedAt: string;
}
export interface KubernetesStorageAdapterOptions extends KubernetesAdapterOptions {
  operationTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPods?: number;
  maxNodes?: number;
}
export interface KubernetesStorageManager {
  inspect(
    connection: ParsedKubernetesConnection,
    target: StorageClusterTarget,
    options?: { signal?: AbortSignal },
  ): Promise<StorageCapabilities>;
  create(
    connection: ParsedKubernetesConnection,
    plan: StorageVolumePlan,
    hooks: StorageWriteHooks,
  ): Promise<StorageMutationReceipt>;
  observe(
    connection: ParsedKubernetesConnection,
    plan: StorageVolumePlan,
    options?: { signal?: AbortSignal },
  ): Promise<StorageVolumeObservation>;
  destroy(
    connection: ParsedKubernetesConnection,
    plan: StorageVolumePlan,
    hooks: StorageWriteHooks,
  ): Promise<StorageMutationReceipt>;
  prepareBindings(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    volumes: readonly { plan: StorageVolumePlan; path: string; readOnly: boolean }[],
    options?: { signal?: AbortSignal },
  ): Promise<PreparedVolumeBinding[]>;
}
export class StorageAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'StorageAdapterError';
  }
}
