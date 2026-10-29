import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { KubernetesAdapterError } from '../kubernetes/contracts.js';
import { safeKubernetesError, type InspectionClient } from '../kubernetes/transport.js';
import {
  NetworkingAdapterError,
  type DomainTarget,
  type ManagedNetworkResource,
  type NetworkClusterTarget,
  type NetworkResourceDescriptor,
  type NetworkResourceReceipt,
  type NetworkWriteHooks,
} from './contracts.js';

export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  [key: string]: unknown;
}
export interface Resource {
  apiVersion: string;
  kind: string;
  metadata: Metadata;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
}
export type NetworkOwner = NetworkClusterTarget | DomainTarget;

export const keys = {
  installation: 'networking.ozz.dev/installation-id',
  cluster: 'networking.ozz.dev/cluster-id',
  system: 'networking.ozz.dev/kube-system-uid',
  project: 'networking.ozz.dev/project-id',
  environment: 'networking.ozz.dev/environment-id',
  service: 'networking.ozz.dev/service-id',
  domain: 'networking.ozz.dev/domain-id',
  role: 'networking.ozz.dev/role',
  scope: 'networking.ozz.dev/scope',
  nonce: 'networking.ozz.dev/creation-nonce',
  revision: 'networking.ozz.dev/revision',
  hostname: 'networking.ozz.dev/hostname',
  port: 'networking.ozz.dev/port-id',
  portName: 'networking.ozz.dev/port-name',
  serviceName: 'networking.ozz.dev/service-name',
  serviceUid: 'networking.ozz.dev/service-uid',
} as const;

export function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(fields) : [];
}
export function fail(code: string, message: string, retryable = false): never {
  throw new NetworkingAdapterError(code, message, retryable);
}
export function safeError(error: unknown): NetworkingAdapterError {
  if (error instanceof NetworkingAdapterError) return error;
  const safe = error instanceof KubernetesAdapterError ? error : safeKubernetesError(error);
  if (safe.httpStatus === 409)
    return new NetworkingAdapterError(
      'NETWORK_RESOURCE_CONFLICT',
      '网络资源版本已变化，请重新核对。',
      true,
    );
  return new NetworkingAdapterError(safe.code, safe.message, safe.retryable);
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sorted(value)))
    .digest('hex');
}
export function resourceKey(
  value: Pick<NetworkResourceDescriptor, 'kind' | 'namespace' | 'name'>,
): string {
  return `${value.kind}/${value.namespace}/${value.name}`;
}
export function revision(value: Resource): number {
  const text = value.metadata.annotations?.[keys.revision];
  if (!text || !/^(0|[1-9][0-9]{0,14})$/u.test(text))
    fail('NETWORK_RESOURCE_OWNERSHIP_MISMATCH', '网络资源缺少可信的版本记录。');
  return Number(text);
}
export function ownership(owner: NetworkOwner, row: NetworkResourceDescriptor) {
  const labels: Record<string, string> = {
    'app.kubernetes.io/managed-by': 'ozz',
    [keys.installation]: owner.installationId,
    [keys.cluster]: owner.clusterId,
    [keys.scope]: row.scope,
    [keys.role]: row.role,
  };
  const annotations: Record<string, string> = { [keys.system]: owner.kubeSystemUid };
  if (row.scope !== 'cluster') {
    if (!('domainId' in owner)) fail('NETWORK_INPUT_INVALID', '网络资源归属无效。');
    labels[keys.project] = owner.projectId;
    labels[keys.environment] = owner.environmentId;
    if (row.scope === 'domain') {
      labels[keys.service] = owner.serviceId;
      labels[keys.domain] = owner.domainId;
      annotations[keys.hostname] = owner.hostname;
      annotations[keys.port] = owner.portId;
      annotations[keys.portName] = owner.portName;
      annotations[keys.serviceName] = owner.serviceName;
    }
  }
  return { labels, annotations };
}
export function withOwnership(
  resource: Resource,
  owner: NetworkOwner,
  row: ManagedNetworkResource,
  desiredRevision: number,
): Resource {
  const value = structuredClone(resource);
  const owned = ownership(owner, row);
  value.metadata.labels = { ...value.metadata.labels, ...owned.labels };
  value.metadata.annotations = {
    ...value.metadata.annotations,
    ...owned.annotations,
    [keys.nonce]: row.creationNonce,
    [keys.revision]: String(desiredRevision),
  };
  return value;
}
export function assertOwnership(
  owner: NetworkOwner,
  row: ManagedNetworkResource,
  actual: Resource,
  maximum: number,
): void {
  const expected = ownership(owner, row);
  if (
    actual.kind !== row.kind ||
    actual.apiVersion !== row.apiVersion ||
    actual.metadata.name !== row.name ||
    (actual.metadata.namespace ?? '') !== row.namespace ||
    !actual.metadata.uid ||
    !actual.metadata.resourceVersion ||
    actual.metadata.annotations?.[keys.nonce] !== row.creationNonce ||
    Object.entries(expected.labels).some(
      ([key, value]) => actual.metadata.labels?.[key] !== value,
    ) ||
    Object.entries(expected.annotations).some(
      ([key, value]) => actual.metadata.annotations?.[key] !== value,
    ) ||
    (row.uid ? actual.metadata.uid !== row.uid : !row.creationAttempted)
  )
    fail(
      'NETWORK_RESOURCE_OWNERSHIP_MISMATCH',
      '同名网络资源的原登记、UID 或创建标记不一致，已停止操作。',
    );
  if (revision(actual) > maximum || revision(actual) < row.revision)
    fail('NETWORK_RESOURCE_REVISION_MISMATCH', '网络资源版本与当前任务不一致，已停止操作。');
}

