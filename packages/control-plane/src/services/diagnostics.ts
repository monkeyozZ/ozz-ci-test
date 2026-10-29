import type {
  WorkloadObservation,
  WorkloadDeploymentObservation,
} from '@ozz/infrastructure/workload';
import type { DeploymentFailureObservation } from './contracts.js';

// Kubernetes reason/message fields may contain application-controlled text.
// Persist only recognized status codes; raw messages, images and specs stay out.
const containerReasons = new Set([
  'OOMKilled',
  'Error',
  'Completed',
  'CrashLoopBackOff',
  'ContainerCreating',
  'PodInitializing',
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
  'ErrImageNeverPull',
  'ContainerCannotRun',
  'StartError',
  'DeadlineExceeded',
]);
const knownContainerReason = (reason: string | null) =>
  reason !== null && containerReasons.has(reason) ? reason : null;

function controllerEvidence(
  value: WorkloadDeploymentObservation,
): NonNullable<DeploymentFailureObservation['deployment']> {
  return {
    uid: value.uid,
    resourceVersion: value.resourceVersion,
    snapshotId: value.snapshotId,
    configRevision: value.configRevision,
    mutationRevision: value.mutationRevision,
    generation: value.generation,
    observedGeneration: value.observedGeneration,
    rolloutId: value.rolloutId,
    replicas: value.replicas,
    currentReplicas: value.currentReplicas,
    readyReplicas: value.readyReplicas,
    updatedReplicas: value.updatedReplicas,
    availableReplicas: value.availableReplicas,
    templateFingerprint: value.templateFingerprint,
    workloadFingerprint: value.workloadFingerprint,
    progressDeadlineExceeded: value.progressDeadlineExceeded,
  };
}

/** Keep bounded controlled statuses and identities, never raw specs, messages or Events. */
export function workloadFailureObservation(
  observation: WorkloadObservation,
  failure: Pick<DeploymentFailureObservation, 'attempt' | 'errorCode' | 'capturedAt'>,
): DeploymentFailureObservation {
  const deployment = observation.deployment;
  const resources = [...observation.resources].sort(
    (a, b) => Number(a.state === 'verified') - Number(b.state === 'verified'),
  );
  return {
    attempt: failure.attempt,
    errorCode: failure.errorCode,
    capturedAt: failure.capturedAt,
    observedAt: observation.observedAt,
    configurationState: observation.configurationState,
    drift: observation.drift.slice(0, 128).map((item) => ({
      kind: item.kind,
      name: item.name,
      reason: item.reason,
    })),
    resources: resources.slice(0, 64).map((item) => ({
      kind: item.kind,
      name: item.name,
      namespace: item.namespace,
      expectedUid: item.expectedUid,
      observedUid: item.observedUid,
      resourceVersion: item.resourceVersion,
      state: item.state,
      reason: item.reason,
    })),
    deployment: deployment ? controllerEvidence(deployment) : null,
    ...(observation.controller !== undefined
      ? {
          controller: observation.controller
            ? {
                ...controllerEvidence(observation.controller),
                kind: observation.controller.kind,
                strategy: observation.controller.strategy,
                currentRevision: observation.controller.currentRevision,
                updateRevision: observation.controller.updateRevision,
              }
            : null,
        }
      : {}),
    pods: observation.pods.slice(0, 32).map((pod) => ({
      uid: pod.uid,
      name: pod.name,
      snapshotId: pod.snapshotId,
      configRevision: pod.configRevision,
      rolloutId: pod.rolloutId,
      replicaSetUid: pod.replicaSetUid,
      matchesDeploymentTemplate: pod.matchesDeploymentTemplate,
      ...(pod.owner ? { owner: { kind: pod.owner.kind, uid: pod.owner.uid } } : {}),
      ...(pod.matchesControllerTemplate !== undefined
        ? { matchesControllerTemplate: pod.matchesControllerTemplate }
        : {}),
      phase: pod.phase,
      ready: pod.ready,
      deletionTimestamp: pod.deletionTimestamp,
      containers: pod.containers.slice(0, 16).map((container) => ({
        name: container.name,
        state: container.state,
        ready: container.ready,
        restartCount: container.restartCount,
        reason: knownContainerReason(container.reason),
        lastTerminationReason: knownContainerReason(container.lastTerminationReason),
        oomKilled: container.oomKilled,
        exitCode: container.exitCode,
      })),
    })),
    truncated: {
      drift: observation.drift.length > 128,
      resources: resources.length > 64,
      pods: observation.podsTruncated || observation.pods.length > 32,
      containers: observation.pods.some((pod) => pod.containers.length > 16),
    },
  };
}
