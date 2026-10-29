<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import { request } from '@/lib/api';
import { useCollection } from '@/lib/query';
import { dateTime } from '@/lib/utils';
import { reasonLabel } from './presentation';
import type { WebhookDelivery, WebhookRejections } from './types';
const deliveries = useCollection<WebhookDelivery>('/webhook-deliveries', undefined, true, {
  refetchInterval: 10_000,
});
const rejections = useQuery({
  queryKey: ['webhook-rejections'],
  queryFn: ({ signal }) => request<WebhookRejections>('/webhook-rejections', { signal }),
});
const stateLabels: Record<string, string> = {
  accepted: '已接收',
  received: '已接收',
  ignored: '已忽略',
  processed: '已处理',
  dispatched: '已投递',
};
</script>
<template>
  <div class="stack">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>GitHub 事件收件</h2>
          <p class="meta mt-1">
            收件成功表示已持久保存。各服务的等待、待审阅或部署结果在事件详情中分别追踪。
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新 GitHub 事件"
          :disabled="deliveries.isFetching.value"
          @click="deliveries.refetch()"
          ><RefreshCw
        /></Button>
      </div>
      <QueryState
        :pending="deliveries.isPending.value"
        :error="deliveries.error.value"
        @retry="deliveries.refetch()"
      >
        <ul class="delivery-list">
          <li v-for="delivery in deliveries.items.value" :key="delivery.id">
            <div class="min-w-0">
              <RouterLink
                :to="'/webhook-deliveries/' + delivery.id"
                class="text-link font-medium break-all"
                >{{ delivery.event }} · {{ delivery.ref || '无分支引用' }}</RouterLink
              >
              <p v-if="delivery.afterSha" class="mono text-sm mt-2 break-all">
                {{ delivery.afterSha }}
              </p>
              <p class="meta mt-2">
                {{ dateTime(delivery.createdAt) }} ·
                {{ stateLabels[delivery.state] || delivery.state
                }}{{
                  delivery.duplicateCount ? ' · 重复投递 ' + delivery.duplicateCount + ' 次' : ''
                }}
              </p>
              <p v-if="delivery.reason" class="meta mt-1">{{ reasonLabel(delivery.reason) }}</p>
            </div>
            <Button as-child variant="outline"
              ><RouterLink :to="'/webhook-deliveries/' + delivery.id"
                >查看各服务投递</RouterLink
              ></Button
            >
          </li>
        </ul>
        <p v-if="!deliveries.items.value.length && !deliveries.error.value" class="meta py-4">
          尚无已验签的事件。请在 Git 与构建设置中配置授权仓库和 Webhook。
        </p>
        <Button
          v-if="deliveries.hasNextPage.value"
          variant="outline"
          :disabled="deliveries.isFetchingNextPage.value"
          @click="deliveries.fetchNextPage()"
          >载入更多事件</Button
        >
      </QueryState>
    </section>
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>Webhook 拒绝记录</h2>
          <p class="meta mt-1">按仓库与原因汇总有界拒绝审计，不显示原始请求体或敏感请求头。</p>
        </div>
        <Button
          variant="outline"
          :disabled="rejections.isFetching.value"
          @click="rejections.refetch()"
          >刷新拒绝记录</Button
        >
      </div>
      <QueryState
        :pending="rejections.isPending.value"
        :error="rejections.error.value"
        @retry="rejections.refetch()"
      >
        <ul v-if="rejections.data.value?.data.length" class="rejection-list">
          <li
            v-for="item in rejections.data.value.data"
            :key="item.repositoryId + ':' + item.bucket + ':' + item.reason"
          >
            <strong>{{ reasonLabel(item.reason) }} · {{ item.count }} 次</strong>
            <p class="meta mt-1">{{ dateTime(item.bucket) }} · 仓库 {{ item.repositoryId }}</p>
          </li>
        </ul>
        <p v-else-if="!rejections.error.value" class="meta">保留范围内暂无拒绝记录。</p>
        <p v-if="rejections.data.value" class="meta mt-4">
          审计保留 {{ rejections.data.value.retentionHours }} 小时{{
            rejections.data.value.truncated ? '，当前列表已达到返回上限。' : '。'
          }}
        </p>
      </QueryState>
    </section>
  </div>
</template>
<style scoped>
.delivery-list,
.rejection-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.delivery-list li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
  padding: 1.25rem 0;
}
.rejection-list li {
  padding: 1rem 0;
  overflow-wrap: anywhere;
}
li + li {
  border-top: 1px solid var(--border);
}
@media (max-width: 640px) {
  .delivery-list li {
    flex-direction: column;
  }
}
</style>
