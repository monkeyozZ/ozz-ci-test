import type {
  CoreV1Event,
  V1Container,
  V1ContainerStatus,
  V1Deployment,
  V1ListMeta,
  V1ObjectMeta,
  V1Pod,
  V1PodTemplateSpec,
  V1ReplicaSet,
  V1Secret,
  V1Service,
  V1StatefulSet,
  V1ControllerRevision,
} from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import { KubernetesAdapterError, type KubernetesErrorCode } from '../kubernetes/contracts.js';
import type { InspectionClient } from '../kubernetes/transport.js';
import {
  WorkloadAdapterError,
  type ManagedWorkloadResource,
  type WorkloadContainerObservation,
  type WorkloadDeploymentObservation,
  type WorkloadControllerObservation,
  type WorkloadEventObservation,
  type WorkloadMetrics,
  type WorkloadObservation,
  type WorkloadPodObservation,
  type WorkloadTarget,
} from './contracts.js';
import {
  fingerprint,
  keys,
  revision,
  selector,
  selectorText,
  specFingerprint,
  templateFingerprint,
  workloadFingerprint,
  workloadNames,
  type Resource,
  type Controller,
} from './names.js';
import { actualRevision, assertOwnership, readResource, safeWorkloadError } from './resources.js';
import { record, requireText, resourceKey, text, uuid, validateController } from './validation.js';
import { count, date, quantity, unknownMetrics, windowSeconds } from './values.js';

interface Page<T> {
  items: T[];
  metadata?: V1ListMeta;
}

async function pages<T extends { metadata?: V1ObjectMeta }>(
  read: (cursor: string | undefined, limit: number) => Promise<Page<T>>,
  max: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  const cursors = new Set<string>();
  const identities = new Set<string>();
  let cursor: string | undefined;
  let version: string | undefined;
  for (let page = 0; page < 32; page += 1) {
    const value = await read(cursor, Math.min(max, 100));
    if (!Array.isArray(value.items) || (page > 0 && value.metadata?.resourceVersion !== version))
      throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
    version = value.metadata?.resourceVersion;
    for (const item of value.items) {
      const uid = requireText(item.metadata?.uid, 128);
      if (identities.has(uid)) throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
      identities.add(uid);
      if (items.length === max) return { items, truncated: true };
      items.push(item);
    }
    const next = value.metadata?._continue;
    if (next === undefined || next === '') return { items, truncated: false };
    if (items.length === max) return { items, truncated: true };
    cursor = requireText(next, 16 * 1024);
    if (cursors.has(cursor)) throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
    cursors.add(cursor);
  }
  throw new WorkloadAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
}

/** Ask the official Secret list operation for metadata to keep secret bodies off this read path. */
async function secretMetadata(client: InspectionClient, target: WorkloadTarget) {
  const sdk = await import('@kubernetes/client-node');
  const middleware = sdk.createConfiguration({
    promiseMiddleware: [
      {
        pre: async (context) => {
          context.setHeaderParam(
            'Accept',
            'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1,application/json;q=0.9',
          );
          return context;
        },
        post: async (context) => context,
      },
    ],
  }).middleware;
  return pages<V1Secret>(
    (cursor, limit) =>
      client.core.listNamespacedSecret(
        {
          namespace: target.namespace,
          labelSelector: selectorText(target),
          limit: Math.min(limit, 50),
          _continue: cursor,
        },
        { middleware },
      ),
    512,
  );
}

function containerSnapshot(
  container: V1Container,
  status: V1ContainerStatus | undefined,
): WorkloadContainerObservation {
  const state = status?.state;
  const terminated = state?.terminated;
  const reason = text(state?.waiting?.reason ?? terminated?.reason, 128);
  const lastReason = text(status?.lastState?.terminated?.reason, 128);
  return {
    name: requireText(container.name, 63),
    image: text(container.image, 512) ?? '',
    imageId: text(status?.imageID, 1024),
    ready: typeof status?.ready === 'boolean' ? status.ready : null,
    restartCount: count(status?.restartCount),
    state: state?.running
      ? 'running'
      : state?.waiting
        ? 'waiting'
        : state?.terminated
          ? 'terminated'
          : 'unknown',
    reason,
    lastTerminationReason: lastReason,
    oomKilled: reason === 'OOMKilled' || lastReason === 'OOMKilled',
    exitCode:
      typeof terminated?.exitCode === 'number' && Number.isSafeInteger(terminated.exitCode)
        ? terminated.exitCode
        : null,
    requests: {
      cpuCores: quantity(container.resources?.requests?.cpu),
      memoryBytes: quantity(container.resources?.requests?.memory),
    },
    limits: {
      cpuCores: quantity(container.resources?.limits?.cpu),
      memoryBytes: quantity(container.resources?.limits?.memory),
    },
    metrics: unknownMetrics(),
  };
}

