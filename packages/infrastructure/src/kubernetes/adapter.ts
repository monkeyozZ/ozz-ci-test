import type { V1Node } from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import { connectionMaterial, verifyCredentialTime } from './config.js';
import { readCapabilities } from './capabilities.js';
import { readWorkloads } from './workloads.js';
import { hasControlCharacters } from './text.js';
import {
  KubernetesAdapterError,
  type KubernetesAdapterOptions,
  type KubernetesConditionState,
  type KubernetesConnectionInspector,
  type KubernetesInspection,
  type KubernetesInspectOptions,
  type KubernetesNodeMetrics,
  type KubernetesNodeSnapshot,
  type KubernetesPermissionCheck,
  type KubernetesResourceValues,
  type ParsedKubernetesConnection,
} from './contracts.js';
import {
  createInspectionClient,
  safeKubernetesError,
  transportLimits,
  type InspectionClient,
  type TransportLimits,
} from './transport.js';

function invalidResponse(): never {
  throw new KubernetesAdapterError('KUBERNETES_INVALID_RESPONSE');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

function safeText(value: unknown, max = 256): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !hasControlCharacters(value)
    ? value
    : null;
}

function requiredText(value: unknown, max = 256): string {
  const result = safeText(value, max);
  if (!result) invalidResponse();
  return result;
}

function date(value: unknown): string | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

/** Kubernetes Quantity conversion. Invalid/missing/unsafe values are unknown, never zero. */
function quantity(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = /^(\d+(?:\.\d+)?|\.\d+)([eE][+-]?\d+|[numkMGTPE]|[KMGTPE]i)?$/u.exec(value);
  if (!parts) return null;
  const units: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const suffix = parts[2];
  const factor = !suffix
    ? 1
    : /^[eE][+-]?\d+$/u.test(suffix)
      ? 10 ** Number(suffix.slice(1))
      : units[suffix];
  if (factor === undefined) return null;
  const result = Number(parts[1]) * factor;
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER
    ? result
    : null;
}

function resources(values: Record<string, string> | undefined): KubernetesResourceValues {
  return {
    cpuCores: quantity(values?.cpu),
    memoryBytes: quantity(values?.memory),
    ephemeralStorageBytes: quantity(values?.['ephemeral-storage']),
    pods: quantity(values?.pods),
  };
}

function windowSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gu)];
  if (!parts.length || parts.map((part) => part[0]).join('') !== value) return null;
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
  };
  const total = parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2]!]!, 0);
  return Number.isFinite(total) && total > 0 && total <= 86400 ? total : null;
}

function unknownMetrics(): KubernetesNodeMetrics {
  return {
    state: 'unknown',
    cpuCores: null,
    memoryBytes: null,
    observedAt: null,
    windowSeconds: null,
  };
}

