import type {
  V1Deployment,
  V1Namespace,
  V1Secret,
  V1Service,
  V1StatefulSet,
} from '@kubernetes/client-node' with {
  'resolution-mode': 'import',
};
import { KubernetesAdapterError } from '../kubernetes/contracts.js';
import type { InspectionClient } from '../kubernetes/transport.js';
import { safeKubernetesError } from '../kubernetes/transport.js';
import {
  WorkloadAdapterError,
  type ManagedWorkloadKind,
  type ManagedWorkloadResource,
  type WorkloadResourceReceipt,
  type WorkloadTarget,
  type WorkloadWriteHooks,
  type WorkloadWriteIntent,
} from './contracts.js';
import {
  fingerprint,
  keys,
  ownershipLabels,
  revision,
  specFingerprint,
  type Controller,
  type Resource,
} from './names.js';
import { requireText, resourceKey, record } from './validation.js';
import { invokeHook } from './hooks.js';
import { ensureEnvironmentNamespace } from './namespace.js';

export function safeWorkloadError(error: unknown): WorkloadAdapterError {
  if (error instanceof WorkloadAdapterError) return error;
  const safe = error instanceof KubernetesAdapterError ? error : safeKubernetesError(error);
  if (safe.httpStatus === 409) return new WorkloadAdapterError('WORKLOAD_RESOURCE_CONFLICT', true);
  return new WorkloadAdapterError(safe.code, safe.retryable);
}

export async function readResource(
  client: InspectionClient,
  resource: Pick<ManagedWorkloadResource, 'kind' | 'name' | 'namespace'>,
): Promise<Resource | null> {
  try {
    let value: Resource;
    const namespaced = { name: resource.name, namespace: resource.namespace! };
    if (resource.kind === 'Namespace')
      value = await client.core.readNamespace({ name: resource.name });
    else if (resource.kind === 'Deployment')
      value = await client.apps.readNamespacedDeployment(namespaced);
    else if (resource.kind === 'StatefulSet')
      value = await client.apps.readNamespacedStatefulSet(namespaced);
    else if (resource.kind === 'Service')
      value = await client.core.readNamespacedService(namespaced);
    else value = await client.core.readNamespacedSecret(namespaced);
    if (
      value.kind !== resource.kind ||
      value.apiVersion !==
        (['Deployment', 'StatefulSet'].includes(resource.kind) ? 'apps/v1' : 'v1') ||
      value.metadata?.name !== resource.name ||
      (value.metadata.namespace ?? null) !== resource.namespace
    )
      throw new WorkloadAdapterError('KUBERNETES_INVALID_RESPONSE');
    requireText(value.metadata.uid, 128);
    requireText(value.metadata.resourceVersion, 128);
    return value;
  } catch (error) {
    if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return null;
    throw safeWorkloadError(error);
  }
}

export function assertOwnership(
  target: WorkloadTarget,
  resource: ManagedWorkloadResource,
  actual: Resource,
): void {
  const metadata = actual.metadata;
  if (
    !metadata ||
    metadata.name !== resource.name ||
    (metadata.namespace ?? null) !== resource.namespace ||
    metadata.annotations?.[keys.nonce] !== resource.creationNonce ||
    Object.entries(ownershipLabels(target, resource.kind === 'Namespace')).some(
      ([key, value]) => metadata.labels?.[key] !== value,
    ) ||
    (resource.uid ? metadata.uid !== resource.uid : !resource.creationAttempted)
  )
    throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
}

export function actualRevision(resource: Resource): number | null {
  return resource.kind === 'Namespace'
    ? 0
    : revision(resource.metadata?.annotations?.[keys.mutation]);
}

export function assertNotAhead(resource: Resource, maximum: number): void {
  const value = actualRevision(resource);
  if (value === null) throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
  if (value > maximum) throw new WorkloadAdapterError('WORKLOAD_REVISION_AHEAD');
}