function podSnapshot(
  pod: V1Pod,
  controller: V1ReplicaSet | V1StatefulSet,
  matchesDeploymentTemplate: boolean,
): WorkloadPodObservation {
  if (!pod.spec || !Array.isArray(pod.spec.containers) || pod.spec.containers.length > 32)
    throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
  const rawPhase = pod.status?.phase;
  const phase =
    rawPhase === 'Pending' ||
    rawPhase === 'Running' ||
    rawPhase === 'Succeeded' ||
    rawPhase === 'Failed'
      ? rawPhase
      : 'Unknown';
  const ready = pod.status?.conditions?.find((condition) => condition.type === 'Ready')?.status;
  const snapshotId = pod.metadata?.labels?.[keys.snapshot];
  const controllerSnapshotId = controller.spec?.template?.metadata?.labels?.[keys.snapshot];
  const configurationMatches =
    pod.metadata?.labels?.[keys.configuration] ===
    controller.spec?.template?.metadata?.labels?.[keys.configuration];
  return {
    uid: requireText(pod.metadata?.uid, 128),
    name: requireText(pod.metadata?.name, 253),
    namespace: requireText(pod.metadata?.namespace, 63),
    nodeName: text(pod.spec.nodeName, 253),
    createdAt: date(pod.metadata?.creationTimestamp),
    deletionTimestamp: date(pod.metadata?.deletionTimestamp),
    phase,
    ready: ready === 'True' ? true : ready === 'False' ? false : null,
    // Pod labels alone are mutable. An old Pod relabelled as a different
    // publication must never select that publication's log-redaction secrets.
    snapshotId:
      uuid(snapshotId) && snapshotId === controllerSnapshotId && configurationMatches
        ? snapshotId
        : null,
    configRevision: revision(pod.metadata?.labels?.[keys.configuration]),
    rolloutId: text(pod.metadata?.annotations?.[keys.rollout], 128),
    replicaSetUid:
      controller.kind === 'ReplicaSet' ? requireText(controller.metadata?.uid, 128) : null,
    owner: {
      kind: controller.kind === 'ReplicaSet' ? 'ReplicaSet' : 'StatefulSet',
      uid: requireText(controller.metadata?.uid, 128),
    },
    matchesControllerTemplate: matchesDeploymentTemplate,
    matchesDeploymentTemplate: controller.kind === 'ReplicaSet' && matchesDeploymentTemplate,
    containers: pod.spec.containers.map((container) =>
      containerSnapshot(
        container,
        pod.status?.containerStatuses?.find((status) => status.name === container.name),
      ),
    ),
  };
}

function controllerTemplateFingerprint(template: V1PodTemplateSpec | undefined): string | null {
  if (!template?.spec || !Array.isArray(template.spec.containers)) return null;
  const value = structuredClone(template);
  if (value.metadata) {
    // The Deployment controller adds this label when creating the ReplicaSet template.
    if (value.metadata.labels) delete value.metadata.labels['pod-template-hash'];
    delete value.metadata.creationTimestamp;
    delete value.metadata.resourceVersion;
    delete value.metadata.uid;
    delete value.metadata.generation;
    delete value.metadata.managedFields;
  }
  // Unlike the published configuration fingerprint, the rollout token must match here.
  return fingerprint(value);
}

function declaredImagesMatchController(
  pod: V1Pod,
  controller: V1ReplicaSet | V1StatefulSet,
): boolean {
  const expected = controller.spec?.template?.spec?.containers;
  const actual = pod.spec?.containers;
  return Boolean(
    expected &&
    actual &&
    expected.length === actual.length &&
    actual.every((container) =>
      expected.some((value) => value.name === container.name && value.image === container.image),
    ),
  );
}

function ownsReplicaSet(
  target: WorkloadTarget,
  deployment: V1Deployment,
  replicaSet: V1ReplicaSet,
): boolean {
  return Boolean(
    replicaSet.metadata?.namespace === target.namespace &&
    Object.entries(selector(target)).every(
      ([key, value]) => replicaSet.metadata?.labels?.[key] === value,
    ) &&
    replicaSet.metadata.ownerReferences?.some(
      (reference) =>
        reference.controller === true &&
        reference.kind === 'Deployment' &&
        reference.name === deployment.metadata!.name &&
        reference.uid === deployment.metadata!.uid,
    ),
  );
}

