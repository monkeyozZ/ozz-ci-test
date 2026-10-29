import type {
  PreparedVolumeBinding,
  StorageClassObservation,
  StorageCapabilities,
  StoragePodMount,
  StorageVolumeObservation,
} from '@ozz/infrastructure/storage';
import { OperationRequestError, type OperationView, type TaskRef } from '../tasks/contracts.js';

export type {
  PreparedVolumeBinding,
  StorageBindingIdentity,
  StorageCapabilities,
  StorageClassObservation,
  StoragePodMount,
  StorageVolumeObservation,
} from '@ozz/infrastructure/storage';

export const STORAGE_OBSERVATION_STALE_MS = 90_000;
export const STORAGE_OBSERVATION_INTERVAL_MS = 30_000;
export const SERVICE_VOLUME_LIMIT = 8;
export const volumeOperationKinds = [
  'volume_create',
  'volume_sync',
  'volume_destroy',
  'volume_maintenance_enter',
  'volume_maintenance_exit',
] as const;
export type VolumeOperationKind = (typeof volumeOperationKinds)[number];

/** Authentication is resolved at execution. Logical/data identities never change on retry. */
export interface VolumeTarget {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  projectId: string;
  environmentId: string;
  namespace: string;
  volumeId: string;
}
export interface VolumeDeletionConfirmation {
  volumeId: string;
  pvcUid: string | null;
  reclaimPolicy: 'Delete' | 'Retain' | null;
  previewDigest: string;
  volumeName: string;
}
export interface VolumeOperationInput {
  volumeId: string;
  volumeRevision: number;
  mutationRevision: number;
  target: VolumeTarget;
  maintenanceId?: string;
  confirmation?: VolumeDeletionConfirmation;
}

/** Kept here so the task repository can validate stored volume intents without a DB lookup. */
export function parseVolumeOperationInput(value: unknown): VolumeOperationInput {
  const invalid = () =>
    new OperationRequestError(422, 'INVALID_OPERATION_INPUT', '存储任务的固定目标或参数无效。');
  const record = (v: unknown, allowed: string[]): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
    if (Object.keys(v).some((key) => !allowed.includes(key))) throw invalid();
    return v as Record<string, unknown>;
  };
  const uuid = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(v))
      throw invalid();
    return v;
  };
  const raw = record(value, [
    'volumeId',
    'volumeRevision',
    'mutationRevision',
    'target',
    'maintenanceId',
    'confirmation',
  ]);
  uuid(raw.volumeId);
  for (const key of ['volumeRevision', 'mutationRevision'])
    if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 1 || Number(raw[key]) > 2147483647)
      throw invalid();
  const target = record(raw.target, [
    'installationId',
    'clusterId',
    'kubeSystemUid',
    'projectId',
    'environmentId',
    'namespace',
    'volumeId',
  ]);
  for (const key of ['installationId', 'clusterId', 'projectId', 'environmentId', 'volumeId'])
    uuid(target[key]);
  if (
    raw.volumeId !== target.volumeId ||
    typeof target.kubeSystemUid !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(target.kubeSystemUid) ||
    target.namespace !== `ozz-e-${String(target.environmentId).replaceAll('-', '')}`
  )
    throw invalid();
  if (raw.maintenanceId !== undefined) uuid(raw.maintenanceId);
  if (raw.confirmation !== undefined) {
    const confirmation = record(raw.confirmation, [
      'volumeId',
      'pvcUid',
      'reclaimPolicy',
      'previewDigest',
      'volumeName',
    ]);
    if (
      confirmation.volumeId !== raw.volumeId ||
      (confirmation.pvcUid !== null &&
        (typeof confirmation.pvcUid !== 'string' ||
          !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(confirmation.pvcUid))) ||
      ![null, 'Delete', 'Retain'].includes(confirmation.reclaimPolicy as string | null) ||
      typeof confirmation.previewDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(confirmation.previewDigest) ||
      typeof confirmation.volumeName !== 'string' ||
      !confirmation.volumeName.trim() ||
      confirmation.volumeName.length > 120
    )
      throw invalid();
  }
  return value as VolumeOperationInput;
}

