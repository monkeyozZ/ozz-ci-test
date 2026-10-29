<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { RefreshCw, History } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useCollection } from '@/lib/query';
import { dateTime } from '@/lib/utils';
import { stageLabels } from './presentation';
import type { Deployment } from './types';
import { deploymentSourceLabel } from '@/components/git/presentation';
const props = defineProps<{ serviceId?: string; projectId?: string; environmentId?: string }>();
const route = useRoute();
const router = useRouter();
const filterScope = computed(() =>
  [props.serviceId ?? '', props.projectId ?? '', props.environmentId ?? ''].join(':'),
);
const status = computed({
  get: () =>
    route.query.deploymentScope === filterScope.value &&
    typeof route.query.deploymentStatus === 'string' &&
    ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(route.query.deploymentStatus)
      ? route.query.deploymentStatus
      : '',
  set: (value: string) => {
    void router.replace({
      path: route.path,
      query: {
        ...route.query,
        deploymentScope: value ? filterScope.value : undefined,
        deploymentStatus: value || undefined,
      },
    });
  },
});
const query = computed(() => ({
  ...(props.serviceId ? { serviceId: props.serviceId } : {}),
  ...(props.projectId ? { projectId: props.projectId } : {}),
  ...(props.environmentId ? { environmentId: props.environmentId } : {}),
  ...(status.value ? { status: status.value } : {}),
}));
const deployments = useCollection<Deployment>('/deployments', query, true, {
  refetchInterval: 10_000,
});
</script>
<template>
  <section class="panel">
    <div class="section-head">
      <div>
        <h2>部署记录</h2>
        <p class="meta mt-1">任务结果保持历史记录，实际运行状态见服务概览。</p>
      </div>
      <div class="actions">
        <select v-model="status" class="input max-w-48" aria-label="筛选部署状态">
          <option value="">全部状态</option>
          <option value="queued">已排队</option>
          <option value="running">执行中</option>
          <option value="succeeded">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option></select
        ><Button
          variant="ghost"
          size="icon"
          aria-label="刷新部署记录"
          :disabled="deployments.isFetching.value"
          @click="deployments.refetch()"
          ><RefreshCw
        /></Button>
      </div>
    </div>
    <QueryState
      :pending="deployments.isPending.value"
      :error="deployments.error.value"
      :refreshing="deployments.isFetching.value"
      @retry="deployments.refetch()"
      ><div v-if="deployments.items.value.length" class="deployment-list">
        <RouterLink
          v-for="deployment in deployments.items.value"
          :key="deployment.id"
          :to="`/deployments/${deployment.id}`"
          class="deployment-row"
          ><div class="min-w-0">
            <strong
              >{{ deployment.snapshot.serviceName }} · 配置 r{{ deployment.configRevision }}</strong
            >
            <p class="meta mono mt-1 break-all">
              {{ deploymentSourceLabel(deployment) }}
            </p>
            <p class="meta mt-1">
              {{ deployment.kind === 'git_deploy' ? 'Git 构建发布' : '镜像发布' }} ·
              {{ deployment.initiatorKind === 'webhook' ? 'GitHub Webhook' : '管理员发布' }} ·
              {{ dateTime(deployment.createdAt) }} · {{ deployment.id.slice(0, 8) }}
            </p>
          </div>
          <div class="deployment-status">
            <StatusBadge :status="deployment.status" />
            <p class="meta mt-2">{{ stageLabels[deployment.phase] || deployment.phase }}</p>
          </div></RouterLink
        >
      </div>
      <EmptyState
        v-else-if="!deployments.error.value"
        :icon="History"
        title="尚无匹配的部署记录"
        description="发布后会在这里保留固定来源、配置、产物与执行结果。"
      /><Button
        v-if="deployments.hasNextPage.value"
        variant="outline"
        class="mt-4"
        :disabled="deployments.isFetchingNextPage.value"
        @click="deployments.fetchNextPage()"
        >载入更多部署</Button
      ></QueryState
    >
  </section>
</template>
<style scoped>
.deployment-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.25rem 0;
  border-top: 1px solid var(--border);
}
.deployment-row:first-child {
  border-top: 0;
}
.deployment-row:hover strong {
  color: var(--primary);
}
.deployment-status {
  flex-shrink: 0;
  min-width: 6rem;
}
@media (max-width: 639px) {
  .deployment-row {
    align-items: flex-start;
    gap: 1rem;
  }
  .deployment-status {
    min-width: auto;
  }
}
</style>