async function readReplicaSet(
  client: InspectionClient,
  target: WorkloadTarget,
  name: string,
): Promise<V1ReplicaSet | null> {
  try {
    const replicaSet = await client.apps.readNamespacedReplicaSet({
      namespace: target.namespace,
      name,
    });
    if (
      replicaSet.kind !== 'ReplicaSet' ||
      replicaSet.apiVersion !== 'apps/v1' ||
      replicaSet.metadata?.name !== name ||
      replicaSet.metadata.namespace !== target.namespace
    )
      throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
    requireText(replicaSet.metadata.uid, 128);
    return replicaSet;
  } catch (error) {
    if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return null;
    throw safeWorkloadError(error);
  }
}

async function listedPodIsStale(
  client: InspectionClient,
  target: WorkloadTarget,
  pod: V1Pod,
): Promise<boolean> {
  const name = requireText(pod.metadata?.name, 253);
  try {
    const current = await client.core.readNamespacedPod({ namespace: target.namespace, name });
    if (
      current.kind !== 'Pod' ||
      current.apiVersion !== 'v1' ||
      current.metadata?.name !== name ||
      current.metadata.namespace !== target.namespace
    )
      throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
    return requireText(current.metadata.uid, 128) !== requireText(pod.metadata?.uid, 128);
  } catch (error) {
    if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return true;
    throw safeWorkloadError(error);
  }
}

export function deploymentSnapshot(value: V1Deployment): WorkloadDeploymentObservation {
  return controllerSnapshot(value);
}

export function controllerSnapshot(value: Controller): WorkloadControllerObservation {
  validateController(value);
  const snapshotId = value.spec!.template.metadata?.labels?.[keys.snapshot];
  const primary = value.spec!.template.spec!.containers.find(
    (container) => container.name === 'app',
  );
  const replicas = count(value.spec?.replicas);
  if (replicas === null) throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
  return {
    kind: value.kind === 'StatefulSet' ? 'StatefulSet' : 'Deployment',
    strategy:
      value.kind === 'StatefulSet'
        ? (value as V1StatefulSet).spec?.updateStrategy?.type === 'OnDelete'
          ? 'OnDelete'
          : 'RollingUpdate'
        : (value as V1Deployment).spec?.strategy?.type === 'Recreate'
          ? 'Recreate'
          : 'RollingUpdate',
    currentRevision:
      value.kind === 'StatefulSet'
        ? text((value as V1StatefulSet).status?.currentRevision, 253)
        : null,
    updateRevision:
      value.kind === 'StatefulSet'
        ? text((value as V1StatefulSet).status?.updateRevision, 253)
        : null,
    uid: requireText(value.metadata?.uid, 128),
    resourceVersion: requireText(value.metadata?.resourceVersion, 128),
    generation: value.metadata!.generation!,
    observedGeneration: count(value.status?.observedGeneration),
    replicas,
    currentReplicas: count(value.status?.replicas ?? (value.status ? 0 : undefined)),
    updatedReplicas: count(value.status?.updatedReplicas ?? (value.status ? 0 : undefined)),
    readyReplicas: count(value.status?.readyReplicas ?? (value.status ? 0 : undefined)),
    availableReplicas: count(value.status?.availableReplicas ?? (value.status ? 0 : undefined)),
    snapshotId: uuid(snapshotId) ? snapshotId : null,
    configRevision: revision(value.spec!.template.metadata?.labels?.[keys.configuration]),
    mutationRevision: actualRevision(value),
    rolloutId: text(value.spec!.template.metadata?.annotations?.[keys.rollout], 128),
    image: text(primary?.image, 512),
    templateFingerprint: templateFingerprint(value),
    workloadFingerprint: workloadFingerprint(value),
    progressDeadlineExceeded:
      value.status?.conditions?.some(
        (condition) =>
          condition.type === 'Progressing' &&
          condition.status === 'False' &&
          condition.reason === 'ProgressDeadlineExceeded',
      ) ?? false,
    deleting: Boolean(value.metadata?.deletionTimestamp),
  };
}

interface MetricRecord {
  metadata?: V1ObjectMeta;
  timestamp?: unknown;
  window?: unknown;
  containers?: unknown;
}

