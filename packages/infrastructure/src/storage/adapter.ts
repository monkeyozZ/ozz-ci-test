import { setTimeout as delay } from 'node:timers/promises';
import { connectionMaterial, verifyCredentialTime } from '../kubernetes/config.js';
import type { ParsedKubernetesConnection } from '../kubernetes/contracts.js';
import {
  createInspectionClient,
  transportLimits,
  type InspectionClient,
  type TransportLimits,
} from '../kubernetes/transport.js';
import { invokeHook } from '../workload/hooks.js';
import { ensureEnvironmentNamespace, verifyEnvironmentNamespace } from '../workload/namespace.js';
import type { WorkloadTarget } from '../workload/contracts.js';
import { boundedInteger, text, validateTarget } from '../workload/validation.js';
import {
  type KubernetesStorageAdapterOptions,
  type KubernetesStorageManager,
  type PreparedVolumeBinding,
  type StorageCapabilities,
  type StorageClusterTarget,
  type StorageMutationReceipt,
  type StorageResourceReceipt,
  type StorageVolumeObservation,
  type StorageVolumePlan,
  type StorageWriteHooks,
} from './contracts.js';
import {
  absentObservation,
  actualMounts,
  bindingOf,
  observeVolume,
  type ObservationLimits,
} from './observation.js';
import {
  checkpoint,
  claimManifest,
  classObservation,
  classUidKey,
  fail,
  localPathProvisioner,
  optional,
  readClass,
  receipt,
  safeError,
  validateCluster,
  validateHooks,
  validatePlan,
  verifyClaim,
} from './resources.js';