function nodeSnapshot(node: V1Node): KubernetesNodeSnapshot {
  if (!node || typeof node !== 'object') invalidResponse();
  const uid = requiredText(node.metadata?.uid, 128);
  const name = requiredText(node.metadata?.name, 253);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(name)) invalidResponse();
  const condition = (type: string): KubernetesConditionState => {
    const values = node.status?.conditions;
    if (!Array.isArray(values)) return 'unknown';
    const found = values.find((value) => value.type === type)?.status;
    return found === 'True' ? 'true' : found === 'False' ? 'false' : 'unknown';
  };
  const addresses: KubernetesNodeSnapshot['addresses'] = [];
  if (Array.isArray(node.status?.addresses)) {
    for (const item of node.status.addresses.slice(0, 16)) {
      if (item.type !== 'InternalIP' && item.type !== 'ExternalIP' && item.type !== 'Hostname')
        continue;
      const address = safeText(item.address, 253);
      if (address) addresses.push({ type: item.type, address });
    }
  }
  const info = node.status?.nodeInfo;
  return {
    uid,
    name,
    resourceVersion: safeText(node.metadata?.resourceVersion, 128),
    createdAt: date(node.metadata?.creationTimestamp),
    architecture: safeText(info?.architecture, 32),
    operatingSystem: safeText(info?.operatingSystem, 32),
    osImage: safeText(info?.osImage),
    kubeletVersion: safeText(info?.kubeletVersion, 128),
    containerRuntimeVersion: safeText(info?.containerRuntimeVersion, 128),
    machineId: safeText(info?.machineID, 128),
    systemUuid: safeText(info?.systemUUID, 128),
    roles: Object.keys(node.metadata?.labels ?? {})
      .filter((key) => key.startsWith('node-role.kubernetes.io/'))
      .map((key) => key.slice('node-role.kubernetes.io/'.length))
      .filter((role) => /^[a-z0-9-]{1,63}$/u.test(role))
      .slice(0, 16),
    addresses,
    unschedulable: node.spec?.unschedulable === true,
    conditions: {
      ready: condition('Ready'),
      diskPressure: condition('DiskPressure'),
      memoryPressure: condition('MemoryPressure'),
      pidPressure: condition('PIDPressure'),
      networkUnavailable: condition('NetworkUnavailable'),
    },
    capacity: resources(node.status?.capacity),
    allocatable: resources(node.status?.allocatable),
    metrics: unknownMetrics(),
  };
}

async function readNodes(client: InspectionClient, limits: TransportLimits) {
  const nodes: KubernetesNodeSnapshot[] = [];
  const uids = new Set<string>();
  const names = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let resourceVersion: string | null = null;
  for (let page = 0; page < 32; page += 1) {
    const result = await client.core.listNode({
      limit: Math.min(100, limits.maxNodes),
      _continue: cursor,
    });
    if (!Array.isArray(result.items)) invalidResponse();
    if (nodes.length + result.items.length > limits.maxNodes)
      throw new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
    const pageVersion = safeText(result.metadata?.resourceVersion, 128);
    if (page > 0 && pageVersion !== resourceVersion) invalidResponse();
    resourceVersion = pageVersion;
    for (const item of result.items) {
      const node = nodeSnapshot(item);
      if (uids.has(node.uid) || names.has(node.name)) invalidResponse();
      uids.add(node.uid);
      names.add(node.name);
      nodes.push(node);
    }
    const next = result.metadata?._continue;
    if (next === undefined || next === '') return { nodes, resourceVersion };
    cursor = requiredText(next, 16 * 1024);
    if (seenCursors.has(cursor)) invalidResponse();
    seenCursors.add(cursor);
  }
  throw new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
}

interface NodeMetricRecord {
  name: string;
  uid: string | null;
  metrics: KubernetesNodeMetrics;
}

async function readMetrics(client: InspectionClient, limits: TransportLimits, now: Date) {
  try {
    const records: NodeMetricRecord[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 32; page += 1) {
      const raw: unknown = await client.custom.listClusterCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        plural: 'nodes',
        limit: Math.min(100, limits.maxNodes),
        _continue: cursor,
      });
      const result = object(raw);
      if (!Array.isArray(result.items)) invalidResponse();
      if (records.length + result.items.length > limits.maxNodes)
        throw new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
      for (const rawMetric of result.items) {
        const metric = object(rawMetric);
        const metadata = object(metric.metadata);
        const name = requiredText(metadata.name, 253);
        if (names.has(name)) invalidResponse();
        names.add(name);
        const usage = object(metric.usage);
        const timestamp = date(metric.timestamp);
        const cpuCores = quantity(usage.cpu);
        const memoryBytes = quantity(usage.memory);
        const window = windowSeconds(metric.window);
        const age = timestamp ? now.getTime() - Date.parse(timestamp) : Infinity;
        const available =
          cpuCores !== null &&
          memoryBytes !== null &&
          window !== null &&
          age >= -60_000 &&
          age <= 5 * 60_000;
        records.push({
          name,
          uid: safeText(metadata.uid, 128),
          metrics: {
            state: available ? 'available' : 'unknown',
            cpuCores: available ? cpuCores : null,
            memoryBytes: available ? memoryBytes : null,
            observedAt: timestamp,
            windowSeconds: window,
          },
        });
      }
      const metadata = result.metadata === undefined ? {} : object(result.metadata);
      if (metadata.continue === undefined || metadata.continue === '') {
        const timestamps = records
          .map((item) => item.metrics.observedAt)
          .filter((value): value is string => value !== null)
          .sort();
        return {
          records,
          capability: {
            state: 'available' as const,
            errorCode: null,
            observedAt: timestamps[0] ?? null,
          },
        };
      }
      cursor = requiredText(metadata.continue, 16 * 1024);
      if (cursors.has(cursor)) invalidResponse();
      cursors.add(cursor);
    }
    throw new KubernetesAdapterError('KUBERNETES_RESPONSE_TOO_LARGE');
  } catch (error) {
    const safe = safeKubernetesError(error);
    if (safe.code === 'KUBERNETES_CANCELLED') throw safe;
    return {
      records: [],
      capability: {
        state:
          safe.code === 'KUBERNETES_FORBIDDEN'
            ? ('forbidden' as const)
            : safe.code === 'KUBERNETES_API_NOT_FOUND'
              ? ('unavailable' as const)
              : ('unknown' as const),
        errorCode: safe.code,
        observedAt: null,
      },
    };
  }
}

