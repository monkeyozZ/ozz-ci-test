<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { ArrowRight, Database, Info, LoaderCircle, Package } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import QueryState from '@/components/QueryState.vue';
import StorageTargetPicker from '@/components/storage/StorageTargetPicker.vue';
import StorageMutationError from '@/components/storage/StorageMutationError.vue';
import TemplateDetails from '@/components/storage/TemplateDetails.vue';
import TemplateParameterEditor from '@/components/storage/TemplateParameterEditor.vue';
import TemplateConfigurationPreview from '@/components/storage/TemplateConfigurationPreview.vue';
import ConfigurationReview from '@/components/services/ConfigurationReview.vue';
import ServiceConfigurationEditor from '@/components/services/ServiceConfigurationEditor.vue';
import ServiceCreationFrame from '@/components/services/ServiceCreationFrame.vue';
import { draftConfiguration, serviceDraft, taskLocation } from '@/components/services/presentation';
import { templateDraft, templateParameters } from '@/components/storage/presentation';
import { invalidateStorage } from '@/components/storage/queries';
import type { Template, TemplatePreview, TemplatePreviewInput } from '@/components/storage/types';
import type { CreateServiceInput, Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { resourceSlug, idempotencyKey } from '@/lib/utils';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import { useServiceCreationContext } from '@/composables/useServiceCreationContext';
import { revealCreationError, useServiceCreationFlow } from '@/composables/useServiceCreationFlow';
import { useUiStore } from '@/stores/ui';
import { creationStepQuery, useCreationBusy } from '@/composables/useCreationDialogState';

const route = useRoute();
const ui = useUiStore();
const active = useViewScope();
const query = (key: string) =>
  typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const templateId = String(route.params.templateId || query('template'));
const templateVersion = query('version');
const inProject = typeof route.params.projectId === 'string';
const selection = ref({
  projectId: String(route.params.projectId || query('projectId')),
  environmentId: query('environmentId'),
});
const place = useServiceCreationContext(() => ({
  projectId: selection.value.projectId,
  environmentId: selection.value.environmentId || undefined,
  environmentSlug: inProject
    ? route.query.environment == null
      ? 'production'
      : query('environment')
    : undefined,
  invalid:
    ['environment', 'environmentId', 'projectId'].some(
      (key) => route.query[key] != null && typeof route.query[key] !== 'string',
    ) ||
    (!inProject &&
      route.query.createdService != null &&
      (!selection.value.projectId || !selection.value.environmentId)),
}));
const template = useQuery({
  queryKey: ['template', templateId, templateVersion],
  queryFn: ({ signal }) =>
    api.get<Template>(
      `/templates/${encodeURIComponent(templateId)}${templateVersion ? `?version=${encodeURIComponent(templateVersion)}` : ''}`,
      signal,
    ),
});
const flow = useServiceCreationFlow(place.context, () => ({
  kind: 'template',
  id: templateId,
  version: template.data.value?.version || templateVersion || undefined,
}));
const suffix = idempotencyKey().replace(/-/g, '').slice(0, 6);
const form = ref({
  name: '',
  slug: resourceSlug('', suffix),
  description: '',
  parameters: {} as Record<string, string>,
});
const editForm = ref(serviceDraft());
const guard = useDirtyForm(
  () => (flow.hasSavedService.value ? editForm.value : form.value),
  '模板服务配置',
);
const formElement = ref<HTMLFormElement>();
const editor = ref<InstanceType<typeof ServiceConfigurationEditor>>();
const localError = ref<unknown>(null);
const previewPending = ref(false);
const slugEdited = ref(false);
let initialized = false;
watch(
  () => form.value.name,
  (name) => {
    if (!slugEdited.value) form.value.slug = resourceSlug(name, suffix);
  },
  { flush: 'sync' },
);
watch(
  template.data,
  (value) => {
    if (value && !initialized) {
      initialized = true;
      form.value.name = value.name;
      form.value.parameters = templateDraft(value);
      guard.markClean();
    }
  },
  { immediate: true },
);
function loadSaved(service: Service) {
  editForm.value = serviceDraft(service);
  guard.markClean();
  localError.value = null;
}
watch(
  flow.service,
  (service) => {
    if (service && !guard.dirty.value) loadSaved(service);
  },
  { immediate: true },
);
const fingerprint = computed(() =>
  JSON.stringify({
    templateId,
    version: template.data.value?.version,
    projectId: place.context.value?.project.id,
    environmentId: place.context.value?.environment.id,
    form: form.value,
  }),
);
const reviewed = shallowRef<{
  value: TemplatePreview;
  fingerprint: string;
  input: TemplatePreviewInput;
} | null>(null);
const stale = computed(() => !!reviewed.value && reviewed.value.fingerprint !== fingerprint.value);
const review = computed(() => flow.phase.value === 'review');
const reviewBusy = ref(false);
const busy = computed(() => flow.saving.value || previewPending.value);
useCreationBusy(() => busy.value || reviewBusy.value, flow.uncertain);
const sourceLocation = computed(() =>
  inProject
    ? {
        path: route.path,
        query: creationStepQuery(route.query, {
          source: 'template',
          category: template.data.value?.category || 'database',
          environment:
            place.context.value?.environment.slug || query('environment') || 'production',
        }),
      }
    : {
        path: '/templates',
        query: {
          projectId: selection.value.projectId || undefined,
          environmentId: selection.value.environmentId || undefined,
        },
      },
);

async function back() {
  if (!flow.service.value || reviewBusy.value || busy.value) return;
  if (review.value) {
    loadSaved(flow.service.value);
    flow.edit();
    return;
  }
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '放弃这次配置修改？',
      description: '返回已保存配置的部署预览。',
      confirmText: '返回预览',
    }))
  )
    return;
  loadSaved(flow.service.value);
  await flow.showReview();
}
async function validateForm() {
  const invalid = formElement.value?.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input:invalid, select:invalid, textarea:invalid');
  if (!invalid) return true;
  for (const details of formElement.value?.querySelectorAll('details') ?? []) {
    if (details.contains(invalid)) details.open = true;
  }
  await nextTick();
  invalid.focus();
  invalid.reportValidity();
  return false;
}
async function submit() {
  if (busy.value || flow.writesLocked.value || !place.context.value || !template.data.value) return;
  localError.value = null;
  const submittedPath = route.fullPath;
  try {
    let createInput: CreateServiceInput | null = null;
    if (!flow.hasSavedService.value && !flow.uncertain.value) {
      if (!(await validateForm())) return;
      const captured = fingerprint.value;
      const body: TemplatePreviewInput = {
        projectId: place.context.value.project.id,
        environmentId: place.context.value.environment.id,
        version: template.data.value.version,
        parameters: templateParameters(template.data.value, form.value.parameters),
      };
      createInput = {
        projectId: body.projectId,
        environmentId: body.environmentId,
        name: form.value.name.trim(),
        slug: form.value.slug,
        description: form.value.description,
        template: {
          id: template.data.value.id,
          version: body.version,
          parameters: body.parameters,
        },
      };
      previewPending.value = true;
      const value = await api.create<TemplatePreview>(
        `/templates/${encodeURIComponent(templateId)}/preview`,
        body,
      );
      if (!active() || route.fullPath !== submittedPath) return;
      reviewed.value = { value, fingerprint: captured, input: body };
      if (captured !== fingerprint.value) {
        localError.value = new Error('配置已变化，请重新核对。');
        return;
      }
      if (value.issues.some((issue) => issue.blocks === 'save' || issue.blocks === 'both')) {
        localError.value = new Error('请先处理模板检查中的问题，再继续。');
        return;
      }
    } else if (flow.hasSavedService.value && !(await editor.value?.validate())) {
      return;
    }
    if (!active() || route.fullPath !== submittedPath) return;
    const value = await flow.save({
      create: () => {
        if (!createInput) throw new Error('请先重新核对模板配置。');
        return createInput;
      },
      update: (service) =>
        api.update<Service>(`/services/${service.id}`, {
          revision: editForm.value.revision,
          name: editForm.value.name.trim(),
          description: editForm.value.description,
          registryCredentialRefId: editForm.value.registryCredentialRefId || null,
          configuration: draftConfiguration(editForm.value),
        }),
    });
    if (!value) {
      if (flow.active()) await revealCreationError(formElement.value, flow.saveError.value);
      return;
    }
    loadSaved(value);
    previewPending.value = false;
    await flow.showReview();
    await invalidateStorage(value.id);
  } catch (error) {
    localError.value = error;
    await revealCreationError(formElement.value, error);
  } finally {
    previewPending.value = false;
  }
}
onScopeDispose(() => {
  for (const variable of editForm.value.variables)
    if (variable.mode === 'secret') variable.value = '';
});
</script>
<template>
  <ServiceCreationFrame
    :step="review ? 'review' : 'configure'"
    :title="
      review
        ? '核对部署配置'
        : template.data.value
          ? `配置 ${template.data.value.name}`
          : '配置模板服务'
    "
    :context="place.context.value"
    :show-environment="!inProject || place.showEnvironment.value"
    :back-to="!flow.hasSavedService.value ? sourceLocation : undefined"
    :back-label="review ? '返回配置' : flow.hasSavedService.value ? '返回预览' : '选择模板'"
    :back-disabled="busy || flow.uncertain.value || reviewBusy || !!flow.service.value?.activeTask"
    @back="back"
  >
    <QueryState
      :pending="template.isPending.value"
      :error="template.error.value"
      @retry="template.refetch()"
    >
      <template v-if="template.data.value">
        <QueryState
          :pending="
            ((inProject || flow.hasSavedService.value) && place.pending.value) || flow.loading.value
          "
          :error="place.error.value || flow.loadError.value"
          @retry="
            place.refetch();
            flow.refetch();
          "
        >
          <template v-if="review && flow.service.value">
            <TemplateConfigurationPreview
              v-if="reviewed?.value.issues.length"
              :preview="reviewed.value"
              :stale="stale"
              class="mb-6"
            />
            <ConfigurationReview
              :service="flow.service.value"
              @busy-change="reviewBusy = $event"
              @submitted="flow.submitted"
            />
          </template>
          <form
            v-else-if="!flow.hasSavedService.value || flow.service.value"
            ref="formElement"
            class="panel stack"
            novalidate
            @submit.prevent="submit"
            @compositionstart="flow.compositionStart"
            @compositionend="flow.compositionEnd"
            @keydown="flow.guardEnter"
          >
            <StorageTargetPicker
              v-if="!inProject && !flow.hasSavedService.value"
              v-model="selection"
              :disabled="busy || flow.fieldsLocked.value"
            />
            <div class="template-heading">
              <Database v-if="template.data.value.category === 'database'" /><Package v-else />
              <strong>{{ template.data.value.name }}</strong>
              <span class="meta">v{{ template.data.value.version }}</span>
            </div>
            <div v-if="flow.uncertain.value" class="notice">
              <Info />
              <p>保存结果尚未确认。配置已保留，重试会核对同一次创建。</p>
            </div>
            <div v-if="flow.service.value?.activeTask" class="notice">
              <Info />
              <p>
                服务已有任务正在执行。<RouterLink
                  :to="taskLocation(flow.service.value.activeTask)"
                  class="text-link"
                  >查看当前任务</RouterLink
                >
              </p>
            </div>
            <template v-if="!flow.hasSavedService.value">
              <fieldset class="stack min-w-0" :disabled="busy || flow.fieldsLocked.value">
                <div class="field">
                  <label for="template-service-name">服务名称</label>
                  <Input
                    id="template-service-name"
                    v-model="form.name"
                    required
                    maxlength="120"
                    placeholder="例如：订单数据库"
                  />
                </div>
                <TemplateParameterEditor
                  v-model="form.parameters"
                  :template="template.data.value"
                  :disabled="busy || flow.fieldsLocked.value"
                />
                <details class="template-advanced">
                  <summary>标识与描述</summary>
                  <div class="stack pt-5">
                    <div class="field">
                      <label for="template-service-slug">服务标识</label>
                      <Input
                        id="template-service-slug"
                        v-model="form.slug"
                        required
                        pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
                        maxlength="63"
                        @input="slugEdited = true"
                      />
                      <p class="field-hint">自动生成，也可修改；保存后保持固定。</p>
                    </div>
                    <div class="field">
                      <label for="template-service-description"
                        >描述 <span class="meta">（选填）</span></label
                      >
                      <Textarea
                        id="template-service-description"
                        v-model="form.description"
                        maxlength="1000"
                        rows="2"
                      />
                    </div>
                  </div>
                </details>
              </fieldset>
            </template>
            <template v-else-if="flow.service.value">
              <p class="meta">模板来源已固定。数据库的初始化配置保持只读。</p>
              <ServiceConfigurationEditor
                ref="editor"
                v-model="editForm"
                compact
                :protected-configuration="flow.service.value.kind === 'database'"
                :disabled="flow.fieldsLocked.value"
              />
            </template>
            <StorageMutationError :error="localError || flow.saveError.value" />
            <p v-if="!flow.hasSavedService.value" class="meta">先保存为服务草稿，再核对并部署。</p>
            <div class="form-footer">
              <Button
                type="submit"
                :disabled="busy || flow.writesLocked.value || !place.context.value"
              >
                <LoaderCircle v-if="busy" class="animate-spin" />
                {{
                  busy
                    ? previewPending
                      ? '正在核对…'
                      : '正在保存…'
                    : flow.uncertain.value
                      ? '重试确认保存结果'
                      : '核对部署配置'
                }}
                <ArrowRight v-if="!busy" />
              </Button>
            </div>
          </form>
          <TemplateConfigurationPreview
            v-if="reviewed && !flow.hasSavedService.value"
            class="mt-6"
            :preview="reviewed.value"
            :stale="stale"
          />
          <details class="template-details mt-6">
            <summary>查看模板说明与配置明细</summary>
            <TemplateDetails :template="template.data.value" class="mt-4" />
            <TemplateConfigurationPreview
              v-if="reviewed && flow.hasSavedService.value"
              :preview="reviewed.value"
              :stale="false"
              class="mt-4"
            />
          </details>
        </QueryState>
      </template>
    </QueryState>
  </ServiceCreationFrame>
</template>
<style scoped>
.template-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.625rem;
}
.template-heading svg {
  width: 1.25rem;
  height: 1.25rem;
  color: var(--primary);
}
.template-advanced {
  border-top: 1px solid var(--border);
  padding-top: 1.125rem;
}
.template-advanced summary,
.template-details summary {
  min-height: 2.25rem;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--muted-foreground);
}
.template-advanced summary:hover,
.template-details summary:hover {
  color: var(--primary);
}
</style>
