import {
  KubernetesAdapterError,
  type KubernetesCapabilities,
  type KubernetesCapabilityState,
} from './contracts.js';
import { safeKubernetesError, type InspectionClient } from './transport.js';
import { hasControlCharacters } from './text.js';

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 253 || hasControlCharacters(value))
    throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
  return value;
}

function failure(error: unknown) {
  const safe = safeKubernetesError(error);
  if (safe.code === 'KUBERNETES_CANCELLED') throw safe;
  const state: KubernetesCapabilityState =
    safe.code === 'KUBERNETES_FORBIDDEN'
      ? 'forbidden'
      : safe.code === 'KUBERNETES_API_NOT_FOUND'
        ? 'unavailable'
        : 'unknown';
  return { state, errorCode: safe.code };
}

interface ClassMetadata {
  name?: string;
  annotations?: Record<string, string>;
}

async function classes<T extends { metadata?: ClassMetadata }>(
  read: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; metadata?: { _continue?: string; resourceVersion?: string } }>,
): Promise<T[]> {
  const items: T[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let resourceVersion: string | undefined;
  for (let page = 0; page < 8; page += 1) {
    const result = await read(cursor);
    if (!Array.isArray(result.items))
      throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
    if (items.length + result.items.length > 100)
      throw new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
    if (page > 0 && result.metadata?.resourceVersion !== resourceVersion)
      throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
    resourceVersion = result.metadata?.resourceVersion;
    for (const item of result.items) {
      const name = text(item.metadata?.name);
      if (names.has(name)) throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
      names.add(name);
      items.push(item);
    }
    const next = result.metadata?._continue;
    if (next === undefined || next === '') return items;
    if (typeof next !== 'string' || next.length > 16 * 1024 || cursors.has(next))
      throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
    cursor = next;
    cursors.add(cursor);
  }
  throw new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
}

async function ingress(client: InspectionClient): Promise<KubernetesCapabilities['ingress']> {
  try {
    const found = await classes((cursor) =>
      client.networking.listIngressClass({ limit: 50, _continue: cursor }),
    );
    return {
      state: found.length ? 'available' : 'unavailable',
      errorCode: null,
      classes: found.map((item) => ({
        name: text(item.metadata?.name),
        controller: text(item.spec?.controller),
        isDefault:
          item.metadata?.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true',
      })),
    };
  } catch (error) {
    return { ...failure(error), classes: [] };
  }
}

async function storage(client: InspectionClient): Promise<KubernetesCapabilities['storage']> {
  try {
    const found = await classes((cursor) =>
      client.storage.listStorageClass({ limit: 50, _continue: cursor }),
    );
    return {
      state: found.length ? 'available' : 'unavailable',
      errorCode: null,
      classes: found.map((item) => ({
        name: text(item.metadata?.name),
        provisioner: text(item.provisioner),
        isDefault:
          item.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ||
          item.metadata?.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] ===
            'true',
        volumeBindingMode:
          item.volumeBindingMode === 'Immediate' ||
          item.volumeBindingMode === 'WaitForFirstConsumer'
            ? item.volumeBindingMode
            : null,
        reclaimPolicy:
          item.reclaimPolicy === 'Delete' || item.reclaimPolicy === 'Retain'
            ? item.reclaimPolicy
            : null,
        allowVolumeExpansion:
          typeof item.allowVolumeExpansion === 'boolean' ? item.allowVolumeExpansion : null,
      })),
    };
  } catch (error) {
    return { ...failure(error), classes: [] };
  }
}

async function traefik(client: InspectionClient): Promise<KubernetesCapabilities['traefik']> {
  const target = { namespace: 'kube-system' as const, deployment: 'traefik' as const };
  try {
    const deployment = await client.apps.readNamespacedDeployment({
      namespace: target.namespace,
      name: target.deployment,
    });
    if (
      deployment.metadata?.name !== target.deployment ||
      deployment.metadata?.namespace !== target.namespace
    )
      throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
    const count = (value: unknown): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const desiredReplicas = count(deployment.spec?.replicas);
    const readyReplicas = count(
      deployment.status?.readyReplicas ?? (deployment.status ? 0 : undefined),
    );
    const availableReplicas = count(
      deployment.status?.availableReplicas ?? (deployment.status ? 0 : undefined),
    );
    const generation = count(deployment.metadata?.generation);
    const observedGeneration = count(deployment.status?.observedGeneration);
    const ready =
      desiredReplicas === null ||
      readyReplicas === null ||
      availableReplicas === null ||
      generation === null ||
      observedGeneration === null
        ? null
        : desiredReplicas > 0 &&
          observedGeneration >= generation &&
          readyReplicas >= desiredReplicas &&
          availableReplicas >= desiredReplicas;
    return {
      ...target,
      state: 'available',
      ready,
      desiredReplicas,
      readyReplicas,
      availableReplicas,
      errorCode: null,
    };
  } catch (error) {
    return {
      ...target,
      ...failure(error),
      ready: null,
      desiredReplicas: null,
      readyReplicas: null,
      availableReplicas: null,
    };
  }
}

export async function readCapabilities(
  client: InspectionClient,
): Promise<Omit<KubernetesCapabilities, 'metrics'>> {
  const values = await Promise.all([ingress(client), traefik(client), storage(client)]);
  return { ingress: values[0], traefik: values[1], storage: values[2] };
}
