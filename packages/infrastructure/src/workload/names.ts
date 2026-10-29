import { createHash } from 'node:crypto';
import type {
  V1Deployment,
  V1Namespace,
  V1Secret,
  V1Service,
  V1StatefulSet,
} from '@kubernetes/client-node' with {
  'resolution-mode': 'import',
};
import type { PublishedWorkload, WorkloadControllerIdentity, WorkloadTarget } from './contracts.js';

export const keys = {
  installation: 'ozz.dev/installation-id',
  project: 'ozz.dev/project-id',
  environment: 'ozz.dev/environment-id',
  service: 'ozz.dev/service-id',
  cluster: 'ozz.dev/cluster-id',
  nonce: 'ozz.dev/creation-nonce',
  mutation: 'ozz.dev/mutation-revision',
  configuration: 'ozz.dev/config-revision',
  snapshot: 'ozz.dev/snapshot-id',
  task: 'ozz.dev/task-id',
  rollout: 'ozz.dev/rollout-id',
  role: 'ozz.dev/resource-role',
  claims: 'ozz.dev/pvc-uids',
} as const;

export type Resource = V1Namespace | V1Deployment | V1StatefulSet | V1Service | V1Secret;
export type Controller = V1Deployment | V1StatefulSet;

export function publishedController(published: PublishedWorkload): WorkloadControllerIdentity {
  return published.controller ?? { kind: 'Deployment', uid: published.deploymentUid };
}

/** Stable names have no display name, slug or page context in their derivation. */
export function workloadNames(
  target: Pick<WorkloadTarget, 'environmentId' | 'serviceId'>,
  snapshotId?: string,
) {
  return {
    namespace: `ozz-e-${target.environmentId.replaceAll('-', '')}`,
    deployment: `ozz-s-${target.serviceId.replaceAll('-', '')}`,
    service: `ozz-s-${target.serviceId.replaceAll('-', '')}`,
    headlessService: `ozz-h-${target.serviceId.replaceAll('-', '')}`,
    statefulSet: `ozz-s-${target.serviceId.replaceAll('-', '')}`,
    pullSecret: `ozz-p-${target.serviceId.replaceAll('-', '')}`,
    runtimeSecret: snapshotId ? `ozz-r-${snapshotId.replaceAll('-', '')}` : null,
  };
}

export function selector(target: WorkloadTarget) {
  return {
    [keys.installation]: target.installationId,
    [keys.service]: target.serviceId,
  };
}

export function selectorText(target: WorkloadTarget): string {
  return Object.entries(selector(target))
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

export function ownershipLabels(
  target: Omit<WorkloadTarget, 'serviceId'> & { serviceId?: string },
  namespace = false,
) {
  return {
    'app.kubernetes.io/managed-by': 'ozz',
    [keys.installation]: target.installationId,
    [keys.cluster]: target.clusterId,
    [keys.project]: target.projectId,
    [keys.environment]: target.environmentId,
    ...(namespace ? {} : { [keys.service]: target.serviceId! }),
  };
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sorted(value)))
    .digest('hex');
}

export function specFingerprint(resource: Resource): string | null {
  if (resource.kind === 'Secret' || resource.kind === 'Namespace') return null;
  return fingerprint((resource as Controller | V1Service).spec ?? null);
}

export function templateFingerprint(deployment: Controller): string {
  const value = structuredClone(deployment.spec?.template ?? {});
  // The restart token changes Pod identity without changing published configuration.
  if (value.metadata?.annotations) delete value.metadata.annotations[keys.rollout];
  if (value.metadata) {
    delete value.metadata.creationTimestamp;
    delete value.metadata.resourceVersion;
    delete value.metadata.uid;
    delete value.metadata.generation;
    delete value.metadata.managedFields;
  }
  return fingerprint(value);
}

export function workloadFingerprint(deployment: Controller): string {
  const value = structuredClone(deployment.spec);
  if (!value) return fingerprint(null);
  delete value.replicas;
  if (value.template?.metadata?.annotations)
    delete value.template.metadata.annotations[keys.rollout];
  if (value.template?.metadata) {
    delete value.template.metadata.creationTimestamp;
    delete value.template.metadata.resourceVersion;
    delete value.template.metadata.uid;
    delete value.template.metadata.generation;
    delete value.template.metadata.managedFields;
  }
  return fingerprint(value);
}

export function revision(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,14})$/u.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
