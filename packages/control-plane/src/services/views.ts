import { observedConnectionStatus } from '../infrastructure/persistence.js';
import {
  SERVICE_OBSERVATION_STALE_MS,
  type ServiceRuntimeState,
  type ServiceSnapshot,
  type ServiceView,
} from './contracts.js';
import type { ServiceRecord } from './persistence.js';
import { observedController } from './snapshots.js';
import type { GitSourceRevision, ServiceSourceView } from '../git/contracts.js';

export function presentService(service: ServiceRecord): ServiceView {
  const project = service.environment.project;
  const cluster = project.cluster;
  const observation = service.observationJson as ServiceView['observation'];
  const controller = observedController(observation);
  let stale =
    !service.lastObservedAt ||
    Date.now() - service.lastObservedAt.getTime() > SERVICE_OBSERVATION_STALE_MS ||
    Boolean(service.observationErrorCode);
  const snapshot = service.publishedDeployment?.snapshotJson as unknown as
    ServiceSnapshot | undefined;
  const published =
    service.publishedDeployment?.appliedAt && snapshot
      ? {
          deploymentId: service.publishedDeployment.id,
          configRevision: service.publishedDeployment.configRevision,
          configuration: snapshot.configuration,
          source: snapshot.version === 3 ? snapshot.source : { kind: 'image' as const },
          image: service.publishedDeployment.resolvedImageJson as unknown as NonNullable<
            ServiceView['published']
          >['image'],
          appliedAt: service.publishedDeployment.appliedAt.toISOString(),
        }
      : null;
  // A recent timestamp from the prior rollout cannot describe a publication
  // that was completely applied afterwards, even when its health wait failed.
  stale ||= Boolean(
    published &&
    ((service.lastObservedAt &&
      service.lastObservedAt.getTime() < Date.parse(published.appliedAt)) ||
      (controller &&
        (controller.snapshotId !== published.deploymentId ||
          controller.configRevision !== published.configRevision))),
  );
  const activePods =
    observation?.pods.filter((pod) => pod.phase !== 'Succeeded' && pod.phase !== 'Failed') ?? [];
  let runtimeState: ServiceRuntimeState = 'unknown';
  if (!service.remoteCreatedAt && !published) runtimeState = 'unpublished';
  else if (stale || !observation) runtimeState = 'unknown';
  else if (!controller) runtimeState = 'missing';
  else {
    const deployment = controller;
    const observed = (deployment.observedGeneration ?? -1) >= deployment.generation;
    if (
      observed &&
      deployment.replicas === 0 &&
      activePods.length === 0 &&
      !observation.podsTruncated
    )
      runtimeState = 'stopped';
    else if (
      observed &&
      deployment.replicas > 0 &&
      (deployment.updatedReplicas ?? 0) >= deployment.replicas &&
      (deployment.readyReplicas ?? 0) >= deployment.replicas &&
      (deployment.availableReplicas ?? 0) >= deployment.replicas &&
      !deployment.deleting &&
      service.configurationState === 'consistent' &&
      observation.configurationState === 'consistent' &&
      !observation.podsTruncated &&
      activePods.length === deployment.replicas &&
      activePods.every(
        (pod) =>
          !pod.deletionTimestamp &&
          pod.ready === true &&
          pod.phase === 'Running' &&
          (pod.matchesControllerTemplate ?? pod.matchesDeploymentTemplate) &&
          pod.snapshotId === deployment.snapshotId &&
          pod.configRevision === deployment.configRevision &&
          pod.rolloutId === deployment.rolloutId,
      )
    )
      runtimeState = 'running';
    else if (
      deployment.progressDeadlineExceeded ||
      observation.pods.some(
        (pod) =>
          pod.phase === 'Failed' ||
          pod.containers.some(
            (container) =>
              container.oomKilled ||
              [
                'CrashLoopBackOff',
                'ImagePullBackOff',
                'ErrImagePull',
                'CreateContainerConfigError',
              ].includes(container.reason ?? ''),
          ),
      )
    )
      runtimeState = 'degraded';
    else runtimeState = 'pending';
  }
  const active = service.activeMutation;
  const source: ServiceSourceView =
    service.sourceKind === 'github' && service.gitSource?.currentRevision
      ? {
          kind: 'github',
          sourceId: service.gitSource.id,
          currentRevision: service.gitSource.currentRevision
            .snapshotJson as unknown as GitSourceRevision,
          autoDeploy: service.gitSource.autoDeploy,
          policyRevision: service.gitSource.policyRevision,
        }
      : { kind: 'image' };
  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    description: service.description,
    kind: service.kind,
    controller: service.database
      ? { kind: 'StatefulSet', strategy: 'RollingUpdate' }
      : {
          kind: 'Deployment',
          strategy: service.volumeMounts.some((mount) => !mount.readOnly)
            ? 'Recreate'
            : 'RollingUpdate',
        },
    template:
      service.templateId && service.templateVersion
        ? { id: service.templateId, version: service.templateVersion }
        : null,
    databaseInstanceId: service.database?.id ?? null,
    environmentId: service.environmentId,
    projectId: project.id,
    clusterId: cluster.id,
    project: { id: project.id, name: project.name, slug: project.slug },
    environment: {
      id: service.environment.id,
      name: service.environment.name,
      slug: service.environment.slug,
    },
    cluster: {
      id: cluster.id,
      name: cluster.name,
      slug: cluster.slug,
      connectionStatus: observedConnectionStatus(cluster),
      lastObservedAt: cluster.lastObservedAt?.toISOString() ?? null,
    },
    revision: service.revision,
    configRevision: service.configRevision,
    mutationRevision: service.mutationRevision,
    configuration: service.configJson as unknown as ServiceView['configuration'],
    source,
    registryCredentialRefId: service.registryCredentialRefId,
    desiredState: service.desiredState,
    configurationState: service.configurationState,
    runtimeState,
    hasUnpublishedChanges:
      !published ||
      published.configRevision !== service.configRevision ||
      (source.kind === 'github' &&
        (published.source.kind !== 'github' ||
          published.source.revision.id !== source.currentRevision.id)) ||
      (source.kind === 'image' && published.source.kind !== 'image'),
    published,
    lastSuccessfulDeploymentId: service.lastSuccessfulDeploymentId,
    activeTask: active?.deployment
      ? {
          type: 'deployment',
          id: active.deployment.id,
          kind: active.deployment.kind,
          status:
            active.deployment.status === 'running'
              ? active.deployment.phase
              : active.deployment.status,
        }
      : active?.operation
        ? {
            type: 'operation',
            id: active.operation.id,
            kind: active.operation.kind,
            status: active.operation.status,
          }
        : null,
    observation,
    observationStale: stale,
    remoteCreatedAt: service.remoteCreatedAt?.toISOString() ?? null,
    lastObservedAt: service.lastObservedAt?.toISOString() ?? null,
    lastErrorCode: service.lastErrorCode,
    lastErrorMessage: service.lastErrorMessage,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}
