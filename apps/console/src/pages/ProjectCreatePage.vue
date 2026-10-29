<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation } from '@tanstack/vue-query';
import { ChevronRight, Plus, Layers3, Check, Info, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { useCollection, invalidateCollection } from '@/lib/query';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { useAuthStore } from '@/stores/auth';
import { idempotencyKey, slugify } from '@/lib/utils';
import type { Cluster, Project } from '@/lib/types';
const isViewActive = useViewScope();
const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const auth = useAuthStore();
const clusters = useCollection<Cluster>('/clusters');
const form = reactive({
  clusterId: String(route.query.clusterId ?? ''),
  name: '',
  slug: '',
  description: '',
});
const { dirty, markClean } = useDirtyForm(form, '新项目');
const slugEdited = ref(false);
watch(
  () => form.name,
  (name) => {
    if (!slugEdited.value) form.slug = slugify(name);
  },
);
const selected = computed(() =>
  clusters.items.value.find((cluster) => cluster.id === form.clusterId),
);
const key = idempotencyKey();
const create = useMutation({
  mutationFn: () =>
    api.create<Project>(
      '/projects',
      { ...form, description: form.description.trim() || undefined },
      key,
    ),
  onSuccess: async (project) => {
    markClean();
    await invalidateCollection('/projects');
    if (!isViewActive()) return;
    ui.toast('项目已创建，production 环境已保存。');
    await router.push(`/projects/${project.id}`);
  },
});
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/projects" class="text-link">项目</RouterLink><ChevronRight /><span
      >创建项目</span
    >
  </nav>
  <div class="page-head">
    <div>
      <h1>创建项目</h1>
      <p>先选择承载目标，再填写项目信息。</p>
    </div>
    <span v-if="dirty" class="badge">尚未保存</span>
  </div>
  <div class="split">
    <form class="stack" @submit.prevent="create.mutate()">
      <section class="panel">
        <div class="section-head">
          <h2><span class="step-number">1</span>选择承载目标</h2>
          <Button v-if="!auth.restoreMode" as-child variant="outline" size="sm"
            ><RouterLink :to="{ path: '/clusters/new', query: { returnTo: '/projects/new' } }"
              ><Plus />登记集群</RouterLink
            ></Button
          >
        </div>
        <QueryState
          :pending="clusters.isPending.value"
          :error="clusters.error.value"
          @retry="clusters.refetch()"
        >
          <fieldset
            v-if="clusters.items.value.length"
            class="target-list"
            :disabled="create.isPending.value || auth.restoreMode"
          >
            <legend class="sr-only">选择一个已登记集群</legend>
            <label
              v-for="cluster in clusters.items.value"
              :key="cluster.id"
              :class="['target-option', { selected: form.clusterId === cluster.id }]"
              ><input
                v-model="form.clusterId"
                type="radio"
                name="cluster"
                :value="cluster.id"
                required />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <strong>{{ cluster.name }}</strong
                  ><span v-if="cluster.region" class="meta">{{ cluster.region }}</span>
                </div>
                <p class="meta mt-1">{{ cluster.slug }} · 集群登记</p>
              </div>
              <StatusBadge :status="cluster.connectionStatus" :observed-at="cluster.lastObservedAt"
            /></label>
          </fieldset>
          <EmptyState
            v-else-if="!clusters.error.value"
            :icon="Layers3"
            title="先登记一个承载目标"
            description="已登记但未验证的集群也可以保存项目资料。"
            ><Button v-if="!auth.restoreMode" as-child
              ><RouterLink :to="{ path: '/clusters/new', query: { returnTo: '/projects/new' } }"
                ><Plus />登记集群</RouterLink
              ></Button
            ></EmptyState
          >
          <Button
            v-if="clusters.hasNextPage.value"
            type="button"
            variant="ghost"
            :disabled="clusters.isFetchingNextPage.value"
            @click="clusters.fetchNextPage()"
            >载入更多目标</Button
          >
        </QueryState>
        <div v-if="selected" class="notice mt-4">
          <Info />
          <p>
            项目创建后固定使用 <strong>{{ selected.name }}</strong
            >，所有环境继承该目标。{{
              selected.connectionStatus === 'unverified' ? '连接与运行能力仍待验证。' : ''
            }}
          </p>
        </div>
      </section>
      <section class="panel">
        <h2 class="mb-6"><span class="step-number">2</span>项目信息</h2>
        <fieldset class="stack" :disabled="create.isPending.value || auth.restoreMode">
          <div class="form-grid">
            <div class="field">
              <label for="project-name">项目名称</label
              ><Input
                id="project-name"
                v-model="form.name"
                required
                maxlength="100"
                autocomplete="off"
                placeholder="例如：我的博客"
              />
            </div>
            <div class="field">
              <label for="project-slug">项目标识</label
              ><Input
                id="project-slug"
                v-model="form.slug"
                required
                maxlength="63"
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                autocomplete="off"
                placeholder="my-blog"
                aria-describedby="project-slug-hint"
                @input="slugEdited = true"
              />
              <p id="project-slug-hint" class="field-hint">
                小写字母、数字与连字符，保存后保持固定。
              </p>
            </div>
          </div>
          <div class="field">
            <label for="project-description">描述 <span class="meta">（选填）</span></label
            ><Textarea
              id="project-description"
              v-model="form.description"
              maxlength="1000"
              rows="3"
            />
          </div>
          <p class="meta flex items-center gap-2">
            <Check class="size-4" />一并创建默认 production 环境。
          </p>
        </fieldset>
        <MutationError class="mt-4" :error="create.error.value" />
        <div class="form-footer">
          <Button as-child variant="outline"><RouterLink to="/projects">取消</RouterLink></Button
          ><Button type="submit" :disabled="create.isPending.value || !selected || auth.restoreMode"
            ><LoaderCircle v-if="create.isPending.value" class="animate-spin" />{{
              create.isPending.value ? '正在创建…' : '创建项目'
            }}</Button
          >
        </div>
      </section>
    </form>
    <aside class="creation-aside">
      <Layers3 class="size-5 text-primary mb-4" />
      <h2>一个项目，一处承载目标</h2>
      <p class="mt-3 muted">production 与 staging 使用同一集群，分别保存各自的环境配置。</p>
      <div class="my-6 h-px bg-border" />
      <h3>需要不同集群？</h3>
      <p class="mt-2 muted">分别创建项目，让资源归属和操作范围保持清晰。</p>
    </aside>
  </div>
</template>
<style scoped>
.step-number {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  background: var(--accent);
  color: var(--primary);
  font-size: 0.75rem;
  margin-right: 0.75rem;
}
.target-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0;
  border: 0;
}
.target-option {
  display: flex;
  gap: 1rem;
  align-items: center;
  padding: 1.125rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  cursor: pointer;
}
.target-option.selected {
  border-color: var(--primary);
  background: var(--accent);
}
.target-option input {
  accent-color: var(--primary);
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}
.creation-aside {
  padding: 0.5rem 0.25rem;
  font-size: 0.8125rem;
}
.creation-aside h2 {
  font-size: 1rem;
}
@media (max-width: 639px) {
  .target-option {
    gap: 0.625rem;
    padding: 1rem 0.75rem;
    flex-wrap: wrap;
  }
  .target-option .badge {
    margin-left: 1.625rem;
  }
  .creation-aside {
    display: none;
  }
}
</style>