export interface StorageIdentity {
  id: string;
  name: string;
  slug: string;
}
export interface StorageIssue {
  code: string;
  message: string;
}
export interface ClusterStorageView {
  clusterId: string;
  capabilities: StorageCapabilities | null;
  storageClasses: StorageClassObservation[];
  observedAt: string | null;
  stale: boolean;
  lastAttemptAt: string | null;
  errorCode: string | null;
}
export interface VolumeMountView {
  id: string;
  serviceId: string | null;
  service: StorageIdentity | null;
  volumeId: string;
  volume: StorageIdentity & { revision: number; destroyedAt: string | null };
  mountPath: string;
  readOnly: boolean;
  desired: boolean;
  lastPublishedDeploymentId: string | null;
  detachedAt: string | null;
}
export interface VolumeMountCollection {
  data: VolumeMountView[];
  serviceRevision: number;
  configRevision: number;
}
export interface VolumeMaintenanceView {
  id: string;
  purpose: 'backup' | 'restore';
  state: 'entering' | 'active' | 'exiting' | 'failed' | 'closed';
  revision: number;
  enteredAt: string | null;
  expiresAt: string;
  releasedAt: string | null;
  overdue: boolean;
  lastErrorCode: string | null;
  exitBlockers: StorageIssue[];
}
export interface RetainedDatabaseView {
  id: string;
  serviceId: string | null;
  engine: string;
  majorVersion: number;
  initializedAt: string | null;
  initializationFenceAt: string | null;
}
export interface VolumeView {
  id: string;
  name: string;
  slug: string;
  revision: number;
  project: StorageIdentity | null;
  environment: StorageIdentity | null;
  cluster: StorageIdentity | null;
  namespace: string;
  requestedBytes: string;
  storageClassName: string;
  storageClassUid: string | null;
  storageClass: StorageClassObservation | null;
  hardQuotaSupport: 'unsupported' | 'unknown';
  desiredState: 'active' | 'destroying' | 'destroyed';
  retained: boolean;
  destroyedAt: string | null;
  pvc: StorageVolumeObservation['pvc'];
  pv:
    | (Omit<NonNullable<StorageVolumeObservation['pv']>, 'capacityBytes'> & {
        capacityBytes: string | null;
      })
    | null;
  locality: StorageVolumeObservation['locality'];
  nodes: StorageVolumeObservation['nodes'];
  usage: { usedBytes: string | null; nodeAvailableBytes: string | null; observedAt: string | null };
  mounts: {
    desired: VolumeMountView[];
    published: VolumeMountView[];
    actual: StoragePodMount[];
    truncated: boolean;
  };
  observation: {
    state: StorageVolumeObservation['state'];
    observedAt: string | null;
    stale: boolean;
    code: string | null;
    message: string;
  };
  maintenance: VolumeMaintenanceView | null;
  activeTask: (TaskRef & { status: string; kind: string }) | null;
  deletionBlockers: StorageIssue[];
  retainedDatabase: RetainedDatabaseView | null;
  manualDataIdentity: ManualDataIdentity | null;
  lastManualBackupRecord: ManualDataRecordView | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface VolumeListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  projectId?: string;
  environmentId?: string;
  clusterId?: string;
  serviceId?: string;
  retained?: boolean;
}
export interface CreateVolumeInput {
  environmentId: string;
  name: string;
  slug: string;
  storageClassName: string;
  requestedBytes: string;
}
export interface SaveVolumeMountInput {
  revision: number;
  volumeId: string;
  volumeRevision: number;
  mountPath: string;
  readOnly: boolean;
}
export interface VolumeDeletionPreview {
  volumeId: string;
  revision: number;
  volumeName: string;
  pvcUid: string | null;
  pvcName: string;
  pvName: string | null;
  reclaimPolicy: 'Delete' | 'Retain' | null;
  observedAt: string | null;
  previewDigest: string;
  blockers: StorageIssue[];
  retained: boolean;
  retainedDatabase: RetainedDatabaseView | null;
  lastManualBackupRecord: ManualDataRecordView | null;
}
export interface VolumeCreateResult {
  volumeId: string;
  operation: OperationView;
}
export interface VolumeSnapshotReference {
  volumeId: string;
  mountId: string;
  volumeRevision: number;
  target: VolumeTarget;
  pvcName: string;
  pvcUid: string | null;
  creationNonce: string;
  storageClassName: string;
  storageClassUid: string | null;
  requestedBytes: string;
  mountPath: string;
  readOnly: boolean;
}
export type PreparedVolumeBindings = PreparedVolumeBinding[];

export interface ManualDataIdentity {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  environmentId: string;
  volumeId: string;
  pvcUid: string;
}
export interface CreateManualDataRecordInput {
  type: 'backup' | 'restore';
  backupId: string;
  source: ManualDataIdentity;
  target: ManualDataIdentity | null;
  engine: 'postgresql' | 'redis' | 'files';
  engineVersion: string;
  dataLayout: string;
  format: string;
  toolVersion: string;
  sizeBytes: string;
  sha256: string;
  startedAt: string;
  completedAt: string;
  dataTime: { from: string | null; to: string | null; description: string };
  offHostLocationLabel: string;
  integrity: 'passed' | 'failed' | 'unknown';
  verificationSteps: string[];
  result: 'passed' | 'failed' | 'incomplete';
  evidenceReferences: string[];
}
export interface ManualDataRecordView extends CreateManualDataRecordInput {
  id: string;
  volumeId: string;
  actorId: string | null;
  createdAt: string;
  verificationSource: 'operator_reported';
  durationMs: number;
}
