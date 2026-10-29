<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation } from '@tanstack/vue-query';
import { Activity, Plus, ChevronRight, RefreshCw, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import WorkerHealth from '@/components/WorkerHealth.vue';
import {
  operationLabel,
  serviceOperationInput,
  domainOperationInput,
} from '@/components/infrastructure/operation-presentation';
import { api, ApiError } from '@/lib/api';
import { useCollection, invalidateCollection, queryClient } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { dateTime, idempotencyKey } from '@/lib/utils';
import type { Operation } from '@/lib/types';
const isViewActive = useViewScope();
const auth = useAuthStore();
const ui = useUiStore();
const router = useRouter();
const route = useRoute();
const targetParams = computed<Record<string, string>>(() => ({
  ...(typeof route.query.serverId === 'string' ? { serverId: route.query.serverId } : {}),
  ...(typeof route.query.clusterId === 'string' ? { clusterId: route.query.clusterId } : {}),
  ...(typeof route.query.serviceId === 'string' ? { serviceId: route.query.serviceId } : {}),
}));
const contextual = computed(() => Object.keys(targetParams.value).length > 0);
const filter = ref('');
const operations = useCollection<Operation>(
  '/operations',
  computed(() => ({ ...targetParams.value, ...(filter.value ? { status: filter.value } : {}) })),
);
const rows = operations.items;
let key = idempotencyKey();
const create = useMutation({
  mutationFn: () => api.create<Operation>('/operations/diagnostics', {}, key),
  onSuccess: async (operation) => {
    key = idempotencyKey();
    queryClient.setQueryData(['operation', operation.id], operation);
    await invalidateCollection('/operations');
    if (!isViewActive()) return;
    ui.toast('诊断任务已受理。');
    await router.push(`/operations/${operation.id}`);
  },
});
let interval: number | undefined;
onMounted(() => {
  interval = window.setInterval(() => {
    if (
      document.visibilityState === 'visible' &&
      operations.items.value.some((item) => item.status === 'queued' || item.status === 'running')
    )
      void operations.refetch();
  }, 5000);
});
onUnmounted(() => clearInterval(interval));
</script>
<template>
  <div class="page-head">
    <div>
      <h1>操作任务</h1>
      <p>
        {{
          contextual
            ? '查看当前资源的持久任务、执行过程与结果。'
            : '查看服务变更、服务器接入、集群连接与控制面诊断的真实处理记录。'
        }}
      </p>
    </div>
    <div class="actions">
      <Button
        variant="outline"
        size="icon"
        aria-label="刷新操作任务"
        :disabled="operations.isFetching.value"
        @click="operations.refetch()"
        ><RefreshCw /></Button
      ><Button
        v-if="!auth.restoreMode && !contextual"
        :disabled="create.isPending.value"
        @click="create.mutate()"
        ><LoaderCircle v-if="create.isPending.value" class="animate-spin" /><Plus v-else />{{
          create.isPending.value
            ? '正在受理…'
            : create.error.value instanceof ApiError && create.error.value.status === 0
              ? '确认原诊断请求'
              : '运行诊断'
        }}</Button
      >
    </div>
  </div>
  <WorkerHealth class="mb-6" /><MutationError class="mb-6" :error="create.error.value" />
  <div class="mb-5 flex items-center justify-between gap-4">
    <p class="meta">
      已载入 {{ operations.items.value.length }} 条任务<span v-if="contextual">
        · <RouterLink to="/operations" class="text-link">查看所有任务</RouterLink></span
      >
    </p>
    <select v-model="filter" class="input max-w-40" aria-label="筛选任务状态">
      <option value="">全部状态</option>
      <option value="queued">已排队</option>
      <option value="running">执行中</option>
      <option value="succeeded">已完成</option>
      <option value="failed">失败</option>
      <option value="cancelled">已取消</option>
    </select>
  </div>
  <QueryState
    :pending="operations.isPending.value"
    :error="operations.error.value"
    @retry="operations.refetch()"
    ><div
      v-if="rows.length"
      class="table-wrap"
      tabindex="0"
      role="region"
      aria-label="操作任务表，可水平滚动"
    >
      <table class="data-table operations-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>固定目标</th>
            <th>状态</th>
            <th class="mobile-hide">尝试次数</th>
            <th>受理时间</th>
            <th><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="operation in rows" :key="operation.id">
            <td>
              <RouterLink :to="`/operations/${operation.id}`" class="text-link font-medium">{{
                operationLabel(operation.kind)
              }}</RouterLink>
              <p class="mono muted mt-1">{{ operation.id.slice(0, 8) }}</p>
            </td>
            <td>
              <template v-if="domainOperationInput(operation)">
                <strong class="mono break-all">{{
                  domainOperationInput(operation)!.hostname
                }}</strong>
                <p class="meta mono mt-1 break-all">
                  {{ domainOperationInput(operation)!.target.namespace }} /
                  {{ domainOperationInput(operation)!.target.portName }}
                </p>
              </template>
              <template v-else-if="serviceOperationInput(operation)">
                <strong class="break-all">{{
                  serviceOperationInput(operation)!.target.serviceName
                }}</strong>
                <p class="meta mono mt-1 break-all">
                  {{ serviceOperationInput(operation)!.target.namespace }}
                </p>
                <p class="meta mt-1">
                  服务 {{ serviceOperationInput(operation)!.serviceId.slice(0, 8) }} · 集群
                  {{ serviceOperationInput(operation)!.target.clusterId.slice(0, 8) }}
                </p>
              </template>
              <RouterLink
                v-else-if="operation.serverId"
                :to="`/servers/${operation.serverId}`"
                class="text-link"
                >服务器 {{ operation.serverId.slice(0, 8) }}</RouterLink
              >
              <RouterLink
                v-else-if="operation.clusterId"
                :to="`/clusters/${operation.clusterId}`"
                class="text-link"
                >集群 {{ operation.clusterId.slice(0, 8) }}</RouterLink
              >
              <span v-else class="meta">控制面</span>
            </td>
            <td>
              <StatusBadge :status="operation.status" />
              <p
                v-if="operation.cancelRequestedAt && operation.status === 'running'"
                class="meta mt-1"
              >
                取消请求待执行器确认
              </p>
            </td>
            <td class="mobile-hide">{{ operation.attempts }} / {{ operation.maxAttempts }}</td>
            <td class="meta">{{ dateTime(operation.createdAt) }}</td>
            <td>
              <Button as-child variant="ghost" size="icon"
                ><RouterLink
                  :to="`/operations/${operation.id}`"
                  :aria-label="`查看${operationLabel(operation.kind)} ${operation.id.slice(0, 8)}`"
                  ><ChevronRight /></RouterLink
              ></Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="!operations.error.value" class="panel">
      <EmptyState
        :icon="Activity"
        :title="filter ? '没有匹配的任务' : contextual ? '尚无关联任务' : '运行第一次控制面诊断'"
        :description="
          filter
            ? '调整状态筛选，查看其他任务记录。'
            : contextual
              ? '在资源详情执行服务变更、预检或连接后，任务会保留在这里。'
              : '服务变更、接入、连接与诊断都会持久记录受理和执行过程。'
        "
        ><Button v-if="filter" variant="outline" @click="filter = ''">清空筛选</Button
        ><Button
          v-else-if="!auth.restoreMode && !contextual"
          :disabled="create.isPending.value"
          @click="create.mutate()"
          ><Plus />运行诊断</Button
        ></EmptyState
      >
    </div>
    <Button
      v-if="operations.hasNextPage.value"
      variant="outline"
      class="mt-5"
      :disabled="operations.isFetchingNextPage.value"
      @click="operations.fetchNextPage()"
      >载入更多任务</Button
    ></QueryState
  >
</template>
<style scoped>
.operations-table {
  min-width: 54rem;
}
.operations-table th:first-child {
  min-width: 10rem;
}
.operations-table th:nth-child(2) {
  min-width: 19rem;
}
.operations-table td:first-child {
  white-space: nowrap;
}
</style>