async function readPermissions(client: InspectionClient): Promise<KubernetesPermissionCheck[]> {
  const specs = [
    { apiGroup: '*', resource: '*', verb: '*' },
    { apiGroup: '', resource: 'namespaces', verb: 'create' },
    { apiGroup: 'apps', resource: 'deployments', verb: 'create' },
    { apiGroup: '', resource: 'secrets', verb: 'create' },
  ];
  return Promise.all(
    specs.map(async (spec): Promise<KubernetesPermissionCheck> => {
      const base = { ...spec, resourceName: null, namespace: null };
      try {
        const review = await client.authorization.createSelfSubjectAccessReview({
          body: {
            apiVersion: 'authorization.k8s.io/v1',
            kind: 'SelfSubjectAccessReview',
            spec: {
              resourceAttributes: {
                group: spec.apiGroup,
                resource: spec.resource,
                verb: spec.verb,
              },
            },
          },
        });
        const allowed = review.status?.allowed;
        if (typeof allowed !== 'boolean' || (allowed && review.status?.denied === true))
          invalidResponse();
        if (review.status?.evaluationError && !allowed)
          return {
            ...base,
            allowed: null,
            evidence: 'unknown',
            errorCode: 'KUBERNETES_INVALID_RESPONSE',
          };
        return { ...base, allowed, evidence: 'self_subject_access_review', errorCode: null };
      } catch (error) {
        const safe = safeKubernetesError(error);
        if (safe.code === 'KUBERNETES_CANCELLED') throw safe;
        return { ...base, allowed: null, evidence: 'unknown', errorCode: safe.code };
      }
    }),
  );
}

export class KubernetesAdapter implements KubernetesConnectionInspector {
  private readonly limits: TransportLimits;
  private readonly now: () => Date;

  constructor(options: KubernetesAdapterOptions = {}) {
    this.limits = transportLimits(options);
    this.now = options.now ?? (() => new Date());
  }