function cleanTemplate<T extends Controller['spec']>(spec: T): T {
  const result = structuredClone(spec);
  if (result?.minReadySeconds === 0) delete result.minReadySeconds;
  if (result?.template.metadata) {
    delete result.template.metadata.creationTimestamp;
    delete result.template.metadata.managedFields;
  }
  const pod = result?.template.spec;
  if (pod && pod.serviceAccount !== undefined && pod.serviceAccount === pod.serviceAccountName)
    delete pod.serviceAccount;
  // These Kubernetes bool fields use omitempty on the wire. An omitted false
  // is still a writable mount; an explicit true must remain a real difference.
  for (const volume of pod?.volumes ?? []) {
    if (volume.persistentVolumeClaim?.readOnly === false)
      delete volume.persistentVolumeClaim.readOnly;
  }
  for (const container of pod?.containers ?? []) {
    for (const mount of container.volumeMounts ?? [])
      if (mount.readOnly === false) delete mount.readOnly;
    for (const probe of [
      container.readinessProbe,
      container.startupProbe,
      container.livenessProbe,
    ]) {
      if (probe?.initialDelaySeconds === 0) delete probe.initialDelaySeconds;
    }
  }
  return result;
}

function withServiceAllocation(desired: V1Service, actual: V1Service): V1Service {
  const result = structuredClone(desired);
  if (!result.spec || !actual.spec) return result;
  for (const key of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy'] as const) {
    const value = actual.spec[key];
    // These fields are allocated by Kubernetes and immutable across a replace.
    if (value !== undefined) Object.assign(result.spec, { [key]: value });
  }
  return result;
}

function normalizeQuantities(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeQuantities);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([key, item]) => [key, normalizeQuantities(item)]);
  const result = Object.fromEntries(entries);
  for (const field of ['requests', 'limits']) {
    const raw = result[field];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const quantities = raw as Record<string, unknown>;
    for (const name of ['cpu', 'memory']) {
      const current = quantities[name];
      if (typeof current !== 'string') continue;
      const parts = /^(\d+(?:\.\d+)?)(m|[KMGTPE]i)?$/u.exec(current);
      if (!parts) continue;
      const suffix = parts[2];
      const factor =
        suffix === 'm' ? 0.001 : suffix ? 1024 ** ('KMGTPE'.indexOf(suffix[0]!) + 1) : 1;
      quantities[name] = Number(parts[1]) * factor;
    }
  }
  return result;
}

export function matchesManifest(actual: Resource, desired: Resource): boolean {
  if (actual.kind !== desired.kind) return false;
  if (actual.kind === 'Namespace') return true;
  if (actual.kind === 'Secret') {
    const existing = actual as V1Secret;
    const next = desired as V1Secret;
    return (
      existing.type === next.type &&
      Boolean(existing.immutable) === Boolean(next.immutable) &&
      fingerprint(existing.data ?? {}) === fingerprint(next.data ?? {}) &&
      Object.entries(next.metadata?.labels ?? {}).every(
        ([key, value]) => existing.metadata?.labels?.[key] === value,
      )
    );
  }
  const spec =
    actual.kind === 'Deployment' || actual.kind === 'StatefulSet'
      ? cleanTemplate((actual as Controller).spec)
      : (actual as V1Service).spec;
  const next =
    desired.kind === 'Deployment' || desired.kind === 'StatefulSet'
      ? cleanTemplate((desired as Controller).spec)
      : withServiceAllocation(desired as V1Service, actual as V1Service).spec;
  return fingerprint(normalizeQuantities(spec)) === fingerprint(normalizeQuantities(next));
}

export { invokeHook } from './hooks.js';

/** PVC names alone cannot carry data identity across a same-name replacement. */
export async function assertControllerClaims(
  client: InspectionClient,
  target: WorkloadTarget,
  controller: Controller,
): Promise<void> {
  const volumes = (controller.spec?.template.spec?.volumes ?? []).filter(
    (volume) => volume.persistentVolumeClaim,
  );
  const encoded = controller.spec?.template.metadata?.annotations?.[keys.claims];
  if (!volumes.length) {
    if (encoded) throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    return;
  }
  let claims: Record<string, unknown>;
  try {
    claims = record(JSON.parse(encoded ?? ''));
  } catch {
    throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
  }
  if (volumes.length > 16 || Object.keys(claims).length !== volumes.length)
    throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
  for (const volume of volumes) {
    const name = volume.persistentVolumeClaim!.claimName;
    const uid = claims[name];
    if (typeof uid !== 'string' || !/^ozz-v-[a-f0-9]{32}$/u.test(name))
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    const claim = await client.core.readNamespacedPersistentVolumeClaim({
      namespace: target.namespace,
      name,
    });
    if (
      claim.kind !== 'PersistentVolumeClaim' ||
      claim.metadata?.uid !== uid ||
      claim.metadata.name !== name ||
      claim.metadata.namespace !== target.namespace ||
      claim.metadata.deletionTimestamp ||
      Object.entries(ownershipLabels(target, true)).some(
        ([key, value]) => claim.metadata?.labels?.[key] !== value,
      )
    )
      throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
  }
}