async function podMetrics(
  client: InspectionClient,
  target: WorkloadTarget,
  pods: WorkloadPodObservation[],
  now: Date,
  maxPods: number,
): Promise<KubernetesErrorCode | null> {
  try {
    const result = await pages<MetricRecord>(async (cursor, limit) => {
      const raw: unknown = await client.custom.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        plural: 'pods',
        namespace: target.namespace,
        labelSelector: selectorText(target),
        limit,
        _continue: cursor,
      });
      const value = record(raw);
      if (!Array.isArray(value.items))
        throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
      // Metrics APIs may omit UIDs. Only the bounded, same-inspection Pod name and timestamp join is allowed.
      const items = value.items.map((item) => {
        const data = record(item);
        const metadata = record(data.metadata);
        const name = requireText(metadata.name, 253);
        return {
          ...data,
          metadata: { ...metadata, name, uid: text(metadata.uid, 128) ?? `metric-${name}` },
        } as MetricRecord;
      });
      return { items, metadata: value.metadata as V1ListMeta | undefined };
    }, maxPods);
    const byName = new Map(pods.map((pod) => [pod.name, pod]));
    const seen = new Set<string>();
    for (const metric of result.items) {
      const name = requireText(metric.metadata?.name, 253);
      if (seen.has(name)) throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
      seen.add(name);
      const pod = byName.get(name);
      if (
        !pod ||
        (metric.metadata?.uid &&
          metric.metadata.uid !== `metric-${name}` &&
          metric.metadata.uid !== pod.uid)
      )
        continue;
      const observedAt = date(metric.timestamp);
      const window = windowSeconds(metric.window);
      if (
        !observedAt ||
        window === null ||
        Date.parse(observedAt) > now.getTime() + 30_000 ||
        now.getTime() - Date.parse(observedAt) > 120_000 ||
        (pod.createdAt && Date.parse(observedAt) < Date.parse(pod.createdAt)) ||
        !Array.isArray(metric.containers) ||
        metric.containers.length > 32
      )
        continue;
      for (const raw of metric.containers) {
        const value = record(raw);
        const container = pod.containers.find((container) => container.name === value.name);
        if (!container) continue;
        const usage = record(value.usage);
        const cpuCores = quantity(usage.cpu);
        const memoryBytes = quantity(usage.memory);
        if (cpuCores === null || memoryBytes === null) continue;
        container.metrics = {
          state: 'available',
          cpuCores,
          memoryBytes,
          observedAt,
          windowSeconds: window,
        };
      }
    }
    return result.truncated ? 'KUBERNETES_RESPONSE_TOO_LARGE' : null;
  } catch (error) {
    const safe = safeWorkloadError(error);
    for (const pod of pods)
      for (const container of pod.containers) container.metrics = unknownMetrics();
    if (safe.code === 'KUBERNETES_CANCELLED') throw safe;
    return safe.code.startsWith('KUBERNETES_')
      ? (safe.code as KubernetesErrorCode)
      : 'KUBERNETES_INVALID_RESPONSE';
  }
}

const eventMessages: Record<string, string> = {
  Failed: 'Kubernetes 未能完成此资源操作。',
  FailedScheduling: 'Pod 暂时无法调度，请检查节点容量、条件与资源请求。',
  FailedMount: 'Pod 挂载失败，请检查引用的存储或配置资源。',
  FailedCreate: '工作负载未能创建 Pod，请检查资源配额与集群策略。',
  FailedSync: 'Kubernetes 同步此资源失败。',
  BackOff: '容器启动或镜像拉取正在退避重试。',
  Unhealthy: '容器健康探针未通过。',
  Pulled: '容器镜像已经可用。',
  Pulling: '节点正在拉取容器镜像。',
  Created: '容器已经创建。',
  Started: '容器已经启动。',
  Killing: 'Kubernetes 正在终止容器。',
  Scheduled: 'Pod 已分配至节点。',
  SuccessfulCreate: '工作负载已创建 Pod。',
  SuccessfulDelete: '工作负载已删除 Pod。',
  ScalingReplicaSet: 'Deployment 正在调整 ReplicaSet 的副本。',
};

async function events(
  client: InspectionClient,
  target: WorkloadTarget,
  ownedUids: Set<string>,
  maxEvents: number,
) {
  try {
    const result = await pages<CoreV1Event>(
      (cursor, limit) =>
        client.core.listNamespacedEvent({ namespace: target.namespace, limit, _continue: cursor }),
      Math.min(1000, maxEvents * 5),
    );
    const matching = result.items.filter(
      (event) =>
        typeof event.involvedObject.uid === 'string' && ownedUids.has(event.involvedObject.uid),
    );
    const items: WorkloadEventObservation[] = matching
      .map((event): WorkloadEventObservation => {
        const reason = text(event.reason, 128) ?? 'Unknown';
        return {
          uid: requireText(event.metadata?.uid, 128),
          reason,
          type: event.type === 'Normal' || event.type === 'Warning' ? event.type : 'Unknown',
          objectUid: requireText(event.involvedObject.uid, 128),
          objectKind: text(event.involvedObject.kind, 63) ?? 'Unknown',
          objectName: text(event.involvedObject.name, 253) ?? 'Unknown',
          count: count(event.series?.count ?? event.count),
          firstObservedAt: date(
            event.firstTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp,
          ),
          lastObservedAt: date(
            event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime,
          ),
          message:
            eventMessages[reason] ?? 'Kubernetes 已记录此资源事件，请结合对象状态和原因代码诊断。',
        };
      })
      .sort((a, b) => (b.lastObservedAt ?? '').localeCompare(a.lastObservedAt ?? ''))
      .slice(0, maxEvents);
    return {
      items,
      state: 'available' as const,
      truncated: result.truncated || matching.length > maxEvents,
    };
  } catch (error) {
    if (safeWorkloadError(error).code === 'KUBERNETES_CANCELLED') throw safeWorkloadError(error);
    return { items: [], state: 'unknown' as const, truncated: false };
  }
}

