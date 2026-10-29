<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';
const model = defineModel<string | number>();
const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>
<template>
  <input v-model="model" :class="cn('input', props.class)" />
</template>