/** Owns a mutation's receipt collection. All error exits preserve known partial effects. */
export class ResourceWriter {
  readonly receipts: WorkloadResourceReceipt[] = [];
  readonly inventory: Map<string, ManagedWorkloadResource>;
  private touched = false;

  constructor(
    readonly client: InspectionClient,
    readonly target: WorkloadTarget,
    inventory: readonly ManagedWorkloadResource[],
    readonly mutationRevision: number,
    readonly hooks: WorkloadWriteHooks,
    readonly signal: AbortSignal,
    readonly now: () => Date,
  ) {
    this.inventory = new Map(inventory.map((value) => [resourceKey(value), { ...value }]));
  }

  get(kind: ManagedWorkloadKind, name: string): ManagedWorkloadResource {
    const value = this.inventory.get(
      resourceKey({ kind, name, namespace: kind === 'Namespace' ? null : this.target.namespace }),
    );
    if (!value) throw new WorkloadAdapterError('WORKLOAD_INVENTORY_REQUIRED');
    return value;
  }

  error(error: unknown): WorkloadAdapterError {
    const safe = safeWorkloadError(error);
    return new WorkloadAdapterError(
      safe.code,
      safe.retryable,
      this.touched ? 'may_have_changed' : safe.sideEffects,
      [...this.receipts],
      safe.observation,
    );
  }

  async inspect(resource: ManagedWorkloadResource, allowDrift = false): Promise<Resource | null> {
    const actual = await readResource(this.client, resource);
    if (!actual) {
      if (resource.uid) throw new WorkloadAdapterError('WORKLOAD_RESOURCE_MISSING');
      return null;
    }
    assertOwnership(this.target, resource, actual);
    assertNotAhead(actual, resource.kind === 'Namespace' ? 0 : this.mutationRevision);
    if (actual.metadata?.deletionTimestamp)
      throw new WorkloadAdapterError('WORKLOAD_RESOURCE_CONFLICT', true);
    if (
      !allowDrift &&
      resource.uid &&
      resource.kind !== 'Secret' &&
      resource.kind !== 'Namespace' &&
      (!resource.specFingerprint || specFingerprint(actual) !== resource.specFingerprint)
    )
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    return actual;
  }

  private async receipt(
    resource: ManagedWorkloadResource,
    actual: Resource,
    action: WorkloadResourceReceipt['action'],
  ): Promise<WorkloadResourceReceipt> {
    const result: WorkloadResourceReceipt = {
      action,
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      creationNonce: resource.creationNonce,
      uid: requireText(actual.metadata?.uid, 128),
      resourceVersion: actual.metadata?.resourceVersion ?? null,
      generation: actual.metadata?.generation ?? null,
      mutationRevision: actualRevision(actual) ?? 0,
      specFingerprint: specFingerprint(actual),
      observedAt: this.now().toISOString(),
    };
    this.receipts.push(result);
    await invokeHook(() => this.hooks.onReceipt(result), this.signal);
    this.inventory.set(resourceKey(resource), {
      ...resource,
      uid: result.uid,
      creationAttempted: true,
      resourceVersion: result.resourceVersion,
      mutationRevision: result.mutationRevision,
      specFingerprint: result.specFingerprint,
    });
    return result;
  }

  private async before(
    resource: ManagedWorkloadResource,
    action: WorkloadWriteIntent['action'],
    actual: Resource | null,
  ): Promise<void> {
    const intent: WorkloadWriteIntent = {
      action,
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      creationNonce: resource.creationNonce,
      expectedUid: actual?.metadata?.uid ?? null,
      expectedResourceVersion: actual?.metadata?.resourceVersion ?? null,
      mutationRevision: resource.kind === 'Namespace' ? 0 : this.mutationRevision,
    };
    await invokeHook(() => this.hooks.beforeWrite(intent), this.signal);
    if (action === 'create') resource.creationAttempted = true;
    if (this.signal.aborted) throw new WorkloadAdapterError('KUBERNETES_CANCELLED');
    this.touched = true;
  }