function aggregate(pods: WorkloadPodObservation[], truncated: boolean): WorkloadMetrics {
  const containers = pods
    .filter((pod) => pod.phase !== 'Succeeded' && pod.phase !== 'Failed')
    .flatMap((pod) => pod.containers);
  if (
    truncated ||
    !containers.length ||
    containers.some((container) => container.metrics.state !== 'available')
  )
    return unknownMetrics();
  const metrics = containers.map((container) => container.metrics);
  return {
    state: 'available',
    cpuCores: metrics.reduce((sum, value) => sum + value.cpuCores!, 0),
    memoryBytes: metrics.reduce((sum, value) => sum + value.memoryBytes!, 0),
    observedAt: metrics.map((value) => value.observedAt!).sort()[0]!,
    windowSeconds: Math.max(...metrics.map((value) => value.windowSeconds!)),
  };
}

/** StatefulSet Pods refer directly to the set; revision templates establish old/current publication identity. */
async function observeStatefulPods(
  client: InspectionClient,
  target: WorkloadTarget,
  set: V1StatefulSet,
  result: WorkloadObservation,
  maxPods: number,
): Promise<Set<string>> {
  const listed = await pages<V1Pod>(
    (cursor, limit) =>
      client.core.listNamespacedPod({
        namespace: target.namespace,
        labelSelector: selectorText(target),
        limit,
        _continue: cursor,
      }),
    maxPods,
  );
  const revisions = new Map<string, V1ControllerRevision | null>();
  const ownedUids = new Set<string>([set.metadata!.uid!]);
  const expectedTemplate = controllerTemplateFingerprint(set.spec?.template);
  for (const pod of listed.items) {
    const owners =
      pod.metadata?.ownerReferences?.filter((reference) => reference.controller === true) ?? [];
    const owner = owners[0];
    const revisionName = text(pod.metadata?.labels?.['controller-revision-hash'], 253);
    const validOwner =
      owners.length === 1 &&
      owner?.apiVersion === 'apps/v1' &&
      owner.kind === 'StatefulSet' &&
      owner.name === set.metadata!.name &&
      owner.uid === set.metadata!.uid &&
      pod.metadata?.namespace === target.namespace &&
      Boolean(pod.metadata?.name?.startsWith(`${set.metadata!.name}-`)) &&
      pod.metadata?.labels?.['statefulset.kubernetes.io/pod-name'] === pod.metadata.name;
    let template: V1PodTemplateSpec | undefined;
    if (validOwner && revisionName) {
      if (!revisions.has(revisionName)) {
        try {
          const revision = await client.apps.readNamespacedControllerRevision({
            namespace: target.namespace,
            name: revisionName,
          });
          revisions.set(revisionName, revision);
        } catch (error) {
          if (error instanceof KubernetesAdapterError && error.httpStatus === 404)
            revisions.set(revisionName, null);
          else throw error;
        }
      }
      const revision = revisions.get(revisionName);
      const revisionOwners =
        revision?.metadata?.ownerReferences?.filter((reference) => reference.controller === true) ??
        [];
      const revisionOwner = revisionOwners[0];
      if (
        revision?.kind === 'ControllerRevision' &&
        revision.apiVersion === 'apps/v1' &&
        revision.metadata?.name === revisionName &&
        revision.metadata.namespace === target.namespace &&
        text(revision.metadata.uid, 128) &&
        revisionOwners.length === 1 &&
        revisionOwner?.apiVersion === 'apps/v1' &&
        revisionOwner.kind === 'StatefulSet' &&
        revisionOwner.uid === set.metadata!.uid &&
        revisionOwner.name === set.metadata!.name &&
        Object.entries(selector(target)).every(
          ([key, value]) => revision.metadata?.labels?.[key] === value,
        )
      ) {
        const raw = record(record(revision.data).spec).template;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const data = structuredClone(raw) as V1PodTemplateSpec & { $patch?: unknown };
          delete data.$patch;
          template = data;
          ownedUids.add(revision.metadata.uid!);
        }
      }
    }
    if (!validOwner || !template?.spec || !Array.isArray(template.spec.containers)) {
      if (
        pod.metadata?.namespace === target.namespace &&
        (await listedPodIsStale(client, target, pod))
      ) {
        result.podsTruncated = true;
        continue;
      }
      result.drift.push({
        kind: 'Pod',
        name: requireText(pod.metadata?.name, 253),
        reason: 'unowned_pod_matches_service_selector',
      });
      continue;
    }
    const revisionController: V1StatefulSet = { ...set, spec: { ...set.spec!, template } };
    if (!declaredImagesMatchController(pod, revisionController))
      result.drift.push({
        kind: 'Pod',
        name: requireText(pod.metadata?.name, 253),
        reason: 'pod_images_differ_from_controller',
      });
    const observed = podSnapshot(
      pod,
      revisionController,
      expectedTemplate !== null &&
        controllerTemplateFingerprint(template) === expectedTemplate &&
        revisionName === set.status?.updateRevision,
    );
    if (!observed.snapshotId)
      result.drift.push({
        kind: 'Pod',
        name: observed.name,
        reason: 'pod_snapshot_differs_from_controller',
      });
    result.pods.push(observed);
    ownedUids.add(observed.uid);
  }
  result.podsTruncated ||= listed.truncated;
  return ownedUids;
}

