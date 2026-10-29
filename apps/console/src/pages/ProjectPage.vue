<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useMutation } from '@tanstack/vue-query';
import {
  ChevronRight,
  Layers3,
  Plus,
  Pencil,
  Trash2,
  ArrowUpRight,
  Info,
  Check,
  LoaderCircle,
} from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import MutationError from '@/components/MutationError.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import ServiceCollection from '@/components/services/ServiceCollection.vue';
import { api } from '@/lib/api';
import { queryClient, useCollection, invalidateCollection } from '@/lib/query';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useUiStore } from '@/stores/ui';
import { useViewScope } from '@/composables/useViewScope';
import { useAuthStore } from '@/stores/auth';
import { dateTime, idempotencyKey } from '@/lib/utils';
import type { Project, Environment } from '@/lib/types';
const isViewActive = useViewScope();
const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const auth = useAuthStore();
const projectId = String(route.params.projectId);
const tab = computed(() =>
  route.query.tab === 'settings' || route.query.tab === 'environments'
    ? route.query.tab
    : 'overview',
);
const project = useQuery({
  queryKey: ['project', projectId],
  queryFn: ({ signal }) => api.get<Project>(`/projects/${projectId}`, signal),
});
const environments = useCollection<Environment>('/environments', { projectId });
const environmentSlug = computed(() =>
  typeof route.query.environment === 'string' ? route.query.environment : 'production',
);
const currentEnvironment = computed(() =>
  environments.items.value.find((environment) => environment.slug === environmentSlug.value),
);
const projectForm = reactive({ name: '', description: '', revision: 1 });
const projectGuard = useDirtyForm(projectForm, '项目资料');
const reloadingProject = ref(false);
watch(
  project.data,
  (value) => {
    if (value && !projectGuard.dirty.value) {
      Object.assign(projectForm, {
        name: value.name,
        description: value.description ?? '',
        revision: value.revision,
      });
      projectGuard.markClean();
    }
  },
  { immediate: true },
);
const saveProject = useMutation({
  mutationFn: () => api.update<Project>(`/projects/${projectId}`, projectForm),
  onSuccess: async (result) => {
    projectGuard.markClean();
    queryClient.setQueryData(['project', projectId], result);
    await invalidateCollection('/projects');
    if (!isViewActive()) return;
    ui.toast('项目资料已保存。');
  },
});
const removeProject = useMutation({
  mutationFn: (revision: number) => api.delete(`/projects/${projectId}`, revision),
  onSuccess: async () => {
    projectGuard.abandon();
    environmentGuard.abandon();
    await invalidateCollection('/projects');
    queryClient.removeQueries({ queryKey: ['project', projectId] });
    if (!isViewActive()) return;
    await router.push('/projects');
    ui.toast('项目登记已删除。');
  },
});
async function deleteProject() {
  if (!project.data.value) return;
  const reviewedRevision = project.data.value.revision;
  if (
    await ui.confirm({
      title: `删除项目「${project.data.value.name}」？`,
      description: '移除项目及其空环境登记。控制面会检查资源引用，所属集群登记保留。',
      confirmText: '删除项目',
      destructive: true,
    })
  )
    if (isViewActive()) removeProject.mutate(reviewedRevision);
}
const editorOpen = ref(false);
const editingEnvironment = ref<Environment | null>(null);
const environmentForm = reactive({ name: '', slug: '', description: '', revision: 1 });
let environmentKey = idempotencyKey();
const environmentGuard = useDirtyForm(
  () => (editorOpen.value ? environmentForm : null),
  '环境资料',
);
async function editEnvironment(environment?: Environment) {
  if (saveEnvironment.isPending.value) return;
  if (
    editorOpen.value &&
    environmentGuard.dirty.value &&
    !(await ui.confirm({
      title: '放弃当前环境编辑？',
      description: '当前环境有未保存的修改。',
      confirmText: '继续',
    }))
  )
    return;
  editingEnvironment.value = environment ?? null;
  Object.assign(environmentForm, {
    name: environment?.name ?? '',
    slug: environment?.slug ?? '',
    description: environment?.description ?? '',
    revision: environment?.revision ?? 1,
  });
  environmentKey = idempotencyKey();
  editorOpen.value = true;
  environmentGuard.markClean();
  saveEnvironment.reset();
  await nextTick();
  document.getElementById('environment-name')?.focus();
}
async function closeEditor() {
  if (saveEnvironment.isPending.value) return;
  if (
    environmentGuard.dirty.value &&
    !(await ui.confirm({
      title: '放弃环境修改？',
      description: '离开编辑后，未保存的内容需要重新填写。',
      confirmText: '放弃修改',
    }))
  )
    return;
  editorOpen.value = false;
  environmentGuard.markClean();
}
const saveEnvironment = useMutation({
  mutationFn: () =>
    editingEnvironment.value
      ? api.update<Environment>(`/environments/${editingEnvironment.value.id}`, {
          name: environmentForm.name,
          description: environmentForm.description,
          revision: environmentForm.revision,
        })
      : api.create<Environment>(
          '/environments',
          {
            name: environmentForm.name,
            slug: environmentForm.slug,
            description: environmentForm.description,
            projectId,
          },
          environmentKey,
        ),
  onSuccess: async () => {
    editorOpen.value = false;
    environmentGuard.markClean();
    await invalidateCollection('/environments');
    if (!isViewActive()) return;
    ui.toast(editingEnvironment.value ? '环境资料已保存。' : '环境已创建，继承项目的固定集群。');
  },
});
const removeEnvironment = useMutation({
  mutationFn: (environment: Environment) =>
    api.delete(`/environments/${environment.id}`, environment.revision),
  onSuccess: async (_, environment) => {
    await invalidateCollection('/environments');
    if (!isViewActive()) return;
    if (environment.slug === environmentSlug.value)
      await router.replace({
        path: route.path,
        query: { ...route.query, environment: 'production' },
      });
    ui.toast('环境已删除。');
  },
});
async function deleteEnvironment(environment: Environment) {
  if (
    await ui.confirm({
      title: `删除环境「${environment.name}」？`,
      description: `项目 ${project.data.value?.name} · ${environment.slug}。存在资源引用时控制面会拒绝删除。`,
      confirmText: '删除环境',
      destructive: true,
    })
  )
    if (isViewActive()) removeEnvironment.mutate(environment);
}
async function reloadProject() {
  if (saveProject.isPending.value || reloadingProject.value) return;
  if (
    projectGuard.dirty.value &&
    !(await ui.confirm({
      title: '载入最新项目资料？',
      description: '当前未保存修改将被服务器上的最新资料替换。',
      confirmText: '载入最新资料',
    }))
  )
    return;
  if (!isViewActive()) return;
  reloadingProject.value = true;
  try {
    const result = await project.refetch();
    if (result.data && isViewActive()) {
      Object.assign(projectForm, {
        name: result.data.name,
        description: result.data.description ?? '',
        revision: result.data.revision,
      });
      projectGuard.markClean();
      saveProject.reset();
    }
  } finally {
    reloadingProject.value = false;
  }
}
function tabLocation(value: string) {
  return {
    path: route.path,
    query: { ...route.query, tab: value === 'overview' ? undefined : value },
  };
}
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/projects" class="text-link">项目</RouterLink><ChevronRight /><span>{{
      project.data.value?.name ?? '项目工作区'
    }}</span
    ><ChevronRight /><span>{{ environmentSlug }}</span>
  </nav>
  <QueryState
    :pending="project.isPending.value"
    :error="project.error.value"
    @retry="project.refetch()"
  >
    <template v-if="project.data.value">
      <div class="page-head">
        <div>
          <h1>{{ project.data.value.name }}</h1>
          <p>{{ project.data.value.description || '管理当前环境的服务、部署与项目资料。' }}</p>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <Layers3 class="size-4 text-muted-foreground" /><RouterLink
              :to="`/clusters/${project.data.value.clusterId}`"
              class="text-link"
              >{{ project.data.value.cluster?.name ?? project.data.value.clusterId }}</RouterLink
            ><span class="meta">由项目固定继承</span
            ><StatusBadge
              :status="project.data.value.cluster?.connectionStatus"
              :observed-at="project.data.value.cluster?.lastObservedAt"
            />
          </div>
        </div>
      </div>
      <nav class="page-tabs" aria-label="项目页面">
        <RouterLink
          v-for="item in [
            { id: 'overview', label: '服务' },
            { id: 'environments', label: '环境' },
            { id: 'settings', label: '项目设置' },
          ]"
          :key="item.id"
          :to="tabLocation(item.id)"
          class="page-tab"
          :aria-current="tab === item.id ? 'page' : undefined"
          >{{ item.label }}</RouterLink
        >
      </nav>
      <div v-if="tab === 'overview'" class="stack">
        <QueryState
          :pending="environments.isPending.value"
          :error="environments.error.value"
          @retry="environments.refetch()"
        >
          <template v-if="currentEnvironment">
            <div class="environment-summary">
              <div class="flex flex-wrap items-center gap-3 min-w-0">
                <span class="environment-icon"><Layers3 class="size-5" /></span>
                <div class="min-w-0">
                  <h2 class="break-words">{{ currentEnvironment.name }}</h2>
                  <p class="meta">{{ currentEnvironment.slug }} · 继承项目集群</p>
                </div>
                <span v-if="currentEnvironment.slug === 'production'" class="badge">默认环境</span>
              </div>
              <Button variant="outline" size="sm" as-child
                ><RouterLink :to="tabLocation('environments')">管理环境<ArrowUpRight /></RouterLink
              ></Button>
            </div>
            <ServiceCollection
              :key="currentEnvironment.id"
              :project-id="projectId"
              :environment-id="currentEnvironment.id"
              :environment-slug="currentEnvironment.slug"
            />
            <details class="environment-details">
              <summary>环境资料</summary>
              <dl class="detail-list mt-5">
                <div>
                  <dt>所属项目</dt>
                  <dd>{{ project.data.value.name }}</dd>
                </div>
                <div>
                  <dt>承载集群</dt>
                  <dd>{{ project.data.value.cluster?.name ?? project.data.value.clusterId }}</dd>
                </div>
                <div>
                  <dt>创建时间</dt>
                  <dd>{{ dateTime(currentEnvironment.createdAt) }}</dd>
                </div>
                <div>
                  <dt>最近修改</dt>
                  <dd>{{ dateTime(currentEnvironment.updatedAt) }}</dd>
                </div>
              </dl>
            </details>
          </template>
          <div v-else-if="!environments.error.value" class="notice notice-warning">
            <Info />
            <div>
              <strong>当前环境不可用</strong>
              <p>链接中的 {{ environmentSlug }} 不在已载入的环境中。请在环境列表核对归属。</p>
              <div class="actions mt-3">
                <Button
                  v-if="environments.hasNextPage.value"
                  variant="outline"
                  :disabled="environments.isFetchingNextPage.value"
                  @click="environments.fetchNextPage()"
                  >载入更多环境</Button
                >
                <RouterLink :to="tabLocation('environments')" class="text-link"
                  >查看环境列表</RouterLink
                >
              </div>
            </div>
          </div>
        </QueryState>
      </div>
      <div v-else-if="tab === 'environments'" class="stack">
        <div class="section-head mb-0">
          <div>
            <h2>项目环境</h2>
            <p class="meta mt-1">
              所有环境继承
              {{
                project.data.value.cluster?.name ?? project.data.value.clusterId
              }}，不会独立选择集群。
            </p>
          </div>
          <Button
            v-if="!auth.restoreMode"
            :disabled="saveEnvironment.isPending.value"
            @click="editEnvironment()"
            ><Plus />创建环境</Button
          >
        </div>
        <MutationError :error="removeEnvironment.error.value" />
        <section v-if="editorOpen" class="panel">
          <h2 class="mb-5">{{ editingEnvironment ? '编辑环境' : '创建环境' }}</h2>
          <form @submit.prevent="saveEnvironment.mutate()">
            <fieldset :disabled="saveEnvironment.isPending.value || auth.restoreMode" class="stack">
              <div class="form-grid">
                <div class="field">
                  <label for="environment-name">环境名称</label
                  ><Input
                    id="environment-name"
                    v-model="environmentForm.name"
                    required
                    maxlength="100"
                    placeholder="例如：预发布"
                  />
                </div>
                <div class="field">
                  <label for="environment-slug">环境标识</label
                  ><Input
                    id="environment-slug"
                    v-model="environmentForm.slug"
                    :readonly="!!editingEnvironment"
                    required
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    maxlength="63"
                    placeholder="staging"
                    aria-describedby="environment-slug-hint"
                  />
                  <p id="environment-slug-hint" class="field-hint">
                    保存后保持固定，production 是默认环境。
                  </p>
                </div>
              </div>
              <div class="field">
                <label for="environment-description">描述 <span class="meta">（选填）</span></label
                ><Textarea
                  id="environment-description"
                  v-model="environmentForm.description"
                  rows="2"
                  maxlength="1000"
                />
              </div>
            </fieldset>
            <MutationError class="mt-4" :error="saveEnvironment.error.value" />
            <div class="form-footer">
              <Button
                type="button"
                variant="outline"
                :disabled="saveEnvironment.isPending.value"
                @click="closeEditor"
                >取消</Button
              ><Button type="submit" :disabled="saveEnvironment.isPending.value || auth.restoreMode"
                ><LoaderCircle v-if="saveEnvironment.isPending.value" class="animate-spin" />{{
                  saveEnvironment.isPending.value ? '正在保存…' : '保存环境'
                }}</Button
              >
            </div>
          </form>
        </section>
        <QueryState
          :pending="environments.isPending.value"
          :error="environments.error.value"
          :refreshing="environments.isRefetching.value"
          @retry="environments.refetch()"
          ><div v-if="environments.items.value.length" class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>环境</th>
                  <th>标识与归属</th>
                  <th class="mobile-hide">最近修改</th>
                  <th><span class="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="environment in environments.items.value" :key="environment.id">
                  <td>
                    <strong>{{ environment.name }}</strong
                    ><span v-if="environment.slug === 'production'" class="badge ml-2">默认</span>
                    <p v-if="environment.description" class="meta mt-1">
                      {{ environment.description }}
                    </p>
                  </td>
                  <td>
                    <code>{{ environment.slug }}</code>
                    <p class="meta">
                      {{ project.data.value.cluster?.name ?? project.data.value.clusterId }}
                    </p>
                  </td>
                  <td class="meta mobile-hide">{{ dateTime(environment.updatedAt) }}</td>
                  <td>
                    <div class="row-actions">
                      <Button
                        v-if="!auth.restoreMode"
                        variant="ghost"
                        size="icon"
                        :aria-label="`编辑环境 ${environment.name}`"
                        :disabled="saveEnvironment.isPending.value"
                        @click="editEnvironment(environment)"
                        ><Pencil /></Button
                      ><Button
                        v-if="environment.slug !== 'production' && !auth.restoreMode"
                        variant="ghost"
                        size="icon"
                        :aria-label="`删除环境 ${environment.name}`"
                        :disabled="removeEnvironment.isPending.value"
                        @click="deleteEnvironment(environment)"
                        ><Trash2
                      /></Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Button
            v-if="environments.hasNextPage.value"
            class="mt-4"
            variant="outline"
            :disabled="environments.isFetchingNextPage.value"
            @click="environments.fetchNextPage()"
            >载入更多环境</Button
          ></QueryState
        >
        <p class="meta flex items-center gap-2">
          <Check class="size-4" />默认 production 环境保留，名称可以修改。
        </p>
      </div>
      <div v-else class="stack max-w-4xl">
        <section class="panel">
          <div class="section-head">
            <h2>项目资料</h2>
            <span v-if="projectGuard.dirty.value" class="badge">尚未保存</span>
          </div>
          <form @submit.prevent="saveProject.mutate()">
            <fieldset
              class="stack"
              :disabled="saveProject.isPending.value || reloadingProject || auth.restoreMode"
            >
              <div class="form-grid">
                <div class="field">
                  <label for="edit-project-name">项目名称</label
                  ><Input
                    id="edit-project-name"
                    v-model="projectForm.name"
                    required
                    maxlength="100"
                  />
                </div>
                <div class="field">
                  <label for="edit-project-slug">项目标识</label
                  ><Input id="edit-project-slug" :model-value="project.data.value.slug" readonly />
                </div>
              </div>
              <div class="field">
                <label for="edit-project-description">描述</label
                ><Textarea
                  id="edit-project-description"
                  v-model="projectForm.description"
                  maxlength="1000"
                  rows="3"
                />
              </div>
              <dl class="detail-list">
                <div>
                  <dt>固定承载目标</dt>
                  <dd>{{ project.data.value.cluster?.name ?? project.data.value.clusterId }}</dd>
                </div>
              </dl>
            </fieldset>
            <div
              v-if="project.data.value.revision !== projectForm.revision"
              class="notice notice-warning mt-4"
            >
              <Info />
              <p>服务器上有较新版本。请先载入最新资料，再核对修改。</p>
            </div>
            <MutationError class="mt-4" :error="saveProject.error.value" />
            <div class="form-footer">
              <Button
                type="button"
                variant="outline"
                :disabled="saveProject.isPending.value || reloadingProject"
                @click="reloadProject"
                >载入最新资料</Button
              ><Button
                type="submit"
                :disabled="
                  !projectGuard.dirty.value ||
                  saveProject.isPending.value ||
                  reloadingProject ||
                  auth.restoreMode
                "
                >{{ saveProject.isPending.value ? '正在保存…' : '保存项目资料' }}</Button
              >
            </div>
          </form>
        </section>
        <section class="panel">
          <h2>删除项目</h2>
          <p class="muted mt-2 mb-5">
            移除项目登记前，会检查项目内的资源与环境。承载集群保持登记。
          </p>
          <MutationError class="mb-4" :error="removeProject.error.value" /><Button
            variant="destructive"
            :disabled="removeProject.isPending.value || auth.restoreMode"
            @click="deleteProject"
            ><Trash2 />{{ removeProject.isPending.value ? '正在删除…' : '删除项目' }}</Button
          >
        </section>
      </div>
    </template>
  </QueryState>
</template>
<style scoped>
.environment-icon {
  display: grid;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  background: var(--accent);
  color: var(--primary);
  border-radius: 0.75rem;
}
.environment-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}
.environment-details {
  border-top: 1px solid var(--border);
  padding-top: 1rem;
}
.environment-details summary {
  cursor: pointer;
  padding: 0.5rem 0;
  color: var(--muted-foreground);
}
</style>
