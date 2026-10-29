import { OperationRequestError } from '../tasks/contracts.js';
import type { RuntimeConfiguration, ServiceConfiguration, ServiceSnapshot } from './contracts.js';
import { validateRuntimeConfiguration, validateServiceConfiguration } from './validation.js';
import type {
  WorkloadObservation,
  WorkloadControllerObservation,
} from '@ozz/infrastructure/workload';

/** Reads retained v1 bytes without replacing them with current draft defaults. */
export function readServiceSnapshot(value: unknown): ServiceSnapshot {
  const invalid = () =>
    new OperationRequestError(
      409,
      'DEPLOYMENT_SNAPSHOT_INVALID',
      '原发布快照无效，不能重新解释为当前草稿。',
    );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const v = value as Partial<ServiceSnapshot>;
  if (
    (v.version !== 1 && v.version !== 2 && v.version !== 3) ||
    typeof v.serviceId !== 'string' ||
    !Number.isSafeInteger(v.configRevision) ||
    Number(v.configRevision) < 1 ||
    !v.configuration ||
    typeof v.configuration !== 'object'
  )
    throw invalid();
  if (
    (v.version === 2 || v.version === 3) &&
    (!v.controller ||
      !['Deployment', 'StatefulSet'].includes(v.controller.kind) ||
      !Array.isArray(v.volumes) ||
      v.volumes.length > 8 ||
      !Array.isArray(v.databaseBindings) ||
      v.databaseBindings.length > 8 ||
      v.database === undefined ||
      v.template === undefined)
  )
    throw invalid();
  if (v.version === 3) {
    if (
      v.database !== null ||
      v.template !== null ||
      v.controller?.kind !== 'Deployment' ||
      !v.source ||
      v.source.kind !== 'github' ||
      !/^[0-9a-f]{40}$/.test(v.source.commitSha) ||
      !v.source.revision ||
      v.source.revision.version !== 1 ||
      typeof v.source.revision.id !== 'string' ||
      !/^[0-9a-f]{64}$/.test(v.source.revision.recipeHash) ||
      'image' in v.configuration
    )
      throw invalid();
    validateRuntimeConfiguration(v.configuration);
  }
  return value as ServiceSnapshot;
}

export function snapshotRuntime(snapshot: ServiceSnapshot): RuntimeConfiguration {
  if (snapshot.version === 3) return validateRuntimeConfiguration(snapshot.configuration);
  const { image: _image, ...runtime } = validateServiceConfiguration(snapshot.configuration);
  return runtime;
}

/** Supply an image only after resolving a pinned image/artifact; never persist it into V3. */
export function snapshotConfiguration(
  snapshot: ServiceSnapshot,
  deployReference?: string,
): ServiceConfiguration {
  if (snapshot.version !== 3) return validateServiceConfiguration(snapshot.configuration);
  if (!deployReference)
    throw new OperationRequestError(
      409,
      'BUILD_ARTIFACT_REQUIRED',
      'Git 发布尚未取得已验证的固定镜像产物。',
    );
  return validateServiceConfiguration({ ...snapshot.configuration, image: deployReference });
}

export function snapshotController(snapshot: ServiceSnapshot) {
  return snapshot.version === 1
    ? { kind: 'Deployment' as const, strategy: 'RollingUpdate' as const }
    : snapshot.controller;
}
export function snapshotVolumes(snapshot: ServiceSnapshot) {
  return snapshot.version === 1 ? [] : snapshot.volumes;
}
export function snapshotDatabaseBindings(snapshot: ServiceSnapshot) {
  return snapshot.version === 1 ? [] : snapshot.databaseBindings;
}

/** v1's Deployment field never describes a StatefulSet. */
export function observedController(
  observation: WorkloadObservation | null | undefined,
): WorkloadControllerObservation | null {
  if (!observation) return null;
  if (observation.controller !== undefined) return observation.controller;
  return observation.deployment
    ? {
        ...observation.deployment,
        kind: 'Deployment',
        strategy: 'RollingUpdate',
        currentRevision: null,
        updateRevision: null,
      }
    : null;
}
