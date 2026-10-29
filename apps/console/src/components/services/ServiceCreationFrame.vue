<script setup lang="ts">
import { inject } from 'vue';
import { ArrowLeft, Server } from '@lucide/vue';
import type { RouteLocationRaw } from 'vue-router';
import type { CreationContext } from './creation-state';
import { CREATION_DIALOG } from '@/composables/useCreationDialogState';
const inDialog = inject(CREATION_DIALOG, false);
defineProps<{
  title: string;
  context?: CreationContext | null;
  showEnvironment?: boolean;
  backTo?: RouteLocationRaw;
  backLabel?: string;
  backDisabled?: boolean;
}>();
defineEmits<{ back: [] }>();
</script>
<template>
  <div :class="['service-creation', { 'in-dialog': inDialog }]">
    <RouterLink
      v-if="backTo"
      :to="backTo"
      class="creation-back"
      data-creation-back
      :aria-disabled="backDisabled || undefined"
      @click="
        (event) => {
          if (backDisabled) event.preventDefault();
        }
      "
    >
      <ArrowLeft />{{ backLabel || '选择来源' }}
    </RouterLink>
    <button
      v-else
      type="button"
      class="creation-back"
      data-creation-back
      :disabled="backDisabled"
      @click="$emit('back')"
    >
      <ArrowLeft />{{ backLabel || '返回配置' }}
    </button>
    <div class="page-head creation-heading">
      <div>
        <h1>{{ title }}</h1>
        <p v-if="context" class="creation-context">
          <Server />{{ context.project.cluster.name }}
          <template v-if="showEnvironment"> · {{ context.environment.name }}</template>
        </p>
      </div>
      <slot name="heading" />
    </div>
    <slot />
  </div>
</template>
<style scoped>
.in-dialog {
  max-width: none;
  padding-top: 0;
}
.in-dialog :deep(.panel) {
  padding: 0;
  border: 0;
  box-shadow: none;
  background: transparent;
}
.in-dialog .creation-heading {
  padding-right: 2rem;
}
.service-creation {
  width: 100%;
  max-width: 48rem;
  margin: 0 auto;
  padding-top: 0.75rem;
}
.creation-back {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  margin-bottom: 0.875rem;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.creation-back:hover {
  color: var(--primary);
}
.creation-back:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.creation-back svg,
.creation-context svg {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}
.creation-heading {
  margin-bottom: 1.75rem;
}
.creation-context {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}
@media (max-width: 639px) {
  .service-creation {
    padding-top: 0;
  }
}
</style>
