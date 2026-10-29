<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import {
  ChevronRight,
  RefreshCw,
  Clock3,
  CheckCircle2,
  Circle,
  RotateCcw,
  Square,
  Info,
  AlertCircle,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import {
  operationLabel,
  serviceOperationInput,
  domainOperationInput,
  clusterNetworkingOperationInput,
  volumeOperationInput,
} from '@/components/infrastructure/operation-presentation';
import { serviceLocation } from '@/components/services/presentation';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import NetworkOperationContext from '@/components/networking/NetworkOperationContext.vue';
import { invalidateNetworking } from '@/components/networking/queries';
import VolumeOperationContext from '@/components/storage/VolumeOperationContext.vue';
import IntegrationOperationContext from '@/components/git/IntegrationOperationContext.vue';
import StorageMutationError from '@/components/storage/StorageMutationError.vue';
import { invalidateStorage } from '@/components/storage/queries';
import type { Service } from '@/components/services/types';
import { api, request } from '@/lib/api';
import { queryClient, invalidateCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { dateTime, idempotencyKey } from '@/lib/utils';
import type { Operation, OperationLogPage, OperationLog } from '@/lib/types';
const isViewActive = useViewScope();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ui = useUiStore();
const operationId = String(route.params.operationId);
const operation = useQuery({
  queryKey: ['operation', operationId],
  queryFn: ({ signal }) => api.get<Operation>(`/operations/${operationId}`, signal),
  refetchInterval: (query) =>
    ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false,
});
const active = computed(() => ['queued', 'running'].includes(operation.data.value?.status ?? ''));
const diagnostic = computed(() => operation.data.value?.kind === 'diagnostic');
const serviceInput = computed(() => serviceOperationInput(operation.data.value));
const domainInput = computed(() => domainOperationInput(operation.data.value));
const clusterNetworkInput = computed(() => clusterNetworkingOperationInput(operation.data.value));
const volumeInput = computed(() => volumeOperationInput(operation.data.value));
const volumeResult = computed(() => {
  const result = operation.data.value?.result;
  return volumeInput.value && result && 'volumeId' in result && 'state' in result ? result : null;
});
const currentServiceId = computed(() => operation.data.value?.serviceId ?? '');
const currentService = useQuery({
  queryKey: computed(() => ['service', currentServiceId.value]),
  enabled: computed(() => !!serviceInput.value && !!currentServiceId.value),
  queryFn: ({ queryKey, signal }) => api.get<Service>(`/services/${queryKey[1]}`, signal),
});
const serviceResult = computed(() => {
  const value = operation.data.value?.result;
  return serviceInput.value &&
    value &&
    'action' in value &&
    ('resources' in value || 'remoteEffects' in value)
    ? value
    : null;
});
const serviceResultLabels: Record<string, string> = {
  stop: '停止操作已记录，配置、数据卷和部署历史保留。',
  resume: '已按原已发布配置恢复运行，未应用配置草稿。',
  restart: '已重启原已发布配置，未应用配置草稿。',
  delete: '服务删除操作已记录，数据卷、数据库凭证、部署和任务历史保留。',
};
const canRetry = computed(
  () =>
    operation.data.value?.status === 'failed' ||
    ((!!serviceInput.value ||
      !!domainInput.value ||
      !!clusterNetworkInput.value ||
      !!volumeInput.value) &&
      operation.data.value?.status === 'cancelled'),
);
const title = computed(() => operationLabel(operation.data.value?.kind));
const logs = useQuery({
  queryKey: ['operation-logs', operationId],
  queryFn: ({ signal }) =>
    request<OperationLogPage>(`/operations/${operationId}/logs?limit=100`, { signal }),
  refetchInterval: () => (active.value ? 2000 : false),
});
const extraLogs = ref<OperationLog[]>([]);
const moreCursor = ref<string | null>(null);
const loadingMore = ref(false);
watch(
  () => operation.data.value?.status,
  (status) => {
    void logs.refetch();
    if (
      operation.data.value?.scope === 'integration' &&
      status &&
      !['queued', 'running'].includes(status)
    ) {
      void invalidateCollection('/integrations/github');
      void invalidateCollection('/integrations/registries');
      void queryClient.invalidateQueries({ queryKey: ['github-page'] });
    }
    if (serviceInput.value && status && !['queued', 'running'].includes(status)) {
      void invalidateCollection('/services');
      void queryClient.invalidateQueries({ queryKey: ['service', serviceInput.value.serviceId] });
    }
    if (domainInput.value && status && !['queued', 'running'].includes(status))
      void invalidateNetworking(domainInput.value.serviceId, domainInput.value.domainId);
    if (clusterNetworkInput.value && status && !['queued', 'running'].includes(status)) {
      void queryClient.invalidateQueries({
        queryKey: ['cluster-networking', clusterNetworkInput.value.clusterId],
      });
      void queryClient.invalidateQueries({ queryKey: ['service-networking'] });
    }
    if (volumeInput.value && status && !['queued', 'running'].includes(status))
      void invalidateStorage(undefined, volumeInput.value.volumeId);
  },
);
const logRows = computed(() =>
  [
    ...new Map(
      [...(logs.data.value?.data ?? []), ...extraLogs.value].map((item) => [item.sequence, item]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence),
);
const hasMoreLogs = computed(() =>
  extraLogs.value.length ? !!moreCursor.value : logs.data.value?.page.hasMore,
);
async function loadMoreLogs() {
  const cursor = extraLogs.value.length ? moreCursor.value : logs.data.value?.page.nextCursor;
  if (!cursor || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const next = await request<OperationLogPage>(
      `/operations/${operationId}/logs?limit=100&cursor=${encodeURIComponent(cursor)}`,
    );
    extraLogs.value.push(...next.data);
    moreCursor.value = next.page.hasMore ? next.page.nextCursor : null;
  } catch {
    ui.toast('未能载入更多日志，请重试。', 'error');
  } finally {
    loadingMore.value = false;
  }
}
const cancel = useMutation({
  mutationFn: () => api.create<Operation>(`/operations/${operationId}/cancel`, {}),
  onSuccess: async (result) => {
    queryClient.setQueryData(['operation', operationId], result);
    await invalidateCollection('/operations');
    if (!isViewActive()) return;
    ui.toast(result.status === 'cancelled' ? '任务已取消。' : '取消请求已受理，等待执行器确认。');
  },
});
const retryKey = idempotencyKey();
const retry = useMutation({
  mutationFn: () => api.create<Operation>(`/operations/${operationId}/retry`, {}, retryKey),
  onSuccess: async (result) => {
    queryClient.setQueryData(['operation', result.id], result);
    await invalidateCollection('/operations');
    if (!isViewActive()) return;
    await router.push(`/operations/${result.id}`);
    ui.toast('重试任务已受理，原记录保留。');
  },
});
async function requestRetry() {
  if (auth.restoreMode || retry.isPending.value || !canRetry.value) return;
  if (
    operation.data.value?.scope === 'integration' &&
    !(await ui.confirm({
      title: '重试这次集成操作？',
      description:
        operation.data.value.kind === 'registry_validate'
          ? '沿用原 Registry 连接和平台探针 repository，再次执行真实推送、拉取及只读权限验证。已发生的远端写入保留。'
          : '沿用原仓库与回调目标，重新核对或注册平台持有的 GitHub Webhook。已发生的远端变更保留。',
      confirmText: '创建集成重试任务',
    }))
  )
    return;
  if (
    volumeInput.value &&
    !(await ui.confirm({
      title: '重试这次数据卷操作？',
      description: `固定卷 ${volumeInput.value.volumeId} · ${volumeInput.value.target.namespace}。重试沿用原卷身份、维护会话和销毁确认，不读取其他卷或替换原意图。已发生的远端变更继续保留；失效的版本或确认由控制面拒绝。`,
      confirmText: '创建重试任务',
      destructive: operation.data.value?.kind === 'volume_destroy',
    }))
  )
    return;
  if (
    domainInput.value &&
    !(await ui.confirm({
      title: '重试这次域名操作？',
      description: `${domainInput.value.hostname} · ${domainInput.value.target.namespace} / ${domainInput.value.target.portName}。重试沿用原域名、目标与操作意图，已发生的远端变更不会自动撤回。`,
      confirmText: '创建重试任务',
      destructive: operation.data.value?.kind === 'domain_unbind',
    }))
  )
    return;
  if (
    serviceInput.value &&
    !(await ui.confirm({
      title: '重试这次服务操作？',
      description: `固定目标 ${serviceInput.value.target.serviceName} / ${serviceInput.value.target.namespace}。重试沿用原目标与配置快照，已发生的远端效果不会自动撤回。后续变更已取代本任务时，控制面会拒绝重放。`,
      confirmText: '创建重试任务',
      destructive: operation.data.value?.kind === 'service_delete',
    }))
  )
    return;
  if (isViewActive()) retry.mutate();
}
async function requestCancel() {
  if (
    await ui.confirm({
      title: diagnostic.value ? '请求取消当前诊断？' : '请求取消当前任务？',
      description: diagnostic.value
        ? '已在执行的诊断，需要等待执行器确认结束后更新状态。'
        : '取消会停止等待或执行，并保留已发生的远端变更。任务状态将在执行器确认结束后更新。',
      confirmText: '请求取消',
    })
  )
    if (isViewActive()) cancel.mutate();
}
const unavailableMessages: Record<string, string> = {
  not_started: '任务尚未开始执行，日志将在执行后出现。',
  expired: '该任务的日志已超过保留期限。',
  not_available: '当前没有可用日志。',
};
const logUnavailable = computed(
  () => unavailableMessages[logs.data.value?.unavailableReason ?? ''] ?? '尚无日志记录。',
);
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/operations" class="text-link">操作任务</RouterLink><ChevronRight /><span>{{
      operationId.slice(0, 8)
    }}</span>
  </nav>
  <QueryState
    :pending="operation.isPending.value"
    :error="operation.error.value"
    @retry="operation.refetch()"
    ><template v-if="operation.data.value">
      <div class="page-head">
        <div>
          <div class="flex items-center gap-3">
            <h1>{{ title }}</h1>
            <StatusBadge :status="operation.data.value.status" />
          </div>
          <p class="mono mt-2">{{ operation.data.value.id }}</p>
        </div>
        <div class="actions">
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新任务状态"
            :disabled="operation.isFetching.value"
            @click="
              operation.refetch();
              logs.refetch();
            "
            ><RefreshCw /></Button
          ><Button
            v-if="canRetry && !auth.restoreMode"
            variant="outline"
            :disabled="retry.isPending.value"
            @click="requestRetry"
            ><RotateCcw />创建重试任务</Button
          ><Button
            v-if="active && !auth.restoreMode"
            variant="outline"
            :disabled="cancel.isPending.value || !!operation.data.value.cancelRequestedAt"
            @click="requestCancel"
            ><Square />{{
              operation.data.value.cancelRequestedAt ? '取消待确认' : '请求取消'
            }}</Button
          >
        </div>
      </div>
      <StorageMutationError
        v-if="volumeInput"
        class="mb-5"
        :error="cancel.error.value ?? retry.error.value"
      />
      <ServiceMutationError
        v-else-if="serviceInput || domainInput"
        class="mb-5"
        :error="cancel.error.value ?? retry.error.value"
      />
      <MutationError v-else class="mb-5" :error="cancel.error.value ?? retry.error.value" />
      <NetworkOperationContext :operation="operation.data.value" />
      <VolumeOperationContext :operation="operation.data.value" />
      <IntegrationOperationContext :operation="operation.data.value" />
      <div v-if="serviceInput" class="notice mb-6">
        <Info />
        <div class="min-w-0">
          <strong
            >服务任务 ·
            {{ currentService.data.value?.name || serviceInput.target.serviceName }}</strong
          >
          <p class="break-all">
            {{
              currentService.data.value
                ? `${currentService.data.value.project.name} / ${currentService.data.value.environment.name} · ${currentService.data.value.cluster.name}`
                : `命名空间 ${serviceInput.target.namespace}`
            }}
          </p>
          <RouterLink
            v-if="currentService.data.value"
            :to="serviceLocation(currentService.data.value)"
            class="text-link mt-2 inline-block"
            >查看服务当前运行状态</RouterLink
          >
          <p v-else-if="!operation.data.value.serviceId" class="meta mt-2">
            服务已删除，原任务目标与结果仍保留。
          </p>
        </div>
      </div>
      <div v-if="operation.data.value.status === 'queued'" class="notice mb-6">
        <Clock3 />
        <div>
          <strong>已持久受理，等待执行</strong>
          <p>任务已保存在控制面。调度连接恢复后会继续投递，受理不代表执行已经完成。</p>
        </div>
      </div>
      <div
        v-if="operation.data.value.cancelRequestedAt && operation.data.value.status === 'running'"
        class="notice notice-warning mb-6"
        role="status"
      >
        <Info />
        <p>取消请求已记录，正在等待执行器确认。当前状态仍为执行中。</p>
      </div>
      <div
        v-if="operation.data.value.status === 'failed'"
        class="notice notice-danger mb-6"
        role="alert"
      >
        <AlertCircle />
        <div>
          <strong>{{ operation.data.value.errorMessage || '任务执行失败' }}</strong>
          <p v-if="operation.data.value.errorCode" class="mono mt-2">
            {{ operation.data.value.errorCode }}
          </p>
        </div>
      </div>
      <div class="split">
        <div class="stack">
          <section class="panel">
            <h2 class="mb-6">执行过程</h2>
            <ol class="task-timeline">
              <li>
                <span class="timeline-icon"><CheckCircle2 /></span>
                <div>
                  <strong>持久受理</strong>
                  <p class="meta">{{ dateTime(operation.data.value.createdAt) }}</p>
                </div>
              </li>
              <li>
                <span :class="['timeline-icon', { waiting: !operation.data.value.startedAt }]"
                  ><component :is="operation.data.value.startedAt ? CheckCircle2 : Circle"
                /></span>
                <div>
                  <strong>{{
                    operation.data.value.startedAt ? '执行器已开始处理' : '等待执行器处理'
                  }}</strong>
                  <p class="meta">
                    {{
                      operation.data.value.startedAt
                        ? dateTime(operation.data.value.startedAt)
                        : '尚无开始时间'
                    }}
                  </p>
                </div>
              </li>
              <li>
                <span :class="['timeline-icon', { waiting: !operation.data.value.finishedAt }]"
                  ><component :is="operation.data.value.finishedAt ? CheckCircle2 : Circle"
                /></span>
                <div>
                  <strong>{{
                    operation.data.value.finishedAt ? '执行结果已记录' : '等待最终结果'
                  }}</strong>
                  <p class="meta">
                    {{
                      operation.data.value.finishedAt
                        ? dateTime(operation.data.value.finishedAt)
                        : '以实际任务记录为准'
                    }}
                  </p>
                </div>
              </li>
            </ol>
          </section>
          <section class="panel">
            <div class="section-head">
              <h2>{{ diagnostic ? '诊断日志' : '执行日志' }}</h2>
              <span class="meta">{{ active ? '每 2 秒更新' : '执行记录' }}</span>
            </div>
            <QueryState
              :pending="logs.isPending.value"
              :error="logs.error.value"
              @retry="logs.refetch()"
              ><div
                v-if="logRows.length"
                class="operation-log"
                tabindex="0"
                :aria-label="diagnostic ? '诊断日志' : '执行日志'"
              >
                <div v-for="line in logRows" :key="line.sequence" class="log-line">
                  <time>{{ dateTime(line.timestamp) }}</time
                  ><span :class="['log-level', `log-${line.level}`]">{{ line.level }}</span
                  ><span>{{ line.message }}</span>
                </div>
              </div>
              <p v-else-if="!logs.error.value" class="muted py-6">{{ logUnavailable }}</p>
              <p v-if="logs.data.value?.truncated" class="meta mt-3">
                日志已达到容量上限，部分内容按保留规则裁剪。
              </p>
              <Button
                v-if="hasMoreLogs"
                variant="outline"
                size="sm"
                class="mt-4"
                :disabled="loadingMore"
                @click="loadMoreLogs"
                >载入更多日志</Button
              ></QueryState
            >
          </section>
          <section v-if="operation.data.value.result && diagnostic" class="panel">
            <h2 class="mb-4">诊断结果</h2>
            <pre class="result-json" tabindex="0">{{
              JSON.stringify(operation.data.value.result, null, 2)
            }}</pre>
          </section>
          <section v-else-if="serviceResult" class="panel">
            <h2 class="mb-4">服务操作结果</h2>
            <p>{{ serviceResultLabels[serviceResult.action] }}</p>
            <p v-if="'remoteEffects' in serviceResult" class="meta mt-3">
              本次操作没有需要处理的远端资源。
            </p>
            <template v-else>
              <p class="meta mt-3">
                完成于 {{ dateTime(serviceResult.completedAt) }} · 已确认
                {{ serviceResult.resources.length }} 个资源
              </p>
              <p v-if="serviceResult.rollout" class="meta mt-2">
                使用配置 r{{ serviceResult.rollout.configRevision }} ·
                {{ serviceResult.rollout.replicas }} 个期望副本
              </p>
            </template>
            <Button v-if="currentService.data.value" as-child variant="outline" class="mt-4"
              ><RouterLink :to="serviceLocation(currentService.data.value)"
                >查看服务运行观察</RouterLink
              ></Button
            >
          </section>
          <section
            v-else-if="volumeResult && volumeInput"
            class="panel"
            data-volume-operation-result
          >
            <h2 class="mb-4">数据卷任务结果</h2>
            <p>
              本次执行已记录：<span class="mono">{{ volumeResult.state }}</span>
            </p>
            <p v-if="volumeResult.observedAt" class="meta mt-3">
              采样于 {{ dateTime(volumeResult.observedAt) }}
            </p>
            <p v-if="volumeResult.neverCreated" class="meta mt-3">已确认没有创建过远端 PVC。</p>
            <p v-if="volumeResult.maintenanceId" class="meta mono mt-3 break-all">
              维护会话 {{ volumeResult.maintenanceId }}
            </p>
            <RouterLink :to="`/volumes/${volumeInput.volumeId}`" class="text-link mt-4 inline-block"
              >核对数据卷当前状态</RouterLink
            >
          </section>
          <section v-else-if="operation.data.value.result" class="panel">
            <h2 class="mb-4">执行结果</h2>
            <p class="muted">任务结果已记录。关联资源页面保留对应的连接、预检或节点观察。</p>
            <div class="actions mt-4">
              <Button v-if="operation.data.value.serverId" as-child variant="outline"
                ><RouterLink :to="`/servers/${operation.data.value.serverId}`"
                  >查看服务器记录</RouterLink
                ></Button
              >
              <Button v-if="operation.data.value.clusterId" as-child variant="outline"
                ><RouterLink :to="`/clusters/${operation.data.value.clusterId}`"
                  >查看集群记录</RouterLink
                ></Button
              >
            </div>
          </section>
        </div>
        <aside class="panel">
          <h2>任务信息</h2>
          <dl class="detail-list mt-4">
            <div>
              <dt>范围</dt>
              <dd>
                {{
                  diagnostic
                    ? '控制面'
                    : volumeInput
                      ? '项目环境中的数据卷'
                      : domainInput
                        ? '服务域名与网络'
                        : serviceInput
                          ? '项目环境中的服务'
                          : operation.data.value.serverId
                            ? '已登记服务器'
                            : operation.data.value.clusterId
                              ? '已登记集群'
                              : '后台任务'
                }}
              </dd>
            </div>
            <template v-if="serviceInput">
              <div>
                <dt>固定服务</dt>
                <dd class="mono break-all">{{ serviceInput.serviceId }}</dd>
              </div>
              <div>
                <dt>固定项目</dt>
                <dd>
                  <RouterLink
                    :to="{
                      path: `/projects/${serviceInput.target.projectId}`,
                      query:
                        currentService.data.value?.environmentId ===
                        serviceInput.target.environmentId
                          ? { environment: currentService.data.value.environment.slug }
                          : { tab: 'environments' },
                    }"
                    class="text-link break-all"
                    >{{
                      currentService.data.value?.projectId === serviceInput.target.projectId
                        ? currentService.data.value.project.name
                        : serviceInput.target.projectId
                    }}</RouterLink
                  >
                </dd>
              </div>
              <div>
                <dt>固定环境</dt>
                <dd class="break-all">
                  {{
                    currentService.data.value?.environmentId === serviceInput.target.environmentId
                      ? currentService.data.value.environment.name
                      : serviceInput.target.environmentId
                  }}
                </dd>
              </div>
              <div>
                <dt>命名空间</dt>
                <dd class="mono break-all">{{ serviceInput.target.namespace }}</dd>
              </div>
              <div v-if="serviceInput.snapshotId">
                <dt>配置快照</dt>
                <dd>
                  <RouterLink
                    :to="`/deployments/${serviceInput.snapshotId}`"
                    class="text-link mono break-all"
                    >{{ serviceInput.snapshotId }}</RouterLink
                  >
                </dd>
              </div>
            </template>
            <div v-if="operation.data.value.serverId">
              <dt>固定服务器</dt>
              <dd>
                <RouterLink
                  :to="`/servers/${operation.data.value.serverId}`"
                  class="text-link mono"
                  >{{ operation.data.value.serverId }}</RouterLink
                >
              </dd>
            </div>
            <div v-if="operation.data.value.clusterId">
              <dt>固定集群</dt>
              <dd>
                <RouterLink
                  :to="`/clusters/${operation.data.value.clusterId}`"
                  class="text-link mono"
                  >{{ operation.data.value.clusterId }}</RouterLink
                >
              </dd>
            </div>
            <div>
              <dt>尝试次数</dt>
              <dd>{{ operation.data.value.attempts }} / {{ operation.data.value.maxAttempts }}</dd>
            </div>
            <div>
              <dt>最近更新</dt>
              <dd>{{ dateTime(operation.data.value.updatedAt) }}</dd>
            </div>
            <div v-if="operation.data.value.retryOfId">
              <dt>原任务</dt>
              <dd>
                <RouterLink
                  :to="`/operations/${operation.data.value.retryOfId}`"
                  class="text-link mono"
                  >{{ operation.data.value.retryOfId.slice(0, 8) }}</RouterLink
                >
              </dd>
            </div>
            <div>
              <dt>当前观察</dt>
              <dd class="meta">{{ active ? '持续读取任务状态' : '已记录终态' }}</dd>
            </div>
          </dl>
        </aside>
      </div>
    </template></QueryState
  >
</template>
<style scoped>
.task-timeline {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}
.task-timeline li {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.timeline-icon {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  color: var(--success);
}
.timeline-icon svg {
  width: 1.125rem;
  height: 1.125rem;
}
.timeline-icon.waiting {
  color: var(--muted-foreground);
}
.operation-log {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  background: var(--background);
  padding: 1rem;
  border-radius: 0.5rem;
  max-height: 26rem;
  overflow: auto;
}
.log-line {
  display: grid;
  grid-template-columns: 8.5rem 2.75rem minmax(18rem, 1fr);
  gap: 0.75rem;
  line-height: 1.8;
  min-width: 33rem;
}
.log-line time {
  color: var(--muted-foreground);
}
.log-level {
  color: var(--muted-foreground);
}
.log-warn {
  color: var(--warning);
}
.log-error {
  color: var(--destructive);
}
.result-json {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 1rem;
  background: var(--background);
  border-radius: 0.5rem;
  margin: 0;
}
</style>
