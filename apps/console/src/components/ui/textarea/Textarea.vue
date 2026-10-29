<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';
const model = defineModel<string>();
const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>
<template>
  <textarea v-model="model" :class="cn('input min-h-24 resize-y', props.class)" />
</template>
