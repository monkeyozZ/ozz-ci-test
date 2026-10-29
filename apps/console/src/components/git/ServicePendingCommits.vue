<script setup lang="ts">
import { RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import type { Service } from '@/components/services/types';
import type { WebhookTarget } from './types';
import GitTargetList from './GitTargetList.vue';
const props = defineProps<{ service: Service }>();
const auth = useAuthStore();
const targets = useCollection<WebhookTarget>(
  () => '/services/' + props.service.id + '/pending-commits',
  undefined,
  true,
  { refetchInterval: 10_000 },
);
</script>
<template>
  <section class="panel mb-6" data-service-pending-commits>
    <div class="section-head">
      <div>
        <h2>Git 提交与待发布记录</h2>
        <p class="meta mt-1">每次合法投递分别保留结果，已创建的部署可继续追踪。</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="刷新 Git 提交"
        :disabled="targets.isFetching.value"
        @click="targets.refetch()"
        ><RefreshCw
      /></Button>
    </div>
    <p v-if="service.desiredState === 'stopped'" class="notice mb-4">
      服务已停止。新提交只留下待办；恢复原已发布版本不会开始构建或消费这些提交。
    </p>
    <p v-else class="meta mb-4">停止期间收到的提交仍需审阅并明确发布，恢复运行不会自动处理它们。</p>
    <QueryState
      :pending="targets.isPending.value"
      :error="targets.error.value"
      @retry="targets.refetch()"
    >
      <GitTargetList
        :targets="targets.items.value"
        :disabled="auth.restoreMode || !!service.activeTask"
      />
      <p v-if="!targets.items.value.length && !targets.error.value" class="meta py-4">
        尚无 Git 提交记录。启用自动发布并注册 Webhook 后，可在这里追踪收件与投递。
      </p>
      <Button
        v-if="targets.hasNextPage.value"
        variant="outline"
        :disabled="targets.isFetchingNextPage.value"
        @click="targets.fetchNextPage()"
        >载入更多提交记录</Button
      >
    </QueryState>
  </section>
</template>
