<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Database as DatabaseIcon, Plus, Search, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import DatabaseList from '@/components/storage/DatabaseList.vue';
import StorageScopeFilters from '@/components/storage/StorageScopeFilters.vue';
import type { Database } from '@/components/storage/types';
import { useCollection } from '@/lib/query';
import { useRouteFilter } from '@/composables/useRouteFilter';
const route = useRoute();
const router = useRouter();
const value = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const search = useRouteFilter('search');
const params = computed<Record<string, string>>(() => ({
  ...Object.fromEntries(
    ['projectId', 'environmentId', 'clusterId', 'serviceId'].flatMap((key) =>
      value(key) ? [[key, value(key)]] : [],
    ),
  ),
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
}));
const databases = useCollection<Database>('/databases', params, true, { refetchInterval: 15_000 });
function filter(key: string, next: string) {
  void router.replace({
    path: '/databases',
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
      <h1>数据库</h1>
      <p>检查数据库认证、数据保护和应用依赖。原服务删除后，保留的数据身份仍在这里。</p>
    </div>
    <Button as-child
      ><RouterLink
        :to="{
          path: '/templates',
          query: {
            category: 'database',
            projectId: value('projectId') || undefined,
            environmentId: value('environmentId') || undefined,
          },
        }"
        ><Plus />添加数据库</RouterLink
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
        aria-label="搜索数据库"
        placeholder="搜索数据库或数据卷名称"
      />
    </div>
    <div class="actions">
      <p class="meta">已载入 {{ databases.items.value.length }} 个数据库</p>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="刷新数据库列表"
        :disabled="databases.isFetching.value"
        @click="databases.refetch()"
        ><RefreshCw
      /></Button>
    </div>
  </div>
  <QueryState
    :pending="databases.isPending.value"
    :error="databases.error.value"
    :refreshing="databases.isFetching.value"
    @retry="databases.refetch()"
    ><DatabaseList
      v-if="databases.items.value.length"
      :databases="databases.items.value"
      :list-path="route.fullPath"
    /><EmptyState
      v-else-if="!databases.error.value"
      :icon="DatabaseIcon"
      :title="Object.keys(params).length ? '没有匹配的数据库' : '还没有数据库'"
      :description="
        Object.keys(params).length
          ? '调整名称或归属筛选。'
          : '使用 PostgreSQL 或 Redis 模板创建私有数据库，保存后再审阅发布。'
      "
    /><Button
      type="button"
      v-if="databases.hasNextPage.value"
      variant="outline"
      class="mt-5"
      :disabled="databases.isFetchingNextPage.value"
      @click="databases.fetchNextPage()"
      >{{ databases.isFetchingNextPage.value ? '正在载入…' : '载入更多数据库' }}</Button
    ></QueryState
  >
</template>
