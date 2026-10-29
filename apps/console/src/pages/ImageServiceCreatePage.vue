<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowRight, Info, LoaderCircle } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import ServiceConfigurationEditor from '@/components/services/ServiceConfigurationEditor.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import ConfigurationReview from '@/components/services/ConfigurationReview.vue';
import ServiceCreationFrame from '@/components/services/ServiceCreationFrame.vue';
import { draftConfiguration, serviceDraft, taskLocation } from '@/components/services/presentation';
import type { Service } from '@/components/services/types';
import { api } from '@/lib/api';
import { invalidateCollection } from '@/lib/query';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useServiceCreationContext } from '@/composables/useServiceCreationContext';
import { revealCreationError, useServiceCreationFlow } from '@/composables/useServiceCreationFlow';
import { useUiStore } from '@/stores/ui';
import { creationStepQuery, useCreationBusy } from '@/composables/useCreationDialogState';

const route = useRoute();
const ui = useUiStore();
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
const flow = useServiceCreationFlow(place.context, { kind: 'image' });
const form = ref(serviceDraft());
const guard = useDirtyForm(form, '服务配置');
const editor = ref<InstanceType<typeof ServiceConfigurationEditor>>();
const formElement = ref<HTMLFormElement>();
const localError = ref<unknown>(null);
const sourceLocation = computed(() => ({
  path: route.path,
  query: creationStepQuery(route.query),
}));
const review = computed(() => flow.phase.value === 'review');
const reviewBusy = ref(false);
useCreationBusy(() => flow.saving.value || reviewBusy.value, flow.uncertain);
const unverified = computed(
  () => place.context.value?.project.cluster.connectionStatus === 'unverified',
);

function loadForm(service: Service) {
  form.value = serviceDraft(service);
  guard.markClean();
  localError.value = null;
}
watch(
  flow.service,
  (service) => {
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
  if (
    !place.context.value ||
    flow.saving.value ||
    (unverified.value && !flow.hasSavedService.value)
  )
    return;
  localError.value = null;
  const submittedPath = route.fullPath;
  try {
    if (!flow.uncertain.value && !(await editor.value?.validate())) return;
    if (!flow.active() || route.fullPath !== submittedPath) return;
    const value = await flow.save({
      create: () => ({
        environmentId: place.context.value!.environment.id,
        projectId,
        name: form.value.name.trim(),
        slug: form.value.slug,
        description: form.value.description,
        registryCredentialRefId: form.value.registryCredentialRefId || null,
        configuration: draftConfiguration(form.value),
      }),
      update: (service) =>
        api.update<Service>(`/services/${service.id}`, {
          revision: form.value.revision,
          name: form.value.name.trim(),
          description: form.value.description,
          registryCredentialRefId: form.value.registryCredentialRefId || null,
          configuration: draftConfiguration(form.value),
        }),
    });
    if (!value) {
      if (flow.active()) await revealCreationError(formElement.value, flow.saveError.value);
      return;
    }
    loadForm(value);
    await flow.showReview();
    await invalidateCollection('/services');
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
    :title="review ? '核对部署配置' : '部署 Docker 镜像'"
    :step="review ? 'review' : 'configure'"
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
        <form
          v-else-if="!flow.hasSavedService.value || flow.service.value"
          ref="formElement"
          class="panel"
          novalidate
          @submit.prevent="submit"
          @compositionstart="flow.compositionStart"
          @compositionend="flow.compositionEnd"
          @keydown="flow.guardEnter"
        >
          <div v-if="unverified && !flow.hasSavedService.value" class="notice notice-warning mb-6">
            <Info />
            <p>
              先完成<RouterLink
                :to="`/clusters/${place.context.value.project.clusterId}`"
                class="text-link"
                >部署目标连接</RouterLink
              >，即可保存服务。
            </p>
          </div>
          <div v-if="flow.uncertain.value" class="notice mb-6">
            <Info />
            <p>保存结果尚未确认。配置已保留，重试会核对同一次创建。</p>
          </div>
          <div v-if="flow.service.value?.activeTask" class="notice mb-6">
            <Info />
            <p>
              服务已有任务正在执行。<RouterLink
                :to="taskLocation(flow.service.value.activeTask)"
                class="text-link"
                >查看当前任务</RouterLink
              >
            </p>
          </div>
          <ServiceConfigurationEditor
            ref="editor"
            v-model="form"
            compact
            :creating="!flow.hasSavedService.value"
            :disabled="flow.fieldsLocked.value"
          />
          <ServiceMutationError :error="localError || flow.saveError.value" class="mt-6" />
          <p v-if="!flow.hasSavedService.value" class="meta mt-5">
            先保存为服务草稿，再核对并部署。
          </p>
          <div class="form-footer">
            <Button
              type="submit"
              :disabled="flow.writesLocked.value || (unverified && !flow.hasSavedService.value)"
            >
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
      </template>
    </QueryState>
  </ServiceCreationFrame>
</template>
