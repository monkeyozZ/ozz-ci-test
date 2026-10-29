<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { ChevronRight, ArrowRight, LoaderCircle, Eye } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import StorageTargetPicker from '@/components/storage/StorageTargetPicker.vue';
import StorageMutationError from '@/components/storage/StorageMutationError.vue';
import TemplateDetails from '@/components/storage/TemplateDetails.vue';
import TemplateParameterEditor from '@/components/storage/TemplateParameterEditor.vue';
import TemplateConfigurationPreview from '@/components/storage/TemplateConfigurationPreview.vue';
import { templateDraft, templateParameters } from '@/components/storage/presentation';
import { invalidateStorage } from '@/components/storage/queries';
import type {
  Template,
  TemplatePreview,
  TemplatePreviewInput,
  TemplateSelection,
} from '@/components/storage/types';
import type { Service } from '@/components/services/types';
import { serviceLocation } from '@/components/services/presentation';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';
import type { Project, Environment } from '@/lib/types';
import { slugify, idempotencyKey } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const active = useViewScope();
const query = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const templateId = String(route.params.templateId || query('template'));
const inProject = typeof route.params.projectId === 'string';
const selection = ref({
  projectId: String(route.params.projectId || query('projectId')),
  environmentId: query('environmentId'),
});
const context = ref<{ project: Project; environment: Environment } | null>(null);
const template = useQuery({
  queryKey: ['template', templateId, query('version')],
  queryFn: ({ signal }) =>
    api.get<Template>(
      `/templates/${encodeURIComponent(templateId)}${query('version') ? `?version=${encodeURIComponent(query('version'))}` : ''}`,
      signal,
    ),
});
const form = ref({ name: '', slug: '', description: '', parameters: {} as Record<string, string> });
const guard = useDirtyForm(form, '模板服务配置');
const formElement = ref<HTMLFormElement>();
const localError = ref<Error | null>(null);
let initialized = false;
let generatedSlug = '';
watch(
  template.data,
  (value) => {
    if (value && !initialized) {
      initialized = true;
      form.value.parameters = templateDraft(value);
      guard.markClean();
    }
  },
  { immediate: true },
);
watch(
  () => form.value.name,
  (name) => {
    if (!form.value.slug || form.value.slug === generatedSlug) {
      generatedSlug = slugify(name);
      form.value.slug = generatedSlug;
    }
  },
);
const fingerprint = computed(() =>
  JSON.stringify({
    templateId,
    version: template.data.value?.version,
    selection: selection.value,
    parameters: form.value.parameters,
  }),
);
const reviewed = ref<{
  value: TemplatePreview;
  fingerprint: string;
  input: TemplatePreviewInput;
} | null>(null);
const stale = computed(() => !!reviewed.value && reviewed.value.fingerprint !== fingerprint.value);
const preview = useMutation({
  mutationFn: (input: { body: TemplatePreviewInput; fingerprint: string }) =>
    api.create<TemplatePreview>(`/templates/${encodeURIComponent(templateId)}/preview`, input.body),
  onSuccess: (value, input) => {
    if (active()) reviewed.value = { value, fingerprint: input.fingerprint, input: input.body };
  },
});
const keys = new Map<string, string>();
const save = useMutation({
  mutationFn: (input: {
    environmentId: string;
    projectId: string;
    name: string;
    slug: string;
    description: string;
    template: TemplateSelection;
  }) => {
    const token = JSON.stringify(input);
    if (!keys.has(token)) keys.set(token, idempotencyKey());
    return api.create<Service>('/services', input, keys.get(token));
  },
  onSuccess: async (service) => {
    queryClient.setQueryData(['service', service.id], service);
    await invalidateStorage(service.id);
    if (!active()) return;
    guard.markClean();
    await router.push(serviceLocation(service, 'review'));
  },
});
async function createPreview() {
  if (
    auth.restoreMode ||
    !template.data.value ||
    !context.value ||
    preview.isPending.value ||
    save.isPending.value
  )
    return;
  localError.value = null;
  try {
    preview.mutate({
      fingerprint: fingerprint.value,
      body: {
        environmentId: context.value.environment.id,
        projectId: context.value.project.id,
        version: template.data.value.version,
        parameters: templateParameters(template.data.value, form.value.parameters),
      },
    });
  } catch (error) {
    localError.value = error instanceof Error ? error : new Error('请检查模板参数。');
    await nextTick();
    document.querySelector<HTMLElement>('[data-mutation-error]')?.focus();
  }
}
function createService() {
  if (
    !reviewed.value ||
    !template.data.value ||
    !context.value ||
    stale.value ||
    auth.restoreMode ||
    save.isPending.value ||
    preview.isPending.value ||
    reviewed.value.value.issues.some((issue) => issue.blocks === 'save' || issue.blocks === 'both')
  )
    return;
  if (!formElement.value?.reportValidity()) return;
  save.mutate({
    environmentId: context.value.environment.id,
    projectId: context.value.project.id,
    name: form.value.name.trim(),
    slug: form.value.slug,
    description: form.value.description,
    template: {
      id: template.data.value.id,
      version: reviewed.value.input.version,
      parameters: reviewed.value.input.parameters,
    },
  });
}
</script>
<template>
  <nav class="breadcrumbs" aria-label="面包屑">
    <RouterLink
      :to="
        inProject
          ? {
              path: route.path,
              query: {
                environment: context?.environment.slug || query('environment') || 'production',
              },
            }
          : '/templates'
      "
      class="text-link"
      >服务模板</RouterLink
    ><ChevronRight /><span>{{ template.data.value?.name ?? '模板参数' }}</span>
  </nav>
  <div class="page-head">
    <div>
      <h1>从模板添加服务</h1>
      <p>检查生成的配置与数据需求，再保存服务草稿。</p>
    </div>
  </div>
  <QueryState
    :pending="template.isPending.value"
    :error="template.error.value"
    @retry="template.refetch()"
  >
    <template v-if="template.data.value">
      <TemplateDetails :template="template.data.value" class="mb-6" />
      <form ref="formElement" class="panel" @submit.prevent="createPreview">
        <StorageTargetPicker
          v-model="selection"
          :project-locked="inProject"
          :environment-slug="inProject ? query('environment') || 'production' : undefined"
          :disabled="save.isPending.value"
          @context="context = $event"
        />
        <fieldset :disabled="save.isPending.value" class="template-service-fields mt-7">
          <legend class="sr-only">服务资料</legend>
          <div class="field">
            <label for="template-service-name">服务名称</label
            ><Input
              id="template-service-name"
              v-model="form.name"
              required
              maxlength="120"
              placeholder="例如：订单数据库"
            />
          </div>
          <div class="field">
            <label for="template-service-slug">服务标识</label
            ><Input
              id="template-service-slug"
              v-model="form.slug"
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              maxlength="63"
              placeholder="例如：orders-db"
            />
            <p class="field-hint">小写字母、数字与连字符；保存后固定。</p>
          </div>
          <div class="field template-description">
            <label for="template-service-description">说明 <span class="meta">可选</span></label
            ><Textarea
              id="template-service-description"
              v-model="form.description"
              maxlength="1000"
              rows="2"
            />
          </div>
        </fieldset>
        <div class="mt-7 pt-6 border-t border-border">
          <h2 class="mb-5">模板参数</h2>
          <TemplateParameterEditor
            v-model="form.parameters"
            :template="template.data.value"
            :disabled="save.isPending.value"
          />
        </div>
        <StorageMutationError
          :error="localError || preview.error.value || save.error.value"
          class="mt-6"
        />
        <div class="form-footer">
          <p class="meta">{{ context ? '集群由所选项目继承。' : '先选择项目与环境。' }}</p>
          <Button
            type="submit"
            variant="outline"
            :disabled="
              auth.restoreMode || !context || preview.isPending.value || save.isPending.value
            "
            ><LoaderCircle v-if="preview.isPending.value" class="animate-spin" /><Eye v-else />{{
              preview.isPending.value ? '正在生成预览…' : '预览生成配置'
            }}</Button
          >
        </div>
      </form>
      <TemplateConfigurationPreview
        v-if="reviewed"
        class="mt-6"
        :preview="reviewed.value"
        :stale="stale"
        ><div class="form-footer">
          <p class="meta">服务保存后还需审阅并发布。</p>
          <Button
            type="button"
            :disabled="
              stale ||
              auth.restoreMode ||
              save.isPending.value ||
              preview.isPending.value ||
              reviewed.value.issues.some(
                (issue) => issue.blocks === 'save' || issue.blocks === 'both',
              )
            "
            @click="createService"
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" />{{
              save.isPending.value ? '正在保存…' : '保存并预览发布'
            }}<ArrowRight v-if="!save.isPending.value"
          /></Button></div
      ></TemplateConfigurationPreview>
    </template>
  </QueryState>
</template>
<style scoped>
.template-service-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
  min-width: 0;
  border: 0;
  padding: 0;
}
.template-description {
  grid-column: 1 / -1;
}
@media (max-width: 650px) {
  .template-service-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
