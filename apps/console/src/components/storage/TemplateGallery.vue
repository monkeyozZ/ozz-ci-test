<script setup lang="ts">
import { Database, Package, ArrowRight, HardDrive } from '@lucide/vue';
import type { Template } from './types';
const props = defineProps<{
  templates: Template[];
  projectId?: string;
  environmentId?: string;
  environmentSlug?: string;
  inProject?: boolean;
}>();
function location(template: Template) {
  return props.inProject && props.projectId
    ? {
        path: `/projects/${props.projectId}/services/new`,
        query: {
          template: template.id,
          version: template.version,
          environment: props.environmentSlug || undefined,
        },
      }
    : {
        path: `/templates/${template.id}`,
        query: {
          version: template.version,
          projectId: props.projectId || undefined,
          environmentId: props.environmentId || undefined,
        },
      };
}
</script>
<template>
  <div class="template-gallery" data-template-gallery>
    <article
      v-for="template in templates"
      :key="`${template.id}-${template.version}`"
      class="template-option"
    >
      <div class="template-icon">
        <Database v-if="template.category === 'database'" /><Package v-else />
      </div>
      <div class="template-copy">
        <h2>
          <RouterLink :to="location(template)" class="text-link">{{ template.name }}</RouterLink>
        </h2>
        <p class="mt-2">{{ template.description }}</p>
        <div class="template-meta mt-4">
          <span>v{{ template.version }}</span
          ><span>{{ template.controller.kind }}</span
          ><span v-if="template.persistent" class="inline-flex items-center gap-1"
            ><HardDrive class="size-3.5" />持久卷</span
          ><span v-else>{{ template.id === 'docker' ? '自选镜像' : '预构建镜像' }}</span>
        </div>
      </div>
      <RouterLink
        :to="location(template)"
        class="template-select text-link"
        :aria-label="`使用 ${template.name} 模板`"
        >选择模板<ArrowRight class="size-4"
      /></RouterLink>
    </article>
  </div>
</template>
<style scoped>
.template-gallery {
  border-top: 1px solid var(--border);
}
.template-option {
  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1fr) auto;
  gap: 1.25rem;
  padding: 1.75rem 0;
  border-bottom: 1px solid var(--border);
}
.template-icon {
  display: grid;
  place-items: center;
  width: 2.75rem;
  height: 2.75rem;
  background: var(--accent);
  border-radius: 0.625rem;
  color: var(--primary);
}
.template-icon svg {
  width: 1.25rem;
  height: 1.25rem;
}
.template-copy p {
  color: var(--muted-foreground);
  font-size: 0.9375rem;
  max-width: 70ch;
}
.template-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.template-select {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  align-self: center;
  font-size: 0.875rem;
}
@media (max-width: 600px) {
  .template-option {
    grid-template-columns: 2.5rem minmax(0, 1fr);
    gap: 1rem;
  }
  .template-select {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
