<script setup lang="ts">
import { computed } from 'vue';
import MutationError from '@/components/MutationError.vue';
import { activeTaskLocation } from './presentation';
const props = defineProps<{ error: unknown }>();
const active = computed(() => activeTaskLocation(props.error));
</script>
<template>
  <div v-if="error">
    <MutationError :error="error" /><RouterLink
      v-if="active"
      :to="active"
      class="text-link mt-3 inline-block"
      >查看当前任务</RouterLink
    >
  </div>
</template>
