<script setup lang="ts">
import { computed, useId } from 'vue';
import { useCollection } from '@/lib/query';
import type { Cluster, Environment, Project } from '@/lib/types';
import { Button } from '@/components/ui/button';
import QueryState from '@/components/QueryState.vue';
const props = defineProps<{ projectId: string; environmentId: string; clusterId: string }>();
const emit = defineEmits<{
  change: [key: 'projectId' | 'environmentId' | 'clusterId', value: string];
}>();
const prefix = useId();
const projects = useCollection<Project>('/projects');
const clusters = useCollection<Cluster>('/clusters');
const environments = useCollection<Environment>(
  '/environments',
  computed(() => ({ projectId: props.projectId })),
  computed(() => !!props.projectId),
);
const change = (key: 'projectId' | 'environmentId' | 'clusterId', event: Event) =>
  emit('change', key, (event.target as HTMLSelectElement).value);
</script>
<template>
  <div class="storage-scope-filters mb-6">
    <div class="field">
      <label :for="`${prefix}-project`">项目</label
      ><select
        :id="`${prefix}-project`"
        class="input"
        :value="projectId"
        @change="change('projectId', $event)"
      >
        <option value="">全部项目</option>
        <option
          v-if="projectId && !projects.items.value.some((item) => item.id === projectId)"
          :value="projectId"
        >
          所选项目
        </option>
        <option v-for="item in projects.items.value" :key="item.id" :value="item.id">
          {{ item.name }}
        </option></select
      ><Button
        type="button"
        v-if="projects.hasNextPage.value"
        variant="ghost"
        class="self-start"
        :disabled="projects.isFetchingNextPage.value"
        @click="projects.fetchNextPage()"
        >载入更多项目</Button
      >
    </div>
    <div class="field">
      <label :for="`${prefix}-environment`">环境</label
      ><select
        :id="`${prefix}-environment`"
        class="input"
        :disabled="!projectId"
        :value="environmentId"
        @change="change('environmentId', $event)"
      >
        <option value="">{{ projectId ? '全部环境' : '先选择项目' }}</option>
        <option
          v-if="
            environmentId && !environments.items.value.some((item) => item.id === environmentId)
          "
          :value="environmentId"
        >
          所选环境
        </option>
        <option v-for="item in environments.items.value" :key="item.id" :value="item.id">
          {{ item.name }}
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
    <div class="field">
      <label :for="`${prefix}-cluster`">集群</label
      ><select
        :id="`${prefix}-cluster`"
        class="input"
        :value="clusterId"
        @change="change('clusterId', $event)"
      >
        <option value="">全部集群</option>
        <option
          v-if="clusterId && !clusters.items.value.some((item) => item.id === clusterId)"
          :value="clusterId"
        >
          所选集群
        </option>
        <option v-for="item in clusters.items.value" :key="item.id" :value="item.id">
          {{ item.name }}
        </option></select
      ><Button
        type="button"
        v-if="clusters.hasNextPage.value"
        variant="ghost"
        class="self-start"
        :disabled="clusters.isFetchingNextPage.value"
        @click="clusters.fetchNextPage()"
        >载入更多集群</Button
      >
    </div>
  </div>
  <QueryState
    v-if="projects.error.value || clusters.error.value || (projectId && environments.error.value)"
    :pending="false"
    :error="projects.error.value || clusters.error.value || environments.error.value"
    class="mb-6"
    @retry="
      projects.refetch();
      clusters.refetch();
      if (projectId) environments.refetch();
    "
  />
</template>
<style scoped>
.storage-scope-filters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}
@media (max-width: 620px) {
  .storage-scope-filters {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
