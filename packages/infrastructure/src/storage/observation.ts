import type {
  V1Node,
  V1NodeSelectorRequirement,
  V1PersistentVolumeClaim,
  V1Pod,
} from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import type { InspectionClient } from '../kubernetes/transport.js';
import { keys, ownershipLabels } from '../workload/names.js';
import { verifyEnvironmentNamespace } from '../workload/namespace.js';
import { text, uuid } from '../workload/validation.js';
import type {
  StorageBindingIdentity,
  StoragePodMount,
  StorageVolumeObservation,
  StorageVolumePlan,
} from './contracts.js';
import {
  classUidKey,
  fail,
  localPathProvisioner,
  optional,
  quantity,
  readClass,
  receipt,
  safeError,
  verifyClaim,
} from './resources.js';

export interface ObservationLimits {
  maxPods: number;
  maxNodes: number;
}
export function absentObservation(
  plan: StorageVolumePlan,
  observedAt: string,
  state: 'missing' | 'destroyed' = 'missing',
): StorageVolumeObservation {
  return {
    observedAt,
    state,
    code: state === 'missing' ? 'STORAGE_CLAIM_MISSING' : null,
    message:
      state === 'missing'
        ? 'PVC 当前不存在；已知卷不会自动重建为空卷。'
        : 'PVC 与已登记 PV 均已确认不存在。',
    requestedBytes: plan.requestedBytes,
    hardQuotaSupport: 'unknown',
    pvc: {
      name: plan.claim.name,
      uid: plan.claim.uid,
      resourceVersion: null,
      phase: 'Missing',
      deleting: false,
    },
    pv: null,
    storageClass: null,
    locality: 'unknown',
    nodes: [],
    usage: { usedBytes: null, nodeAvailableBytes: null, observedAt: null },
    mounts: [],
    mountsTruncated: false,
    destructionBlockers:
      state === 'missing' && (plan.claim.uid || plan.claim.creationAttempted)
        ? [{ code: 'STORAGE_CLAIM_MISSING', message: '已知 PVC 缺失，需要核对原 PV 和数据身份。' }]
        : [],
  };
}
function mount(pod: V1Pod, plan: StorageVolumePlan): StoragePodMount | null {
  const volumes = (pod.spec?.volumes ?? []).filter(
    (volume) => volume.persistentVolumeClaim?.claimName === plan.claim.name,
  );
  if (!volumes.length) return null;
  if (
    !text(pod.metadata?.name) ||
    !text(pod.metadata?.uid, 128) ||
    pod.metadata?.namespace !== plan.target.namespace
  )
    fail('KUBERNETES_INVALID_RESPONSE', '挂载 Pod 缺少可验证身份。');
  const selected = new Set(volumes.map((volume) => volume.name));
  const mounts = [
    ...(pod.spec?.containers ?? []),
    ...(pod.spec?.initContainers ?? []),
    ...(pod.spec?.ephemeralContainers ?? []),
  ].flatMap((container) =>
    (container.volumeMounts ?? []).filter((item) => selected.has(item.name)),
  );
  return {
    podName: pod.metadata!.name!,
    podUid: pod.metadata!.uid!,
    namespace: plan.target.namespace,
    nodeName: pod.spec?.nodeName ?? null,
    phase: pod.status?.phase ?? 'Unknown',
    deleting: Boolean(pod.metadata?.deletionTimestamp),
    readOnly:
      volumes.every((volume) => volume.persistentVolumeClaim?.readOnly === true) ||
      (mounts.length > 0 && mounts.every((item) => item.readOnly === true)),
    paths: [...new Set(mounts.map((item) => item.mountPath))].sort(),
    serviceId: null,
    controller: null,
  };
}
async function mountController(
  client: InspectionClient,
  plan: StorageVolumePlan,
  pod: V1Pod,
  cache: Map<string, Promise<{ kind: string; name: string; uid: string } | null>>,
): Promise<{ serviceId: string; controller: { kind: string; name: string; uid: string } } | null> {
  const serviceId = pod.metadata?.labels?.[keys.service];
  if (!uuid(serviceId)) return null;
  const labels = { ...ownershipLabels(plan.target, true), [keys.service]: serviceId };
  if (Object.entries(labels).some(([key, value]) => pod.metadata?.labels?.[key] !== value))
    return null;
  const owners = pod.metadata?.ownerReferences?.filter((owner) => owner.controller === true) ?? [],
    owner = owners[0];
  if (
    owners.length !== 1 ||
    owner?.apiVersion !== 'apps/v1' ||
    !['ReplicaSet', 'StatefulSet'].includes(owner.kind) ||
    !text(owner.name) ||
    !text(owner.uid, 128)
  )
    return null;
  const key = `${serviceId}/${owner.kind}/${owner.name}/${owner.uid}`;
  if (!cache.has(key))
    cache.set(
      key,
      (async () => {
        try {
          let rootKind: 'Deployment' | 'StatefulSet', rootName: string, rootUid: string;
          if (owner.kind === 'ReplicaSet') {
            const set = await optional(() =>
              client.apps.readNamespacedReplicaSet({
                namespace: plan.target.namespace,
                name: owner.name,
              }),
            );
            const parents =
                set?.metadata?.ownerReferences?.filter((parent) => parent.controller === true) ??
                [],
              parent = parents[0];
            if (
              !set ||
              set.kind !== 'ReplicaSet' ||
              set.apiVersion !== 'apps/v1' ||
              set.metadata?.namespace !== plan.target.namespace ||
              set.metadata.name !== owner.name ||
              set.metadata.uid !== owner.uid ||
              Object.entries(labels).some(
                ([key, value]) => set.metadata?.labels?.[key] !== value,
              ) ||
              parents.length !== 1 ||
              parent?.apiVersion !== 'apps/v1' ||
              parent.kind !== 'Deployment'
            )
              return null;
            rootKind = 'Deployment';
            rootName = parent.name;
            rootUid = parent.uid;
          } else {
            rootKind = 'StatefulSet';
            rootName = owner.name;
            rootUid = owner.uid;
          }
          if (rootName !== `ozz-s-${serviceId.replaceAll('-', '')}` || !text(rootUid, 128))
            return null;
          const args = { namespace: plan.target.namespace, name: rootName };
          const root =
            rootKind === 'Deployment'
              ? await optional(() => client.apps.readNamespacedDeployment(args))
              : await optional(() => client.apps.readNamespacedStatefulSet(args));
          if (
            !root ||
            root.apiVersion !== 'apps/v1' ||
            root.kind !== rootKind ||
            root.metadata?.name !== rootName ||
            root.metadata.namespace !== plan.target.namespace ||
            root.metadata.uid !== rootUid ||
            !uuid(root.metadata.annotations?.[keys.nonce]) ||
            Object.entries(labels).some(([key, value]) => root.metadata?.labels?.[key] !== value)
          )
            return null;
          return { kind: rootKind, name: rootName, uid: rootUid };
        } catch (error) {
          if (safeError(error).code === 'KUBERNETES_CANCELLED') throw error;
          return null;
        }
      })(),
    );
  const controller = await cache.get(key)!;
  return controller ? { serviceId, controller } : null;
}
export async function actualMounts(
  client: InspectionClient,
  plan: StorageVolumePlan,
  limit: number,
): Promise<{ mounts: StoragePodMount[]; truncated: boolean }> {
  const list = await client.core.listNamespacedPod({
    namespace: plan.target.namespace,
    limit: limit + 1,
  });
  if (list.kind !== 'PodList' || !Array.isArray(list.items))
    fail('KUBERNETES_INVALID_RESPONSE', 'Pod 挂载列表响应无效。');
  const mounts: StoragePodMount[] = [],
    controllers = new Map<string, Promise<{ kind: string; name: string; uid: string } | null>>();
  for (const pod of list.items.slice(0, limit)) {
    const found = mount(pod, plan);
    if (!found) continue;
    const owner = await mountController(client, plan, pod, controllers);
    if (owner) {
      found.serviceId = owner.serviceId;
      found.controller = owner.controller;
    }
    mounts.push(found);
  }
  return { mounts, truncated: Boolean(list.metadata?._continue) || list.items.length > limit };
}
function requirement(item: V1NodeSelectorRequirement, values: Record<string, string>): boolean {
  const value = values[item.key];
  switch (item.operator) {
    case 'In':
      return Boolean(item.values?.length) && value !== undefined && item.values!.includes(value);
    case 'NotIn':
      return Boolean(item.values?.length) && (value === undefined || !item.values!.includes(value));
    case 'Exists':
      return value !== undefined && !item.values?.length;
    case 'DoesNotExist':
      return value === undefined && !item.values?.length;
    case 'Gt':
    case 'Lt': {
      if (
        !/^-?\d+$/u.test(value ?? '') ||
        item.values?.length !== 1 ||
        !/^-?\d+$/u.test(item.values[0]!)
      )
        return false;
      return item.operator === 'Gt'
        ? BigInt(value!) > BigInt(item.values[0]!)
        : BigInt(value!) < BigInt(item.values[0]!);
    }
    default:
      fail('STORAGE_NODE_AFFINITY_UNSUPPORTED', 'PV 节点约束使用当前不支持的操作符。');
  }
}
function ready(node: V1Node): boolean | null {
  const status = node.status?.conditions?.find((condition) => condition.type === 'Ready')?.status;
  return status === 'True' ? true : status === 'False' ? false : null;
}
export function bindingOf(observation: StorageVolumeObservation): StorageBindingIdentity | null {
  return observation.pv && observation.nodes.length
    ? {
        pvName: observation.pv.name,
        pvUid: observation.pv.uid,
        nodes: observation.nodes.map(({ name, uid }) => ({ name, uid })),
      }
    : null;
}
export async function observeVolume(
  client: InspectionClient,
  plan: StorageVolumePlan,
  limits: ObservationLimits,
  observedAt: string,
): Promise<StorageVolumeObservation> {
  const result = absentObservation(plan, observedAt);
  result.destructionBlockers = [];
  let claimRead = false;
  try {
    const namespace = await optional(() =>
      client.core.readNamespace({ name: plan.target.namespace }),
    );
    if (!namespace) {
      result.code = 'STORAGE_NAMESPACE_MISSING';
      result.message = '登记的环境 Namespace 已不存在。';
      result.destructionBlockers.push({ code: result.code, message: result.message });
      return result;
    }
    verifyEnvironmentNamespace(plan.target, plan.namespace, namespace);
    const mounts = await actualMounts(client, plan, limits.maxPods);
    result.mounts = mounts.mounts;
    result.mountsTruncated = mounts.truncated;
    result.destructionBlockers = [];
    if (mounts.truncated)
      result.destructionBlockers.push({
        code: 'STORAGE_MOUNTS_INCOMPLETE',
        message: '实际 Pod 挂载扫描超出边界，不能确认卷无人引用。',
      });
    if (mounts.mounts.length)
      result.destructionBlockers.push({
        code: 'STORAGE_VOLUME_MOUNTED',
        message: '集群中仍有 Pod 引用该 PVC，包含正在结束的 Pod。',
      });
    const actual = await optional(() =>
      client.core.readNamespacedPersistentVolumeClaim({
        namespace: plan.target.namespace,
        name: plan.claim.name,
      }),
    );
    claimRead = true;
    if (!actual) {
      if (plan.claim.uid || plan.claim.creationAttempted || plan.knownBinding)
        result.destructionBlockers.push({
          code: 'STORAGE_CLAIM_MISSING',
          message: '已知 PVC 缺失，需要核对原 PV 和数据身份。',
        });
      return result;
    }
    result.pvc = {
      name: plan.claim.name,
      uid: actual.metadata?.uid ?? null,
      resourceVersion: actual.metadata?.resourceVersion ?? null,
      phase:
        actual.status?.phase === 'Pending' ||
        actual.status?.phase === 'Bound' ||
        actual.status?.phase === 'Lost'
          ? actual.status.phase
          : 'Unknown',
      deleting: Boolean(actual.metadata?.deletionTimestamp),
    };
    verifyClaim(plan, actual);
    const storageClass = await readClass(client, plan);
    result.storageClass = storageClass;
    result.hardQuotaSupport = storageClass.hardQuotaSupport;
    if (actual.metadata?.annotations?.[classUidKey] !== storageClass.uid)
      fail('STORAGE_CLASS_REPLACED', 'PVC 原 StorageClass 已被同名对象替换。');
    if (!storageClass.supported) fail('STORAGE_CLASS_UNSUPPORTED', storageClass.message);
    if (storageClass.reclaimPolicy !== 'Delete')
      result.destructionBlockers.push({
        code: 'STORAGE_RECLAIM_RETAIN',
        message: '当前 StorageClass 回收策略不是 Delete，阻止平台销毁。',
      });
    if (actual.status?.phase === 'Lost')
      fail('STORAGE_BINDING_LOST', 'PVC 已进入 Lost，原数据绑定无法验证。');
    if (!actual.spec?.volumeName) {
      if (plan.knownBinding) fail('STORAGE_BINDING_CHANGED', 'PVC 已丢失登记的 PV 绑定。');
      if (actual.status?.phase === 'Bound')
        fail('STORAGE_BINDING_INVALID', 'Bound PVC 没有 PV 名称。');
      result.state = 'pending';
      result.code = null;
      result.locality =
        storageClass.bindingMode === 'WaitForFirstConsumer' ? 'waiting_for_consumer' : 'unknown';
      result.message =
        result.locality === 'waiting_for_consumer'
          ? 'PVC 等待首个消费者选择节点；创建已经完成。'
          : 'PVC 已创建，正在等待 provisioner 绑定。';
    } else {
      await observeBinding(client, plan, actual, result, limits);
      result.state =
        actual.status?.phase === 'Bound' && result.locality === 'verified' ? 'ready' : 'pending';
      result.code = null;
      result.message =
        result.state === 'ready'
          ? 'PVC、PV、StorageClass 与本地节点身份已核对。'
          : '数据绑定已核对，等待 PVC 就绪。';
    }
    if (result.pvc.deleting) {
      result.state = 'pending';
      result.message = 'PVC 正在删除；等待 Kubernetes 和 provisioner 完成。';
    }
    result.verifiedReceipt = receipt(
      plan,
      actual,
      'verified',
      storageClass.uid,
      bindingOf(result),
      observedAt,
    );
    return result;
  } catch (error) {
    const safe = safeError(error);
    result.state =
      safe.code.startsWith('KUBERNETES_') ||
      [
        'WORKLOAD_RESOURCE_CONFLICT',
        'STORAGE_NODE_UNAVAILABLE',
        'STORAGE_NODES_INCOMPLETE',
      ].includes(safe.code)
        ? 'unknown'
        : 'drifted';
    result.code = safe.code;
    result.message = safe.message;
    if (!claimRead) result.pvc.phase = 'Unknown';
    result.destructionBlockers.push({ code: safe.code, message: safe.message });
    return result;
  }
}
async function observeBinding(
  client: InspectionClient,
  plan: StorageVolumePlan,
  claim: V1PersistentVolumeClaim,
  result: StorageVolumeObservation,
  limits: ObservationLimits,
): Promise<void> {
  const name = claim.spec!.volumeName!;
  if (!text(name)) fail('STORAGE_BINDING_INVALID', 'PV 名称无效。');
  const pv = await optional(() => client.core.readPersistentVolume({ name }));
  if (!pv) fail('STORAGE_PV_MISSING', 'PVC 指向的 PV 已不存在。');
  const spec = pv.spec;
  if (!spec || !spec.claimRef) fail('STORAGE_BINDING_INVALID', 'PV 没有可核对的 claimRef。');
  if (
    pv.apiVersion !== 'v1' ||
    pv.kind !== 'PersistentVolume' ||
    pv.metadata?.name !== name ||
    !text(pv.metadata.uid, 128) ||
    spec?.claimRef?.uid !== claim.metadata!.uid ||
    spec.claimRef.name !== plan.claim.name ||
    spec.claimRef.namespace !== plan.target.namespace ||
    (spec.claimRef.kind && spec.claimRef.kind !== 'PersistentVolumeClaim') ||
    spec.storageClassName !== plan.storageClassName ||
    (spec.volumeMode ?? 'Filesystem') !== 'Filesystem' ||
    spec.accessModes?.length !== 1 ||
    spec.accessModes[0] !== 'ReadWriteOnce'
  )
    fail('STORAGE_BINDING_INVALID', 'PV 的 UID、claimRef、StorageClass 或访问方式与 PVC 不一致。');
  const provisioner = pv.metadata.annotations?.['pv.kubernetes.io/provisioned-by'];
  if (
    provisioner !== localPathProvisioner ||
    !(Boolean(spec.hostPath) !== Boolean(spec.local)) ||
    spec.csi ||
    spec.nfs ||
    spec.iscsi ||
    spec.flexVolume
  )
    fail('STORAGE_PROVISIONER_UNVERIFIED', 'PV 未能验证为受支持的 local-path 文件系统数据。');
  const capacity = quantity(spec.capacity?.storage);
  if (capacity === null || capacity < plan.requestedBytes)
    fail(
      'STORAGE_CAPACITY_INCONSISTENT',
      'PV 的报告容量无法满足固定 PVC 申请；这不代表本地卷具备硬配额。',
    );
  result.pv = {
    name,
    uid: pv.metadata.uid!,
    claimUid: spec.claimRef.uid!,
    capacityBytes: quantity(spec.capacity?.storage),
    reclaimPolicy:
      spec.persistentVolumeReclaimPolicy === 'Delete' ||
      spec.persistentVolumeReclaimPolicy === 'Retain'
        ? spec.persistentVolumeReclaimPolicy
        : null,
    storageClassName: spec.storageClassName!,
    provisioner,
    nodeAffinity: structuredClone(spec.nodeAffinity ?? null),
  };
  if (
    plan.knownBinding &&
    (plan.knownBinding.pvName !== name || plan.knownBinding.pvUid !== pv.metadata.uid)
  )
    fail('STORAGE_BINDING_CHANGED', '登记的 PV 已被替换或 PVC 改绑到其他 PV。');
  if (result.pv.reclaimPolicy !== 'Delete')
    result.destructionBlockers.push({
      code: 'STORAGE_RECLAIM_RETAIN',
      message: '实际 PV 的回收策略不是 Delete；平台不会删除或清理 Retain 数据。',
    });
  const terms = spec.nodeAffinity?.required?.nodeSelectorTerms;
  if (!terms?.length || terms.length > 32)
    fail('STORAGE_NODE_AFFINITY_UNVERIFIED', '本地 PV 没有可验证的有界节点约束。');
  if (
    terms.some(
      (term) =>
        (term.matchExpressions?.length ?? 0) > 32 ||
        (term.matchFields?.length ?? 0) > 4 ||
        term.matchFields?.some((field) => field.key !== 'metadata.name') ||
        term.matchExpressions?.some((field) => (field.values?.length ?? 0) > 1000),
    )
  )
    fail('STORAGE_NODE_AFFINITY_UNSUPPORTED', 'PV 节点约束超过当前可核验边界。');
  const list = await client.core.listNode({ limit: limits.maxNodes + 1 });
  if (
    list.kind !== 'NodeList' ||
    !Array.isArray(list.items) ||
    list.items.length > limits.maxNodes ||
    list.metadata?._continue
  )
    fail('STORAGE_NODES_INCOMPLETE', '节点观察不完整，无法核对本地数据位置。');
  const matches = list.items.filter((node) =>
    terms.some((term) => {
      if (!(term.matchExpressions?.length || term.matchFields?.length)) return false;
      return (
        (term.matchExpressions ?? []).every((item) =>
          requirement(item, node.metadata?.labels ?? {}),
        ) &&
        (term.matchFields ?? []).every((item) =>
          requirement(item, { 'metadata.name': node.metadata?.name ?? '' }),
        )
      );
    }),
  );
  result.nodes = matches.map((node) => {
    if (!text(node.metadata?.name) || !text(node.metadata?.uid, 128))
      fail('KUBERNETES_INVALID_RESPONSE', '本地节点缺少可验证 UID。');
    return { name: node.metadata!.name!, uid: node.metadata!.uid!, ready: ready(node) };
  });
  if (matches.length !== 1) {
    result.locality = 'unavailable';
    fail('STORAGE_NODE_UNAVAILABLE', '本地 PV 必须匹配唯一的实际节点。');
  }
  if (
    plan.knownBinding &&
    (plan.knownBinding.nodes.length !== result.nodes.length ||
      plan.knownBinding.nodes.some(
        (known) => !result.nodes.some((node) => node.name === known.name && node.uid === known.uid),
      ))
  )
    fail('STORAGE_NODE_REPLACED', '同名节点的 UID 已变化，不能把新节点当作原本地数据位置。');
  if (result.nodes.some((node) => node.ready !== true)) {
    result.locality = 'unavailable';
    fail('STORAGE_NODE_UNAVAILABLE', '本地数据节点当前未确认 Ready，停止自动恢复写入。');
  }
  result.locality = 'verified';
}
