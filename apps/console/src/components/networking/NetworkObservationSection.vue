<script setup lang="ts">
import { useId } from 'vue';
import { dateTime } from '@/lib/utils';
import NetworkStateBadge from './NetworkStateBadge.vue';

defineProps<{
  title: string;
  status: {
    label: string;
    tone: 'neutral' | 'primary' | 'good' | 'warning' | 'danger';
  };
  observedAt?: string | null;
  stale?: boolean;
  message?: string | null;
}>();
const titleId = useId();
</script>
<template>
  <section class="network-observation" :aria-labelledby="titleId">
    <div class="observation-heading">
      <h3 :id="titleId">{{ title }}</h3>
      <NetworkStateBadge :label="status.label" :tone="status.tone" />
    </div>
    <p class="meta observation-time">
      {{ observedAt ? `观察于 ${dateTime(observedAt)}` : '尚无观察结果' }}
      <span v-if="stale" class="observation-stale"> · 上次结果，当前未能更新</span>
    </p>
    <p v-if="message" class="observation-message">{{ message }}</p>
    <slot />
  </section>
</template>
<style scoped>
.network-observation {
  min-width: 0;
  padding: 1.5rem 0;
  border-top: 1px solid var(--border);
}
.network-observation:first-child {
  padding-top: 0;
  border-top: 0;
}
.network-observation:last-child {
  padding-bottom: 0;
}
.observation-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.observation-time {
  margin-top: 0.5rem;
}
.observation-stale {
  color: var(--warning);
}
.observation-message {
  margin-top: 0.875rem;
  max-width: 72ch;
  overflow-wrap: anywhere;
}
</style>