const paths: Record<string, { api: string; plural: string; namespaced: boolean }> = {
  Namespace: { api: 'v1', plural: 'namespaces', namespaced: false },
  Secret: { api: 'v1', plural: 'secrets', namespaced: true },
  Service: { api: 'v1', plural: 'services', namespaced: true },
  ServiceAccount: { api: 'v1', plural: 'serviceaccounts', namespaced: true },
  Deployment: { api: 'apps/v1', plural: 'deployments', namespaced: true },
  Ingress: { api: 'networking.k8s.io/v1', plural: 'ingresses', namespaced: true },
  IngressClass: { api: 'networking.k8s.io/v1', plural: 'ingressclasses', namespaced: false },
  Middleware: { api: 'traefik.io/v1alpha1', plural: 'middlewares', namespaced: true },
  Certificate: { api: 'cert-manager.io/v1', plural: 'certificates', namespaced: true },
  Issuer: { api: 'cert-manager.io/v1', plural: 'issuers', namespaced: true },
  CustomResourceDefinition: {
    api: 'apiextensions.k8s.io/v1',
    plural: 'customresourcedefinitions',
    namespaced: false,
  },
  ClusterRole: { api: 'rbac.authorization.k8s.io/v1', plural: 'clusterroles', namespaced: false },
  ClusterRoleBinding: {
    api: 'rbac.authorization.k8s.io/v1',
    plural: 'clusterrolebindings',
    namespaced: false,
  },
  Role: { api: 'rbac.authorization.k8s.io/v1', plural: 'roles', namespaced: true },
  RoleBinding: { api: 'rbac.authorization.k8s.io/v1', plural: 'rolebindings', namespaced: true },
  MutatingWebhookConfiguration: {
    api: 'admissionregistration.k8s.io/v1',
    plural: 'mutatingwebhookconfigurations',
    namespaced: false,
  },
  ValidatingWebhookConfiguration: {
    api: 'admissionregistration.k8s.io/v1',
    plural: 'validatingwebhookconfigurations',
    namespaced: false,
  },
};
export function resourcePath(
  row: Pick<NetworkResourceDescriptor, 'apiVersion' | 'kind' | 'namespace' | 'name'>,
  collection = false,
): string {
  const type = paths[row.kind];
  if (
    !type ||
    type.api !== row.apiVersion ||
    !/^[a-z0-9](?:[a-z0-9.:-]{0,251}[a-z0-9])?$/u.test(row.name) ||
    (type.namespaced
      ? !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(row.namespace)
      : row.namespace !== '')
  )
    fail('NETWORK_INPUT_INVALID', '不支持的网络资源身份。');
  return `${type.api === 'v1' ? '/api/v1' : `/apis/${type.api}`}${type.namespaced ? `/namespaces/${row.namespace}` : ''}/${type.plural}${collection ? '' : `/${row.name}`}`;
}
export function descriptor(
  resource: Resource,
  role: string,
  scope: NetworkResourceDescriptor['scope'],
): NetworkResourceDescriptor {
  const row = {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    namespace: resource.metadata.namespace ?? '',
    name: resource.metadata.name,
    role,
    scope,
  };
  resourcePath(row);
  return row;
}
export function asResource(
  value: unknown,
  row: Pick<NetworkResourceDescriptor, 'apiVersion' | 'kind' | 'namespace' | 'name'>,
): Resource {
  const object = fields(value);
  const metadata = fields(object.metadata);
  if (
    object.kind !== row.kind ||
    object.apiVersion !== row.apiVersion ||
    metadata.name !== row.name ||
    (metadata.namespace ?? '') !== row.namespace ||
    typeof metadata.uid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(metadata.uid) ||
    typeof metadata.resourceVersion !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(metadata.resourceVersion)
  )
    fail('KUBERNETES_INVALID_RESPONSE', 'Kubernetes 返回的网络资源身份无法验证。');
  return object as unknown as Resource;
}
export async function readResource(
  client: InspectionClient,
  row: Pick<NetworkResourceDescriptor, 'apiVersion' | 'kind' | 'namespace' | 'name'>,
): Promise<Resource | null> {
  try {
    return asResource(await client.request('GET', resourcePath(row)), row);
  } catch (error) {
    if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return null;
    throw safeError(error);
  }
}

