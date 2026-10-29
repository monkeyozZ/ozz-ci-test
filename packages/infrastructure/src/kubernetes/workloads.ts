import {
  KubernetesAdapterError,
  type KubernetesCapabilityState,
  type KubernetesWorkloadKind,
  type KubernetesWorkloadObservation,
  type KubernetesWorkloadSnapshot,
} from './contracts.js';
import { safeKubernetesError, type InspectionClient } from './transport.js';
import { hasControlCharacters } from './text.js';

interface WorkloadObject {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    generation?: number;
    deletionTimestamp?: Date;
    labels?: Record<string, string>;
  };
  spec?: unknown;
  status?: unknown;
}

interface WorkloadPage {
  items: WorkloadObject[];
  metadata?: { _continue?: string; resourceVersion?: string };
}

type Collection = KubernetesWorkloadObservation['collections'][number];

function text(value: unknown, max = 253): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlCharacters(value)
    ? value
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snapshot(kind: KubernetesWorkloadKind, item: WorkloadObject): KubernetesWorkloadSnapshot {
  const name = text(item.metadata?.name);
  const namespace = text(item.metadata?.namespace, 63);
  const uid = text(item.metadata?.uid, 128);
  if (!name || !namespace || !uid) throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
  const spec = fields(item.spec);
  const status = fields(item.status);
  const condition = (type: string) => {
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const value = conditions.map(fields).find((value) => value.type === type)?.status;
    return value === 'True' ? true : value === 'False' ? false : null;
  };
  const result: KubernetesWorkloadSnapshot = {
    kind,
    name,
    namespace,
    uid,
    status: 'unknown',
    ready: null,
    desiredReplicas: null,
    readyReplicas: null,
    managedBy: text(item.metadata?.labels?.['app.kubernetes.io/managed-by'], 63),
  };
  if (item.metadata?.deletionTimestamp) return { ...result, status: 'terminating', ready: false };
  if (kind === 'Pod') {
    const phase = status.phase;
    result.status =
      phase === 'Running'
        ? 'running'
        : phase === 'Pending'
          ? 'pending'
          : phase === 'Succeeded'
            ? 'succeeded'
            : phase === 'Failed'
              ? 'failed'
              : 'unknown';
    result.ready = condition('Ready');
    result.desiredReplicas = 1;
    result.readyReplicas = result.ready === null ? null : result.ready ? 1 : 0;
  } else if (kind === 'CronJob') {
    result.status =
      spec.suspend === true
        ? 'suspended'
        : typeof spec.schedule === 'string'
          ? 'scheduled'
          : 'unknown';
  } else if (kind === 'Job') {
    result.status =
      condition('Complete') === true
        ? 'succeeded'
        : condition('Failed') === true
          ? 'failed'
          : spec.suspend === true
            ? 'suspended'
            : (count(status.active) ?? 0) > 0
              ? 'running'
              : 'pending';
  } else {
    const daemon = kind === 'DaemonSet';
    const desired = count(daemon ? status.desiredNumberScheduled : spec.replicas);
    const ready = count(
      (daemon ? status.numberReady : status.readyReplicas) ?? (item.status ? 0 : undefined),
    );
    const generation = count(item.metadata?.generation);
    const observedGeneration = count(status.observedGeneration);
    result.desiredReplicas = desired;
    result.readyReplicas = ready;
    if (desired !== null && ready !== null && generation !== null && observedGeneration !== null) {
      result.ready = desired > 0 && ready >= desired && observedGeneration >= generation;
      result.status = result.ready
        ? 'ready'
        : desired === 0 && !daemon
          ? 'scaled_to_zero'
          : 'not_ready';
    }
  }
  return result;
}

async function readCollection(
  kind: KubernetesWorkloadKind,
  read: (cursor: string | undefined) => Promise<WorkloadPage>,
): Promise<{ items: KubernetesWorkloadSnapshot[]; collection: Collection }> {
  const items: KubernetesWorkloadSnapshot[] = [];
  const identities = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let resourceVersion: string | undefined;
  try {
    for (let page = 0; page < 8; page += 1) {
      const result = await read(cursor);
      if (
        !Array.isArray(result.items) ||
        (page > 0 && result.metadata?.resourceVersion !== resourceVersion)
      )
        throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
      resourceVersion = result.metadata?.resourceVersion;
      const remaining = 100 - items.length;
      for (const item of result.items.slice(0, remaining)) {
        const value = snapshot(kind, item);
        if (identities.has(value.uid))
          throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
        identities.add(value.uid);
        items.push(value);
      }
      const next = result.metadata?._continue;
      const more = next !== undefined && next !== '';
      const truncated = result.items.length > remaining || (items.length === 100 && more);
      if (truncated || !more)
        return {
          items,
          collection: {
            kind,
            state: 'available',
            listedCount: items.length,
            truncated,
            errorCode: null,
          },
        };
      if (typeof next !== 'string' || next.length > 16 * 1024 || cursors.has(next))
        throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
      cursor = next;
      cursors.add(cursor);
    }
    throw new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
  } catch (error) {
    const safe = safeKubernetesError(error);
    if (safe.code === 'KUBERNETES_CANCELLED') throw safe;
    const state: KubernetesCapabilityState =
      safe.code === 'KUBERNETES_FORBIDDEN'
        ? 'forbidden'
        : safe.code === 'KUBERNETES_API_NOT_FOUND'
          ? 'unavailable'
          : 'unknown';
    return {
      items: [],
      collection: { kind, state, listedCount: null, truncated: false, errorCode: safe.code },
    };
  }
}

export async function readWorkloads(
  client: InspectionClient,
  now: () => Date,
): Promise<KubernetesWorkloadObservation> {
  const results = await Promise.all([
    readCollection('Deployment', (cursor) =>
      client.apps.listDeploymentForAllNamespaces({ limit: 50, _continue: cursor }),
    ),
    readCollection('StatefulSet', (cursor) =>
      client.apps.listStatefulSetForAllNamespaces({ limit: 50, _continue: cursor }),
    ),
    readCollection('DaemonSet', (cursor) =>
      client.apps.listDaemonSetForAllNamespaces({ limit: 50, _continue: cursor }),
    ),
    readCollection('Job', (cursor) =>
      client.batch.listJobForAllNamespaces({ limit: 50, _continue: cursor }),
    ),
    readCollection('CronJob', (cursor) =>
      client.batch.listCronJobForAllNamespaces({ limit: 50, _continue: cursor }),
    ),
    readCollection('Pod', (cursor) =>
      client.core.listPodForAllNamespaces({ limit: 50, _continue: cursor }),
    ),
  ]);
  const available = results.filter((result) => result.collection.state === 'available').length;
  return {
    state: available === results.length ? 'available' : available > 0 ? 'partial' : 'unknown',
    items: results.flatMap((result) => result.items),
    collections: results.map((result) => result.collection),
    observedAt: now().toISOString(),
  };
}
