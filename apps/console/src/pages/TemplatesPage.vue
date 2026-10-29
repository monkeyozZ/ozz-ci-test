<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Package, Search, GitBranch, Box, Database, ChevronRight, HardDrive } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import EmptyState from '@/components/EmptyState.vue';
import QueryState from '@/components/QueryState.vue';
import StorageTargetPicker from '@/components/storage/StorageTargetPicker.vue';
import ServiceCreationFrame from '@/components/services/ServiceCreationFrame.vue';
import type { CreationContext } from '@/components/services/creation-state';
import type { Template } from '@/components/storage/types';
import { useCollection } from '@/lib/query';
import { useServiceCreationContext } from '@/composables/useServiceCreationContext';
import { creationStepQuery, withoutCreationQuery } from '@/composables/useCreationDialogState';

const route = useRoute();
const query = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const inProject = computed(() => typeof route.params.projectId === 'string');
const showTemplates = computed(
  () => !inProject.value || route.query.source === 'template' || route.query.category != null,
);
const selection = ref({
  projectId: String(route.params.projectId || query('projectId')),
  environmentId: query('environmentId'),
});
const selectedContext = ref<CreationContext | null>(null);
const place = useServiceCreationContext(() => ({
  projectId: inProject.value ? String(route.params.projectId) : '',
  environmentId: query('environmentId') || undefined,
  environmentSlug: route.query.environment == null ? 'production' : query('environment'),
  invalid: ['environment', 'environmentId'].some(
    (key) => route.query[key] != null && typeof route.query[key] !== 'string',
  ),
}));
const context = computed(() => (inProject.value ? place.context.value : selectedContext.value));
const search = ref('');
const category = ref(query('category') || (inProject.value ? 'database' : ''));
const params = computed<Record<string, string>>(() => ({
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
  ...(category.value ? { category: category.value } : {}),
}));
const templates = useCollection<Template>('/templates', params, showTemplates);
const sourceLocation = (source?: string, selectedCategory?: string) => ({
  path: inProject.value ? route.path : `/projects/${context.value?.project.id}`,
  query: creationStepQuery(inProject.value ? route.query : {}, {
    environment: context.value?.environment.slug || query('environment') || 'production',
    ...(source ? { source } : {}),
    ...(selectedCategory ? { category: selectedCategory } : {}),
  }),
});
const backTo = computed(() =>
  inProject.value
    ? showTemplates.value
      ? sourceLocation()
      : {
          path: route.path,
          query: withoutCreationQuery(route.query),
        }
    : '/settings',
);
function templateLocation(template: Template) {
  return inProject.value && context.value
    ? {
        path: route.path,
        query: creationStepQuery(route.query, {
          source: 'template',
          category: template.category,
          template: template.id,
          version: template.version,
          environment: context.value.environment.slug,
        }),
      }
    : {
        path: `/templates/${template.id}`,
        query: {
          version: template.version,
          projectId: selection.value.projectId || undefined,
          environmentId: selection.value.environmentId || undefined,
        },
      };
}
function moveSource(event: KeyboardEvent) {
  if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const links = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLAnchorElement>('.source-option'),
  );
  const index = links.indexOf(document.activeElement as HTMLAnchorElement);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? links.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
  event.preventDefault();
  links[next]?.focus();
}
</script>
<template>
  <ServiceCreationFrame
    :title="
      !showTemplates
        ? route.query.first === '1'
          ? '添加第一个服务'
          : '添加服务'
        : inProject
          ? '选择服务模板'
          : '服务模板'
    "
    :context="context"
    :show-environment="inProject ? place.showEnvironment.value : !!context"
    :back-to="backTo"
    :back-label="
      inProject
        ? showTemplates
          ? '选择来源'
          : route.params.serviceId
            ? '返回服务'
            : '返回项目'
        : '返回设置'
    "
  >
    <QueryState
      :pending="inProject && place.pending.value"
      :error="inProject ? place.error.value : null"
      @retry="place.refetch()"
    >
      <template v-if="!inProject || context">
        <div v-if="!showTemplates && context" class="source-options panel" @keydown="moveSource">
          <RouterLink :to="sourceLocation('github')" class="source-option">
            <GitBranch class="source-icon" />
            <div>
              <strong>从 GitHub 部署</strong>
              <p>选择仓库与分支，使用 Dockerfile 构建。</p>
            </div>
            <ChevronRight />
          </RouterLink>
          <RouterLink :to="sourceLocation('image')" class="source-option">
            <Box class="source-icon" />
            <div>
              <strong>部署 Docker 镜像</strong>
              <p>填写镜像地址与应用端口。</p>
            </div>
            <ChevronRight />
          </RouterLink>
          <RouterLink :to="sourceLocation('template', 'database')" class="source-option">
            <Database class="source-icon" />
            <div>
              <strong>添加数据库</strong>
              <p>选择数据库模板，配置持久化存储。</p>
            </div>
            <ChevronRight />
          </RouterLink>
          <RouterLink :to="sourceLocation('template', 'application')" class="source-option">
            <Package class="source-icon" />
            <div>
              <strong>使用应用模板</strong>
              <p>从 Docker、Node.js 或静态网站示例开始。</p>
            </div>
            <ChevronRight />
          </RouterLink>
        </div>
        <template v-else-if="showTemplates">
          <section v-if="!inProject" class="panel mb-7">
            <h2 class="mb-5">部署到</h2>
            <StorageTargetPicker v-model="selection" @context="selectedContext = $event" />
          </section>
          <div class="section-head mb-5">
            <div class="relative w-full max-w-lg">
              <Search
                class="absolute left-3 top-3 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input v-model="search" class="pl-10" placeholder="搜索模板" aria-label="搜索模板" />
            </div>
            <select v-model="category" class="input w-auto" aria-label="模板类别">
              <option value="database">数据库</option>
              <option value="application">应用</option>
              <option value="">全部模板</option>
            </select>
          </div>
          <QueryState
            :pending="templates.isPending.value"
            :error="templates.error.value"
            @retry="templates.refetch()"
          >
            <div v-if="templates.items.value.length" class="template-list" data-template-gallery>
              <article
                v-for="template in templates.items.value"
                :key="`${template.id}:${template.version}`"
                class="template-option"
              >
                <Database v-if="template.category === 'database'" class="source-icon" />
                <Package v-else class="source-icon" />
                <div>
                  <h2>
                    <RouterLink :to="templateLocation(template)" class="text-link">{{
                      template.name
                    }}</RouterLink>
                  </h2>
                  <p>{{ template.description }}</p>
                  <span class="template-meta"
                    >v{{ template.version
                    }}<template v-if="template.persistent"><HardDrive />持久化存储</template></span
                  >
                </div>
                <RouterLink
                  :to="templateLocation(template)"
                  class="template-select text-link"
                  :aria-label="`使用 ${template.name} 模板`"
                >
                  选择<ChevronRight />
                </RouterLink>
              </article>
            </div>
            <EmptyState
              v-else
              :icon="Package"
              title="没有匹配的模板"
              description="调整名称或类别筛选。"
            />
            <Button
              v-if="templates.hasNextPage.value"
              type="button"
              variant="outline"
              class="mt-5"
              :disabled="templates.isFetchingNextPage.value"
              @click="templates.fetchNextPage()"
              >载入更多模板</Button
            >
          </QueryState>
          <p v-if="!inProject && context" class="meta mt-6">
            也可以<RouterLink :to="sourceLocation('github')" class="text-link mx-1"
              >从 GitHub 部署</RouterLink
            >或<RouterLink :to="sourceLocation('image')" class="text-link ml-1"
              >部署 Docker 镜像</RouterLink
            >。
          </p>
        </template>
      </template>
    </QueryState>
  </ServiceCreationFrame>
