<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { ArrowRight, Info, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import ServiceConfigurationEditor from '@/components/services/ServiceConfigurationEditor.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import ConfigurationReview from '@/components/services/ConfigurationReview.vue';
import ServiceCreationFrame from '@/components/services/ServiceCreationFrame.vue';
import GitSourceEditor from '@/components/git/GitSourceEditor.vue';
import { sourceDraft, sourceInput } from '@/components/git/presentation';
import { invalidateGitService, saveGitSource } from '@/components/git/queries';
import type { RegistryConnection } from '@/components/git/types';
import {
  draftRuntimeConfiguration,
  serviceDraft,
  taskLocation,
} from '@/components/services/presentation';
import type { Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import { useServiceCreationContext } from '@/composables/useServiceCreationContext';
import { revealCreationError, useServiceCreationFlow } from '@/composables/useServiceCreationFlow';
import { useUiStore } from '@/stores/ui';
import { creationStepQuery, useCreationBusy } from '@/composables/useCreationDialogState';

const route = useRoute();
const ui = useUiStore();
const active = useViewScope();
const projectId = String(route.params.projectId);
const environmentSlug = computed(() =>
  typeof route.query.environment === 'string' ? route.query.environment : 'production',
);
const place = useServiceCreationContext(() => ({
  projectId,
  environmentSlug: environmentSlug.value,
  environmentId:
    typeof route.query.environmentId === 'string' ? route.query.environmentId : undefined,
  invalid: ['environment', 'environmentId'].some(
    (key) => route.query[key] != null && typeof route.query[key] !== 'string',
  ),
}));
const flow = useServiceCreationFlow(place.context, { kind: 'github' });
const form = ref(serviceDraft());
const git = ref(sourceDraft());
const guard = useDirtyForm(
  () => ({ configuration: form.value, source: git.value }),
  'Git 服务配置',
);
const editor = ref<InstanceType<typeof ServiceConfigurationEditor>>();
const sourceEditor = ref<InstanceType<typeof GitSourceEditor>>();
const formElement = ref<HTMLFormElement>();
const localError = ref<unknown>(null);
const review = computed(() => flow.phase.value === 'review');
const reviewBusy = ref(false);
useCreationBusy(() => flow.saving.value || reviewBusy.value, flow.uncertain);
const sourceLocation = computed(() => ({
  path: route.path,
  query: creationStepQuery(route.query),
}));
const registryId = computed(() => {
  const source = flow.service.value?.source;
  return source?.kind === 'github' ? source.currentRevision.destination.registryConnectionId : '';
});
const registry = useQuery({
  queryKey: computed(() => ['registry-connection', registryId.value]),
  enabled: () => !!registryId.value,
  queryFn: ({ queryKey, signal }) =>
    api.get<RegistryConnection>(`/integrations/registries/${queryKey[1]}`, signal),
});
let runtimeBaseline = '';
let sourceBaseline = '';
let editRevision = 1;
const sourceFingerprint = () => {
  const input = sourceInput(git.value);
  delete input.autoDeploy;
  return JSON.stringify(input);
};
function loadForm(service: Service) {
  form.value = serviceDraft(service);
  runtimeBaseline = JSON.stringify(form.value);
  editRevision = service.revision;
  if (
    service.source.kind === 'github' &&
    registry.data.value?.id === service.source.currentRevision.destination.registryConnectionId
  ) {
    git.value = sourceDraft(service.source, registry.data.value);
    sourceBaseline = sourceFingerprint();
  }
  guard.markClean();
  localError.value = null;
}
watch(
  [flow.service, registry.data],
  ([service]) => {
    if (service && !guard.dirty.value) loadForm(service);
  },
  { immediate: true },
);
async function back() {
  if (!flow.service.value || reviewBusy.value || flow.saving.value) return;
  if (review.value) {
    loadForm(flow.service.value);
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
  loadForm(flow.service.value);
  await flow.showReview();
}
async function submit() {
  if (!place.context.value || flow.writesLocked.value) return;
  if (
    flow.hasSavedService.value &&
    (registry.isPending.value ||
      registry.error.value ||
      registry.data.value?.id !== registryId.value)
  )
    return;
  localError.value = null;
  const submittedPath = route.fullPath;
  try {
    if (
      !flow.uncertain.value &&
      (!(await editor.value?.validate()) || !(await sourceEditor.value?.validate()))
    )
      return;
    if (!active() || route.fullPath !== submittedPath) return;
    const value = await flow.save({
      create: () => ({
        projectId,
        environmentId: place.context.value!.environment.id,
        name: form.value.name.trim(),
        slug: form.value.slug,
        description: form.value.description,
        source: sourceInput(git.value),
        configuration: draftRuntimeConfiguration(form.value),
      }),
      update: async (service, remember) => {
        const changedRuntime = JSON.stringify(form.value) !== runtimeBaseline;
        const source = sourceInput(git.value);
        delete source.autoDeploy;
        const changedSource = JSON.stringify(source) !== sourceBaseline;
        let saved = service;
        if (changedRuntime) {
          saved = await api.update<Service>(`/services/${service.id}`, {
            revision: form.value.revision,
            name: form.value.name.trim(),
            description: form.value.description,
            configuration: draftRuntimeConfiguration(form.value),
          });
          remember(saved);
          // A later source failure must not lose this accepted runtime revision or its secret refs.
          form.value = serviceDraft(saved);
          runtimeBaseline = JSON.stringify(form.value);
          editRevision = saved.revision;
        }
        if (changedSource) {
          if (!active() || route.fullPath !== submittedPath)
            throw new DOMException('已离开当前配置', 'AbortError');
          saved = await saveGitSource(service.id, { revision: editRevision, source });
          remember(saved);
        }
        return saved;
      },
    });
    if (!value) {
      if (flow.active()) await revealCreationError(formElement.value, flow.saveError.value);
      return;
    }
    loadForm(value);
    await flow.showReview();
    await invalidateGitService(value.id);
  } catch (error) {
    localError.value = error;
    await revealCreationError(formElement.value, error);
  }
}
onScopeDispose(() => {
  for (const variable of form.value.variables) if (variable.mode === 'secret') variable.value = '';
});
</script>
<template>
  <ServiceCreationFrame
    :title="review ? '核对部署配置' : '从 GitHub 部署'"
    :context="place.context.value"
    :show-environment="place.showEnvironment.value"
    :back-to="!flow.hasSavedService.value ? sourceLocation : undefined"
    :back-label="review ? '返回配置' : flow.hasSavedService.value ? '返回预览' : '选择来源'"
    :back-disabled="
      flow.saving.value || flow.uncertain.value || reviewBusy || !!flow.service.value?.activeTask
    "
    @back="back"
  >
    <QueryState
      :pending="place.pending.value || flow.loading.value"
      :error="place.error.value || flow.loadError.value"
      @retry="
        place.refetch();
        flow.refetch();
      "
    >
      <template v-if="place.context.value">
        <ConfigurationReview
          v-if="review && flow.service.value"
          :service="flow.service.value"
          @busy-change="reviewBusy = $event"
          @submitted="flow.submitted"
        />
        <QueryState
          v-else-if="!flow.hasSavedService.value || flow.service.value"
          :pending="flow.hasSavedService.value && registry.isPending.value"
          :error="flow.hasSavedService.value ? registry.error.value : null"
          @retry="registry.refetch()"
        >
          <form
            ref="formElement"
            class="panel stack"
            novalidate
            @submit.prevent="submit"
            @compositionstart="flow.compositionStart"
            @compositionend="flow.compositionEnd"
            @keydown="flow.guardEnter"
          >
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
            <GitSourceEditor
              ref="sourceEditor"
              v-model="git"
              compact
              :creating="!flow.hasSavedService.value"
              :disabled="flow.fieldsLocked.value"
            />
            <div class="border-t border-border pt-6">
              <ServiceConfigurationEditor
                ref="editor"
                v-model="form"
                compact
                :creating="!flow.hasSavedService.value"
                source-kind="github"
                :disabled="flow.fieldsLocked.value"
              />
            </div>
            <ServiceMutationError :error="localError || flow.saveError.value" />
            <p v-if="!flow.hasSavedService.value" class="meta">先保存为服务草稿，再核对并部署。</p>
            <div class="form-footer">
              <Button type="submit" :disabled="flow.writesLocked.value">
                <LoaderCircle v-if="flow.saving.value" class="animate-spin" />
                {{
                  flow.saving.value
                    ? '正在保存…'
                    : flow.uncertain.value
                      ? '重试确认保存结果'
                      : '核对部署配置'
                }}
                <ArrowRight v-if="!flow.saving.value" />
              </Button>
            </div>
          </form>
        </QueryState>
      </template>
    </QueryState>
  </ServiceCreationFrame>
</template>
