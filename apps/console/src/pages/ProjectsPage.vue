<script setup lang="ts">
import { computed, ref } from 'vue';
import { Plus, Search, ArrowUpRight, Layers3, RefreshCw, FolderKanban, Package } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useCollection } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { dateTime } from '@/lib/utils';
import type { Project } from '@/lib/types';
const auth = useAuthStore();
const projects = useCollection<Project>('/projects');
const search = ref('');
const target = ref('');
const targets = computed(() => [
  ...new Map(
    projects.items.value.map((p) => [
      p.clusterId,
      { id: p.clusterId, name: p.cluster?.name ?? p.clusterId },
    ]),
  ).values(),
]);
const filtered = computed(() =>
  projects.items.value.filter(
    (p) =>
      (!target.value || p.clusterId === target.value) &&
      `${p.name} ${p.slug} ${p.description ?? ''}`
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
</script>
<template>
  <div class="page-head">
    <div>
      <h1>我的项目</h1>
      <p>把应用和它需要的数据库放在一起。</p>
    </div>
    <div class="actions">
      <Button variant="ghost" as-child
        ><RouterLink to="/settings?tab=resources"><Package />所有资源</RouterLink></Button
      >
      <Button
        variant="outline"
        size="icon"
        aria-label="刷新项目"
        :disabled="projects.isFetching.value"
        @click="projects.refetch()"
        ><RefreshCw /></Button
      ><Button v-if="!auth.restoreMode" as-child
        ><RouterLink to="/projects/new"><Plus />创建项目</RouterLink></Button
      >
    </div>
  </div>
  <QueryState
    :pending="projects.isPending.value"
    :error="projects.error.value"
    :refreshing="projects.isRefetching.value"
    @retry="projects.refetch()"
  >
    <template v-if="projects.items.value.length">
      <div class="project-toolbar">
        <p class="meta">
          <strong class="text-foreground">{{ projects.items.value.length }}</strong> 个已载入项目
        </p>
        <div class="filters">
          <div class="relative">
            <Search class="absolute left-3 top-3 size-4 text-muted-foreground" /><Input
              v-model="search"
              class="pl-10"
              aria-label="搜索已载入项目"
              placeholder="搜索已载入项目"
            />
          </div>
          <select v-model="target" class="input" aria-label="筛选承载目标">
            <option value="">全部承载目标</option>
            <option v-for="cluster in targets" :key="cluster.id" :value="cluster.id">
              {{ cluster.name }}
            </option>
          </select>
        </div>
      </div>
      <div v-if="filtered.length" class="project-grid">
        <RouterLink
          v-for="project in filtered"
          :key="project.id"
          :to="{ path: `/projects/${project.id}`, query: { openService: '1' } }"
          class="project-card"
        >
          <div class="flex items-start justify-between gap-3">
            <span class="project-letter">{{ project.name.slice(0, 1).toUpperCase() }}</span
            ><ArrowUpRight class="size-4 text-muted-foreground" />
          </div>
          <h2>{{ project.name }}</h2>
          <p class="project-description">{{ project.description || '尚未添加项目描述' }}</p>
          <div class="project-target">
            <Layers3 class="size-3.5" /><span>{{
              project.cluster?.name ?? project.clusterId
            }}</span>
          </div>
          <div class="project-card-foot">
            <StatusBadge
              :status="project.cluster?.connectionStatus"
              :observed-at="project.cluster?.lastObservedAt"
            /><time class="meta" :datetime="project.updatedAt">{{
              dateTime(project.updatedAt)
            }}</time>
          </div>
        </RouterLink>
      </div>
      <EmptyState v-else title="没有匹配的项目" description="调整关键词或承载目标筛选。"
        ><Button
          variant="outline"
          @click="
            search = '';
            target = '';
          "
          >清空筛选</Button
        ></EmptyState
      >
    </template>
    <div v-else-if="!projects.error.value" class="panel">
      <EmptyState
        :icon="FolderKanban"
        title="从第一个项目开始"
        description="选择一个部署位置，接着添加应用或数据库。"
        ><Button v-if="!auth.restoreMode" as-child
          ><RouterLink to="/projects/new"><Plus />创建项目</RouterLink></Button
        ></EmptyState
      >
    </div>
    <div v-if="projects.hasNextPage.value" class="mt-6 text-center">
      <Button
        variant="outline"
        :disabled="projects.isFetchingNextPage.value"
        @click="projects.fetchNextPage()"
        >{{ projects.isFetchingNextPage.value ? '正在载入…' : '载入更多项目' }}</Button
      >
    </div>
  </QueryState>
</template>
<style scoped>
.project-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.filters {
  display: flex;
  gap: 0.75rem;
}
.filters select {
  width: 12rem;
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
  gap: 1.25rem;
}
.project-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--card);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.project-card:hover {
  border-color: var(--input);
  box-shadow: 0 4px 14px oklch(25% 0.02 285 / 0.04);
}
.project-letter {
  display: grid;
  place-items: center;
  width: 2.5rem;
  height: 2.5rem;
  border: 1px solid var(--border);
  background: var(--secondary);
  border-radius: 0.625rem;
  font-weight: 600;
  color: var(--primary);
}
.project-card h2 {
  margin-top: 1.25rem;
  overflow-wrap: anywhere;
}
.project-description {
  font-size: 0.8125rem;
  color: var(--muted-foreground);
  margin-top: 0.375rem;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.project-target {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
  margin: 1.25rem 0;
}
.project-target span {
  overflow-wrap: anywhere;
}
.project-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  margin-top: auto;
}
.project-card-foot time {
  font-size: 0.75rem;
}
@media (max-width: 639px) {
  .filters {
    flex-direction: column;
    width: 100%;
  }
  .filters select {
    width: 100%;
  }
  .project-card {
    padding: 1.25rem;
  }
}
</style>