interface Limits extends ObservationLimits {
  transport: TransportLimits;
  operationTimeoutMs: number;
  pollIntervalMs: number;
}
function limits(options: KubernetesStorageAdapterOptions): Limits {
  const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
    const result = value ?? fallback;
    if (!boundedInteger(result, min, max))
      fail('STORAGE_INPUT_INVALID', '存储 Adapter 边界参数无效。');
    return result;
  };
  return {
    transport: transportLimits(options),
    operationTimeoutMs: bounded(options.operationTimeoutMs, 120_000, 50, 900_000),
    pollIntervalMs: bounded(options.pollIntervalMs, 1000, 10, 10_000),
    maxPods: bounded(options.maxPods, 500, 1, 2000),
    maxNodes: bounded(options.maxNodes, 500, 1, 1000),
  };
}
async function provisioner(client: InspectionClient): Promise<StorageCapabilities['provisioner']> {
  try {
    const deployment = await optional(() =>
      client.apps.readNamespacedDeployment({
        namespace: 'kube-system',
        name: 'local-path-provisioner',
      }),
    );
    if (!deployment) return { state: 'missing', version: null };
    const image = deployment.spec?.template.spec?.containers.find(
      (container) => container.name === 'local-path-provisioner',
    )?.image;
    const match =
      /(?:^|\/)local-path-provisioner:(v?\d+\.\d+\.\d+)(?:-[A-Za-z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/u.exec(
        image ?? '',
      );
    const desired = deployment.spec?.replicas ?? 1;
    const ready =
      deployment.kind === 'Deployment' &&
      deployment.metadata?.uid &&
      !deployment.metadata.deletionTimestamp &&
      deployment.metadata.generation &&
      (deployment.status?.observedGeneration ?? 0) >= deployment.metadata.generation &&
      desired > 0 &&
      (deployment.status?.readyReplicas ?? 0) >= desired &&
      Boolean(match);
    return { state: ready ? 'ready' : 'unknown', version: match?.[1] ?? null };
  } catch {
    return { state: 'unknown', version: null };
  }
}
function requireUsable(observation: StorageVolumeObservation): void {
  if (
    !['ready', 'pending'].includes(observation.state) ||
    observation.pvc.deleting ||
    !observation.verifiedReceipt
  )
    fail(observation.code ?? 'STORAGE_NOT_READY', observation.message);
}
function requireDestroyable(observation: StorageVolumeObservation): void {
  const blocker = observation.destructionBlockers[0];
  if (blocker) fail(blocker.code, blocker.message);
  if (
    !['pending', 'ready'].includes(observation.state) ||
    observation.mountsTruncated ||
    observation.mounts.length
  )
    fail(observation.code ?? 'STORAGE_DESTRUCTION_BLOCKED', observation.message);
}

/** Creates and deletes only the registered PVC. PVs, Nodes and host paths remain read-only. */
export class KubernetesStorageAdapter implements KubernetesStorageManager {
  private readonly limits: Limits;
  private readonly now: () => Date;
  constructor(options: KubernetesStorageAdapterOptions = {}) {
    this.limits = limits(options);
    this.now = options.now ?? (() => new Date());
  }
  private async session<T>(
    connection: ParsedKubernetesConnection,
    target: StorageClusterTarget,
    external: AbortSignal | undefined,
    work: (client: InspectionClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    validateCluster(target);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort('inspection_timeout'),
      this.limits.operationTimeoutMs,
    );
    timer.unref();
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    let client: InspectionClient | undefined;
    try {
      connectionMaterial(connection);
      verifyCredentialTime(connection, this.now());
      if (signal.aborted) fail('KUBERNETES_CANCELLED', '存储操作已取消。');
      if (connection.caFingerprint !== target.caFingerprint)
        fail('KUBERNETES_CA_MISMATCH', '集群 CA 指纹与固定存储目标不符。');
      client = await createInspectionClient(connection, this.limits.transport, signal);
      const namespace = await client.core.readNamespace({ name: 'kube-system' });
      if (
        namespace.metadata?.name !== 'kube-system' ||
        namespace.metadata.uid !== target.kubeSystemUid
      )
        fail('KUBERNETES_CLUSTER_IDENTITY_MISMATCH', 'kube-system UID 与固定存储目标不符。');
      return await work(client, signal);
    } catch (error) {
      if (controller.signal.aborted && !external?.aborted)
        fail('STORAGE_OPERATION_TIMEOUT', '存储操作超时，保留已取得回执并可按原意图重试。', true);
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      controller.abort('operation_finished');
      client?.close();
    }
  }
  async inspect(
    connection: ParsedKubernetesConnection,
    target: StorageClusterTarget,
    options: { signal?: AbortSignal } = {},
  ): Promise<StorageCapabilities> {
    return this.session(connection, target, options.signal, async (client) => {
      const result: StorageCapabilities = {
        observedAt: this.now().toISOString(),
        storageClasses: [],
        truncated: false,
        provisioner: { state: 'unknown', version: null },
        permissions: 'unknown',
        issues: [],
      };
      try {
        const list = await client.storage.listStorageClass({ limit: 101 });
        if (
          list.kind !== 'StorageClassList' ||
          list.apiVersion !== 'storage.k8s.io/v1' ||
          !Array.isArray(list.items)
        )
          fail('KUBERNETES_INVALID_RESPONSE', 'StorageClass 列表无效。');
        // Typed Kubernetes lists may omit TypeMeta on individual items. Only
        // the validated list envelope supplies missing fields; explicit type
        // mismatches and missing resource identities are still rejected.
        result.storageClasses = list.items.slice(0, 100).map((item) =>
          classObservation({
            ...item,
            kind: item.kind === undefined ? 'StorageClass' : item.kind,
            apiVersion: item.apiVersion === undefined ? 'storage.k8s.io/v1' : item.apiVersion,
          }),
        );
        result.truncated = Boolean(list.metadata?._continue) || list.items.length > 100;
        if (result.truncated)
          result.issues.push({
            code: 'STORAGE_CLASSES_INCOMPLETE',
            message: 'StorageClass 列表超过观察边界。',
          });
      } catch (error) {
        const safe = safeError(error);
        result.issues.push({ code: safe.code, message: safe.message });
      }
      result.provisioner = await provisioner(client);
      if (result.provisioner.state !== 'ready')
        result.issues.push({
          code: 'STORAGE_PROVISIONER_UNAVAILABLE',
          message: 'local-path provisioner 尚未验证为就绪。',
        });
      try {
        const requirements = [
          ['', 'namespaces', 'get'],
          ['', 'namespaces', 'create'],
          ['', 'persistentvolumeclaims', 'get'],
          ['', 'persistentvolumeclaims', 'create'],
          ['', 'persistentvolumeclaims', 'delete'],
          ['', 'persistentvolumes', 'get'],
          ['', 'persistentvolumes', 'list'],
          ['', 'pods', 'list'],
          ['', 'nodes', 'list'],
          ['storage.k8s.io', 'storageclasses', 'get'],
          ['storage.k8s.io', 'storageclasses', 'list'],
          ['apps', 'replicasets', 'get'],
          ['apps', 'deployments', 'get'],
          ['apps', 'statefulsets', 'get'],
        ] as const;
        let denied = false;
        for (const [group, resource, verb] of requirements) {
          const access = await client.authorization.createSelfSubjectAccessReview({
            body: {
              apiVersion: 'authorization.k8s.io/v1',
              kind: 'SelfSubjectAccessReview',
              spec: { resourceAttributes: { group, resource, verb } },
            },
          });
          if (typeof access.status?.allowed !== 'boolean')
            fail('KUBERNETES_INVALID_RESPONSE', '存储权限检查响应无效。');
          if (!access.status.allowed) denied = true;
        }
        result.permissions = denied ? 'insufficient' : 'ready';
        if (denied)
          result.issues.push({
            code: 'STORAGE_PERMISSION_INSUFFICIENT',
            message: '管理凭证缺少 PVC 操作或 PV、节点、Pod 观察权限。',
          });
      } catch (error) {
        const safe = safeError(error);
        result.issues.push({ code: safe.code, message: safe.message });
      }
      return result;
    });
  }
  async observe(
    connection: ParsedKubernetesConnection,
    plan: StorageVolumePlan,
    options: { signal?: AbortSignal } = {},
  ): Promise<StorageVolumeObservation> {
    validatePlan(plan);
    return this.session(connection, plan.target, options.signal, (client) =>
      observeVolume(client, plan, this.limits, this.now().toISOString()),
    );
  }
  async create(
    connection: ParsedKubernetesConnection,
    source: StorageVolumePlan,
    hooks: StorageWriteHooks,
  ): Promise<StorageMutationReceipt> {
    validatePlan(source);
    validateHooks(hooks);
    if (source.mutationRevision < 1) fail('STORAGE_INPUT_INVALID', '创建任务必须持有变更版本。');
    const plan = structuredClone(source);
    return this.session(connection, plan.target, hooks.signal, async (client, signal) => {
      const resources: StorageResourceReceipt[] = [];
      await checkpoint(hooks, signal);
      const storageClass = await readClass(client, plan);
      if (!storageClass.supported) fail('STORAGE_CLASS_UNSUPPORTED', storageClass.message);
      let actual = await optional(() =>
        client.core.readNamespacedPersistentVolumeClaim({
          namespace: plan.target.namespace,
          name: plan.claim.name,
        }),
      );
      if (!actual && plan.claim.uid)
        fail('STORAGE_CLAIM_MISSING', '已知 PVC 不存在；禁止自动创建同名空卷。');
      if (actual) verifyClaim(plan, actual);
      if (!actual && (await provisioner(client)).state !== 'ready')
        fail(
          'STORAGE_PROVISIONER_UNAVAILABLE',
          '创建前必须确认 local-path provisioner 就绪。',
          true,
        );
      const namespace = await ensureEnvironmentNamespace(
        client,
        plan.target,
        plan.namespace,
        hooks.namespace,
        signal,
        this.now,
      );
      plan.namespace = {
        ...plan.namespace,
        uid: namespace.receipt.uid,
        resourceVersion: namespace.receipt.resourceVersion,
        creationAttempted: true,
      };
      const action = actual ? 'verified' : 'created';
      if (!actual) {
        await checkpoint(hooks, signal);
        await invokeHook(
          () =>
            hooks.beforeWrite({
              action: 'create',
              name: plan.claim.name,
              namespace: plan.target.namespace,
              creationNonce: plan.claim.creationNonce,
              expectedUid: null,
              expectedResourceVersion: null,
              mutationRevision: plan.mutationRevision,
              storageClassUid: storageClass.uid,
              binding: null,
            }),
          signal,
        );
        plan.claim.creationAttempted = true;
        plan.storageClassUid = storageClass.uid;
        const classAtWrite = await readClass(client, plan);
        if (!classAtWrite.supported) fail('STORAGE_CLASS_UNSUPPORTED', classAtWrite.message);
        const namespaceAtWrite = await client.core.readNamespace({ name: plan.target.namespace });
        verifyEnvironmentNamespace(plan.target, plan.namespace, namespaceAtWrite);
        actual = await client.core.createNamespacedPersistentVolumeClaim({
          namespace: plan.target.namespace,
          body: claimManifest(plan, storageClass.uid),
          fieldManager: 'ozz',
          fieldValidation: 'Strict',
        });
      }
      verifyClaim(plan, actual);
      if (actual.metadata?.annotations?.[classUidKey] !== storageClass.uid)
        fail('STORAGE_CLASS_REPLACED', 'PVC 与实际 StorageClass UID 不一致。');
      if (actual.metadata?.deletionTimestamp)
        fail('STORAGE_CLAIM_DELETING', 'PVC 正在删除，不能重新创建或继续发布。');
      const initial = receipt(
        plan,
        actual,
        action,
        storageClass.uid,
        plan.knownBinding ?? null,
        this.now().toISOString(),
      );
      resources.push(initial);
      await invokeHook(() => hooks.onReceipt(initial), signal);
      plan.storageClassUid = storageClass.uid;
      plan.claim = {
        ...plan.claim,
        uid: initial.uid,
        resourceVersion: initial.resourceVersion,
        specFingerprint: initial.specFingerprint,
        creationAttempted: true,
      };
      const observation = await observeVolume(client, plan, this.limits, this.now().toISOString());
      requireUsable(observation);
      if (
        observation.verifiedReceipt &&
        JSON.stringify(observation.verifiedReceipt.binding) !== JSON.stringify(initial.binding)
      ) {
        resources.push(observation.verifiedReceipt);
        await invokeHook(() => hooks.onReceipt(observation.verifiedReceipt!), signal);
      }
      return { completedAt: this.now().toISOString(), resources, observation };
    });
  }
  async prepareBindings(
    connection: ParsedKubernetesConnection,
    target: WorkloadTarget,
    volumes: readonly { plan: StorageVolumePlan; path: string; readOnly: boolean }[],
    options: { signal?: AbortSignal } = {},
  ): Promise<PreparedVolumeBinding[]> {
    validateTarget(target);
    if (!Array.isArray(volumes) || volumes.length > 16)
      fail('STORAGE_INPUT_INVALID', '挂载数量超过边界。');
    const paths = new Set<string>(),
      ids = new Set<string>();
    for (const entry of volumes) {
      validatePlan(entry.plan);
      if (
        typeof entry.readOnly !== 'boolean' ||
        !text(entry.path, 512) ||
        !entry.path.startsWith('/') ||
        entry.path === '/' ||
        entry.path.includes('//') ||
        entry.path.split('/').some((part: string) => part === '.' || part === '..') ||
        ['/proc', '/sys', '/dev', '/run/ozz', '/run/secrets', '/var/run/secrets', '/etc/ozz'].some(
          (root) => entry.path === root || entry.path.startsWith(`${root}/`),
        ) ||
        paths.has(entry.path) ||
        ids.has(entry.plan.target.volumeId) ||
        [
          'installationId',
          'clusterId',
          'kubeSystemUid',
          'caFingerprint',
          'projectId',
          'environmentId',
          'namespace',
        ].some(
          (key) =>
            entry.plan.target[key as keyof typeof entry.plan.target] !==
            target[key as keyof WorkloadTarget],
        )
      )
        fail('STORAGE_TARGET_MISMATCH', '卷目标或挂载路径不符合当前服务。');
      for (const path of paths)
        if (path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${path}/`))
          fail('STORAGE_INPUT_INVALID', '挂载路径不能相互覆盖。');
      paths.add(entry.path);
      ids.add(entry.plan.target.volumeId);
    }
    return this.session(connection, target, options.signal, async (client) => {
      const result: PreparedVolumeBinding[] = [];
      for (const { plan, path, readOnly } of volumes) {
        const observed = await observeVolume(client, plan, this.limits, this.now().toISOString());
        requireUsable(observed);
        if (observed.mountsTruncated)
          fail('STORAGE_MOUNTS_INCOMPLETE', '不能在实际 Pod 引用扫描不完整时发布挂载。');
        // The observation establishes actual controller ancestry before assigning serviceId.
        // Read-only consumers may share a local node with its single writer.
        if (
          !readOnly &&
          observed.mounts.some((mount) => mount.serviceId !== target.serviceId && !mount.readOnly)
        )
          fail('STORAGE_VOLUME_IN_USE', '另一个实际 Pod 正在使用该卷，不能开始新的写入者。');
        if (
          observed.locality === 'unavailable' ||
          (observed.pv && observed.locality !== 'verified')
        )
          fail('STORAGE_NODE_UNAVAILABLE', '本地数据节点尚未验证。');
        result.push({
          volumeId: plan.target.volumeId,
          namespace: target.namespace,
          claimName: plan.claim.name,
          claimUid: observed.pvc.uid!,
          path,
          readOnly,
          storageClassUid: observed.storageClass!.uid,
          binding: bindingOf(observed),
          observedAt: observed.observedAt,
        });
      }
      let compatibleNodes: Set<string> | null = null;
      for (const volume of result) {
        if (!volume.binding) continue;
        const actualNodes = new Set(volume.binding.nodes.map((node) => node.uid));
        compatibleNodes =
          compatibleNodes === null
            ? actualNodes
            : new Set<string>([...compatibleNodes].filter((uid: string) => actualNodes.has(uid)));
        if (!compatibleNodes.size)
          fail('STORAGE_LOCALITY_CONFLICT', '多个本地卷位于不同节点，不能由同一 Pod 挂载。');
      }
      return result;
    });
  }
  async destroy(
    connection: ParsedKubernetesConnection,
    source: StorageVolumePlan,
    hooks: StorageWriteHooks,
  ): Promise<StorageMutationReceipt> {
    validatePlan(source);
    validateHooks(hooks);
    const plan = structuredClone(source);
    return this.session(connection, plan.target, hooks.signal, async (client, signal) => {
      const resources: StorageResourceReceipt[] = [];
      await checkpoint(hooks, signal);
      let actual = await optional(() =>
        client.core.readNamespacedPersistentVolumeClaim({
          namespace: plan.target.namespace,
          name: plan.claim.name,
        }),
      );
      if (actual) {
        let observation = await observeVolume(client, plan, this.limits, this.now().toISOString());
        requireDestroyable(observation);
        const verified = observation.verifiedReceipt!;
        resources.push(verified);
        await invokeHook(() => hooks.onReceipt(verified), signal);
        plan.claim = {
          ...plan.claim,
          uid: verified.uid,
          resourceVersion: verified.resourceVersion,
          specFingerprint: verified.specFingerprint,
          creationAttempted: true,
        };
        plan.storageClassUid = verified.storageClassUid;
        plan.knownBinding = verified.binding;
        await checkpoint(hooks, signal);
        if (!actual.metadata?.deletionTimestamp) {
          await invokeHook(
            () =>
              hooks.beforeWrite({
                action: 'delete',
                name: plan.claim.name,
                namespace: plan.target.namespace,
                creationNonce: plan.claim.creationNonce,
                expectedUid: verified.uid,
                expectedResourceVersion: verified.resourceVersion,
                mutationRevision: plan.mutationRevision,
                storageClassUid: verified.storageClassUid,
                binding: verified.binding,
              }),
            signal,
          );
          observation = await observeVolume(client, plan, this.limits, this.now().toISOString());
          requireDestroyable(observation);
          if (
            observation.pvc.resourceVersion !== verified.resourceVersion ||
            JSON.stringify(bindingOf(observation)) !== JSON.stringify(verified.binding)
          )
            fail('STORAGE_RESOURCE_CONFLICT', '删除检查期间 PVC 或 PV 绑定发生变化。', true);
          await client.core.deleteNamespacedPersistentVolumeClaim({
            namespace: plan.target.namespace,
            name: plan.claim.name,
            body: {
              apiVersion: 'v1',
              kind: 'DeleteOptions',
              preconditions: { uid: verified.uid!, resourceVersion: verified.resourceVersion! },
              propagationPolicy: 'Background',
            },
          });
        }
        while (true) {
          await checkpoint(hooks, signal);
          actual = await optional(() =>
            client.core.readNamespacedPersistentVolumeClaim({
              namespace: plan.target.namespace,
              name: plan.claim.name,
            }),
          );
          if (!actual) break;
          verifyClaim(plan, actual);
          await delay(this.limits.pollIntervalMs, undefined, { signal });
        }
      }
      await this.waitForPvAbsence(client, plan, hooks, signal);
      const namespace = await optional(() =>
        client.core.readNamespace({ name: plan.target.namespace }),
      );
      const mounts = namespace
        ? await actualMounts(client, plan, this.limits.maxPods)
        : { mounts: [], truncated: false };
      if (mounts.truncated || mounts.mounts.length)
        fail('STORAGE_VOLUME_MOUNTED', 'PVC 已不存在，但仍有 Pod 引用或挂载扫描不完整。');
      const deleted = receipt(
        plan,
        null,
        'deleted',
        plan.storageClassUid,
        plan.knownBinding ?? null,
        this.now().toISOString(),
      );
      resources.push(deleted);
      await invokeHook(() => hooks.onReceipt(deleted), signal);
      const observation = absentObservation(plan, this.now().toISOString(), 'destroyed');
      return { completedAt: this.now().toISOString(), resources, observation };
    });
  }
  private async waitForPvAbsence(
    client: InspectionClient,
    plan: StorageVolumePlan,
    hooks: StorageWriteHooks,
    signal: AbortSignal,
  ): Promise<void> {
    if (!plan.knownBinding) {
      // Lost DELETE receipts for a never-bound claim still require a complete read of PV claim references.
      const list = await client.core.listPersistentVolume({ limit: 501 });
      if (!Array.isArray(list.items) || list.items.length > 500 || list.metadata?._continue)
        fail('STORAGE_PVS_INCOMPLETE', 'PV 列表不完整，不能确认数据回收已完成。');
      if (
        list.items.some(
          (pv) =>
            pv.spec?.claimRef?.namespace === plan.target.namespace &&
            pv.spec.claimRef.name === plan.claim.name,
        )
      )
        fail(
          'STORAGE_PV_IDENTITY_REQUIRED',
          '仍有 PV 引用该 PVC 名称，缺少已登记的 PV 身份，保留数据并停止销毁。',
        );
      return;
    }
    while (true) {
      await checkpoint(hooks, signal);
      const pv = await optional(() =>
        client.core.readPersistentVolume({ name: plan.knownBinding!.pvName }),
      );
      if (!pv) return;
      if (pv.metadata?.uid !== plan.knownBinding.pvUid || pv.spec?.claimRef?.uid !== plan.claim.uid)
        fail('STORAGE_BINDING_CHANGED', '回收期间 PV 或 claimRef 身份变化，停止观察性销毁。');
      if (
        pv.spec.persistentVolumeReclaimPolicy !== 'Delete' ||
        pv.metadata.annotations?.['pv.kubernetes.io/provisioned-by'] !== localPathProvisioner
      )
        fail(
          'STORAGE_RECLAIM_CHANGED',
          '回收期间 PV 策略或 provisioner 已变化，平台不会删除 PV 或宿主路径。',
        );
      await delay(this.limits.pollIntervalMs, undefined, { signal });
    }
  }
}
