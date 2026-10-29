import type { V1Namespace } from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import { KubernetesAdapterError } from '../kubernetes/contracts.js';
import { safeKubernetesError, type InspectionClient } from '../kubernetes/transport.js';
import {
  WorkloadAdapterError,
  type ManagedWorkloadResource,
  type WorkloadResourceReceipt,
  type WorkloadTarget,
  type WorkloadWriteHooks,
} from './contracts.js';
import { invokeHook } from './hooks.js';
import { keys, ownershipLabels } from './names.js';

export type EnvironmentNamespaceTarget = Omit<WorkloadTarget, 'serviceId'>;
export function environmentNamespaceName(
  target: Pick<EnvironmentNamespaceTarget, 'environmentId'>,
): string {
  return `ozz-e-${target.environmentId.replaceAll('-', '')}`;
}
export function verifyEnvironmentNamespace(
  target: EnvironmentNamespaceTarget,
  row: ManagedWorkloadResource,
  actual: V1Namespace,
): void {
  const metadata = actual.metadata;
  if (
    actual.apiVersion !== 'v1' ||
    actual.kind !== 'Namespace' ||
    metadata?.name !== target.namespace ||
    !metadata.uid ||
    !metadata.resourceVersion ||
    metadata.annotations?.[keys.nonce] !== row.creationNonce ||
    Object.entries(ownershipLabels(target, true)).some(
      ([key, value]) => metadata.labels?.[key] !== value,
    ) ||
    (row.uid ? metadata.uid !== row.uid : !row.creationAttempted)
  )
    throw new WorkloadAdapterError('WORKLOAD_OWNERSHIP_MISMATCH');
  if (metadata.deletionTimestamp)
    throw new WorkloadAdapterError('WORKLOAD_RESOURCE_CONFLICT', true);
}

/** Shared by Service and standalone Volume creation; the caller supplies the same environment ledger row. */
export async function ensureEnvironmentNamespace(
  client: InspectionClient,
  target: EnvironmentNamespaceTarget,
  source: ManagedWorkloadResource,
  hooks: WorkloadWriteHooks,
  signal: AbortSignal,
  now: () => Date,
): Promise<{ resource: V1Namespace; receipt: WorkloadResourceReceipt }> {
  if (
    target.namespace !== environmentNamespaceName(target) ||
    source.kind !== 'Namespace' ||
    source.name !== target.namespace ||
    source.namespace !== null ||
    source.mutationRevision !== 0
  )
    throw new WorkloadAdapterError('WORKLOAD_INPUT_INVALID');
  const row = { ...source };
  let attempted = false;
  let receipt: WorkloadResourceReceipt | undefined;
  try {
    let actual: V1Namespace | null;
    try {
      actual = await client.core.readNamespace({ name: row.name });
    } catch (error) {
      if (error instanceof KubernetesAdapterError && error.httpStatus === 404) actual = null;
      else throw error;
    }
    if (!actual) {
      if (row.uid) throw new WorkloadAdapterError('WORKLOAD_RESOURCE_MISSING');
      await invokeHook(
        () =>
          hooks.beforeWrite({
            action: 'create',
            kind: 'Namespace',
            name: row.name,
            namespace: null,
            creationNonce: row.creationNonce,
            expectedUid: null,
            expectedResourceVersion: null,
            mutationRevision: 0,
          }),
        signal,
      );
      attempted = true;
      row.creationAttempted = true;
      actual = await client.core.createNamespace({
        body: {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: row.name,
            labels: ownershipLabels(target, true),
            annotations: { [keys.nonce]: row.creationNonce },
          },
        },
        fieldManager: 'ozz',
        fieldValidation: 'Strict',
      });
    }
    verifyEnvironmentNamespace(target, row, actual);
    receipt = {
      action: attempted ? 'created' : 'verified',
      kind: 'Namespace',
      name: row.name,
      namespace: null,
      creationNonce: row.creationNonce,
      uid: actual.metadata!.uid!,
      resourceVersion: actual.metadata!.resourceVersion!,
      generation: actual.metadata!.generation ?? null,
      mutationRevision: 0,
      specFingerprint: null,
      observedAt: now().toISOString(),
    };
    await invokeHook(() => hooks.onReceipt(receipt!), signal);
    return { resource: actual, receipt };
  } catch (error) {
    const safe = error instanceof WorkloadAdapterError ? error : safeKubernetesError(error);
    throw new WorkloadAdapterError(
      safe.code,
      safe.retryable,
      attempted ? 'may_have_changed' : 'none',
      receipt ? [receipt] : [],
    );
  }
}
