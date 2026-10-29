<script setup lang="ts">
import { Folder } from '@lucide/vue';
import type { Component } from 'vue';
withDefaults(defineProps<{ title: string; description: string; icon?: Component }>(), {
  icon: Folder,
});
</script>
<template>
  <div class="empty-state">
    <div class="empty-icon"><component :is="icon" class="size-6" /></div>
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
    <slot />
  </div>
</template>
