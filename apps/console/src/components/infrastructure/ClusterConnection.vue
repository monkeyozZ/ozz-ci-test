<script setup lang="ts">
import { computed, nextTick, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { useRoute } from 'vue-router';
import {
  AlertCircle,
  Check,
  CircleHelp,
  Info,
  KeyRound,
  LoaderCircle,
  PlugZap,
  RefreshCw,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import CredentialContent from './CredentialContent.vue';
import InfrastructureTask from './InfrastructureTask.vue';
import NodeInventory from './NodeInventory.vue';
import ClusterObservationReport from './ClusterObservationReport.vue';
import { credentialExpiryLabel, sampleFreshness } from './format';
import { useObservationClock } from './useObservationClock';
import { api } from '@/lib/api';
import { invalidateCollection, queryClient, useCollection } from '@/lib/query';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import type { Cluster, Operation, SecretReference } from '@/lib/types';
import type { ClusterNode, ConnectionPreview } from './types';

const props = withDefaults(
  defineProps<{ cluster: Cluster; disabled?: boolean; metadataDirty?: boolean }>(),
  { disabled: false, metadataDirty: false },
);
const emit = defineEmits<{ changed: []; busy: [busy: boolean]; editing: [editing: boolean] }>();
const ui = useUiStore();
const route = useRoute();
const auth = useAuthStore();
const isViewActive = useViewScope();
const secrets = useCollection<SecretReference>('/secrets', { kind: 'kubeconfig' });
const nodes = useCollection<ClusterNode>(() => `/clusters/${props.cluster.id}/nodes`);
const currentOperationId = ref<string | null>(props.cluster.lastOperationId);
const observedOperation = shallowRef<Operation | null>(null);
watch(
  () => props.cluster.lastOperationId,
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
const editorOpen = ref(false);
const closeConfirmationPending = ref(false);
type EditorOwner = { session: number; clusterId: string; route: string };
let editorSession = 0;
let editorOwner: EditorOwner | null = null;
function ownsEditor(owner: EditorOwner | null) {
  return (
    owner !== null &&
    isViewActive() &&
    owner.session === editorSession &&
    owner.clusterId === props.cluster.id &&
    owner.route === route.fullPath
  );
}
watch(editorOpen, (value) => emit('editing', value), { immediate: true });
const form = reactive({
  source: 'saved' as 'saved' | 'new',
  credentialRefId: '',
  credentialName: '',
  kubeconfig: '',
  apiEndpoint: '',
  confirmCa: false,
});
const guard = useDirtyForm(() => (editorOpen.value ? form : null), '集群候选连接');
const candidateSecret = shallowRef<SecretReference | null>(null);
type Candidate = {
  clusterId: string;
  revision: number;
  credentialRefId: string;
  preview: ConnectionPreview;
};
const candidate = shallowRef<Candidate | null>(null);
let credentialKey = idempotencyKey();
let connectKey = idempotencyKey();
let clearing = false;
function clearRaw() {
  clearing = true;
  form.kubeconfig = '';
  clearing = false;
}
watch(
  () => form.kubeconfig,
  () => {
    if (clearing) return;
    candidateSecret.value = null;
    candidate.value = null;
    form.confirmCa = false;
    credentialKey = idempotencyKey();
  },
  { flush: 'sync' },
);
watch(
  () => [form.source, form.credentialRefId, form.apiEndpoint],
  () => {
    candidate.value = null;
    form.confirmCa = false;
  },
);
watch(
  () => form.credentialName,
  () => {
    if (!candidateSecret.value) credentialKey = idempotencyKey();
  },
);
const now = useObservationClock();
onScopeDispose(clearRaw);
const preview = useMutation({
  mutationFn: async () => {
    const owner = editorOwner;
    const clusterId = props.cluster.id;
    const revision = props.cluster.revision;
    const apiEndpoint = form.apiEndpoint.trim();
    let credentialRefId = form.credentialRefId;
    if (form.source === 'new') {
      if (candidateSecret.value) credentialRefId = candidateSecret.value.id;
      else {
        const saved = await api.create<SecretReference>(
          '/secrets',
          {
            name: form.credentialName.trim(),
            kind: 'kubeconfig',
            payload: { kubeconfig: form.kubeconfig },
          },
          credentialKey,
        );
        credentialRefId = saved.id;
        clearRaw();
        if (ownsEditor(owner) && editorOpen.value) candidateSecret.value = saved;
        await invalidateCollection('/secrets');
      }
    }
    const result = await api.create<ConnectionPreview>(
      `/clusters/${clusterId}/connection-preview`,
      { revision, credentialRefId, ...(apiEndpoint ? { apiEndpoint } : {}) },
    );
    return { clusterId, revision, credentialRefId, preview: result, owner };
  },
  onSuccess: async (value) => {
    if (!ownsEditor(value.owner) || !editorOpen.value) return;
    candidate.value = value;
    form.confirmCa = false;
    connectKey = idempotencyKey();
    await nextTick();
    if (!ownsEditor(value.owner) || !editorOpen.value || ui.confirmation) return;
    document.getElementById('connection-preview')?.focus();
  },
});
type ConnectSubmission = {
  clusterId: string;
  body: {
    revision: number;
    credentialRefId: string;
    apiEndpoint: string;
    acceptedCaFingerprint?: string;
  };
  key: string;
};
const connect = useMutation({
  mutationFn: (submission: ConnectSubmission) =>
    api.create<Operation>(
      `/clusters/${submission.clusterId}/connect`,
      submission.body,
      submission.key,
    ),
  onSuccess: async (value, submission) => {
    queryClient.setQueryData(['operation', value.id], value);
    if (isViewActive() && submission.clusterId === props.cluster.id) {
      observedOperation.value = value;
      currentOperationId.value = value.id;
      clearEditor();
      emit('changed');
      ui.toast('连接验证任务已受理，验证通过后才会启用候选连接。');
    }
    await invalidateCollection('/operations');
  },
});
let syncKey = idempotencyKey();
const sync = useMutation({
  mutationFn: (input: { clusterId: string; revision: number }) =>
    api.create<Operation>(
      `/clusters/${input.clusterId}/sync`,
      { revision: input.revision },
      syncKey,
    ),
  onSuccess: async (value, input) => {
    syncKey = idempotencyKey();
    queryClient.setQueryData(['operation', value.id], value);
    if (isViewActive() && input.clusterId === props.cluster.id) {
      observedOperation.value = value;
      currentOperationId.value = value.id;
      emit('changed');
      ui.toast('集群同步任务已受理，完成后更新观察记录。');
    }
    await invalidateCollection('/operations');
  },
});
const busy = computed(
  () =>
    preview.isPending.value || connect.isPending.value || sync.isPending.value || taskBusy.value,
);
const locked = computed(
  () => props.disabled || props.metadataDirty || auth.restoreMode || busy.value,
);
watch(busy, (value) => emit('busy', value), { immediate: true });
const current = computed(
  () =>
    props.cluster.connectionStatus === 'connected' &&
    !props.cluster.observationStale &&
    sampleFreshness(props.cluster.lastObservedAt, now.value) === 'fresh',
);
const candidateCurrent = computed(() => candidate.value?.revision === props.cluster.revision);
async function openEditor() {
  if (locked.value || editorOpen.value || !isViewActive()) return;
  const owner = {
    session: ++editorSession,
    clusterId: props.cluster.id,
    route: route.fullPath,
  };
  editorOwner = owner;
  form.source = props.cluster.credentialRefId ? 'saved' : 'new';
  form.credentialRefId = props.cluster.credentialRefId || '';
  form.credentialName = `${props.cluster.name} · Kubernetes`;
  clearRaw();
  form.apiEndpoint = props.cluster.apiEndpoint || '';
  form.confirmCa = false;
  candidateSecret.value = null;
  candidate.value = null;
  credentialKey = idempotencyKey();
  preview.reset();
  connect.reset();
  editorOpen.value = true;
  guard.markClean();
  await nextTick();
  if (!ownsEditor(owner) || !editorOpen.value || ui.confirmation) return;
  document.getElementById('connection-source')?.focus();
}
function previewCandidate() {
  if (
    !ownsEditor(editorOwner) ||
    !editorOpen.value ||
    locked.value ||
    closeConfirmationPending.value
  )
    return;
  preview.mutate();
}
function syncCluster() {
  if (!isViewActive() || locked.value || editorOpen.value) return;
  sync.mutate({ clusterId: props.cluster.id, revision: props.cluster.revision });
}
function clearEditor() {
  editorOpen.value = false;
  clearRaw();
  candidateSecret.value = null;
  candidate.value = null;
  form.confirmCa = false;
  guard.markClean();
}
async function closeEditor() {
  if (busy.value || closeConfirmationPending.value || !editorOpen.value) return;
  const owner = editorOwner;
  closeConfirmationPending.value = true;
  try {
    if (
      guard.dirty.value &&
      !(await ui.confirm({
        title: '关闭候选连接配置？',
        description: '尚未提交的连接设置会被清空。已单独加密保存的凭证仍可在设置中管理。',
        confirmText: '清空输入并关闭',
      }))
    )
      return;
    if (!ownsEditor(owner) || !editorOpen.value || busy.value) return;
    clearEditor();
    await nextTick();
    if (!ownsEditor(owner) || editorOpen.value || locked.value || ui.confirmation) return;
    document.getElementById('open-connection-editor')?.focus();
  } finally {
    closeConfirmationPending.value = false;
  }
}
function connectCandidate() {
  const reviewed = candidate.value;
  if (
    !reviewed ||
    !ownsEditor(editorOwner) ||
    !candidateCurrent.value ||
    locked.value ||
    closeConfirmationPending.value ||
    (reviewed.preview.requiresCaConfirmation && !form.confirmCa)
  )
    return;
  const body = {
    revision: reviewed.revision,
    credentialRefId: reviewed.credentialRefId,
    apiEndpoint: reviewed.preview.apiEndpoint,
    ...(reviewed.preview.requiresCaConfirmation
      ? { acceptedCaFingerprint: reviewed.preview.caFingerprint }
      : {}),
  };
  connect.mutate({ clusterId: reviewed.clusterId, body, key: connectKey });
}
function changeUploadedCredential() {
  candidateSecret.value = null;
  candidate.value = null;
  clearRaw();
  credentialKey = idempotencyKey();
}
function taskObserved(value: Operation) {
  observedOperation.value = value;
}
async function taskSettled() {
  emit('changed');
  await nodes.refetch();
}
function retried(value: Operation) {
  observedOperation.value = value;
  currentOperationId.value = value.id;
  emit('changed');
}
</script>

<template>
  <div class="stack cluster-connection">
    <div v-if="metadataDirty" class="notice" role="status">
      <Info />
      <p>登记资料有未保存的修改。先保存资料，再验证或更新集群连接。</p>
    </div>
    <div v-if="cluster.lastErrorMessage" class="notice notice-warning" role="status">
      <AlertCircle />
      <div class="min-w-0">
        <strong>{{ cluster.lastErrorMessage }}</strong>
        <p class="meta mt-1">
          最近尝试 {{ dateTime(cluster.lastAttemptAt)
          }}<span v-if="cluster.lastErrorCode" class="mono ml-2">{{ cluster.lastErrorCode }}</span>
        </p>
        <p v-if="cluster.lastObservedAt" class="mt-2">
          最近成功观察保留于 {{ dateTime(cluster.lastObservedAt) }}，当前状态以新的连接结果为准。
        </p>
      </div>
    </div>
    <InfrastructureTask
      v-if="currentOperationId"
      :operation-id="currentOperationId"
      title="最近集群任务"
      :disabled="disabled || metadataDirty"
      @observed="taskObserved"
      @settled="taskSettled"
      @retried="retried"
    />
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>集群连接</h2>
          <p class="meta mt-1">已登记项目始终绑定当前 Cluster ID。</p>
        </div>
        <div class="actions">
          <Button
            v-if="cluster.identity && cluster.credentialRefId"
            variant="outline"
            :disabled="locked || editorOpen"
            :aria-busy="sync.isPending.value || undefined"
            @click="syncCluster"
            ><LoaderCircle v-if="sync.isPending.value" class="animate-spin" />
            <RefreshCw v-else />{{
              sync.isPending.value ? '正在受理同步…' : '重新检查与同步'
            }}</Button
          ><Button
            v-if="!editorOpen"
            id="open-connection-editor"
            :variant="cluster.identity ? 'outline' : 'default'"
            :disabled="locked"
            @click="openEditor"
            ><PlugZap />{{ cluster.identity ? '更新连接凭证或地址' : '接入已有集群' }}</Button
          >
        </div>
      </div>
      <div class="actions">
        <StatusBadge
          :status="cluster.connectionStatus"
          :observed-at="cluster.lastObservedAt"
        /><span
          v-if="cluster.observationStale && cluster.lastObservedAt"
          class="badge badge-warning"
          ><CircleHelp />观察已过期</span
        ><span class="meta">最近成功观察 {{ dateTime(cluster.lastObservedAt) }}</span>
      </div>
      <dl class="detail-list mt-4">
        <div>
          <dt>API 地址</dt>
          <dd class="mono">{{ cluster.apiEndpoint || '尚未配置' }}</dd>
        </div>
        <div>
          <dt>集群版本</dt>
          <dd>{{ cluster.observation?.version || '尚未验证' }}</dd>
        </div>
        <div v-if="cluster.observation">
          <dt>
            {{
              cluster.observation.credential.expirationSource === 'token_claim'
                ? 'Token 声明到期'
                : cluster.observation.credential.expirationSource === 'client_certificate'
                  ? '证书到期'
                  : '凭证到期'
            }}
          </dt>
          <dd>
            {{ credentialExpiryLabel(cluster.observation.credential.expiresAt) }}
            <p
              v-if="cluster.observation.credential.expirationSource === 'token_claim'"
              class="meta mt-1"
            >
              时间来自令牌声明，身份以 API 认证为准。
            </p>
          </dd>
        </div>
      </dl>
      <details v-if="cluster.identity" class="connection-details mt-4">
        <summary>查看已固定的集群身份</summary>
        <dl class="detail-list mt-2">
          <div>
            <dt>Cluster ID</dt>
            <dd class="mono">{{ cluster.id }}</dd>
          </div>
          <div>
            <dt>kube-system UID</dt>
            <dd class="mono">{{ cluster.identity.kubeSystemUid }}</dd>
          </div>
          <div>
            <dt>CA 指纹</dt>
            <dd class="mono">{{ cluster.identity.caFingerprint }}</dd>
          </div>
        </dl>
      </details>
      <MutationError class="mt-4" :error="sync.error.value" />
      <form
        v-if="editorOpen"
        class="connection-editor mt-6"
        :aria-busy="preview.isPending.value || connect.isPending.value || undefined"
        @submit.prevent="previewCandidate"
      >
        <h3 class="font-medium mb-4">{{ cluster.identity ? '候选连接配置' : '已有集群接入' }}</h3>
        <p v-if="cluster.identity" class="muted mb-5">
          新连接必须仍指向这个集群。验证成功前，当前地址与凭证引用保持有效。
        </p>
        <fieldset class="stack" :disabled="locked || closeConfirmationPending">
          <div class="form-grid">
            <div class="field">
              <label for="connection-source">凭证来源</label
              ><select id="connection-source" v-model="form.source" class="input">
                <option value="saved">选择已加密保存的凭证</option>
                <option value="new">上传或粘贴新 kubeconfig</option>
              </select>
            </div>
            <div class="field">
              <label for="connection-api">候选 API 地址 <span class="meta">（选填）</span></label
              ><Input
                id="connection-api"
                v-model="form.apiEndpoint"
                type="url"
                pattern="https://.*"
                maxlength="2048"
                placeholder="留空使用 kubeconfig 中的地址"
              />
              <p class="field-hint">该地址须可由控制面访问，并通过 CA 与主机名校验。</p>
            </div>
          </div>
          <div v-if="form.source === 'saved'" class="field">
            <label for="connection-credential">候选 kubeconfig 凭证</label
            ><select
              id="connection-credential"
              v-model="form.credentialRefId"
              class="input"
              required
              :disabled="secrets.isPending.value"
            >
              <option value="">选择一个 kubeconfig 凭证</option>
              <option
                v-if="
                  form.credentialRefId &&
                  !secrets.items.value.some((item) => item.id === form.credentialRefId)
                "
                :value="form.credentialRefId"
              >
                当前引用 · {{ form.credentialRefId }}
              </option>
              <option v-for="secret in secrets.items.value" :key="secret.id" :value="secret.id">
                {{ secret.name }}
              </option>
            </select>
            <p v-if="secrets.error.value" class="field-error">凭证列表没有载入，请重试。</p>
            <div class="actions">
              <Button
                v-if="secrets.error.value"
                type="button"
                variant="ghost"
                @click="secrets.refetch()"
                >重新载入凭证</Button
              ><Button
                v-if="secrets.hasNextPage.value"
                type="button"
                variant="ghost"
                :disabled="secrets.isFetchingNextPage.value"
                @click="secrets.fetchNextPage()"
                >载入更多凭证</Button
              >
            </div>
          </div>
          <template v-else-if="!candidateSecret">
            <div class="field">
              <label for="connection-credential-name">候选凭证名称</label
              ><Input
                id="connection-credential-name"
                v-model="form.credentialName"
                required
                maxlength="120"
                autocomplete="off"
              />
            </div>
            <CredentialContent
              id="connection-kubeconfig"
              v-model="form.kubeconfig"
              kind="kubeconfig"
              :disabled="locked"
            />
          </template>
          <div v-else class="notice">
            <KeyRound />
            <div class="min-w-0">
              <strong>{{ candidateSecret.name }}</strong>
              <p class="mt-1">候选凭证已加密保存。验证成功后，才会用于当前集群。</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="mt-2"
                @click="changeUploadedCredential"
                >换一个 kubeconfig</Button
              >
            </div>
          </div>
          <div class="actions">
            <Button
              type="submit"
              variant="outline"
              :aria-busy="preview.isPending.value || undefined"
              ><LoaderCircle v-if="preview.isPending.value" class="animate-spin" />{{
                preview.isPending.value ? '正在解析配置…' : '预览候选连接'
              }}</Button
            ><Button type="button" variant="ghost" @click="closeEditor">取消并清空输入</Button>
          </div>
        </fieldset>
        <MutationError class="mt-4" :error="preview.error.value ?? connect.error.value" />
        <div v-if="candidate" id="connection-preview" class="connection-preview mt-6" tabindex="-1">
          <h3 class="font-medium flex items-center gap-2"><Check class="size-4" />配置解析结果</h3>
          <p class="meta mt-2">
            以下信息来自已保存的候选配置。还需要执行真实 API 连接与集群身份验证。
          </p>
          <dl class="detail-list mt-4">
            <div>
              <dt>目标 API</dt>
              <dd class="mono">{{ candidate.preview.apiEndpoint }}</dd>
            </div>
            <div>
              <dt>认证方式</dt>
              <dd>
                {{
                  candidate.preview.credential.authentication === 'client_certificate'
                    ? '客户端证书'
                    : 'Token'
                }}
              </dd>
            </div>
            <div>
              <dt>
                {{
                  candidate.preview.credential.expirationSource === 'token_claim'
                    ? 'Token 声明到期'
                    : candidate.preview.credential.expirationSource === 'client_certificate'
                      ? '证书到期'
                      : '凭证到期'
                }}
              </dt>
              <dd>
                {{ credentialExpiryLabel(candidate.preview.credential.expiresAt) }}
              </dd>
            </div>
            <div v-if="candidate.preview.credential.expirationSource === 'token_claim'">
              <dt>到期依据</dt>
              <dd>时间来自 Token 声明；是否可用以 API 认证为准。</dd>
            </div>
            <div v-if="candidate.preview.currentCaFingerprint">
              <dt>当前 CA</dt>
              <dd class="mono">{{ candidate.preview.currentCaFingerprint }}</dd>
            </div>
            <div>
              <dt>候选 CA</dt>
              <dd class="mono">{{ candidate.preview.caFingerprint }}</dd>
            </div>
          </dl>
          <div v-if="candidate.preview.requiresCaConfirmation" class="notice notice-warning mt-4">
            <AlertCircle />
            <p>
              候选 CA 与当前记录不同。请核对这次证书变更的可信来源；连接验证还会核对原集群的
              kube-system UID。
            </p>
          </div>
          <label v-if="candidate.preview.requiresCaConfirmation" class="review-choice mt-4"
            ><input v-model="form.confirmCa" type="checkbox" :disabled="locked" /><span
              >我已核对新的 CA 指纹，确认这是当前集群的证书更新。</span
            ></label
          >
          <p v-if="!candidateCurrent" class="field-error mt-4">
            集群登记已更新，请重新预览候选连接。
          </p>
          <div class="actions mt-5">
            <Button
              type="button"
              :disabled="
                locked ||
                closeConfirmationPending ||
                !candidateCurrent ||
                (candidate.preview.requiresCaConfirmation && !form.confirmCa)
              "
              :aria-busy="connect.isPending.value || undefined"
              @click="connectCandidate"
              ><LoaderCircle v-if="connect.isPending.value" class="animate-spin" />
              <PlugZap v-else />{{
                connect.isPending.value ? '正在受理…' : '开始验证并连接'
              }}</Button
            >
          </div>
        </div>
      </form>
    </section>
    <QueryState
      :pending="nodes.isPending.value"
      :error="nodes.error.value"
      @retry="nodes.refetch()"
    >
      <NodeInventory
        :nodes="nodes.items.value"
        :reachable="current"
        :observed-at="cluster.lastObservedAt"
        :metrics-state="cluster.observation?.metrics.state"
      >
        <template #pagination
          ><Button
            v-if="nodes.hasNextPage.value"
            variant="outline"
            class="mt-4"
            :disabled="nodes.isFetchingNextPage.value"
            @click="nodes.fetchNextPage()"
            >载入更多节点</Button
          ></template
        >
      </NodeInventory>
    </QueryState>
    <ClusterObservationReport
      v-if="cluster.observation"
      :observation="cluster.observation"
      :current="current"
    />
  </div>
</template>

<style scoped>
.cluster-connection {
  min-width: 0;
}
.connection-details {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}
.connection-details summary {
  cursor: pointer;
  padding: 0.5rem 0;
}
.connection-editor {
  border-top: 1px solid var(--border);
  padding-top: 1.5rem;
}
.connection-preview {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 1.25rem;
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
@media (max-width: 639px) {
  .connection-preview {
    padding: 1rem;
  }
}
</style>
