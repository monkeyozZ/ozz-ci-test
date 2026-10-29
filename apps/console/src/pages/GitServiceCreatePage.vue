<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { ChevronRight, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import ServiceConfigurationEditor from '@/components/services/ServiceConfigurationEditor.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import GitSourceEditor from '@/components/git/GitSourceEditor.vue';
import { sourceDraft, sourceInput } from '@/components/git/presentation';
import {
  draftRuntimeConfiguration,
  serviceDraft,
  serviceLocation,
} from '@/components/services/presentation';
import type { CreateServiceInput, Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { invalidateCollection, queryClient, useCollection } from '@/lib/query';
import { idempotencyKey, slugify } from '@/lib/utils';
import type { Environment, Project } from '@/lib/types';
import { useAuthStore } from '@/stores/auth';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const active = useViewScope();
const projectId = String(route.params.projectId);
const environmentSlug = computed(() =>
  typeof route.query.environment === 'string' ? route.query.environment : 'production',
);
const project = useQuery({
  queryKey: ['project', projectId],
  queryFn: ({ signal }) => api.get<Project>('/projects/' + projectId, signal),
});
const environments = useCollection<Environment>('/environments', { projectId });
const environment = computed(() =>
  environments.items.value.find((value) => value.slug === environmentSlug.value),
);
const form = ref(serviceDraft());
const git = ref(sourceDraft());
const guard = useDirtyForm(() => ({ configuration: form.value, source: git.value }), '新 Git 服务');
const localError = ref<Error | null>(null);
const editor = ref<InstanceType<typeof ServiceConfigurationEditor>>();
const sourceEditor = ref<InstanceType<typeof GitSourceEditor>>();
const key = idempotencyKey();
let generatedSlug = '';
watch(
  () => form.value.name,
  (name) => {
    if (!form.value.slug || form.value.slug === generatedSlug) {
      generatedSlug = slugify(name);
      form.value.slug = generatedSlug;
    }
  },
);
const save = useMutation({
  gcTime: 0,
  mutationFn: (input: CreateServiceInput) => api.create<Service>('/services', input, key),
  onSuccess: async (service) => {
    guard.markClean();
    queryClient.setQueryData(['service', service.id], service);
    await invalidateCollection('/services');
    if (active()) await router.push(serviceLocation(service, 'review'));
  },
});
async function submit() {
  if (!environment.value || save.isPending.value || auth.restoreMode) return;
  localError.value = null;
  try {
    if (!(await editor.value?.validate()) || !(await sourceEditor.value?.validate())) return;
    save.mutate({
      environmentId: environment.value.id,
      projectId,
      name: form.value.name.trim(),
      slug: form.value.slug,
      description: form.value.description,
      source: sourceInput(git.value),
      configuration: draftRuntimeConfiguration(form.value),
    });
  } catch (error) {
    localError.value = error instanceof Error ? error : new Error('请检查来源与运行配置。');
    await nextTick();
    document.querySelector<HTMLElement>('[data-mutation-error]')?.focus();
  }
}
onScopeDispose(() => {
  for (const variable of form.value.variables) if (variable.mode === 'secret') variable.value = '';
});
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink to="/projects" class="text-link">项目</RouterLink><ChevronRight />
    <RouterLink
      :to="{ path: '/projects/' + projectId, query: { environment: environmentSlug } }"
      class="text-link"
      >{{ project.data.value?.name || '所属项目' }}</RouterLink
    >
    <ChevronRight /><span>{{ environmentSlug }}</span
    ><ChevronRight /><span>GitHub 服务</span>
  </nav>
  <div class="page-head">
    <div>
      <h1>从 GitHub 添加服务</h1>
      <p>选择授权来源和显式 Dockerfile，先保存草稿，再审阅固定提交。</p>
    </div>
  </div>
  <QueryState
    :pending="project.isPending.value || environments.isPending.value"
    :error="project.error.value || environments.error.value"
    @retry="
      project.refetch();
      environments.refetch();
    "
  >
    <template v-if="project.data.value && environment">
      <p class="meta mb-5">
        {{ project.data.value.name }} / {{ environment.name }} →
        {{ project.data.value.cluster.name }} · 目标来自项目
      </p>
      <form class="stack" novalidate @submit.prevent="submit">
        <section class="panel">
          <h2 class="mb-5">服务与运行配置</h2>
          <ServiceConfigurationEditor
            ref="editor"
            v-model="form"
            creating
            source-kind="github"
            :disabled="save.isPending.value || auth.restoreMode"
          />
        </section>
        <section class="panel">
          <GitSourceEditor
            ref="sourceEditor"
            v-model="git"
            creating
            :disabled="save.isPending.value || auth.restoreMode"
          />
        </section>
        <ServiceMutationError :error="localError || save.error.value" />
        <div class="form-footer">
          <Button as-child variant="outline"
            ><RouterLink
              :to="{ path: '/projects/' + projectId, query: { environment: environmentSlug } }"
              >返回项目</RouterLink
            ></Button
          >
          <Button type="submit" :disabled="save.isPending.value || auth.restoreMode"
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
              save.isPending.value ? '正在保存…' : '保存 Git 服务并进入预览'
            }}</Button
          >
        </div>
      </form>
    </template>
    <div v-else class="notice notice-warning">
      <div>
        <strong>当前环境不可用</strong>
        <p>请核对当前项目的环境后再创建服务。</p>
        <Button
          v-if="environments.hasNextPage.value"
          variant="outline"
          class="mt-3"
          @click="environments.fetchNextPage()"
          >载入更多环境</Button
        >
      </div>
    </div>
  </QueryState>
</template>