/** A controller-created Secret needs a trusted parent delegation in addition to a copied label. */
export async function verifyTlsParent(
  client: InspectionClient,
  owner: NetworkOwner,
  inventory: Iterable<ManagedNetworkResource>,
  row: ManagedNetworkResource,
  actual: Resource,
  maximum: number,
): Promise<void> {
  if (row.role !== 'tls' || row.uid) return;
  if (!('domainId' in owner))
    fail('NETWORK_RESOURCE_OWNERSHIP_MISMATCH', 'TLS Secret 没有可验证的域名归属。');
  const parentRow = [...inventory].find(
    (resource) =>
      resource.kind === 'Certificate' &&
      resource.role === 'certificate' &&
      resource.scope === 'domain' &&
      resource.namespace === row.namespace,
  );
  const parent = parentRow ? await readResource(client, parentRow) : null;
  if (!parentRow || !parent)
    fail('NETWORK_TLS_PARENT_UNVERIFIED', 'TLS Secret 缺少已登记的 Certificate 父资源。');
  assertOwnership(owner, parentRow, parent, maximum);
  const template = fields(parent.spec?.secretTemplate);
  const issuer = fields(parent.spec?.issuerRef);
  const annotations = actual.metadata.annotations ?? {};
  const references = entries(actual.metadata.ownerReferences);
  if (
    parent.spec?.secretName !== row.name ||
    !contains(parent.spec?.dnsNames, [owner.hostname]) ||
    fields(template.annotations)[keys.nonce] !== row.creationNonce ||
    !contains(actual.metadata.labels, template.labels) ||
    !contains(annotations, template.annotations) ||
    annotations['cert-manager.io/certificate-name'] !== parent.metadata.name ||
    annotations['cert-manager.io/issuer-name'] !== issuer.name ||
    annotations['cert-manager.io/issuer-kind'] !== 'Issuer' ||
    annotations['cert-manager.io/issuer-group'] !== 'cert-manager.io' ||
    references.some(
      (reference) =>
        reference.kind !== 'Certificate' ||
        reference.apiVersion !== 'cert-manager.io/v1' ||
        reference.name !== parent.metadata.name ||
        reference.uid !== parent.metadata.uid,
    )
  )
    fail(
      'NETWORK_TLS_PARENT_UNVERIFIED',
      'TLS Secret 的 Certificate UID、模板或 cert-manager 子资源记录不匹配。',
    );
}

