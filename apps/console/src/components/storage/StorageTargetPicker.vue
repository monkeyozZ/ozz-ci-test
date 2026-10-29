<script setup lang="ts">
import { computed, useId, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
import { api } from '@/lib/api';
import { useCollection } from '@/lib/query';
import type { Project, Environment } from '@/lib/types';
import StorageTarget from './StorageTarget.vue';

const model = defineModel<{ projectId: string; environmentId: string }>({ required: true });
const props = defineProps<{
  projectLocked?: boolean;
  environmentSlug?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  context: [value: { project: Project; environment: Environment } | null];
}>();
const prefix = useId();
const initialProjectId = model.value.projectId;
const projects = useCollection<Project>(
  '/projects',
  undefined,
  computed(() => !props.projectLocked),
);
const project = useQuery({
  queryKey: computed(() => ['project', model.value.projectId]),
  enabled: computed(() => !!model.value.projectId),
  queryFn: ({ queryKey, signal }) => api.get<Project>(`/projects/${queryKey[1]}`, signal),
});
const environments = useCollection<Environment>(
  '/environments',
  computed(() => ({ projectId: model.value.projectId })),
  computed(() => !!model.value.projectId),
);
const environment = computed(() =>
  environments.items.value.find((item) => item.id === model.value.environmentId),
);
const context = computed(() =>
  project.data.value && environment.value
    ? { project: project.data.value, environment: environment.value }
    : null,
);
watch(context, (value) => emit('context', value), { immediate: true });
watch(
  () => model.value.projectId,
  () => {
    model.value = { ...model.value, environmentId: '' };
  },
);
watch(
  [environments.items, environments.hasNextPage, environments.isFetching],
  () => {
    const selected = model.value.environmentId;
    const initialSlug =
      model.value.projectId === initialProjectId ? props.environmentSlug : undefined;
    if (!selected && initialSlug) {
      const found = environments.items.value.find((item) => item.slug === initialSlug);
      if (found) model.value = { ...model.value, environmentId: found.id };
    }
    const stillMissing = selected
      ? !environment.value
      : initialSlug && !environments.items.value.some((item) => item.slug === initialSlug);
    if (stillMissing && environments.hasNextPage.value && !environments.isFetching.value)
      void environments.fetchNextPage();
  },
  { immediate: true },
);
</script>
<template>
  <section aria-label="项目与环境" data-storage-target-picker>
    <div class="target-fields">
      <div class="field">
        <label :for="`${prefix}-project`">所属项目</label
        ><select
          v-if="!projectLocked"
          :id="`${prefix}-project`"
          v-model="model.projectId"
          class="input"
          :disabled="disabled || projects.isPending.value"
        >
          <option value="" disabled>选择项目</option>
          <option
            v-if="
              project.data.value &&
              !projects.items.value.some((item) => item.id === model.projectId)
            "
            :value="project.data.value.id"
          >
            {{ project.data.value.name }}
          </option>
          <option v-for="item in projects.items.value" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
        <input
          v-else
          :id="`${prefix}-project`"
          class="input target-fixed"
          readonly
          :value="project.data.value?.name ?? '正在载入项目…'"
        />
        <Button
          type="button"
          v-if="!projectLocked && projects.hasNextPage.value"
          variant="ghost"
          class="self-start"
          :disabled="projects.isFetchingNextPage.value"
          @click="projects.fetchNextPage()"
          >载入更多项目</Button
        >
      </div>
      <div class="field">
        <label :for="`${prefix}-environment`">所属环境</label
        ><select
          :id="`${prefix}-environment`"
          v-model="model.environmentId"
          class="input"
          :disabled="disabled || !model.projectId || environments.isPending.value"
        >
          <option value="" disabled>{{ model.projectId ? '选择环境' : '先选择项目' }}</option>
          <option v-if="model.environmentId && !environment" :value="model.environmentId" disabled>
            正在核对所选环境…
          </option>
          <option v-for="item in environments.items.value" :key="item.id" :value="item.id">
            {{ item.name }} · {{ item.slug }}
          </option></select
        ><Button
          type="button"
          v-if="environments.hasNextPage.value"
          variant="ghost"
          class="self-start"
          :disabled="environments.isFetchingNextPage.value"
          @click="environments.fetchNextPage()"
          >载入更多环境</Button
        >
      </div>
    </div>
    <QueryState
      v-if="model.projectId"
      class="mt-5"
      :pending="project.isPending.value || environments.isPending.value"
      :error="project.error.value || environments.error.value"
      @retry="
        project.refetch();
        environments.refetch();
      "
      ><StorageTarget
        v-if="context"
        :context="{
          project: context.project,
          environment: context.environment,
          cluster: context.project.cluster,
        }"
      />
      <p v-else-if="model.environmentId && !environments.hasNextPage.value" class="field-error">
        所选环境不属于当前项目，请重新选择。
      </p></QueryState
    >
    <QueryState
      v-if="!projectLocked && projects.error.value"
      class="mt-4"
      :pending="false"
      :error="projects.error.value"
      @retry="projects.refetch()"
    />
  </section>
</template>
<style scoped>
.target-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}
.target-fixed {
  display: flex;
  align-items: center;
  height: auto;
  min-height: 2.5rem;
  background: var(--secondary);
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .target-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