</template>
<style scoped>
.source-options {
  padding: 0 1.5rem;
}
.source-option {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) 1rem;
  align-items: center;
  gap: 1rem;
  padding: 1.625rem 0;
}
.source-option + .source-option {
  border-top: 1px solid var(--border);
}
.source-option strong {
  display: block;
  font-size: 1rem;
  font-weight: 600;
}
.source-option p,
.template-option p {
  margin-top: 0.4rem;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.source-option:hover strong {
  color: var(--primary);
}
.source-icon {
  width: 1.375rem;
  height: 1.375rem;
  color: var(--primary);
}
.source-option > svg:last-child,
.template-select svg {
  width: 1rem;
  height: 1rem;
  color: var(--muted-foreground);
}
.template-list {
  border-top: 1px solid var(--border);
}
.template-option {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: start;
  padding: 1.5rem 0;
  border-bottom: 1px solid var(--border);
}
.template-option h2 {
  font-size: 1rem;
}
.template-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.625rem;
  margin-top: 0.625rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.template-meta svg {
  width: 0.875rem;
  height: 0.875rem;
}
.template-select {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 2.75rem;
  font-size: 0.875rem;
}
@media (max-width: 639px) {
  .source-options {
    padding: 0 1rem;
  }
  .source-option {
    gap: 0.75rem;
  }
  .template-option {
    grid-template-columns: 1.5rem minmax(0, 1fr);
    gap: 0.75rem;
  }
  .template-select {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
