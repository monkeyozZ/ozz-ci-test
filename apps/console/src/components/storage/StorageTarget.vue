<script setup lang="ts">
import { ChevronRight, Layers3 } from '@lucide/vue';

defineProps<{
  context: {
    project: { id: string; name: string };
    environment: { id: string; name: string; slug: string };
    cluster: { id: string; name: string };
  };
}>();
</script>
<template>
  <div class="storage-target" data-storage-target>
    <div class="storage-scope" aria-label="数据归属">
      <RouterLink
        :to="{
          path: `/projects/${context.project.id}`,
          query: { environment: context.environment.slug },
        }"
        class="text-link"
        >{{ context.project.name }}</RouterLink
      >
      <ChevronRight aria-hidden="true" />
      <span>{{ context.environment.name }}</span>
      <ChevronRight aria-hidden="true" />
      <RouterLink :to="`/clusters/${context.cluster.id}`" class="text-link cluster-link">
        <Layers3 aria-hidden="true" />{{ context.cluster.name }}
      </RouterLink>
    </div>
    <p class="meta">数据资源继承项目环境的固定集群。</p>
  </div>
</template>
<style scoped>
.storage-target {
  min-width: 0;
}
.storage-scope {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
  overflow-wrap: anywhere;
}
.storage-scope > svg {
  width: 0.875rem;
  height: 0.875rem;
  color: var(--muted-foreground);
}
.cluster-link {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}
.cluster-link svg {
  width: 1rem;
  height: 1rem;
}
</style>
