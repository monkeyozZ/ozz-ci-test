<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Package, Search, GitBranch } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EmptyState from '@/components/EmptyState.vue';
import QueryState from '@/components/QueryState.vue';
import TemplateGallery from '@/components/storage/TemplateGallery.vue';
import StorageTargetPicker from '@/components/storage/StorageTargetPicker.vue';
import type { Template } from '@/components/storage/types';
import { useCollection } from '@/lib/query';
import type { Project, Environment } from '@/lib/types';
const route = useRoute();
const query = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const inProject = computed(() => typeof route.params.projectId === 'string');
const selection = ref({
  projectId: String(route.params.projectId || query('projectId')),
  environmentId: query('environmentId'),
});
const context = ref<{ project: Project; environment: Environment } | null>(null);
const search = ref('');
const category = ref(query('category'));
const params = computed<Record<string, string>>(() => ({
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
  ...(category.value ? { category: category.value } : {}),
}));
const templates = useCollection<Template>('/templates', params);
</script>
<template>
  <div class="page-head">
    <div>
      <h1>{{ inProject ? '添加服务' : '服务模板' }}</h1>
      <p>选择服务模板或 GitHub 来源，先保存配置草稿，再审阅发布到项目环境。</p>
    </div>
  </div>
  <section class="panel mb-7">
    <h2 class="mb-5">选择项目与环境</h2>
    <StorageTargetPicker
      v-model="selection"
      :project-locked="inProject"
      :environment-slug="inProject ? query('environment') || 'production' : undefined"
      @context="context = $event"
    />
  </section>
  <div class="section-head mb-6">
    <div>
      <h2>从 GitHub 构建应用</h2>
      <p class="meta mt-1">选择授权仓库、Dockerfile 和独立 Builder。</p>
    </div>
    <Button v-if="context" as-child variant="outline"
      ><RouterLink
        :to="{
          path: '/projects/' + context.project.id + '/services/new',
          query: { environment: context.environment.slug, source: 'github' },
        }"
        ><GitBranch />从 GitHub 添加</RouterLink
      ></Button
    >
    <p v-else class="meta">先选择项目与环境。</p>
  </div>
  <div class="section-head">
    <div class="relative w-full max-w-lg">
      <Search class="absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true" /><Input
        v-model="search"
        class="pl-10"
        placeholder="搜索模板"
        aria-label="搜索模板"
      />
    </div>
    <select v-model="category" class="input w-auto" aria-label="模板类别">
      <option value="">全部模板</option>
      <option value="application">应用</option>
      <option value="database">数据库</option>
    </select>
  </div>
  <QueryState
    :pending="templates.isPending.value"
    :error="templates.error.value"
    @retry="templates.refetch()"
    ><TemplateGallery
      v-if="templates.items.value.length"
      :templates="templates.items.value"
      :project-id="selection.projectId"
      :environment-id="selection.environmentId"
      :environment-slug="context?.environment.slug"
      :in-project="inProject"
    /><EmptyState
      v-else
      :icon="Package"
      title="没有匹配的模板"
      description="调整名称或类别筛选。"
    /><Button
      type="button"
      v-if="templates.hasNextPage.value"
      variant="outline"
      class="mt-5"
      :disabled="templates.isFetchingNextPage.value"
      @click="templates.fetchNextPage()"
      >载入更多模板</Button
    ></QueryState
  >
  <p v-if="inProject" class="meta mt-7">
    需要逐项配置镜像、探针或环境变量？<RouterLink
      :to="{
        path: route.path,
        query: {
          environment: context?.environment.slug || query('environment') || 'production',
          source: 'image',
        },
      }"
      class="text-link ml-1"
      >打开镜像配置表单</RouterLink
    >
  </p>
</template>