/** Only persisted configuration is fingerprinted; TLS material and controller status rotate independently. */
export function specFingerprint(resource: Resource, row: NetworkResourceDescriptor): string {
  const body = structuredClone(resource);
  Reflect.deleteProperty(body, 'metadata');
  delete body.status;
  if (row.kind === 'Secret' && row.role === 'tls') delete body.data;
  if (row.kind === 'Secret') delete body.stringData;
  body.networkAnnotations = Object.fromEntries(
    Object.entries(resource.metadata.annotations ?? {}).filter(
      ([key]) => key.startsWith('traefik.ingress.kubernetes.io/') || key === keys.serviceUid,
    ),
  );
  // Kubernetes allocates these, and cert-manager's CA injector renews bundles.
  if (row.kind === 'Service') {
    for (const key of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy'])
      delete body.spec?.[key];
  }
  for (const hook of entries(body.webhooks)) delete fields(hook.clientConfig).caBundle;
  if (row.kind === 'CustomResourceDefinition')
    delete fields(fields(body.spec?.conversion).webhook).clientConfig;
  return fingerprint(body);
}
/** K8s defaults may add fields, but every requested field must still match. */
export function contains(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(desired))
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((value, i) => contains(actual[i], value))
    );
  if (desired && typeof desired === 'object') {
    const object = fields(actual);
    return Object.entries(desired).every(
      ([key, value]) => value === undefined || contains(object[key], value),
    );
  }
  return actual === desired;
}

