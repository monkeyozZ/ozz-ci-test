<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/vue-query';
import { AlertCircle, Clock3, ExternalLink, RefreshCw, RotateCcw, Square } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/StatusBadge.vue';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import { api, request } from '@/lib/api';
import { invalidateCollection, queryClient } from '@/lib/query';
import { dateTime, idempotencyKey } from '@/lib/utils';
import { useViewScope } from '@/composables/useViewScope';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import type { Operation, OperationLogPage } from '@/lib/types';
import { operationLabel } from './operation-presentation';

const props = withDefaults(
  defineProps<{ operationId: string; title?: string; disabled?: boolean }>(),
  { title: '基础设施任务', disabled: false },
);
const emit = defineEmits<{
  observed: [operation: Operation];
  settled: [operation: Operation];
  retried: [operation: Operation];
}>();
const auth = useAuthStore();
const ui = useUiStore();
const isViewActive = useViewScope();
const logsOpen = ref(false);
const operation = useQuery({
  queryKey: computed(() => ['operation', props.operationId]),
  queryFn: ({ queryKey, signal }) => api.get<Operation>(`/operations/${queryKey[1]}`, signal),
  refetchInterval: (query) =>
    ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false,
});
const active = computed(() => ['queued', 'running'].includes(operation.data.value?.status ?? ''));
const settledKeys = new Set<string>();
watch(
  operation.data,
  (value) => {
    if (!value || value.id !== props.operationId) return;
    emit('observed', value);
    const key = `${value.id}:${value.status}:${value.finishedAt ?? ''}`;
    if (!['queued', 'running'].includes(value.status) && !settledKeys.has(key)) {
      settledKeys.add(key);
      emit('settled', value);
    }
  },
  { immediate: true },
);
const logs = useInfiniteQuery({
  queryKey: computed(() => ['infrastructure-operation-logs', props.operationId]),
  enabled: logsOpen,
  initialPageParam: '',
  queryFn: ({ queryKey, pageParam, signal }) => {
    const search = new URLSearchParams({ limit: '100' });
    if (pageParam) search.set('cursor', pageParam);
    return request<OperationLogPage>(`/operations/${queryKey[1]}/logs?${search}`, { signal });
  },
  getNextPageParam: (last) => (last.page.hasMore ? (last.page.nextCursor ?? undefined) : undefined),
  refetchInterval: () => (logsOpen.value && active.value ? 2000 : false),
});
watch(
  () => operation.data.value?.status,
  () => {
    if (logsOpen.value) void logs.refetch();
  },
);
const logRows = computed(() =>
  [
    ...new Map(
      (logs.data.value?.pages.flatMap((page) => page.data) ?? []).map((line) => [
        line.sequence,
        line,
      ]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence),
);
const logUnavailable = computed(() => {
  switch (logs.data.value?.pages[0]?.unavailableReason) {
    case 'expired':
      return '任务日志已超过保留期限。';
    case 'not_started':
      return '任务尚未开始，执行器处理后会记录日志。';
    default:
      return '目前没有可用的任务日志。';
  }
});
const cancel = useMutation({
  mutationFn: (id: string) => api.create<Operation>(`/operations/${id}/cancel`, {}),
  onSuccess: async (value, id) => {
    queryClient.setQueryData(['operation', value.id], value);
    await invalidateCollection('/operations');
    if (!isViewActive() || props.operationId !== id) return;
    ui.toast(value.status === 'cancelled' ? '任务已取消。' : '取消请求已受理，等待执行器确认。');
  },
});
const retryKeys = new Map<string, string>();
const retry = useMutation({
  mutationFn: (id: string) => {
    if (!retryKeys.has(id)) retryKeys.set(id, idempotencyKey());
    return api.create<Operation>(`/operations/${id}/retry`, {}, retryKeys.get(id));
  },
  onSuccess: async (value, originalId) => {
    queryClient.setQueryData(['operation', value.id], value);
    await invalidateCollection('/operations');
    if (!isViewActive() || props.operationId !== originalId) return;
    emit('retried', value);
    ui.toast('重试任务已受理，原执行记录保留。');
  },
});
async function requestCancel() {
  const reviewedId = props.operationId;
  if (
    await ui.confirm({
      title: '请求取消当前任务？',
      description: '已执行的远端步骤不会自动撤回。任务状态将在执行器确认结束后更新。',
      confirmText: '请求取消',
    })
  ) {
    if (isViewActive() && props.operationId === reviewedId) cancel.mutate(reviewedId);
  }
}
function toggleLogs(event: Event) {
  logsOpen.value = (event.currentTarget as HTMLDetailsElement).open;
}
</script>

<template>
  <section class="panel infrastructure-task" aria-label="基础设施任务记录" data-infrastructure-task>
    <div class="section-head">
      <div class="min-w-0">
        <h2>{{ title }}</h2>
        <p class="meta mono mt-1 break-all">{{ operationId }}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="刷新当前基础设施任务"
        :disabled="operation.isFetching.value"
        @click="operation.refetch()"
        ><RefreshCw
      /></Button>
    </div>
    <QueryState
      :pending="operation.isPending.value"
      :error="operation.error.value"
      @retry="operation.refetch()"
    >
      <template v-if="operation.data.value">
        <div class="task-status-line" role="status">
          <StatusBadge :status="operation.data.value.status" />
          <span>{{ operationLabel(operation.data.value.kind) }}</span>
          <span v-if="operation.data.value.cancelRequestedAt && active" class="meta">
            取消待确认
          </span>
          <span class="meta">更新于 {{ dateTime(operation.data.value.updatedAt) }}</span>
        </div>
        <div v-if="operation.data.value.status === 'queued'" class="notice mt-4">
          <Clock3 aria-hidden="true" />
          <p>任务已保存，等待执行器处理。离开页面后仍会继续执行。</p>
        </div>
        <div
          v-if="operation.data.value.status === 'failed'"
          class="notice notice-danger mt-4"
          role="alert"
        >
          <AlertCircle aria-hidden="true" />
          <div class="min-w-0">
            <strong>{{
              operation.data.value.errorMessage || '任务执行失败，请查看执行记录。'
            }}</strong>
            <p v-if="operation.data.value.errorCode" class="mono mt-1 break-all">
              {{ operation.data.value.errorCode }}
            </p>
          </div>
        </div>
        <dl class="task-times">
          <div>
            <dt>受理</dt>
            <dd>{{ dateTime(operation.data.value.createdAt) }}</dd>
          </div>
          <div>
            <dt>开始</dt>
            <dd>{{ dateTime(operation.data.value.startedAt) }}</dd>
          </div>
          <div>
            <dt>结束</dt>
            <dd>{{ dateTime(operation.data.value.finishedAt) }}</dd>
          </div>
        </dl>
        <MutationError class="mt-4" :error="cancel.error.value ?? retry.error.value" />
        <div class="actions mt-4">
          <Button
            v-if="active && !auth.restoreMode"
            variant="outline"
            :disabled="
              disabled || cancel.isPending.value || !!operation.data.value.cancelRequestedAt
            "
            @click="requestCancel"
            ><Square />{{
              operation.data.value.cancelRequestedAt ? '取消待确认' : '请求取消'
            }}</Button
          >
          <Button
            v-if="operation.data.value.status === 'failed' && !auth.restoreMode"
            variant="outline"
            :disabled="disabled || retry.isPending.value"
            @click="retry.mutate(operationId)"
            ><RotateCcw />创建重试任务</Button
          >
          <Button as-child variant="ghost">
            <RouterLink :to="`/operations/${operationId}`"><ExternalLink />完整任务记录</RouterLink>
          </Button>
        </div>
        <details class="task-logs mt-5" @toggle="toggleLogs">
          <summary>
            执行日志<span class="meta ml-2">{{ active ? '展开后持续更新' : '已记录的输出' }}</span>
          </summary>
          <QueryState
            v-if="logsOpen"
            :pending="logs.isPending.value"
            :error="logs.error.value"
            @retry="logs.refetch()"
          >
            <div
              v-if="logRows.length"
              class="log-scroll mt-4"
              tabindex="0"
              aria-label="基础设施执行日志"
            >
              <div v-for="line in logRows" :key="line.sequence" class="log-line">
                <time :datetime="line.timestamp">{{ dateTime(line.timestamp) }}</time>
                <span :class="['log-level', `log-${line.level}`]">{{ line.level }}</span>
                <span>{{ line.message }}</span>
              </div>
            </div>
            <p v-else-if="!logs.error.value" class="muted mt-4">{{ logUnavailable }}</p>
            <p v-if="logs.data.value?.pages.some((page) => page.truncated)" class="meta mt-3">
              日志达到容量上限，部分输出已按保留规则裁剪。
            </p>
            <Button
              v-if="logs.hasNextPage.value"
              variant="outline"
              size="sm"
              class="mt-4"
              :disabled="logs.isFetchingNextPage.value"
              @click="logs.fetchNextPage()"
              >{{ logs.isFetchingNextPage.value ? '正在载入…' : '载入更多日志' }}</Button
            >
          </QueryState>
        </details>
      </template>
    </QueryState>
  </section>
</template>

<style scoped>
.infrastructure-task {
  min-width: 0;
}
.task-status-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}
.task-times {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  margin-top: 1.25rem;
}
.task-times dt {
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.task-times dd {
  margin: 0.375rem 0 0;
  font-variant-numeric: tabular-nums;
}
.task-logs {
  border-top: 1px solid var(--border);
  padding-top: 1rem;
}
.task-logs summary {
  cursor: pointer;
  padding: 0.5rem 0;
}
.log-scroll {
  max-height: 20rem;
  overflow: auto;
  border-radius: 0.5rem;
  padding: 1rem;
  background: var(--background);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}
.log-line {
  display: grid;
  grid-template-columns: 8.5rem 2.75rem minmax(18rem, 1fr);
  gap: 0.75rem;
  min-width: 32rem;
  line-height: 1.8;
}
.log-line time,
.log-level {
  color: var(--muted-foreground);
}
.log-warn {
  color: var(--warning);
}
.log-error {
  color: var(--destructive);
}
@media (max-width: 639px) {
  .task-times {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.625rem;
  }
  .task-times > div {
    display: grid;
    grid-template-columns: 3rem minmax(0, 1fr);
    align-items: baseline;
    gap: 0.75rem;
  }
  .task-times dd {
    margin: 0;
  }
}
</style>
