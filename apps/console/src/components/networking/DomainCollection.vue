<script setup lang="ts">
import { computed, ref } from 'vue';
import { Globe, Search, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import { useCollection } from '@/lib/query';
import DomainList from './DomainList.vue';
import type { Domain } from './types';

const props = defineProps<{
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  clusterId?: string;
}>();
const search = ref('');
const filters = computed<Record<string, string>>(() => ({
  ...(props.projectId ? { projectId: props.projectId } : {}),
  ...(props.environmentId ? { environmentId: props.environmentId } : {}),
  ...(props.serviceId ? { serviceId: props.serviceId } : {}),
  ...(props.clusterId ? { clusterId: props.clusterId } : {}),
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
}));
const domains = useCollection<Domain>('/domains', filters, true, { refetchInterval: 15_000 });
const filtered = computed(() => Object.keys(filters.value).length > 0);
</script>
<template>
  <section aria-label="域名列表" data-domain-collection>
    <div class="section-head">
      <div class="relative w-full max-w-lg">
        <Search class="absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true" />
        <Input
          v-model="search"
          class="pl-10"
          aria-label="搜索域名或服务"
          placeholder="搜索域名或服务"
        />
      </div>
      <div class="actions">
        <p class="meta">已载入 {{ domains.items.value.length }} 个域名</p>
        <Button
          variant="outline"
          size="icon"
          aria-label="刷新域名列表"
          :disabled="domains.isFetching.value"
          @click="domains.refetch()"
          ><RefreshCw
        /></Button>
      </div>
    </div>
    <QueryState
      :pending="domains.isPending.value"
      :error="domains.error.value"
      @retry="domains.refetch()"
    >
      <DomainList v-if="domains.items.value.length" :domains="domains.items.value" />
      <EmptyState
        v-else
        :icon="Globe"
        :title="filtered ? '没有匹配的域名' : '还没有应用域名'"
        :description="
          filtered
            ? '调整名称、项目、环境或集群筛选。'
            : '先发布服务的 HTTP 端口，再从服务网络页分配默认域名。'
        "
      >
        <Button v-if="!filtered" as-child
          ><RouterLink to="/services">选择服务配置域名</RouterLink></Button
        >
      </EmptyState>
      <Button
        v-if="domains.hasNextPage.value"
        variant="outline"
        class="mt-5"
        :disabled="domains.isFetchingNextPage.value"
        @click="domains.fetchNextPage()"
        >{{ domains.isFetchingNextPage.value ? '正在载入…' : '载入更多域名' }}</Button
      >
    </QueryState>
  </section>
</template>
