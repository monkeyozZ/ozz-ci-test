<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { Info, LoaderCircle, RefreshCw, Download, Activity } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import NetworkStateBadge from './NetworkStateBadge.vue';
import { api } from '@/lib/api';
import { queryClient, invalidateCollection } from '@/lib/query';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import type { Cluster, Operation } from '@/lib/types';
import type { ClusterNetworking, NetworkStatus } from './types';

const props = defineProps<{ cluster: Cluster }>();
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const network = useQuery({
  queryKey: ['cluster-networking', props.cluster.id],
  queryFn: ({ signal }) =>
    api.get<ClusterNetworking>(`/clusters/${props.cluster.id}/networking`, signal),
});
const form = reactive({ revision: 0, subdomain: '', entryText: '', cnameTarget: '' });
const guard = useDirtyForm(form, `集群「${props.cluster.name}」的入口设置`);
const localError = ref<Error | null>(null);
function setForm(value: ClusterNetworking) {
  Object.assign(form, {
    revision: value.revision,
    subdomain: value.subdomain ?? '',
    entryText: value.entryAddresses.join('\n'),
    cnameTarget: value.cnameTarget ?? '',
  });
  guard.markClean();
}
watch(
  network.data,
  (value) => {
    if (value && !guard.dirty.value) setForm(value);
  },
  { immediate: true },
);
const save = useMutation({
  mutationFn: () =>
    api.update<ClusterNetworking>(`/clusters/${props.cluster.id}/networking`, {
      revision: form.revision,
      subdomain: form.subdomain.trim(),
      entryAddresses: [
        ...new Set(
          form.entryText
            .trim()
            .split(/[\s,]+/)
            .filter(Boolean),
        ),
      ],
      cnameTarget: form.cnameTarget.trim() || null,
    }),
  onSuccess: async (value) => {
    setForm(value);
    queryClient.setQueryData(['cluster-networking', props.cluster.id], value);
    await queryClient.invalidateQueries({ queryKey: ['service-networking'] });
    if (active()) ui.toast('集群应用入口已保存，路由与证书结果需要单独检查。');
  },
});
function submit() {
  if (auth.restoreMode || save.isPending.value || !guard.dirty.value) return;
  localError.value = null;
  if (!form.entryText.trim() && !form.cnameTarget.trim()) {
    localError.value = new Error('请至少填写一个 IPv4 / IPv6 地址或 CNAME 目标。');
    return;
  }
  save.mutate();
}
async function reload() {
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '载入最新集群入口？',
      description: '本页尚未保存的集群后缀和入口地址会被替换。',
      confirmText: '载入最新入口',
    }))
  )
    return;
  const result = await network.refetch();
  if (result.data && active()) {
    setForm(result.data);
    localError.value = null;
    save.reset();
  }
}
const operationId = ref('');
const operation = useQuery({
  queryKey: computed(() => ['operation', operationId.value]),
  enabled: computed(() => !!operationId.value),
  queryFn: ({ queryKey, signal }) => api.get<Operation>(`/operations/${queryKey[1]}`, signal),
  refetchInterval: (query) =>
    ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false,
});
const taskActive = computed(() =>
  ['queued', 'running'].includes(operation.data.value?.status ?? ''),
);
const keys = new Map<string, string>();
const task = useMutation({
  mutationFn: (input: {
    action: 'check' | 'install-cert-manager';
    revision: number;
    key: string;
    token: string;
  }) =>
    api.create<Operation>(
      `/clusters/${props.cluster.id}/networking/${input.action}`,
      { revision: input.revision },
      input.key,
    ),
  onSuccess: async (value, input) => {
    queryClient.setQueryData(['operation', value.id], value);
    operationId.value = value.id;
    keys.delete(input.token);
    await invalidateCollection('/operations');
    if (active())
      ui.toast(input.action === 'check' ? '网络能力检查已受理。' : 'cert-manager 安装任务已受理。');
  },
});
watch(
  () => operation.data.value?.status,
  (status) => {
    if (status && !['queued', 'running'].includes(status)) {
      void network.refetch();
      void queryClient.invalidateQueries({ queryKey: ['service-networking'] });
    }
  },
);
const tasksDisabled = computed(
  () =>
    auth.restoreMode ||
    task.isPending.value ||
    taskActive.value ||
    save.isPending.value ||
    guard.dirty.value,
);
async function runTask(action: 'check' | 'install-cert-manager') {
  const current = network.data.value;
  if (!current || tasksDisabled.value) return;
  if (
    action === 'install-cert-manager' &&
    !(await ui.confirm({
      title: `在「${props.cluster.name}」安装 cert-manager？`,
      description:
        '此任务会在该集群安装经过兼容检查的证书管理组件。应用证书的签发结果仍需单独观察。',
      confirmText: '提交安装任务',
    }))
  )
    return;
  if (!active()) return;
  const token = `${action}:${current.revision}`;
  if (!keys.has(token)) keys.set(token, idempotencyKey());
  task.mutate({ action, revision: current.revision, token, key: keys.get(token)! });
}
function capability(state: string): NetworkStatus {
  return ({
    ready: { label: '已就绪', tone: 'good' },
    missing: { label: '未安装或缺失', tone: 'warning' },
    incompatible: { label: '版本不兼容', tone: 'danger' },
    insufficient: { label: '权限不足', tone: 'danger' },
    unknown: { label: '尚未确认', tone: 'neutral' },
  }[state] ?? { label: '尚未确认', tone: 'neutral' }) as NetworkStatus;
}
</script>
<template>
  <QueryState
    :pending="network.isPending.value"
    :error="network.error.value"
    @retry="network.refetch()"
  >
    <template v-if="network.data.value">
      <form data-cluster-entry-form @submit.prevent="submit">
        <fieldset class="stack" :disabled="auth.restoreMode || save.isPending.value || taskActive">
          <div class="form-grid">
            <div class="field">
              <label for="cluster-network-subdomain">稳定子后缀</label>
              <Input
                id="cluster-network-subdomain"
                v-model="form.subdomain"
                required
                maxlength="63"
                placeholder="例如 sg"
                autocomplete="off"
                autocapitalize="off"
                :spellcheck="false"
              />
              <p class="field-hint">分配域名后保持固定，修改集群显示名不会改变它。</p>
            </div>
            <div class="field">
              <label for="cluster-network-suffix">已保存的完整后缀</label>
              <input
                id="cluster-network-suffix"
                class="input mono"
                :value="network.data.value.domainSuffix || '等待平台后缀和集群入口设置'"
                readonly
              />
              <p class="field-hint">显示控制面计算的已保存值。</p>
            </div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="cluster-network-addresses">入口 IPv4 / IPv6</label>
              <textarea
                id="cluster-network-addresses"
                v-model="form.entryText"
                class="input mono"
                rows="4"
                placeholder="每行一个地址"
                spellcheck="false"
              />
              <p class="field-hint">填写应用入口地址。Kubernetes API 地址不代表应用入口。</p>
            </div>
            <div class="field">
              <label for="cluster-network-cname">CNAME 目标</label>
              <Input
                id="cluster-network-cname"
                v-model="form.cnameTarget"
                placeholder="可选的入口主机名"
                autocomplete="off"
                autocapitalize="off"
                :spellcheck="false"
                maxlength="253"
              />
              <p class="field-hint">地址与 CNAME 至少填写一项，不包含协议或路径。</p>
            </div>
          </div>
        </fieldset>
        <MutationError :error="localError || save.error.value" class="mt-5" />
        <div class="form-footer">
          <p class="meta mr-auto" role="status">
            {{
              guard.dirty.value
                ? '有未保存的更改'
                : network.data.value.updatedAt
                  ? `已保存 r${network.data.value.revision} · ${dateTime(network.data.value.updatedAt)}`
                  : '尚未配置此集群入口'
            }}
          </p>
          <Button
            type="button"
            variant="outline"
            :disabled="save.isPending.value || network.isFetching.value"
            @click="reload"
            >载入最新入口</Button
          >
          <Button
            type="submit"
            :disabled="auth.restoreMode || save.isPending.value || taskActive || !guard.dirty.value"
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
              save.isPending.value ? '正在保存…' : '保存集群入口'
            }}</Button
          >
        </div>
      </form>
      <section class="network-capabilities" data-network-capabilities>
        <div class="section-head">
          <div>
            <h3>路由与证书能力</h3>
            <p class="meta mt-1">
              {{
                network.data.value.capabilities
                  ? `观察于 ${dateTime(network.data.value.capabilities.observedAt)}`
                  : '尚未检查目标集群'
              }}
            </p>
          </div>
          <div class="actions">
            <Button variant="outline" :disabled="tasksDisabled" @click="runTask('check')"
              ><RefreshCw />检查网络能力</Button
            >
            <Button
              v-if="network.data.value.capabilities?.certManager === 'missing'"
              :disabled="tasksDisabled"
              @click="runTask('install-cert-manager')"
              ><Download />安装 cert-manager</Button
            >
          </div>
        </div>
        <p v-if="guard.dirty.value" class="meta mb-4">保存或放弃入口更改后，再提交集群检查。</p>
        <div v-if="network.data.value.capabilitiesStale" class="notice notice-warning mb-4">
          <Info aria-hidden="true" />
          <p>保留上次能力观察，当前未能更新。</p>
        </div>
        <dl class="capability-list">
          <div>
            <dt>Traefik Ingress</dt>
            <dd>
              <NetworkStateBadge
                v-bind="capability(network.data.value.capabilities?.ingressClass ?? 'unknown')"
              />
            </dd>
          </div>
          <div>
            <dt>HTTP 重定向组件</dt>
            <dd>
              <NetworkStateBadge
                v-bind="capability(network.data.value.capabilities?.traefikMiddleware ?? 'unknown')"
              />
            </dd>
          </div>
          <div>
            <dt>cert-manager</dt>
            <dd>
              <NetworkStateBadge
                v-bind="capability(network.data.value.capabilities?.certManager ?? 'unknown')"
              />
              <p v-if="network.data.value.capabilities?.certManagerVersion" class="meta mt-2">
                {{ network.data.value.capabilities.certManagerVersion }}
              </p>
            </dd>
          </div>
          <div>
            <dt>管理权限</dt>
            <dd>
              <NetworkStateBadge
                v-bind="capability(network.data.value.capabilities?.permissions ?? 'unknown')"
              />
            </dd>
          </div>
        </dl>
        <ul v-if="network.data.value.capabilities?.issues.length" class="capability-issues">
          <li v-for="issue in network.data.value.capabilities.issues" :key="issue.code">
            <p>{{ issue.message }}</p>
            <p class="meta mono mt-1">{{ issue.code }}</p>
          </li>
        </ul>
        <MutationError :error="task.error.value" class="mt-5" />
        <div v-if="operation.data.value" class="notice mt-5">
          <Activity aria-hidden="true" />
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <strong>集群网络任务</strong><StatusBadge :status="operation.data.value.status" />
            </div>
            <p class="mt-2">受理成功后，继续查看任务结果和能力观察。</p>
            <RouterLink
              :to="`/operations/${operation.data.value.id}`"
              class="text-link inline-block mt-2"
              >查看集群网络任务</RouterLink
            >
          </div>
        </div>
      </section>
    </template>
  </QueryState>
</template>
<style scoped>
.network-capabilities {
  border-top: 1px solid var(--border);
  padding-top: 1.5rem;
  margin-top: 1.75rem;
}
.capability-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}
.capability-list dt {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
  margin-bottom: 0.625rem;
}
.capability-list dd {
  margin: 0;
}
.capability-issues {
  margin: 1.25rem 0 0;
  padding-left: 1.25rem;
  list-style: disc;
}
.capability-issues li + li {
  margin-top: 0.875rem;
}
@media (max-width: 479px) {
  .capability-list {
    grid-template-columns: 1fr;
  }
}
</style>
