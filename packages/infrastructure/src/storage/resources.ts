import type { V1PersistentVolumeClaim, V1StorageClass } from '@kubernetes/client-node' with {
  'resolution-mode': 'import',
};
import { KubernetesAdapterError } from '../kubernetes/contracts.js';
import { safeKubernetesError, type InspectionClient } from '../kubernetes/transport.js';
import { WorkloadAdapterError } from '../workload/contracts.js';
import { invokeHook } from '../workload/hooks.js';
import { fingerprint, keys, ownershipLabels, revision } from '../workload/names.js';
import { environmentNamespaceName } from '../workload/namespace.js';
import { boundedInteger, text, uuid } from '../workload/validation.js';
import {
  StorageAdapterError,
  type StorageClusterTarget,
  type StorageVolumePlan,
  type StorageWriteHooks,
  type StorageClassObservation,
  type StorageBindingIdentity,
  type StorageResourceReceipt,
} from './contracts.js';

export const volumeKey = 'ozz.dev/volume-id';
export const classUidKey = 'ozz.dev/storage-class-uid';
export const localPathProvisioner = 'rancher.io/local-path';
export function fail(code: string, message: string, retryable = false): never {
  throw new StorageAdapterError(code, message, retryable);
}
export function safeError(error: unknown): StorageAdapterError {
  if (error instanceof StorageAdapterError) return error;
  if (error instanceof WorkloadAdapterError)
    return new StorageAdapterError(
      error.code,
      '环境 Namespace 或任务租约校验失败。',
      error.retryable,
    );
  const safe = safeKubernetesError(error);
  return new StorageAdapterError(
    safe.httpStatus === 409 ? 'STORAGE_RESOURCE_CONFLICT' : safe.code,
    safe.httpStatus === 409
      ? '存储资源已变化，请刷新后重试。'
      : '无法完成有界 Kubernetes 存储请求。',
    safe.retryable || safe.httpStatus === 409,
  );
}
export async function checkpoint(
  hooks: Pick<StorageWriteHooks, 'checkpoint'>,
  signal: AbortSignal,
): Promise<void> {
  await invokeHook(hooks.checkpoint, signal);
}
export function validateCluster(target: StorageClusterTarget): void {
  if (
    !target ||
    !uuid(target.installationId) ||
    !uuid(target.clusterId) ||
    !text(target.kubeSystemUid, 128) ||
    !/^SHA256:[a-f0-9]{64}$/u.test(target.caFingerprint)
  )
    fail('STORAGE_INPUT_INVALID', '存储集群身份无效。');
}
function validBinding(value: StorageBindingIdentity): boolean {
  return Boolean(
    value &&
    text(value.pvName) &&
    text(value.pvUid, 128) &&
    Array.isArray(value.nodes) &&
    value.nodes.length > 0 &&
    value.nodes.length <= 1000 &&
    value.nodes.every((node) => text(node.name) && text(node.uid, 128)) &&
    new Set(value.nodes.map((node) => node.name)).size === value.nodes.length,
  );
}
export function validatePlan(plan: StorageVolumePlan): void {
  validateCluster(plan?.target);
  const { target, claim, namespace } = plan;
  if (
    ![target.projectId, target.environmentId, target.volumeId].every(uuid) ||
    target.namespace !== environmentNamespaceName(target) ||
    !boundedInteger(plan.requestedBytes, 1024 * 1024, 1024 ** 4) ||
    !boundedInteger(plan.mutationRevision, 0, Number.MAX_SAFE_INTEGER) ||
    !text(plan.storageClassName, 253) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(plan.storageClassName) ||
    (plan.storageClassUid !== null && !text(plan.storageClassUid, 128)) ||
    !claim ||
    claim.name !== `ozz-v-${target.volumeId.replaceAll('-', '')}` ||
    claim.namespace !== target.namespace ||
    !uuid(claim.creationNonce) ||
    typeof claim.creationAttempted !== 'boolean' ||
    (claim.uid !== null && !text(claim.uid, 128)) ||
    (claim.resourceVersion !== null && !text(claim.resourceVersion, 128)) ||
    !boundedInteger(claim.ledgerVersion, 0, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(claim.mutationRevision, 0, plan.mutationRevision) ||
    (claim.specFingerprint !== null && !/^[a-f0-9]{64}$/u.test(claim.specFingerprint)) ||
    !namespace ||
    namespace.kind !== 'Namespace' ||
    namespace.name !== target.namespace ||
    namespace.namespace !== null ||
    !uuid(namespace.creationNonce) ||
    namespace.mutationRevision !== 0 ||
    (plan.knownBinding != null && !validBinding(plan.knownBinding))
  )
    fail('STORAGE_INPUT_INVALID', '卷意图或持久身份无效。');
}
export function validateHooks(hooks: StorageWriteHooks): void {
  if (
    !hooks ||
    ['checkpoint', 'beforeWrite', 'onReceipt'].some(
      (key) => typeof hooks[key as keyof StorageWriteHooks] !== 'function',
    ) ||
    !hooks.namespace ||
    typeof hooks.namespace.beforeWrite !== 'function' ||
    typeof hooks.namespace.onReceipt !== 'function'
  )
    fail('STORAGE_INPUT_INVALID', '存储写入回调无效。');
}
export async function optional<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KubernetesAdapterError && error.httpStatus === 404) return null;
    throw error;
  }
}
export function quantity(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d+(?:\.\d+)?)([KMGTPE]i|[kKMGTPE]|m)?$/u.exec(value);
  if (!parts) return null;
  const suffix = parts[2];
  const factor = !suffix
    ? 1
    : suffix === 'm'
      ? 0.001
      : suffix.endsWith('i')
        ? 1024 ** ('KMGTPE'.indexOf(suffix[0]!) + 1)
        : 1000 ** ('KMGTPE'.indexOf(suffix.toUpperCase()) + 1);
  const result = Number(parts[1]) * factor;
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER
    ? result
    : null;
}
export function classObservation(actual: V1StorageClass): StorageClassObservation {
  if (
    actual.kind !== 'StorageClass' ||
    actual.apiVersion !== 'storage.k8s.io/v1' ||
    !text(actual.metadata?.name) ||
    !text(actual.metadata?.uid, 128) ||
    !text(actual.provisioner, 253)
  )
    fail('KUBERNETES_INVALID_RESPONSE', 'StorageClass 响应缺少可验证身份。');
  const mode = actual.volumeBindingMode ?? 'Immediate';
  const policy = actual.reclaimPolicy ?? 'Delete';
  const supported =
    actual.provisioner === localPathProvisioner &&
    ['Immediate', 'WaitForFirstConsumer'].includes(mode) &&
    ['Delete', 'Retain'].includes(policy) &&
    !actual.metadata?.deletionTimestamp;
  return {
    name: actual.metadata!.name!,
    uid: actual.metadata!.uid!,
    provisioner: actual.provisioner,
    bindingMode: mode === 'Immediate' || mode === 'WaitForFirstConsumer' ? mode : null,
    reclaimPolicy: policy === 'Delete' || policy === 'Retain' ? policy : null,
    default:
      actual.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' ||
      actual.metadata?.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true',
    supported,
    code: supported ? null : 'STORAGE_CLASS_UNSUPPORTED',
    message: supported
      ? 'local-path 文件系统卷使用 RWO；申请容量不是硬配额。'
      : '当前仅支持已验证的 local-path 文件系统卷。',
    hardQuotaSupport: actual.provisioner === localPathProvisioner ? 'unsupported' : 'unknown',
    allowVolumeExpansion: actual.allowVolumeExpansion === true,
  };
}
export async function readClass(
  client: InspectionClient,
  plan: StorageVolumePlan,
): Promise<StorageClassObservation> {
  const actual = await optional(() =>
    client.storage.readStorageClass({ name: plan.storageClassName }),
  );
  if (!actual) fail('STORAGE_CLASS_MISSING', '登记的 StorageClass 已不存在。');
  const result = classObservation(actual);
  if (plan.storageClassUid && plan.storageClassUid !== result.uid)
    fail('STORAGE_CLASS_REPLACED', '同名 StorageClass 的 UID 已变化。');
  return result;
}
export function claimFingerprint(actual: V1PersistentVolumeClaim): string {
  const spec = actual.spec;
  return fingerprint({
    storageClassName: spec?.storageClassName ?? null,
    accessModes: spec?.accessModes ?? [],
    volumeMode: spec?.volumeMode ?? 'Filesystem',
    requestedBytes: quantity(spec?.resources?.requests?.storage),
    limits: spec?.resources?.limits ?? null,
    selector: spec?.selector ?? null,
    dataSource: spec?.dataSource ?? null,
    dataSourceRef: spec?.dataSourceRef ?? null,
    volumeAttributesClassName: spec?.volumeAttributesClassName ?? null,
  });
}
export function claimManifest(plan: StorageVolumePlan, classUid: string): V1PersistentVolumeClaim {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: plan.claim.name,
      namespace: plan.target.namespace,
      labels: { ...ownershipLabels(plan.target, true), [volumeKey]: plan.target.volumeId },
      annotations: {
        [keys.nonce]: plan.claim.creationNonce,
        [keys.mutation]: String(plan.mutationRevision),
        [classUidKey]: classUid,
      },
    },
    spec: {
      storageClassName: plan.storageClassName,
      accessModes: ['ReadWriteOnce'],
      volumeMode: 'Filesystem',
      resources: { requests: { storage: String(plan.requestedBytes) } },
    },
  };
}
export function verifyClaim(plan: StorageVolumePlan, actual: V1PersistentVolumeClaim): void {
  const meta = actual.metadata;
  if (
    actual.kind !== 'PersistentVolumeClaim' ||
    actual.apiVersion !== 'v1' ||
    !meta ||
    meta.name !== plan.claim.name ||
    meta.namespace !== plan.target.namespace ||
    !text(meta.uid, 128) ||
    !text(meta.resourceVersion, 128) ||
    Object.entries({
      ...ownershipLabels(plan.target, true),
      [volumeKey]: plan.target.volumeId,
    }).some(([key, value]) => meta.labels?.[key] !== value) ||
    meta.annotations?.[keys.nonce] !== plan.claim.creationNonce ||
    (plan.claim.uid ? meta.uid !== plan.claim.uid : !plan.claim.creationAttempted)
  )
    fail('STORAGE_OWNERSHIP_MISMATCH', 'PVC 的 UID、创建 nonce 或目标所有权不一致。');
  const actualRevision = revision(meta.annotations?.[keys.mutation]);
  if (actualRevision === null || actualRevision > plan.mutationRevision)
    fail('STORAGE_REVISION_AHEAD', 'PVC 变更版本无法验证或已超前。');
  if (actualRevision < plan.claim.mutationRevision && plan.claim.specFingerprint === null)
    fail('STORAGE_CONFIGURATION_DRIFT', 'PVC 原始配置身份无法验证。');
  const classUid = meta.annotations?.[classUidKey];
  if (!text(classUid, 128) || (plan.storageClassUid && plan.storageClassUid !== classUid))
    fail('STORAGE_CLASS_REPLACED', 'PVC 的 StorageClass 持久身份不一致。');
  if (
    claimFingerprint(actual) !== claimFingerprint(claimManifest(plan, classUid!)) ||
    (plan.claim.specFingerprint && plan.claim.specFingerprint !== claimFingerprint(actual))
  )
    fail('STORAGE_CONFIGURATION_DRIFT', 'PVC 的容量、访问方式、来源或存储配置已变化。');
}
export function receipt(
  plan: StorageVolumePlan,
  actual: V1PersistentVolumeClaim | null,
  action: StorageResourceReceipt['action'],
  storageClassUid: string | null,
  binding: StorageBindingIdentity | null,
  observedAt: string,
): StorageResourceReceipt {
  return {
    action,
    name: plan.claim.name,
    namespace: plan.target.namespace,
    creationNonce: plan.claim.creationNonce,
    uid: actual?.metadata?.uid ?? plan.claim.uid,
    resourceVersion: actual?.metadata?.resourceVersion ?? plan.claim.resourceVersion,
    mutationRevision: plan.mutationRevision,
    storageClassUid,
    specFingerprint: actual ? claimFingerprint(actual) : plan.claim.specFingerprint,
    binding,
    observedAt,
  };
}
