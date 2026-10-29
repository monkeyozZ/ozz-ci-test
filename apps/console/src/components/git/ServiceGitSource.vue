<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQuery } from '@tanstack/vue-query';
import { LoaderCircle, Save } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import ServiceMutationError from '@/components/services/ServiceMutationError.vue';
import GitSourceEditor from './GitSourceEditor.vue';
import GitSourceSummary from './GitSourceSummary.vue';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useDirtyForm } from '@/composables/useDirtyForm';
import { useViewScope } from '@/composables/useViewScope';
import type { Service } from '@/components/services/types';
import type { GitPolicyUpdate, GitSourceUpdate, RegistryConnection } from './types';
import { sourceDraft, sourceInput } from './presentation';
import { invalidateGitService, saveGitSource } from './queries';
const props = defineProps<{ service: Service }>();
const source = computed(() =>
  props.service.source.kind === 'github' ? props.service.source : null,
);
const registryId = computed(
  () => source.value?.currentRevision.destination.registryConnectionId ?? '',
);
const registry = useQuery({
  queryKey: computed(() => ['registry-connection', registryId.value]),
  enabled: computed(() => !!registryId.value),
  queryFn: ({ queryKey, signal }) =>
    api.get<RegistryConnection>('/integrations/registries/' + queryKey[1], signal),
});
const auth = useAuthStore();
const ui = useUiStore();
const active = useViewScope();
const form = ref(sourceDraft());
const revision = ref(props.service.revision);
const guard = useDirtyForm(form, 'Git 来源');
const editor = ref<InstanceType<typeof GitSourceEditor>>();
const localError = ref<Error | null>(null);
function loadSource() {
  if (!source.value || !registry.data.value) return;
  form.value = sourceDraft(source.value, registry.data.value);
  revision.value = props.service.revision;
  guard.markClean();
  localError.value = null;
}
watch(
  [() => props.service, registry.data],
  () => {
    if (!guard.dirty.value) loadSource();
  },
  { immediate: true },
);
const stale = computed(() => revision.value !== props.service.revision);
const save = useMutation({
  mutationFn: (input: GitSourceUpdate) => saveGitSource(props.service.id, input),
  onSuccess: async (value) => {
    queryClient.setQueryData(['service', value.id], value);
    guard.markClean();
    await invalidateGitService(value.id);
    if (active()) ui.toast('Git 来源已保存为新版本，尚未开始构建或发布。');
  },
});
const policy = useMutation({
  mutationFn: (input: GitPolicyUpdate) =>
    api.update<Service>('/services/' + props.service.id + '/git-source/policy', input),
  onSuccess: async (value) => {
    queryClient.setQueryData(['service', value.id], value);
    await invalidateGitService(value.id);
    if (active()) ui.toast('自动发布策略已更新，已有待审阅提交保持待办。');
  },
});
const locked = computed(
  () =>
    auth.restoreMode ||
    !!props.service.activeTask ||
    save.isPending.value ||
    policy.isPending.value,
);
async function submit() {
  if (locked.value || stale.value) return;
  localError.value = null;
  try {
    if (!(await editor.value?.validate())) return;
    const input = sourceInput(form.value);
    delete input.autoDeploy;
    save.mutate({ revision: revision.value, source: input });
  } catch (error) {
    localError.value = error instanceof Error ? error : new Error('请检查来源配置。');
  }
}
async function reload() {
  if (
    guard.dirty.value &&
    !(await ui.confirm({
      title: '重新载入 Git 来源？',
      description: '尚未保存的来源修改会被替换。',
      confirmText: '载入已保存来源',
    }))
  )
    return;
  if (active()) loadSource();
}
async function togglePolicy() {
  if (!source.value || locked.value) return;
  const input: GitPolicyUpdate = {
    revision: props.service.revision,
    policyRevision: source.value.policyRevision,
    autoDeploy: !source.value.autoDeploy,
  };
  if (
    !(await ui.confirm({
      title: input.autoDeploy ? '启用此分支的自动发布？' : '停用此分支的自动发布？',
      description:
        '已注册的 Webhook 按此策略处理新提交。停止期提交和已有待审阅记录仍需明确发布；此操作不会注册或修改 GitHub Webhook。',
      confirmText: input.autoDeploy ? '启用自动发布' : '停用自动发布',
    }))
  )
    return;
  if (active()) policy.mutate(input);
}
</script>
<template>
  <div v-if="source" class="stack">
    <section class="panel">
      <div class="section-head">
        <h2>当前已保存来源</h2>
        <span class="badge">来源 r{{ source.currentRevision.revision }}</span>
      </div>
      <GitSourceSummary :revision="source.currentRevision" />
      <div class="form-footer">
        <p class="meta">
          自动发布：{{ source.autoDeploy ? '已启用' : '已停用' }} · 策略 r{{
            source.policyRevision
          }}
        </p>
        <Button variant="outline" :disabled="locked" @click="togglePolicy">{{
          source.autoDeploy ? '停用自动发布' : '启用自动发布'
        }}</Button>
      </div>
      <ServiceMutationError :error="policy.error.value" />
    </section>
    <QueryState
      :pending="registry.isPending.value"
      :error="registry.error.value"
      @retry="registry.refetch()"
    >
      <form v-if="registry.data.value" class="panel" novalidate @submit.prevent="submit">
        <div v-if="stale" class="notice notice-warning mb-5">
          <p>服务已更新，保存前请载入最新来源。</p>
        </div>
        <GitSourceEditor ref="editor" v-model="form" :disabled="locked || stale" />
        <ServiceMutationError class="mt-5" :error="localError || save.error.value" />
        <div class="form-footer">
          <Button type="button" variant="outline" :disabled="locked" @click="reload"
            >载入已保存来源</Button
          >
          <Button type="submit" :disabled="locked || stale || !guard.dirty.value"
            ><LoaderCircle v-if="save.isPending.value" class="animate-spin" /><Save
              v-else
            />保存来源新版本</Button
          >
        </div>
      </form>
    </QueryState>
  </div>
</template>