export class ResourceWriter {
  readonly inventory = new Map<string, ManagedNetworkResource>();
  readonly receipts: NetworkResourceReceipt[] = [];
  constructor(
    readonly client: InspectionClient,
    readonly owner: NetworkOwner,
    inventory: readonly ManagedNetworkResource[],
    readonly revisions: { domain: number; environment: number; cluster: number },
    readonly hooks: NetworkWriteHooks,
    readonly signal: AbortSignal,
    readonly now: () => Date,
    readonly reconcileMissing = false,
  ) {
    for (const row of inventory) this.inventory.set(resourceKey(row), { ...row });
  }
  async hook<T>(work: () => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(10_000);
    const signal = AbortSignal.any([this.signal, timeout]);
    if (signal.aborted) fail('KUBERNETES_CANCELLED', '网络操作已取消。');
    let listener: () => void = () => {};
    try {
      const result = await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => {
          listener = () =>
            reject(
              new NetworkingAdapterError(
                this.signal.aborted ? 'KUBERNETES_CANCELLED' : 'NETWORK_CALLBACK_FAILED',
                '网络写入凭据已失效或回执未确认。',
                !this.signal.aborted,
              ),
            );
          signal.addEventListener('abort', listener, { once: true });
        }),
      ]);
      if (signal.aborted) fail('KUBERNETES_CANCELLED', '网络操作已取消。');
      return result;
    } catch (error) {
      if (error instanceof NetworkingAdapterError) throw error;
      fail('NETWORK_CALLBACK_FAILED', '网络写入凭据已失效或回执未确认。', true);
    } finally {
      signal.removeEventListener('abort', listener);
    }
  }
  async checkpoint(): Promise<void> {
    await this.hook(() => this.hooks.checkpoint());
  }
  async reserve(row: NetworkResourceDescriptor): Promise<ManagedNetworkResource> {
    await this.checkpoint();
    const descriptor = {
      apiVersion: row.apiVersion,
      kind: row.kind,
      namespace: row.namespace,
      name: row.name,
      role: row.role,
      scope: row.scope,
    };
    const value = await this.hook(() => this.hooks.reserve(descriptor));
    if (
      Object.entries(descriptor).some(
        ([key, item]) => value[key as keyof ManagedNetworkResource] !== item,
      ) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(value.creationNonce) ||
      !Number.isSafeInteger(value.ledgerVersion) ||
      value.ledgerVersion < 0 ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      value.revision > this.revisions[value.scope]
    )
      fail('NETWORK_RESOURCE_OWNERSHIP_MISMATCH', '网络资源登记返回了不匹配的身份。');
    this.inventory.set(resourceKey(value), { ...value });
    return this.inventory.get(resourceKey(value))!;
  }
  row(row: NetworkResourceDescriptor): ManagedNetworkResource {
    const found = this.inventory.get(resourceKey(row));
    if (!found) fail('NETWORK_RESOURCE_OWNERSHIP_MISMATCH', '网络资源尚未登记。');
    return found;
  }
  async record(
    row: ManagedNetworkResource,
    actual: Resource | null,
    action: NetworkResourceReceipt['action'],
  ): Promise<void> {
    const receipt: NetworkResourceReceipt = {
      apiVersion: row.apiVersion,
      kind: row.kind,
      namespace: row.namespace,
      name: row.name,
      role: row.role,
      scope: row.scope,
      creationNonce: row.creationNonce,
      action,
      uid: actual?.metadata.uid ?? row.uid,
      resourceVersion: actual?.metadata.resourceVersion ?? row.resourceVersion,
      revision: actual ? revision(actual) : Math.max(row.revision, this.revisions[row.scope]),
      specFingerprint: actual ? specFingerprint(actual, row) : row.specFingerprint,
      observedAt: this.now().toISOString(),
    };
    await this.hook(() => this.hooks.onReceipt(receipt));
    this.receipts.push(receipt);
    Object.assign(row, {
      uid: receipt.uid,
      resourceVersion: receipt.resourceVersion,
      revision: receipt.revision,
      specFingerprint: receipt.specFingerprint,
    });
  }
  async inspect(row: ManagedNetworkResource, verifyFingerprint = true): Promise<Resource | null> {
    await this.checkpoint();
    const actual = await readResource(this.client, row);
    if (!actual) return null;
    assertOwnership(this.owner, row, actual, this.revisions[row.scope]);
    await verifyTlsParent(
      this.client,
      this.owner,
      this.inventory.values(),
      row,
      actual,
      this.revisions[row.scope],
    );
    if (actual.metadata.deletionTimestamp)
      fail('NETWORK_RESOURCE_DELETING', '网络资源正在删除，请稍后重试。', true);
    if (
      verifyFingerprint &&
      row.specFingerprint &&
      revision(actual) === row.revision &&
      specFingerprint(actual, row) !== row.specFingerprint
    )
      fail('NETWORK_RESOURCE_DRIFT', '网络资源配置已被更改，请检查集群中的实际配置。');
    return actual;
  }
  async preflight(row: ManagedNetworkResource): Promise<void> {
    const actual = await this.inspect(row);
    if (!actual && row.uid && !this.reconcileMissing)
      fail('NETWORK_RESOURCE_MISSING', '已登记网络资源已消失，请显式重新协调后重试。');
  }
  async recoverMissing(row: ManagedNetworkResource): Promise<ManagedNetworkResource> {
    if (!row.uid) return row;
    if (!this.reconcileMissing)
      fail('NETWORK_RESOURCE_MISSING', '已登记网络资源已消失，请显式重新协调后重试。');
    await this.record(row, null, 'deleted');
    return this.reserve(row);
  }
  async intent(
    row: ManagedNetworkResource,
    action: 'create' | 'replace' | 'delete',
    actual: Resource | null,
  ): Promise<void> {
    await this.checkpoint();
    await this.hook(() =>
      this.hooks.beforeWrite({
        apiVersion: row.apiVersion,
        kind: row.kind,
        namespace: row.namespace,
        name: row.name,
        role: row.role,
        scope: row.scope,
        action,
        creationNonce: row.creationNonce,
        expectedUid: row.uid,
        expectedResourceVersion: actual?.metadata.resourceVersion ?? null,
        revision: this.revisions[row.scope],
      }),
    );
    if (action === 'create') row.creationAttempted = true;
  }
  /** The controller gets permission to create a TLS Secret only after this durable intent. */
  async prepareChild(descriptor: NetworkResourceDescriptor): Promise<ManagedNetworkResource> {
    let row = this.row(descriptor);
    const actual = await this.inspect(row);
    if (actual) {
      await this.record(row, actual, 'verified');
      return row;
    }
    row = await this.recoverMissing(row);
    await this.intent(row, 'create', null);
    return row;
  }
  async ensure(
    descriptor: NetworkResourceDescriptor,
    make: (row: ManagedNetworkResource, actual: Resource | null) => Resource | Promise<Resource>,
  ): Promise<Resource> {
    let row = this.row(descriptor);
    const actual = await this.inspect(row);
    if (!actual) row = await this.recoverMissing(row);
    const desired = withOwnership(
      await make(row, actual),
      this.owner,
      row,
      this.revisions[row.scope],
    );
    if (
      actual &&
      row.scope !== 'cluster' &&
      row.kind !== 'Secret' &&
      revision(actual) === this.revisions[row.scope] &&
      fingerprint(actual.spec ?? {}) !== fingerprint(desired.spec ?? {})
    )
      fail('NETWORK_RESOURCE_DRIFT', '当前版本的网络资源完整配置不匹配，已停止覆盖。');
    if (actual && contains(actual, desired)) {
      await this.record(row, actual, 'verified');
      return actual;
    }
    if (actual && revision(actual) === this.revisions[row.scope])
      fail('NETWORK_RESOURCE_DRIFT', '当前版本的网络资源配置不匹配，已停止覆盖。');
    if (actual && !row.uid) await this.record(row, actual, 'verified');
    if (actual) {
      // Preserve server allocations and opaque credentials when replacing owned metadata.
      desired.metadata = {
        ...actual.metadata,
        ...desired.metadata,
        uid: actual.metadata.uid,
        resourceVersion: actual.metadata.resourceVersion,
      };
      if (desired.kind === 'Service') {
        for (const field of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy'])
          if (actual.spec?.[field] !== undefined) desired.spec![field] = actual.spec[field];
      }
      for (const [i, hook] of entries(desired.webhooks).entries()) {
        const ca = fields(entries(actual.webhooks)[i]?.clientConfig).caBundle;
        if (ca !== undefined) fields(hook.clientConfig).caBundle = ca;
      }
    }
    await this.intent(row, actual ? 'replace' : 'create', actual);
    const response = asResource(
      await this.client.request(actual ? 'PUT' : 'POST', resourcePath(row, !actual), desired),
      row,
    );
    assertOwnership(this.owner, row, response, this.revisions[row.scope]);
    await this.record(row, response, actual ? 'replaced' : 'created');
    return response;
  }
  async remove(row: ManagedNetworkResource, pollIntervalMs: number): Promise<void> {
    await this.checkpoint();
    let actual = await readResource(this.client, row);
    if (actual) {
      assertOwnership(this.owner, row, actual, this.revisions[row.scope]);
      if (!row.uid) await this.record(row, actual, 'verified');
      await this.intent(row, 'delete', actual);
      try {
        await this.client.request('DELETE', resourcePath(row), {
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: {
            uid: actual.metadata.uid,
            resourceVersion: actual.metadata.resourceVersion,
          },
          propagationPolicy: 'Foreground',
        });
      } catch (error) {
        if (!(error instanceof KubernetesAdapterError && error.httpStatus === 404)) throw error;
      }
      while (actual) {
        await this.checkpoint();
        actual = await readResource(this.client, row);
        if (actual) {
          assertOwnership(this.owner, row, actual, this.revisions[row.scope]);
          await delay(pollIntervalMs, undefined, { signal: this.signal });
        }
      }
    }
    // A named GET proved absence. The prior UID remains in the deletion receipt.
    await this.record(row, null, 'deleted');
  }
}
