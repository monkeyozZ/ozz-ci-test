import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import {
  ManualDataError,
  MAX_METADATA_BYTES,
  boundedRead,
  contextPath,
  digestJson,
  fail,
  identity,
  privateHandle,
  privateJson,
  publishJson,
  record,
  sameIdentity,
  text,
  uid,
  uuid,
} from './manual-data-core.mjs';
import { ENGINES, engine } from './manual-data-artifact.mjs';
import {
  parseKubeconfig,
  connectionMaterial,
} from '../packages/infrastructure/dist/kubernetes/config.js';
import {
  templateFingerprint,
  workloadFingerprint,
} from '../packages/infrastructure/dist/workload/names.js';

const K = {
  installation: 'ozz.dev/installation-id',
  cluster: 'ozz.dev/cluster-id',
  project: 'ozz.dev/project-id',
  environment: 'ozz.dev/environment-id',
  service: 'ozz.dev/service-id',
  volume: 'ozz.dev/volume-id',
  snapshot: 'ozz.dev/snapshot-id',
  nonce: 'ozz.dev/creation-nonce',
  claims: 'ozz.dev/pvc-uids',
};
function origin(value) {
  text(value, 2048);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('MANUAL_ORIGIN_INVALID', '产品地址必须是明确的 HTTPS origin，或本机 HTTP origin。');
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.pathname !== '' && url.pathname !== '/')
  )
    fail('MANUAL_ORIGIN_INVALID', '产品地址必须是明确的 HTTPS origin，或本机 HTTP origin。');
  return url.origin;
}
/** No redirects, ambient proxy, global TLS configuration, response-body errors or unbounded reads. */
export async function requestJson(
  base,
  path,
  {
    method = 'GET',
    body,
    headers = {},
    agent,
    timeoutMs = 15_000,
    maxBytes = 4 * 1024 * 1024,
    allowMissing = false,
  } = {},
) {
  const url = new URL(path, base);
  if (
    url.origin !== base ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('..') ||
    url.hash
  )
    fail('MANUAL_REQUEST_TARGET', '请求超出固定目标。');
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (bytes && bytes.length > MAX_METADATA_BYTES)
    fail('MANUAL_REQUEST_TOO_LARGE', '请求超过受控大小。');
  return await new Promise((resolve, reject) => {
    let settled = false;
    const stop = (code, message) => {
      if (settled) return;
      settled = true;
      reject(new ManualDataError(code, message));
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method,
        agent,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'ozz-manual-data/1.0.0',
          ...headers,
          ...(bytes
            ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) }
            : {}),
        },
        signal: globalThis.AbortSignal.timeout(timeoutMs),
        maxHeaderSize: 16384,
      },
      (response) => {
        if (response.statusCode === 404 && allowMissing) {
          settled = true;
          response.destroy();
          resolve(null);
          return;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          stop(
            response.statusCode >= 300 && response.statusCode < 400
              ? 'MANUAL_REDIRECT_REJECTED'
              : 'MANUAL_REQUEST_REJECTED',
            '固定目标拒绝请求，或认证/权限已失效。',
          );
          response.destroy();
          request.destroy();
          return;
        }
        if (
          !/^application\/(?:[a-z.+-]*\+)?json(?:;|$)/i.test(
            response.headers['content-type'] ?? '',
          ) ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity') ||
          Number(response.headers['content-length'] ?? 0) > maxBytes
        ) {
          stop('MANUAL_RESPONSE_INVALID', '响应类型、编码或大小不受支持。');
          response.destroy();
          request.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            stop('MANUAL_RESPONSE_TOO_LARGE', '响应超过受控大小；不会使用部分列表。');
            response.destroy();
            request.destroy();
          } else chunks.push(chunk);
        });
        response.on('error', () => stop('MANUAL_CONNECTION_FAILED', '固定目标连接中断。'));
        response.on('aborted', () => stop('MANUAL_CONNECTION_FAILED', '固定目标连接中断。'));
        response.on('end', () => {
          if (settled) return;
          try {
            const buffer = Buffer.concat(chunks),
              raw = buffer.toString('utf8');
            if (!Buffer.from(raw).equals(buffer)) throw new Error();
            const value = JSON.parse(raw);
            settled = true;
            resolve(value);
          } catch {
            stop('MANUAL_RESPONSE_INVALID', '固定目标返回无效 JSON。');
          }
        });
      },
    );
    request.on('error', () =>
      stop('MANUAL_CONNECTION_FAILED', '固定目标连接、证书或超时检查未通过。'),
    );
    request.end(bytes);
  });
}
function list(value, kind, maximum = 1000) {
  const apiVersion = kind === 'VolumeAttachmentList' ? 'storage.k8s.io/v1' : 'v1',
    itemKind = kind.slice(0, -4);
  if (
    value?.kind !== kind ||
    value.apiVersion !== apiVersion ||
    !Array.isArray(value.items) ||
    value.items.length > maximum ||
    value.metadata?.continue ||
    (value.metadata?.remainingItemCount ?? 0) > 0
  )
    fail('MANUAL_LIST_INCOMPLETE', '实际资源列表不完整或超过边界；不能假设卷无人使用。');
  return value.items.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      (item.kind !== undefined && item.kind !== itemKind) ||
      (item.apiVersion !== undefined && item.apiVersion !== apiVersion)
    )
      fail('MANUAL_LIST_INCOMPLETE', 'typed List 内出现显式不匹配的资源类型。');
    return { ...item, kind: item.kind ?? itemKind, apiVersion: item.apiVersion ?? apiVersion };
  });
}
function resource(value, kind, name, namespace, expectedUid) {
  if (
    value?.kind !== kind ||
    value.metadata?.name !== name ||
    (namespace && value.metadata.namespace !== namespace) ||
    !uid(value.metadata?.uid) ||
    (expectedUid && value.metadata.uid !== expectedUid) ||
    value.metadata.deletionTimestamp
  )
    fail('MANUAL_RESOURCE_IDENTITY', 'Kubernetes 对象身份变化、删除中或缺失。');
  return value;
}
function owned(value, expected, serviceId) {
  const labels = value.metadata?.labels;
  if (
    labels?.['app.kubernetes.io/managed-by'] !== 'ozz' ||
    labels?.[K.installation] !== expected.installationId ||
    labels?.[K.cluster] !== expected.clusterId ||
    labels?.[K.environment] !== expected.environmentId ||
    (serviceId && labels?.[K.service] !== serviceId)
  )
    fail('MANUAL_RESOURCE_OWNERSHIP', '对象目标标签与固定数据身份不符。');
}
function fresh(value) {
  return (
    typeof value === 'string' &&
    Date.now() - Date.parse(value) < 90_000 &&
    Date.parse(value) <= Date.now() + 5000
  );
}
function matchingNode(node, affinity) {
  const terms = affinity?.required?.nodeSelectorTerms;
  if (!Array.isArray(terms) || !terms.length || terms.length > 16)
    fail('MANUAL_NODE_AFFINITY', '本地卷缺少受支持的实际节点约束。');
  return terms.some((term) => {
    if (
      !Array.isArray(term.matchExpressions) ||
      !term.matchExpressions.length ||
      term.matchFields?.length
    )
      fail('MANUAL_NODE_AFFINITY', '本地卷节点约束无法完整验证。');
    return term.matchExpressions.every((rule) => {
      if (
        rule.key !== 'kubernetes.io/hostname' ||
        rule.operator !== 'In' ||
        !Array.isArray(rule.values) ||
        rule.values.length !== 1
      )
        fail('MANUAL_NODE_AFFINITY', '首版仅接收 local-path 的唯一 hostname In 约束。');
      return node.metadata?.labels?.[rule.key] === rule.values[0];
    });
  });
}
export function validateProductTarget(
  config,
  volume,
  service,
  database,
  mode,
  { allowOverdue = false } = {},
) {
  const expected = config.expectedIdentity;
  if (
    !sameIdentity(volume?.manualDataIdentity, expected) ||
    volume.id !== expected.volumeId ||
    volume.environment?.id !== expected.environmentId ||
    volume.cluster?.id !== expected.clusterId ||
    volume.namespace !== `ozz-e-${expected.environmentId.replaceAll('-', '')}` ||
    volume.pvc?.name !== `ozz-v-${expected.volumeId.replaceAll('-', '')}` ||
    volume.pvc.uid !== expected.pvcUid ||
    volume.pvc.phase !== 'Bound' ||
    volume.pvc.deleting ||
    volume.desiredState !== 'active' ||
    volume.destroyedAt ||
    volume.activeTask ||
    volume.observation?.stale ||
    volume.observation?.state !== 'ready' ||
    !fresh(volume.observation?.observedAt) ||
    volume.locality !== 'verified' ||
    volume.mounts?.truncated ||
    !volume.pv ||
    !volume.storageClassUid ||
    volume.nodes?.length !== 1 ||
    volume.nodes[0].ready !== true
  )
    fail('MANUAL_VOLUME_NOT_VERIFIED', 'Volume 需要新鲜、完整且身份一致的 Bound/PV/Node 观察。');
  const controller = service?.observation?.controller;
  if (
    service?.id !== config.serviceId ||
    service.environmentId !== expected.environmentId ||
    service.clusterId !== expected.clusterId ||
    service.projectId !== volume.project?.id ||
    !service.published ||
    service.published.deploymentId !== controller?.snapshotId ||
    service.published.configRevision !== controller?.configRevision ||
    service.activeTask ||
    service.hasUnpublishedChanges ||
    service.observationStale ||
    !fresh(service.observation?.observedAt) ||
    service.configurationState !== 'consistent' ||
    service.observation.configurationState !== 'consistent' ||
    service.observation.podsTruncated ||
    controller.deleting ||
    !['Deployment', 'StatefulSet'].includes(controller.kind) ||
    !uid(controller.uid) ||
    !service.observation.resources?.some(
      (row) =>
        row.kind === controller.kind &&
        row.name === `ozz-s-${service.id.replaceAll('-', '')}` &&
        row.expectedUid === controller.uid &&
        row.observedUid === controller.uid &&
        row.state === 'verified',
    )
  )
    fail(
      'MANUAL_SERVICE_NOT_VERIFIED',
      'Service 必须有完整可信的已发布 controller 身份且无并行变更。',
    );
  const mount = volume.mounts.published?.filter(
    (row) =>
      row.serviceId === service.id &&
      row.volumeId === volume.id &&
      row.lastPublishedDeploymentId === service.published.deploymentId,
  );
  if (mount?.length !== 1)
    fail('MANUAL_MOUNT_NOT_PUBLISHED', '指定 Service 未在当前快照挂载这个 Volume。');
  if (mode === 'online' || mode === 'formal') {
    if (
      service.desiredState !== 'running' ||
      service.runtimeState !== 'running' ||
      controller.replicas !== 1 ||
      controller.readyReplicas !== 1 ||
      (volume.maintenance && volume.maintenance.state !== 'closed')
    )
      fail('MANUAL_SERVICE_NOT_RUNNING', '正式 Service 尚未单实例就绪，或仍处于维护。');
  } else {
    const maintenance = volume.maintenance;
    if (
      service.desiredState !== 'stopped' ||
      service.runtimeState !== 'stopped' ||
      controller.replicas !== 0 ||
      !maintenance ||
      maintenance.state !== 'active' ||
      maintenance.purpose !== mode ||
      (!allowOverdue && maintenance.overdue) ||
      maintenance.releasedAt ||
      !Number.isFinite(Date.parse(maintenance.expiresAt)) ||
      (!allowOverdue && Date.parse(maintenance.expiresAt) <= Date.now()) ||
      !uuid(maintenance.id)
    )
      fail(
        'MANUAL_MAINTENANCE_REQUIRED',
        '先停止 Service 并进入有效的对应维护状态；工具不会自动解除维护。',
      );
  }
  if (config.engine === 'files') {
    if (volume.retainedDatabase || service.databaseInstanceId || database)
      fail('MANUAL_DATABASE_TAR_FORBIDDEN', '数据库数据卷不能通过普通文件归档备份或恢复。');
  } else {
    const fixed = engine(config.engine);
    if (
      database?.engine !== config.engine ||
      database.exactVersion !== fixed.version ||
      database.service?.id !== service.id ||
      database.dataVolume?.id !== volume.id ||
      database.dataVolume?.pvcUid !== expected.pvcUid ||
      database.dataVolume?.namespace !== volume.namespace ||
      database.dataVolume?.pvcName !== volume.pvc.name ||
      database.projectId !== service.projectId ||
      database.environmentId !== expected.environmentId ||
      database.clusterId !== expected.clusterId ||
      database.consumersTruncated ||
      controller.kind !== 'StatefulSet' ||
      service.published.image?.deployReference !== fixed.image ||
      !database.protection?.active ||
      database.initialization?.pvcUid !== expected.pvcUid ||
      database.initialization?.state !== 'verified'
    )
      fail('MANUAL_DATABASE_IDENTITY', '固定数据库模板、版本、数据身份或初始化保护不一致。');
    if (
      (mode === 'online' || mode === 'formal') &&
      (!database.databaseReady || database.observationStale)
    )
      fail('MANUAL_DATABASE_NOT_READY', '正式数据库的认证就绪观察尚未通过。');
    if (config.engine === 'redis' && database.connection?.username !== 'default')
      fail('MANUAL_DATABASE_IDENTITY', 'Redis 首版仅支持固定 default ACL 身份。');
  }
  return { controller, mount: mount[0] };
}
export async function readManualContext(file) {
  const value = record(await privateJson(file), [
    'apiOrigin',
    'appOrigin',
    'sessionFile',
    'kubeconfigFile',
    'serviceId',
    'engine',
    'expectedIdentity',
    'probes',
  ]);
  engine(value.engine);
  identity(value.expectedIdentity);
  if (!uuid(value.serviceId)) fail('MANUAL_INPUT_INVALID', 'Service ID 必须为 UUID。');
  return {
    ...value,
    apiOrigin: origin(value.apiOrigin),
    appOrigin: origin(value.appOrigin),
    sessionFile: contextPath(file, value.sessionFile),
    kubeconfigFile: contextPath(file, value.kubeconfigFile),
  };
}
export async function openManualSession(file, { cleanupOnly = false } = {}) {
  const config = await readManualContext(file),
    session = record(await privateJson(config.sessionFile, 16 * 1024), ['cookie']);
  if (
    typeof session.cookie !== 'string' ||
    !/^ozz_session=[A-Za-z0-9_-]{16,512}$/.test(session.cookie)
  )
    fail('MANUAL_SESSION_INVALID', '会话文件只接收受保护的 ozz_session Cookie。');
  const input = await privateHandle(config.kubeconfigFile, 256 * 1024);
  let connection;
  try {
    connection = parseKubeconfig((await boundedRead(input, 256 * 1024)).toString('utf8'));
  } catch {
    fail(
      'MANUAL_KUBECONFIG_INVALID',
      'kubeconfig 必须内嵌可信 CA 与凭证，不使用插件、文件引用、代理或 TLS 跳过。',
    );
  } finally {
    await input.close();
  }
  const material = connectionMaterial(connection),
    agent = new HttpsAgent({
      keepAlive: true,
      maxSockets: 4,
      maxFreeSockets: 1,
      ca: material.ca,
      cert: material.certificate,
      key: material.privateKey,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
  const apiAgent = config.apiOrigin.startsWith('https:')
    ? new HttpsAgent({
        keepAlive: true,
        maxSockets: 4,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      })
    : undefined;
  const api = async (path, options = {}) => {
    const result = await requestJson(config.apiOrigin, `/api${path}`, {
      ...options,
      agent: apiAgent,
      headers: { Cookie: session.cookie, ...options.headers },
    });
    if (!result || !Object.hasOwn(result, 'data'))
      fail('MANUAL_API_INVALID', '产品 API 响应缺少数据封装。');
    return result.data;
  };
  const kube = (path, options = {}) =>
    requestJson(connection.endpoint, path, {
      ...options,
      agent,
      headers: {
        ...options.headers,
        ...(material.token ? { Authorization: `Bearer ${material.token}` } : {}),
      },
    });
  let fixedFence = null,
    fixedPodIdentity = null;
  const authorized = async () => {
    const result = await api('/auth/me');
    if (
      !result?.user ||
      result.restoreMode !== false ||
      typeof result.csrfToken !== 'string' ||
      !Number.isFinite(Date.parse(result.expiresAt)) ||
      Date.parse(result.expiresAt) <= Date.now()
    )
      fail('MANUAL_PLATFORM_LOCKED', '会话已失效或控制面处于恢复锁；不继续远端操作。');
    return result;
  };
  const checkpoint = async (mode, { helper = null, expectedFence = null } = {}) => {
    await authorized();
    const id = config.expectedIdentity;
    const [volume, service, cluster, database] = await Promise.all([
      api(`/volumes/${id.volumeId}`),
      api(`/services/${config.serviceId}`),
      api(`/clusters/${id.clusterId}`),
      config.engine === 'files'
        ? Promise.resolve(null)
        : api(`/services/${config.serviceId}/database`),
    ]);
    const selected = validateProductTarget(config, volume, service, database, mode, {
      allowOverdue: cleanupOnly,
    });
    if (
      cluster?.id !== id.clusterId ||
      cluster.apiEndpoint !== connection.endpoint ||
      cluster.identity?.caFingerprint !== connection.caFingerprint ||
      cluster.identity?.kubeSystemUid !== id.kubeSystemUid
    )
      fail('MANUAL_CLUSTER_IDENTITY', 'kubeconfig 地址、CA 指纹或集群 UID 不匹配产品登记。');
    const namespace = volume.namespace,
      name = `ozz-s-${config.serviceId.replaceAll('-', '')}`;
    const [
      system,
      pvc,
      pv,
      storageClass,
      nodesValue,
      controller,
      podsValue,
      attachmentsValue,
      namespaceObject,
    ] = await Promise.all([
      kube('/api/v1/namespaces/kube-system'),
      kube(`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${volume.pvc.name}`),
      kube(`/api/v1/persistentvolumes/${volume.pv.name}`),
      kube(`/apis/storage.k8s.io/v1/storageclasses/${volume.storageClassName}`),
      kube('/api/v1/nodes?limit=1001'),
      kube(
        `/apis/apps/v1/namespaces/${namespace}/${selected.controller.kind === 'StatefulSet' ? 'statefulsets' : 'deployments'}/${name}`,
      ),
      kube(`/api/v1/namespaces/${namespace}/pods?limit=1001`),
      kube('/apis/storage.k8s.io/v1/volumeattachments?limit=1001'),
      kube(`/api/v1/namespaces/${namespace}`),
    ]);
    resource(system, 'Namespace', 'kube-system', null, id.kubeSystemUid);
    resource(namespaceObject, 'Namespace', namespace, null);
    owned(namespaceObject, id);
    if (
      !service.observation.resources.some(
        (row) =>
          row.kind === 'Namespace' &&
          row.name === namespace &&
          row.expectedUid === namespaceObject.metadata.uid &&
          row.observedUid === row.expectedUid &&
          row.state === 'verified',
      )
    )
      fail('MANUAL_RESOURCE_IDENTITY', 'Namespace UID 不在已验证的发布台账中。');
    resource(pvc, 'PersistentVolumeClaim', volume.pvc.name, namespace, id.pvcUid);
    owned(pvc, id);
    if (
      pvc.metadata.labels?.[K.volume] !== id.volumeId ||
      pvc.metadata.labels?.[K.project] !== service.projectId ||
      pvc.spec?.volumeName !== volume.pv.name ||
      pvc.spec.storageClassName !== volume.storageClassName ||
      pvc.spec.volumeMode !== 'Filesystem' ||
      digestJson(pvc.spec.accessModes) !== digestJson(['ReadWriteOnce']) ||
      pvc.status?.phase !== 'Bound'
    )
      fail('MANUAL_PVC_IDENTITY', 'PVC 规格或绑定发生变化。');
    resource(storageClass, 'StorageClass', volume.storageClassName, null, volume.storageClassUid);
    if (storageClass.provisioner !== 'rancher.io/local-path')
      fail('MANUAL_STORAGE_UNSUPPORTED', '首版手工工具只支持已登记的 local-path 卷。');
    resource(pv, 'PersistentVolume', volume.pv.name, null, volume.pv.uid);
    if (
      pv.spec?.claimRef?.uid !== id.pvcUid ||
      pv.spec.claimRef.name !== volume.pvc.name ||
      pv.spec.claimRef.namespace !== namespace ||
      pv.spec.storageClassName !== volume.storageClassName ||
      pv.metadata.annotations?.['pv.kubernetes.io/provisioned-by'] !== storageClass.provisioner ||
      pv.spec.persistentVolumeReclaimPolicy !== volume.pv.reclaimPolicy ||
      digestJson(pv.spec.nodeAffinity) !== digestJson(volume.pv.nodeAffinity)
    )
      fail('MANUAL_PV_IDENTITY', 'PV 的 claimRef、provisioner、回收策略或节点约束发生变化。');
    const nodes = list(nodesValue, 'NodeList').filter((node) =>
      matchingNode(node, pv.spec.nodeAffinity),
    );
    if (
      nodes.length !== 1 ||
      nodes[0].metadata?.uid !== volume.nodes[0].uid ||
      nodes[0].metadata.name !== volume.nodes[0].name ||
      nodes[0].spec?.unschedulable ||
      nodes[0].metadata.deletionTimestamp ||
      !nodes[0].status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
    )
      fail('MANUAL_NODE_IDENTITY', '实际唯一 Node UID 或 Ready 状态变化，不能确认本地数据位置。');
    if (
      list(attachmentsValue, 'VolumeAttachmentList').some(
        (item) => item.spec?.source?.persistentVolumeName === pv.metadata.name,
      )
    )
      fail('MANUAL_VOLUME_ATTACHED', '卷仍有 VolumeAttachment；不能假设已经卸载。');
    resource(controller, selected.controller.kind, name, namespace, selected.controller.uid);
    owned(controller, id, config.serviceId);
    if (config.engine !== 'files') {
      const secretName = `ozz-r-${service.published.deploymentId.replaceAll('-', '')}`;
      const expectedSecret = service.observation.resources.find(
        (row) =>
          row.kind === 'Secret' &&
          row.name === secretName &&
          row.state === 'verified' &&
          row.expectedUid === row.observedUid &&
          uid(row.expectedUid),
      );
      if (!expectedSecret)
        fail('MANUAL_SECRET_REFERENCE', '当前快照的运行期 Secret UID 未通过台账核验。');
      const secret = await kube(`/api/v1/namespaces/${namespace}/secrets/${secretName}`, {
        headers: { Accept: 'application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1' },
      });
      resource(secret, 'PartialObjectMetadata', secretName, namespace, expectedSecret.expectedUid);
      owned(secret, id, config.serviceId);
      if (secret.metadata.labels?.[K.snapshot] !== service.published.deploymentId)
        fail('MANUAL_SECRET_REFERENCE', '运行期 Secret 快照发生变化。');
    }
    if (
      controller.spec?.replicas !== selected.controller.replicas ||
      templateFingerprint(controller) !== selected.controller.templateFingerprint ||
      workloadFingerprint(controller) !== selected.controller.workloadFingerprint ||
      controller.spec.template.metadata?.labels?.[K.snapshot] !== service.published.deploymentId
    )
      fail('MANUAL_CONTROLLER_DRIFT', 'controller 模板、快照或副本数偏离产品发布。');
    const mounts = list(podsValue, 'PodList').filter((pod) =>
      pod.spec?.volumes?.some((v) => v.persistentVolumeClaim?.claimName === volume.pvc.name),
    );
    let pod = null;
    if (mode === 'online' || mode === 'formal') {
      const observed = service.observation.pods.filter(
        (p) => p.phase === 'Running' && p.ready && !p.deletionTimestamp,
      );
      if (
        observed.length !== 1 ||
        mounts.length !== 1 ||
        mounts[0].metadata?.uid !== observed[0].uid ||
        observed[0].matchesControllerTemplate !== true
      )
        fail('MANUAL_POD_IDENTITY', '必须只有一个已验证且就绪的正式挂载 Pod。');
      pod = mounts[0];
      resource(pod, 'Pod', observed[0].name, namespace, observed[0].uid);
      owned(pod, id, config.serviceId);
      const owners =
        pod.metadata.ownerReferences?.filter((owner) => owner.controller === true) ?? [];
      if (
        owners.length !== 1 ||
        pod.metadata.labels?.[K.snapshot] !== service.published.deploymentId ||
        pod.spec.nodeName !== nodes[0].metadata.name
      )
        fail('MANUAL_POD_IDENTITY', '正式 Pod 的祖先、快照或节点身份不匹配。');
      if (controller.kind === 'Deployment') {
        if (owners[0].kind !== 'ReplicaSet' || owners[0].apiVersion !== 'apps/v1')
          fail('MANUAL_POD_IDENTITY', '普通应用 Pod 缺少真实 ReplicaSet 祖先。');
        const replicaSet = await kube(
          `/apis/apps/v1/namespaces/${namespace}/replicasets/${owners[0].name}`,
        );
        resource(replicaSet, 'ReplicaSet', owners[0].name, namespace, owners[0].uid);
        owned(replicaSet, id, config.serviceId);
        const roots =
          replicaSet.metadata.ownerReferences?.filter((owner) => owner.controller === true) ?? [];
        if (
          roots.length !== 1 ||
          roots[0].kind !== 'Deployment' ||
          roots[0].apiVersion !== 'apps/v1' ||
          roots[0].uid !== controller.metadata.uid ||
          roots[0].name !== name
        )
          fail('MANUAL_POD_IDENTITY', 'ReplicaSet 不属于当前已发布 Deployment。');
      } else if (
        owners[0].kind !== 'StatefulSet' ||
        owners[0].apiVersion !== 'apps/v1' ||
        owners[0].uid !== controller.metadata.uid ||
        owners[0].name !== name
      )
        fail('MANUAL_POD_IDENTITY', 'Pod 不属于当前已发布 StatefulSet。');
      if (
        config.engine !== 'files' &&
        (owners.length !== 1 ||
          owners[0].kind !== 'StatefulSet' ||
          owners[0].uid !== controller.metadata.uid ||
          owners[0].name !== name ||
          pod.metadata.labels?.[K.snapshot] !== service.published.deploymentId ||
          pod.spec.containers?.length !== 1 ||
          pod.spec.containers[0].name !== 'app' ||
          pod.spec.containers[0].image !== engine(config.engine).image ||
          pod.spec.nodeName !== nodes[0].metadata.name)
      )
        fail('MANUAL_POD_IDENTITY', '数据库 Pod 的实际 StatefulSet 祖先、快照或镜像不匹配。');
      const running = pod.status?.containerStatuses?.find((value) => value.name === 'app');
      if (!running?.state?.running || !running.containerID || running.ready !== true)
        fail('MANUAL_POD_IDENTITY', '正式 app 容器尚未确认运行就绪。');
      const runtimeIdentity = {
        podUid: pod.metadata.uid,
        containerId: running.containerID,
        restartCount: running.restartCount,
      };
      if (fixedPodIdentity && digestJson(fixedPodIdentity) !== digestJson(runtimeIdentity))
        fail('MANUAL_EXEC_POD_CHANGED', '本次操作期间正式 Pod 或容器重新创建；保留不完整结果。');
      fixedPodIdentity ??= runtimeIdentity;
    } else if (
      mounts.some(
        (p) => !helper || p.metadata?.uid !== helper.uid || p.metadata.name !== helper.name,
      ) ||
      mounts.length > (helper ? 1 : 0)
    )
      fail('MANUAL_VOLUME_IN_USE', '仍有其他实际 Pod 引用这个 PVC；保持维护，不开始或继续导入。');
    const fence = {
      identity: id,
      namespace,
      pvcName: volume.pvc.name,
      pvName: pv.metadata.name,
      pvUid: pv.metadata.uid,
      storageClassName: storageClass.metadata.name,
      storageClassUid: storageClass.metadata.uid,
      reclaimPolicy: pv.spec.persistentVolumeReclaimPolicy,
      node: {
        name: nodes[0].metadata.name,
        uid: nodes[0].metadata.uid,
        hostname: nodes[0].metadata.labels['kubernetes.io/hostname'],
      },
      serviceId: service.id,
      controller: { kind: controller.kind, name, uid: controller.metadata.uid },
      snapshotId: service.published.deploymentId,
      templateFingerprint: selected.controller.templateFingerprint,
      workloadFingerprint: selected.controller.workloadFingerprint,
      maintenance:
        mode === 'online' || mode === 'formal'
          ? null
          : {
              id: volume.maintenance.id,
              purpose: volume.maintenance.purpose,
              revision: volume.maintenance.revision,
            },
    };
    const expected = expectedFence ?? fixedFence;
    if (expected && digestJson(fence) !== digestJson(expected))
      fail('MANUAL_TARGET_CHANGED', '操作期间固定卷、节点、快照或维护身份发生变化。');
    fixedFence ??= fence;
    return { fence, volume, service, cluster, database, controller, pod, mount: selected.mount };
  };
  return {
    config,
    cleanupOnly,
    connection,
    api,
    kube,
    checkpoint,
    authorized,
    record: async (volumeId, value) => {
      if (volumeId !== value.source.volumeId || !uuid(volumeId))
        fail('MANUAL_RECORD_TARGET', '记录路径必须引用原备份的源 Volume。');
      const auth = await authorized();
      return api(`/volumes/${volumeId}/manual-data-records`, {
        method: 'POST',
        body: value,
        headers: { Origin: config.appOrigin, 'x-csrf-token': auth.csrfToken },
      });
    },
    close: () => {
      agent.destroy();
      apiAgent?.destroy();
    },
  };
}
export function helperName(id) {
  if (!uuid(id)) fail('MANUAL_HELPER_ID', 'helper ID 必须为 UUID。');
  return `ozz-manual-${id.replaceAll('-', '')}`;
}
export function helperManifest(snapshot, kind, operationId, nonce, readOnly = false) {
  engine(kind);
  if (!uuid(nonce)) fail('MANUAL_HELPER_ID', 'helper nonce 必须为 UUID。');
  const db = kind !== 'files',
    secretName = `ozz-r-${snapshot.fence.snapshotId.replaceAll('-', '')}`;
  const original = snapshot.controller.spec.template.spec,
    originalApp = original.containers.find((c) => c.name === 'app');
  if (!originalApp) fail('MANUAL_TEMPLATE_INVALID', '已发布模板缺少 app 容器。');
  const credentialNames =
    kind === 'postgresql'
      ? ['POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD', 'PGDATA']
      : ['REDIS_USERNAME', 'REDIS_PASSWORD'];
  if (db) {
    const secretLedger = snapshot.service.observation.resources.find(
      (r) =>
        r.kind === 'Secret' &&
        r.name === secretName &&
        r.state === 'verified' &&
        r.expectedUid === r.observedUid &&
        r.expectedUid,
    );
    if (
      !secretLedger ||
      (!originalApp.envFrom?.some((e) => e.secretRef?.name === secretName) &&
        !credentialNames.every((name) =>
          originalApp.env?.some(
            (e) =>
              e.name === name &&
              e.valueFrom?.secretKeyRef?.name === secretName &&
              e.valueFrom.secretKeyRef.key === name,
          ),
        ))
    )
      fail('MANUAL_SECRET_REFERENCE', '只允许复用当前已验证的运行期 Secret 引用。');
  }
  const idle =
    kind === 'postgresql'
      ? `trap 'pg_ctl -D /var/lib/postgresql/data/pgdata -m fast -w stop >/dev/null 2>&1 || true; exit 0' TERM INT; while true; do sleep 1 & wait $!; done`
      : kind === 'redis'
        ? `trap 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --raw -e --user "$REDIS_USERNAME" -h 127.0.0.1 SHUTDOWN NOSAVE >/dev/null 2>&1 || true; exit 0' TERM INT; while true; do sleep 1 & wait $!; done`
        : `trap 'exit 0' TERM INT; while true; do sleep 1 & wait $!; done`;
  const dataPath = kind === 'postgresql' ? '/var/lib/postgresql/data' : '/data';
  const volumes = [
    { name: 'data', persistentVolumeClaim: { claimName: snapshot.fence.pvcName, readOnly } },
    { name: 'scratch', emptyDir: { sizeLimit: '1100Mi' } },
  ];
  const mounts = [
    { name: 'data', mountPath: dataPath, readOnly },
    { name: 'scratch', mountPath: '/tmp' },
  ];
  if (kind === 'redis') {
    const secretVolume = original.volumes?.find(
      (v) => v.name === 'ozz-database' && v.secret?.secretName === secretName,
    );
    if (
      !secretVolume ||
      !secretVolume.secret.items?.some((i) => i.key === 'redis-acl' && i.path === 'users.acl')
    )
      fail('MANUAL_SECRET_REFERENCE', 'Redis 模板缺少固定 ACL 文件引用。');
    volumes.push(globalThis.structuredClone(secretVolume));
    mounts.push({ name: 'ozz-database', mountPath: '/run/ozz/database', readOnly: true });
  }
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: helperName(operationId),
      namespace: snapshot.fence.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'ozz-manual-data',
        'ozz.dev/manual-operation-id': operationId,
      },
      annotations: {
        'ozz.dev/manual-nonce': nonce,
        'ozz.dev/manual-target': digestJson(snapshot.fence),
        'ozz.dev/manual-read-only': String(readOnly),
      },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Never',
      terminationGracePeriodSeconds: 60,
      activeDeadlineSeconds: 3600,
      nodeSelector: {
        'kubernetes.io/os': 'linux',
        'kubernetes.io/hostname': snapshot.fence.node.hostname,
      },
      securityContext: db
        ? { runAsUser: 999, runAsGroup: 999, fsGroup: 999, fsGroupChangePolicy: 'OnRootMismatch' }
        : { runAsUser: 0, runAsGroup: 0 },
      volumes,
      containers: [
        {
          name: 'app',
          image: ENGINES[kind].image,
          imagePullPolicy: 'IfNotPresent',
          command: ['bash', '--noprofile', '--norc', '-ceu', idle],
          ...(db
            ? {
                env: credentialNames.map((name) => ({
                  name,
                  valueFrom: { secretKeyRef: { name: secretName, key: name, optional: false } },
                })),
              }
            : {}),
          volumeMounts: mounts,
          resources: {
            requests: { cpu: '25m', memory: '64Mi' },
            limits: { cpu: '500m', memory: kind === 'postgresql' ? '512Mi' : '256Mi' },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: {
              drop: ['ALL'],
              ...(db
                ? {}
                : { add: readOnly ? ['DAC_READ_SEARCH'] : ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'] }),
            },
          },
        },
      ],
    },
  };
}
function containsExpected(actual, expected, path = []) {
  const omittedReadOnly =
    (path.length === 4 &&
      path[0] === 'volumes' &&
      Number.isInteger(path[1]) &&
      path[2] === 'persistentVolumeClaim' &&
      path[3] === 'readOnly') ||
    (path.length === 5 &&
      path[0] === 'containers' &&
      Number.isInteger(path[1]) &&
      path[2] === 'volumeMounts' &&
      Number.isInteger(path[3]) &&
      path[4] === 'readOnly');
  if (actual === undefined && expected === false && omittedReadOnly) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => containsExpected(actual[index], value, [...path, index]))
    );
  if (expected && typeof expected === 'object')
    return (
      actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, value]) =>
        containsExpected(actual[key], value, [...path, key]),
      )
    );
  return actual === expected;
}
export function verifyHelper(pod, receipt) {
  resource(pod, 'Pod', receipt.name, receipt.namespace, receipt.uid ?? undefined);
  const app = pod.spec?.containers?.[0];
  if (
    pod.metadata.annotations?.['ozz.dev/manual-nonce'] !== receipt.nonce ||
    pod.metadata.annotations?.['ozz.dev/manual-target'] !== receipt.targetDigest ||
    pod.metadata.labels?.['ozz.dev/manual-operation-id'] !== receipt.operationId ||
    pod.spec?.containers?.length !== 1 ||
    pod.spec.containers[0].image !== receipt.image ||
    pod.spec.automountServiceAccountToken !== false ||
    pod.metadata.ownerReferences?.length ||
    pod.spec.initContainers?.length ||
    pod.spec.ephemeralContainers?.length ||
    pod.spec.hostNetwork ||
    pod.spec.hostPID ||
    pod.spec.hostIPC ||
    !receipt.expectedSpec ||
    !containsExpected(pod.spec, receipt.expectedSpec) ||
    pod.spec.containers[0].args?.length ||
    pod.spec.containers[0].envFrom?.length ||
    pod.spec.containers[0].securityContext?.privileged === true ||
    ['lifecycle', 'startupProbe', 'livenessProbe', 'readinessProbe', 'workingDir'].some(
      (key) => app?.[key] !== undefined,
    ) ||
    app?.volumeDevices?.length ||
    app?.stdin ||
    app?.stdinOnce ||
    app?.tty ||
    (!receipt.expectedSpec.containers[0].env && app?.env?.length) ||
    app?.volumeMounts?.some(
      (mount) => mount.subPath || mount.subPathExpr || mount.mountPropagation,
    ) ||
    pod.spec.hostAliases?.length ||
    pod.spec.imagePullSecrets?.length
  )
    fail('MANUAL_HELPER_IDENTITY', 'helper 的 nonce、目标、镜像或 UID 不符；不会接管或删除它。');
  return pod;
}
export async function createHelper(
  session,
  snapshot,
  kind,
  operationId,
  directory,
  readOnly = false,
) {
  if (session.cleanupOnly) fail('MANUAL_CLEANUP_ONLY', '清理会话只能正常停止并移除已登记 helper。');
  const nonce = globalThis.crypto.randomUUID(),
    manifest = helperManifest(snapshot, kind, operationId, nonce, readOnly);
  const receipt = {
    formatVersion: 1,
    operationId,
    nonce,
    name: manifest.metadata.name,
    namespace: snapshot.fence.namespace,
    uid: null,
    targetDigest: digestJson(snapshot.fence),
    image: engine(kind).image,
    expectedSpec: manifest.spec,
    engine: kind,
    mode: readOnly ? 'backup' : 'restore',
  };
  await publishJson(resolve(directory, 'helper-intent.json'), {
    ...receipt,
    manifestDigest: digestJson(manifest),
    fence: snapshot.fence,
    createdAt: new Date().toISOString(),
  });
  await session.checkpoint(readOnly ? 'backup' : 'restore');
  const path = `/api/v1/namespaces/${receipt.namespace}/pods/${receipt.name}`;
  if (await session.kube(path, { allowMissing: true }))
    fail('MANUAL_HELPER_EXISTS', 'helper 名称已存在；保留证据并核对，不覆盖它。');
  let pod;
  try {
    pod = await session.kube(`/api/v1/namespaces/${receipt.namespace}/pods`, {
      method: 'POST',
      body: manifest,
    });
  } catch (error) {
    pod = await session.kube(path, { allowMissing: true });
    if (!pod) throw error;
  }
  verifyHelper(pod, receipt);
  receipt.uid = pod.metadata.uid;
  await publishJson(resolve(directory, 'helper-receipt.json'), receipt);
  for (let attempt = 0; attempt < 90; attempt++) {
    pod = verifyHelper(await session.kube(path), receipt);
    if (
      pod.status?.phase === 'Running' &&
      pod.status.containerStatuses?.find((c) => c.name === 'app')?.state?.running
    ) {
      if (pod.spec.nodeName !== snapshot.fence.node.name)
        fail('MANUAL_HELPER_NODE', 'helper 调度到了未确认的节点。');
      await session.checkpoint(readOnly ? 'backup' : 'restore', { helper: receipt });
      return receipt;
    }
    if (['Failed', 'Succeeded'].includes(pod.status?.phase))
      fail('MANUAL_HELPER_NOT_RUNNING', 'helper 已退出；保留维护和诊断。');
    await delay(1000);
  }
  fail('MANUAL_HELPER_TIMEOUT', 'helper 未在受控时间内运行；保持维护。');
}
export async function deleteHelper(session, receipt, mode) {
  await session.checkpoint(mode, { helper: receipt });
  const path = `/api/v1/namespaces/${receipt.namespace}/pods/${receipt.name}`,
    pod = verifyHelper(await session.kube(path), receipt);
  await session.kube(path, {
    method: 'DELETE',
    body: {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      gracePeriodSeconds: 60,
      preconditions: { uid: receipt.uid, resourceVersion: pod.metadata.resourceVersion },
    },
  });
  for (let i = 0; i < 90; i++) {
    const current = await session.kube(path, { allowMissing: true });
    if (!current) {
      await session.checkpoint(mode);
      return;
    }
    if (current.metadata?.uid !== receipt.uid)
      fail('MANUAL_HELPER_IDENTITY', '删除期间 helper 名称被替换；停止。');
    await delay(1000);
  }
  fail('MANUAL_HELPER_STILL_PRESENT', 'helper 尚未消失；不得退出维护或启动正式工作负载。');
}
