<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { useRoute } from 'vue-router';
import {
  AlertCircle,
  Check,
  Fingerprint,
  Info,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import InfrastructureTask from './InfrastructureTask.vue';
import SshPreflightReport from './SshPreflightReport.vue';
import { api } from '@/lib/api';
import { invalidateCollection, queryClient, useCollection } from '@/lib/query';
import { dateTime, idempotencyKey, slugify } from '@/lib/utils';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import type { Cluster, Operation, Server } from '@/lib/types';
import type { ClusterNode } from './types';

const props = withDefaults(
  defineProps<{ server: Server; disabled?: boolean; metadataDirty?: boolean }>(),
  { disabled: false, metadataDirty: false },
);
const emit = defineEmits<{ changed: []; busy: [busy: boolean] }>();
const auth = useAuthStore();
const ui = useUiStore();
const route = useRoute();
const isViewActive = useViewScope();
const clusters = useCollection<Cluster>('/clusters');
const linkedNodes = useCollection<ClusterNode>(() => `/servers/${props.server.id}/nodes`);
const candidates = computed(() =>
  clusters.items.value.filter(
    (cluster) =>
      cluster.connectionStatus === 'unverified' &&
      !cluster.identity &&
      !cluster.credentialRefId &&
      cluster.projectCount === 0,
  ),
);
const linkedClusters = computed(() => [
  ...new Map(
    linkedNodes.items.value
      .filter((node) => node.present && node.cluster)
      .map((node) => [node.clusterId, node.cluster!]),
  ).values(),
]);
const currentOperationId = ref<string | null>(props.server.lastOperationId);
const observedOperation = shallowRef<Operation | null>(null);
watch(
  () => props.server.lastOperationId,
  (id) => {
    if (id) currentOperationId.value = id;
  },
);
const taskBusy = computed(
  () =>
    !!currentOperationId.value &&
    (observedOperation.value?.id !== currentOperationId.value ||
      ['queued', 'running'].includes(observedOperation.value.status)),
);
const keys = new Map<string, string>();
type Submission = {
  action: 'discover-host-key' | 'preflight' | 'initialize';
  serverId: string;
  body: Record<string, unknown>;
  key: string;
};
const run = useMutation({
  mutationFn: (submission: Submission) =>
    api.create<Operation>(
      `/servers/${submission.serverId}/${submission.action}`,
      submission.body,
      submission.key,
    ),
  onSuccess: async (value, submission) => {
    keys.delete(`${submission.action}:${JSON.stringify(submission.body)}`);
    queryClient.setQueryData(['operation', value.id], value);
    if (isViewActive() && submission.serverId === props.server.id) {
      observedOperation.value = value;
      currentOperationId.value = value.id;
      if (submission.action === 'initialize') initGuard.markClean();
      emit('changed');
      ui.toast('任务已受理，执行进度会保留在当前服务器。');
    }
    await invalidateCollection('/operations');
  },
});
const pendingAction = computed(() =>
  run.isPending.value && run.variables.value?.serverId === props.server.id
    ? run.variables.value.action
    : null,
);
function submit(action: Submission['action'], body: Record<string, unknown>) {
  if (
    !isViewActive() ||
    locked.value ||
    createCluster.isPending.value ||
    (action !== 'discover-host-key' && !preflightAllowed.value)
  )
    return;
  const mapKey = `${action}:${JSON.stringify(body)}`;
  if (!keys.has(mapKey)) keys.set(mapKey, idempotencyKey());
  run.mutate({ action, body, serverId: props.server.id, key: keys.get(mapKey)! });
}
const trustForm = reactive({ source: '', confirmed: false });
const trustGuard = useDirtyForm(trustForm, '主机指纹确认');
watch(
  () => props.server.hostKey.discoveryOperationId,
  () => {
    trustForm.confirmed = false;
  },
);
const mismatch = computed(
  () =>
    !!props.server.hostKey.trustedFingerprint &&
    !!props.server.hostKey.observedFingerprint &&
    props.server.hostKey.trustedFingerprint !== props.server.hostKey.observedFingerprint,
);
const needsTrust = computed(
  () =>
    !!props.server.hostKey.observedFingerprint &&
    (!props.server.hostKey.trustedFingerprint || mismatch.value),
);
const trust = useMutation({
  mutationFn: (body: {
    revision: number;
    discoveryOperationId: string;
    fingerprint: string;
    source: string;
  }) => api.create<Server>(`/servers/${props.server.id}/trust-host-key`, body),
  onSuccess: async (value) => {
    queryClient.setQueryData(['server', value.id], value);
    if (isViewActive() && value.id === props.server.id) {
      trustForm.source = '';
      trustForm.confirmed = false;
      trustGuard.markClean();
    }
    await invalidateCollection('/servers');
    if (!isViewActive() || value.id !== props.server.id) return;
    emit('changed');
    ui.toast('已保存核对来源与可信主机指纹，可以执行只读预检。');
  },
});
function trustFingerprint() {
  const key = props.server.hostKey;
  if (
    !isViewActive() ||
    locked.value ||
    createCluster.isPending.value ||
    !key.discoveryOperationId ||
    !key.observedFingerprint ||
    !trustForm.confirmed ||
    !trustForm.source.trim()
  )
    return;
  trust.mutate({
    revision: props.server.revision,
    discoveryOperationId: key.discoveryOperationId,
    fingerprint: key.observedFingerprint,
    source: trustForm.source.trim(),
  });
}
const locked = computed(
  () =>
    props.disabled ||
    props.metadataDirty ||
    auth.restoreMode ||
    run.isPending.value ||
    trust.isPending.value ||
    taskBusy.value,
);
const preflightAllowed = computed(
  () =>
    !locked.value &&
    !!props.server.credentialRefId &&
    !!props.server.hostKey.trustedFingerprint &&
    !mismatch.value,
);
const report = computed(() => props.server.preflight);
const initForm = reactive({
  clusterId: '',
  nodeName: slugify(props.server.name) || 'app-node',
  apiEndpoint: '',
  reviewed: false,
});
const initGuard = useDirtyForm(initForm, 'K3s 初始化配置');
watch(
  () => [
    initForm.clusterId,
    initForm.nodeName,
    initForm.apiEndpoint,
    props.server.hostKey.trustedFingerprint,
    props.server.machineId,
  ],
  () => {
    initForm.reviewed = false;
  },
);
const initializable = computed(
  () =>
    !linkedNodes.isPending.value &&
    !linkedNodes.error.value &&
    !!report.value &&
    !report.value.k3s.installed &&
    report.value.blockers.length === 0 &&
    !!props.server.machineId &&
    linkedClusters.value.length === 0,
);
const selectedCluster = computed(() =>
  candidates.value.find((cluster) => cluster.id === initForm.clusterId),
);
async function initialize() {
  if (
    !initializable.value ||
    !selectedCluster.value ||
    !initForm.reviewed ||
    !preflightAllowed.value
  )
    return;
  const selected = selectedCluster.value;
  const serverId = props.server.id;
  const body = {
    revision: props.server.revision,
    clusterId: selected.id,
    nodeName: initForm.nodeName.trim(),
    apiEndpoint: initForm.apiEndpoint.trim(),
  };
  if (
    await ui.confirm({
      title: `在「${props.server.name}」初始化 K3s？`,
      description: `将通过 ${props.server.sshUser}@${props.server.host}:${props.server.sshPort} 安装 K3s ${props.server.initializationVersion}，并连接到集群登记「${selected.name}」。API 地址为 ${body.apiEndpoint}。取消会停止等待或执行，并保留已发生的远端变更。`,
      confirmText: '确认并开始初始化',
    })
  ) {
    if (isViewActive() && props.server.id === serverId) submit('initialize', body);
  }
}
const createOpen = ref(false);
const clusterConfirmationPending = ref(false);
const clusterDraft = reactive({ name: '', slug: '' });
const clusterDraftGuard = useDirtyForm(
  () => (createOpen.value ? clusterDraft : null),
  '新集群登记',
);
let clusterKey = idempotencyKey();
type ClusterFormOwner = { session: number; serverId: string; route: string };
let clusterFormSession = 0;
let clusterFormOwner: ClusterFormOwner | null = null;
let pendingClusterFocus: ClusterFormOwner | null = null;
function ownsClusterForm(owner: ClusterFormOwner | null) {
  return (
    owner !== null &&
    isViewActive() &&
    clusterFormSession === owner.session &&
    props.server.id === owner.serverId &&
    route.fullPath === owner.route
  );
}
const createCluster = useMutation({
  mutationFn: () =>
    api.create<Cluster>(
      '/clusters',
      { name: clusterDraft.name, slug: clusterDraft.slug, region: props.server.region },
      clusterKey,
    ),
  onSuccess: async (value) => {
    const owner = clusterFormOwner;
    await invalidateCollection('/clusters');
    if (!ownsClusterForm(owner)) return;
    createOpen.value = false;
    clusterDraft.name = '';
    clusterDraft.slug = '';
    clusterDraftGuard.markClean();
    initForm.clusterId = value.id;
    ui.toast('集群登记已保存，初始化会使用这个唯一目标。');
    pendingClusterFocus = owner;
  },
});
watch(
  () =>
    run.isPending.value || trust.isPending.value || createCluster.isPending.value || taskBusy.value,
  (value) => emit('busy', value),
  { immediate: true },
);
watch(
  () => createCluster.isPending.value,
  async (pending) => {
    if (pending || !pendingClusterFocus) return;
    const owner = pendingClusterFocus;
    pendingClusterFocus = null;
    await nextTick();
    if (!ownsClusterForm(owner) || createOpen.value || locked.value || ui.confirmation) return;
    document.getElementById('initialize-cluster')?.focus();
  },
);
async function openClusterForm() {
  if (locked.value || createCluster.isPending.value || createOpen.value || !isViewActive()) return;
  const owner = {
    session: ++clusterFormSession,
    serverId: props.server.id,
    route: route.fullPath,
  };
  clusterFormOwner = owner;
  pendingClusterFocus = null;
  createOpen.value = true;
  clusterKey = idempotencyKey();
  createCluster.reset();
  clusterDraftGuard.markClean();
  await nextTick();
  if (!ownsClusterForm(owner) || !createOpen.value || ui.confirmation) return;
  document.getElementById('initialize-cluster-name')?.focus();
}
function saveCluster() {
  if (
    !createOpen.value ||
    !ownsClusterForm(clusterFormOwner) ||
    locked.value ||
    createCluster.isPending.value ||
    clusterConfirmationPending.value
  )
    return;
  createCluster.mutate();
}
async function closeClusterForm() {
  if (createCluster.isPending.value || clusterConfirmationPending.value || !createOpen.value)
    return;
  const owner = clusterFormOwner;
  clusterConfirmationPending.value = true;
  try {
    if (
      clusterDraftGuard.dirty.value &&
      !(await ui.confirm({
        title: '放弃新集群资料？',
        description: '尚未保存的名称和标识会被清空。',
        confirmText: '清空并关闭',
      }))
    )
      return;
    if (!ownsClusterForm(owner) || !createOpen.value || createCluster.isPending.value) return;
    createOpen.value = false;
    clusterDraft.name = '';
    clusterDraft.slug = '';
    clusterDraftGuard.markClean();
    await nextTick();
    if (!ownsClusterForm(owner) || createOpen.value || locked.value || ui.confirmation) return;
    document.getElementById('open-cluster-form')?.focus();
  } finally {
    clusterConfirmationPending.value = false;
  }
}
function taskObserved(value: Operation) {
  observedOperation.value = value;
}
async function taskSettled() {
  emit('changed');
  await Promise.all([linkedNodes.refetch(), invalidateCollection('/clusters')]);
}
function retried(value: Operation) {
  observedOperation.value = value;
  currentOperationId.value = value.id;
  emit('changed');
}
</script>

<template>
  <div class="stack server-onboarding">
    <div v-if="metadataDirty" class="notice" role="status">
      <Info />
      <p>连接资料有未保存的修改。先保存服务器登记，再对这份资料执行指纹核对或预检。</p>
    </div>
    <div v-if="server.lastErrorMessage" class="notice notice-warning" role="status">
      <AlertCircle />
      <div class="min-w-0">
        <strong>{{ server.lastErrorMessage }}</strong>
        <p class="meta mt-1">
          最近尝试 {{ dateTime(server.lastAttemptAt)
          }}<span v-if="server.lastErrorCode" class="mono ml-2">{{ server.lastErrorCode }}</span>
        </p>
      </div>
    </div>
    <MutationError :error="run.error.value ?? trust.error.value" />
    <InfrastructureTask
      v-if="currentOperationId"
      :operation-id="currentOperationId"
      title="最近接入任务"
      :disabled="disabled || metadataDirty"
      @observed="taskObserved"
      @settled="taskSettled"
      @retried="retried"
    />
    <section class="panel">
      <div class="section-head">
        <h2 class="flex items-center gap-2"><Fingerprint class="size-5" />1. 核对 SSH 主机身份</h2>
        <Button
          variant="outline"
          :disabled="locked || createCluster.isPending.value"
          :aria-busy="pendingAction === 'discover-host-key' || undefined"
          @click="submit('discover-host-key', { revision: server.revision })"
          ><LoaderCircle v-if="pendingAction === 'discover-host-key'" class="animate-spin" />
          <RefreshCw v-else />{{
            pendingAction === 'discover-host-key'
              ? '正在受理指纹读取…'
              : server.hostKey.observedFingerprint
                ? '重新读取指纹'
                : '读取主机指纹'
          }}</Button
        >
      </div>
      <p class="muted">
        从 {{ server.host }}:{{ server.sshPort }} 读取主机公钥。请通过云厂商的串口 / VNC
        控制台或可信安装记录核对后再信任。
      </p>
      <dl v-if="server.hostKey.trustedFingerprint" class="detail-list mt-4">
        <div>
          <dt>可信指纹</dt>
          <dd class="mono">{{ server.hostKey.trustedFingerprint }}</dd>
        </div>
        <div>
          <dt>核对来源</dt>
          <dd>{{ server.hostKey.trustSource || '尚无来源记录' }}</dd>
        </div>
        <div>
          <dt>确认时间</dt>
          <dd>{{ dateTime(server.hostKey.trustedAt) }}</dd>
        </div>
      </dl>
      <div v-if="server.hostKey.observedFingerprint" class="observed-key mt-5">
        <div class="actions">
          <span class="meta">本次读取</span
          ><span class="badge">{{ server.hostKey.observedAlgorithm }}</span
          ><time class="meta" :datetime="server.hostKey.observedAt || undefined">{{
            dateTime(server.hostKey.observedAt)
          }}</time>
        </div>
        <p class="mono break-all mt-3">{{ server.hostKey.observedFingerprint }}</p>
      </div>
      <div v-if="mismatch" class="notice notice-danger mt-5" role="alert">
        <AlertCircle />
        <p>本次指纹与可信记录不同。预检与初始化已暂停；核实主机身份后，才能明确替换可信记录。</p>
      </div>
      <form
        v-if="needsTrust"
        class="mt-5"
        :aria-busy="trust.isPending.value || undefined"
        @submit.prevent="trustFingerprint"
      >
        <fieldset class="stack" :disabled="locked || createCluster.isPending.value">
          <div class="field">
            <label for="host-key-source">独立核对来源</label
            ><Textarea
              id="host-key-source"
              v-model="trustForm.source"
              required
              minlength="4"
              maxlength="500"
              rows="2"
              placeholder="例如：通过服务商串口控制台查看该主机的 SSH 公钥指纹"
            />
            <p class="field-hint">填写实际使用的核对方式。当前网络读取本身不能作为独立可信来源。</p>
          </div>
          <label class="review-choice"
            ><input v-model="trustForm.confirmed" type="checkbox" required /><span
              >我已与上述可信来源逐字核对，确认主机指纹一致。</span
            ></label
          >
          <div class="actions">
            <Button
              type="submit"
              :disabled="!trustForm.confirmed || !trustForm.source.trim()"
              :aria-busy="trust.isPending.value || undefined"
              ><LoaderCircle v-if="trust.isPending.value" class="animate-spin" />
              <ShieldCheck v-else />{{
                trust.isPending.value
                  ? '正在保存可信指纹…'
                  : mismatch
                    ? '确认并替换可信指纹'
                    : '确认并保存可信指纹'
              }}</Button
            >
          </div>
        </fieldset>
      </form>
      <p
        v-else-if="server.hostKey.trustedFingerprint && !mismatch"
        class="mt-4 flex items-center gap-2 text-sm"
      >
        <Check class="size-4 text-success" />后续 SSH 操作会核对这个可信指纹。
      </p>
    </section>
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>2. 只读预检</h2>
          <p class="meta mt-1">检查系统、资源、权限、端口及已有安装。</p>
        </div>
        <Button
          variant="outline"
          :disabled="!preflightAllowed || createCluster.isPending.value"
          :aria-busy="pendingAction === 'preflight' || undefined"
          @click="submit('preflight', { revision: server.revision })"
          ><LoaderCircle v-if="pendingAction === 'preflight'" class="animate-spin" />
          <RefreshCw v-else />{{
            pendingAction === 'preflight'
              ? '正在受理预检…'
              : report
                ? '重新执行预检'
                : '执行只读预检'
          }}</Button
        >
      </div>
      <p v-if="!server.credentialRefId" class="muted mb-4">
        先在下方服务器资料中保存 SSH 凭证引用。
      </p>
      <p v-else-if="!server.hostKey.trustedFingerprint" class="muted mb-4">
        保存可信主机指纹后，即可开始预检。
      </p>
      <SshPreflightReport v-if="report" :report="report" />
      <p v-else class="muted">尚无预检报告，主机资源与现有软件状态未知。</p>
    </section>
    <section class="panel">
      <div class="section-head">
        <h2 class="flex items-center gap-2"><Layers3 class="size-5" />3. 连接项目的承载集群</h2>
      </div>
      <QueryState
        :pending="linkedNodes.isPending.value"
        :error="linkedNodes.error.value"
        @retry="linkedNodes.refetch()"
      >
        <div v-if="linkedClusters.length" class="space-y-4">
          <p class="muted">已通过机器身份关联到以下集群。创建项目时选择对应集群即可。</p>
          <RouterLink
            v-for="cluster in linkedClusters"
            :key="cluster.id"
            :to="`/clusters/${cluster.id}`"
            class="cluster-association"
            ><Layers3 class="size-5" /><span class="min-w-0"
              ><strong>{{ cluster.name }}</strong
              ><span class="meta mono block mt-1">{{ cluster.slug }}</span></span
            ><span class="text-link ml-auto">查看集群</span></RouterLink
          >
        </div>
        <div v-else-if="report?.k3s.installed" class="stack">
          <div class="notice">
            <Info />
            <p>
              检测到已有 {{ report.k3s.version || 'K3s' }}，请用 kubeconfig
              接入已有集群。初始化不会覆盖这台主机上的现有安装。
            </p>
          </div>
          <Button as-child variant="outline"
            ><RouterLink to="/clusters/new"><Layers3 />登记并接入已有集群</RouterLink></Button
          >
        </div>
        <template v-else>
          <p v-if="!initializable" class="muted">
            新主机通过预检后，可以在此确认 K3s 初始化。若已拥有集群，也可以直接<RouterLink
              to="/clusters/new"
              class="text-link"
              >登记并接入已有集群</RouterLink
            >。
          </p>
          <template v-else>
            <p class="muted mb-5">
              初始化将安装 K3s {{ server.initializationVersion }} 并启用 Secret
              静态加密。先选择一个未连接、无项目的集群登记，任务与后续项目都使用这个唯一目标。
            </p>
            <QueryState
              :pending="clusters.isPending.value"
              :error="clusters.error.value"
              @retry="clusters.refetch()"
            >
              <div class="actions mb-5">
                <Button
                  v-if="!createOpen"
                  id="open-cluster-form"
                  variant="outline"
                  :disabled="locked || createCluster.isPending.value"
                  @click="openClusterForm"
                  ><Plus />先登记一个集群</Button
                ><Button
                  v-if="clusters.hasNextPage.value"
                  variant="ghost"
                  :disabled="clusters.isFetchingNextPage.value"
                  @click="clusters.fetchNextPage()"
                  >载入更多集群</Button
                >
              </div>
              <form
                v-if="createOpen"
                class="inline-cluster-form mb-5"
                :aria-busy="createCluster.isPending.value || undefined"
                @submit.prevent="saveCluster"
              >
                <h3 class="font-medium mb-4">新集群登记</h3>
                <fieldset
                  class="form-grid"
                  :disabled="locked || createCluster.isPending.value || clusterConfirmationPending"
                >
                  <div class="field">
                    <label for="initialize-cluster-name">集群名称</label
                    ><Input
                      id="initialize-cluster-name"
                      v-model="clusterDraft.name"
                      required
                      maxlength="120"
                    />
                  </div>
                  <div class="field">
                    <label for="initialize-cluster-slug">集群标识</label
                    ><Input
                      id="initialize-cluster-slug"
                      v-model="clusterDraft.slug"
                      required
                      maxlength="63"
                      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                      placeholder="sg-apps"
                    />
                  </div>
                </fieldset>
                <MutationError class="mt-4" :error="createCluster.error.value" />
                <div class="actions mt-4">
                  <Button
                    type="submit"
                    :disabled="
                      locked || createCluster.isPending.value || clusterConfirmationPending
                    "
                    :aria-busy="createCluster.isPending.value || undefined"
                    ><LoaderCircle v-if="createCluster.isPending.value" class="animate-spin" />{{
                      createCluster.isPending.value ? '正在保存集群登记…' : '保存集群登记'
                    }}</Button
                  ><Button
                    type="button"
                    variant="ghost"
                    :disabled="createCluster.isPending.value || clusterConfirmationPending"
                    @click="closeClusterForm"
                    >取消</Button
                  >
                </div>
              </form>
              <form @submit.prevent="initialize">
                <fieldset
                  class="stack"
                  :disabled="locked || createCluster.isPending.value || createOpen"
                >
                  <div class="field">
                    <label for="initialize-cluster">初始化目标集群</label
                    ><select
                      id="initialize-cluster"
                      v-model="initForm.clusterId"
                      class="input"
                      required
                    >
                      <option value="">选择未连接且无项目的集群</option>
                      <option v-for="cluster in candidates" :key="cluster.id" :value="cluster.id">
                        {{ cluster.name }} · {{ cluster.slug }}
                      </option>
                    </select>
                  </div>
                  <div class="form-grid">
                    <div class="field">
                      <label for="initialize-node">节点名称</label
                      ><Input
                        id="initialize-node"
                        v-model="initForm.nodeName"
                        required
                        maxlength="63"
                        pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                      />
                    </div>
                    <div class="field">
                      <label for="initialize-api">初始化后的 API 地址</label
                      ><Input
                        id="initialize-api"
                        v-model="initForm.apiEndpoint"
                        type="url"
                        pattern="https://.*"
                        required
                        maxlength="2048"
                        placeholder="https://app.example.com:6443"
                      />
                      <p class="field-hint">
                        填写控制面可以访问的 HTTPS 地址，将用于证书主机名验证与后续连接。
                      </p>
                    </div>
                  </div>
                  <label class="review-choice"
                    ><input v-model="initForm.reviewed" type="checkbox" required /><span
                      >已核对 {{ server.host }} 的预检、可信指纹与目标集群，确认允许在这台主机安装
                      K3s。</span
                    ></label
                  >
                  <div class="actions">
                    <Button
                      type="submit"
                      :disabled="!selectedCluster || !initForm.reviewed || !preflightAllowed"
                      :aria-busy="pendingAction === 'initialize' || undefined"
                      ><LoaderCircle v-if="pendingAction === 'initialize'" class="animate-spin" />{{
                        pendingAction === 'initialize' ? '正在受理初始化…' : '确认初始化配置'
                      }}</Button
                    >
                  </div>
                </fieldset>
              </form>
            </QueryState>
          </template>
        </template>
        <Button
          v-if="linkedNodes.hasNextPage.value"
          variant="ghost"
          class="mt-4"
          :disabled="linkedNodes.isFetchingNextPage.value"
          @click="linkedNodes.fetchNextPage()"
          >载入更多节点关联</Button
        >
      </QueryState>
    </section>
  </div>
</template>

<style scoped>
.server-onboarding {
  min-width: 0;
}
.observed-key {
  padding: 1rem;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.review-choice {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  cursor: pointer;
  line-height: 1.6;
}
.review-choice input {
  accent-color: var(--primary);
  margin-top: 0.25rem;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}
.cluster-association {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 0;
  border-top: 1px solid var(--border);
}
.inline-cluster-form {
  border-block: 1px solid var(--border);
  padding-block: 1.25rem;
}
@media (max-width: 639px) {
  .cluster-association {
    flex-wrap: wrap;
  }
}
</style>