  async inspect(
    connection: ParsedKubernetesConnection,
    options: KubernetesInspectOptions = {},
  ): Promise<KubernetesInspection> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort('inspection_timeout'),
      this.limits.inspectionTimeoutMs,
    );
    timer.unref();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let client: InspectionClient | undefined;
    try {
      connectionMaterial(connection);
      verifyCredentialTime(connection, this.now());
      if (signal.aborted) throw new KubernetesAdapterError('KUBERNETES_CANCELLED');
      const expected = options.expectedIdentity;
      if (
        expected?.caFingerprint !== undefined &&
        expected.caFingerprint !== connection.caFingerprint
      )
        throw new KubernetesAdapterError('KUBERNETES_CA_MISMATCH');
      client = await createInspectionClient(connection, this.limits, signal);
      const initial = await Promise.allSettled([
        client.version.getCode(),
        client.core.readNamespace({ name: 'kube-system' }),
      ]);
      const versionResult = initial[0]!;
      const namespaceResult = initial[1]!;
      if (versionResult.status === 'rejected') throw versionResult.reason;
      if (namespaceResult.status === 'rejected') throw namespaceResult.reason;
      const version = requiredText(versionResult.value.gitVersion, 128);
      const namespace = namespaceResult.value;
      if (namespace.metadata?.name !== 'kube-system') invalidResponse();
      const kubeSystemUid = requiredText(namespace.metadata.uid, 128);
      if (expected && expected.kubeSystemUid !== kubeSystemUid)
        throw new KubernetesAdapterError('KUBERNETES_CLUSTER_IDENTITY_MISMATCH');

      const results = await Promise.allSettled([
        readNodes(client, this.limits),
        readMetrics(client, this.limits, this.now()),
        readPermissions(client),
        readCapabilities(client),
        readWorkloads(client, this.now),
      ]);
      const nodeResult = results[0]!;
      const metricResult = results[1]!;
      const permissionResult = results[2]!;
      const capabilityResult = results[3]!;
      const workloadResult = results[4]!;
      if (signal.aborted)
        throw new KubernetesAdapterError(
          controller.signal.reason === 'inspection_timeout'
            ? 'KUBERNETES_TIMEOUT'
            : 'KUBERNETES_CANCELLED',
          controller.signal.reason === 'inspection_timeout',
        );
      if (nodeResult.status === 'rejected') throw nodeResult.reason;
      if (metricResult.status === 'rejected') throw metricResult.reason;
      if (permissionResult.status === 'rejected') throw permissionResult.reason;
      if (capabilityResult.status === 'rejected') throw capabilityResult.reason;
      if (workloadResult.status === 'rejected') throw workloadResult.reason;
      const { nodes, resourceVersion } = nodeResult.value;
      // Names are only used inside this one inspection to join Metrics API data;
      // every persisted node is identified by this cluster and its immutable UID.
      const metrics = new Map(metricResult.value.records.map((item) => [item.name, item]));
      for (const node of nodes) {
        const candidate = metrics.get(node.name);
        if (!candidate || (candidate.uid && candidate.uid !== node.uid)) continue;
        if (
          node.createdAt &&
          candidate.metrics.observedAt &&
          Date.parse(candidate.metrics.observedAt) < Date.parse(node.createdAt)
        )
          continue;
        node.metrics = candidate.metrics;
      }
      const checks: KubernetesPermissionCheck[] = [
        {
          apiGroup: '',
          resource: 'namespaces',
          verb: 'get',
          resourceName: 'kube-system',
          namespace: null,
          allowed: true,
          evidence: 'successful_request',
          errorCode: null,
        },
        {
          apiGroup: '',
          resource: 'nodes',
          verb: 'list',
          resourceName: null,
          namespace: null,
          allowed: true,
          evidence: 'successful_request',
          errorCode: null,
        },
        ...permissionResult.value,
      ];
      return {
        endpoint: connection.endpoint,
        version,
        identity: { kubeSystemUid, caFingerprint: connection.caFingerprint },
        credential: connection.credential,
        permissions: {
          clusterWideAdmin: checks.find((check) => check.resource === '*')?.allowed ?? null,
          checks,
        },
        nodes,
        nodesResourceVersion: resourceVersion,
        metrics: metricResult.value.capability,
        capabilities: { ...capabilityResult.value, metrics: metricResult.value.capability },
        workloads: workloadResult.value,
        secretsEncryption: { state: 'unknown', evidence: 'not_available_via_standard_api' },
        observedAt: this.now().toISOString(),
      };
    } catch (error) {
      throw safeKubernetesError(error);
    } finally {
      clearTimeout(timer);
      controller.abort('inspection_finished');
      client?.close();
    }
  }
}
