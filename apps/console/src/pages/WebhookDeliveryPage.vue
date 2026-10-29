<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import GitTargetList from '@/components/git/GitTargetList.vue';
import { reasonLabel } from '@/components/git/presentation';
import type { WebhookDeliveryDetail, WebhookTarget } from '@/components/git/types';
import { api } from '@/lib/api';
import { useCollection } from '@/lib/query';
import { dateTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
const route = useRoute();
const auth = useAuthStore();
const id = String(route.params.deliveryId);
const delivery = useQuery({
  queryKey: ['webhook-delivery', id],
  queryFn: ({ signal }) => api.get<WebhookDeliveryDetail>('/webhook-deliveries/' + id, signal),
  refetchInterval: 10_000,
});
const targets = useCollection<WebhookTarget>(
  '/webhook-deliveries/' + id + '/targets',
  undefined,
  true,
  { refetchInterval: 10_000 },
);
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/deployments?tab=events" class="text-link">Git 事件</RouterLink
    ><span>事件详情</span>
  </nav>
  <div class="page-head">
    <div>
      <h1>GitHub 事件详情</h1>
      <p>接收结果与各服务的投递分别记录。</p>
    </div>
    <Button
      variant="outline"
      :disabled="delivery.isFetching.value || targets.isFetching.value"
      @click="
        delivery.refetch();
        targets.refetch();
      "
      ><RefreshCw />刷新事件</Button
    >
  </div>
  <QueryState
    :pending="delivery.isPending.value"
    :error="delivery.error.value"
    @retry="delivery.refetch()"
  >
    <section v-if="delivery.data.value" class="panel mb-6">
      <h2 class="break-all">
        {{ delivery.data.value.event }} · {{ delivery.data.value.ref || '无分支引用' }}
      </h2>
      <p v-if="delivery.data.value.afterSha" class="mono mt-3 break-all">
        {{ delivery.data.value.afterSha }}
      </p>
      <p class="meta mt-3">
        首次接收 {{ dateTime(delivery.data.value.createdAt) }} · 最近接收
        {{ dateTime(delivery.data.value.lastReceivedAt) }}
      </p>
      <p class="meta mt-2">
        重复投递 {{ delivery.data.value.duplicateCount }} 次{{
          delivery.data.value.reason ? ' · ' + reasonLabel(delivery.data.value.reason) : ''
        }}
      </p>
      <details class="mt-4">
        <summary>事件身份</summary>
        <p class="mono meta mt-2 break-all">
          GitHub delivery {{ delivery.data.value.externalDeliveryId }}
        </p>
        <p class="mono meta mt-2 break-all">
          仓库 {{ delivery.data.value.repositoryId }} · GitHub ID
          {{ delivery.data.value.githubRepositoryId }}
        </p>
      </details>
    </section>
  </QueryState>
  <section class="panel">
    <div class="section-head"><h2>逐服务投递</h2></div>
    <QueryState
      :pending="targets.isPending.value"
      :error="targets.error.value"
      @retry="targets.refetch()"
    >
      <GitTargetList :targets="targets.items.value" :disabled="auth.restoreMode" />
      <p v-if="!targets.items.value.length && !targets.error.value" class="meta py-4">
        此事件没有服务投递记录，请核对接收原因、分支和自动发布策略。
      </p>
      <Button
        v-if="targets.hasNextPage.value"
        variant="outline"
        :disabled="targets.isFetchingNextPage.value"
        @click="targets.fetchNextPage()"
        >载入更多服务投递</Button
      >
    </QueryState>
  </section>
</template>
