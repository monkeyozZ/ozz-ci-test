<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { HardDrive, Plus, Search, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import VolumeList from '@/components/storage/VolumeList.vue';
import StorageScopeFilters from '@/components/storage/StorageScopeFilters.vue';
import type { Volume } from '@/components/storage/types';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const value = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const search = ref('');
const params = computed<Record<string, string>>(() => ({
  ...Object.fromEntries(
    ['projectId', 'environmentId', 'clusterId', 'serviceId', 'retained'].flatMap((key) =>
      value(key) ? [[key, value(key)]] : [],
    ),
  ),
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
}));
const volumes = useCollection<Volume>('/volumes', params, true, { refetchInterval: 15_000 });
function filter(key: string, next: string) {
  void router.replace({
    path: '/volumes',
    query: {
      ...route.query,
      [key]: next || undefined,
      ...(key === 'projectId' ? { environmentId: undefined, serviceId: undefined } : {}),
    },
  });
}
</script>
<template>
  <div class="page-head">
    <div>
      <h1>持久卷</h1>
      <p>查看本地数据、挂载关系与保留卷，独立管理卷的生命周期。</p>
    </div>
    <Button as-child :disabled="auth.restoreMode"
      ><RouterLink
        :to="{
          path: '/volumes/new',
          query: {
            projectId: value('projectId') || undefined,
            environmentId: value('environmentId') || undefined,
          },
        }"
        ><Plus />创建卷</RouterLink
      ></Button
    >
  </div>
  <StorageScopeFilters
    :project-id="value('projectId')"
    :environment-id="value('environmentId')"
    :cluster-id="value('clusterId')"
    @change="filter"
  />
  <div class="section-head">
    <div class="relative w-full max-w-lg">
      <Search class="absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true" /><Input
        v-model="search"
        class="pl-10"
        aria-label="搜索卷名称"
        placeholder="搜索卷名称"
      />
    </div>
    <div class="actions">
      <select
        class="input w-auto"
        aria-label="筛选保留卷"
        :value="value('retained')"
        @change="filter('retained', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">全部卷</option>
        <option value="true">服务删除后保留</option>
        <option value="false">其他卷</option></select
      ><Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="刷新卷列表"
        :disabled="volumes.isFetching.value"
        @click="volumes.refetch()"
        ><RefreshCw
      /></Button>
    </div>
  </div>
  <p class="meta mb-4">
    已载入 {{ volumes.items.value.length }} 个卷{{
      volumes.hasNextPage.value ? ' · 还有更多结果' : ''
    }}
  </p>
  <QueryState
    :pending="volumes.isPending.value"
    :error="volumes.error.value"
    @retry="volumes.refetch()"
    ><VolumeList v-if="volumes.items.value.length" :volumes="volumes.items.value" /><EmptyState
      v-else
      :icon="HardDrive"
      :title="Object.keys(params).length ? '没有匹配的卷' : '还没有持久卷'"
      :description="
        Object.keys(params).length
          ? '调整名称或归属筛选。'
          : '先在项目环境中创建卷，再将它加入服务的挂载草稿。'
      "
    /><Button
      type="button"
      v-if="volumes.hasNextPage.value"
      variant="outline"
      class="mt-5"
      :disabled="volumes.isFetchingNextPage.value"
      @click="volumes.fetchNextPage()"
      >{{ volumes.isFetchingNextPage.value ? '正在载入…' : '载入更多卷' }}</Button
    ></QueryState
  >
</template>
