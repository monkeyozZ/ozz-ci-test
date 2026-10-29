<script setup lang="ts">
import { AlertCircle, CheckCircle2, Clock3, Circle } from '@lucide/vue';

withDefaults(
  defineProps<{
    label: string;
    tone?: 'neutral' | 'primary' | 'good' | 'warning' | 'danger';
  }>(),
  { tone: 'neutral' },
);
</script>
<template>
  <span :class="['badge', tone === 'neutral' ? '' : `badge-${tone}`]">
    <CheckCircle2 v-if="tone === 'good'" aria-hidden="true" />
    <AlertCircle v-else-if="tone === 'danger' || tone === 'warning'" aria-hidden="true" />
    <Clock3 v-else-if="tone === 'primary'" aria-hidden="true" />
    <Circle v-else aria-hidden="true" />
    {{ label }}
  </span>
</template>
