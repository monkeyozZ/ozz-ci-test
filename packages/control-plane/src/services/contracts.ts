import type {
  WorkloadPort,
  WorkloadProbe,
  WorkloadResources,
  WorkloadControllerConfiguration,
} from '@ozz/infrastructure/workload';
import type { VolumeSnapshotReference } from '../storage/contracts.js';
import type {
  DatabaseSnapshot,
  DatabaseBindingSnapshot,
  TemplateSelection,
} from '../databases/contracts.js';
import type { ResolvedImage } from '@ozz/infrastructure/registry';
import type {
  WorkloadDeploymentObservation,
  WorkloadControllerObservation,
  WorkloadErrorCode,
  WorkloadObservation,
  WorkloadPodObservation,
  WorkloadContainerObservation,
  WorkloadRolloutTarget,
} from '@ozz/infrastructure/workload';
import { OperationRequestError, type TaskRef } from '../tasks/contracts.js';
import type { GitSourceInput, GitSourceSnapshot, ServiceSourceView } from '../git/contracts.js';

export class ServiceOperationActiveError extends OperationRequestError {
  constructor(readonly activeTask: TaskRef) {
    super(409, 'SERVICE_OPERATION_ACTIVE', '此服务有正在执行的变更，请先查看当前任务。');
  }
}

export interface ServiceVariable {
  name: string;
  value?: string;
  secretRefId?: string;
  secretKey?: string;
}

/** A raw secret is accepted only at the write boundary and replaced with an encrypted reference. */
export interface ServiceVariableInput extends ServiceVariable {
  secret?: boolean;
}

export interface ServiceConfiguration {
  image: string;
  replicas: number;
  command: string[];
  args: string[];
  ports: WorkloadPort[];
  resources: WorkloadResources;
  environment: ServiceVariable[];
  readiness: WorkloadProbe | null;
  startup: WorkloadProbe | null;
  healthTimeoutSeconds: number;
}

export interface ServiceConfigurationInput extends Partial<
  Omit<ServiceConfiguration, 'environment'>
> {
  image: string;
  environment?: ServiceVariableInput[];
}

export type RuntimeConfiguration = Omit<ServiceConfiguration, 'image'>;
export interface RuntimeConfigurationInput extends Partial<
  Omit<RuntimeConfiguration, 'environment'>
> {
  environment?: ServiceVariableInput[];
}

/** Endpoint and management authentication are resolved from this approved cluster identity. */
export interface ServiceTarget {
  installationId: string;
  clusterId: string;
  kubeSystemUid: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  namespace: string;
  serviceName: string;
}

interface ServiceSnapshotFields {
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  configRevision: number;
  configuration: ServiceConfiguration;
  deployAndStart: boolean;
  allowConfigurationRepair: boolean;
}
export interface ServiceSnapshotV1 extends ServiceSnapshotFields {
  version: 1;
}
export interface ServiceSnapshotV2 extends ServiceSnapshotFields {
  version: 2;
  controller: WorkloadControllerConfiguration;
  volumes: VolumeSnapshotReference[];
  database: DatabaseSnapshot | null;
  databaseBindings: DatabaseBindingSnapshot[];
  template: { id: string; version: string } | null;
}
export interface ServiceSnapshotV3 extends Omit<ServiceSnapshotFields, 'configuration'> {
  version: 3;
  configuration: RuntimeConfiguration;
  source: GitSourceSnapshot;
  controller: WorkloadControllerConfiguration & { kind: 'Deployment' };
  volumes: VolumeSnapshotReference[];
  database: null;
  databaseBindings: DatabaseBindingSnapshot[];
  template: null;
}
export type ServiceSnapshot = ServiceSnapshotV1 | ServiceSnapshotV2 | ServiceSnapshotV3;

export interface DeploymentResult {
  version: 1 | 2 | 3;
  published: WorkloadRolloutTarget;
  image: ResolvedImage;
  serviceDns: string | null;
  appliedAt: string;
  observation?: WorkloadObservation;
  /** Immutable evidence from the failed attempt, never a replacement for the live Service observation. */
  failureObservation?: DeploymentFailureObservation;
}

/** Database JSON may contain only failure evidence when no publication was completely applied. */
export type StoredDeploymentResult =
  DeploymentResult | { failureObservation: DeploymentFailureObservation };

export type DeploymentFailureContainer = Pick<
  WorkloadContainerObservation,
  'name' | 'state' | 'ready' | 'restartCount' | 'oomKilled' | 'exitCode'
> & { reason: string | null; lastTerminationReason: string | null };