  async preflight(desired: Resource, allowRepair = false): Promise<Resource | null> {
    const resource = this.get(desired.kind as ManagedWorkloadKind, desired.metadata!.name!);
    const actual = await this.inspect(resource, true);
    if (!actual || resource.kind === 'Namespace') return actual;
    if (resource.uid && !allowRepair && actualRevision(actual)! < resource.mutationRevision)
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    const alreadyApplied =
      actualRevision(actual) === this.mutationRevision && matchesManifest(actual, desired);
    const recoveringOnDeleteStop =
      actual.kind === 'StatefulSet' &&
      desired.kind === 'StatefulSet' &&
      actualRevision(actual) === this.mutationRevision &&
      (actual as V1StatefulSet).spec?.replicas === 0 &&
      (desired as V1StatefulSet).spec?.updateStrategy?.type === 'OnDelete' &&
      matchesManifest(
        {
          ...actual,
          spec: {
            ...(actual as V1StatefulSet).spec!,
            replicas: (desired as V1StatefulSet).spec!.replicas,
          },
        },
        desired,
      );
    if (
      resource.uid &&
      resource.kind !== 'Secret' &&
      !allowRepair &&
      !alreadyApplied &&
      !recoveringOnDeleteStop &&
      (!resource.specFingerprint || specFingerprint(actual) !== resource.specFingerprint)
    )
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    if (
      resource.kind === 'Secret' &&
      (actual as V1Secret).immutable &&
      !matchesManifest(actual, desired)
    )
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    return actual;
  }

  async ensure(desired: Resource, allowRepair = false): Promise<Resource> {
    let resource = this.get(desired.kind as ManagedWorkloadKind, desired.metadata!.name!);
    if (resource.kind === 'Namespace') {
      const result = await ensureEnvironmentNamespace(
        this.client,
        this.target,
        resource,
        {
          beforeWrite: async (intent) => {
            await this.hooks.beforeWrite(intent);
            this.touched = true;
          },
          onReceipt: async (receipt) => {
            this.receipts.push(receipt);
            await this.hooks.onReceipt(receipt);
            this.inventory.set(resourceKey(resource), {
              ...resource,
              uid: receipt.uid,
              creationAttempted: true,
              resourceVersion: receipt.resourceVersion,
              specFingerprint: receipt.specFingerprint,
            });
          },
        },
        this.signal,
        this.now,
      );
      return result.resource;
    }
    const actual = await this.preflight(desired, allowRepair);
    if (
      actual &&
      (!resource.uid ||
        (matchesManifest(actual, desired) &&
          ((resource.kind === 'Secret' && (actual as V1Secret).immutable) ||
            actualRevision(actual) === this.mutationRevision)))
    ) {
      await this.receipt(resource, actual, 'verified');
      resource = this.get(resource.kind, resource.name);
      if (
        resource.kind === 'Namespace' ||
        (matchesManifest(actual, desired) &&
          ((resource.kind === 'Secret' && (actual as V1Secret).immutable) ||
            actualRevision(actual) === this.mutationRevision))
      )
        return actual;
    }
    let body = structuredClone(desired);
    if (actual) {
      if (body.kind === 'Service')
        body = withServiceAllocation(body as V1Service, actual as V1Service);
      body.metadata = {
        ...body.metadata,
        uid: actual.metadata!.uid,
        resourceVersion: actual.metadata!.resourceVersion,
        labels: { ...actual.metadata?.labels, ...body.metadata?.labels },
        annotations: { ...actual.metadata?.annotations, ...body.metadata?.annotations },
      };
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024)
      throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
    await this.before(resource, actual ? 'replace' : 'create', actual);
    if (body.kind === 'Deployment' || body.kind === 'StatefulSet')
      await assertControllerClaims(this.client, this.target, body as Controller);
    const namespaced = {
      namespace: this.target.namespace,
      fieldManager: 'ozz',
      fieldValidation: 'Strict',
    };
    let result: Resource;
    if (body.kind === 'Namespace') {
      result = await this.client.core.createNamespace({
        body: body as V1Namespace,
        fieldManager: 'ozz',
        fieldValidation: 'Strict',
      });
    } else if (body.kind === 'Deployment') {
      result = actual
        ? await this.client.apps.replaceNamespacedDeployment({
            ...namespaced,
            name: resource.name,
            body: body as V1Deployment,
          })
        : await this.client.apps.createNamespacedDeployment({
            ...namespaced,
            body: body as V1Deployment,
          });
    } else if (body.kind === 'StatefulSet') {
      result = actual
        ? await this.client.apps.replaceNamespacedStatefulSet({
            ...namespaced,
            name: resource.name,
            body: body as V1StatefulSet,
          })
        : await this.client.apps.createNamespacedStatefulSet({
            ...namespaced,
            body: body as V1StatefulSet,
          });
    } else if (body.kind === 'Service') {
      result = actual
        ? await this.client.core.replaceNamespacedService({
            ...namespaced,
            name: resource.name,
            body: body as V1Service,
          })
        : await this.client.core.createNamespacedService({
            ...namespaced,
            body: body as V1Service,
          });
    } else {
      result = actual
        ? await this.client.core.replaceNamespacedSecret({
            ...namespaced,
            name: resource.name,
            body: body as V1Secret,
          })
        : await this.client.core.createNamespacedSecret({ ...namespaced, body: body as V1Secret });
    }
    assertOwnership(this.target, resource, result);
    assertNotAhead(result, this.mutationRevision);
    await this.receipt(resource, result, actual ? 'replaced' : 'created');
    if (!matchesManifest(result, desired))
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    return result;
  }