export async function observeWorkload(
  client: InspectionClient,
  target: WorkloadTarget,
  inventory: readonly ManagedWorkloadResource[],
  limits: { maxPods: number; maxEvents: number },
  now: Date,
  knownInventory: readonly ManagedWorkloadResource[] = inventory,
): Promise<WorkloadObservation> {
  const names = workloadNames(target);
  const required = new Set(inventory.map(resourceKey));
  const ledger = new Map(
    [...knownInventory, ...inventory].map((resource) => [resourceKey(resource), resource]),
  );
  const allInventory = [...ledger.values()];
  const result: WorkloadObservation = {
    observedAt: now.toISOString(),
    configurationState: 'consistent',
    drift: [],
    resources: [],
    deployment: null,
    controller: null,
    pods: [],
    podsTruncated: false,
    events: [],
    eventsState: 'unknown',
    eventsTruncated: false,
    metrics: unknownMetrics(),
    metricsErrorCode: null,
    serviceDns: null,
  };
  const resources = new Map<string, Resource>();
  const missingSecrets = new Set<string>();
  let secretItems: V1Secret[] = [];
  let secretsAvailable = false;
  for (const resource of allInventory.filter((value) => value.kind !== 'Secret')) {
    const value = await readResource(client, resource);
    if (value) resources.set(resourceKey(resource), value);
  }
  const namespace = resources.get(
    resourceKey({ kind: 'Namespace', name: target.namespace, namespace: null }),
  );
  if (namespace) {
    try {
      const metadata = await secretMetadata(client, target);
      secretItems = metadata.items;
      secretsAvailable = !metadata.truncated;
      for (const secret of secretItems) {
        const name = requireText(secret.metadata?.name, 253);
        if (secret.metadata?.namespace !== target.namespace)
          throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
        resources.set(resourceKey({ kind: 'Secret', name, namespace: target.namespace }), {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: secret.metadata,
        });
      }
    } catch (error) {
      if (safeWorkloadError(error).code === 'KUBERNETES_CANCELLED') throw safeWorkloadError(error);
    }
  } else secretsAvailable = true;
  // Absence from a label-filtered list is not a 404: labels may have drifted.
  // Confirm every missing ledger Secret with its named GET before reporting it missing.
  for (const resource of allInventory.filter(
    (value) => value.kind === 'Secret' && (value.uid || value.creationAttempted),
  )) {
    if (resources.has(resourceKey(resource))) continue;
    try {
      const actual = await readResource(client, resource);
      if (actual) resources.set(resourceKey(resource), actual);
      else missingSecrets.add(resourceKey(resource));
    } catch (error) {
      if (safeWorkloadError(error).code === 'KUBERNETES_CANCELLED') throw safeWorkloadError(error);
      secretsAvailable = false;
    }
  }
  for (const resource of allInventory.filter(
    (value) =>
      value.uid ||
      value.creationAttempted ||
      resources.has(resourceKey(value)) ||
      value.kind === 'Namespace' ||
      value.kind === 'Deployment' ||
      value.kind === 'StatefulSet',
  )) {
    const key = resourceKey(resource);
    const actual = resources.get(key);
    // Historical Secrets are still checked for replacement and ownership drift.
    // Only a named GET's confirmed 404 can exempt a no-longer-required Secret.
    if (!required.has(key) && missingSecrets.has(key)) continue;
    const item: WorkloadObservation['resources'][number] = {
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      expectedUid: resource.uid,
      observedUid: actual?.metadata?.uid ?? null,
      resourceVersion: actual?.metadata?.resourceVersion ?? null,
      state: 'verified',
      reason: null,
    };
    if (!actual) {
      item.state = resource.kind === 'Secret' && !secretsAvailable ? 'unknown' : 'missing';
      item.reason =
        item.state === 'missing' ? 'resource_not_found' : 'resource_metadata_unavailable';
    } else {
      try {
        assertOwnership(target, resource, actual);
        const observedRevision = actualRevision(actual);
        if (observedRevision === null || observedRevision !== resource.mutationRevision) {
          item.state = 'drifted';
          item.reason =
            observedRevision !== null && observedRevision < resource.mutationRevision
              ? 'remote_revision_behind'
              : 'remote_revision_ahead';
        } else if (
          resource.kind !== 'Secret' &&
          resource.kind !== 'Namespace' &&
          (!resource.specFingerprint || specFingerprint(actual) !== resource.specFingerprint)
        ) {
          item.state = 'drifted';
          item.reason = 'configuration_changed';
        }
      } catch {
        item.state = 'drifted';
        item.reason = 'ownership_mismatch';
      }
    }
    result.resources.push(item);
    if (item.state !== 'verified')
      result.drift.push({ kind: item.kind, name: item.name, reason: item.reason! });
  }
  for (const secret of secretItems) {
    const name = requireText(secret.metadata?.name, 253);
    if (!ledger.has(resourceKey({ kind: 'Secret', name, namespace: target.namespace }))) {
      result.drift.push({ kind: 'Secret', name, reason: 'untracked_resource' });
      result.resources.push({
        kind: 'Secret',
        name,
        namespace: target.namespace,
        expectedUid: null,
        observedUid: secret.metadata?.uid ?? null,
        resourceVersion: secret.metadata?.resourceVersion ?? null,
        state: 'drifted',
        reason: 'untracked_resource',
      });
    }
  }
  const deploymentResource = resources.get(
    resourceKey({ kind: 'Deployment', name: names.deployment, namespace: target.namespace }),
  ) as V1Deployment | undefined;
  const statefulResource = resources.get(
    resourceKey({ kind: 'StatefulSet', name: names.statefulSet, namespace: target.namespace }),
  ) as V1StatefulSet | undefined;
  const service = resources.get(
    resourceKey({ kind: 'Service', name: names.service, namespace: target.namespace }),
  ) as V1Service | undefined;
  if (service?.spec?.type === 'ClusterIP')
    result.serviceDns = `${names.service}.${target.namespace}.svc`;
  const deploymentOwnership = result.resources.find((item) => item.kind === 'Deployment');
  if (deploymentResource && statefulResource)
    result.drift.push({
      kind: 'StatefulSet',
      name: names.statefulSet,
      reason: 'multiple_controllers_match_service',
    });
  if (deploymentResource && deploymentOwnership?.reason !== 'ownership_mismatch') {
    result.deployment = deploymentSnapshot(deploymentResource);
    result.controller = controllerSnapshot(deploymentResource);
    const query = { namespace: target.namespace, labelSelector: selectorText(target) };
    const [replicaSets, podList] = await Promise.all([
      pages<V1ReplicaSet>(
        async (cursor, limit) => {
          const page = await client.apps.listNamespacedReplicaSet({
            ...query,
            limit,
            _continue: cursor,
          });
          if (
            page.kind !== 'ReplicaSetList' ||
            page.apiVersion !== 'apps/v1' ||
            !Array.isArray(page.items)
          )
            throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
          return {
            ...page,
            items: page.items.map((item) => {
              if (
                (item.kind !== undefined && item.kind !== 'ReplicaSet') ||
                (item.apiVersion !== undefined && item.apiVersion !== 'apps/v1')
              )
                throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
              // Typed lists omit per-item TypeMeta on real Kubernetes. Preserve
              // the verified list type before classifying the Pod's controller.
              return { ...item, kind: 'ReplicaSet', apiVersion: 'apps/v1' };
            }),
          };
        },
        Math.min(1000, limits.maxPods * 3),
      ),
      pages<V1Pod>(
        (cursor, limit) => client.core.listNamespacedPod({ ...query, limit, _continue: cursor }),
        limits.maxPods,
      ),
    ]);
    const ownedReplicaSets = new Map(
      replicaSets.items
        .filter((replicaSet) => ownsReplicaSet(target, deploymentResource, replicaSet))
        .map((replicaSet) => [requireText(replicaSet.metadata?.uid, 128), replicaSet]),
    );
    const namedReplicaSets = new Map<string, V1ReplicaSet | null>();
    const deploymentTemplate = controllerTemplateFingerprint(deploymentResource.spec?.template);
    for (const pod of podList.items) {
      const owner = pod.metadata?.ownerReferences?.find(
        (reference) => reference.controller === true && reference.kind === 'ReplicaSet',
      );
      let controller = owner ? ownedReplicaSets.get(owner.uid) : undefined;
      if (
        owner &&
        pod.metadata?.namespace === target.namespace &&
        (!controller || controller.metadata?.name !== owner.name)
      ) {
        // These lists are separate snapshots. A Pod can refer to a controller
        // created after the ReplicaSet list was read; verify its full ancestry.
        // Cache one named read per controller in this bounded Pod list.
        const name = requireText(owner.name, 253);
        if (!namedReplicaSets.has(name))
          namedReplicaSets.set(name, await readReplicaSet(client, target, name));
        const current = namedReplicaSets.get(name);
        controller =
          current &&
          current.metadata?.uid === owner.uid &&
          ownsReplicaSet(target, deploymentResource, current)
            ? current
            : undefined;
        if (controller) ownedReplicaSets.set(owner.uid, controller);
      }
      if (!controller || pod.metadata?.namespace !== target.namespace) {
        if (
          pod.metadata?.namespace === target.namespace &&
          (await listedPodIsStale(client, target, pod))
        ) {
          // The listed object no longer exists, but this read cannot establish
          // the complete live Pod set. A later observation must confirm health.
          result.podsTruncated = true;
          continue;
        }
        result.drift.push({
          kind: 'Pod',
          name: requireText(pod.metadata?.name, 253),
          reason: 'unowned_pod_matches_service_selector',
        });
        continue;
      }
      if (!declaredImagesMatchController(pod, controller))
        result.drift.push({
          kind: 'Pod',
          name: requireText(pod.metadata?.name, 253),
          reason: 'pod_images_differ_from_controller',
        });
      const observedPod = podSnapshot(
        pod,
        controller,
        deploymentTemplate !== null &&
          controllerTemplateFingerprint(controller.spec?.template) === deploymentTemplate,
      );
      if (!observedPod.snapshotId)
        result.drift.push({
          kind: 'Pod',
          name: observedPod.name,
          reason: 'pod_snapshot_differs_from_controller',
        });
      result.pods.push(observedPod);
    }
    result.podsTruncated ||= replicaSets.truncated || podList.truncated;
    const ownedUids = new Set([
      deploymentResource.metadata!.uid!,
      ...ownedReplicaSets.keys(),
      ...result.pods.map((pod) => pod.uid),
    ]);
    const [metricError, observedEvents] = await Promise.all([
      podMetrics(client, target, result.pods, now, limits.maxPods),
      events(client, target, ownedUids, limits.maxEvents),
    ]);
    result.metricsErrorCode = metricError;
    result.metrics = aggregate(result.pods, result.podsTruncated || metricError !== null);
    result.events = observedEvents.items;
    result.eventsState = observedEvents.state;
    result.eventsTruncated = observedEvents.truncated;
  }
  const statefulOwnership = result.resources.find((item) => item.kind === 'StatefulSet');
  if (
    statefulResource &&
    !deploymentResource &&
    statefulOwnership?.reason !== 'ownership_mismatch'
  ) {
    result.controller = controllerSnapshot(statefulResource);
    const ownedUids = await observeStatefulPods(
      client,
      target,
      statefulResource,
      result,
      limits.maxPods,
    );
    const [metricError, observedEvents] = await Promise.all([
      podMetrics(client, target, result.pods, now, limits.maxPods),
      events(client, target, ownedUids, limits.maxEvents),
    ]);
    result.metricsErrorCode = metricError;
    result.metrics = aggregate(result.pods, result.podsTruncated || metricError !== null);
    result.events = observedEvents.items;
    result.eventsState = observedEvents.state;
    result.eventsTruncated = observedEvents.truncated;
  }
  if (
    result.resources.some((item) => item.state === 'drifted') ||
    result.drift.some(
      (item) => item.kind === 'Pod' || item.reason === 'multiple_controllers_match_service',
    )
  )
    result.configurationState = 'drifted';
  else if (result.resources.some((item) => item.state === 'missing'))
    result.configurationState = 'missing';
  else if (!secretsAvailable || result.resources.some((item) => item.state === 'unknown'))
    result.configurationState = 'unknown';
  return result;
}