export interface DeploymentFailureObservation {
  attempt: number;
  errorCode: WorkloadErrorCode;
  capturedAt: string;
  observedAt: string;
  configurationState: WorkloadObservation['configurationState'];
  drift: WorkloadObservation['drift'];
  resources: WorkloadObservation['resources'];
  deployment: Pick<
    WorkloadDeploymentObservation,
    | 'uid'
    | 'resourceVersion'
    | 'snapshotId'
    | 'configRevision'
    | 'mutationRevision'
    | 'generation'
    | 'observedGeneration'
    | 'rolloutId'
    | 'replicas'
    | 'currentReplicas'
    | 'readyReplicas'
    | 'updatedReplicas'
    | 'availableReplicas'
    | 'templateFingerprint'
    | 'workloadFingerprint'
    | 'progressDeadlineExceeded'
  > | null;
  controller?:
    | (NonNullable<DeploymentFailureObservation['deployment']> &
        Pick<
          WorkloadControllerObservation,
          'kind' | 'strategy' | 'currentRevision' | 'updateRevision'
        >)
    | null;
  pods: (Pick<
    WorkloadPodObservation,
    | 'uid'
    | 'name'
    | 'snapshotId'
    | 'configRevision'
    | 'rolloutId'
    | 'replicaSetUid'
    | 'matchesDeploymentTemplate'
    | 'owner'
    | 'matchesControllerTemplate'
    | 'phase'
    | 'ready'
    | 'deletionTimestamp'
  > & { containers?: DeploymentFailureContainer[] })[];
  truncated: { drift: boolean; resources: boolean; pods: boolean; containers?: boolean };
}

export interface CreateServiceInput {
  environmentId: string;
  projectId?: string;
  name: string;
  slug: string;
  description?: string | null;
  registryCredentialRefId?: string | null;
  configuration?: ServiceConfigurationInput | RuntimeConfigurationInput;
  source?: { kind: 'image' } | GitSourceInput;
  template?: TemplateSelection;
}

export interface UpdateServiceInput {
  revision: number;
  environmentId?: string;
  projectId?: string;
  name?: string;
  description?: string | null;
  registryCredentialRefId?: string | null;
  configuration?: ServiceConfigurationInput | RuntimeConfigurationInput;
}

export interface DeployServiceInput {
  revision: number;
  deployAndStart?: boolean;
  allowConfigurationRepair?: boolean;
}

export interface ServiceActionInput {
  revision: number;
}

export type RetryDeploymentInput = DeployServiceInput;

export type ServiceRuntimeState =
  'unpublished' | 'running' | 'pending' | 'stopped' | 'degraded' | 'missing' | 'unknown';

export interface ServiceView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  kind: string;
  controller: WorkloadControllerConfiguration;
  template: { id: string; version: string } | null;
  databaseInstanceId: string | null;
  environmentId: string;
  projectId: string;
  clusterId: string;
  project: { id: string; name: string; slug: string };
  environment: { id: string; name: string; slug: string };
  cluster: {
    id: string;
    name: string;
    slug: string;
    connectionStatus: 'unverified' | 'connected' | 'unreachable' | 'unknown';
    lastObservedAt: string | null;
  };
  revision: number;
  configRevision: number;
  mutationRevision: number;
  configuration: ServiceConfiguration | RuntimeConfiguration;
  source: ServiceSourceView;
  registryCredentialRefId: string | null;
  desiredState: 'running' | 'stopped';
  configurationState: 'unpublished' | 'consistent' | 'partial' | 'drifted' | 'unknown';
  runtimeState: ServiceRuntimeState;
  hasUnpublishedChanges: boolean;
  published: {
    deploymentId: string;
    configRevision: number;
    configuration: ServiceConfiguration | RuntimeConfiguration;
    source: { kind: 'image' } | GitSourceSnapshot;
    image: ResolvedImage | null;
    appliedAt: string;
  } | null;
  lastSuccessfulDeploymentId: string | null;
  activeTask: (TaskRef & { status: string; kind: string }) | null;
  observation: WorkloadObservation | null;
  observationStale: boolean;
  remoteCreatedAt: string | null;
  lastObservedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceListQuery {
  limit?: number;
  cursor?: string;
  search?: string;
  projectId?: string;
  environmentId?: string;
  clusterId?: string;
}

export type ServiceAction = 'restart' | 'stop' | 'resume' | 'delete';

export const SERVICE_CONFIG_MAX_BYTES = 24 * 1024;
export const SERVICE_RUNTIME_ENV_MAX_BYTES = 24 * 1024;
export const SERVICE_OBSERVATION_STALE_MS = 90_000;
export const SERVICE_OBSERVATION_INTERVAL_MS = 15_000;