  /** Only used for a verified controller; the caller preserves its existing spec. */
  async replaceController(body: Controller, current: Controller): Promise<Controller> {
    if (body.kind !== current.kind || !['Deployment', 'StatefulSet'].includes(body.kind ?? ''))
      throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
    const resource = this.get(body.kind as 'Deployment' | 'StatefulSet', body.metadata!.name!);
    assertOwnership(this.target, resource, current);
    assertNotAhead(current, this.mutationRevision);
    body.metadata = {
      ...body.metadata,
      uid: current.metadata!.uid,
      resourceVersion: current.metadata!.resourceVersion,
    };
    delete body.status;
    await this.before(resource, 'replace', current);
    if ((body.spec?.replicas ?? 0) > 0)
      await assertControllerClaims(this.client, this.target, body);
    const request = {
      namespace: this.target.namespace,
      name: resource.name,
      fieldManager: 'ozz',
      fieldValidation: 'Strict',
    };
    const result =
      body.kind === 'StatefulSet'
        ? await this.client.apps.replaceNamespacedStatefulSet({
            ...request,
            body: body as V1StatefulSet,
          })
        : await this.client.apps.replaceNamespacedDeployment({
            ...request,
            body: body as V1Deployment,
          });
    assertOwnership(this.target, resource, result);
    await this.receipt(resource, result, 'replaced');
    if (!matchesManifest(result, body))
      throw new WorkloadAdapterError('WORKLOAD_CONFIGURATION_DRIFT');
    return result;
  }

  async beginDelete(resource: ManagedWorkloadResource): Promise<Resource | null> {
    if (resource.kind === 'Namespace') throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
    const actual = await readResource(this.client, resource);
    if (!actual) return null;
    assertOwnership(this.target, resource, actual);
    assertNotAhead(actual, this.mutationRevision);
    if (!resource.uid) await this.receipt(resource, actual, 'verified');
    if (actual.metadata?.deletionTimestamp) return actual;
    await this.before(resource, 'delete', actual);
    const request = {
      name: resource.name,
      namespace: this.target.namespace,
      body: {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: {
          uid: actual.metadata!.uid!,
          resourceVersion: actual.metadata!.resourceVersion!,
        },
        propagationPolicy: ['Deployment', 'StatefulSet'].includes(resource.kind)
          ? 'Foreground'
          : 'Background',
      },
    };
    if (resource.kind === 'Deployment') await this.client.apps.deleteNamespacedDeployment(request);
    else if (resource.kind === 'StatefulSet')
      await this.client.apps.deleteNamespacedStatefulSet(request);
    else if (resource.kind === 'Service') await this.client.core.deleteNamespacedService(request);
    else await this.client.core.deleteNamespacedSecret(request);
    return actual;
  }

  async deleted(resource: ManagedWorkloadResource, previous: Resource | null): Promise<void> {
    if (!previous && !resource.uid) return;
    const actual = previous ?? {
      kind: resource.kind,
      metadata: {
        uid: resource.uid!,
        resourceVersion: resource.resourceVersion ?? undefined,
        annotations: { [keys.mutation]: String(resource.mutationRevision) },
      },
    };
    await this.receipt(resource, actual, 'deleted');
  }
}
