<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { ChevronRight, Layers3, LoaderCircle, ArrowRight, Info } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import ServiceConfigurationEditor from '@/components/services/ServiceConfigurationEditor.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import {
  draftConfiguration,
  serviceDraft,
  serviceLocation,
} from '@/components/services/presentation';
import type { Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { invalidateCollection, queryClient, useCollection } from '@/lib/query';
import { slugify } from '@/lib/utils';
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
  queryFn: ({ signal }) => api.get<Project>(`/projects/${projectId}`, signal),
});
const environments = useCollection<Environment>('/environments', { projectId });
const environment = computed(() =>
  environments.items.value.find((value) => value.slug === environmentSlug.value),
);
const form = ref(serviceDraft());
const guard = useDirtyForm(form, '新服务配置');
const localError = ref<Error | null>(null);
const editor = ref<InstanceType<typeof ServiceConfigurationEditor>>();
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
  mutationFn: (input: {
    environmentId: string;
    projectId: string;
    name: string;
    slug: string;
    description: string;
    registryCredentialRefId: string | null;
    configuration: ReturnType<typeof draftConfiguration>;
  }) => api.create<Service>('/services', input),
  onSuccess: async (service) => {
    form.value = serviceDraft(service);
    guard.markClean();
    queryClient.setQueryData(['service', service.id], service);
    await invalidateCollection('/services');
    if (!active()) return;
    await router.push(serviceLocation(service, 'review'));
  },
});
async function submit() {
  if (!environment.value || save.isPending.value || auth.restoreMode) return;
  localError.value = null;
  if (editor.value?.validate && !(await editor.value.validate())) return;
  try {
    save.mutate({
      environmentId: environment.value.id,
      projectId,
      name: form.value.name.trim(),
      slug: form.value.slug,
      description: form.value.description,
      registryCredentialRefId: form.value.registryCredentialRefId || null,
      configuration: draftConfiguration(form.value),
    });
  } catch (error) {
    localError.value = error instanceof Error ? error : new Error('请检查配置。');
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
    <RouterLink to="/projects" class="text-link">项目</RouterLink><ChevronRight /><RouterLink
      :to="{ path: `/projects/${projectId}`, query: { environment: environmentSlug } }"
      class="text-link"
      >{{ project.data.value?.name || '所属项目' }}</RouterLink
    ><ChevronRight /><span>{{ environmentSlug }}</span
    ><ChevronRight /><span>添加服务</span>
  </nav>
  <div class="page-head">
    <div>
      <h1>从镜像添加服务</h1>
      <p>先保存配置，再审阅并发布到当前项目环境。</p>
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
      <div class="service-placement mb-6">
        <span class="badge badge-primary"
          >{{ project.data.value.name }} / {{ environment.name }}</span
        ><Layers3 class="size-4" /><RouterLink
          :to="`/clusters/${project.data.value.clusterId}`"
          class="text-link"
          >{{ project.data.value.cluster.name }}</RouterLink
        ><span class="meta">来自项目</span
        ><StatusBadge
          :status="project.data.value.cluster.connectionStatus"
          :observed-at="project.data.value.cluster.lastObservedAt"
        />
      </div>
      <div
        v-if="project.data.value.cluster.connectionStatus === 'unverified'"
        class="notice notice-warning mb-6"
      >
        <Info />
        <p>
          集群尚未验证，可以先填写配置；保存服务前请完成<RouterLink
            :to="`/clusters/${project.data.value.clusterId}`"
            class="text-link"
            >集群连接</RouterLink
          >。
        </p>
      </div>
      <form class="panel" novalidate @submit.prevent="submit">
        <ServiceConfigurationEditor
          ref="editor"
          v-model="form"
          creating
          :disabled="save.isPending.value || auth.restoreMode"
        /><ServiceMutationError class="mt-6" :error="localError || save.error.value" />
        <div class="form-footer">
          <Button as-child variant="outline"
            ><RouterLink
              :to="{ path: `/projects/${projectId}`, query: { environment: environmentSlug } }"
              >返回项目</RouterLink
            ></Button
          ><Button
            type="submit"
            :disabled="
              save.isPending.value ||
              auth.restoreMode ||
              project.data.value.cluster.connectionStatus === 'unverified'
            "
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
              save.isPending.value ? '正在保存…' : '保存并预览发布'
            }}<ArrowRight v-if="!save.isPending.value"
          /></Button>
        </div>
      </form>
    </template>
    <div v-else class="notice notice-warning">
      <Info />
      <div>
        <strong>当前环境不可用</strong>
        <p>链接中的环境不属于已载入的项目环境，请先核对后再创建服务。</p>
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
<style scoped>
.service-placement {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.625rem;
}
</style>
