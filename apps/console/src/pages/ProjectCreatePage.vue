<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation } from '@tanstack/vue-query';
import { ChevronRight, Plus, Layers3, Info, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import EmptyState from '@/components/EmptyState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api, ApiError } from '@/lib/api';
import { useCollection, invalidateCollection, queryClient } from '@/lib/query';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import {
  projectCreationNavigationLocked,
  useProjectCreationState,
} from '@/composables/useProjectCreationState';
import { useAuthStore } from '@/stores/auth';
import { idempotencyKey, resourceSlug } from '@/lib/utils';
import type { Cluster, Project } from '@/lib/types';
const isViewActive = useViewScope();
const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const auth = useAuthStore();
const clusters = useCollection<Cluster>('/clusters');
const key = idempotencyKey();
const suffix = key.replace(/-/g, '').slice(0, 6);
const form = reactive({
  clusterId: String(route.query.clusterId ?? ''),
  name: '',
  slug: resourceSlug('', suffix, 'project'),
  description: '',
});
const { dirty, markClean } = useDirtyForm(form, '新项目');
const slugEdited = ref(false);
watch(
  () => form.name,
  (name) => {
    if (!slugEdited.value) form.slug = resourceSlug(name, suffix, 'project');
  },
);
const selected = computed(() =>
  clusters.items.value.find((cluster) => cluster.id === form.clusterId),
);
const uncertain = ref(false);
const createdProject = ref<Project | null>(null);
const composing = ref(false);
let compositionEndedAt = 0;
let payload: typeof form | undefined;
watch(
  [clusters.items, clusters.isFetching],
  () => {
    if (
      !form.clusterId &&
      clusters.items.value.length === 1 &&
      !clusters.hasNextPage.value &&
      !clusters.error.value
    ) {
      form.clusterId = clusters.items.value[0]!.id;
      if (!form.name && !form.description && !slugEdited.value) markClean();
    } else if (
      form.clusterId &&
      !selected.value &&
      clusters.hasNextPage.value &&
      !clusters.isFetching.value &&
      !clusters.error.value
    ) {
      void clusters.fetchNextPage({ cancelRefetch: false });
    }
  },
  { immediate: true },
);
async function openFirstService(project: Project) {
  await router.push({
    path: `/projects/${project.id}/services/new`,
    query: { environment: 'production', first: '1' },
  });
}
const create = useMutation({
  mutationFn: async () => {
    const project = await api.create<Project>('/projects', payload!, key);
    if (
      !project ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(project.id) ||
      project.clusterId !== payload!.clusterId ||
      project.slug !== payload!.slug
    )
      throw new ApiError(0, {
        code: 'RESPONSE_UNCONFIRMED',
        detail: '项目创建结果不完整，请重试确认同一次创建。',
      });
    return project;
  },
  onSuccess: async (project) => {
    createdProject.value = project;
    uncertain.value = false;
    markClean();
    queryClient.setQueryData(['project', project.id], project);
    await invalidateCollection('/projects');
    if (!isViewActive()) return;
    ui.toast('项目已创建，添加第一个服务。');
    await openFirstService(project);
  },
  onError: (error) => {
    uncertain.value =
      !createdProject.value &&
      (!(error instanceof ApiError) || error.status === 0 || error.status >= 500);
  },
});
useProjectCreationState(
  () => create.isPending.value && !createdProject.value,
  () => uncertain.value && !createdProject.value,
);
function submit() {
  if (
    create.isPending.value ||
    auth.restoreMode ||
    (!selected.value && !uncertain.value && !createdProject.value) ||
    composing.value ||
    Date.now() - compositionEndedAt < 80
  )
    return;
  if (createdProject.value) {
    void openFirstService(createdProject.value);
    return;
  }
  if (!uncertain.value || !payload)
    payload = {
      ...form,
      name: form.name.trim() || `新项目 ${suffix.slice(0, 4)}`,
      description: form.description.trim(),
    };
  create.mutate();
}
function revealInvalid(event: Event) {
  let details = (event.target as HTMLElement).closest('details');
  while (details) {
    details.open = true;
    details = details.parentElement?.closest('details') ?? null;
  }
}
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
      <p>选择部署位置，创建后直接添加服务。</p>
    </div>
    <span v-if="dirty" class="badge">尚未保存</span>
  </div>
  <div class="max-w-3xl mx-auto">
    <form
      class="stack"
      @submit.prevent="submit"
      @invalid.capture="revealInvalid"
      @compositionstart="composing = true"
      @compositionend="
        composing = false;
        compositionEndedAt = Date.now();
      "
    >
      <section class="panel">
        <div class="section-head">
          <h2>选择部署位置</h2>
          <Button
            v-if="!auth.restoreMode"
            as-child
            variant="outline"
            size="sm"
            :disabled="projectCreationNavigationLocked"
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
            :disabled="create.isPending.value || uncertain || auth.restoreMode"
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
            ><Button v-if="!auth.restoreMode" as-child :disabled="projectCreationNavigationLocked"
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
            项目内的服务将部署到 <strong>{{ selected.name }}</strong
            >。{{ selected.connectionStatus === 'unverified' ? '连接与运行能力仍待验证。' : '' }}
          </p>
        </div>
      </section>
      <section class="panel">
        <fieldset class="stack" :disabled="create.isPending.value || uncertain || auth.restoreMode">
          <div class="field">
            <label for="project-name">项目名称 <span class="meta">（选填）</span></label
            ><Input
              id="project-name"
              v-model="form.name"
              maxlength="100"
              autocomplete="off"
              :placeholder="`新项目 ${suffix.slice(0, 4)}`"
            />
            <p class="field-hint">留空会使用默认名称，之后可以修改。</p>
          </div>
          <details class="advanced-project">
            <summary>更多设置</summary>
            <div class="stack mt-5">
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
              <div class="field">
                <label for="project-description">描述 <span class="meta">（选填）</span></label
                ><Textarea
                  id="project-description"
                  v-model="form.description"
                  maxlength="1000"
                  rows="3"
                />
              </div>
            </div>
          </details>
        </fieldset>
        <div v-if="uncertain" class="notice notice-warning mt-4">
          <Info />
          <p>创建结果暂未确认。重试会核对同一次请求，避免重复创建。</p>
        </div>
        <MutationError class="mt-4" :error="create.error.value" />
        <div class="form-footer">
          <Button
            type="button"
            variant="outline"
            :disabled="projectCreationNavigationLocked"
            @click="router.push('/projects')"
            >取消</Button
          ><Button
            type="submit"
            :disabled="
              create.isPending.value ||
              (!selected && !uncertain && !createdProject) ||
              auth.restoreMode
            "
            ><LoaderCircle v-if="create.isPending.value" class="animate-spin" />{{
              create.isPending.value
                ? '正在创建…'
                : uncertain
                  ? '重试确认创建结果'
                  : createdProject
                    ? '添加第一个服务'
                    : '创建项目'
            }}</Button
          >
        </div>
      </section>
    </form>
  </div>
</template>
<style scoped>
.advanced-project summary {
  cursor: pointer;
  color: var(--muted-foreground);
  padding: 0.5rem 0;
}
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
